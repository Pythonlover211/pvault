# pvault 发票本体 实现计划（计划 4）

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让 pvault 能存发票——拍照或选文件存进 App，记下号码/金额/销售方等标准字段，并能把多张票挂到某笔账上。

**架构：** 新增三张 IndexedDB 表（发票、发票文件、报销单，本计划只用前两张；报销单表先建好、计划 5 再填），图片经 Canvas 压缩后与缩略图分开存放，列表页只加载缩略图。纯逻辑（字段校验、尺寸计算）抽成可单测的独立模块，Canvas 与 IndexedDB 部分靠模拟器实测。

**技术栈：** 原生 ES Modules、IndexedDB（手写封装）、Canvas、零第三方依赖；测试用 `node --test --test-isolation=none`。

**依据规格：** `docs/superpowers/specs/2026-09-24-pvault-invoice-design.md`

---

## 文件结构

**创建**

| 文件 | 职责 |
|---|---|
| `app/invoice-model.js` | 纯逻辑：发票类型枚举、字段校验、查重键、金额合计、显示标题 |
| `app/image-scale.js` | 纯逻辑：压缩目标尺寸、是否需要压缩、备份体积估算 |
| `app/image-store.js` | Canvas 压缩 + 缩略图生成 + `invoiceFiles` 表读写（依赖浏览器 API，不可在 Node import） |
| `app/invoice-store.js` | 发票 CRUD、按号码查重、挂靠到账目（依赖 db.js，不可在 Node import） |
| `app/ui/invoice-view.js` | 发票列表页（搜索、筛选、汇总、列表） |
| `app/ui/invoice-editor.js` | 新建/编辑发票的半屏 sheet |
| `styles/invoice.css` | 发票模块样式 |
| `tests/invoice-model.test.js` | 上述纯逻辑的单测 |
| `tests/image-scale.test.js` | 上述纯逻辑的单测 |

**修改**

| 文件 | 改动 |
|---|---|
| `app/schema.js` | `DB_VERSION` 1→2；`STORES` 加 `invoices` / `invoiceFiles` / `reimbursements` |
| `app/router.js` | `TABS` 加第四项 `invoice` |
| `app/main.js` | 注册 `invoice` 视图到 `renderers` |
| `app/store.js` | 导出 `uid` 供 invoice-store 复用（已导出，无需改；确认即可） |
| `index.html` | 引入 `styles/invoice.css` |
| `sw.js` | `ASSETS` 加 7 个新文件；`CACHE` 从 `pvault-v12` 改成 `pvault-v13` |
| `app/backup.js` | `buildBackup` 的 `data` 加 `invoices` / `invoiceFiles` |
| `app/backup-store.js` | 导出/导入带上两张新表；图片走 base64 |
| `app/ui/ledger-home.js` | 今日流水每行显示发票标记，点开看这笔账的发票 |
| `docs/手动验证清单.md` | 加「发票」小节 |

**只增不改**：`app/db.js` 新增一个 `getAllByIndex`（按索引取多条）。已核实它目前只有 `get` / `getAll` / `getByRange`，**没有**任何按索引取值的函数，而查重与挂靠都要用；除此之外 `app/money.js`、`app/crypto.js`、`app/dates.js`、`app/summary.js` 不动。

---

## 任务 1：数据表与迁移

**文件：**
- 修改：`app/schema.js`
- 测试：`tests/schema.test.js`（追加）

- [ ] **步骤 1：编写失败的测试**

追加到 `tests/schema.test.js` 末尾：

```js
test('STORES 里有发票相关的三张表', () => {
  assert.ok(STORES.invoices, '缺少 invoices 表');
  assert.ok(STORES.invoiceFiles, '缺少 invoiceFiles 表');
  assert.ok(STORES.reimbursements, '缺少 reimbursements 表');
  assert.equal(STORES.invoices.keyPath, 'id');
  assert.equal(STORES.invoiceFiles.keyPath, 'id');
  assert.equal(STORES.reimbursements.keyPath, 'id');
});

test('invoices 的索引齐全（查重与挂靠都要用）', () => {
  const names = STORES.invoices.indexes.map(([n]) => n).sort();
  assert.deepEqual(names, ['by_issuedAt', 'by_number', 'by_reimbursement', 'by_txn']);
});

test('DB_VERSION 已提到 2', () => {
  assert.equal(DB_VERSION, 2);
});

test('迁移只建缺失的表，已有的表不重复创建', () => {
  const created = [];
  const fakeDb = {
    objectStoreNames: { contains: (n) => n === 'accounts' },
    createObjectStore: (name) => {
      created.push(name);
      return { createIndex: () => {} };
    }
  };
  applyMigrations(fakeDb, 1);
  assert.ok(!created.includes('accounts'), '已存在的表不该重建');
  assert.ok(created.includes('invoices'));
  assert.ok(created.includes('invoiceFiles'));
  assert.ok(created.includes('reimbursements'));
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test --test-isolation=none tests/schema.test.js`
预期：FAIL —— 断言 `STORES.invoices` 为 undefined。

- [ ] **步骤 3：编写最少实现代码**

把 `app/schema.js` 顶部的常量与 `STORES` 改成：

```js
export const DB_NAME = 'pvault';
export const DB_VERSION = 2;

export const STORES = {
  txns: { keyPath: 'id', indexes: [['by_occurredAt', 'occurredAt'], ['by_kind', 'kind']] },
  accounts: { keyPath: 'id', indexes: [] },
  categories: { keyPath: 'id', indexes: [['by_kind', 'kind']] },
  receivables: { keyPath: 'id', indexes: [['by_settledAt', 'settledAt']] },
  settings: { keyPath: 'key', indexes: [] },
  // 发票本体。报销状态不单独存，由 reimbursementId + 报销单状态推导（见规格第 6 节）。
  invoices: {
    keyPath: 'id',
    indexes: [
      ['by_issuedAt', 'issuedAt'],
      ['by_number', 'number'],
      ['by_txn', 'txnId'],
      ['by_reimbursement', 'reimbursementId']
    ]
  },
  // 发票的图片/PDF 单独一张表：列表页只加载缩略图，不为显示一行把几 MB 的原图读进内存。
  invoiceFiles: { keyPath: 'id', indexes: [] },
  // 报销单。计划 4 只建表不用，计划 5 才填。
  reimbursements: { keyPath: 'id', indexes: [['by_status', 'status']] }
};
```

`applyMigrations` **不需要改**：它已经是「表不存在才创建」，对老库是加表、对新库是全建，两种情况都正确。

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test --test-isolation=none tests/schema.test.js`
预期：PASS，且原有断言全绿。

- [ ] **步骤 5：跑全量测试**

运行：`node --test --test-isolation=none`
预期：全部通过（186 条 + 新增 4 条）。

- [ ] **步骤 6：Commit**

```bash
git add app/schema.js tests/schema.test.js
git commit -m "feat(schema): 加发票三张表并把 DB_VERSION 提到 2"
```

---

## 任务 2：发票纯逻辑模块

**文件：**
- 创建：`app/invoice-model.js`
- 测试：`tests/invoice-model.test.js`

- [ ] **步骤 1：编写失败的测试**

创建 `tests/invoice-model.test.js`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INVOICE_TYPES, TYPE_IDS, typeLabel,
  dedupeKey, validateInvoice, sumCents, invoiceTitle
} from '../app/invoice-model.js';

test('发票类型枚举有 7 项且 id 唯一', () => {
  assert.equal(INVOICE_TYPES.length, 7);
  // 断言整份 id 清单：只抽查两个 id 的话，另外五个拼错（比如 e_invoice 写成 einvoice）
  // 测试照样是绿的，而库里已经存进去的旧数据会突然变成「发票类型无效」。
  assert.deepEqual(TYPE_IDS, [
    'vat_special', 'vat_normal', 'e_invoice', 'itinerary', 'train', 'taxi', 'other'
  ]);
  assert.equal(new Set(TYPE_IDS).size, 7);
  // TYPE_IDS 是模块级共享数组，必须冻结：否则任何 import 方 push 一下就会污染全校验。
  assert.ok(Object.isFrozen(TYPE_IDS), 'TYPE_IDS 应当是冻结的，避免被 import 方改动');
});

test('typeLabel：认识的类型给中文名，不认识的给兜底', () => {
  assert.equal(typeLabel('vat_special'), '增值税专用发票');
  assert.equal(typeLabel('nope'), '未知类型');
  assert.equal(typeLabel(undefined), '未知类型');
});

test('dedupeKey：只有非空号码才参与查重', () => {
  assert.equal(dedupeKey({ number: '12345678' }), '12345678');
  assert.equal(dedupeKey({ number: '  12345678  ' }), '12345678', '应去掉首尾空白');
  assert.equal(dedupeKey({ number: '' }), null);
  assert.equal(dedupeKey({ number: '   ' }), null);
  assert.equal(dedupeKey({}), null);
  assert.equal(dedupeKey(null), null);
});

test('validateInvoice：合法输入通过', () => {
  const r = validateInvoice({ number: '123', amountCents: 10000, issuedAt: 1700000000000, type: 'vat_normal', taxCents: 300 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
});

test('validateInvoice：金额缺失和金额不合法给两种不同的提示', () => {
  // 只拍照没填金额就点保存，是最常见的失败路径：keypad 返回 null，走「请先输入」这条。
  // 界面上没有「分」这个单位，旧文案「金额必须是不小于 0 的整数分」用户不知道要改什么。
  const missing = validateInvoice({ amountCents: null });
  assert.deepEqual(missing.errors, ['请先输入价税合计金额']);
  assert.deepEqual(validateInvoice({}).errors, ['请先输入价税合计金额'],
    '字段整个缺失（undefined）也按「还没输入」处理');
  assert.deepEqual(validateInvoice({ amountCents: undefined }).errors, ['请先输入价税合计金额']);

  assert.deepEqual(validateInvoice({ amountCents: 12.5 }).errors, ['金额格式不对，请重新输入']);
  assert.deepEqual(validateInvoice({ amountCents: -1 }).errors, ['金额格式不对，请重新输入']);
  assert.deepEqual(validateInvoice({ amountCents: '100' }).errors, ['金额格式不对，请重新输入'],
    '字符串不该被当作合法整数');
  assert.deepEqual(validateInvoice({ amountCents: 1e21 }).errors, ['金额格式不对，请重新输入'],
    '1e21 是整数但超出安全整数范围，存进 IndexedDB 再读出来就不是原来那个数了');
  assert.equal(validateInvoice({ amountCents: 0 }).ok, true, '0 元是合法的');
});

test('validateInvoice：issuedAt 必须是毫秒安全整数', () => {
  // 这里曾经写成 Number.isFinite(Number(x))，下面这些脏值会被全部放行，
  // 而 new Date('2026') 只解析到 1970 年附近——按 issuedAt 倒序的列表会把它沉到最底。
  for (const bad of ['', '   ', '2026', true, 1.5, NaN, [], '1700000000000']) {
    const r = validateInvoice({ amountCents: 1, issuedAt: bad });
    assert.equal(r.ok, false, `issuedAt=${JSON.stringify(bad)} 应当被拒`);
    assert.deepEqual(r.errors, ['开票日期无效']);
  }
  assert.equal(validateInvoice({ amountCents: 1, issuedAt: 1700000000000 }).ok, true);
  assert.equal(validateInvoice({ amountCents: 1, issuedAt: null }).ok, true, '没填日期由上层兜，这里不拦');
  assert.equal(validateInvoice({ amountCents: 1, issuedAt: undefined }).ok, true);
});

test('validateInvoice：文本字段必须是字符串', () => {
  // number 传数字 0 时编辑器里 state.number.trim() 会直接抛 TypeError；
  // 传对象时 dedupeKey 得到 '[object Object]'，两张脏票互判「这张票已经录过了」。
  assert.deepEqual(validateInvoice({ amountCents: 1, number: 0 }).errors, ['发票号码必须是文字']);
  assert.deepEqual(validateInvoice({ amountCents: 1, number: {} }).errors, ['发票号码必须是文字']);
  assert.deepEqual(validateInvoice({ amountCents: 1, seller: 5 }).errors, ['销售方必须是文字']);
  assert.deepEqual(validateInvoice({ amountCents: 1, buyerTitle: 5 }).errors, ['购买方抬头必须是文字']);
  assert.deepEqual(validateInvoice({ amountCents: 1, buyerTaxId: 5 }).errors, ['纳税人识别号必须是文字']);
  assert.deepEqual(validateInvoice({ amountCents: 1, note: [] }).errors, ['备注必须是文字']);

  assert.equal(validateInvoice({ amountCents: 1, number: '0' }).ok, true, '字符串 "0" 是合法的');
  assert.equal(validateInvoice({ amountCents: 1, seller: '' }).ok, true);
  // 缺省与 null 都放行：字段没填是常态，由订单据的界面自己决定必填与否。
  assert.equal(validateInvoice({ amountCents: 1 }).ok, true);
  assert.equal(validateInvoice({ amountCents: 1, note: null }).ok, true);
});

test('validateInvoice：输入不是对象时提示数据不完整，而不是怪金额', () => {
  for (const bad of [null, undefined, 'x', 42]) {
    const r = validateInvoice(bad);
    assert.equal(r.ok, false);
    assert.deepEqual(r.errors, ['发票数据不完整'], `${JSON.stringify(bad)} 应当报数据不完整`);
  }
});

test('validateInvoice：税额不合法与税额大于总额给不同提示', () => {
  const bigger = validateInvoice({ amountCents: 100, taxCents: 101 });
  assert.equal(bigger.ok, false);
  assert.deepEqual(bigger.errors, ['税额比价税合计还大，请核对这两项金额']);

  assert.deepEqual(validateInvoice({ amountCents: 100, taxCents: -1 }).errors, ['税额格式不对，请重新输入']);
  assert.deepEqual(validateInvoice({ amountCents: 100, taxCents: 1.5 }).errors, ['税额格式不对，请重新输入']);
  assert.deepEqual(validateInvoice({ amountCents: 100, taxCents: '30' }).errors, ['税额格式不对，请重新输入']);
  assert.equal(validateInvoice({ amountCents: 100, taxCents: 100 }).ok, true, '税额等于总额是允许的');
  assert.equal(validateInvoice({ amountCents: 100, taxCents: null }).ok, true, '没填税额不参与判断');
});

test('validateInvoice：未知类型被拒，type 缺省放行，号码格式不做校验', () => {
  assert.equal(validateInvoice({ amountCents: 1, type: 'weird' }).ok, false);
  // 缺省放行是刻意的：仓库层 saveInvoice 会兜成 'other'，编辑器 state.type 初值也是 'other'。
  assert.equal(validateInvoice({ amountCents: 1 }).ok, true, '没给 type 应当放行');
  assert.equal(validateInvoice({ amountCents: 1, type: null }).ok, true);
  // 发票号码格式各地不一（8 位 / 20 位都有），不校验格式是刻意的
  assert.equal(validateInvoice({ amountCents: 1, number: '随便什么' }).ok, true);
});

test('sumCents：空数组与脏数据都安全', () => {
  assert.equal(sumCents([]), 0);
  assert.equal(sumCents(null), 0);
  assert.equal(sumCents([{ amountCents: 100 }, { amountCents: 250 }]), 350);
  assert.equal(sumCents([{ amountCents: 100 }, {}]), 100);
  // 备份恢复会绕过 validateInvoice 把脏数据直接写进库，这里不能抛错，也不能把脏值算进来：
  // 旧实现用 Number(x) || 0，会把 '5' 当成 5 分、把小数分照加，0.5 + 0.5 凭空多出一分钱。
  assert.equal(sumCents([{ amountCents: '5' }, { amountCents: -3 }, { amountCents: 0.5 }, { amountCents: 0.5 }]), 0,
    '字符串、负数、小数一律不计');
  assert.equal(sumCents([{ amountCents: 100 }, { amountCents: '5' }]), 100);
  assert.equal(sumCents([{ amountCents: 0 }]), 0);
});

test('invoiceTitle：优先用销售方，其次号码，最后兜底', () => {
  assert.equal(invoiceTitle({ seller: '某某公司', number: '1' }), '某某公司');
  assert.equal(invoiceTitle({ seller: '  ', number: '12345678' }), '发票 12345678');
  assert.equal(invoiceTitle({}), '未命名发票');
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test --test-isolation=none tests/invoice-model.test.js`
预期：FAIL —— 报 `Cannot find module '../app/invoice-model.js'`。

