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
