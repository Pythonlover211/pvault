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
  const r = await createReimbursement({ invoiceIds: ['i1', 'i2'], title: '9月报销 · 2 张', now: NOW });

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
  const first = await createReimbursement({ invoiceIds: ['i1'], title: '第一单', now: NOW });
  const second = await createReimbursement({ invoiceIds: ['i1', 'i2'], title: '第二单', now: NOW });

  assert.equal((await db.get('invoices', 'i1')).reimbursementId, first.id, 'i1 应当还在第一单里，不能被抢走');
  assert.equal((await db.get('invoices', 'i2')).reimbursementId, second.id);
  assert.deepEqual(second.skipped, ['i1'], '被跳过的票要报出来，界面据此提示张数');
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
  const r = await createReimbursement({ invoiceIds: [], title: '空的', now: NOW });
  assert.ok(r.id);
  assert.deepEqual(await listInvoicesOf(r.id), []);
});

test('renameReimbursement：草稿能改名，提交后拒绝', async () => {
  await mkInvoice({ id: 'i1' });
  const r = await createReimbursement({ invoiceIds: ['i1'], title: '旧名', now: NOW });
  await renameReimbursement(r.id, '新名');
  assert.equal((await getReimbursement(r.id)).title, '新名');

  await db.put('reimbursements', { ...(await getReimbursement(r.id)), status: 'submitted' });
  await assert.rejects(() => renameReimbursement(r.id, '再改'), /已经提交|不能修改/);
});

test('addInvoicesTo / removeInvoiceFrom：加票与移票', async () => {
  await mkInvoice({ id: 'i1' });
  await mkInvoice({ id: 'i2' });
  const r = await createReimbursement({ invoiceIds: ['i1'], title: 'x', now: NOW });

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
  const r = await createReimbursement({ invoiceIds: ['i1', 'i2'], title: 'x', now: NOW });
  const two = await listInvoicesOf(r.id);
  assert.deepEqual(two.map(i => i.id), ['i2', 'i1'], '与 listInvoices 同一套排序：开票日期倒序、同日按录入时间倒序');

  await db.put('reimbursements', { id: 'r0', title: '更早', status: 'draft', createdAt: NOW - 1000 });
  const all = await listReimbursements();
  assert.deepEqual(all.map(x => x.id), [r.id, 'r0'], '报销单按创建时间倒序');
});