- [ ] **步骤 3：编写最少实现代码**

创建 `app/invoice-model.js`：

```js
// 发票的纯逻辑：类型枚举、字段校验、查重键、金额合计、显示标题。
// 本模块是纯数据 + 纯函数，不引用 indexedDB / Canvas / DOM，
// 因此可以在 Node 里直接 import 并单测（见 tests/invoice-model.test.js）。

export const INVOICE_TYPES = [
  { id: 'vat_special', label: '增值税专用发票' },
  { id: 'vat_normal', label: '增值税普通发票' },
  { id: 'e_invoice', label: '电子发票' },
  { id: 'itinerary', label: '行程单' },
  { id: 'train', label: '火车票' },
  { id: 'taxi', label: '出租车票' },
  { id: 'other', label: '其他' }
];

// freeze 是必要的：这是模块级共享数组，任何 import 方 push 一下就会污染全校验，
// 而且这种污染在测试里跑不出错（同一个进程内先污染后校验），排查起来极其费劲。
export const TYPE_IDS = Object.freeze(INVOICE_TYPES.map(t => t.id));

export function typeLabel(id) {
  return INVOICE_TYPES.find(t => t.id === id)?.label ?? '未知类型';
}

// 查重键：只用发票号码，空号码不参与查重（返回 null）。
// 刻意不做「号码 + 销售方」的组合键——同号不同销售方只可能是输错，
// 那种情况也该提示，而不是放行。
// 这里的 trim 必须与仓库写入侧的 app/invoice-store.js 里 saveInvoice 那句
// String(input.number ?? '').trim() 保持一致：两边都 trim 才能让带空格的号码查得出来，
// 只改其中一处，存进去的键和查出来的键就对不上，查重会静默失效（不报错、只是永不命中）。
export function dedupeKey(invoice) {
  const n = String(invoice?.number ?? '').trim();
  return n === '' ? null : n;
}

// 文本字段的中文名。校验失败时用它们拼提示语——提示是直接显示给用户的，
// 说「number 字段类型不对」对用户没有任何意义。
const TEXT_FIELDS = {
  number: '发票号码',
  seller: '销售方',
  buyerTitle: '购买方抬头',
  buyerTaxId: '纳税人识别号',
  note: '备注'
};

// 校验只保证「能安全存进库、不会被下游用炸」，不保证业务上合理。
// 提示语一律写「用户该做什么」而不是「哪个字段不合法」：界面上没有「分」这个单位，
// 说「金额必须是整数分」用户无从下手（实测这是最容易撞上的一条——只拍照不填金额就点保存）。
// 发票号码的格式不做校验也是刻意的：增值税发票 8 位、全电发票 20 位，各地还有差异，
// 硬校验只会挡住正确的票。
export function validateInvoice(input) {
  const errors = [];
  // 传 null / undefined / 非对象是**调用方**写错了，不是用户填错了金额。分开报，
  // 免得排查时被一句「金额不对」带到错的方向去。
  if (input === null || typeof input !== 'object') {
    return { ok: false, errors: ['发票数据不完整'] };
  }

  const amountCents = input.amountCents;
  if (amountCents === null || amountCents === undefined) {
    errors.push('请先输入价税合计金额');
  } else if (!Number.isSafeInteger(amountCents) || amountCents < 0) {
    // isSafeInteger 而不是 isInteger：1e21 也是「整数」，但存进 IndexedDB 再读出来
    // 已经不是原来那个数了。口径与 app/money.js 的 addCents 保持一致。
    errors.push('金额格式不对，请重新输入');
  }

  // 时间戳必须是毫秒安全整数。这里曾经写成 Number.isFinite(Number(x))，它把 ''、'   '、
  // '2026'、true、[] 全部放行；而 new Date('2026') 只解析到 1970 年附近的年份——
  // 脏值入库后，按 issuedAt 倒序的发票列表会把它沉到最底，用户再也找不到这张票。
  if (input.issuedAt !== null && input.issuedAt !== undefined
      && !Number.isSafeInteger(input.issuedAt)) {
    errors.push('开票日期无效');
  }

  // 缺省放行是刻意的：仓库层 saveInvoice 会把它兜成 'other'，编辑器里 state.type 初值也是 'other'，
  // 所以「没选类型」这种情况到不了这里。这里只拦「给了但给错」。
  if (input.type !== null && input.type !== undefined && !TYPE_IDS.includes(input.type)) {
    errors.push('发票类型无效');
  }

  // 文本字段必须是字符串：它们会被 .trim()、会被拼进查重键、会被渲染进列表。
  // number 传 0（数字而不是 '0'）时，编辑器里 state.number.trim() 会直接抛 TypeError；
  // 传对象时 dedupeKey 会得到 '[object Object]'，两张脏票互判「这张票已经录过了」。
  for (const [key, label] of Object.entries(TEXT_FIELDS)) {
    const value = input[key];
    if (value !== null && value !== undefined && typeof value !== 'string') {
      errors.push(`${label}必须是文字`);
    }
  }

  if (input.taxCents !== null && input.taxCents !== undefined) {
    const tax = input.taxCents;
    if (!Number.isSafeInteger(tax) || tax < 0) {
      errors.push('税额格式不对，请重新输入');
    } else if (Number.isSafeInteger(amountCents) && tax > amountCents) {
      // 税额是价税合计的一部分，大于总额一定是输错了。提示语要带上「核对哪两项」，
      // 光说「不能大于」用户还得自己回去比对。
      errors.push('税额比价税合计还大，请核对这两项金额');
    }
  }

  return { ok: errors.length === 0, errors };
}

export function sumCents(invoices) {
  // 非安全整数 / 负数一律按 0 计，与 app/money.js 的 addCents 同一口径。
  // 这里刻意不抛错：备份恢复是把发票直接写进库的，读到脏数据不该让整页汇总炸掉。
  // 但也不能像以前那样用 Number(x) || 0 —— 那会把字符串 '5' 当成 5 分、把小数分照加，
  // 0.5 + 0.5 就凭空多出一分钱，显示成查不出来的错账。
  return (invoices ?? []).reduce(
    (sum, i) => sum + (Number.isSafeInteger(i?.amountCents) && i.amountCents > 0 ? i.amountCents : 0),
    0
  );
}

export function invoiceTitle(invoice) {
  const seller = String(invoice?.seller ?? '').trim();
  if (seller) return seller;
  const n = String(invoice?.number ?? '').trim();
  return n ? `发票 ${n}` : '未命名发票';
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test --test-isolation=none tests/invoice-model.test.js`
预期：PASS，12 条全绿（初版 9 条，代码质量审查后又补了 3 条：`issuedAt` 必须是毫秒安全整数、文本字段必须是字符串、入参不是对象时的早返回）。

- [ ] **步骤 5：Commit**

```bash
git add app/invoice-model.js tests/invoice-model.test.js
git commit -m "feat(invoice): 发票纯逻辑模块（类型/校验/查重键/合计）"
```

---

## 任务 3：图片尺寸纯逻辑

**文件：**
- 创建：`app/image-scale.js`
- 测试：`tests/image-scale.test.js`

- [ ] **步骤 1：编写失败的测试**

