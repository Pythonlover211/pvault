# pvault 报销流程 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让发票能被打成报销单、跟着它走到公司打钱，并在钱到账时一键记一笔收入。

**架构：** 纯逻辑（`reimburse-model.js`）+ 数据层（`reimburse-store.js`）+ 界面（`reimburse-view.js`）三层，沿用项目里 `invoice-model` / `invoice-store` 的既有分层。到账这条路径要写三处（收入交易、报销单状态、`txnId`），全部收进**一个事务**——为此给 `store.addTransaction` 加一个可选参数，让调用方把自己的条目并由同一个 `db.putAll` 写下去。

**技术栈：** 原生 ES Modules、IndexedDB、零依赖、无构建；测试用 Node 24 内置 `node:test`（`D:\node.exe --test --test-isolation=none`，这个 flag 是必须的）。

**规格：** `docs/superpowers/specs/2026-09-28-pvault-reimbursement-design.md`

---

## 前置：开工前必须知道的三件事

1. **当前测试基线是 326 pass / 0 fail**（约 18 秒）。每个任务结束时它必须仍然全绿。
   后面各任务里写的「预期 N pass」都是**按当时基线累加**出来的；它们写于基线更早的时候，若与运行时对不上，**以运行时为准**，并把该任务的数字更新掉（数字对不上时先怀疑它，别去改断言迁就）。
2. **不要动 `DB_VERSION`**。`reimbursements` 表与 `by_status` 索引计划 4 已经建好（`app/schema.js:55`），本计划对数据库结构零改动。IndexedDB 没有字段级 schema，记录上多一个 `settledCents` 照存不误。
3. **`fake-browser.js` 的桩盖不住事务回滚**——它的 `abort()` 只改一个标记，已经写进 Map 的数据不会退回去（见该文件头第 1 条）。所以「事务原子性」**不能**用「注入一次写失败、断言库里没半截状态」来验，那条路在桩上永远绿、什么也没证明。本计划改用的判据是**结构性的**：断言写操作**只发起一次**批量写调用（见任务 4、5 的 `db.putAll` 记账探针），真实的回滚语义挂到手动验证清单。

---

## 文件结构

**新建：**

| 文件 | 职责 |
|---|---|
| `app/reimburse-model.js` | 报销单的纯逻辑：状态机、标题生成、差额、发票侧状态推导。零依赖（只 import `invoice-model.js` 的 `sumCents`），可单测 |
| `app/reimburse-store.js` | 报销单的数据层：读写 IndexedDB、发票进出、状态流转。每条写操作一个事务 |
| `app/ui/reimburse-view.js` | 报销单列表与详情两个视图 |
| `app/ui/settle-sheet.js` | 「标记到账」的半屏面板（金额 / 账户 / 分类 / 只标记不记账） |
| `tests/reimburse-model.test.js` | 纯逻辑单测 |
| `tests/reimburse-store.test.js` | 数据层探针（用 `tests/helpers/fake-browser.js`） |

**修改：**

| 文件 | 改什么 |
|---|---|
| `app/store.js` | `addTransaction` 加可选第二参数 `{ extraEntries = [] }` |
| `app/backup.js` | `buildBackup` 打包 `reimbursements`、`summarizeBackup` 计数它。**不动 `REQUIRED_ARRAYS`** |
| `app/backup-store.js` | `ARRAY_STORES` 加 `'reimbursements'` |
| `app/ui/invoice-view.js` | 五个筛选（补「已报销」）、顶部细分段切换、多选模式 |
| `app/ui/invoice-editor.js` | 「仅存档」与「已在报销单里」互斥保护 |
| `styles/*.css` | 分段切换、勾选框、报销单卡片与时间线的样式 |
| `sw.js` | `CACHE` 版本 +1 |
| `docs/手动验证清单.md` | 加「报销」小节 |

**为什么不把报销单塞进 `invoice-view.js`**：那个文件已经 289 行，且同时管着搜索、筛选、汇总、缩略图分批加载与两级渲染序号。报销单列表与详情是另一件事（不同的数据源、不同的交互），放进去会让它承担两个职责。分段切换只是一个入口，切换后调用 `reimburse-view.js` 的渲染函数。

---

### 任务 1：`reimburse-model.js` 的纯逻辑

**文件：**
- 创建：`app/reimburse-model.js`
- 测试：`tests/reimburse-model.test.js`

- [ ] **步骤 1：编写失败的测试**

创建 `tests/reimburse-model.test.js`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STATUS, STATUS_IDS, STATUS_LABELS, isStatus, statusLabel,
  canEdit, canSubmit, canSettle, canDelete, isActive,
  autoTitle, diffCents, invoiceStatus, invoiceBadge
} from '../app/reimburse-model.js';

const r = (status) => ({ id: 'r1', status });

test('状态枚举有三项且冻结', () => {
  assert.deepEqual(STATUS_IDS, ['draft', 'submitted', 'settled']);
  assert.equal(STATUS.DRAFT, 'draft');
  // 模块级共享数组必须冻结：任何 import 方 push 一下就会污染全网校验，
  // 而这种污染在测试里跑不出错（同进程内先污染后校验），排查极费劲。
  assert.ok(Object.isFrozen(STATUS_IDS), 'STATUS_IDS 应当是冻结的');

  assert.ok(Object.isFrozen(STATUS_LABELS), 'STATUS_LABELS 也应当是冻结的');
  // 这张表是**导出的**：将来有人图省事直接 STATUS_LABELS[x]，而 x 命中原型链上的
  // 'constructor' / 'toString' 会返回函数而不是 undefined，`??` 也兜不住（非 nullish）——
  // 那正是 baa3bf7 修掉的那个 bug 的原形。无原型对象让裸查也安全，这条断言钉住它。
  // （statusLabel('constructor') 的兜底文案已在上面那条测试里钉过，这里不重复。）
  assert.equal(STATUS_LABELS['constructor'], undefined, '原型链不该漏进来');
  assert.equal(STATUS_LABELS['toString'], undefined);
  assert.equal(STATUS_LABELS['__proto__'], undefined);
});

test('isStatus / statusLabel：认识的三项，不认识的给兜底', () => {
  assert.equal(isStatus('draft'), true);
  assert.equal(isStatus('submitted'), true);
  assert.equal(isStatus('settled'), true);
  assert.equal(isStatus('cancelled'), false);
  assert.equal(isStatus(null), false);
  assert.equal(isStatus(undefined), false);
  assert.equal(statusLabel('settled'), '已到账');
  // 三个文案都要钉住：只断言 settled 的话，把 draft / submitted 的文案改错（变异实验里
  // 改成「草稿箱」「送审中」）测试照样全绿，而任务 7/8/9 的界面正是用它们渲染列表的。
  assert.equal(statusLabel('draft'), '待提交');
  assert.equal(statusLabel('submitted'), '已提交');
  assert.equal(statusLabel('nope'), '未知状态');
  // 属性查找会命中原型链：这几行曾经拿不到兜底文案——statusLabel('constructor')
  // 返回的是一个函数（function Object(){[native code]}），'toString' / '__proto__' 同理。
  // 判据必须与 isStatus 同源（都用 STATUS_IDS.includes），两处口径不能分叉。
  assert.equal(statusLabel('constructor'), '未知状态');
  assert.equal(statusLabel('toString'), '未知状态');
  assert.equal(statusLabel('__proto__'), '未知状态');
  assert.equal(statusLabel('hasOwnProperty'), '未知状态');
});

test('canEdit：只有草稿能改', () => {
  assert.equal(canEdit(r('draft')), true);
  assert.equal(canEdit(r('submitted')), false, '提交给公司之后票不该再动');
  assert.equal(canEdit(r('settled')), false);
  // 脏状态（读库读到一个不认识的 status）一律按「不能改」处理：
  // 宁可让用户发现异常，也不要在一个状态不明的时候放行写入。
  assert.equal(canEdit(r('nope')), false);
  assert.equal(canEdit(null), false);
});

test('canSubmit / canSettle：各自只放行前一个状态', () => {
  assert.equal(canSubmit(r('draft')), true);
  assert.equal(canSubmit(r('submitted')), false);
  assert.equal(canSubmit(r('settled')), false);

  assert.equal(canSettle(r('submitted')), true);
  assert.equal(canSettle(r('draft')), false, '草稿不能直接到账：没提交就谈不到到账');
  assert.equal(canSettle(r('settled')), false);
});

test('canDelete：任何状态都能删', () => {
  for (const s of STATUS_IDS) assert.equal(canDelete(r(s)), true, `${s} 应当可删`);
  assert.equal(canDelete({ id: 'r1' }), true, '脏记录也允许删——删不掉才是真的把用户卡住');
});

test('isActive：草稿与已提交算进行中', () => {
  assert.equal(isActive(r('draft')), true);
  assert.equal(isActive(r('submitted')), true);
  assert.equal(isActive(r('settled')), false);
});

test('autoTitle：月份与张数拼成默认标题', () => {
  // 用本地时间的月份（不是 UTC）：UTC 读数落后东八区 8 小时，
  // 北京时间 10 月 1 日凌晨（00:00–07:59）那一刻 UTC 还停在 9 月 30 日，
  // 用 UTC 会把「10月报销」写成「9月报销」，而用户明明是在 10 月建的单。
  const sep = new Date(2026, 8, 15, 12, 0, 0).getTime();   // 2026-09-15 本地
  assert.equal(autoTitle(sep, 3), '9月报销 · 3 张');
  assert.equal(autoTitle(sep, 0), '9月报销 · 0 张');
  const jan = new Date(2026, 0, 1, 0, 30, 0).getTime();
  assert.equal(autoTitle(jan, 12), '1月报销 · 12 张', '1 月不能写成 0 月（getMonth 从 0 起）');

  // 时间戳脏值一律退回当前月，绝不产出「NaN月报销」——那会被存进 reimb.title 显示给用户。
  const nowMonth = new Date().getMonth() + 1;
  for (const bad of [undefined, null, NaN, Infinity, '1700000000000', 1e300, 8640000000000001, 8.7e15]) {
    assert.equal(autoTitle(bad, 3), `${nowMonth}月报销 · 3 张`, `monthTs=${String(bad)} 应当退回当前月`);
  }
  // count 脏值一律按 0 张计。
  assert.equal(autoTitle(sep, -5), '9月报销 · 0 张');
  assert.equal(autoTitle(sep, '3'), '9月报销 · 0 张', '字符串张数不算数');
  assert.equal(autoTitle(sep, 1.5), '9月报销 · 0 张');
  assert.equal(autoTitle(sep, NaN), '9月报销 · 0 张');
});

test('diffCents：还没到账时没有差额可谈', () => {
  const invoices = [{ amountCents: 1000 }, { amountCents: 250 }];
  assert.equal(diffCents(null, invoices), null, '没到账就返回 null，界面据此不显示差额行');
  assert.equal(diffCents(1250, invoices), 0);
  assert.equal(diffCents(1238, invoices), -12, '公司抹零：差额是负的');
  assert.equal(diffCents(1300, invoices), 50, '多打了也算差额');
  assert.equal(diffCents(0, []), 0);
  // 脏值一律返回 null（而不是拿 NaN 或字符串去参与减法）：这几个值会从备份文件、
  // 手改过的记录里来，一旦漏出去，界面上那一行会显示成「差额 ¥NaN」，
  // 而 JSON.stringify 会把 NaN 变成 null 跟着下一次备份跑到别的设备上。
  assert.equal(diffCents('1250', invoices), null, '字符串不该被当成数字');
  assert.equal(diffCents(1.5, invoices), null, '小数分不存在');
  assert.equal(diffCents(NaN, invoices), null);
  assert.equal(diffCents(undefined, invoices), null);
  assert.equal(diffCents(9007199254740993, invoices), null, '超出安全整数范围');
  assert.equal(diffCents(Infinity, invoices), null);
});

test('invoiceStatus：筛选用的三态', () => {
  assert.equal(invoiceStatus({ archived: true }, null), 'stored');
  // reimb 参数允许为 null：列表页只查 invoices 表，那一刻拿不到报销单。
  // 拿不到时按「有 reimbursementId 就是已报销」判定，不能因此把它算成待报销。
  assert.equal(invoiceStatus({ archived: false, reimbursementId: 'r1' }, null), 'reimbursed');
  assert.equal(invoiceStatus({ archived: false, reimbursementId: null }, null), 'pending');
  // reimb 传进来但不匹配（这张票属于别的单）时仍判「已报销」：
  // 一次读库的时序问题不该把一张已经报出去的票退回待报销，那会让用户重复报销同一张票。
  assert.equal(invoiceStatus({ archived: false, reimbursementId: 'r1' }, { id: 'OTHER', status: 'draft' }), 'reimbursed');
  // 脏组合（既存档又在单里）优先按「仅存档」显示——它本不该存在，
  // 但显示成一个没法解释的东西更糟。
  assert.equal(invoiceStatus({ archived: true, reimbursementId: 'r1' }, null), 'stored');
});

