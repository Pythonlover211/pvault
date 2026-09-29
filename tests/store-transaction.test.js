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

test('addTransaction：extraEntries 会与交易一起落库', async () => {
  // 名字只说「一起落库」，不说「同一个事务」——因为这条断言钉住的只有**数据到达**那一层：
  // 额外条目确实被写下去了。它钉不住「同一次 putAll」。实测过：把 store.js 里
  // `await db.putAll(entries.concat(extraEntries))` 拆成两次 putAll（即真的变成两个事务），
  // 这条测试照样绿。名字若承诺「同事务」，它承诺的就是一个自己拿不出证据的保证——
  // 下一个人会以为这层保证有人看着，然后放心去改那行代码。
  //
  // 真正那层保证（同事务 / 中途失败整笔回滚）由 app/store.js 里「单个 transaction + 单次
  // putAll」的代码结构承载，**自动化测不了**：tests/helpers/fake-browser.js 文件头第 1 条差异
  // 写的正是它——abort() 只改一个标记，已经写进 Map 的数据不会退回去，所以桩上根本产生不了
  // 「写了一半」的状态。那层保证得靠代码审查与 docs/手动验证清单.md 的真机条目，不靠这条测试。
  //
  // 补上这一环的是任务 4：桩会加一个 transactionCount()，届时这条才能真正强化成
  // 「整笔写入只发起一次 putAll」。现在做不到，就不要在这里假装做到了。
  const txn = await store.addTransaction(
    { kind: 'income', amountCents: 300000, categoryId: 'cat-refund', accountId: 'acc-1' },
    { extraEntries: [{ store: 'reimbursements', value: { id: 'r1', status: 'settled', createdAt: 1 } }] }
  );
  assert.ok(txn.id, '返回的仍然是完整交易');
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