创建 `tests/image-scale.test.js`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_EDGE, THUMB_EDGE, SKIP_COMPRESS_BYTES,
  computeTargetSize, shouldCompress, useCompressed, estimateBackupMB
} from '../app/image-scale.js';

test('常态：长边超过上限时按比例缩小，宽高比不变', () => {
  const r = computeTargetSize(4000, 3000, 1600);
  assert.equal(r.width, 1600);
  assert.equal(r.height, 1200);
  assert.equal(r.scale, 0.4);
});

test('竖图：高的那边是长边', () => {
  const r = computeTargetSize(1200, 3600, 1600);
  assert.equal(r.height, 1600);
  assert.equal(r.width, 533);
});

test('不超过上限：原样返回，scale 为 1', () => {
  const r = computeTargetSize(800, 600, 1600);
  assert.deepEqual(r, { width: 800, height: 600, scale: 1 });
});

test('极端尺寸：缩完也不会变成 0 像素', () => {
  const r = computeTargetSize(100000, 10, 1600);
  assert.ok(r.width >= 1 && r.height >= 1);
  assert.equal(r.width, 1600);
});

test('非法尺寸：不抛错，返回 0 尺寸让对方放弃压缩', () => {
  for (const [w, h] of [[0, 0], [-1, 100], [NaN, 100], [undefined, undefined]]) {
    const r = computeTargetSize(w, h, 1600);
    assert.equal(r.width, 0);
    assert.equal(r.scale, 1);
  }
});

test('非法 maxEdge：不返回 1×1，也不返回 NaN', () => {
  // maxEdge 是单独就能毁图的参数：0 会把发票缩成一像素；NaN 时 Math.max(1, NaN) 得到 NaN，
  // 而调用方原先的守卫写的是 width === 0，NaN 会溜过去变成一块宽度 0 的画布。
  for (const edge of [0, NaN, -100]) {
    const r = computeTargetSize(4000, 3000, edge);
    assert.deepEqual(r, { width: 0, height: 0, scale: 1 }, `maxEdge=${edge} 应当整体判非法`);
  }
  assert.equal(computeTargetSize(4000, 3000, 1600).width, 1600, '合法 maxEdge 不受影响');
});

test('shouldCompress：小文件不压', () => {
  assert.equal(shouldCompress(100 * 1024, 4000, 3000), false, '小于阈值直接不压');
  assert.equal(shouldCompress(SKIP_COMPRESS_BYTES, 4000, 3000), true);
});

test('shouldCompress：本来就不大的图不压', () => {
  assert.equal(shouldCompress(5 * 1024 * 1024, 800, 600), false, '尺寸已在上限内，压了也白压');
});

test('shouldCompress：目标尺寸取整后没有真的变小就不压', () => {
  // 1600.6×10 配 1600 的上限：scale 是 0.9996 < 1，目标却是 1600×10，
  // 和原图截断后的像素数一样大——压了只是白跑一次解码 + 重编码，还多损失一道画质。
  assert.equal(shouldCompress(SKIP_COMPRESS_BYTES, 1600.6, 10), false);
  assert.equal(shouldCompress(SKIP_COMPRESS_BYTES, 1601, 10), true, '真的少了 1 像素才算变小');
  assert.equal(shouldCompress(SKIP_COMPRESS_BYTES, 1600, 10), false, '刚好等于上限，原样返回');
});

test('useCompressed：压完反而更大就不用', () => {
  assert.equal(useCompressed(1000, 900), true);
  assert.equal(useCompressed(1000, 1000), false);
  assert.equal(useCompressed(1000, 1200), false, '压完更大必须回退原图');
  assert.equal(useCompressed(1000, 0), false);
  assert.equal(useCompressed(1000, NaN), false);
});

test('estimateBackupMB：空集合与脏数据都安全', () => {
  assert.equal(estimateBackupMB([]), 0);
  assert.equal(estimateBackupMB(null), 0);
  assert.equal(estimateBackupMB({}), 0, '非数组不能变成 reduce is not a function');
  const oneMB = 1024 * 1024;
  const mb = estimateBackupMB([{ size: oneMB }, { size: oneMB }]);
  assert.ok(mb > 2 && mb < 4, 'base64 会比原始字节大约 1/3，再加缩略图系数');
});

test('常量取值与规格一致', () => {
  assert.equal(MAX_EDGE, 1600);
  assert.equal(THUMB_EDGE, 240);
  assert.equal(SKIP_COMPRESS_BYTES, 300 * 1024);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test --test-isolation=none tests/image-scale.test.js`
预期：FAIL —— 报 `Cannot find module '../app/image-scale.js'`。

- [ ] **步骤 3：编写最少实现代码**

创建 `app/image-scale.js`：

```js
// 图片压缩的尺寸计算与取舍判断。纯函数，可在 Node 里单测。
// 真正的 Canvas 压缩在 image-store.js 里，那部分只能在浏览器 / WebView 里跑。

/** 原图长边上限。发票上的字要看得清，1600 足够，再大只是浪费体积。 */
export const MAX_EDGE = 1600;
/** 缩略图长边。列表页只加载它。 */
export const THUMB_EDGE = 240;
/**
 * 原图 JPEG 质量。0.72 是「白底黑字」这类高对比内容上的经验拐点：
 * 再往下（0.6 一带）发票上的小号数字开始出现肉眼可见的毛边，往上到 0.85 以上
 * 体积几乎线性变贵却看不出区别——压完的图还是要在手机上直接看清金额和号码的。
 */
export const JPEG_QUALITY = 0.72;
/**
 * 缩略图质量，比原图略低。理由不是省那点体积，而是列表要一次读几十张：
 * 缩略图只有 240px，是列表里的一小块，0.72 与 0.7 的差别肉眼不可辨，
 * 而每一 KB 都要乘以「一屏几十张」，省下来的是切 Tab 时的加载时间。
 */
export const THUMB_QUALITY = 0.7;
/** 小于这个体积就不压：压完未必更小，还白白损失一次画质。 */
export const SKIP_COMPRESS_BYTES = 300 * 1024;

/**
 * 算压缩后的目标尺寸。长边超过 maxEdge 时等比缩小，否则原样返回。
 * 非法的尺寸或 maxEdge 一律返回 0 尺寸而不是抛错——调用方据此放弃压缩、回退原图。
 */
export function computeTargetSize(width, height, maxEdge = MAX_EDGE) {
  const w = Number(width);
  const h = Number(height);
  const edge = Number(maxEdge);
  // maxEdge 必须和宽高一起校验，它是单独就能把图毁掉的那个参数：
  // edge = 0 时任何图都会被缩成 1×1（发票变成一像素）；edge 为 NaN 时
  // Math.max(1, NaN) 得到 NaN，而调用方原来的守卫写的是 `target.width === 0`——
  // NaN === 0 是 false，NaN 会从缝里溜过去，最后给 canvas 设一块宽度 0 的画布白跑一趟。
  // edge < 1 与 0 同类，一并算非法。
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0 ||
      !Number.isFinite(edge) || edge < 1) {
    return { width: 0, height: 0, scale: 1 };
  }
  const longest = Math.max(w, h);
  if (longest <= edge) {
    return { width: Math.round(w), height: Math.round(h), scale: 1 };
  }
  const scale = edge / longest;
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
    scale
  };
}

/**
 * 该不该压：既要够大（否则白损失画质），又要确实会缩小。
 * 「确实会缩小」比的是取整后的像素数，不是 scale。反例：computeTargetSize(1600.6, 10, 1600)
 * 的目标是 (1600, 10)，和原图截断后的像素数一模一样，可 scale = 0.9996 < 1——
 * 只看 scale 就会判成「该压」，白白多跑一次解码 + 重编码，还多损失一道画质。
 * 小数尺寸本身是脏数据：位图的像素宽度只能是整数，1600.6 的图解码出来就是 1600 像素，
 * 所以原尺寸也按截断算，两边才是同一把尺子。
 */
export function shouldCompress(bytes, width, height) {
  if (!Number.isFinite(bytes) || bytes < SKIP_COMPRESS_BYTES) return false;
  const target = computeTargetSize(width, height);
  // 尺寸非法（含 maxEdge 兜底那一路）就谈不上「压小了」，交给调用方回退原图。
  if (!(target.width >= 1)) return false;
  return target.width < Math.trunc(Number(width)) || target.height < Math.trunc(Number(height));
}

/** 压完比原图还大就不用压缩版——宁可占点体积，也不要把图弄糊。 */
export function useCompressed(originalBytes, compressedBytes) {
  if (!Number.isFinite(compressedBytes) || compressedBytes <= 0) return false;
  return compressedBytes < originalBytes;
}

/**
 * 估算含图备份的体积（MB）。base64 比二进制大约 1/3，
 * 再加缩略图与 JSON 结构，用 1.4 的系数偏高估——导出前宁可说大一点。
 * 用 Array.isArray 而不是 `files ?? []`：后者只挡 null/undefined，传进来一个对象
 * （调用方读错了字段）会变成 `({}).reduce is not a function`，一句与图片毫无关系的报错。
 */
export function estimateBackupMB(files) {
  const list = Array.isArray(files) ? files : [];
  const bytes = list.reduce((s, f) => s + (Number(f?.size) || 0), 0);
  return Math.round((bytes * 1.4) / (1024 * 1024) * 10) / 10;
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test --test-isolation=none tests/image-scale.test.js`
预期：PASS，12 条全绿（初版 10 条，代码质量审查后又补了 2 条：非法 `maxEdge` 不返回 1×1、目标尺寸取整后没真的变小就不压）。

- [ ] **步骤 5：Commit**

```bash
git add app/image-scale.js tests/image-scale.test.js
git commit -m "feat(invoice): 图片压缩的尺寸与取舍纯逻辑"
```

---

## 任务 4：图片压缩与存取

**文件：**
- 创建：`app/image-store.js`

本任务**没有单测**：Canvas 与 Blob 在 Node 里不存在。可单测的部分已在任务 3 抽走，本文件只剩「调用浏览器 API」的胶水。验证靠任务 10 的模拟器实测。

- [ ] **步骤 1：编写实现**

创建 `app/image-store.js`：

```js
// 发票图片的压缩与存取。
// 依赖 Canvas / Blob / indexedDB，**不能在 Node 里 import**。
// 所有纯计算已抽到 image-scale.js 单测，这里只做浏览器 API 的编排。

import * as db from './db.js';
import { uid } from './store.js';
import {
  MAX_EDGE, THUMB_EDGE, JPEG_QUALITY, THUMB_QUALITY,
  computeTargetSize, shouldCompress, useCompressed, estimateBackupMB
} from './image-scale.js';

export { estimateBackupMB };

/**
 * 用 <img> + object URL 解码。这是 decode 的最后一道退路，也是老内核（没有 createImageBitmap）唯一的路。
 * <img> 在 Chrome 81+ 默认 from-image，EXIF 方向是套用过的，所以这条路出来的位图本来就是正的。
 */
async function loadViaImg(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    // decode() 一 resolve，像素就已经在 <img> 里了，URL 此后只是多占着一份 Blob 不让回收。
    // 放 finally：解码抛错（损坏文件、不支持的格式）时也不能把这个 URL 漏在内存里。
    URL.revokeObjectURL(url);
  }
}

/**
 * 解码成可画进 canvas 的位图。两条纪律：
 * 1. 必须显式写 imageOrientation: 'from-image'——Chromium 的 createImageBitmap 默认是 'none'，
 *    不套用 EXIF 方向；手机竖拍的发票会因此躺倒，而 canvas 重编码会把 EXIF 一起丢掉，
 *    躺倒从此不可逆（同一张图走 <img> 显示时反而是正的，更让人以为是偶发）。
 * 2. 失败必须退回 <img>：createImageBitmap 存在 ≠ 调用成功，HEIC、损坏文件、内存不足
 *    都会让它 reject；那时退回 <img>（它本来就是 from-image，方向也对）比整段放弃好得多——
 *    放弃会连已经能生成的缩略图一起丢掉。
 */
