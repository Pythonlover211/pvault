// 报销单列表与详情（app/ui/reimburse-view.js）的行为探针。
//
// 为什么这里能测 UI：与 tests/settle-sheet.test.js 走的是同一条路——DOM 由
// tests/helpers/fake-dom.js 顶上、IndexedDB 由 tests/helpers/fake-browser.js 顶上，中间的
// invoice-store / reimburse-store 全是**真的**。所以下面断的是「点一下之后库里多了什么、
// 屏幕上写着什么」，不是 DOM 结构；一条断言都不该因为改样式或挪节点而红。
//
// 只有三处用了类名，它们都是**仓里的显示约定**、不是本测试对布局的假设（换名字时两处一起换）：
//   · `reimb-card`   —— 列表卡片，用来「按标题取到某一张卡」；
//   · `rd-node`      —— 详情页时间线的节点，灰显在 Node 里没有样式可验，只能验类名；
//   · `sheet-overlay`—— sheet.js 的面板容器，用来把「面板里的按钮」与页面上的同名按钮分开
//                       （详情页有一个「删除」，删除确认面板里也有一个）。
//
// 本文件的第一条断言（空状态那个按钮的**参数形状**）钉的是**跨文件契约**：任务 7 的动态
// import 按 `{ startSelecting: true }` 进入多选。参数名写错**不会报错**，只会让用户点完
// 「去发票里选几张」之后什么也不发生——这类错只有把形状写进断言才抓得住。
//
// 另一条来由（与 settle-sheet.test.js 同类）：删掉详情页的 canEdit 判断、让「移除」在已提交的
// 单上照样显示，全仓测试曾经**全绿**——规格 §6 说「提交后不能再改单里的票」正是靠这一层。
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeBrowser, failNextWrite } from './helpers/fake-browser.js';
import {
  installFakeDom, resetFakeDom, findAll, findByText
} from './helpers/fake-dom.js';
import * as db from '../app/db.js';
import { STORES } from '../app/schema.js';
import { saveInvoice } from '../app/invoice-store.js';
import {
  createReimbursement, submitReimbursement, settleReimbursement, getReimbursement
} from '../app/reimburse-store.js';
import { formatCents } from '../app/money.js';
import { renderReimbursements } from '../app/ui/reimburse-view.js';

installFakeBrowser();
installFakeDom();
// app/router.js 的 currentTab() 读的是**裸全局** location（不是 window.location），
// 而本视图的每次渲染都会拿它做「还在发票段吗」的守卫。不装上就是 ReferenceError。
globalThis.location = { hash: '#/invoice' };

const NOW = 1700000000000;

async function clearAll() {
  await db.replaceAllRecords({ clears: Object.keys(STORES), puts: [] });
}

// IndexedDB 桩的每个请求都走 setTimeout(0)（见 fake-browser.js 的 settledRequest），
// 而本视图一次渲染要串好几个 await。**不能用 setImmediate**：setImmediate 跑在 check 阶段，
// 连续几十次也花不到 1ms，而 setTimeout(0) 实际被 clamp 到 1ms——回合数写少一点就等于没推进。
const tick = () => new Promise(resolve => setTimeout(resolve, 1));

async function flush(rounds = 10) {
  for (let i = 0; i < rounds; i += 1) await tick();
}

// 等一个条件成立，而不是睡固定轮数：渲染的 await 轮数与数据量有关，写死轮数就是随机红。
async function waitFor(pred, label, rounds = 60) {
  for (let i = 0; i < rounds; i += 1) {
    if (pred()) return;
    await tick();
  }
  throw new Error(`等了 ${rounds} 轮，${label} 还没出现`);
}

// 判据本身要读库时用这个（读库是异步的，而 waitFor 的判据是同步的）。
// 它比「睡 N 轮再断言」诚实：库还没写完就是等，而不是碰运气。
async function waitForAsync(pred, label, rounds = 60) {
  for (let i = 0; i < rounds; i += 1) {
    if (await pred()) return;
    await tick();
  }
  throw new Error(`等了 ${rounds} 轮，${label} 还没出现`);
}

