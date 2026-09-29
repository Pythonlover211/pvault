// 报销单数据层的探针。
//
// 环境：真的 IndexedDB 在 Node 里不存在，这里用 tests/helpers/fake-browser.js 装的内存版。
// 它盖得住「数据形状」（谁写了什么、删了什么），盖不住事务回滚——
// 所以下面凡是要验「同事务」的地方，用的是**事务计数**（见任务 4 步骤 1 给桩加的那个）。
//
// 计数一律用**差值**（桩的 txCount 单调递增、永不重置，见 fake-browser.js 里那段注释）：
// 绝对计数会红，而红线指向被测代码、真凶在桩里。
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeBrowser, transactionCount, failNextWrite } from './helpers/fake-browser.js';
import * as db from '../app/db.js';
import { saveInvoice } from '../app/invoice-store.js';
import { STORES } from '../app/schema.js';
import {
  listReimbursements, getReimbursement, listInvoicesOf, listPendingInvoices,
  createReimbursement, renameReimbursement, addInvoicesTo, removeInvoiceFrom,
  submitReimbursement, settleReimbursement, deleteReimbursement
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

// 让**这一次**写入失败。桩的 put 永远成功（fake-browser.js 文件头第 2 条），
// 所以「英文异常被翻成中文」这条路径不动桩就一次也走不到。
// finally 里再还原一次：fn 若没走到 put（前面的守卫先抛了），failNextWrite 的一次性还原不会发生。
async function withWriteFailure(storeName, err, fn) {
  const restore = failNextWrite(storeName, err);
  try {
    return await fn();
  } finally {
    restore();
  }
}

test.beforeEach(async () => { await clearAll(); });

test('createReimbursement：建单并把票挂上去', async () => {
  await mkInvoice({ id: 'i1' });
  await mkInvoice({ id: 'i2' });
  const created = await createReimbursement({ invoiceIds: ['i1', 'i2'], title: '9月报销 · 2 张', now: NOW });
  const { reimb: r, skipped } = created;

  // 返回值是**两件**，不是 `{ ...reimb, skipped }` 那样的混合体：
  // 混成一个对象之后，它和 getReimbursement 读回来的实体就有了两种形状，
  // 而照抄返回值字段去写库的代码（改名、改状态那类）会把 skipped 一起写进去，且不报错。
  assert.deepEqual(Object.keys(created).sort(), ['reimb', 'skipped'], '返回值是 { reimb, skipped } 两件');
  assert.deepEqual(skipped, [], '两张都是待报销的票，没有该跳过的');

  // 这里刻意**不写** `assert.ok(r.id)`：id 是 uid() 造的，永远非空，那条断言等于什么都没验
  // （store-transaction.test.js 里刚修掉同型的一条）。改成读回库里那条，钉住写进去的字段。
  const saved = await getReimbursement(r.id);
  assert.equal(saved.title, '9月报销 · 2 张');
  assert.equal(saved.status, 'draft');
  assert.ok(!('skipped' in saved), 'skipped 是给人看的信息，不该进库');

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
  const { reimb: second, skipped } = await createReimbursement({ invoiceIds: ['i1', 'i2'], title: '第二单', now: NOW });

  assert.equal((await db.get('invoices', 'i1')).reimbursementId, first.id, 'i1 应当还在第一单里，不能被抢走');
  assert.equal((await db.get('invoices', 'i2')).reimbursementId, second.id);
  assert.deepEqual(skipped, ['i1'], '被跳过的票要报出来，界面据此提示张数');
});

test('createReimbursement：仅存档的票被拒绝', async () => {
  await mkInvoice({ id: 'i1', archived: true });
  // 断言 code 而不是文案：文案是给人看的一句话，改文案不该让测试变红；
  // code 才是本模块与界面之间的契约（界面按 code 决定怎么提示），该被钉住的是它。
  // 对象形式的匹配只逐属性比较，**不比较 message**——所以改文案不会再让这两条变红（Node v24.19.0 实测）。
  await assert.rejects(
    () => createReimbursement({ invoiceIds: ['i1'], title: 'x', now: NOW }),
    { code: 'ARCHIVED_INVOICE' }
  );
  assert.equal((await db.getAll('reimbursements')).length, 0, '拒绝时不该留下半张报销单');
});

test('createReimbursement：一张票都没有也允许（用户可能先建单）', async () => {
  const { reimb: r } = await createReimbursement({ invoiceIds: [], title: '空的', now: NOW });
  assert.equal((await getReimbursement(r.id)).title, '空的');
  assert.deepEqual(await listInvoicesOf(r.id), []);
});

test('renameReimbursement：草稿能改名，提交后拒绝', async () => {
  await mkInvoice({ id: 'i1' });
  const { reimb: r } = await createReimbursement({ invoiceIds: ['i1'], title: '旧名', now: NOW });
  await renameReimbursement(r.id, '新名');
  assert.equal((await getReimbursement(r.id)).title, '新名');

  await db.put('reimbursements', { ...(await getReimbursement(r.id)), status: 'submitted' });
  await assert.rejects(() => renameReimbursement(r.id, '再改'), { code: 'NOT_EDITABLE' });
});

test('addInvoicesTo / removeInvoiceFrom：多票同事务、空清单早退、跨单不误伤', async () => {
  await mkInvoice({ id: 'i1' });
  await mkInvoice({ id: 'i2' });
  await mkInvoice({ id: 'i3' });
  const { reimb: r } = await createReimbursement({ invoiceIds: ['i1'], title: 'x', now: NOW });

  // —— 一次加**多张**票 ——
  // 只加一张时，「整批一次写」与「逐张写」在计数上不可区分（差值都是 1），这条纪律就等于没验。
  // 两张以上才分得开：把 writeAll(entries) 改成 for (const e of entries) await writeAll([e])，
  // 下面的差值立刻变成 2。
  const before = transactionCount();
  const added = await addInvoicesTo(r.id, ['i2', 'i3']);
  assert.deepEqual(added.skipped, []);
  assert.equal(transactionCount() - before, 1, '多张票必须落在同一个事务里（逐张写会让差值变成 2）');
  assert.equal((await db.get('invoices', 'i2')).reimbursementId, r.id);
  assert.equal((await db.get('invoices', 'i3')).reimbursementId, r.id);
  assert.equal((await listInvoicesOf(r.id)).length, 3);

  // —— 造一张「别人的票」：把 i3 挪到第二单，后面两条都以它为准 ——
  await removeInvoiceFrom(r.id, 'i3');
  const { reimb: other } = await createReimbursement({ invoiceIds: ['i3'], title: '第二单', now: NOW });
  assert.deepEqual((await listInvoicesOf(r.id)).map(i => i.id), ['i2', 'i1'], '第一单剩 i1、i2');

  // —— 空清单早退 ——
  // 把**已经在别的单里**的票再加一次：entries 会是空的，那条 `if (entries.length === 0) return`
  // 就是为它写的（少了它，db.putAll([]) 会在 db.transaction([]) 上抛 InvalidAccessError——
  // db.js 的 putAll 上方写着这条调用方契约）。本该是「什么都没发生」，不该把界面炸掉。
  const emptyAdd = await addInvoicesTo(r.id, ['i3']);
  assert.deepEqual(emptyAdd.skipped, ['i3'], '在别的单里的票要报出来，界面据此提示张数');
  assert.equal((await db.get('invoices', 'i3')).reimbursementId, other.id, '跳过就是没动它');
  assert.deepEqual((await listInvoicesOf(r.id)).map(i => i.id), ['i2', 'i1'], '第一单的票列表不该变');

  // —— 跨单不误伤 ——
  // 对第一单调 removeInvoiceFrom 一张其实属于第二单的票：归属校验少了，这里会把 i3 的
  // reimbursementId 置成 null——**第二单凭空少一张票**，而用户是在第一单上点的。
  const beforeRemove = transactionCount();
  await removeInvoiceFrom(r.id, 'i3');
  assert.equal((await db.get('invoices', 'i3')).reimbursementId, other.id, 'i3 属于第二单，不该被第一单摘走');
  assert.deepEqual((await listInvoicesOf(r.id)).map(i => i.id), ['i2', 'i1'], '第一单的票列表也不该变');
  assert.equal(transactionCount() - beforeRemove, 0, '不该发生的事连一次写都不该发起');

  // 本单的票仍然移得掉（归属校验别把正常路径也挡了）
  await removeInvoiceFrom(r.id, 'i2');
  assert.equal((await db.get('invoices', 'i2')).reimbursementId, null, '移除后票回到待报销');
  assert.deepEqual((await listInvoicesOf(r.id)).map(i => i.id), ['i1']);
});

test('写失败：英文异常翻成中文，原文进控制台（reimbursements 与 txns 两个入口）', async (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  const { reimb: r } = await createReimbursement({ invoiceIds: [], title: 'x', now: NOW });

  // 配额满。判据刻意是「有没有英文异常名」「有没有给出一句能照着做的中文」，而不是钉死整句文案：
  // 这里验的是**政策**（照 invoice-store 的 putInvoice 同一种人话），换一种说法只要还带下一步动作就该继续绿。
  const quota = new Error('QuotaExceededError: the quota has been exceeded.');
  quota.name = 'QuotaExceededError';
  await assert.rejects(
    () => withWriteFailure('reimbursements', quota, () => renameReimbursement(r.id, '新名')),
    err => {
      assert.equal(err.name, 'QuotaExceededError', '配额那条要沿用原 name，排查时还认得出');
      assert.doesNotMatch(err.message, /QuotaExceededError/, '英文异常名不能冒到界面上');
      assert.match(err.message, /备份|再试/, '要告诉用户下一步做什么');
      assert.ok(!logged.mock.calls.length, '配额那条不重复记控制台（与 invoice-store 同处置）');
      return true;
    }
  );

  // 其余存储失败：给一句中文，原文进控制台。
  const boom = new Error('UnknownError: the operation failed for reasons unrelated to the database itself.');
  boom.name = 'UnknownError';
  await assert.rejects(
    () => withWriteFailure('reimbursements', boom, () => renameReimbursement(r.id, '又改')),
    err => {
      assert.equal(err.name, 'Error', '这些 name 对用户没有信息量，不沿用');
      assert.doesNotMatch(err.message, /UnknownError/, '英文异常名不能冒到界面上');
      return true;
    }
  );
  assert.equal(logged.mock.calls.length, 1, '原文要进控制台留给排查');
  assert.equal(logged.mock.calls[0].arguments[1], boom, '控制台里那条就是原始异常本身');

  // 写失败就是没写成：库里那条不该被改动，用户重试才有意义。
  assert.equal((await getReimbursement(r.id)).title, 'x');

  // —— 第二个入口：settleReimbursement 的**记账**那支 ——
  // 它不走 writeAll（报销单那一条要作为 extraEntries 交给 addTransaction 同批写下去），
  // 于是「英文异常翻成人话」那层曾被整条绕过：同一个「标记到账」按钮，不记收入时是中文，
  // 记收入时把「QuotaExceededError: the quota has been exceeded.」直接送到界面上
  // （任务 9 的界面读的就是 err.message）。这条钉住两个入口说同一种人话。
  const { reimb: r2 } = await createReimbursement({ invoiceIds: [], title: '到账', now: NOW });
  await submitReimbursement(r2.id, NOW);
  const quotaTxn = new Error('QuotaExceededError: the quota has been exceeded.');
  quotaTxn.name = 'QuotaExceededError';
  await assert.rejects(
    () => withWriteFailure('txns', quotaTxn, () => settleReimbursement(r2.id, {
      settledCents: 100, accountId: null, categoryId: null, createTxn: true, now: NOW
    })),
    err => {
      assert.equal(err.name, 'QuotaExceededError', '配额那条要沿用原 name，排查时还认得出');
      assert.doesNotMatch(err.message, /QuotaExceededError/, '记账这条路也不能把英文异常名冒到界面上');
      assert.match(err.message, /备份|再试/, '与 writeAll 那条必须是同一句人话');
      return true;
    }
  );
  assert.equal((await getReimbursement(r2.id)).status, 'submitted', '写失败就是没写成，单子还停在已提交');
  assert.deepEqual(await db.getAll('txns'), [], '交易也不该留下');
  assert.equal(logged.mock.calls.length, 1, '配额失败不重复记控制台——两个入口一致（这一条没再多记一次）');
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

test('submitReimbursement：草稿→已提交，记下 submittedAt', async () => {
  await mkInvoice({ id: 'i1' });
  const { reimb: r } = await createReimbursement({ invoiceIds: ['i1'], title: 'x', now: NOW });
  const after = await submitReimbursement(r.id, NOW + 1000);

  assert.equal(after.status, 'submitted');
  assert.equal(after.submittedAt, NOW + 1000);
  assert.equal((await getReimbursement(r.id)).status, 'submitted', '必须真的落库');
});

test('submitReimbursement：已提交的不能再提交，已到账的也不许再提交', async () => {
  await mkInvoice({ id: 'i1' });
  const { reimb: r } = await createReimbursement({ invoiceIds: ['i1'], title: 'x', now: NOW });
  await submitReimbursement(r.id, NOW);

  // 断言 code、不断言文案（本文件的政策：改文案不该让测试变红），代价是那两处文案分叉也验不出来——
  // 把「已经提交过了」与「已经到账的…」对调，只断 code 的版本照样全绿。
  // 折中是**钉分支而不是钉措辞**：两条 message 必须**不同**，并且第二条要说得出「到账」这个区别。
  const seen = [];
  await assert.rejects(() => submitReimbursement(r.id, NOW), err => {
    assert.equal(err.code, 'NOT_SUBMITTABLE');
    seen.push(err.message);
    return true;
  });

  // 走到已到账：提交之后标记到账（不记账，只把状态推过去）
  await settleReimbursement(r.id, { settledCents: 0, createTxn: false, now: NOW });
  await assert.rejects(() => submitReimbursement(r.id, NOW), err => {
    assert.equal(err.code, 'NOT_SUBMITTABLE');
    seen.push(err.message);
    assert.match(err.message, /到账/, '已到账这条要说清卡在哪一步');
    return true;
  });
  assert.notEqual(seen[0], seen[1], '「已经提交过」与「已经到账」是两种情形，不能共用同一句文案（对调就会红）');
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
  // 这里刻意**不写** `assert.ok(settled.txnId)`：txnId 由 uid() 生成、永远非空，那条断言等于什么都没验
  // （本文件上面刚写过同型的一条）。真验「写进去的是同一个 id」的是下面这行——读回库里那笔交易，
  // 同时钉住「报销单上的 txnId 就是交易的主键」。
  const txn = await db.get('txns', settled.txnId);
  assert.ok(txn, '报销单上的 txnId 必须就是那笔交易的主键（换个 id 就读不到它了）');
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

test('settleReimbursement：草稿不能直接到账，已到账的不能重复标记', async () => {
  await mkInvoice({ id: 'i1' });
  const { reimb: r } = await createReimbursement({ invoiceIds: ['i1'], title: 'x', now: NOW });
  // 「钉分支而不是钉措辞」：只断 code 时，把这两处文案对调仍然全绿（见 submit 那条的说明）。
  const seen = [];
  await assert.rejects(
    () => settleReimbursement(r.id, { settledCents: 1, createTxn: false, now: NOW }),
    err => {
      assert.equal(err.code, 'NOT_SETTLEABLE');
      seen.push(err.message);
      assert.match(err.message, /提交/, '草稿这条要说清「还没提交给公司」');
      return true;
    }
  );

  await submitReimbursement(r.id, NOW);
  await settleReimbursement(r.id, { settledCents: 0, createTxn: false, now: NOW });
  await assert.rejects(
    () => settleReimbursement(r.id, { settledCents: 0, createTxn: false, now: NOW }),
    err => {
      assert.equal(err.code, 'NOT_SETTLEABLE');
      seen.push(err.message);
      assert.match(err.message, /到账/, '重复标记这条要说清「已经到账了」');
      return true;
    }
  );
  assert.notEqual(seen[0], seen[1], '「还没提交」与「已经到账」是两种情形，不能共用同一句文案（对调就会红）');
});

test('settleReimbursement：要记账时金额非法或缺失一律拒绝，且零写入', async () => {
  await mkInvoice({ id: 'i1', amountCents: 1000 });
  const { reimb: r } = await createReimbursement({ invoiceIds: ['i1'], title: 'x', now: NOW });
  await submitReimbursement(r.id, NOW);

  // 四类输入都在这一条里：
  //  · `{}` 与 `{ amountCents: 100 }` 是**漏传 / 写错字段名**——第一版有 `settledCents = 0` 的默认值
  //    叠上「非法就折成 0」的兜底，这两种调用会「标记已到账 + 记一笔 ¥0 收入 + 记一个 txnId」
  //    而全程不报错，用户根本看不出记错了（0 又是合法业务值，公司拒报就是它）；
  //  · '100' 与 1.5 是**给了但不合法**——从输入框直接拿到的字符串、或算错的小数。
  const bad = [
    ['漏传', {}],
    ['写错字段名 amountCents', { amountCents: 100 }],
    ['字符串金额', { settledCents: '100' }],
    ['小数金额', { settledCents: 1.5 }]
  ];
  for (const [label, opts] of bad) {
    const before = transactionCount();
    await assert.rejects(
      () => settleReimbursement(r.id, { ...opts, createTxn: true, now: NOW }),
      err => {
        assert.equal(err.code, 'BAD_INPUT', `${label} 要被拒绝，而不是折成 0`);
        return true;
      }
    );
    assert.equal(transactionCount() - before, 0, `${label}：拒绝就该发生在写入之前，一次写都不该发起`);
  }

  assert.equal((await getReimbursement(r.id)).status, 'submitted', '单子还停在已提交');
  assert.deepEqual(await db.getAll('txns'), [], '库里不该有任何交易');
});

test('settleReimbursement：显式传 0 是合法值（公司拒报），照记账', async () => {
  await mkInvoice({ id: 'i1', amountCents: 1000 });
  const { reimb: r } = await createReimbursement({ invoiceIds: ['i1'], title: 'x', now: NOW });
  await submitReimbursement(r.id, NOW);

  // 0 与「漏传」必须是两条路：前者是用户按过二次确认的真实结果，要照记；后者见上一条。
  const settled = await settleReimbursement(r.id, { settledCents: 0, createTxn: true, now: NOW });
  assert.equal(settled.settledCents, 0);
  assert.equal((await db.get('txns', settled.txnId)).amountCents, 0, '显式传 0 就记一笔 ¥0 的收入');
});

test('settleReimbursement：不记账时缺金额是正常的（落 null，不是折成 0）', async () => {
  await mkInvoice({ id: 'i1', amountCents: 1000 });
  const { reimb: r } = await createReimbursement({ invoiceIds: ['i1'], title: 'x', now: NOW });
  await submitReimbursement(r.id, NOW);

  // createTxn:false 那条路（公司没打钱、只把单子标成到账）**本来就没有金额**，
  // 那里不传 settledCents 是正常的调用方式，不该被上面的金额校验挡住。
  const settled = await settleReimbursement(r.id, { createTxn: false, now: NOW });
  assert.equal(settled.status, 'settled');
  // 这条断言原文是 `settledCents === 0`，理由写的是「没给金额就是不记账的那条路，按 0 记
  // （不是 null：单子已经到账了）」。**它钉的正是「缺省折成 0」这个被推翻的行为**，已按审查结论改成 null：
  //  · 兜底成 0 与 settledCents 的 null 默认值（「没给」与「真的是 0 元」必须分开）自相矛盾；
  //  · 后果是界面上「金额留空 + 只标记到账」会静默落库 0，详情页显示
  //    「实际到账 ¥0.00 / 差额 −¥3,025.00」——把「没填」记成了「公司给了 0 元」。
  // 真的 0 元（公司拒报）走显式传值那条路，见上面「显式传 0 是合法值」。
  assert.equal(settled.settledCents, null, '没给金额就是不记账的那条路：落 null（「没填」不是「0 元」）');
  assert.equal(settled.txnId, null);
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

test('deleteReimbursement：删一张不存在的单是幂等成功，一次写都不发起', async () => {
  // 这是**有意**的契约（与其余写函数的 NOT_FOUND 相反）：重复点删除不该报错。
  // 之前没有任何测试钉住它——把 `if (!reimb) return` 改成抛 NOT_FOUND，全量仍然全绿。
  const before = transactionCount();
  await deleteReimbursement('r-不存在');
  assert.equal(transactionCount() - before, 0, '什么都不存在时，连一次写都不该发起');
  assert.deepEqual(await db.getAll('reimbursements'), [], '也不该凭空写出一条记录');
});

test('deleteReimbursement：deleteTxn 为真但单子还没到账（没有 txnId）时照常删掉，不碰 txns', async () => {
  // 草稿单/已提交单本来就没有 txnId（settle 才生成），此时 `reimb.txnId` 那半个守卫必须挡住
  // 「删一个 undefined 主键」——真机上 store.delete(undefined) 是**同步抛 DataError**的
  // （app/db.js 的 removeAll 注释逐字记着这个坑），整单会跟着删不掉。
  // 这条测试在桩上也验得动，前提是桩的 delete 校验主键（tests/helpers/fake-browser.js）。
  await mkInvoice({ id: 'i1', amountCents: 5000 });
  const { reimb: r } = await createReimbursement({ invoiceIds: ['i1'], title: 'x', now: NOW });
  await submitReimbursement(r.id, NOW);
  assert.equal((await getReimbursement(r.id)).txnId, null, '还没到账的单子没有 txnId');

  await deleteReimbursement(r.id, { deleteTxn: true });

  assert.equal(await getReimbursement(r.id), null, '没有 txnId 也照样删得掉');
  assert.equal((await db.get('invoices', 'i1')).reimbursementId, null, '票回到待报销');
  assert.deepEqual(await db.getAll('txns'), [], '没有交易可删，txns 不该被动过');
});