async function decode(blob) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch (err) {
      // 老内核不认这个选项会抛 TypeError；图片本身有问题也会抛。两种情况都往下走。
      console.warn('createImageBitmap 解码失败，退回 <img>', err);
    }
  }
  return loadViaImg(blob);
}

/**
 * 位图用完立刻释放。ImageBitmap 背后是一整张解压后的像素（手机上一张就是几十 MB），
 * 等 GC 来收意味着连拍几张就先把自己撑爆；<img> 没有 close，可选调用正好兼容两条路径。
 */
function releaseSource(source) {
  source?.close?.();
}

/** 画到指定长边并导出 JPEG Blob。 */
async function drawTo(source, maxEdge, quality) {
  // 用 || 而不是 ??：<img> 在没插进文档等情形下 .width 会是 0，而 0 在 ?? 眼里是「有效值」，
  // 会一路走到「尺寸无效」把整张图（连带刚生成的缩略图）丢掉——0 只是个空值，该去看 naturalWidth。
  const w = source.width || source.naturalWidth;
  const h = source.height || source.naturalHeight;
  const target = computeTargetSize(w, h, maxEdge);
  // 不写 `=== 0`：脏尺寸配合非法 maxEdge 时这里可能是 NaN，而 NaN === 0 为 false，
  // 会放过去给 canvas 设一块宽度 0 的画布，白跑一遍 toBlob 再报一次错。
  if (!(target.width >= 1)) throw new Error('图片尺寸无效');
  const canvas = document.createElement('canvas');
  canvas.width = target.width;
  canvas.height = target.height;
  const ctx = canvas.getContext('2d');
  // canvas 缩放默认是 low（最近邻），缩到 1600 时发票上的小字会糊成一片马赛克，
  // 而 MAX_EDGE 这个上限存在的意义恰恰是「字要看得清」，所以这里必须显式要 high。
  ctx.imageSmoothingQuality = 'high';
  // 发票多为白底黑字，缩放后最容易出现的是一圈灰边；铺白底再画能干净不少
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, target.width, target.height);
  ctx.drawImage(source, 0, 0, target.width, target.height);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
  if (!blob) throw new Error('canvas.toBlob 返回空');
  return blob;
}

/**
 * 是不是 PDF。只看 `mime === 'application/pdf'` 太严：安卓的文件选择器给出的常常是
 * `application/pdf; charset=binary`、`application/octet-stream`，甚至是空 type，
 * 这些都会被漏成「图片」送进 <img> 解码，用户拍下来的 PDF 最后只剩一张裂图。
 * 所以 mime 里含 pdf、或文件名以 .pdf 结尾，都算数。
 */
function isPdf(mime, name) {
  return /pdf/i.test(mime) || /\.pdf$/i.test(name || '');
}

/**
 * 读入用户选的发票文件，返回可直接落库的形态：
 * `{ blob, thumbBlob, mime, size, originalSize, compressed, failed }`
 * - thumbBlob 可能是 null：PDF 本来就没有缩略图，或连缩略图都没生成出来；
 * - failed 为 true 表示压缩环节整个失败、已回退原图（此时 blob 就是 inputFile），
 *   但只要缩略图成功生成过就仍然带出来，列表页不至于只能显示占位方块；
 * - compressed 为 true 时才有 originalSize（压缩前的字节数），界面据此算省了多少。
 * 任何一步失败都回退原图——不能因为省体积就把用户的发票弄丢。
 */
export async function prepareFile(inputFile) {
  const mime = String(inputFile?.type || '');
  const size = Number(inputFile?.size) || 0;

  if (isPdf(mime, inputFile?.name)) {
    // PDF 不压缩，原样存；也没有缩略图。
    // mime 一律写成 application/pdf：选择器给的可能带 charset= 参数或是空 type，
    // 存原文也能用（预览只认 image/ 前缀），但备份里的元数据会留一堆五花八门的写法。
    return { blob: inputFile, thumbBlob: null, mime: 'application/pdf', size, compressed: false };
  }

  // 提到 try 外面：压缩失败时 catch 也要看得见它们，才能把已经生成好的缩略图一起返回。
  let thumbBlob = null;
  let source = null;
  try {
    source = await decode(inputFile);
    const w = source.width || source.naturalWidth;
    const h = source.height || source.naturalHeight;
    thumbBlob = await drawTo(source, THUMB_EDGE, THUMB_QUALITY);

    if (!shouldCompress(size, w, h)) {
      return { blob: inputFile, thumbBlob, mime: mime || 'image/jpeg', size, compressed: false };
    }
    const out = await drawTo(source, MAX_EDGE, JPEG_QUALITY);
    if (!useCompressed(size, out.size)) {
      return { blob: inputFile, thumbBlob, mime: mime || 'image/jpeg', size, compressed: false };
    }
    return {
      blob: out, thumbBlob, mime: 'image/jpeg',
      size: out.size, originalSize: size, compressed: true
    };
  } catch (err) {
    console.error('发票图片压缩失败，按原样保存', err);
    // 缩略图成功过就留着：它只是一张 240px 的小图，扔了列表就只能显示占位方块，
    // 而原图其实好好地存在库里。
    return {
      blob: inputFile, thumbBlob,
      mime: mime || 'application/octet-stream', size, compressed: false, failed: true
    };
  } finally {
    // finally 而不是在成功路径上 close：上面每一条 return 和抛错都是出口，漏一条就漏一张位图。
    releaseSource(source);
  }
}

/** 把 prepareFile 的结果写进 invoiceFiles，返回 fileId。 */
export async function saveFile(prepared) {
  const id = uid();
  try {
    await db.put('invoiceFiles', {
      id,
      blob: prepared.blob,
      thumbBlob: prepared.thumbBlob,
      mime: prepared.mime,
      size: prepared.size ?? prepared.blob.size,
      createdAt: Date.now()
    });
  } catch (err) {
    // 配额写满是这台手机上最可能撞到的失败：一张原图几 MB。直接把 IndexedDB 的异常抛出去，
    // 用户在编辑器里看到的是「图片保存失败：QuotaExceededError: …」——既不知道发生了什么，
    // 也不知道下一步该做什么。这里换成一句能照着做的话。
    if (err?.name === 'QuotaExceededError') {
      const quota = new Error('手机存储空间不够了，照片没存下。可以先去「记账 → 备份」导出一份并清理旧图再试。');
      // 沿用原 name：界面读的是 message（已经是中文人话），控制台与排查时仍认得出这是配额失败，
      // 不至于退化成一个无从追查的普通 Error。
      quota.name = err.name;
      throw quota;
    }
    throw err;
  }
  return id;
}

export async function getFile(id) {
  if (!id) return null;
  return (await db.get('invoiceFiles', id)) ?? null;
}

export async function deleteFile(id) {
  if (!id) return;
  await db.removeAll([{ store: 'invoiceFiles', key: id }]);
}

// 同一份记录只建一次 URL，并记住它们，好让整页重绘时能一次性回收。
// 为什么不让调用方自己 revoke：调用点在搜索框的 oninput 里（每敲一个字跑一遍），
// 漏一次就是一批 URL 活到页面卸载，而每个 URL 都会 pin 住对应的 Blob。
const urlCache = new Map();   // key: `${kind}:${id}` → url

async function cachedUrl(kind, id, make) {
  const key = `${kind}:${id}`;
  const hit = urlCache.get(key);
  if (hit) return hit;
  const url = await make();
  // 只记真的拿到了 URL 的情况。把 null（PDF 没有缩略图）也缓存下来的话，
  // 下次命中就得先判断「缓存里是不是 null」，反而更容易写错。
  if (url) urlCache.set(key, url);
  return url;
}

/** 释放全部缓存 URL。整页重绘前调一次：旧的那批节点马上就被 mount 换掉，此时 revoke 是安全的。 */
export function clearUrlCache() {
  for (const url of urlCache.values()) URL.revokeObjectURL(url);
  urlCache.clear();
}

export function revokeUrl(url) {
  if (!url) return;
  // 同步删掉缓存项：编辑器换图时会 revoke 旧 URL，缓存里若还留着它，
  // 之后命中的就是一个已经失效的 URL（图片会变成裂图）。
  for (const [key, cached] of urlCache) {
    if (cached === url) urlCache.delete(key);
  }
  URL.revokeObjectURL(url);
}

/**
 * 列表页的缩略图地址。两条契约都得知道：
 * 1. 返回的 URL 由本模块统一缓存，调用方**不要**自己 revoke，整页重绘前调一次 clearUrlCache() 回收；
 * 2. 这条记录是 PDF（或压根没生成出缩略图）时返回 null，调用方据此改显示占位图标，
 *    不要拿 null 去当 src——`<img src="null">` 会去请求一个真叫 null 的地址。
 */
export async function getThumbUrl(id) {
  return cachedUrl('thumb', id, async () => {
    const rec = await getFile(id);
    const blob = rec?.thumbBlob ?? null;
    if (!blob) return null;
    return URL.createObjectURL(blob);
  });
}

/**
 * 原图的地址。和 getThumbUrl 不同，它回答的是「这份资源在哪」，不是「这是不是一张能塞进 <img> 的图」：
 * PDF 记录同样会返回 URL。调用方（编辑器预览）必须先看 mime 再决定用 <img> 还是显示占位，
 * 直接塞进 <img> 得到的是裂图加一行浅灰 alt 文字，比干脆不显示更糟。
 */
export async function getFullUrl(id) {
  return cachedUrl('full', id, async () => {
    const rec = await getFile(id);
    const blob = rec?.blob ?? null;
    if (!blob) return null;
    return URL.createObjectURL(blob);
  });
}
```

- [ ] **步骤 2：语法检查**

运行：`node --check app/image-store.js`
预期：无输出（语法通过）。

- [ ] **步骤 3：确认没有纯逻辑漏在外面**

运行：`node --test --test-isolation=none`
预期：全绿（本任务不新增测试；若报错说明误改了别的模块）。

- [ ] **步骤 4：Commit**

```bash
git add app/image-store.js
git commit -m "feat(invoice): 图片压缩（Canvas）与 invoiceFiles 存取"
```

---

## 任务 5：发票仓库层

**文件：**
- 创建：`app/invoice-store.js`

- [ ] **步骤 1：编写实现**

创建 `app/invoice-store.js`：

```js
// 发票仓库层：UI 与 IndexedDB 之间的唯一通道。
// 依赖 db.js（进而依赖 indexedDB），**不能在 Node 里 import**；验证靠 fake-IndexedDB 探针与真机。

import * as db from './db.js';
import { uid } from './store.js';
import { dedupeKey, validateInvoice } from './invoice-model.js';
import { deleteFile } from './image-store.js';