async function attachedInvoiceCount() {
  return (await db.getAll('invoices')).filter(i => i.reimbursementId).length;
}

// 按**完全相等**的文本找按钮：屏幕上到处都是含「删除」「到账」的句子，
// findByText 是 includes，撞上哪个全看节点深度。
function buttons(text) {
  return findAll(document.body, n => n.tagName === 'BUTTON' && n.textContent === text);
}

function button(text) {
  const hit = buttons(text)[0];
  if (!hit) throw new Error(`屏幕上没有文本为「${text}」的按钮`);
  return hit;
}

function cards() {
  return findAll(document.body, n => n.classList.contains('reimb-card'));
}

function cardByTitle(title) {
  const hit = cards().find(c => c.textContent.includes(title));
  if (!hit) throw new Error(`列表里没有标题含「${title}」的卡片`);
  return hit;
}

function sheetRoot() {
  const hit = findAll(document.body, n => n.classList.contains('sheet-overlay'))[0];
  if (!hit) throw new Error('没有打开的面板');
  return hit;
}

function sheetButtons(text) {
  return findAll(sheetRoot(), n => n.tagName === 'BUTTON' && n.textContent === text);
}

// 详情页时间线上的一行。灰显（opacity）在 Node 里验不了，能验的是它带上没带上那个类。
function timelineRow(label) {
  const hit = findAll(document.body, n => n.classList.contains('rd-node'))
    .find(n => n.textContent.includes(label));
  if (!hit) throw new Error(`时间线上没有「${label}」这一行`);
  return hit;
}

async function mkInvoice(id, amountCents, seller = '某公司') {
  await saveInvoice({ id, number: '', amountCents, issuedAt: NOW, seller, type: 'other', archived: false });
}

async function mkDraftAt(title, invoiceIds, now) {
  const { reimb } = await createReimbursement({ invoiceIds, title, now });
  return reimb;
}

async function mkDraft(title, invoiceIds) {
  return mkDraftAt(title, invoiceIds, NOW);
}

async function submitAndGet(id) {
  await submitReimbursement(id, NOW + 1000);
  return getReimbursement(id);
}

// 只标记到账、不记收入：这条路能落 settledCents: null（「没填金额」），
// 而它是本文件里最容易写错的那个状态（折成 0 之后屏幕上写着「公司给了 0 元」）。
async function settleAndGet(id, settledCents) {
  return settleAt(id, settledCents, NOW + 2000);
}

// 到账时间要能被测试摆布：列表的「已到账」组按 settledAt 倒序，而 settledAt 与 createdAt
// 在真实使用里本来就是两回事（早建的单可能晚到账）。时间戳全用同一个 NOW 就验不出顺序。
async function settleAt(id, settledCents, now) {
  await settleReimbursement(id, { settledCents, createTxn: false, now });
  return getReimbursement(id);
}

async function renderList(opts = {}) {
  await renderReimbursements(document.body, opts);
}

// 从列表点进详情：点卡片的 onclick **不 await** 它发起的那次渲染（与仓里各视图一致），
// 所以要等一个只在详情页出现的标志。
async function openDetail(title) {
  await cardByTitle(title).click();
  await waitFor(() => buttons('← 报销单').length === 1, '详情页的返回按钮');
}

async function backToList() {
  await button('← 报销单').click();
  await waitFor(() => cards().length > 0, '回到列表');
}

test.beforeEach(async () => {
  await clearAll();
  resetFakeDom();
  // 复位模块级的 openId。它是**故意**留在模块里的（切走再回来，用户应该还在刚才那一单上），
  // 于是它也会跨用例残留。清库之后那一单已经不存在，renderReimbursements 读到 null 会自己退回列表
  // ——用**真实分支**复位，而不是给生产代码开一个只有测试用的 reset 口子。
  await renderList();
});

