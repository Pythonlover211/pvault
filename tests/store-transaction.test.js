// store.js 的交易写入探针。
//
// 环境：真的 IndexedDB 在 Node 里不存在，这里用 tests/helpers/fake-browser.js 装的内存版
// （它盖得住什么、盖不住什么写在那份文件的开头，别把这里的绿读成真机验证）。
// app/db.js 与 app/store.js 的模块体都不碰浏览器全局，所以可以直接 import——
// 只要在**调用**它们之前把桩装好（下面那行 installFakeBrowser()）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeBrowser } from './helpers/fake-browser.js';
import * as db from '../app/db.js';
import * as store from '../app/store.js';
import { STORES } from '../app/schema.js';

installFakeBrowser();

async function clearAll() {
  await db.replaceAllRecords({ clears: Object.keys(STORES), puts: [] });
}

test.beforeEach(async () => { await clearAll(); });

test('addTransaction：extraEntries 与交易在同一个事务里写下去', async () => {
  const txn = await store.addTransaction(
    { kind: 'income', amountCents: 300000, categoryId: 'cat-refund', accountId: 'acc-1' },
    { extraEntries: [{ store: 'reimbursements', value: { id: 'r1', status: 'settled', createdAt: 1 } }] }
  );
  assert.ok(txn.id, '返回的仍然是完整交易');
  const saved = await db.get('reimbursements', 'r1');
  assert.equal(saved?.status, 'settled', '额外的条目必须真的落库');
});

test('addTransaction：不传 extraEntries 时行为与从前完全一致', async () => {
  // 既有 5 处调用点都走这条路，一个字都不该变。
  const txn = await store.addTransaction({ kind: 'expense', amountCents: 500 });
  assert.equal(txn.source, 'manual', 'source 默认值不变');
  // 不传时是 **null** 而不是 undefined：这个对象是重建出来的、字段逐个显式列出，
  // `input.reimbursementId ?? null` 对 undefined 也会落成 null。
  assert.equal(txn.reimbursementId, null, '不传时显式写 null');
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