export async function listInvoices() {
  const all = await db.getAll('invoices');
  // 开票日期倒序；同日的按录入时间倒序，保证顺序稳定
  return all.sort((a, b) => (b.issuedAt ?? 0) - (a.issuedAt ?? 0) || (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

export async function getInvoice(id) {
  return (await db.get('invoices', id)) ?? null;
}

/**
 * 按发票号码查已有记录。空号码一律返回 null（不查重）。
 * 只做精确匹配——号码是印在票上的，不需要模糊。
 */
export async function findByNumber(number) {
  const key = dedupeKey({ number });
  if (key === null) return null;
  const hits = await db.getAllByIndex('invoices', 'by_number', key);
  return hits[0] ?? null;
}

export async function listByTxn(txnId) {
  if (!txnId) return [];
  return db.getAllByIndex('invoices', 'by_txn', txnId);
}

/** 每笔账挂了发票的条数，形如 { [txnId]: n }。记账列表用它显示「发票（N）」。 */
export async function countByTxn() {
  const all = await db.getAll('invoices');
  const out = {};
  for (const inv of all) {
    if (!inv.txnId) continue;
    out[inv.txnId] = (out[inv.txnId] ?? 0) + 1;
  }
  return out;
}

/**
 * 新建或更新一张发票。fileId 为 null 表示「没图」；传 undefined 表示「不改动图片」。
 * 调用方负责先调 prepareFile/saveFile 拿到 fileId。
 */
export async function saveInvoice(input) {
  const now = Date.now();
  const existing = input.id ? await getInvoice(input.id) : null;

  const inv = {
    id: input.id ?? uid(),
    number: String(input.number ?? '').trim(),
    issuedAt: input.issuedAt ?? now,
    amountCents: input.amountCents,
    seller: String(input.seller ?? '').trim(),
    type: input.type ?? 'other',
    buyerTitle: String(input.buyerTitle ?? '').trim(),
    buyerTaxId: String(input.buyerTaxId ?? '').trim(),
    taxCents: input.taxCents ?? null,
    note: String(input.note ?? '').trim(),
    fileId: input.fileId === undefined ? (existing?.fileId ?? null) : input.fileId,
    txnId: input.txnId === undefined ? (existing?.txnId ?? null) : input.txnId,
    reimbursementId: existing?.reimbursementId ?? null,
    archived: input.archived ?? existing?.archived ?? false,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };

  const check = validateInvoice(inv);
  if (!check.ok) throw new Error(check.errors.join('；'));

  // 换了图就把旧图删掉，否则 invoiceFiles 会越攒越多、备份也跟着虚胖
  const oldFileId = existing?.fileId;
  await db.put('invoices', inv);
  if (oldFileId && oldFileId !== inv.fileId) {
    await deleteFile(oldFileId);
  }
  return inv;
}

/** 只改挂靠关系，不碰其它字段。传 null 表示解除挂靠。 */
export async function linkToTxn(invoiceId, txnId) {
  const inv = await getInvoice(invoiceId);
  if (!inv) throw new Error('发票不存在');
  await db.put('invoices', { ...inv, txnId: txnId ?? null, updatedAt: Date.now() });
}

export async function deleteInvoice(id) {
  const inv = await getInvoice(id);
  if (!inv) return;
  await db.removeAll([{ store: 'invoices', key: id }]);
  // 图片跟着发票走：没有别的发票引用它，留着就是垃圾
  if (inv.fileId) await deleteFile(inv.fileId);
}

/** 汇总：本月合计、待报销合计（「仅存档」的票不计入待报销）。 */
export async function summary(now = Date.now()) {
  const all = await listInvoices();
  const d = new Date(now);
  const monthStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  const monthEnd = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();

  let monthCents = 0;
  let pendingCents = 0;
  let pendingCount = 0;
  for (const inv of all) {
    const amt = Number(inv.amountCents) || 0;
    if ((inv.issuedAt ?? 0) >= monthStart && (inv.issuedAt ?? 0) < monthEnd) monthCents += amt;
    if (!inv.archived && !inv.reimbursementId) {
      pendingCents += amt;
      pendingCount += 1;
    }
  }
  return { monthCents, pendingCents, pendingCount, total: all.length };
}
```

- [ ] **步骤 2：** 给 `app/db.js` 新增 `getAllByIndex`

已核实：`app/db.js` 现有 `put` / `putAll` / `replaceAll` / `get` / `getAll` / `getByRange` / `remove` / `removeAll`，**没有** `getByIndex` 一类的按索引取值函数——本任务与任务 8 都要用，必须新增一个。不写「单条版 `getByIndex`」：`by_txn` 索引下一笔账可能挂多张票，`index().get()` 只会返回第一条，那样「这笔账有几张票」永远显示 1。统一用返回数组的 `getAllByIndex`，查重处取 `hits[0]` 即可。

在 `app/db.js` 的 `getByRange` 之后插入：

```js
// 按索引取**全部**命中：一笔账可以挂多张票（by_txn），所以不能用 index().get()——
// 它只返回第一条，调用方拿到的永远是「一张」。查重那种只要一条的场景自己取 [0]。
export async function getAllByIndex(store, indexName, key) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).index(indexName).getAll(key);
    req.onsuccess = () => resolve(req.result ?? []);
    req.onerror = () => reject(req.error);
  });
}
```

`get` 已存在且签名就是 `get(store, key)`，`findByNumber` 之外还用它的只有 `getInvoice`——本任务直接用，不用补。

- [ ] **步骤 3：语法检查**

运行：`node --check app/invoice-store.js`
预期：无输出。

- [ ] **步骤 4：Commit**

```bash
git add app/invoice-store.js app/db.js
git commit -m "feat(invoice): 发票仓库层（CRUD / 查重 / 挂靠 / 汇总）"
```

---

## 任务 6：发票列表页与第四个 Tab

**文件：**
- 创建：`app/ui/invoice-view.js`、`styles/invoice.css`
- 修改：`app/router.js:4-8`、`app/main.js:29`、`index.html:14`

- [ ] **步骤 1：加第四个 Tab**

`app/router.js` 的 `TABS` 改成：

```js
const TABS = [
  { id: 'ledger', label: '记账', icon: '📒' },
  { id: 'invoice', label: '发票', icon: '🧾' },
  { id: 'stats', label: '统计', icon: '📊' },
  { id: 'vault', label: '密码箱', icon: '🔒' }
];
```

同时把文件头注释里的「三个 Tab」改成「四个 Tab」。

- [ ] **步骤 2：注册视图**

`app/main.js` 顶部 import 区加：

```js
import { renderInvoices } from './ui/invoice-view.js';
```

`render` 函数里的 `renderers` 改成：

```js
const renderers = { ledger: renderLedgerHome, invoice: renderInvoices, stats: renderStats, vault: renderVault };
```

- [ ] **步骤 3：创建样式文件**

创建 `styles/invoice.css`：

```css
/* 发票模块样式。沿用 base.css 的设计令牌，不引入新的色值。
   注意令牌名：base.css 里是 --surface / --border / --text-2（卡片底、分隔线、次要文字），
   写错名字不会报错，只会静默失效——卡片没有底色、灰字变成全黑。 */

.inv-summary {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
  margin: 0 0 12px;
}
.inv-summary-cell {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 10px 12px;
}
.inv-summary-cell .k { font-size: 12px; color: var(--text-2); }
.inv-summary-cell .v { font-size: 19px; font-variant-numeric: tabular-nums; margin-top: 2px; }

.inv-filters { display: flex; gap: 6px; margin-bottom: 10px; }
.inv-filters button {
  flex: 1;
  padding: 7px 4px;
  font-size: 13px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--text);
}
.inv-filters button[aria-selected="true"] {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

.inv-item {
  display: grid;
  grid-template-columns: 52px 1fr auto;
  gap: 10px;
  align-items: center;
  padding: 10px 12px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  margin-bottom: 6px;
}
.inv-thumb {
  width: 52px;
  height: 52px;
  border-radius: 6px;
  object-fit: cover;
  background: var(--bg);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
}
.inv-title { font-size: 14.5px; }
.inv-meta { font-size: 12px; color: var(--text-2); margin-top: 2px; }
.inv-amount { font-size: 15px; font-variant-numeric: tabular-nums; text-align: right; }
.inv-tag {
  display: inline-block;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--text-2);
  margin-top: 3px;
}
.inv-tag.pending { color: #b26a00; border-color: #e0b060; }
.inv-tag.stored { color: var(--text-2); }

.inv-preview {
  width: 100%;
  max-height: 240px;
  object-fit: contain;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}
```

- [ ] **步骤 4：引入样式**

`index.html` 在 `styles/vault.css` 那一行后面加：

```html
<link rel="stylesheet" href="./styles/invoice.css">
```

- [ ] **步骤 5：实现列表页**

创建 `app/ui/invoice-view.js`：

```js
// 发票 Tab：搜索、筛选、汇总、列表。
// 依赖 invoice-store（进而 IndexedDB），验证靠模拟器实测。

import { el, mount } from './dom.js';
import * as invoiceStore from '../invoice-store.js';
import { formatCents } from '../money.js';
import { typeLabel, invoiceTitle } from '../invoice-model.js';
import { openInvoiceEditor } from './invoice-editor.js';

const FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'pending', label: '待报销' },
  { id: 'stored', label: '仅存档' },
  { id: 'unlinked', label: '未挂账' }
];

// 筛选状态按 Tab 生命周期保存在模块级：切走再回来不该被重置，
// 与统计页存口径是同一种做法。
let filter = 'all';
let keyword = '';

// 当前列表渲染序号：每次 paint() 自增。paint 是逐行 await 取缩略图的异步循环，
// 而切 Tab 会立刻发起新的一次渲染——main.js 的 renderSeq 只保证外壳（root）不被旧渲染盖，
// 管不到这个 listBox。少了这道检查，先发起、后完成的那次会把新列表盖回去，
// 用户切回来看到的是一份旧数据（点进去还会是已经被删掉的那张票）。
let paintSeq = 0;

function matches(inv, kw) {
  if (!kw) return true;
  const hay = [inv.seller, inv.number, inv.note, inv.buyerTitle].join(' ').toLowerCase();
  return hay.includes(kw);
}

function inFilter(inv) {
  switch (filter) {
    case 'pending': return !inv.archived && !inv.reimbursementId;
    case 'stored': return !!inv.archived;
    case 'unlinked': return !inv.txnId;
    default: return true;
  }
}

export async function renderInvoices(root) {
  const all = await invoiceStore.listInvoices();
  const sum = await invoiceStore.summary();

  const searchInput = el('input', {
    type: 'search',
    placeholder: '搜索销售方、号码、备注',
    value: keyword,
    oninput: (e) => { keyword = e.target.value; paint(); }
  });

  const listBox = el('div', {});
  const filterBox = el('div', { class: 'inv-filters' });

  function paintFilters() {
    mount(filterBox, FILTERS.map(f => el('button', {
      type: 'button',
      'aria-selected': String(f.id === filter),
      onclick: () => { filter = f.id; paint(); }
    }, [f.label])));
  }

  async function paint() {
    const seq = ++paintSeq;
    paintFilters();
    const kw = keyword.trim().toLowerCase();
    const rows = all.filter(inv => inFilter(inv) && matches(inv, kw));
    if (rows.length === 0) {
      if (seq !== paintSeq) return;
      mount(listBox, el('div', { class: 'empty' }, [
        all.length === 0 ? '还没有发票，点右下角拍一张' : '没有符合条件的发票'
      ]));
      return;
    }
    const nodes = [];
    for (const inv of rows) {
      const thumbUrl = inv.fileId ? await invoiceStore.thumbUrlFor(inv.fileId).catch(() => null) : null;
      // 每取一张缩略图都要重新对一次序号：一次列表可能有几十张票，等第一张的时候
      // 用户完全来得及切走再切回来。这里停手而不是继续拼节点，省掉整轮无用的 IO。
      if (seq !== paintSeq) return;
      nodes.push(el('button', {
        class: 'inv-item',
        type: 'button',
        onclick: () => openInvoiceEditor({ id: inv.id, onSaved: refresh })
      }, [
        thumbUrl
          ? el('img', { class: 'inv-thumb', src: thumbUrl, alt: '' })
          : el('div', { class: 'inv-thumb', text: inv.fileId ? '📄' : '🧾' }),
        el('div', {}, [
          el('div', { class: 'inv-title', text: invoiceTitle(inv) }),
          el('div', { class: 'inv-meta', text: [typeLabel(inv.type), inv.number].filter(Boolean).join(' · ') }),
          el('div', { class: 'inv-tag ' + (inv.archived ? 'stored' : 'pending'), text: inv.archived ? '仅存档' : (inv.reimbursementId ? '已报销' : '待报销') })
        ]),
        el('div', { class: 'inv-amount', text: formatCents(inv.amountCents) })
      ]));
    }
    if (seq !== paintSeq) return;
    mount(listBox, nodes);
  }

  async function refresh() {
    const fresh = await invoiceStore.listInvoices();
    all.length = 0;
    all.push(...fresh);
    await paint();
  }

  mount(root, el('div', { class: 'stack' }, [
    el('div', { class: 'inv-summary' }, [
      el('div', { class: 'inv-summary-cell' }, [
        el('div', { class: 'k', text: '本月发票' }),
        el('div', { class: 'v', text: formatCents(sum.monthCents) })
      ]),
      el('div', { class: 'inv-summary-cell' }, [
        el('div', { class: 'k', text: `待报销（${sum.pendingCount} 张）` }),
        el('div', { class: 'v', text: formatCents(sum.pendingCents) })
      ])
    ]),
    searchInput,
    filterBox,
    listBox
  ]),
  // 右下角新建入口：类名、位置、观感都跟记账页的 FAB 保持一致。
  // 少了它就等于没有入口——空态那句「点右下角拍一张」会指向一片空气。
  el('button', {
    class: 'fab', type: 'button', text: '+',
    'aria-label': '新建发票',
    onclick: () => openNewInvoice(refresh)
  }));

  await paint();
}