test('列表：空库给空状态，那个按钮以 { startSelecting: true } 回调（跨文件契约）', async () => {
  const calls = [];
  await renderList({ onSwitchToInvoices: opts => calls.push(opts) });

  assert.ok(findByText(document.body, '还没有报销单'), '空库要有空状态，不能是一片空白');
  await button('去发票里选几张').click();

  // 这一条钉的是任务 7 的回调形状：它按 { startSelecting: true } 切回发票段并进入多选。
  // 写成无参调用（或换一个键名）不会报错，只会让这个按钮点了没反应。
  assert.deepEqual(calls, [{ startSelecting: true }]);
});

test('列表：草稿与已提交进「进行中」，已到账进「已到账」', async () => {
  await mkInvoice('i1', 100000);
  await mkInvoice('i2', 202500);
  await mkInvoice('i3', 302500);
  await mkDraft('草稿单', ['i1']);
  const sub = await mkDraft('已提交单', ['i2']);
  await submitAndGet(sub.id);
  const set = await mkDraft('已到账单', ['i3']);
  await submitAndGet(set.id);
  await settleAndGet(set.id, 302500);

  await renderList();

  assert.ok(findByText(document.body, '进行中（2）'),
    '草稿与已提交都算「进行中」（isActive），分组计数必须是 2');
  assert.ok(findByText(document.body, '已到账（1）'), '已到账单独一组');
  assert.equal(cards().length, 3, '三张单都该出现在列表里');
});

test('列表：每张卡的「N 张 · 合计」是按它自己的发票算的', async () => {
  await mkInvoice('i1', 100000);
  await mkInvoice('i2', 202500);
  await mkInvoice('i3', 55500);
  await mkDraft('两张单', ['i1', 'i2']);
  await mkDraft('一张单', ['i3']);

  await renderList();

  // 断「某张卡自己的数」而不是「屏幕上有这个数」：合计写错（比如把列表里的票摊平了算）
  // 只要总数还在，全局断言照样绿。
  assert.ok(cardByTitle('两张单').textContent.includes('2 张 · ¥3025.00'),
    `两张单的合计应是 100000 + 202500 = ¥3025.00，实际卡片文本是「${cardByTitle('两张单').textContent}」`);
  assert.ok(cardByTitle('一张单').textContent.includes('1 张 · ¥555.00'));
});

test('列表：每张卡带创建日期（规格 §7.4 列的那一项）', async () => {
  await mkInvoice('i1', 100000);
  await mkDraft('有日期的单', ['i1']);

  await renderList();

  // 期望值用同一个 toLocaleDateString **现算**，不写死字符串：日期读的是本地时区，
  // 把「2023/11/15」钉进断言的话，换一台机器（或换时区）就红，而代码是对的。
  const want = new Date(NOW).toLocaleDateString('zh-CN');
  assert.ok(cardByTitle('有日期的单').textContent.includes(want),
    `卡片要带创建日期 ${want}，实际卡片文本是「${cardByTitle('有日期的单').textContent}」`);
});

test('列表：一张票都没有的单写「还没有发票」，不是「0 张 · ¥0.00」', async () => {
  await mkInvoice('i1', 100000);
  await mkDraft('空单', []);
  await mkDraft('正常单', ['i1']);

  await renderList();

  const empty = cardByTitle('空单').textContent;
  // 规格 §8：「报销单里一张票都没有」允许存在，但列表上要写「还没有发票」。
  // 「0 张」读起来是一个既成事实，而用户此刻恰恰是要往里加票。
  assert.ok(empty.includes('还没有发票'), `实际卡片文本是「${empty}」`);
  assert.ok(!empty.includes('0 张'), '零张的卡不该写「0 张」');
  assert.ok(!empty.includes('¥0.00'), '零张的卡不该写「¥0.00」');
  // 另一张卡照旧是「N 张 · 合计」——别为了零张那一句把正常分支也改了。
  assert.ok(cardByTitle('正常单').textContent.includes('1 张 · ¥1000.00'));
});

