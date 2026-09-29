import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STATUS, STATUS_IDS, STATUS_LABELS, isStatus, statusLabel,
  canEdit, canSubmit, canSettle, canDelete, isActive,
  autoTitle, diffCents, invoiceStatus, invoiceBadge, matchFilter,
  settleDefaults, DEFAULT_SETTLE_CATEGORY
} from '../app/reimburse-model.js';
import { seedCategories } from '../app/schema.js';

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
  assert.equal(invoiceStatus({ archived: true }), 'stored');
  // 这个判据只看发票自身的两个字段，不看报销单：列表页只查 invoices 表，那一刻拿不到报销单。
  // 有 reimbursementId 就判「已报销」，不能因为读不到报销单就把它算成待报销。
  assert.equal(invoiceStatus({ archived: false, reimbursementId: 'r1' }), 'reimbursed');
  assert.equal(invoiceStatus({ archived: false, reimbursementId: null }), 'pending');
  // 脏组合（既存档又在单里）优先按「仅存档」显示——它本不该存在，
  // 但显示成一个没法解释的东西更糟。
  assert.equal(invoiceStatus({ archived: true, reimbursementId: 'r1' }), 'stored');
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

  // 脏组合「既存档、又在单里」：三态判据以 archived 优先（见 invoiceStatus 的注释），
  // 所以它既不算待报销、也不算已报销——两个筛选都要把它排除掉。
  // 这几条不能省：把 case 'reimbursed' 换成手写 `!!inv?.reimbursementId`（丢掉 archived 优先）
  // 时，其余 11 条断言全绿——夹具里从来没有这个组合，洞就是这么留下的。
  const dirty = { archived: true, reimbursementId: 'r1', txnId: null };
  assert.equal(matchFilter(dirty, 'pending'), false, '仅存档的票不该出现在待报销里');
  assert.equal(matchFilter(dirty, 'reimbursed'), false, '仅存档的票不参与报销追踪');

  // 仅存档 ∩ 未挂账：**照旧算「未挂账」**（控制者裁定，理由见 matchFilter 的注释）。
  // 这条同样不能省：夹具原本只覆盖了「存档且已挂账」，把 unlinked 改成排除 archived 也是全绿。
  assert.equal(matchFilter({ archived: true, reimbursementId: null, txnId: null }, 'unlinked'), true);

  // 不认识的筛选 id 一律放行（等于「全部」），不把列表变成空白。
  assert.equal(matchFilter(pending, 'nope'), true);
});

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
  // 这条是「编 id」与「给 null」的分界：往下传 'acc-9' 或不存在的值，会在
  // settleReimbursement 里写出一笔指向幽灵账户的收入——界面显示空白、账对不上、还不报错。
  const d = settleDefaults({ invoices: [], lastAccountId: 'acc-9', accounts: [] });
  assert.equal(d.accountId, null);
  // 没给 lastAccountId（首次使用，settings 表里根本没这个键）时同样不许编 id。
  assert.equal(settleDefaults({ invoices: [], accounts: [] }).accountId, null);
  // 脏数据：账户项缺 id（或 id 是空串）时不能被当成候选，「第一个」也不能落在它头上。
  const dirty = [{ name: '没有 id 的脏账户' }, null, { id: '' }, { id: 'acc-1' }];
  assert.equal(settleDefaults({ invoices: [], lastAccountId: null, accounts: dirty }).accountId, 'acc-1');
  // 全都是脏项 → 退到 null，而不是退到 undefined 或空串（它们会被原样写进库）。
  assert.equal(settleDefaults({ invoices: [], accounts: [{}, null] }).accountId, null);
});

test('settleDefaults：分类默认值必须真的是「退款」这个收入分类', () => {
  // 钉住 id 与种子的对应关系：schema 里把 cat-refund 改名 / 挪走 kind 之后，
  // 面板会安静地预选到一个不存在（或不是收入）的分类上，交易记出来是「无分类」。
  const hit = seedCategories().find(c => c.id === DEFAULT_SETTLE_CATEGORY);
  assert.ok(hit, `默认到账分类 ${DEFAULT_SETTLE_CATEGORY} 不在默认种子里——面板会预选到一个不存在的分类`);
  assert.equal(hit.kind, 'income', '到账记的是收入，默认分类的 kind 必须是 income');
});