export function openNewInvoice(onSaved) {
  return openInvoiceEditor({ onSaved });
}
```

**注意**：上面用到 `invoiceStore.thumbUrlFor`，请在 `app/invoice-store.js` 末尾补这个转发函数，避免 UI 直接依赖 image-store：

```js
import { getThumbUrl, getFullUrl } from './image-store.js';

export async function thumbUrlFor(fileId) {
  return getThumbUrl(fileId);
}

export async function fullUrlFor(fileId) {
  return getFullUrl(fileId);
}
```

- [ ] **步骤 6：语法检查**

运行：`node --check app/ui/invoice-view.js`
预期：无输出（`invoice-editor.js` 尚不存在，但 `node --check` 只查语法、不解析 import，所以会通过）。

- [ ] **步骤 7：Commit**

```bash
git add app/router.js app/main.js app/ui/invoice-view.js styles/invoice.css index.html app/invoice-store.js
git commit -m "feat(invoice): 发票列表页与第四个 Tab"
```

---

## 任务 7：发票编辑器

**文件：**
- 创建：`app/ui/invoice-editor.js`

- [ ] **步骤 1：实现编辑器**

创建 `app/ui/invoice-editor.js`：

```js
// 新建 / 编辑发票的半屏 sheet。
// 复用项目既有的 openSheet 与 createKeypad，不另造一套。

import { el, mount } from './dom.js';
import { openSheet } from './sheet.js';
import { createKeypad } from './keypad.js';
import * as invoiceStore from '../invoice-store.js';
import { prepareFile, saveFile, getFile, getFullUrl, revokeUrl } from '../image-store.js';
import { INVOICE_TYPES, validateInvoice } from '../invoice-model.js';
import { formatCents } from '../money.js';

let activeSheet = null;