test('列表：已到账组内按 settledAt 倒序（不是创建时间）', async () => {
  await mkInvoice('i1', 100000);
  await mkInvoice('i2', 100000);
  await mkInvoice('i3', 100000);
  // 创建顺序是「早 → 晚」，到账顺序**反过来**（最早建的最后才到账）。
  // 两个顺序都写死，才能区分实现读的是哪一个时间戳。
  const a = await mkDraftAt('早建晚到', ['i1'], NOW);
  const b = await mkDraftAt('中建中到', ['i2'], NOW + 1000);
  const c = await mkDraftAt('晚建早到', ['i3'], NOW + 2000);
  for (const r of [a, b, c]) await submitAndGet(r.id);
  await settleAt(a.id, 100000, NOW + 30000);
  await settleAt(b.id, 100000, NOW + 20000);
  await settleAt(c.id, 100000, NOW + 10000);

  await renderList();

  // 判据取**屏幕上卡片的先后**（cards() 是文档序）：用户在这一组里找的是「最近哪笔钱回来了」，
  // 而不是「哪张单建得晚」。跟着 createdAt 倒序走的话，顺序刚好是反的。
  const order = cards()
    .map(c => /早建晚到|中建中到|晚建早到/.exec(c.textContent)?.[0])
    .filter(Boolean);
  assert.deepEqual(order, ['早建晚到', '中建中到', '晚建早到'],
    `已到账组应按 settledAt 倒序，实际屏幕顺序：${order.join(' → ')}`);
});

test('列表：脏 status 的单不会静默消失（兜底分组让它照旧出现在屏幕上）', async () => {
  await mkInvoice('i1', 100000);
  await mkDraft('正常单', ['i1']);
  // 一条谁也没定义过的 status：备份是从外部导入的、记录也可能被手改过——
  // statusLabel 早就为这种值准备好了「未知状态」的说法，说明这条路径是被承认存在的。
  await db.put('reimbursements', {
    id: 'garb-1', title: '脏状态单', status: 'garbage', createdAt: NOW - 1000,
    submittedAt: null, settledAt: null, accountId: null, txnId: null, settledCents: null, note: ''
  });

  await renderList();

  // 关键不是「它被归到哪一组」，而是**它在屏幕上**：「进行中」与「已到账」都是白名单判据，
  // 两个都不要它时这张单会从列表上整张消失——不报错、数据也还在，用户却以为单子丢了。
  assert.equal(cards().length, 2, `两张单都该出现，实际屏幕上 ${cards().length} 张`);
  assert.ok(cardByTitle('脏状态单').textContent.includes('未知状态'),
    '脏 status 的标签要走 statusLabel 的兜底说法，不是一句谁都看不懂的原文');
});

test('列表：已到账的卡片一定显示「实际到账」，差额只在非 0 时另起一行', async () => {
  await mkInvoice('i1', 302500);
  await mkInvoice('i2', 302500);
  await mkInvoice('i3', 302500);
  const a = await mkDraft('少给了', ['i1']);
  await submitAndGet(a.id);
  await settleAndGet(a.id, 300000);
  const b = await mkDraft('正好', ['i2']);
  await submitAndGet(b.id);
  await settleAndGet(b.id, 302500);
  const c = await mkDraft('没填金额', ['i3']);
  await submitAndGet(c.id);
  await settleAndGet(c.id, null);

  await renderList();

  // ① 实到 ≠ 合计：两行都要有，负数如实显示（公司少报、扣税、抹零都合法）
  assert.ok(cardByTitle('少给了').textContent.includes('实际到账 ¥3000.00'),
    `实到要如实显示，实际卡片文本是「${cardByTitle('少给了').textContent}」`);
  assert.ok(cardByTitle('少给了').textContent.includes('差额 -¥25.00'),
    '实到与合计不同时要有差额行');
  // ② 差额为 0：没有信息，不显示。**这条守着「别写成 diffCents(...) !== null」**——
  //    那样写会让差额为 0 的行也渲染，屏幕上多一行「差额 ¥0.00」的噪音。
  //    ⚠️ 但「实际到账」这一行**必须**在：规格 §7.4 那句「（若有）」紧跟在「差额」后面，管的是差额；
  //    实到金额对已到账的单是**无条件**的。改这条测试之前，「实际到账」与「差额」挤在同一行、
  //    由 diff 的真值一起决定要不要渲染，于是「公司正好给对」的单在列表上跟没记过金额一模一样
  //    （点进去才看得到）——那是规格偏差，返工把它拆成了两行（与详情页对齐）。
  assert.ok(!cardByTitle('正好').textContent.includes('差额'),
    '差额为 0 不显示（0 是 falsy，但这条判据靠的是真值判断，不是 diffCents 返回了 null）');
  assert.ok(cardByTitle('正好').textContent.includes('实际到账 ¥3025.00'),
    '差额为 0 时「实际到账」这一行仍必须在（「（若有）」管的是差额，不是到账金额）');
  // ③ settledCents 为 null：只标记到账、没填金额 → 写「未填」。**不能**走 formatCents：
  //    它对 null 会安静地返回 '¥0.00'，屏幕上就变成「公司给了 0 元」（同一个坑详情页那边也钉着）。
  assert.ok(cardByTitle('没填金额').textContent.includes('实际到账 未填'),
    `「没填」必须说出来，实际卡片文本是「${cardByTitle('没填金额').textContent}」`);
  assert.ok(!cardByTitle('没填金额').textContent.includes('¥0.00'),
    '「没填」不能显示成 ¥0.00');
  assert.ok(!cardByTitle('没填金额').textContent.includes('差额'),
    '没填金额就没有差额可谈');
});

