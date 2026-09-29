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
  // `settleReimbursement：三处写入只发起一个事务，且都落地`：settleReimbursement 把报销单当
  // extraEntries 交给 addTransaction，那一次调用只发起一个写事务——把下面
  // `entries.concat(extraEntries)` 拆成两次 putAll，那条断言的计数差就从 1 变成 2、必红。
  // （「从 1 变成 2」的前提是桩只数**写**事务，见任务 4 步骤 1 里 transactionCount 的注释；
  //   它最初把只读事务也数进去，那样基数会是 2，正确的实现反而先红。）
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