export function openInvoiceEditor({ id = null, txnId = null, onSaved } = {}) {
  // 同一时刻只开一层：与项目其它 sheet 的约定一致
  if (activeSheet) { activeSheet.close(); activeSheet = null; }

  const state = {
    id,
    number: '', issuedAt: Date.now(), amountCents: null,
    seller: '', type: 'other', buyerTitle: '', buyerTaxId: '',
    taxCents: null, note: '', fileId: null, txnId,
    archived: false, busy: false
  };
  // 查重提示只弹一次（见 submit）：用户第二次点「保存」就放行。
  let dupWarned = false;

  const errorNode = el('div', { class: 'vault-error' });
  const previewBox = el('div', {});
  const body = el('div', { class: 'stack' });

  const sheet = openSheet({ title: id ? '编辑发票' : '新建发票', body });
  activeSheet = sheet;

  // 换预览内容时先记住旧节点：从图片换成 PDF 占位之后，旧图片那个 object URL 再没人持有，
  // 不 revoke 就是每换一次文件泄漏一份内存（原来只在「图换图」那一支做了，漏了「图换 PDF」）。
  function mountPreview(node) {
    const old = previewBox.firstChild;
    mount(previewBox, node);
    if (old?.tagName === 'IMG') revokeUrl(old.src);
  }

  async function paintPreview() {
    if (!state.fileId) {
      mountPreview(el('div', { class: 'inv-thumb', style: 'width:100%;height:130px', text: '🧾 还没有图片' }));
      return;
    }
    // PDF 不能塞进 <img>：getFullUrl 对任何存在的记录都返回一个 blob URL，
    // 只判 `!url` 是拦不住它的——那样 <img src="blob:…pdf"> 加载失败，用户看到的是裂图加
    // 一行浅灰的 alt 文字，比干脆不显示更糟。所以先取一次记录看 mime，只有图片才走 <img>。
    const rec = await getFile(state.fileId).catch(() => null);
    if (!rec || !String(rec.mime || '').startsWith('image/')) {
      mountPreview(el('div', { class: 'inv-thumb', style: 'width:100%;height:130px', text: '📄 PDF 已保存' }));
      return;
    }
    const url = await getFullUrl(state.fileId).catch(() => null);
    if (!url) {
      mountPreview(el('div', { class: 'inv-thumb', style: 'width:100%;height:130px', text: '📄 PDF 已保存' }));
      return;
    }
    mountPreview(el('img', { class: 'inv-preview', src: url, alt: '发票' }));
  }

  async function pickFile(file) {
    if (!file) return;
    state.busy = true;
    errorNode.textContent = '';
    try {
      const prepared = await prepareFile(file);
      const fileId = await saveFile(prepared);
      state.fileId = fileId;
      if (prepared.failed) {
        errorNode.textContent = '图片未能压缩，已按原样保存';
      } else if (prepared.compressed) {
        const saved = Math.round((1 - prepared.size / prepared.originalSize) * 100);
        errorNode.textContent = `已压缩，省了约 ${saved}%`;
      }
      await paintPreview();
    } catch (err) {
      errorNode.textContent = '图片保存失败：' + (err?.message || err);
    } finally {
      state.busy = false;
    }
  }

  function fileInput(accept, capture) {
    const input = el('input', {
      type: 'file', accept,
      ...(capture ? { capture } : {}),
      style: 'display:none',
      onchange: (e) => { pickFile(e.target.files?.[0]); e.target.value = ''; }
    });
    return input;
  }

  const cameraInput = fileInput('image/*', 'environment');
  const albumInput = fileInput('image/*,application/pdf');

  const amountText = el('div', { class: 'vault-code', text: '¥0.00' });
  const keypad = createKeypad({
    onChange: ({ cents }) => {
      state.amountCents = cents;
      amountText.textContent = cents === null ? '¥0.00' : formatCents(cents, { symbol: true });
    }
  });

  const numberInput = el('input', {
    type: 'text', placeholder: '发票号码',
    oninput: (e) => { state.number = e.target.value; }
  });

  function field(label, node) {
    return el('label', { class: 'stack', style: 'gap:4px' }, [
      el('span', { class: 'k', text: label }),
      node
    ]);
  }

  const typeSelect = el('select', {
    onchange: (e) => { state.type = e.target.value; }
  }, INVOICE_TYPES.map(t => el('option', { value: t.id, text: t.label })));

  // 这几个输入框要具名：load() 回填时必须逐个写回控件的 value，
  // 只把值塞进 state 是不够的（state 有值 ≠ 界面上有值）。
  const sellerInput = el('input', { type: 'text', placeholder: '开票单位名称', oninput: (e) => { state.seller = e.target.value; } });
  const buyerTitleInput = el('input', { type: 'text', oninput: (e) => { state.buyerTitle = e.target.value; } });
  const buyerTaxIdInput = el('input', { type: 'text', oninput: (e) => { state.buyerTaxId = e.target.value; } });
  const noteInput = el('input', { type: 'text', oninput: (e) => { state.note = e.target.value; } });
  const archivedCheck = el('input', { type: 'checkbox', onchange: (e) => { state.archived = e.target.checked; } });

  async function submit() {
    errorNode.textContent = '';
    const check = validateInvoice(state);
    if (!check.ok) { errorNode.textContent = check.errors.join('；'); return; }

    // 查重：**只提示、不阻止**（规格第 5 节）。号码为空时不查。
    // 两段式：第一次点「保存」只提示，再点一次才真的存进去。直接用 return 拦住是不对的——
    // 同一张票补扫一次、纸质票号码撞了，都是真会遇到的合法情况，用户必须能强行存。
    if (state.number.trim()) {
      const dup = await invoiceStore.findByNumber(state.number);
      if (dup && dup.id !== state.id && !dupWarned) {
        dupWarned = true;
        errorNode.textContent = `这张票已经录过了（${dup.seller || dup.number}，${formatCents(dup.amountCents, { symbol: true })}）。要再存一张就再点一次「保存」。`;
        return;
      }
    }

    try {
      await invoiceStore.saveInvoice(state);
      sheet.close();
      activeSheet = null;
      if (onSaved) await onSaved();
    } catch (err) {
      errorNode.textContent = String(err?.message || err);
    }
  }

  async function load() {
    if (!id) return;
    const inv = await invoiceStore.getInvoice(id);
    if (!inv) return;
    Object.assign(state, inv);
    // 逐个写回控件：少这几行，编辑已有发票时所有字段都是空白，
    // 用户随便改一个字段再保存，就把原来的号码/销售方/抬头全清了。
    numberInput.value = inv.number ?? '';
    typeSelect.value = inv.type ?? 'other';
    sellerInput.value = inv.seller ?? '';
    buyerTitleInput.value = inv.buyerTitle ?? '';
    buyerTaxIdInput.value = inv.buyerTaxId ?? '';
    noteInput.value = inv.note ?? '';
    archivedCheck.checked = inv.archived === true;
    // 金额只能走 setFromCents（纪律 3）：formatCents 的输出带 ¥，键盘解析不了会变空。
    keypad.setFromCents(inv.amountCents ?? 0);
    amountText.textContent = formatCents(inv.amountCents ?? 0, { symbol: true });
  }

  // mount(parent, ...nodes) 是变参（内部还会 flat），这里按项目其它视图的写法传变参。
  mount(body,
    errorNode,
    previewBox,
    el('div', { class: 'stack', style: 'gap:6px' }, [
      el('button', { class: 'btn', type: 'button', text: '拍照', onclick: () => cameraInput.click() }),
      el('button', { class: 'btn', type: 'button', text: '选图片或 PDF', onclick: () => albumInput.click() })
    ]),
    cameraInput, albumInput,
    field('发票号码', numberInput),
    field('价税合计', amountText),
    keypad.node,
    field('销售方', sellerInput),
    field('发票类型', typeSelect),
    field('购买方抬头', buyerTitleInput),
    field('纳税人识别号', buyerTaxIdInput),
    el('label', { class: 'vault-check' }, [
      archivedCheck,
      el('span', { text: '仅存档（不参与报销追踪）' })
    ]),
    field('备注', noteInput),
    el('button', { class: 'btn btn-primary', type: 'button', text: '保存', onclick: submit })
  );

  load().then(paintPreview).catch(err => { errorNode.textContent = String(err?.message || err); });
}
```

- [ ] **步骤 2：** 核对 `createKeypad` 的返回字段名（已核实，不用改）

已核实：`app/ui/keypad.js` 的 `createKeypad({ onChange })` 返回 `{ node, clearAll, setFromCents, cents, text }`，字段名就是 `node`——上面代码里的 `keypad.node` 写法正确，**不要改成 `keypad.el`**。想自己看一眼可运行 `grep -n "return {" -A 6 app/ui/keypad.js`。

同时复核两条纪律（`app/ui/entry-panel.js` 文件头第 3、4 条）：回填金额只能用 `keypad.setFromCents(cents)`（`formatCents` 的输出带 `¥`，`parseAmountToCents` 解析不了会变空）；`onChange` 回调里只能读回调参数，不能引用 `const keypad` 自身（创建时会同步首调一次，那时还在 TDZ）。

- [ ] **步骤 3：** 删掉上面 import 里用不到的两个符号

运行：`node --check app/ui/invoice-editor.js`（预期通过；`node --check` 不解析 import，所以这一步必须人工确认——**import 了不存在的导出会在运行时抛 SyntaxError 级别的链接错误，整个编辑器打不开**）。

把 `import { INVOICE_TYPES, validateInvoice, findByNumberGuard } from '../invoice-model.js';` 改成

```js
import { INVOICE_TYPES, validateInvoice } from '../invoice-model.js';
```

查重不靠 `invoice-model` 里的纯函数，而是直接调 `invoiceStore.findByNumber`（见下面 `submit()`）——号码查重要读库，纯逻辑模块读不到。

再删掉 `import { todayRange } from '../dates.js';` 这一行：编辑器里没有任何地方用它（时间字段直接用时间戳）。

- [ ] **步骤 4：Commit**

```bash
git add app/ui/invoice-editor.js
git commit -m "feat(invoice): 发票编辑器（拍照/选文件/字段/查重提示）"
```

### 后续补充（超出原计划）

上面这套字段只到「备注」为止。收尾实测时发现两个用户看得见的缺口，补齐如下——两项都在同一个 commit `10e8c7c`（`feat(invoice): 编辑器里补上关联账目与删除入口`）里落地。

**缺口一：没法给一笔还没挂票的记账挂上第一张票**

原计划里「把发票挂到某笔账上」的唯一入口，是任务 8 放在记账首页流水行里的那个「🧾N」标记；而那个标记只有某笔账**已经有票**时才渲染，`openInvoiceLinkSheet` 也只有这一个入口。于是「给一笔还没挂票的账挂上第一张票」在界面上完全没有路径——而「发票与记账挂钩」正是这个功能的四条核心用途之一。

现在编辑器里多了「关联账目」一行：没有关联时显示「未关联」；已关联时显示那笔账的日期 · 分类名 · 金额（转账显示「转账」）。点「选一笔账」展开候选列表——最近 6 个月的流水里最新的 50 笔、按时间倒序（流水可能几百笔，不限条数这个面板会变得又长又慢），点一行即选中并收起；选中后给「取消关联」，它只把 `state.txnId` 置 null，保存时才落盘。保存时 `txnId` 随 `state` 一起交给 `saveInvoice`（仓库层从任务 5 起就支持它，不用改）；编辑一张已经关联过的票会按库里的记录回填。之所以放这里而不是继续加在记账页：用户现实中的顺序是「先有票，再决定挂到哪笔账上」。已经关联的那笔账如果被删掉了，这一行显示「已关联的账目已不存在」，不留空白也不报错。

**缺口二：发票没有删除入口**

`invoice-store.js` 的 `deleteInvoice(id)`（删票时连带删图）从任务 5 起就实现了，但界面上没有任何地方调用它：建错一张票就只能一直留着，而手机上最缺的恰恰是存储空间。

现在编辑器底部多了一个「删除这张发票」按钮，只在编辑已有发票时出现（新建时没什么可删的）。它用**两段式确认**：第一次点，按钮文字变成「再点一次就删除」并进入确认态，3 秒后自动复原，第二次点才真的删。不用 `window.confirm`——那是同步阻塞的系统弹窗，样式不可控、在 PWA 里还会打断整页，而项目里所有交互都不用系统弹窗（查重提示、密码箱的「确认删除？」都是改按钮文字），按钮就长在手指底下，改文字是最轻的确认方式。删除不可逆，所以：成功后关面板并调 `onSaved()`（列表与汇总自己刷新）；失败时把中文原因写在面板的错误行里并**留在面板里**，关掉面板会让用户以为删成功了。

**另外**（不在这一节的两项功能之内）：统计页有一处同款的切 Tab 竞态（`stats-view.js` 在 `await` 之后无条件 `mount(root, …)`，切走时那次渲染会盖掉别的页面），已照 `vault-view.js` 的「渲染序号 + 当前 Tab」两层检查补上，单独一个 commit。

---

## 任务 8：记账侧显示发票

**背景（已核实，这一条改变了做法）：** pvault 的记账流水**没有详情页**。`app/ui/ledger-home.js` 里的今日流水行是一个纯展示的 `div.row.ledger-txn-row`，点它没有任何反应；全项目唯一的交易交互入口是右下角 FAB 的「记一笔」（`openEntryPanel`），而 `store.updateTransaction` 至今零调用点（`app/ui/import-view.js` 里有一行注释专门记着这件事）。所以「在流水详情里加一行发票数」在当前结构下无处可挂。

**本任务改为：** 今日流水行里显示一个可点的「🧾N」标记，点它打开**发票关联面板**（列出这笔账已挂的票、可当场补挂）。不新增交易详情页——那是一次独立的界面扩展，超出本计划范围。

**文件：**
- 修改：`app/ui/invoice-view.js`（追加 `openInvoiceLinkSheet`）
- 修改：`app/ui/ledger-home.js`（取计数 + 行内标记）
- 修改：`styles/invoice.css`（补两个类）

### 步骤 1：在 `app/ui/invoice-view.js` 末尾追加关联面板

- [ ] 先补一个 import。该文件目前**没有**引入 `openSheet`（任务 6 的列表页自己不开 sheet），所以在文件头 import 区加一行：

```js
import { openSheet } from './sheet.js';
```

`el` / `mount` / `formatCents` / `openInvoiceEditor` 该文件已在用，不必再加。

- [ ] 再追加这段代码：

```js
// 从记账页点「🧾N」进来的小面板：看这笔账挂了哪些票，也能当场补挂一张。
// 与编辑器的分工：这里只管「挂靠」这一件事，看大图/改字段交给编辑器。
// txn 由调用方直接传整条对象（ledger-home 手里就有），不再查一次库；
// categoryName 同理已由调用方查好，这里不重复查分类表。
export function openInvoiceLinkSheet({ txn, categoryName = '', onChanged } = {}) {
  const body = el('div', { class: 'stack' });
  const sheet = openSheet({ title: '这笔账的发票', body });

  async function refresh() {
    const list = await invoiceStore.listByTxn(txn.id);

    const rows = list.map(inv => el('button', {
      class: 'inv-row', type: 'button',
      onclick: () => {
        sheet.close();
        openInvoiceEditor({ id: inv.id, onSaved: onChanged });
      }
    }, [
      el('span', { class: 'inv-row-main' }, [
        el('span', { text: inv.seller || inv.number || '未命名发票' }),
        el('span', { class: 'muted tiny', text: `${inv.number || '无号码'} · ${formatCents(inv.amountCents ?? 0, { symbol: true })}` })
      ]),
      inv.archived
        ? el('span', { class: 'inv-tag stored', text: '仅存档' })
        : el('span', { class: 'inv-tag pending', text: inv.reimbursementId ? '已报销' : '待报销' })
    ]));

    mount(body,
      el('div', { class: 'muted tiny', text: `${categoryName || '这笔账'} ${formatCents(txn.amountCents ?? 0, { symbol: true })}　已挂 ${list.length} 张` }),
      // el(tag, props, children) 的 children 收数组（不能像 mount 那样变参展开）
      list.length === 0
        ? el('div', { class: 'empty', text: '这笔账还没有发票' })
        : el('div', { class: 'stack' }, rows),
      el('button', {
        class: 'btn btn-primary', type: 'button', text: '＋ 新建发票并挂到这笔账',
        // txnId 直接交给编辑器：saveInvoice 会把它写进发票，不必再调 linkToTxn。
        onclick: () => {
          sheet.close();
          openInvoiceEditor({ txnId: txn.id, onSaved: onChanged });
        }
      })
    );
  }

  refresh().catch(err => {
    mount(body, el('div', { class: 'vault-error', text: String(err?.message || err) }));
  });
}
```

- [ ] 确认 `onChanged` 允许为 undefined：`openInvoiceEditor({ onSaved: undefined })` 内部是 `if (onSaved) await onSaved();`（见任务 7），不会炸。

### 步骤 2：`app/ui/ledger-home.js` 取发票计数

- [ ] 加两个 import（放在现有 import 区末尾）：

```js
import * as invoiceStore from '../invoice-store.js';
import { openInvoiceLinkSheet } from './invoice-view.js';
```

- [ ] 在 `renderLedgerHome` 的 `Promise.all` 里多要一项，解构末尾加 `invCounts`：

```js
  const [monthTxns, todayTxns, accounts, categories, receivables, budgetTotal, hideAmounts, lastBackupAt, reminderDays, invCounts] =
    await Promise.all([
      // …原有九项保持不变…
      store.getSetting('backupReminderDays', DEFAULT_BACKUP_REMINDER_DAYS),
      // 一次性整表统计，不要逐笔查：今日流水十几笔就是十几个事务，
      // 而发票表在没有导入大备份时也就几十到几百条，一次 getAll 更省。
      // 它返回 { [txnId]: 条数 }，没有发票的账根本不出现在这个对象里。
      invoiceStore.countByTxn()
    ]);
```

### 步骤 3：流水行加标记

- [ ] 今日流水那一行现在是「名称 + 金额」两个子节点，在**金额之前**插入标记（阅读顺序：名称 → 🧾N → 金额）：

```js
              // 发票标记：只有挂了票的账才出现。行本身不可点（流水没有详情页），
              // 所以能点开的入口就是这个小标记——aria-label 写清楚，别只留一个 emoji。
              invCounts[t.id]
                ? el('button', {
                    class: 'inv-tag ledger-inv-tag', type: 'button',
                    text: `🧾${invCounts[t.id]}`,
                    'aria-label': `这笔账有 ${invCounts[t.id]} 张发票`,
                    onclick: () => openInvoiceLinkSheet({
                      txn: t,
                      categoryName: catOf.get(t.categoryId)?.name || (t.kind === 'transfer' ? '转账' : ''),
                      onChanged: () => { renderLedgerHome(root).catch(err => console.error('首页重渲染失败', err)); }
                    })
                  })
                : null,
              el('span', { class: amountClass, text: `${t.kind === 'income' ? '+' : t.kind === 'transfer' ? '⇄ ' : '-'}${formatCents(t.amountCents)}` })
```

`onChanged` 里必须自己吞掉异常，理由与底部备份提醒那处相同（见该文件现有注释）：面板已经关掉了，首页渲染失败不该把整个流程带崩。

### 步骤 4：补样式

- [ ] 追加到 `styles/invoice.css` 末尾：

```css
/* 今日流水行里的发票标记。复用 .inv-tag 的边框/圆角/字号，但它是个 <button>：
   必须清掉按钮默认底色（否则在流水行里是一块突兀的灰底），并让字体继承行内字号。 */
.ledger-inv-tag {
  background: none;
  font: inherit;
  font-size: 11px;
  line-height: 1;
  padding: 2px 6px;
  margin: 0;
  cursor: pointer;
}