test('详情：合计与时间线——已发生的节点有时间，未发生的是 — 且灰显', async () => {
  await mkInvoice('i1', 302500);
  await mkInvoice('i2', 55500);
  const r = await mkDraft('九月报销', ['i1', 'i2']);
  await submitAndGet(r.id);

  await renderList();
  await openDetail('九月报销');

  assert.ok(findByText(document.body, '¥3580.00'), '详情页的合计 = 两张票之和');
  assert.ok(findByText(document.body, '已提交'), '详情页要显示状态');
  for (const label of ['创建', '提交', '到账']) {
    assert.ok(timelineRow(label), `时间线上要有「${label}」这个节点`);
  }
  assert.ok(!timelineRow('创建').textContent.includes('—'), '创建时间一定有');
  assert.ok(!timelineRow('提交').textContent.includes('—'), '已提交的单，提交时间一定有');
  assert.ok(timelineRow('到账').textContent.includes('—'), '还没到账，到账节点显示「—」而不是一个假时间');
  assert.ok(timelineRow('到账').classList.contains('is-pending'), '未发生的节点要灰显（is-pending）');
  assert.ok(!timelineRow('提交').classList.contains('is-pending'), '已发生的节点不该灰显');
  assert.equal(findByText(document.body, '实际到账'), null, '没到账的单不该有「实际到账」这一行');
});

test('详情：settledCents 为 null 显示「未填」，不是 ¥0.00', async () => {
  await mkInvoice('i1', 302500);
  const r = await mkDraft('没填金额', ['i1']);
  await submitAndGet(r.id);
  await settleAndGet(r.id, null);

  await renderList();
  await openDetail('没填金额');

  assert.ok(findByText(document.body, '未填'),
    '「只标记到账、没填金额」在详情页必须说「未填」');
  // 这一句是整条测试的重点：把实现写成 formatCents(r.settledCents ?? 0) 会安静地渲染
  // 「¥0.00」——在记账 app 里「没填」与「公司给了 0 元」必须能分开（settleReimbursement 的
  // settledCents 默认值当初从 0 改成 null 就是为这件事）。
  assert.equal(findByText(document.body, '¥0.00'), null,
    '不能把「没填」显示成 ¥0.00');
  assert.equal(findByText(document.body, '差额'), null, '没有实到金额就没有差额可谈');
});