test('invoiceBadge：列表上那一行标签的五种文案', () => {
  assert.equal(invoiceBadge({ archived: true }, null), '仅存档');
  assert.equal(invoiceBadge({ archived: false, reimbursementId: null }, null), '待报销');
  assert.equal(invoiceBadge({ archived: false, reimbursementId: 'r1' }, { status: 'draft' }), '报销中');
  assert.equal(invoiceBadge({ archived: false, reimbursementId: 'r1' }, { status: 'submitted' }), '已提交');
  assert.equal(invoiceBadge({ archived: false, reimbursementId: 'r1' }, { status: 'settled' }), '已到账');
  // 拿不到报销单（列表页）时退回中性说法，不猜它到哪一步了。
  assert.equal(invoiceBadge({ archived: false, reimbursementId: 'r1' }, null), '已报销');
  assert.equal(invoiceBadge({ archived: false, reimbursementId: 'r1' }, { status: 'nope' }), '已报销');
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`D:\node.exe --test --test-isolation=none tests/reimburse-model.test.js`

预期：FAIL，报 `Cannot find module '.../app/reimburse-model.js'`。

- [ ] **步骤 3：编写实现**

创建 `app/reimburse-model.js`：

```js
// 报销单的纯逻辑：状态机、标题生成、差额、发票侧的状态推导。
// 本模块是纯数据 + 纯函数，不引用 indexedDB / DOM / Canvas，
// 因此可以在 Node 里直接 import 并单测（见 tests/reimburse-model.test.js）。
//
// 为什么这些逻辑不写在 reimburse-store.js 里：状态流转的合法性与差额的取整
// 恰恰是最容易写错、也最值得用纯单测钉死的部分；一旦它们和数据层混在一起，
// 就只能靠 fake-indexeddb 探针去验，而那层桩盖不住事务回滚（见 tests/helpers/fake-browser.js
// 文件头第 1 条），验出来的绿是虚的。项目里 invoice-model / budget / receivable / theme
// 走的都是「纯逻辑独立成模块」这条路。

// 合计**复用** invoice-model 的 sumCents，不在这里另写一份：
// 同一个数会出现在「发票列表的待报销汇总」和「报销单详情的合计」两处，
// 两套口径只要有一点不同（比如对脏记录的处置），用户就会看到两个对不上的数，
// 而且没有任何地方会报错。
import { sumCents } from './invoice-model.js';

export const STATUS = Object.freeze({
  DRAFT: 'draft',
  SUBMITTED: 'submitted',
  SETTLED: 'settled'
});

// freeze 是必要的：模块级共享数组，任何 import 方 push 一下就会污染全网校验。
export const STATUS_IDS = Object.freeze([STATUS.DRAFT, STATUS.SUBMITTED, STATUS.SETTLED]);

// 用无原型对象：这张表是**导出的**，将来有人直接 STATUS_LABELS[x] 是迟早的事，
// 而 x 命中 'constructor' / 'toString' 会返回函数而不是 undefined——
// statusLabel 里那个 includes 守卫只保护 statusLabel 自己，保护不了裸查的人。
// （这正是 baa3bf7 修掉的那个 bug 的原形。）
export const STATUS_LABELS = Object.freeze(Object.assign(Object.create(null), {
  [STATUS.DRAFT]: '待提交',
  [STATUS.SUBMITTED]: '已提交',
  [STATUS.SETTLED]: '已到账'
}));

export function isStatus(v) {
  return STATUS_IDS.includes(v);
}

export function statusLabel(v) {
  // 判据必须与 isStatus **同源**（都用 STATUS_IDS.includes），不能直接写 STATUS_LABELS[v]。
  // 后者是属性查找、给不出「未知状态」这句兜底。这张表早期还是普通字面量时更糟：
  // 它会命中**原型链**——statusLabel('constructor') 返回的是一个函数
  // （function Object(){[native code]}），'toString' / '__proto__' 同理，而备份文件里的脏 status、
  // 手改过的记录都可能带上这类字符串。表现在已经改成 Object.create(null) 的无原型对象，
  // 但这条守卫要留着：两个函数对「不认识的值」的口径不能分叉——isStatus 说不认识、
  // statusLabel 却给出别的东西，排查时会把人带到错的方向去。
  return STATUS_IDS.includes(v) ? STATUS_LABELS[v] : '未知状态';
}

// ===== 状态机 =====
// 判据一律「白名单」：只放行明确认识的那个状态。读库可能读到脏值
// （手改过的备份、被别的版本写过的记录），白名单让它们在写入前就被挡住，
// 而不是带着一个谁也没定义过的状态继续往下走。

export function canEdit(reimb) {
  return reimb?.status === STATUS.DRAFT;
}

export function canSubmit(reimb) {
  return reimb?.status === STATUS.DRAFT;
}

export function canSettle(reimb) {
  // 草稿不能直接到账：没提交给公司就谈不到「到账」。
  // 真要允许，用户就能做出一张「从没提交过、但已经到账」的单子，
  // 而时间线上那两个节点会变成无意义的装饰。
  return reimb?.status === STATUS.SUBMITTED;
}

export function canDelete() {
  // 任何状态都能删。删不掉才是真的把用户卡住——一张填错的单子如果
  // 因为「已到账」而永远留在列表里，他就只剩下忍着这一条路。
  // 已生成收入账时的额外确认在界面层（reimburse-view.js 的 confirmDelete），不在这里。
  //
  // 它是**零参**的、恒为 true：别用它做可删性判断（`if (!canDelete(...))` 是装饰）。
  // 它在这里的意义是给 canEdit / canSubmit / canSettle / canDelete 这一套判据留个齐整的
  // 落点——「删除不受状态限制」这个决策得有个地方写着。
  return true;
}

export function isActive(reimb) {
  return reimb?.status === STATUS.DRAFT || reimb?.status === STATUS.SUBMITTED;
}

// ===== 计算与推导 =====

// 默认标题「9月报销 · 3 张」。用**本地时间**取月份：UTC 读数落后东八区 8 小时，
// 北京时间 10 月 1 日凌晨（00:00–07:59）那一刻 UTC 还停在 9 月 30 日，
// 用 UTC 会把「10月报销」写成「9月报销」——而用户明明是在 10 月建的单。
//
// 用 isSafeInteger 而不是 isFinite：8.7e15 也是有限数，但 new Date(8.7e15) 是 Invalid Date，
// getMonth() 得到 NaN，标题就写成「NaN月报销 · 3 张」——而标题是要存库、要显示的。
// isSafeInteger 仍挡不住 8.64e15 ~ 9.007e15 那一段，所以再验一次取回的毫秒数。
// 口径与 invoice-model.js 对 issuedAt 的校验一致（那里也是被脏时间戳坑过才改的）。
export function autoTitle(monthTs, count) {
  const ts = Number.isSafeInteger(monthTs) ? monthTs : Date.now();
  const d = new Date(ts);
  const when = Number.isNaN(d.getTime()) ? new Date() : d;
  const n = Number.isSafeInteger(count) && count > 0 ? count : 0;
  return `${when.getMonth() + 1}月报销 · ${n} 张`;
}

// 差额 = 实际到账 − 发票合计。
// settledCents 为 null 表示还没到账，此时**没有差额可谈**，返回 null，
// 界面据此不显示那一行（没有差额就没有信息，显示「差额 ¥0.00」只是噪音）。
// 差额可以为负（公司少报、扣税、抹零），也可以为正（多打了），两者都要如实显示。
export function diffCents(settledCents, invoices) {
  if (settledCents === null || settledCents === undefined) return null;
  if (!Number.isSafeInteger(settledCents)) return null;
  return settledCents - sumCents(invoices);
}

// 发票在**报销追踪**里的状态，供筛选使用（发票规格 §7.2 的五个筛选里有三个用它）。
//
// reimb 允许为 null：发票列表页只查 invoices 表，那一刻手里没有报销单对象。
// 拿不到时按「有 reimbursementId 就是 reimbursed」判定——绝不能因为读不到报销单
// 就把一张已经报出去的票算成「待报销」，那会让用户重复报销同一张票。
export function invoiceStatus(inv, reimb) {
  if (inv?.archived) return 'stored';
  if (!inv?.reimbursementId) return 'pending';
  // reimb 这个参数**刻意不用**：筛选发生在发票列表页，那里只查了 invoices 表，
  // 手里没有报销单，传 null 是常态。保留形参只是为了与 invoiceBadge 同形，
  // 不是做「这张票属于哪张单」的归属校验——归属校验在数据层（reimburse-store），
  // 这里不做，因为没有它也不会把一张已报出去的票算成待报销。
  void reimb;
  return 'reimbursed';
}

// 列表上那一行标签的文案（比 invoiceStatus 细：它要回答「报出去了吗、到哪一步了」）。
// 与 invoiceStatus 分开是因为两者的消费方不同——前者是筛选判据，后者是呈现；
// 合成一个函数会让筛选依赖报销单状态，而筛选那一刻未必读得到它。
export function invoiceBadge(inv, reimb) {
  if (inv?.archived) return '仅存档';
  if (!inv?.reimbursementId) return '待报销';
  const s = reimb?.status;
  if (s === STATUS.DRAFT) return '报销中';
  if (s === STATUS.SUBMITTED) return '已提交';
  if (s === STATUS.SETTLED) return '已到账';
  // 读不到报销单、或状态是脏值：退回中性说法，不猜它到哪一步了。
  return '已报销';
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`D:\node.exe --test --test-isolation=none tests/reimburse-model.test.js`

预期：PASS，10 个测试全过。

- [ ] **步骤 5：跑全量回归**

运行：`D:\node.exe --test --test-isolation=none`

预期：315 pass / 0 fail（原 305 + 新增 10）。

- [ ] **步骤 6：Commit**

```bash
git add app/reimburse-model.js tests/reimburse-model.test.js
git commit -m "feat(reimburse): 报销单的纯逻辑（状态机/标题/差额/发票状态推导）"
```

---

### 任务 2：把 `reimbursements` 接进备份

**为什么这个任务排在界面之前**：`ARRAY_STORES` 里目前**没有** `reimbursements`（`app/backup-store.js:93`），也就是**今天导出的备份不带报销单**。这是规格 §8.1 明确要求、而计划 4 没做的一个既有的洞。它独立于界面，先补上，无论后面怎么变，至少备份不再漏。

**文件：**
- 修改：`app/backup-store.js:93`（`ARRAY_STORES`）
- 修改：`app/backup.js:21-45`（`buildBackup`）、`app/backup.js:73-95`（`summarizeBackup`）
- 测试：`tests/backup.test.js`、`tests/backup-store.test.js`

- [ ] **步骤 1：编写失败的测试**

在 `tests/backup.test.js` 末尾追加（该文件已有的 import 里若没有 `buildBackup` / `summarizeBackup`，一并补上）：

```js
test('buildBackup：reimbursements 进备份包，且老备份读出空数组', () => {
  const reimb = [{ id: 'r1', title: '9月报销 · 2 张', status: 'submitted', createdAt: 1 }];
  const pkg = buildBackup({ reimbursements: reimb }, 1700000000000);
  assert.deepEqual(pkg.data.reimbursements, reimb);

  // 老备份（没有这个键）必须是空数组而不是 undefined：
  // importBackup 的 clears 判据是 `Array.isArray(data[name])`，
  // 给 undefined 就变成「这份备份没带报销单」→ 表不会被清空，
  // 于是恢复出来的库里混着上一份数据的报销单。
  const old = buildBackup({}, 1700000000000);
  assert.deepEqual(old.data.reimbursements, []);
});

test('buildBackup：reimbursements 是深拷贝，改包内数据不影响原数组', () => {
  const src = [{ id: 'r1', title: 'x' }];
  const pkg = buildBackup({ reimbursements: src }, 1);
  pkg.data.reimbursements[0].title = '改过了';
  assert.equal(src[0].title, 'x', '备份包与调用方的数组必须解耦');
});

test('summarizeBackup：数出报销单条数', () => {
  const s = summarizeBackup({ data: { reimbursements: [{ id: 'r1' }, { id: 'r2' }] } });
  assert.equal(s.reimbursements, 2);
  const none = summarizeBackup({ data: {} });
  assert.equal(none.reimbursements, 0);
});

test('REQUIRED_ARRAYS 不含 reimbursements：老备份不能被判成坏文件', () => {
  // 这条是防回归的闸门。REQUIRED_ARRAYS 的含义是「老备份**必须**也有」，
  // 把 reimbursements 加进去会让所有既有备份在 validateBackup 那一步直接被拒，
  // 而「恢复备份」是用户保住账目的唯一通道。发票那次踩过同一个坑（backup.js:4 有注释）。
  const check = validateBackup(buildBackup({}, 1));
  assert.equal(check.ok, true, '没有 reimbursements 键的备份必须是合法的');
});
```

在 `tests/backup-store.test.js` 末尾追加：

```js
test('ARRAY_STORES 覆盖 reimbursements：导出带上、导入清空', async () => {
  await db.putAll([
    { store: 'reimbursements', value: { id: 'r1', title: '9月报销 · 1 张', status: 'draft', createdAt: 1 } }
  ]);
  const out = await exportBackup('pw-123456', 1700000000000);
  await db.replaceAllRecords({ clears: ['reimbursements'], puts: [], deletes: [] });
  assert.equal(await db.get('reimbursements', 'r1'), undefined, '前置：已经清干净');

  await importBackup(out.text, 'pw-123456');
  const back = await db.get('reimbursements', 'r1');
  assert.equal(back?.title, '9月报销 · 1 张', '报销单必须能从备份里恢复');
  assert.equal(back?.status, 'draft');
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`D:\node.exe --test --test-isolation=none tests/backup.test.js tests/backup-store.test.js`

预期：FAIL。`backup.test.js` 的 `pkg.data.reimbursements` 是 `undefined`（`要 deepEqual []`）；`backup-store.test.js` 的最后一条拿不到 `r1`。

- [ ] **步骤 3：编写实现**

`app/backup-store.js`，把第 93 行的清单改成：

```js
// invoices 现在在这里（发票条目是纯 JSON，能进备份包）。
// **reimbursements 也在这里**：报销单本身是纯 JSON，但它与发票的**归属关系**靠
// invoices.reimbursementId 表达，而 invoices 也在同一个清单里 —— 两者必须同进同出，
// 少一个就会恢复出「报销单在、票不知道属不属于它」或者反过来的悬空状态。
// **invoiceFiles 不在这里**：它的 blob / thumbBlob 是 Blob，JSON.stringify(blob) 得到 `{}`，
// 直接进下面那个循环只会往备份里塞一堆空壳，恢复出来就是「有记录、没图片」。
// 它由 encodeFiles() 单独转成 base64 再打包，导入时由 base64ToBlob() 单独反解。
const ARRAY_STORES = ['txns', 'accounts', 'categories', 'receivables', 'invoices', 'reimbursements'];
```

`app/backup.js` 的 `buildBackup` 里，在 `invoices:` 那一行之后加一行：

```js
      reimbursements: deepClone(payload.reimbursements ?? []),
```

`app/backup.js` 的 `summarizeBackup` 里，在 `invoices:` 计数那一行之后加一行：

```js
    reimbursements: countOf(data.reimbursements),
```

**不要**把 `reimbursements` 加进 `REQUIRED_ARRAYS`（`app/backup.js:9`）。

- [ ] **步骤 4：运行测试验证通过**

运行：`D:\node.exe --test --test-isolation=none tests/backup.test.js tests/backup-store.test.js`

预期：PASS。

- [ ] **步骤 5：跑全量回归**

运行：`D:\node.exe --test --test-isolation=none`

预期：319 pass / 0 fail。

**注意**：这一步有可能暴露出**既有测试把 `ARRAY_STORES` 的清单写死了**。若出现失败，不要改断言去迁就，先看清它断言的是什么——如果它断言的是「导出只打包这 5 张表」，那条断言本身就是过时的，应当更新成 6 张并在这条测试里写一句「报销单在计划 5 加入」。

- [ ] **步骤 6：Commit**

```bash
git add app/backup.js app/backup-store.js tests/backup.test.js tests/backup-store.test.js
git commit -m "fix(backup): 报销单进备份（ARRAY_STORES 此前漏了 reimbursements）"
```

---

### 任务 3：`store.addTransaction` 开一个同事务的口子

**文件：**
- 修改：`app/store.js:36-74`
- 测试：`tests/` 下已有的交易测试文件（若没有，则新建 `tests/store-transaction.test.js`）

- [ ] **步骤 1：编写失败的测试**

在交易测试里追加（若新建文件，记得先 `installFakeBrowser()` 与 `await db.open()`）：

```js
test('addTransaction：extraEntries 会与交易一起落库', async () => {
  // 名字只说「一起落库」，不说「同一个事务」——因为这条断言钉住的只有**数据到达**那一层：
  // 额外条目确实被写下去了。它钉不住「同一次 putAll」。实测过：把 store.js 里
  // `await db.putAll(entries.concat(extraEntries))` 拆成两次 putAll（即真的变成两个事务），
  // 这条测试照样绿。名字若承诺「同事务」，它承诺的就是一个自己拿不出证据的保证——
  // 下一个人会以为这层保证有人看着，然后放心去改那行代码。
  //
  // 那层保证由 app/store.js 里「单个 transaction + 单次 putAll」的代码结构承载，它分成两半，
  // 只有一半测不了：**「中途失败整笔回滚」测不了**——tests/helpers/fake-browser.js 文件头第 1 条
  // 差异写的正是它：abort() 只改一个标记，已经写进 Map 的数据不会退回去，桩上根本产生不了
  // 「写了一半」的状态。回滚这半层得靠代码审查与 docs/手动验证清单.md 的真机条目，不靠这条测试
  // （该条目由计划任务 11 步骤 5 补进清单的「报销 · 到账」小节——现在清单里还没有，别去旧章节找）。
  // 而「同一次 putAll」（= 只发起一个事务）**能测**，判据是数事务个数——见下面那段。
  //
  // 这个文件里**不会**出现事务计数断言：桩的 transactionCount() 是任务 4 的交付物，而没有任何
  // 任务会回头改这个文件（任务 4 的文件清单是桩 + reimburse-store.js + 它的测试），所以别把
  // 「这层保证有人看着」读成「就在本文件里」。真正咬住它的是任务 5 那条
  // `settleReimbursement：三处写入只发起一个事务`：settleReimbursement 把报销单当 extraEntries
  // 交给 addTransaction，那一次调用只发起一个事务——把下面 `entries.concat(extraEntries)` 拆成
  // 两次 putAll，那条断言的计数差就从 1 变成 2、必红。
  // 这是**推导，不是实测**：reimburse-store.js 还没实现，那条现在跑不了。
  const txn = await store.addTransaction(
    { kind: 'income', amountCents: 300000, categoryId: 'cat-refund', accountId: 'acc-1' },
    { extraEntries: [{ store: 'reimbursements', value: { id: 'r1', status: 'settled', createdAt: 1 } }] }
  );
  // 主交易本身也得在库里。原先这里只断言 `txn.id` 非空，而 id 走 uid()、永远非空——那等于
  // 什么都没验，这条测试的名字却承诺「与交易**一起**落库」。改为读回库里那条，金额一起钉死，
  // 这样「额外条目到了、主交易没写」这种半截实现才会真的变红。
  assert.equal((await db.get('txns', txn.id)).amountCents, 300000, '主交易必须真的落库');
  const saved = await db.get('reimbursements', 'r1');
  assert.equal(saved?.status, 'settled', '额外的条目必须真的落库');
});

test('addTransaction：不传 extraEntries 时行为与从前完全一致', async () => {
  // 生产代码里 store.addTransaction 只有**一处**调用点：app/ui/entry-panel.js:500（记账面板
  // 提交时），而且它只传一个参数。默认参数要保护的就是它——所以这条测试问的不是「有几处
  // 调用点、重不重要」，而是「不传 extraEntries 时返回值一个字段都不许变」：记账面板没改
  // 任何功能，不该因为这次开的口子悄悄换了行为。
  //
  // 别再写「既有 5 处调用点」：那是计划文档早期的错记。`git grep -n "store.addTransaction(" -- app/`
  // 一跑就看得见只有上面那一条——导入走的是 import-store.js 的 db.putAll，应收走的是
  // store.addReceivable，都不经过这里，它们绿不绿与这个默认参数无关。
  const txn = await store.addTransaction({ kind: 'expense', amountCents: 500 });
  assert.equal(txn.source, 'manual', 'source 默认值不变');
  // 不传时是 **null** 而不是 undefined：这个对象是重建出来的、字段逐个显式列出，
  // `input.reimbursementId ?? null` 对 undefined 也会落成 null。
  assert.equal(txn.reimbursementId, null, '不传时显式写 null');
  // 钉住字段集本身：「不传 extraEntries 时行为不变」的全部含义就是这 14 个字段一个不多、一个不少、
  // 名字一个不差（漏一个＝既有调用点拿到 undefined，多一个＝这个新口子顺手改了返回值），
  // 而 addTransaction 正是**重建**对象的写法，字段集就是它的真契约。只挑 source / reimbursementId
  // 两个字段验，等于让「完全一致」这句话靠运气——正是刚修掉的那条测试名同型的毛病。
  assert.deepEqual(Object.keys(txn).sort(), [
    'accountId', 'amountCents', 'categoryId', 'createdAt', 'id', 'kind', 'note', 'occurredAt',
    'recurringId', 'reimbursementId', 'shares', 'source', 'toAccountId', 'updatedAt'
  ].sort(), '返回值只能是这 14 个字段');
});

test('addTransaction：reimbursementId 会写进交易本身', async () => {
  // store.js 的 addTransaction 是**重建**一个对象、只取固定字段，
  // 没列进去的字段会被静默丢掉（不报错），而删除保护正是靠报销单的 txnId
  // 找回那笔收入的。这一条钉住它。
  const txn = await store.addTransaction({
    kind: 'income', amountCents: 100, source: 'reimbursement', reimbursementId: 'r9'
  });
  const saved = await db.get('txns', txn.id);
  assert.equal(saved.reimbursementId, 'r9');
  assert.equal(saved.source, 'reimbursement');
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`D:\node.exe --test --test-isolation=none tests/store-transaction.test.js`

预期：FAIL。第 1 条 `db.get('reimbursements','r1')` 拿到 `undefined`；第 3 条 `saved.reimbursementId` 是 `undefined`。

- [ ] **步骤 3：编写实现**

把 `app/store.js` 的 `addTransaction` 改成（函数签名与 txn 对象各加一处，其余不动）：

```js
// extraEntries：调用方要把自己的条目写进**同一个事务**时用它。
//
// 存在的理由是报销到账：那一步要同时写一笔收入交易、更新报销单状态、再把 txnId 记回报销单。
// 分两次写一旦中途失败，会留下「钱记上了、报销单还停在已提交」——而用户看到没成功就会
// 再点一次「标记到账」，于是记出**第二笔收入**。宁可控整笔失败。
// （db.replaceAllRecords 的注释、backup-store 的导入注释讲的是同一条纪律。）
//
// 默认参数保证了既有调用点一个字都不用改。
export async function addTransaction(input, { extraEntries = [] } = {}) {
  const now = Date.now();
  const txn = {
    // 允许调用方指定 id：报销到账要在**同一个事务**里把 txnId 写进报销单，
    // 而那要求交易 id 在调用之前就已知（见 reimburse-store.js 的 settleReimbursement——
    // 那个文件由计划任务 4 建立、settleReimbursement 由任务 5 补上，现在都还不存在）。
    // 既有调用点都不传，行为不变。
    // 传一个**已存在**的 id 会静默覆盖那笔交易（db.putAll 走 objectStore.put，同主键即覆盖），
    // 而它先前派生的应收**不会**跟着变——那条 receivables 的 sourceTxnId 仍指向它，主交易却已被
    // 改写，库里留下一对自相矛盾的记录，全程不报错。要改一笔已有的交易请用 updateTransaction。
    id: input.id ?? uid(),
    kind: input.kind,
    amountCents: input.amountCents,
    categoryId: input.categoryId ?? null,
    accountId: input.accountId ?? null,
    toAccountId: input.toAccountId ?? null,
    occurredAt: input.occurredAt ?? now,
    note: input.note ?? '',
    shares: input.shares ?? [],
    recurringId: input.recurringId ?? null,
    source: input.source ?? 'manual',
    // 报销到账生成的收入账会带上它。这个对象是**重建**出来的，没列在这里的字段
    // 会被静默丢掉——而删除保护（删报销单时问「那笔收入要不要一起删」）正是靠
    // 报销单上的 txnId 找回这条交易的，链子断在这里不会报错，只会在删除时找不到它。
    reimbursementId: input.reimbursementId ?? null,
    createdAt: now,
    updatedAt: now
  };
  // 交易与它派生的应收必须同一个事务写入：分次写一旦中途失败（配额满、标签页被杀），
  // 会留下「钱记上了、别人欠我的却少了」的半截数据，而用户重试还会插入第二笔交易。
  const entries = [{ store: 'txns', value: txn }];
  for (const share of txn.shares) {
    entries.push({
      store: 'receivables',
      value: {
        id: uid(),
        personName: share.personName,
        direction: 'owedToMe',
        amountCents: share.amountCents,
        occurredAt: txn.occurredAt,
        dueAt: null,
        settledAt: null,
        note: txn.note,
        sourceTxnId: txn.id
      }
    });
  }
  // 额外的条目追加在最后，由**同一个** putAll 写下去——这就是「同事务」的全部实现。
  // 追加在**主交易之后**有代价：同主键时后面的赢（objectStore.put 逐条覆盖），额外条目若也写
  // `txns` 且撞上 txn.id，就会顶掉刚写下去的主交易，而函数返回的还是被顶掉的那个对象——
  // 调用方拿到一个与库里对不上的 txn。所以额外条目别写 `txns`。
  await db.putAll(entries.concat(extraEntries));
  return txn;
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`D:\node.exe --test --test-isolation=none tests/store-transaction.test.js`

预期：PASS。

- [ ] **步骤 5：跑全量回归**

运行：`D:\node.exe --test --test-isolation=none`

预期：326 pass / 0 fail（基线 323 + 本任务新增 3 条）。

**这一条尤其重要**：`addTransaction` 在生产代码里只有**一处**既有调用点——`app/ui/entry-panel.js:500`（记账面板提交），而且它只传一个参数（`git grep -n "store.addTransaction(" -- app/` 一跑就能核实）。全量绿是「默认参数没让这个唯一调用方换行为」的证据。

**别把这里写成「5 处既有调用点」**（本计划早期就是这个错记）：导入走的是 `import-store.js` 的 `db.putAll`，应收走的是 `store.addReceivable`，两者都不经过 `addTransaction`，它们绿不绿与这个默认参数无关。数字写大了，后来者会以为这层保护比实际更宽，进而觉得「多改几个调用方也没事」。

- [ ] **步骤 6：Commit**

```bash
git add app/store.js tests/
git commit -m "feat(store): addTransaction 支持同事务追加条目，并透传 reimbursementId"
```

---

### 任务 4：`reimburse-store.js` 的读与「建单 / 加票 / 移票」

**先给桩加上事务计数**——这是本计划里「同事务」唯一能被自动验出来的办法。桩的回滚是假的（`abort()` 只改标记），但**它数得清发起了几个事务**，而这正是「一处写入被拆成了两次」时唯一会变红的东西。

**文件：**
- 修改：`tests/helpers/fake-browser.js`（加 `transactionCount()`）
- 创建：`app/reimburse-store.js`
- 测试：`tests/reimburse-store.test.js`

- [ ] **步骤 1：给桩加事务计数**

在 `tests/helpers/fake-browser.js` 里，`const databases = new Map();` 那一行**之后**加：

```js
// 事务计数：给「这几处写入必须落在同一个事务里」这类判据用。
//
// 桩的回滚是假的（见文件头第 1 条：abort() 只改标记，写进 Map 的数据不会退回去），
// 所以「中途失败不留半截」这条**验不了**。但「只发起了几个**写**事务」是能验的，
// 而它恰好是那条保证的**结构前提**：一次 db.putAll / replaceAllRecords 就是一个写事务，
// 把它拆成两次调用，计数就多 1。这是桩能给出的最诚实的那个信号。
//
// **只数 readwrite，不数 readonly**——这一条是 2026-09-28 复审实测纠正的：自增最初写在
// `transaction()` 的第一行，于是 db.get() 那种只读事务也被数进去，判据的基数从 1 变成 2
// （读一次 + 写一次），而下面三处 `assert.equal(transactionCount() - before, 1)` 在**正确
// 实现下也会红**——一条永远红的断言不区分「拆没拆」，等于什么都没验。加上 mode 判定之后
// 「一次批量写 = 1」才成立，把一次写入拆成两次也才会让它变成 2。
let txCount = 0;

export function transactionCount() {
  return txCount;
}
```

再把 `Database` 类的 `transaction(names)` 方法改成（加 mode 形参与一句自增）：

```js
  transaction(names, mode = 'readonly') {
    // 只把**写**事务计进去：db.get / getAll / getAllByIndex 这些读操作不该进这个计数，
    // 否则「一次批量写 = 1」这个判据会被读操作污染成 2 / 3 / 4（见上面 transactionCount 的注释）。
    if (mode === 'readwrite') txCount += 1;
    const list = Array.isArray(names) ? names : [names];
```

- [ ] **步骤 2：编写失败的测试**

创建 `tests/reimburse-store.test.js`：

```js
// 报销单数据层的探针。
//
// 环境：真的 IndexedDB 在 Node 里不存在，这里用 tests/helpers/fake-browser.js 装的内存版。
// 它盖得住「数据形状」（谁写了什么、删了什么），盖不住事务回滚——
// 所以下面凡是要验「同事务」的地方，用的是**事务计数**（见任务 4 步骤 1 给桩加的那个）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeBrowser, transactionCount } from './helpers/fake-browser.js';
import * as db from '../app/db.js';
import { saveInvoice } from '../app/invoice-store.js';
import { STORES } from '../app/schema.js';
import {
  listReimbursements, getReimbursement, listInvoicesOf, listPendingInvoices,
  createReimbursement, renameReimbursement, addInvoicesTo, removeInvoiceFrom
} from '../app/reimburse-store.js';

installFakeBrowser();

const NOW = 1700000000000;

async function clearAll() {
  await db.replaceAllRecords({ clears: Object.keys(STORES), puts: [] });
}

// 造一张发票。saveInvoice 会走 validateInvoice，所以金额必须是合法的安全整数；
// 它也**不接受** reimbursementId（那是 reimburse-store 的事），所以造出来的票一律是「待报销」。
async function mkInvoice({ id, amountCents = 10000, archived = false } = {}) {
  return saveInvoice({ id, number: '', amountCents, issuedAt: NOW, seller: '某公司', type: 'other', archived });
}

test.beforeEach(async () => { await clearAll(); });

test('createReimbursement：建单并把票挂上去', async () => {
  await mkInvoice({ id: 'i1' });
  await mkInvoice({ id: 'i2' });
  const { reimb: r } = await createReimbursement({ invoiceIds: ['i1', 'i2'], title: '9月报销 · 2 张', now: NOW });

  assert.ok(r.id, '要返回新建的报销单');
  assert.equal(r.status, 'draft');
  assert.equal(r.createdAt, NOW);
  assert.equal(r.submittedAt, null);
  assert.equal(r.settledAt, null);
  assert.equal(r.txnId, null);
  assert.equal(r.settledCents, null);

  assert.equal((await db.get('invoices', 'i1')).reimbursementId, r.id);
  assert.equal((await db.get('invoices', 'i2')).reimbursementId, r.id);
});

test('createReimbursement：整批写入只发起一个事务', async () => {
  // 这条是「同事务」的结构判据。拆成「先写报销单、再逐张更新发票」时，
  // 计数会变成 2（桩只数**写**事务，见步骤 1），这条断言立刻变红——
  // 而它在桩上**能**验，回滚那条不能。
  await mkInvoice({ id: 'i1' });
  await mkInvoice({ id: 'i2' });
  await mkInvoice({ id: 'i3' });
  const before = transactionCount();
  await createReimbursement({ invoiceIds: ['i1', 'i2', 'i3'], title: 'x', now: NOW });
  assert.equal(transactionCount() - before, 1, '整批写入必须只发起一个事务');
});

test('createReimbursement：已在别的报销单里的票被跳过，其余照常加入', async () => {
  await mkInvoice({ id: 'i1' });
  await mkInvoice({ id: 'i2' });
  const { reimb: first } = await createReimbursement({ invoiceIds: ['i1'], title: '第一单', now: NOW });
  const { reimb: second, skipped: secondSkipped } = await createReimbursement({ invoiceIds: ['i1', 'i2'], title: '第二单', now: NOW });

  assert.equal((await db.get('invoices', 'i1')).reimbursementId, first.id, 'i1 应当还在第一单里，不能被抢走');
  assert.equal((await db.get('invoices', 'i2')).reimbursementId, second.id);
  assert.deepEqual(secondSkipped, ['i1'], '被跳过的票要报出来，界面据此提示张数');
});

test('createReimbursement：仅存档的票被拒绝', async () => {
  await mkInvoice({ id: 'i1', archived: true });
  await assert.rejects(
    () => createReimbursement({ invoiceIds: ['i1'], title: 'x', now: NOW }),
    /仅存档/
  );
  assert.equal((await db.getAll('reimbursements')).length, 0, '拒绝时不该留下半张报销单');
});

test('createReimbursement：一张票都没有也允许（用户可能先建单）', async () => {
  const { reimb: r } = await createReimbursement({ invoiceIds: [], title: '空的', now: NOW });
  assert.ok(r.id);
  assert.deepEqual(await listInvoicesOf(r.id), []);
});

test('renameReimbursement：草稿能改名，提交后拒绝', async () => {
  await mkInvoice({ id: 'i1' });
  const { reimb: r } = await createReimbursement({ invoiceIds: ['i1'], title: '旧名', now: NOW });
  await renameReimbursement(r.id, '新名');
  assert.equal((await getReimbursement(r.id)).title, '新名');

  await db.put('reimbursements', { ...(await getReimbursement(r.id)), status: 'submitted' });
  await assert.rejects(() => renameReimbursement(r.id, '再改'), /已经提交|不能修改/);
});

test('addInvoicesTo / removeInvoiceFrom：加票与移票', async () => {
  await mkInvoice({ id: 'i1' });
  await mkInvoice({ id: 'i2' });
  const { reimb: r } = await createReimbursement({ invoiceIds: ['i1'], title: 'x', now: NOW });

  const added = await addInvoicesTo(r.id, ['i2']);
  assert.deepEqual(added.skipped, []);
  assert.equal((await db.get('invoices', 'i2')).reimbursementId, r.id);
  assert.equal((await listInvoicesOf(r.id)).length, 2);

  await removeInvoiceFrom(r.id, 'i1');
  assert.equal((await db.get('invoices', 'i1')).reimbursementId, null, '移除后票回到待报销');
  assert.equal((await listInvoicesOf(r.id)).length, 1);
});

test('listPendingInvoices：排除仅存档与已在单里的票', async () => {
  await mkInvoice({ id: 'i1' });
  await mkInvoice({ id: 'i2' });
  await mkInvoice({ id: 'i3', archived: true });
  await createReimbursement({ invoiceIds: ['i2'], title: 'x', now: NOW });

  const pending = await listPendingInvoices();
  assert.deepEqual(pending.map(i => i.id), ['i1'], '只有既没存档、又没在单里的那张算待报销');
});

test('listInvoicesOf / listReimbursements：排序稳定', async () => {
  await mkInvoice({ id: 'i1' });
  await mkInvoice({ id: 'i2' });
  const { reimb: r } = await createReimbursement({ invoiceIds: ['i1', 'i2'], title: 'x', now: NOW });
  const two = await listInvoicesOf(r.id);
  assert.deepEqual(two.map(i => i.id), ['i2', 'i1'], '与 listInvoices 同一套排序：开票日期倒序、同日按录入时间倒序');

  await db.put('reimbursements', { id: 'r0', title: '更早', status: 'draft', createdAt: NOW - 1000 });
  const all = await listReimbursements();
  assert.deepEqual(all.map(x => x.id), [r.id, 'r0'], '报销单按创建时间倒序');
});
```

- [ ] **步骤 3：运行测试验证失败**

运行：`D:\node.exe --test --test-isolation=none tests/reimburse-store.test.js`

预期：FAIL，`Cannot find module '.../app/reimburse-store.js'`。

- [ ] **步骤 4：编写实现**

创建 `app/reimburse-store.js`：

```js
// 报销单的数据层：UI 与 IndexedDB 之间的唯一通道。
// 依赖 db.js（进而依赖 indexedDB），**不能在 Node 里 import**；验证靠 fake-IndexedDB 探针与真机。
//
// 本模块最重要的一条纪律：**每条写操作只用一次批量写调用**（db.putAll 或 db.replaceAllRecords）。
// 报销流程天然是多处写入的（一单对应 N 张票、到账对应一笔交易 + 一条报销单 + 一个 txnId），
// 拆成两次写一旦中途失败，就会留下自相矛盾的库——「报销单建好了、票还没挂上去」
// 或者「钱记上了、报销单还停在已提交」（后者更糟：用户会重试，于是记出第二笔收入）。
// db.replaceAllRecords 与 importBackup 的注释讲的是同一条纪律。
//
// 这条纪律由 tests/reimburse-store.test.js 的**事务计数**守着：
// 拆成两次调用会让计数变成 2，那条断言立刻红。

import * as db from './db.js';
import { uid } from './store.js';
import { canEdit, canSubmit, canSettle, isStatus, STATUS } from './reimburse-model.js';

// 与 invoices 侧的那一对常量同名同值（app/schema.js 里没有它们的定义，
// 键名散在 invoice-store / theme-store 两处）。这里只需要发票侧的 reimbursementId 字段名。
const INVOICE_STORE = 'invoices';
const REIMB_STORE = 'reimbursements';

export class ReimburseError extends Error {
  constructor(message, code = 'BAD_INPUT') {
    super(message);
    this.name = 'ReimburseError';
    this.code = code;
  }
}

// ===== 读 =====

export async function listReimbursements() {
  const all = await db.getAll(REIMB_STORE);
  // 创建时间倒序；同一毫秒的按 id 兜底，保证顺序稳定（否则每次打开列表顺序都在变）。
  return all.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || String(a.id).localeCompare(String(b.id)));
}

export async function getReimbursement(id) {
  if (!id) return null;
  return (await db.get(REIMB_STORE, id)) ?? null;
}

/**
 * 某一单里的发票。走 by_reimbursement 索引——**这里可以走索引**，
 * 因为索引键（reimbursementId）非空；要查的正是「键等于某个值」的记录。
 */
export async function listInvoicesOf(reimbId) {
  if (!reimbId) return [];
  const hits = await db.getAllByIndex(INVOICE_STORE, 'by_reimbursement', reimbId);
  // 索引查询的顺序实际是随机的（同一个索引键下按随机 uid 排），
  // 与 invoice-store.js 的 listInvoices 用同一套排序，保证每次打开顺序一致。
  return hits.sort((a, b) => (b.issuedAt ?? 0) - (a.issuedAt ?? 0) || (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

/**
 * 待报销的发票：既没存档、也不在任何报销单里。
 *
 * **必须 getAll 之后自己 filter，绝不能用 by_reimbursement 索引去查「没有报销单」的票**：
 * 真实 IndexedDB **不索引**键值为 null / undefined 的记录，`IDBKeyRange.only(null)`
 * 还会直接抛 DataError（app/schema.js:25 那段注释讲的就是这个坑，连 index.count()
 * 都会给出一个偏小的数而且看不出来错）。
 */
export async function listPendingInvoices() {
  const all = await db.getAll(INVOICE_STORE);
  return all
    .filter(inv => !inv.archived && !inv.reimbursementId)
    .sort((a, b) => (b.issuedAt ?? 0) - (a.issuedAt ?? 0) || (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

// ===== 内部：发票进出的校验 =====

/**
 * 把一批发票的 reimbursementId 改掉（置为 reimbId，或置 null 表示移出）。
 *
 * 返回 `{ entries, skipped }`：entries 是**待写入的条目**，由调用方并进自己那一次批量写——
 * 这个函数自己**不发事务**，否则「建单 + 挂票」就变成两次写了（见文件头那条纪律）。
 *
 * 两种处置不一样，判据是**用户有没有做错事**：
 *  · 已经在**别的**单里 → 跳过。这多半是列表打开之后的状态变化（另一个标签页先建了单），
 *    用户没做错，不该被一个报错打断整批操作；
 *  · `archived` → **抛错**。「仅存档」是用户亲手动过的标记，它在这条流水线里是明确的排除项
 *    （发票规格 §6.1），选中它说明界面给了他一个不该给的选择，必须停下来讲清楚。
 */
async function invoiceEntriesFor(invoiceIds, reimbId) {
  const entries = [];
  const skipped = [];
  for (const id of invoiceIds ?? []) {
    const inv = await db.get(INVOICE_STORE, id);
    if (!inv) continue;                                   // 已经被删掉的票：静默略过
    if (inv.archived) {
      throw new ReimburseError('这张发票标了「仅存档」，不参与报销', 'ARCHIVED_INVOICE');
    }
    const current = inv.reimbursementId ?? null;
    if (current === reimbId) continue;                    // 已经在本单里：幂等跳过
    if (current) { skipped.push(id); continue; }          // 在别的单里：跳过并报出来
    entries.push({
      store: INVOICE_STORE,
      value: { ...inv, reimbursementId: reimbId, updatedAt: Date.now() }
    });
  }
  return { entries, skipped };
}

// ===== 写（每条一个事务）=====

/**
 * 建一张报销单，并把 invoiceIds 里能挂的票挂上去。
 * 报销单本身与 N 张发票的归属关系**在同一个事务里**落地：分两次写会留下
 * 「单建好了、票还没挂上去」——用户看到一张空单，而票还在待报销里。
 */
export async function createReimbursement({ invoiceIds = [], title = '', now = Date.now() } = {}) {
  const reimb = {
    id: uid(),
    title: String(title ?? '').trim() || '未命名报销',
    status: STATUS.DRAFT,
    createdAt: now,
    submittedAt: null,
    settledAt: null,
    accountId: null,
    txnId: null,
    settledCents: null,
    note: ''
  };
  const { entries, skipped } = await invoiceEntriesFor(invoiceIds, reimb.id);
  await db.putAll([{ store: REIMB_STORE, value: reimb }, ...entries]);
  // 返回两件，不是 `{ ...reimb, skipped }`：后者让同一个实体有两种形状（getReimbursement 读回来的
  // 是纯记录），照抄返回值字段去写库的代码会把 skipped 一起写进去，而且不报错。
  // （复审后本文件的写都改走内部函数 writeAll——一处发起事务、一处把英文异常翻成中文。）
  return { reimb, skipped };
}

export async function renameReimbursement(id, title) {
  const reimb = await getReimbursement(id);
  if (!reimb) throw new ReimburseError('这张报销单不在了', 'NOT_FOUND');
  if (!canEdit(reimb)) throw new ReimburseError('已经提交给公司的报销单不能修改', 'NOT_EDITABLE');
  const next = { ...reimb, title: String(title ?? '').trim() || reimb.title };
  await db.putAll([{ store: REIMB_STORE, value: next }]);
  return next;
}

export async function addInvoicesTo(id, invoiceIds) {
  const reimb = await getReimbursement(id);
  if (!reimb) throw new ReimburseError('这张报销单不在了', 'NOT_FOUND');
  if (!canEdit(reimb)) throw new ReimburseError('已经提交给公司的报销单不能修改', 'NOT_EDITABLE');
  const { entries, skipped } = await invoiceEntriesFor(invoiceIds, id);
  if (entries.length === 0) return { skipped };
  await db.putAll(entries);
  return { skipped };
}

export async function removeInvoiceFrom(id, invoiceId) {
  const reimb = await getReimbursement(id);
  if (!reimb) throw new ReimburseError('这张报销单不在了', 'NOT_FOUND');
  if (!canEdit(reimb)) throw new ReimburseError('已经提交给公司的报销单不能修改', 'NOT_EDITABLE');
  const inv = await db.get(INVOICE_STORE, invoiceId);
  if (!inv || inv.reimbursementId !== id) return;
  await db.putAll([
    { store: INVOICE_STORE, value: { ...inv, reimbursementId: null, updatedAt: Date.now() } }
  ]);
}
```

- [ ] **步骤 5：运行测试验证通过**

运行：`D:\node.exe --test --test-isolation=none tests/reimburse-store.test.js`

预期：PASS，9 个测试全过。

- [ ] **步骤 6：跑全量回归**

运行：`D:\node.exe --test --test-isolation=none`

预期：335 pass / 0 fail（基线 326 + 本任务新增 9 条）。

- [ ] **步骤 7：Commit**

```bash
git add app/reimburse-store.js tests/reimburse-store.test.js tests/helpers/fake-browser.js
git commit -m "feat(reimburse): 报销单数据层的读写（建单/加票/移票），批次写入单事务"
```

---

### 任务 5：提交、到账与删除

**文件：**
- 修改：`app/reimburse-store.js`（追加三个写函数）
- 测试：`tests/reimburse-store.test.js`

- [ ] **步骤 1：编写失败的测试**

在 `tests/reimburse-store.test.js` 末尾追加（并把 import 清单补上 `submitReimbursement, settleReimbursement, deleteReimbursement, listInvoicesOf, getReimbursement, listPendingInvoices`）：

```js
test('submitReimbursement：草稿→已提交，记下 submittedAt', async () => {
  await mkInvoice({ id: 'i1' });
  const { reimb: r } = await createReimbursement({ invoiceIds: ['i1'], title: 'x', now: NOW });
  const after = await submitReimbursement(r.id, NOW + 1000);

  assert.equal(after.status, 'submitted');
  assert.equal(after.submittedAt, NOW + 1000);
  assert.equal((await getReimbursement(r.id)).status, 'submitted', '必须真的落库');
});

test('submitReimbursement：已提交的不能再提交', async () => {
  await mkInvoice({ id: 'i1' });
  const { reimb: r } = await createReimbursement({ invoiceIds: ['i1'], title: 'x', now: NOW });
  await submitReimbursement(r.id, NOW);
  await assert.rejects(() => submitReimbursement(r.id, NOW), /不能重复提交|已提交/);
});

test('settleReimbursement：三处写入只发起一个事务，且都落地', async () => {
  await mkInvoice({ id: 'i1', amountCents: 300000 });
  await mkInvoice({ id: 'i2', amountCents: 2500 });
  const { reimb: r } = await createReimbursement({ invoiceIds: ['i1', 'i2'], title: 'x', now: NOW });
  await submitReimbursement(r.id, NOW);
  await db.put('accounts', { id: 'acc-1', name: '工资卡' });

  const before = transactionCount();
  const settled = await settleReimbursement(r.id, {
    settledCents: 300000, accountId: 'acc-1', categoryId: 'cat-refund', createTxn: true, now: NOW + 5000
  });
  assert.equal(transactionCount() - before, 1, '交易 + 报销单 + txnId 必须落在同一个事务里');

  assert.equal(settled.status, 'settled');
  assert.equal(settled.settledAt, NOW + 5000);
  assert.equal(settled.settledCents, 300000);
  assert.equal(settled.accountId, 'acc-1');
  assert.ok(settled.txnId, '要记下生成的收入账 id');

  const txn = await db.get('txns', settled.txnId);
  assert.equal(txn.kind, 'income');
  assert.equal(txn.amountCents, 300000);
  assert.equal(txn.source, 'reimbursement');
  assert.equal(txn.reimbursementId, r.id, '交易要能找回它的报销单（删除保护靠这个）');
  assert.equal(txn.categoryId, 'cat-refund');
  assert.equal(txn.accountId, 'acc-1');
});

test('settleReimbursement：只标记到账时不生成交易', async () => {
  await mkInvoice({ id: 'i1', amountCents: 1000 });
  const { reimb: r } = await createReimbursement({ invoiceIds: ['i1'], title: 'x', now: NOW });
  await submitReimbursement(r.id, NOW);
  const settled = await settleReimbursement(r.id, {
    settledCents: 1000, accountId: null, categoryId: null, createTxn: false, now: NOW
  });
  assert.equal(settled.status, 'settled');
  assert.equal(settled.txnId, null);
  assert.deepEqual(await db.getAll('txns'), [], '不记账时不该有任何交易');
});

test('settleReimbursement：草稿不能直接到账', async () => {
  await mkInvoice({ id: 'i1' });
  const { reimb: r } = await createReimbursement({ invoiceIds: ['i1'], title: 'x', now: NOW });
  await assert.rejects(
    () => settleReimbursement(r.id, { settledCents: 1, createTxn: false, now: NOW }),
    /还没提交|不能标记到账/
  );
});

test('deleteReimbursement：发票回到待报销，报销单消失', async () => {
  await mkInvoice({ id: 'i1' });
  await mkInvoice({ id: 'i2' });
  const { reimb: r } = await createReimbursement({ invoiceIds: ['i1', 'i2'], title: 'x', now: NOW });

  const before = transactionCount();
  await deleteReimbursement(r.id, { deleteTxn: false });
  assert.equal(transactionCount() - before, 1, '回退发票 + 删单据必须在同一个事务里');

  assert.equal(await getReimbursement(r.id), null);
  assert.equal((await db.get('invoices', 'i1')).reimbursementId, null);
  assert.equal((await db.get('invoices', 'i2')).reimbursementId, null);
  assert.deepEqual((await listPendingInvoices()).map(i => i.id).sort(), ['i1', 'i2'], '票要回到待报销，不是被删掉');
});

test('deleteReimbursement：deleteTxn 为真时连那笔收入一起删', async () => {
  await mkInvoice({ id: 'i1', amountCents: 5000 });
  const { reimb: r } = await createReimbursement({ invoiceIds: ['i1'], title: 'x', now: NOW });
  await submitReimbursement(r.id, NOW);
  const settled = await settleReimbursement(r.id, {
    settledCents: 5000, accountId: null, categoryId: null, createTxn: true, now: NOW
  });

  await deleteReimbursement(r.id, { deleteTxn: true });
  assert.equal(await db.get('txns', settled.txnId), undefined, '选了「一起删」就该删掉');
});

test('deleteReimbursement：deleteTxn 为假时留下那笔收入', async () => {
  await mkInvoice({ id: 'i1', amountCents: 5000 });
  const { reimb: r } = await createReimbursement({ invoiceIds: ['i1'], title: 'x', now: NOW });
  await submitReimbursement(r.id, NOW);
  const settled = await settleReimbursement(r.id, {
    settledCents: 5000, accountId: null, categoryId: null, createTxn: true, now: NOW
  });

  await deleteReimbursement(r.id, { deleteTxn: false });
  assert.ok(await db.get('txns', settled.txnId), '选了「只删报销单」时收入必须留着——那是用户账上的钱');
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`D:\node.exe --test --test-isolation=none tests/reimburse-store.test.js`

预期：FAIL，`submitReimbursement is not a function`。

- [ ] **步骤 3：编写实现**

在 `app/reimburse-store.js` 末尾追加，并把顶部那行 store.js 的 import 合并成：

```js
import { uid, addTransaction } from './store.js';
```

```js
export async function submitReimbursement(id, now = Date.now()) {
  const reimb = await getReimbursement(id);
  if (!reimb) throw new ReimburseError('这张报销单不在了', 'NOT_FOUND');
  if (!canSubmit(reimb)) {
    throw new ReimburseError(
      reimb.status === STATUS.SUBMITTED ? '这张报销单已经提交过了' : '已经到账的报销单不能重复提交',
      'NOT_SUBMITTABLE'
    );
  }
  const next = { ...reimb, status: STATUS.SUBMITTED, submittedAt: now };
  await db.putAll([{ store: REIMB_STORE, value: next }]);
  return next;
}

/**
 * 标记到账。这是本模块唯一一个**跨三张表**的写：
 *   ① 更新报销单（状态 / 到账时间 / 账户 / 实际到账金额 / txnId）
 *   ② 若 createTxn，写一笔收入交易
 * 两件事必须落在**一个**事务里：先写交易、后写报销单，中途失败会留下「钱记上了、
 * 报销单还停在已提交」——用户看到没到账，再点一次「标记到账」，于是记出**第二笔收入**。
 * 而那个半截状态没有任何自愈路径（重启应用也不会去比对）。
 *
 * 实现方式是把「更新报销单」那一条作为 extraEntries 交给 addTransaction，
 * 由它那一次 db.putAll 一并写下去（见 store.js 的 addTransaction 注释）。
 */
export async function settleReimbursement(id, {
  settledCents = 0, accountId = null, categoryId = null, createTxn = true, now = Date.now()
} = {}) {
  const reimb = await getReimbursement(id);
  if (!reimb) throw new ReimburseError('这张报销单不在了', 'NOT_FOUND');
  if (!canSettle(reimb)) {
    throw new ReimburseError(
      reimb.status === STATUS.DRAFT ? '这张报销单还没提交给公司，不能标记到账' : '这张报销单已经到账了',
      'NOT_SETTLEABLE'
    );
  }
  const cents = Number.isSafeInteger(settledCents) ? settledCents : 0;

  if (!createTxn) {
    // 不记账这条路只有一处写入，不必绕 addTransaction。
    const next = {
      ...reimb, status: STATUS.SETTLED, settledAt: now,
      accountId: accountId ?? null, settledCents: cents, txnId: null
    };
    await db.putAll([{ store: REIMB_STORE, value: next }]);
    return next;
  }

  // 交易 id 先自己生成：报销单那一条要与交易**同批写入**，而它里面要写上 txnId——
  // 若等 addTransaction 返回后再写回，就变成两次写入了，那正是这一段要避免的事。
  // 为此任务 3 给 addTransaction 加了 `id: input.id ?? uid()`。
  const txnId = uid();
  const settled = {
    ...reimb, status: STATUS.SETTLED, settledAt: now,
    accountId: accountId ?? null, settledCents: cents, txnId
  };
  await addTransaction({
    id: txnId,
    kind: 'income',
    amountCents: cents,
    categoryId: categoryId ?? null,
    accountId: accountId ?? null,
    occurredAt: now,
    note: `报销到账 · ${reimb.title}`,
    source: 'reimbursement',
    reimbursementId: id
  }, {
    extraEntries: [{ store: REIMB_STORE, value: settled }]
  });

  return settled;
}

/**
 * 删掉一张报销单。两条纪律：
 *  · 单里的发票**回到待报销**，不是被删掉——票是用户的东西，报销单只是它的分组；
 *  · 已经生成过收入账时由**调用方**决定要不要一起删（deleteTxn）。两边都留会变成
 *    对不上的账，所以界面必须问，而且不能默认——但「留还是删」是用户的决定，不是这里的。
 * 三处写入一个事务：回退发票、删单据、（可选）删交易。
 */
export async function deleteReimbursement(id, { deleteTxn = false } = {}) {
  const reimb = await getReimbursement(id);
  if (!reimb) return;

  const invoices = await listInvoicesOf(id);
  const now = Date.now();
  const entries = [
    ...invoices.map(inv => ({
      store: INVOICE_STORE,
      value: { ...inv, reimbursementId: null, updatedAt: now }
    })),
    // 删主键走 removeAll 的形态；replaceAllRecords 的 deletes 与它同形。
    ...(deleteTxn && reimb.txnId ? [{ store: 'txns', key: reimb.txnId }] : [])
  ];

  await db.replaceAllRecords({
    clears: [],
    puts: entries.filter(e => !e.key),
    deletes: [
      ...entries.filter(e => e.key).map(e => ({ store: e.store, key: e.key })),
      { store: REIMB_STORE, key: id }
    ]
  });
}
```

**注意 `settleReimbursement` 里那个 `txnId` 的来历**：它是**调用方**先生成的，然后同时出现在两个地方——交易的 `id`、以及报销单的 `txnId`。这不是绕远路，而是「同事务」的必然要求：报销单那一条必须与交易在同一批里写下去，而它里面要写上交易的 id，所以不能在写之前还不知道那个 id。为此任务 3 的 `addTransaction` 接受了 `id: input.id ?? uid()`。

- [ ] **步骤 4：运行测试验证通过**

运行：`D:\node.exe --test --test-isolation=none tests/reimburse-store.test.js`

预期：PASS，17 个测试全过。

- [ ] **步骤 5：跑全量回归**

运行：`D:\node.exe --test --test-isolation=none`

预期：339 pass / 0 fail。

- [ ] **步骤 6：Commit**

```bash
git add app/reimburse-store.js tests/reimburse-store.test.js
git commit -m "feat(reimburse): 提交/到账/删除，到账三处写入单事务"
```

---

### 任务 6：发票筛选补「已报销」

**文件：**
- 修改：`app/reimburse-model.js`（加 `matchFilter`）
- 修改：`app/ui/invoice-view.js:12-17`（FILTERS）、`:49-56`（inFilter）
- 测试：`tests/reimburse-model.test.js`

- [ ] **步骤 1：编写失败的测试**

在 `tests/reimburse-model.test.js` 末尾追加（import 补上 `matchFilter`）：

```js
test('matchFilter：五个筛选各自的判据', () => {
  const pending = { archived: false, reimbursementId: null, txnId: null };
  const inReimb = { archived: false, reimbursementId: 'r1', txnId: null };
  const stored = { archived: true, reimbursementId: null, txnId: 't1' };
  const linked = { archived: false, reimbursementId: null, txnId: 't1' };

  assert.equal(matchFilter(pending, 'all'), true);
  assert.equal(matchFilter(pending, 'pending'), true);
  assert.equal(matchFilter(inReimb, 'pending'), false);
  assert.equal(matchFilter(inReimb, 'reimbursed'), true, '「已报销」是这次补上的第五个筛选');
  assert.equal(matchFilter(pending, 'reimbursed'), false);
  assert.equal(matchFilter(stored, 'reimbursed'), false, '仅存档的票不参与报销追踪');
  assert.equal(matchFilter(linked, 'unlinked'), false);
  assert.equal(matchFilter(pending, 'unlinked'), true);
  assert.equal(matchFilter(stored, 'stored'), true);
  assert.equal(matchFilter(pending, 'stored'), false);
  // 不认识的筛选 id 一律放行（等于「全部」），不把列表变成空白。
  assert.equal(matchFilter(pending, 'nope'), true);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`D:\node.exe --test --test-isolation=none tests/reimburse-model.test.js`

预期：FAIL，`matchFilter is not a function`。

- [ ] **步骤 3：编写实现**

在 `app/reimburse-model.js` 末尾追加：

```js
// 发票列表的筛选判据。**放在这里而不是 invoice-view.js 里**，是为了能脱离 DOM 单测——
// 「已报销」这一个筛选正是本次要补的缺口（发票规格 §7.2 写了五个，实现只有四个），
// 而它最容易写错的地方是「仅存档的票算不算已报销」（不算：它压根不参与报销追踪）。
export const FILTER_IDS = Object.freeze(['all', 'pending', 'reimbursed', 'unlinked', 'stored']);

export function matchFilter(inv, filterId) {
  switch (filterId) {
    case 'pending': return !inv?.archived && !inv?.reimbursementId;
    case 'reimbursed': return !inv?.archived && Boolean(inv?.reimbursementId);
    case 'unlinked': return !inv?.txnId;
    case 'stored': return Boolean(inv?.archived);
    default: return true;   // 'all' 与任何不认识的 id
  }
}
```

`app/ui/invoice-view.js` 的 `FILTERS` 改成五项（顺序与规格 §7.3 一致）：

```js
const FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'pending', label: '待报销' },
  { id: 'reimbursed', label: '已报销' },
  { id: 'unlinked', label: '未挂账' },
  { id: 'stored', label: '仅存档' }
];
```

同文件的 `inFilter` 整体替换成对纯函数的转发（删掉原来的 switch）：

```js
function inFilter(inv) {
  // 判据本身在 reimburse-model.js 里（可单测），这里只做转发——
  // 五个筛选的边界（尤其「仅存档算不算已报销」）不该只在界面上被验。
  return matchFilter(inv, filter);
}
```

并把这个函数需要的 import 加到文件顶部：

```js
import { matchFilter, invoiceBadge } from '../reimburse-model.js';
```

同文件的列表项状态标签（第 165 行与第 264-266 行两处）改用 `invoiceBadge`：

```js
          el('div', { class: 'inv-tag ' + (inv.archived ? 'stored' : 'pending'), text: invoiceBadge(inv, null) })
```

```js
      inv.archived
        ? el('span', { class: 'inv-tag stored', text: invoiceBadge(inv, null) })
        : el('span', { class: 'inv-tag pending', text: invoiceBadge(inv, null) })
```

**注意**：`invoiceBadge(inv, null)` 传 null 是因为这两处手里没有报销单对象（列表只查了 invoices 表）。它会返回「已报销」这个中性说法，而不是猜「已到账」——猜错的代价是用户以为钱已经到了。

- [ ] **步骤 4：运行测试验证通过**

运行：`D:\node.exe --test --test-isolation=none tests/reimburse-model.test.js`

预期：PASS（11 个测试）。

- [ ] **步骤 5：跑全量回归**

运行：`D:\node.exe --test --test-isolation=none`

预期：340 pass / 0 fail。

- [ ] **步骤 6：界面实测**

在模拟器或本机无头浏览器里打开发票页，确认筛选行现在是**五个**按钮，切到「已报销」时空列表（此时还没有任何报销单），且不报错。

- [ ] **步骤 7：Commit**

```bash
git add app/reimburse-model.js app/ui/invoice-view.js tests/reimburse-model.test.js
git commit -m "feat(invoice): 补上第五个筛选「已报销」，状态标签改用 invoiceBadge"
```

---

### 任务 7：发票 Tab 的分段切换与多选

**文件：**
- 修改：`app/ui/invoice-view.js`
- 修改：`styles/` 下发票相关的 CSS

- [ ] **步骤 1：编写实现——分段状态与切换**

在 `app/ui/invoice-view.js` 的模块级状态区（`let filter = 'all';` 附近）加：

```js
// 当前分段：'list' 发票列表 / 'reimburse' 报销单。与 filter / keyword 同一做法存模块级——
// 切走再回来不该被重置。默认停在发票列表，保持既有用户习惯不变。
let segment = 'list';

// 多选模式：null 表示不在多选；数组表示正在多选的发票 id。
// 用数组而不是 Set：它要参与重渲染比较，数组的顺序稳定、好断言。
let selecting = null;
```

把 `renderInvoices` 的入口按分段分流（在 `const seq = ++viewSeq;` 与数据加载之间插入）：

```js
  if (segment === 'reimburse') {
    // 报销单那一段整块交给 reimburse-view，本文件不掺和它的内部结构。
    const { renderReimbursements } = await import('./reimburse-view.js');
    if (currentTab() !== 'invoice' || seq !== viewSeq) return;
    await renderReimbursements(root, { onSwitchToInvoices: () => { segment = 'list'; selecting = null; renderInvoices(root); } });
    return;
  }
```

**注意**：这里用**动态 import**，理由与 `main.js` 里已经存在的做法一致——报销单视图只有在用户真的切到那一段时才需要加载，而它是本次新增的一整个模块（连带 `sheet`、`keypad`）；静态 import 会让发票页的首屏多背一份用不上的代码。

- [ ] **步骤 2：编写实现——分段条与多选按钮**

在 `mount(root, ...)` 那一段，把顶层结构换成（新增 `segmentBox`，并把它放在 `summaryBox` 之前）：

```js
  const segmentBox = el('div', { class: 'seg-bar' }, [
    el('button', {
      class: 'seg', type: 'button', text: '发票',
      'aria-selected': 'true',
      onclick: () => { /* 已在发票段，无需处理 */ }
    }),
    el('button', {
      class: 'seg', type: 'button', text: '报销单',
      'aria-selected': 'false',
      onclick: () => { segment = 'reimburse'; selecting = null; renderInvoices(root); }
    })
  ]);
```

在搜索框与筛选行之间加一行工具条（只在发票段显示）：

```js
  const toolBar = el('div', { class: 'inv-tools' }, [
    el('button', {
      class: 'btn', type: 'button',
      text: selecting ? '取消' : '选择',
      onclick: () => {
        selecting = selecting ? null : [];
        // 进入多选时把筛选切到「待报销」：不然用户可能把已经报出去的票又选进来，
        // 而那种票会被 createReimbursement 跳过——他白选一场，还不知道为什么。
        if (selecting) filter = 'pending';
        paint();
      }
    })
  ]);
```

`mount(root, ...)` 里按 `segmentBox, summaryBox, searchInput, toolBar, filterBox, listBox` 的顺序组装。

- [ ] **步骤 3：编写实现——列表项的勾选态与底部操作条**

在 `paint()` 里构造每个 `el('button', { class: 'inv-item', ... })` 时，把 class 与点击行为按 `selecting` 分叉：

```js
      const checked = selecting ? selecting.includes(inv.id) : false;
      return el('button', {
        class: 'inv-item' + (checked ? ' is-checked' : ''),
        type: 'button',
        onclick: () => {
          if (!selecting) { openInvoiceEditor({ id: inv.id, onSaved: refresh }); return; }
          // 已在单里的票不给选：它会被 createReimbursement 跳过，选它只是浪费一次点击。
          if (inv.reimbursementId || inv.archived) return;
          selecting = checked ? selecting.filter(x => x !== inv.id) : [...selecting, inv.id];
          paint();
        }
      }, [
        selecting ? el('span', { class: 'inv-check', 'aria-checked': String(checked), role: 'checkbox' }) : null,
        thumb,
        // …其余子节点不变
      ]);
```

在 `paint()` 的末尾（`mount(listBox, items);` 之后）追加底部操作条：

```js
    // 底部操作条：选中 ≥1 张才出现。筹码式的禁用态会让人猜「为什么不能点」，
    // 而这里本来就没有可做的事。
    const bar = document.querySelector('.reimburse-bar');
    if (bar) bar.remove();
    if (selecting && selecting.length > 0) {
      const picked = all.filter(i => selecting.includes(i.id));
      const total = picked.reduce((s, i) => s + (Number.isSafeInteger(i.amountCents) ? i.amountCents : 0), 0);
      document.body.append(el('div', { class: 'reimburse-bar' }, [
        el('span', { class: 'rb-total', text: `已选 ${picked.length} 张 · ${formatCents(total, { symbol: true })}` }),
        el('button', {
          class: 'btn btn-primary', type: 'button', text: '发起报销',
          onclick: () => openCreateReimburseSheet(picked, refresh)
        })
      ]));
    }
```

`all` 与 `formatCents` 在该文件里都已可用（`all` 是 `renderInvoices` 里的闭包变量，`formatCents` 已 import）。

**注意**：操作条挂在 `document.body` 上而不是 `root` 里，因为 `paint()` 会整块替换 `listBox`；挂在 `root` 里会被下一次 paint 顺手清掉。相应地，`renderInvoices` 每次进入时必须先清掉上一次留下的操作条——在函数开头加一句：

```js
  document.querySelector('.reimburse-bar')?.remove();
```

- [ ] **步骤 4：编写实现——发起报销的确认面板**

在 `app/ui/invoice-view.js` 末尾追加：

```js
// 发起报销：确认标题。默认「9月报销 · N 张」，可改。
function openCreateReimburseSheet(invoices, onDone) {
  const input = el('input', { type: 'text', value: autoTitle(Date.now(), invoices.length) });
  const body = el('div', { class: 'stack' }, [
    el('div', { class: 'muted tiny', text: `这 ${invoices.length} 张票会打成一单，合计 ${formatCents(sumCents(invoices), { symbol: true })}` }),
    input,
    el('button', {
      class: 'btn btn-primary', type: 'button', text: '创建报销单',
      onclick: async () => {
        try {
          // createReimbursement 返回 { reimb, skipped } **两件**（任务 4；复审已从 `{ ...reimb, skipped }`
          // 改成两件，免得同一个实体有两种形状）。这一版两件都还没用上，用的时候照这两个名字解构：
          //  · skipped 非空 = 有票已经在别的单里，这里要提示「N 张已经在别的报销单里」（计划末尾「类型一致性」）；
          //  · reimb.id 用于下面那句「跳到那一单」——任务 8 做出详情页之后改成直接进它。
          await createReimbursement({
            invoiceIds: invoices.map(i => i.id),
            title: input.value
          });
          sheet.close();
          selecting = null;
          // 建完直接跳到那一单的详情：用户刚做完一件事，应该看到它的结果，
          // 而不是回到列表里自己找那张新建的单。
          segment = 'reimburse';
          renderInvoices(document.getElementById('view') ?? document.querySelector('.view'));
        } catch (err) {
          mount(body, el('div', { class: 'vault-error', text: String(err?.message || err) }));
        }
      }
    })
  ]);
  const sheet = openSheet({ title: '发起报销', body });
}
```

顶部 import 补上：

```js
import { openSheet } from './sheet.js';            // 已有
import { autoTitle, matchFilter, invoiceBadge } from '../reimburse-model.js';
import { createReimbursement } from '../reimburse-store.js';
import { sumCents } from '../invoice-model.js';
```

**注意**：`openCreateReimburseSheet` 里那句重新渲染用了 `document.getElementById('view')`——**实现时请照该文件已有的做法取 root**（`renderInvoices(root)` 的 `root` 是参数，`paint()` 与 `refresh()` 都靠闭包拿它）。把这个面板函数改成接收 `root` 参数，从 `paint()` 里传进来，**不要**去猜 DOM 结构。

- [ ] **步骤 5：补 CSS**

在发票相关的样式文件里追加（类名与颜色令牌沿用该文件已有的变量）：

```css
.seg-bar { display: flex; gap: 0; margin: 0 0 12px; }
.seg-bar .seg { flex: 1; padding: 7px 0; font-size: 13px; border: 1px solid var(--line, #d3d3d3); background: transparent; color: var(--text-2, #63636a); }
.seg-bar .seg[aria-selected="true"] { background: var(--text, #111); color: var(--bg, #fff); }
.inv-tools { display: flex; justify-content: flex-end; margin: -4px 0 8px; }
.inv-item.is-checked { outline: 2px solid var(--accent, #c85a3f); outline-offset: -2px; }
.inv-check { width: 18px; height: 18px; flex: none; border: 1.5px solid var(--line, #d3d3d3); border-radius: 3px; }
.inv-item.is-checked .inv-check { background: var(--accent, #c85a3f); }
.reimburse-bar { position: fixed; left: 12px; right: 12px; bottom: 12px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 14px; background: var(--surface, #fff); border-radius: 10px; box-shadow: 0 4px 16px rgba(0,0,0,.18); z-index: 40; }
.reimburse-bar .rb-total { font-size: 13px; color: var(--text-2, #63636a); }
```

**注意**：上面用的是**兜底色值**。实现时请先打开样式文件看清该项目实际使用的变量名与命名习惯（分段条与勾选框属于新增组件，没有现成的类可抄），把 `--line` / `--surface` / `--accent` 换成**实际存在的**令牌。**这一步不要跳过**：写一个不存在的变量名，浏览器会静默回退到兜底色，而皮肤切换时这两个控件不会跟着变色。

- [ ] **步骤 6：界面实测**

在无头浏览器或模拟器里：
1. 切到「报销单」再切回「发票」，确认分段状态保持；
2. 点「选择」→ 确认筛选自动跳到「待报销」、列表项出现勾选框；
3. 勾两张 → 确认底部出现操作条且金额等于两张之和；
4. 点「发起报销」→ 改名 → 创建 → 确认跳到了报销单详情（此时详情还没做，任务 8 之后才能完整跑通）。

- [ ] **步骤 7：跑全量回归 + Commit**

运行：`D:\node.exe --test --test-isolation=none`（预期 340 pass / 0 fail，本任务不动逻辑层）

```bash
git add app/ui/invoice-view.js styles/ app/reimburse-model.js
git commit -m "feat(invoice): 发票 Tab 加分段切换与多选发起报销"
```

---

### 任务 8：报销单的列表与详情

**文件：**
- 创建：`app/ui/reimburse-view.js`
- 修改：`styles/` 下发票相关的 CSS

- [ ] **步骤 1：编写实现**

创建 `app/ui/reimburse-view.js`：

```js
// 报销单的两个视图：列表（按状态分组）与详情（缩略图 + 合计 + 时间线 + 操作）。
// 依赖 reimburse-store（进而 IndexedDB），验证靠模拟器/无头浏览器实测。
import { el, mount } from './dom.js';
import { currentTab } from '../router.js';
import { formatCents } from '../money.js';
import { invoiceTitle } from '../invoice-model.js';
import { sumCents } from '../invoice-model.js';
import { STATUS, statusLabel, isActive, canEdit, canSettle, autoTitle, diffCents } from '../reimburse-model.js';
import {
  listReimbursements, listInvoicesOf, getReimbursement,
  submitReimbursement, removeInvoiceFrom, deleteReimbursement
} from '../reimburse-store.js';
import { openSettleSheet } from './settle-sheet.js';
import { openInvoiceEditor } from './invoice-editor.js';
import { openSheet } from './sheet.js';

// 当前打开的报销单 id：null 表示在列表。存模块级，与 invoice-view 的 filter / keyword 同一做法——
// 切走再回来，用户应该还在他刚才那一单上。
let openId = null;

// 渲染序号。与 invoice-view.js 的 viewSeq 是同一类问题：main.js 的 renderSeq 只保证
// 「哪一次渲染有权挂 tabbar」，拦不住本视图在 await 之后自己写 root。
// 少了它，「进报销单页后立刻点统计」会复现「统计高亮着却显示报销单」的错位。
let viewSeq = 0;

export async function renderReimbursements(root, { onSwitchToInvoices } = {}) {
  const seq = ++viewSeq;
  if (openId) return renderDetail(root, openId, { seq, onSwitchToInvoices });

  const all = await listReimbursements();
  if (currentTab() !== 'invoice' || seq !== viewSeq) return;

  // 每张单要显示「N 张 · 合计」，而这两个数都在发票表里，所以逐单查一次。
  // 报销单的数量是「人手动建的」，几十张顶天，不做批量化。
  const rows = await Promise.all(all.map(async r => ({ r, invoices: await listInvoicesOf(r.id) })));
  if (currentTab() !== 'invoice' || seq !== viewSeq) return;

  const active = rows.filter(({ r }) => isActive(r));
  const settled = rows.filter(({ r }) => r.status === STATUS.SETTLED);

  function group(title, list) {
    if (list.length === 0) return null;
    return el('div', { class: 'stack' }, [
      el('div', { class: 'muted tiny', text: `${title}（${list.length}）` }),
      ...list.map(({ r, invoices }) => el('button', {
        class: 'reimb-card', type: 'button',
        onclick: () => { openId = r.id; renderReimbursements(root, { onSwitchToInvoices }); }
      }, [
        el('div', { class: 'rc-head' }, [
          el('span', { class: 'rc-title', text: r.title }),
          el('span', { class: 'rc-status', text: statusLabel(r.status) })
        ]),
        el('div', { class: 'rc-meta', text: `${invoices.length} 张 · ${formatCents(sumCents(invoices), { symbol: true })}` }),
        // 已到账且实际金额与合计不同时才显示差额：没有差额就没有信息，
        // 显示一行「差额 ¥0.00」只是噪音。
        r.status === STATUS.SETTLED && diffCents(r.settledCents, invoices)
          ? el('div', { class: 'rc-diff', text: `实际到账 ${formatCents(r.settledCents, { symbol: true })} · 差额 ${formatCents(diffCents(r.settledCents, invoices), { symbol: true })}` })
          : null
      ]))
    ]);
  }

  mount(root,
    all.length === 0
      ? el('div', { class: 'empty' }, [
          el('div', { text: '还没有报销单' }),
          el('button', {
            class: 'btn btn-primary', type: 'button', text: '去发票里选几张',
            // 把「怎么开始」直接铺好：切回发票段并进入多选。
            onclick: () => onSwitchToInvoices?.({ startSelecting: true })
          })
        ])
      : el('div', { class: 'stack' }, [
          group('进行中', active),
          group('已到账', settled)
        ].filter(Boolean))
  );
}

async function renderDetail(root, id, { seq, onSwitchToInvoices }) {
  const r = await getReimbursement(id);
  if (currentTab() !== 'invoice' || seq !== viewSeq) return;
  if (!r) { openId = null; return renderReimbursements(root, { onSwitchToInvoices }); }

  const invoices = await listInvoicesOf(id);
  if (currentTab() !== 'invoice' || seq !== viewSeq) return;

  const total = sumCents(invoices);
  const diff = diffCents(r.settledCents, invoices);

  // 时间线：三个节点，未发生的灰显。已到账的单才显示到账节点的时间。
  const nodes = [
    { label: '创建', ts: r.createdAt },
    { label: '提交', ts: r.submittedAt },
    { label: '到账', ts: r.settledAt }
  ];

  const actions = [];
  if (canEdit(r)) {
    actions.push(el('button', {
      class: 'btn btn-primary', type: 'button', text: '提交给公司',
      onclick: () => submitReimbursement(id).then(() => renderReimbursements(root, { onSwitchToInvoices }))
    }));
  }
  if (canSettle(r)) {
    actions.push(el('button', {
      class: 'btn btn-primary', type: 'button', text: '标记到账',
      onclick: () => openSettleSheet({
        reimb: r, invoices,
        onSettled: () => renderReimbursements(root, { onSwitchToInvoices })
      })
    }));
  }
  actions.push(el('button', {
    class: 'btn btn-danger', type: 'button', text: '删除',
    onclick: () => confirmDelete(r, () => {
      openId = null;
      renderReimbursements(root, { onSwitchToInvoices });
    })
  }));

  mount(root, el('div', { class: 'stack' }, [
    el('button', {
      class: 'btn', type: 'button', text: '← 报销单',
      onclick: () => { openId = null; renderReimbursements(root, { onSwitchToInvoices }); }
    }),
    el('div', { class: 'rd-title', text: r.title }),
    el('div', { class: 'muted tiny', text: statusLabel(r.status) }),

    // 票的横向列表。点一张进发票详情（那里能看到原图与全部字段）。
    invoices.length === 0
      ? el('div', { class: 'empty', text: '这张报销单还没有发票' })
      : el('div', { class: 'rd-invoices' }, invoices.map(inv => el('div', { class: 'rd-inv' }, [
          el('button', {
            class: 'rd-inv-main', type: 'button', text: invoiceTitle(inv),
            onclick: () => openInvoiceEditor({ id: inv.id, onSaved: () => renderReimbursements(root, { onSwitchToInvoices }) })
          }),
          el('span', { class: 'rd-inv-amt', text: formatCents(inv.amountCents ?? 0, { symbol: true }) }),
          canEdit(r) ? el('button', {
            class: 'btn tiny', type: 'button', text: '移除',
            onclick: async () => { await removeInvoiceFrom(id, inv.id); renderReimbursements(root, { onSwitchToInvoices }); }
          }) : null
        ]))),

    el('div', { class: 'rd-total' }, [
      el('span', { text: '发票合计' }),
      el('span', { text: formatCents(total, { symbol: true }) })
    ]),
    r.status === STATUS.SETTLED ? el('div', { class: 'rd-total' }, [
      el('span', { text: '实际到账' }),
      el('span', { text: formatCents(r.settledCents ?? 0, { symbol: true }) })
    ]) : null,
    diff ? el('div', { class: 'rd-diff', text: `差额 ${formatCents(diff, { symbol: true })}` }) : null,

    el('div', { class: 'rd-timeline' }, nodes.map(n => el('div', {
      class: 'rd-node' + (n.ts ? '' : ' is-pending')
    }, [
      el('span', { class: 'rd-dot' }),
      el('span', { class: 'rd-label', text: n.label }),
      el('span', { class: 'rd-time', text: n.ts ? new Date(n.ts).toLocaleString('zh-CN') : '—' })
    ]))),

    el('div', { class: 'rd-actions' }, actions)
  ]));
}

// 删除保护（规格 §6.6）：生成过收入账的单子必须问，而且不能默认——
// 两边都留会变成对不上的账，默认删又会动用户账上的钱。
function confirmDelete(r, onDone) {
  const body = el('div', { class: 'stack' });
  const sheet = openSheet({ title: '删除报销单', body });

  async function run(deleteTxn) {
    try {
      await deleteReimbursement(r.id, { deleteTxn });
      sheet.close();
      onDone();
    } catch (err) {
      mount(body, el('div', { class: 'vault-error', text: String(err?.message || err) }));
    }
  }

  mount(body,
    el('div', { class: 'muted tiny', text: '单里的发票会回到「待报销」，不会被删掉。' }),
    r.txnId
      ? el('div', { class: 'stack' }, [
          el('div', { text: '这张报销单生成过一笔收入，要不要一起删？' }),
          el('button', { class: 'btn btn-danger', type: 'button', text: '连那笔收入一起删', onclick: () => run(true) }),
          el('button', { class: 'btn', type: 'button', text: '只删报销单，留下收入', onclick: () => run(false) })
        ])
      : el('button', { class: 'btn btn-danger', type: 'button', text: '删除', onclick: () => run(false) })
  );
}
```

- [ ] **步骤 2：补 CSS**

在发票样式文件末尾追加（同样请先把 `--surface` / `--text-2` 等换成项目里**实际存在**的令牌）：

```css
.reimb-card { display: block; width: 100%; text-align: left; padding: 12px 14px; margin-bottom: 8px; background: var(--surface, #fff); border: 1px solid var(--line, #d3d3d3); border-radius: 10px; }
.rc-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.rc-title { font-size: 15px; }
.rc-status { font-size: 11px; color: var(--text-2, #63636a); }
.rc-meta { font-size: 12.5px; color: var(--text-2, #63636a); margin-top: 4px; }
.rc-diff { font-size: 12px; color: var(--accent, #c85a3f); margin-top: 4px; }
.rd-title { font-size: 20px; }
.rd-invoices { display: block; }
.rd-inv { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--line, #d3d3d3); }
.rd-inv-main { flex: 1; text-align: left; background: none; border: none; padding: 0; font-size: 14px; color: inherit; }
.rd-inv-amt { font-size: 13px; color: var(--text-2, #63636a); }
.rd-total { display: flex; justify-content: space-between; font-size: 14px; padding: 6px 0; }
.rd-diff { font-size: 13px; color: var(--accent, #c85a3f); }
.rd-timeline { margin: 12px 0; }
.rd-node { display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 13px; }
.rd-node.is-pending { opacity: .45; }
.rd-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent, #c85a3f); flex: none; }
.rd-time { margin-left: auto; color: var(--text-2, #63636a); font-size: 12px; }
.rd-actions { display: flex; gap: 8px; flex-wrap: nowrap; margin-top: 12px; }
```

- [ ] **步骤 3：界面实测**

1. 从发票列表多选两张 → 发起报销 → 落在详情页，确认标题、两张票、合计都对；
2. 点「提交给公司」→ 状态变已提交，「提交」按钮消失；
3. 点「移除」删掉一张票 → 合计跟着变小（**只在草稿态能点**，提交后按钮应消失）；
4. 返回列表 → 这张单在「进行中」组里；
5. 点「删除」→ 确认发票回到待报销（切到发票段筛「待报销」能看到它们）。

- [ ] **步骤 4：跑全量回归 + Commit**

运行：`D:\node.exe --test --test-isolation=none`（预期 340 pass / 0 fail）

```bash
git add app/ui/reimburse-view.js styles/
git commit -m "feat(reimburse): 报销单列表与详情（分组/合计/时间线/删除保护）"
```

---

### 任务 9：到账面板

**文件：**
- 修改：`app/reimburse-model.js`（加 `settleDefaults`）
- 创建：`app/ui/settle-sheet.js`
- 测试：`tests/reimburse-model.test.js`

- [ ] **步骤 1：编写失败的测试**

在 `tests/reimburse-model.test.js` 末尾追加（import 补上 `settleDefaults`）：

```js
test('settleDefaults：金额取合计、账户取上次用的、分类默认退款', () => {
  const invoices = [{ amountCents: 300000 }, { amountCents: 2500 }];
  const accounts = [{ id: 'acc-1' }, { id: 'acc-2' }];
  const d = settleDefaults({ invoices, lastAccountId: 'acc-2', accounts });
  assert.equal(d.settledCents, 302500, '默认金额就是发票合计');
  assert.equal(d.accountId, 'acc-2', '与记账面板「上次用的账户」同一个来源');
  assert.equal(d.categoryId, 'cat-refund');
});

test('settleDefaults：上次那个账户已经不在了就退回第一个', () => {
  const accounts = [{ id: 'acc-1' }];
  const d = settleDefaults({ invoices: [], lastAccountId: 'acc-9', accounts });
  assert.equal(d.accountId, 'acc-1');
  assert.equal(d.settledCents, 0);
});

test('settleDefaults：一个账户都没有时 accountId 为 null（不编一个不存在的 id）', () => {
  const d = settleDefaults({ invoices: [], lastAccountId: 'acc-9', accounts: [] });
  assert.equal(d.accountId, null);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`D:\node.exe --test --test-isolation=none tests/reimburse-model.test.js`

预期：FAIL，`settleDefaults is not a function`。

- [ ] **步骤 3：编写实现——纯函数部分**

在 `app/reimburse-model.js` 末尾追加：

```js
// 到账面板的三个默认值。**放在纯模块里**是为了能单测「上次那个账户已经不在了怎么办」
// 这类分支——它只有在用户删过账户之后才会出现，靠手点是撞不上的。
export const DEFAULT_SETTLE_CATEGORY = 'cat-refund';   // schema.js 的默认种子里确实有它，且 kind 就是 income

export function settleDefaults({ invoices = [], lastAccountId = null, accounts = [] } = {}) {
  const ids = (accounts ?? []).map(a => a?.id).filter(Boolean);
  // 上次用的账户可能已经被删了（记账面板那边写 lastAccountId 时不校验）。
  // 退到第一个账户，而不是把那个不存在的 id 传下去——传下去会让 saveInvoice 之后的
  // 交易指向一个没有的账户，界面上显示空白，用户找不到哪一笔没记上。
  const accountId = ids.includes(lastAccountId) ? lastAccountId : (ids[0] ?? null);
  return {
    settledCents: sumCents(invoices),
    accountId,
    categoryId: DEFAULT_SETTLE_CATEGORY
  };
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`D:\node.exe --test --test-isolation=none tests/reimburse-model.test.js`

预期：PASS（14 个测试）。

- [ ] **步骤 5：编写实现——面板**

创建 `app/ui/settle-sheet.js`：

```js
// 「标记到账」的半屏面板：金额 / 账户 / 分类 + 一个「只标记到账、不记收入」。
// 三个默认值来自 reimburse-model 的 settleDefaults（纯函数、已单测）。
import { el, mount } from './dom.js';
import { openSheet } from './sheet.js';
import { createKeypad } from './keypad.js';
import { formatCents } from '../money.js';
import { settleDefaults } from '../reimburse-model.js';
import { settleReimbursement } from '../reimburse-store.js';
import { listCategories, listAccounts, getSetting } from '../store.js';

export function openSettleSheet({ reimb, invoices, onSettled }) {
  const body = el('div', { class: 'stack' });
  const sheet = openSheet({ title: '标记到账', body });
  let busy = false;

  async function build() {
    const [accounts, categories, lastAccountId] = await Promise.all([
      listAccounts(),
      listCategories('income'),
      getSetting('lastAccountId', null)
    ]);
    const d = settleDefaults({ invoices, lastAccountId, accounts });

    let settledCents = d.settledCents;
    let accountId = d.accountId;
    let categoryId = d.categoryId;
    let createTxn = true;

    const keypad = createKeypad({ onChange: ({ cents }) => { settledCents = cents ?? 0; } });
    keypad.setFromCents(settledCents);

    const accountSel = el('select', {}, accounts.map(a => el('option', { value: a.id, text: a.name })));
    if (accountId) accountSel.value = accountId;
    accountSel.onchange = () => { accountId = accountSel.value; };

    const catSel = el('select', {}, categories.map(c => el('option', { value: c.id, text: c.name })));
    catSel.value = categoryId;
    catSel.onchange = () => { categoryId = catSel.value; };

    const noTxnCheck = el('input', {
      type: 'checkbox',
      onchange: (e) => { createTxn = !e.target.checked; }
    });

    mount(body,
      el('div', { class: 'muted tiny', text: `「${reimb.title}」共 ${invoices.length} 张，合计 ${formatCents(settledCents, { symbol: true })}` }),
      el('div', { class: 'field' }, [el('span', { text: '到账金额' })]),
      keypad.node,
      el('label', { class: 'field' }, [el('span', { text: '账户' }), accountSel]),
      el('label', { class: 'field' }, [el('span', { text: '分类' }), catSel]),
      el('label', { class: 'field row' }, [noTxnCheck, el('span', { text: '只标记到账，不记收入' })]),
      el('button', {
        class: 'btn btn-primary', type: 'button', text: '确认到账',
        onclick: async () => {
          if (busy) return;   // 防止连点两次记出两笔收入（面板收起有 180ms 动画）
          busy = true;
          try {
            // 0 是合法值（公司拒报、一分没报回来），但要确认一次——
            // 手滑清空输入框同样会得到 0，两者在屏幕上长得一样。
            if (createTxn && settledCents === 0
                && !window.confirm('到账金额是 ¥0.00，确定吗？')) { busy = false; return; }
            await settleReimbursement(reimb.id, { settledCents, accountId, categoryId, createTxn });
            sheet.close();
            onSettled?.();
          } catch (err) {
            busy = false;
            mount(body, el('div', { class: 'vault-error', text: String(err?.message || err) }));
          }
        }
      })
    );
  }

  build().catch(err => {
    mount(body, el('div', { class: 'vault-error', text: String(err?.message || err) }));
  });
}
```

- [ ] **步骤 6：界面实测**

造一张已提交的单，点「标记到账」：
1. 金额输入框预填发票合计；
2. 账户预选「上次用的那个」（先在记账面板记一笔，让 `lastAccountId` 有值）；
3. 分类预选「退款」；
4. 改金额为合计减 12 → 确认 → 详情页出现「差额 −¥12.00」；
5. 切到记账页 → 首页多出一笔收入，金额是改过的那个数；
6. 另一张单选「只标记到账」→ 确认后记账页**没有**多出交易。

- [ ] **步骤 7：跑全量回归 + Commit**

运行：`D:\node.exe --test --test-isolation=none`（预期 343 pass / 0 fail）

```bash
git add app/reimburse-model.js app/ui/settle-sheet.js tests/reimburse-model.test.js
git commit -m "feat(reimburse): 标记到账面板（金额/账户/分类 + 可只标记不记账）"
```

---

### 任务 10：编辑器里「仅存档」与报销单的互斥

**文件：**
- 修改：`app/ui/invoice-editor.js:311`（勾选框）、`:320-350`（保存）

- [ ] **步骤 1：编写实现——勾选框处拦截**

把 `app/ui/invoice-editor.js` 第 311 行的勾选框改成：

```js
  const archivedCheck = el('input', {
    type: 'checkbox',
    onchange: async (e) => {
      // 互斥保护（发票规格 §6.1）：一张票不能同时是「已提交待报销」和「仅存档」。
      // 判据要**现查库**，不能用 state 里的副本——state 可能是在这张票进报销单之前
      // 载入的（面板开着、另一个标签页把它加了进去），用旧副本会放行。
      if (e.target.checked && state.id) {
        const cur = await invoiceStore.getInvoice(state.id);
        if (cur?.reimbursementId) {
          e.target.checked = false;
          showError('这张票在一张报销单里，请先把它从报销单里移出，再标为「仅存档」');
          return;
        }
      }
      state.archived = e.target.checked;
    }
  });
```

其中 `showError` 用该文件里已有的错误显示方式。**实现时先读该文件**：它已有把错误显示在面板里的现成机制（保存失败时用的那套，见第 346 行附近的 catch），**复用它**，不要新造一个。若它没有独立函数，就把那段 catch 里的挂载逻辑提成一个小函数再调用。

- [ ] **步骤 2：编写实现——保存时兜底**

在 `app/ui/invoice-editor.js` 保存路径（第 346 行 `await invoiceStore.saveInvoice(state)` **之前**）插入：

```js
      // 兜底：上面那个 onchange 是**异步**的，用户在它落定之前就点「保存」是有可能的
      // （查库要一个事务的时间）。这里再拦一次，避免那条竞态把互斥状态写进库。
      if (state.archived && state.id) {
        const cur = await invoiceStore.getInvoice(state.id);
        if (cur?.reimbursementId) {
          mount(body, el('div', { class: 'vault-error', text: '这张票在一张报销单里，不能标为「仅存档」。请先从报销单里把它移出。' }));
          return;
        }
      }
```

**注意**：上面的 `body` 与 `mount` 要换成该文件里实际使用的错误显示节点与写法（第 346 行附近的 catch 就是模板）。

- [ ] **步骤 3：界面实测**

1. 建一张单，把某张票加进去（提交前）；
2. 打开那张票的编辑器，勾「仅存档」→ 应被拒绝并看到提示，勾选框弹回未勾状态；
3. 把票从单里移除 → 再勾「仅存档」→ 这次应当成功保存。

- [ ] **步骤 4：跑全量回归 + Commit**

运行：`D:\node.exe --test --test-isolation=none`（预期 343 pass / 0 fail）

```bash
git add app/ui/invoice-editor.js
git commit -m "feat(invoice): 编辑器拦截「仅存档」与报销单的互斥状态"
```

---

### 任务 11：收尾（缓存版本、手动清单、全量实测）

**文件：**
- 修改：`sw.js`（`CACHE` 版本 +1、`ASSETS` 补新模块）
- 修改：`docs/手动验证清单.md`（加「报销」小节）

- [ ] **步骤 1：升 SW 缓存版本**

打开 `sw.js`，把 `const CACHE = 'pvault-v18';` 改成 `'pvault-v19'`，并把本次新增的四个模块加进 `ASSETS` 清单：`app/reimburse-model.js`、`app/reimburse-store.js`、`app/ui/reimburse-view.js`、`app/ui/settle-sheet.js`。

**这一步不能省**：`ASSETS` 少一条会让 `cache.addAll` 整批被 404 拒绝，install 失败、SW 根本不激活，而症状是「离线白屏」——排查起来要绕一圈（`sw.js` 开头那段注释讲的就是这两条路的区别）。

- [ ] **步骤 2：跑全量回归**

运行：`D:\node.exe --test --test-isolation=none`

预期：343 pass / 0 fail。**这是本计划结束时必须留下的基线。**

- [ ] **步骤 3：完整走一遍主流程**

在模拟器或本机无头浏览器里，从零走完：

1. 新建两张发票（金额分别 3000.00 与 25.00）；
2. 发票列表点「选择」→ 筛选自动跳到「待报销」→ 勾两张 → 底部条显示「已选 2 张 · ¥3,025.00」；
3. 「发起报销」→ 默认标题「9月报销 · 2 张」→ 创建 → 跳到详情；
4. 详情里合计 ¥3,025.00；
5. 「提交给公司」→ 状态变已提交，「移除」按钮消失（`canEdit` 生效）；
6. 「标记到账」→ 金额预填 3025.00 → 改成 3013.00 → 确认；
7. 详情出现「实际到账 ¥3,013.00」与「差额 −¥12.00」；
8. 记账首页多出一笔 ¥3,013.00 的收入；
9. 回发票列表，「已报销」筛选里能看到那两张票；
10. 删掉这张报销单 → 选「连那笔收入一起删」→ 发票回到「待报销」、记账页那笔收入消失。

**全程控制台不许出现未处理的拒绝。**

- [ ] **步骤 4：备份往返实测**

在浏览器里：导出备份 → 清空 IndexedDB → 导入 → 确认报销单、它的状态、`txnId`、以及发票的 `reimbursementId` 都回来了。

**判据要能让「什么都没做」的实现变红**：导出之后、导入之前，先把本机的报销单**改成另一个状态**（比如把 `status` 手工改掉），导入后必须变回备份里的那个状态——只清空再导入的话，即使导入端根本没写报销单表，也可能因为别的原因看不出问题。

- [ ] **步骤 5：给 `docs/手动验证清单.md` 加「报销」小节**

在文件末尾追加（沿用该文件既有的复选框格式与「哪一条验什么」的写法）：

```markdown
## 报销

### 发起与流转
- [ ] 发票列表点「选择」，筛选项自动跳到「待报销」，列表项出现勾选框
- [ ] 勾两张后底部浮出「已选 N 张 · ¥X」，金额等于两张之和
- [ ] 「发起报销」默认标题是「M月报销 · N 张」，改成别的名字后能保存
- [ ] 创建后直接落在该报销单详情，票与合计数都对
- [ ] 「提交给公司」之后「移除」按钮消失（提交后不能再改票）
- [ ] 已是「仅存档」的票不在「待报销」筛选里，也选不进报销单
- [ ] 在一张票的编辑器里勾「仅存档」→ 若它在报销单里会被拒绝并给出提示

### 到账
- [ ] 「标记到账」的金额预填发票合计，账户预选上次用的那个，分类预选「退款」
- [ ] 把到账金额改成比合计少 12 元 → 详情出现「差额 −¥12.00」
- [ ] 确认后记账首页多出一笔收入，金额是**改过**的那个数
- [ ] 勾「只标记到账，不记收入」→ 确认后记账页**没有**多出交易
- [ ] 到账金额填 0 → 会要求二次确认（公司拒报时 0 是合法的）
- [ ] 到账那批写入一旦失败，不许留下半截（可人为制造：把交给 `addTransaction` 的 `extraEntries`
      的 value 里塞一个 IndexedDB 克隆不了的值，例如 `bad: () => {}`——真机上 `put()` 会**同步**
      抛 DataCloneError，`db.js` 的 `enqueue` 捕获后调 `tx.abort()` 让整批作废）：点「标记到账」
      报错后，记账首页**没有**多出那笔收入、报销单**仍停在「已提交」**；去掉那个坏值重试，
      只记出**一笔**收入（不是两笔）
  - 备注：这是「交易 + 报销单 + txnId 必须落在同一个事务里」在真机上唯一的验法——桩的 `abort()`
    只改标记，写进 Map 的数据不会退回去，所以这一条自动测不了（见 `tests/helpers/fake-browser.js`
    文件头第 1 条）
  - 备注重申（2026-09-28 复审纠正）：它验的是 `enqueue` 显式 abort 这条路——abort 发生在**提交
    之前**，所以「写了一半」的半截状态其实从未产生；措辞上别把它读成「异步请求失败自动中止事务」
    （那是另一条路径，规范里同样会中止，但不是这条用例打到的）

### 删除保护
- [ ] 删掉一张已生成收入的报销单 → 弹窗问「要不要一起删那笔收入」
- [ ] 选「连那笔收入一起删」→ 记账页那笔收入消失
- [ ] 选「只删报销单，留下收入」→ 记账页那笔收入还在
- [ ] 两种选择下，单里的发票都回到「待报销」（不是被删掉）

### 备份
- [ ] 导出备份 → 把本机报销单改成另一个状态 → 导入 → 状态变回备份里的那个
- [ ] 导入**旧版本**（本计划之前）导出的备份：**不报错**，且本机原有的报销单**被保留**——老备份里没有 `reimbursements` 这个键，就不进清理清单，与发票表的行为一致（判据是 `Array.isArray(data[name])`，别与 `arrayOrEmpty` 混淆）；其余数据完好

### 与外观的交叉
- [ ] 新增的分段条与勾选框在五套皮肤 × 深浅两档下都跟着变色（若有任一控件用了不存在的 CSS 变量，它会保持兜底色不跟随皮肤——这一条专门盯它）
```

- [ ] **步骤 6：Commit**

```bash
git add sw.js docs/手动验证清单.md
git commit -m "chore(reimburse): SW 缓存升到 v19、手动验证清单加「报销」小节"
```

---

## 自检

**规格覆盖度**（逐节对照 `2026-09-28-pvault-reimbursement-design.md`）：

| 规格章节 | 落在哪个任务 |
|---|---|
| §3.1 `reimbursements` 表与 `settledCents` | 任务 4（建单写全字段）、任务 5（settle 写它） |
| §3.2 `invoices` 的两个字段 | 任务 4（`invoiceEntriesFor`）、任务 10（互斥） |
| §3.3 `txns` 新增字段 | 任务 3（`reimbursementId` 透传 + `id` 可指定）、任务 5 |
| §3.4 备份 | 任务 2、任务 11 步骤 4 |
| §4 模块划分 | 任务 1 / 4 / 8 / 9 / 10 各自建文件 |
| §5.1 状态机 | 任务 1 |
| §5.2 计算与推导 | 任务 1（`autoTitle` / `diffCents` / `invoiceStatus` / `invoiceBadge`）；`sumInvoiceCents` **改为复用 `invoice-model.sumCents`**（DRY，见下） |
| §5.3 金额口径 | 任务 1（复用 `sumCents`）+ 任务 9（`settleDefaults`） |
| §6.1 读 | 任务 4 |
| §6.2 写 | 任务 4、5 |
| §6.3 到账三处一事务 | 任务 5 |
| §6.4 进出校验 | 任务 4（`invoiceEntriesFor`）、任务 10（反方向） |
| §6.5 事务纪律 | 任务 4（`transactionCount` 判据）、任务 5 |
| §6.6 删除保护 | 任务 5 + 任务 8（`confirmDelete`） |
| §7.1 分段切换 | 任务 7 |
| §7.2 多选与发起报销 | 任务 7 |
| §7.3 五个筛选 | 任务 6 |
| §7.4 列表与详情 | 任务 8 |
| §7.5 到账确认 | 任务 9 |
| §7.6 渲染竞态 | 任务 8（`viewSeq`） |
| §8 错误处理 | 任务 4（跳过/拒绝）、任务 5（状态前置检查）、任务 9（0 元确认、连点保护） |
| §9 测试策略 | 任务 1/4/5/6/9 的单测 + 任务 7/8/9/10/11 的界面实测 |
| §10 任务划分 | 本计划的 11 个任务一一对应 |
| §11 风险 | 由上述任务的判据分别兜住 |

**两处对规格的修正**（本计划刻意偏离规格，理由如下）：

1. **`sumInvoiceCents` 不新建，改为复用 `invoice-model.js` 已有的 `sumCents`**。规格 §5.2 列了这个函数，但它已经存在（`app/invoice-model.js:104`），再写一份就是两份口径——而这两个数会并排出现在「发票列表的待报销汇总」和「报销单详情的合计」上。DRY。
2. **事务原子性改用「事务计数」判据**。规格 §9 写的是「注入一次写失败，确认库里没有半截状态」，但 `fake-browser.js` 的桩**盖不住回滚**（文件头第 1 条：`abort()` 只改标记、写进 Map 的数据不退回去），那条断言在桩上永远绿、什么也没证明。改成数事务个数之后，「把一次写入拆成两次」这种真实错误会立刻变红。

**占位符扫描**：无「待定 / TODO / 后续实现 / 类似任务 N」。唯一的「实现时先读该文件」出现在任务 10 步骤 1、2 与任务 7 步骤 5——它们的成对内容（要复用哪个已有机制、要把哪些变量名换成实际令牌）都写明了具体做法，不是「补充细节」。

**类型一致性**：`createReimbursement` 返回 `{ reimb, skipped }` **两件**——任务 4 最初写的是 `{ ...reimb, skipped }`（把 skipped 并进实体），复审时改掉了：那会让同一个实体有两种形状（`getReimbursement` 读回来的是纯记录，规格字段表里没有 skipped），而照抄返回值字段去写库的代码（改名、改状态那类）会把 skipped 一起写进库，且没有任何地方会报错。现在测试也钉住了这一点（`Object.keys(created)` 与「库里那条没有 skipped」）。任务 7 只用它的返回对象存在与否，未读 `skipped`——**但界面应当读它**：若 `skipped` 非空要提示「N 张已经在别的报销单里」。任务 7 步骤 4 的代码块里已写明这一点。计划里**所有** `createReimbursement` 的调用点都已按新形状解构：绑定返回值的地方一律是 `const { reimb: X } = await createReimbursement(...)`，后面的 `X.id` / `X.title` 一行都不用动；唯一还要读 `skipped` 的那处（任务 4 测试块「已在别的报销单里的票被跳过」）是 `const { reimb: second, skipped: secondSkipped } = ...`，把 `skipped` 拿到外层来断言——它验的仍是「被跳过的票要报出来」，语义没变。四处不绑定返回值的地方（任务 4 的「整批写入只发起一个事务」、「仅存档的票被拒绝」里的 `assert.rejects`、「listPendingInvoices」，以及任务 7 步骤 4）本来就只关心「它跑完没有」，不读返回值，因此不受形状影响。其余函数签名在本计划内前后一致：`settleReimbursement(id, opts)` 的参数名在任务 5 与任务 9 一致；`listInvoicesOf` / `listPendingInvoices` / `getReimbursement` 三处的用途与返回形状一致。另：复审后 `reimburse-store.js` 的四个写函数不再各自 `db.putAll`，统一走内部函数 `writeAll`（一处发起事务、一处把 `QuotaExceededError` 这类英文异常翻成中文，口径照 `invoice-store` 的 `putInvoice`），任务 5 的 submit / settle 也照这个走。