/* 关联面板里的每张票：整行可点，所以是个铺满宽度的按钮，文字要左对齐。 */
.inv-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  text-align: left;
}
.inv-row-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
```

`.inv-tag` 的 `margin-top: 3px` 是给列表页竖排用的，在横排的流水行里会把标记顶偏，所以 `.ledger-inv-tag` 里 `margin: 0` 覆盖掉它——两条规则特异性相同（都是单类），靠**书写顺序**取胜：`.ledger-inv-tag` 在 `.inv-tag` 之后定义。**因此这两段必须追加在文件末尾，不能插到前面。**

### 步骤 5：语法检查与真机验证

- [ ] 运行：`node --check app/ui/ledger-home.js && node --check app/ui/invoice-view.js`
预期：无输出。

- [ ] 在模拟器/CDP 上确认（这一步不可省：本轮改动全是界面行为）：
  - 给某笔今日流水挂一张票 → 该行出现「🧾1」，金额与名称都还在原位（标记不能把行挤换行）
  - 再挂一张 → 变成「🧾2」（这条专门验 `getAllByIndex` 取的是数组：写错成 `index().get()` 时它永远是 1）
  - 点「🧾2」→ 关联面板列出两张，点其中一张进编辑器且**字段已回填**（验任务 7 的 load 回填）
  - 点「＋ 新建发票并挂到这笔账」→ 保存后回首页，标记数 +1，且发票列表里这张票的关联账目正确
  - 没有发票的流水行不出现任何标记（不能出现「🧾0」）

### 步骤 6：Commit

```bash
git add app/ui/ledger-home.js app/ui/invoice-view.js styles/invoice.css
git commit -m "feat(invoice): 流水行的发票标记与关联面板"
```


---

## 任务 9：备份与恢复

**文件：**
- 修改：`app/backup.js`、`app/backup-store.js`

- [ ] **步骤 1：扩备份结构**

`app/backup.js` 的 `buildBackup` 里，`data` 加两项：

```js
const data = {
  // …原有字段不动…
  invoices: deepClone(payload.invoices ?? []),
  invoiceFiles: payload.invoiceFiles ?? []   // 已由调用方转成 base64 字符串
};
```

`REQUIRED_ARRAYS` **不变**——新字段是可选扩展，老备份没有它也要能导入。

- [ ] **步骤 1.5：把 `invoices` 加回 `ARRAY_STORES`（三个地方必须一起动）**

`app/backup-store.js` 的 `ARRAY_STORES` 现在是**显式**列表 `['txns', 'accounts', 'categories', 'receivables']`——它刻意不从 `Object.keys(STORES)` 派生：加发票三张表时正是那次派生让这个清单悄悄变成 7 张，而 `buildBackup` 仍只打包 5 个键，于是导入任何既有备份文件都在 `for (const value of data[name])` 上抛 TypeError，「恢复备份」这条唯一的救命通道整体失效（`app/backup-store.js` 里记着这件事的完整注释）。

本任务要让发票进备份，就在这里显式加上 `invoices`：

```js
const ARRAY_STORES = ['txns', 'accounts', 'categories', 'receivables', 'invoices'];
```

**但 `invoiceFiles` 不能加进这个清单**：它长得和记账那四张表不一样，`blob` / `thumbBlob` 是 Blob，直接进 `for (const value of data[name])` 循环会写进 `{}`（JSON 里的 Blob 就是这么来的）。它由下面的 `encodeFiles()` 与反解逻辑单独处理，相应地：

1. 写库时单独 `puts.push({ store: 'invoiceFiles', value })`；
2. 清库时必须显式列进去：`clears: [...ARRAY_STORES, 'invoiceFiles', 'settings']`——漏了它，「覆盖恢复」之后旧图片还会留在库里，新发票指向的图片 id 可能撞上这些残留；
3. 反解循环要自己判空：老备份里根本没有 `invoiceFiles` 键，`for (const f of data.invoiceFiles)` 会抛（`ARRAY_STORES` 那个循环有 `?? []` 兜底，这条独立路径没有）。

**这一步之后的回归验证（必做）**：导入一个**加发票之前导出的老备份文件**，必须仍然成功。这是本任务最容易打破的东西。

- [ ] **步骤 2：导出时把图片转 base64**

在 `app/backup-store.js` 的 `exportBackup` 里、组装 payload 处加：

```js
import * as db from './db.js';

// Blob 无法直接进 JSON（JSON.stringify(blob) 得到 {}），必须先转 base64。
// 这也是含图备份体积会大的原因：base64 比二进制大约 1/3。
async function encodeFiles() {
  const files = await db.getAll('invoiceFiles');
  const out = [];
  for (const f of files) {
    out.push({
      id: f.id,
      mime: f.mime,
      size: f.size,
      createdAt: f.createdAt,
      blob: await blobToBase64(f.blob),
      thumbBlob: f.thumbBlob ? await blobToBase64(f.thumbBlob) : null
    });
  }
  return out;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const s = String(fr.result);
      const i = s.indexOf(',');
      resolve(i >= 0 ? s.slice(i + 1) : '');
    };
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}
```

- [ ] **步骤 3：导出前算体积并给选项**

在导出界面的确认处显示：

```js
const files = await db.getAll('invoiceFiles');
const mb = estimateBackupMB(files);
if (files.length > 0) {
  // 界面文案：含 N 张图片，预计约 X MB；另给「不含图片」按钮
}
```

「不含图片」时传 `includeFiles: false`，`encodeFiles()` 直接返回 `[]`。

- [ ] **步骤 4：导入时反解 base64**

在 `app/backup-store.js` 的 `importBackup` 里，写库前加：

```js
function base64ToBlob(b64, mime) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime || 'application/octet-stream' });
}
```

并把 `invoiceFiles` 的每条还原成 `{ id, mime, size, createdAt, blob: base64ToBlob(...), thumbBlob: ... }` 后一起写进 `replaceAll` 的 `puts`。

- [ ] **步骤 5：** 语法检查

运行：`node --check app/backup.js; node --check app/backup-store.js`
预期：均无输出。

- [ ] **步骤 6：** 跑全量测试（`tests/backup.test.js` 会覆盖到 `buildBackup`）

运行：`node --test --test-isolation=none`
预期：全绿。若 `buildBackup` 的既有断言因新增字段而失败，**不要改断言去迁就**，检查是不是把新字段放在了 `data` 之外。

- [ ] **步骤 7：Commit**

```bash
git add app/backup.js app/backup-store.js
git commit -m "feat(invoice): 备份与恢复带上发票与图片（base64）"
```

---

## 任务 10：收尾与实测

**文件：**
- 修改：`sw.js`、`docs/手动验证清单.md`

- [ ] **步骤 1：** 把 7 个新文件加进 `sw.js` 的 `ASSETS` 白名单，并把 `CACHE` 从 `pvault-v12` 改成 `pvault-v13`

「创建」表里的 9 个文件中有 7 个要上线（两个 `tests/*.test.js` 不进白名单——它们不在浏览器里跑）。新增条目：

```
'./app/invoice-model.js',
'./app/image-scale.js',
'./app/image-store.js',
'./app/invoice-store.js',
'./app/ui/invoice-view.js',
'./app/ui/invoice-editor.js',
'./styles/invoice.css',
```

并在 `CACHE` 上方补一行 v13 的变更注释。

- [ ] **步骤 2：** 跑全量测试 + 逐条核对 ASSETS

运行：`node --test --test-isolation=none`
然后起 dev-server 逐条请求 `sw.js` 里每个 ASSETS 路径，确认全部 200，且白名单外（docs/tests/scripts/package.json）仍是 403。

- [ ] **步骤 3：** 在模拟器上实测（这是本计划唯一能验证 Canvas 与 IndexedDB 的手段）

```
powershell -File scripts/build-apk.ps1
adb install -r dist/app-release.apk
adb shell am start -n dev.pvault.app/.MainActivity
adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>
```

用 CDP 驱动，逐条确认：
- 底部出现第 4 个 Tab「发票」，点进去是空状态
- 新建一张发票：拍照（模拟器无摄像头时用「选图片」喂一张测试图）→ 填号码/金额/销售方 → 保存
- 列表中该条带缩略图、金额正确
- 再次用同一号码新建 → 出现「这张票已经录过了」，**再点一次「保存」仍然能存进去**（只警告不阻止）
- 编辑该票、改成「仅存档」→ 汇总里「待报销」减少，且编辑时各字段是**回填好的**（不是空白）
- 给某笔今日流水挂票 → 该行出现「🧾1」，点它能看到这张票
- 删除该票 → `invoiceFiles` 里对应记录也消失（说明没留下孤儿图）

- [ ] **步骤 4：** 更新 `docs/手动验证清单.md`，加「发票」小节

至少覆盖：第 4 个 Tab 存在、拍照、选 PDF、压缩后能看清字、查重提示（再点一次保存可强行存入）、仅存档、挂靠账目、流水行的「🧾N」标记与关联面板、含图备份导出与恢复后图片字节一致、不含图片备份恢复后发票记录仍在。

另外补两条与这次加表直接相关的：

- **老备份仍能导入**：用一个加发票之前导出的备份文件走一遍恢复，必须成功。加表那次差点把这条通道打掉（`ARRAY_STORES` 从 `STORES` 派生 → 多出三个键 → 老备份里没有 → `for...of undefined` 抛 TypeError），现在靠显式清单 + `?? []` 兜底守着，每次动备份结构都要手动回归一次。
- **升级被多标签页挡住时要有明确提示**：同一浏览器里开两个 pvault 页面，把其中一个更新到新版本（`DB_VERSION` 变了）后刷新，应看到「数据库正在被另一个页面占用」这类明确文字，而**不是**页面卡在那儿一动不动、什么都不发生。这是 `app/db.js` 的 `onblocked` 那条错误唯一的实测机会。

- [ ] **步骤 5：** Commit

```bash
git add sw.js docs/手动验证清单.md
git commit -m "chore(invoice): SW 预缓存、缓存版本号与手动验证清单"
```

---

## 自检结果

- **规格覆盖度**：规格第 1 节四项用途 → 任务 2/3/4/5/6/7；第 3 节数据模型 → 任务 1；第 4 节图片处理 → 任务 3/4；第 5 节挂靠与查重 → 任务 5/6/8；第 7 节界面 → 任务 6/7；第 8 节备份 → 任务 9；第 9 节测试策略 → 各任务内的测试步骤 + 任务 10。**第 6 节报销流程属于计划 5，本计划只建表。**
- **占位符扫描**：无「待定 / TODO / 后续实现」；每个代码步骤都给了完整代码。
- **类型一致性**：`validateInvoice` / `dedupeKey` / `sumCents` / `invoiceTitle` / `computeTargetSize` / `shouldCompress` / `useCompressed` / `estimateBackupMB` / `prepareFile` / `saveFile` / `getFile` / `deleteFile` / `getThumbUrl` / `getFullUrl` / `revokeUrl` / `listInvoices` / `getInvoice` / `findByNumber` / `listByTxn` / `countByTxn` / `saveInvoice` / `linkToTxn` / `deleteInvoice` / `summary` / `thumbUrlFor` / `fullUrlFor` / `getAllByIndex` / `openInvoiceEditor` / `openInvoiceLinkSheet` —— 各任务引用处与定义处一致。
- **三处集成点已全部核实（不再是「动手再确认」）**：
  1. `app/db.js` **没有**任何按索引取值的函数 → 任务 5 步骤 2 明确新增 `getAllByIndex`；取数组而不是单条，因为一笔账能挂多张票，`index().get()` 会把它永远显示成 1。
  2. `app/ui/keypad.js` 的 `createKeypad` 返回 `{ node, clearAll, setFromCents, cents, text }` → 任务 7 里的 `keypad.node` 写法正确，不必改。
  3. `app/ui/ledger-home.js` **没有**流水详情页（只有 `renderLedgerHome`，流水行是纯展示；`store.updateTransaction` 零调用点）→ 任务 8 整个改为「行内标记 + 关联面板」，不再假设存在详情渲染点。
- **另外顺手修掉的三处**（写计划时留的坑，不修就会带着 bug 落地）：任务 7 里 `mount(body, [数组])` 改成变参写法；编辑已有发票时必须把 `state` 逐个回填到控件（只 `Object.assign` 会让界面全空、一保存就把原内容清掉）；查重改成「提示一次、再点保存即放行」，而不是直接 `return` 拦住——规格第 5 节写的是只警告不阻止。