test('详情：实到 ≠ 合计显示差额；差额为 0 不显示', async () => {
  await mkInvoice('i1', 302500);
  await mkInvoice('i2', 302500);
  const a = await mkDraft('少给了', ['i1']);
  await submitAndGet(a.id);
  await settleAndGet(a.id, 300000);
  const b = await mkDraft('正好', ['i2']);
  await submitAndGet(b.id);
  await settleAndGet(b.id, 302500);

  await renderList();
  await openDetail('少给了');
  assert.ok(findByText(document.body, '差额 -¥25.00'), '实到 300000、合计 302500 → 差额 -¥25.00');
  assert.ok(findByText(document.body, '¥3000.00'), '「实际到账」要显示用户填的那个数');

  await backToList();
  await openDetail('正好');
  assert.ok(findByText(document.body, '实际到账'), '填了金额就显示这一行');
  assert.equal(findByText(document.body, '差额'), null, '差额为 0 是噪音，不显示');
});

test('canEdit 分界：草稿有「提交给公司」与每张票的「移除」，提交后两者都消失', async () => {
  await mkInvoice('i1', 302500);
  await mkInvoice('i2', 55500);
  await mkDraft('待提交单', ['i1', 'i2']);

  await renderList();
  await openDetail('待提交单');

  assert.equal(buttons('提交给公司').length, 1, '草稿态要能提交');
  assert.equal(buttons('移除').length, 2, '草稿态每张票一个「移除」');
  assert.equal(buttons('标记到账').length, 0, '草稿不能直接标记到账（canSettle 只管已提交）');

  await button('提交给公司').click();
  await waitFor(() => buttons('提交给公司').length === 0, '「提交给公司」消失');

  // 规格 §6 的核心约束：提交给公司之后就不能再改这张单里的票了。
  assert.equal(buttons('移除').length, 0, '已提交的单不该还能移除票');
  assert.ok(findByText(document.body, '已提交'), '状态要跟着变成已提交');
  assert.equal(buttons('标记到账').length, 1, '已提交才轮到「标记到账」');
  const all = await db.getAll('invoices');
  assert.equal(all.filter(i => i.reimbursementId).length, 2, '提交只改状态，不动票的归属');
});

test('详情：草稿的标题可点改名，改完落库并当场重绘', async () => {
  await mkInvoice('i1', 302500);
  const r = await mkDraft('旧标题', ['i1']);

  await renderList();
  await openDetail('旧标题');

  // 判据是**标题那个节点的类型**（`.rd-title` 是仓里的显示约定，与文件头列的三处同源）。
  // 「可点改」这件事只有真做成按钮才算数：做成一个不可点的 div，用户点了之后什么都不会发生，
  // 而 renameReimbursement 在 store 里一直躺着、没有任何调用点（规格 §7.4 要的就是这个入口）。
  const titleNode = findAll(document.body, n => n.classList.contains('rd-title'))[0];
  assert.equal(titleNode.tagName, 'BUTTON', '草稿态的标题应当是可点的按钮（规格 §7.4）');
  await titleNode.click();
  await waitFor(() => findAll(document.body, n => n.classList.contains('sheet-overlay')).length === 1,
    '改名面板');

  const input = findAll(sheetRoot(), n => n.tagName === 'INPUT')[0];
  assert.ok(input, '面板里要有一个标题输入框');
  assert.equal(input.value, '旧标题', '输入框要预填当前标题（用户多半只改一两个字）');
  input.value = '新标题';
  await sheetButtons('保存')[0].click();

  await waitForAsync(async () => (await getReimbursement(r.id))?.title === '新标题', '改名落到库里');
  await waitFor(() => findByText(document.body, '新标题') !== null, '详情页标题跟着变');
  assert.equal(findByText(document.body, '旧标题'), null, '旧标题不该留在屏幕上');
});

test('详情：提交之后的标题点不动（改名与「移票」同属 canEdit）', async () => {
  await mkInvoice('i1', 302500);
  const r = await mkDraft('已提交单', ['i1']);
  await submitAndGet(r.id);

  await renderList();
  await openDetail('已提交单');

  // 规格 §5.1 把「改名」和「加票 / 移票」一起算进 canEdit，只在草稿态放行：
  // 提交给公司之后再改标题，手机上这一单和公司收到的那张单就对不上了。
  // 判据取**节点类型**——把 editable 判据写坏（例如写死成 true）时标题会重新变成 BUTTON，这条当场红。
  const titleNode = findAll(document.body, n => n.classList.contains('rd-title'))[0];
  assert.equal(titleNode.tagName, 'DIV', '提交之后的标题必须是普通文本，不能是能点开改名的入口');
  assert.equal(
    findAll(document.body, n => n.tagName === 'BUTTON' && n.textContent === '已提交单').length, 0,
    '已提交的单不该有任何以标题为文本的按钮'
  );
});

test('删除保护：没生成过收入时只给一个「删除」，打开面板本身不动库', async () => {
  await mkInvoice('i1', 302500);
  const r = await mkDraft('草稿单', ['i1']);

  await renderList();
  await openDetail('草稿单');
  await button('删除').click();
  await waitFor(() => findAll(document.body, n => n.classList.contains('sheet-overlay')).length === 1,
    '删除确认面板');

  assert.equal(sheetButtons('删除').length, 1, '没有收入账时只该有一个「删除」');
  assert.equal(sheetButtons('连那笔收入一起删').length, 0, '没生成过收入就不该问这件事');
  assert.equal(sheetButtons('只删报销单，留下收入').length, 0);
  assert.ok(await getReimbursement(r.id), '只是打开面板，单子还在（点下去才算数）');

  await sheetButtons('删除')[0].click();
  await waitForAsync(async () => (await getReimbursement(r.id)) === null, '单子被删掉');
  assert.equal((await db.get('invoices', 'i1')).reimbursementId, null, '票回到待报销');
});

test('删除保护：生成过收入时给两个选择、都不默认，选了才动库', async () => {
  await mkInvoice('i1', 302500);
  const r = await mkDraft('已到账单', ['i1']);
  await submitAndGet(r.id);
  await settleReimbursement(r.id, {
    settledCents: 302500, createTxn: true, accountId: 'acc-1', categoryId: 'cat-refund', now: NOW + 2000
  });
  const settled = await getReimbursement(r.id);
  assert.ok(settled.txnId, '前置：这张单必须已经生成过收入账，否则测的是另一条分支');

  await renderList();
  await openDetail('已到账单');
  await button('删除').click();
  await waitFor(() => findAll(document.body, n => n.classList.contains('sheet-overlay')).length === 1,
    '删除确认面板');

  // 「不能默认」有两层，两层都要能验：
  //  ① 不能只给一个「删除」——那等于替用户选了「收入也一起删」；
  assert.equal(sheetButtons('删除').length, 0, '有收入账时不能给一个不问就删的按钮');
  assert.equal(sheetButtons('连那笔收入一起删').length, 1);
  assert.equal(sheetButtons('只删报销单，留下收入').length, 1);
  //  ② 两个选项里不能有一个是强调色主按钮（btn-primary）——那在视觉上就是「默认选它」。
  assert.equal(findAll(sheetRoot(), n => n.classList.contains('btn-primary')).length, 0,
    '两个选择都不该被画成默认项');
  // 打开面板不能动库：钱还在、单还在。
  assert.equal((await db.getAll('txns')).length, 1, '只是打开面板，收入不该被动');
  assert.ok(await getReimbursement(r.id));

  await sheetButtons('只删报销单，留下收入')[0].click();
  await waitForAsync(async () => (await getReimbursement(r.id)) === null, '单子被删掉');

  assert.equal((await db.getAll('txns')).length, 1, '选「留下收入」就该留下那笔收入');
  assert.equal((await db.get('invoices', 'i1')).reimbursementId, null, '票回到待报销');
});

test('详情：移除一张票，合计跟着变小并落到库里', async () => {
  await mkInvoice('i1', 302500);
  await mkInvoice('i2', 55500);
  await mkDraft('待提交单', ['i1', 'i2']);

  await renderList();
  await openDetail('待提交单');
  assert.ok(findByText(document.body, '¥3580.00'), '前置：两张票的合计');

  await buttons('移除')[0].click();

  // onclick 里 await 了写库，所以 click 返回时库里已经改完了；屏幕上的重绘没被 await。
  await waitForAsync(async () => (await attachedInvoiceCount()) === 1, '库里只剩一张票还挂着');
  const left = (await db.getAll('invoices')).filter(i => i.reimbursementId);
  // 屏幕上的合计必须跟着变小——只改库不重绘的话，用户点完「移除」看到的是旧的合计。
  const remain = formatCents(left[0].amountCents, { symbol: true });
  await waitFor(() => findByText(document.body, remain) !== null, `合计变成剩下的 ${remain}`);
  assert.equal(findByText(document.body, '¥3580.00'), null, '旧合计不该留在屏幕上');
});

test('详情：移除失败时把中文错误写进错误行，而不是漏成 unhandled rejection', async () => {
  // 与下面「提交失败」那条是同一形状，但守的是**另一个**异步动作——这条是审查实测出来的空档：
  // 把「移除」那句 `.catch(fail)` 删掉，当时 12 条测试**全绿**。它的 rejection 没有任何人接
  // （onclick 的返回值在浏览器里没人 await），用户那头屏幕上什么都不会变、控制台里一条 unhandled。
  await mkInvoice('i1', 302500);
  await mkInvoice('i2', 55500);
  await mkDraft('待提交单', ['i1', 'i2']);

  await renderList();
  await openDetail('待提交单');

  const boom = new Error('磁盘满了');
  boom.name = 'QuotaExceededError';
  // 注入到 invoices 表：Remove 的落库在那一张（detachEntry）。
  const restore = failNextWrite('invoices', boom);
  const unhandled = [];
  const onUnhandled = reason => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    await buttons('移除')[0].click();
    await flush();
    // unhandledRejection 要等一轮事件循环结束才判定，多等一轮再断言（与下一条同理）。
    await flush();
  } finally {
    restore();
    process.off('unhandledRejection', onUnhandled);
  }

  // 两种写坏方式各自被这里的一条钉住：
  //  · `onclick: () => { removeInvoiceFrom(…).then(…) }`（没 return 也没 catch）→ unhandled 非空；
  //  · 链上少了 `.catch(fail)` → 桩的 click 会 await 监听器、直接把这个 rejection 抛出来（上面的 click 红）。
  //    浏览器里同一种写法表现为 unhandled rejection，两条路的结论一致：错误必须被接住并说出来。
  assert.deepEqual(unhandled.map(r => String(r)), [], '移除失败不能漏成 unhandled rejection');
  await waitFor(() => findByText(document.body, '存储空间') !== null, '错误提示');
  // 失败是原子的：票还在这一单里、合计也没变（与 store 的「一次批量写」纪律一致）。
  assert.equal(await attachedInvoiceCount(), 2, '写失败时票不该被移出这一单');
  assert.ok(findByText(document.body, '¥3580.00'), '合计不该变');
});

test('详情：提交失败时把中文错误显示出来，而不是漏成 unhandled rejection', async () => {
  // 这条守的是「异步动作不能有没人接的 rejection」：onclick 返回的 Promise 在浏览器里没人 await，
  // 漏出去就是控制台里一条 unhandled rejection，而用户那头**什么都没有**（settle-sheet 的审查
  // 在同一个形状上踩过：async 回调的 rejection 必须被接住）。
  await mkInvoice('i1', 302500);
  await mkDraft('待提交单', ['i1']);

  await renderList();
  await openDetail('待提交单');

  const boom = new Error('磁盘满了');
  boom.name = 'QuotaExceededError';
  const restore = failNextWrite('reimbursements', boom);
  const unhandled = [];
  const onUnhandled = reason => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    await button('提交给公司').click();
    await flush();
    // unhandledRejection 要等一轮事件循环结束才判定，多等一轮再断言，否则修好之后还会假红。
    await flush();
  } finally {
    restore();
    process.off('unhandledRejection', onUnhandled);
  }

  assert.deepEqual(unhandled.map(r => String(r)), [],
    '提交失败不能漏成 unhandled rejection');
  await waitFor(() => findByText(document.body, '存储空间') !== null, '错误提示');
  assert.ok(findByText(document.body, '待提交'), '写失败时状态不能变');
});
