// 发票 Tab 的分段切换与多选（app/ui/invoice-view.js）的行为探针。
//
// 为什么这里能测这个文件：与 tests/reimburse-view.test.js 走的是同一条路——DOM 由
// tests/helpers/fake-dom.js 顶上、IndexedDB 由 tests/helpers/fake-browser.js 顶上，中间的
// invoice-store / reimburse-store 全是**真的**。所以下面断的是「点一下之后库里多了什么、
// 屏幕上写着什么」，不是 DOM 结构；一条断言都不该因为改样式而红。
//
// 只有三处用了类名，它们都是**仓里的显示约定**（换名字时两处一起换）：
//   · `seg-bar` / `seg`         —— 分段条，用来把「切段」这个动作喂进去；
//   · `inv-tools` / `inv-check` / `inv-item` / `is-checked` —— 多选的工具条、勾选框、被勾中的行；
//   · `reimburse-bar`           —— 底部操作条（金额与按钮都在这块里）；
//   · `sheet-overlay` / `reimb-card` —— 面板容器与报销单卡片（与 reimburse-view.test.js 同源）。
//
// **这里测的终点是「行为」，不是「视觉」**：勾中那一行有没有变蓝、勾选框画得对不对，桩里
// 没有 CSS，验不了（见 fake-dom.js 文件头第 1 条）。能在 Node 里验的是：进了多选之后筛选跳到哪、
// 底部那个数是不是两张之和、按下去之后库里多了哪几条记录。
//
// 另外两处桩自己的语义偏差（fake-dom.js 文件头第 3 条）：`checkbox.click()` 不切换 checked、
// 也不派发 change——本文件里没有 checkbox，只有整行可点的按钮，因此不受影响；`style` 相关的
// 断言做不了，所以下面一条都没碰 style。
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeBrowser } from './helpers/fake-browser.js';
import {
  installFakeDom, resetFakeDom, findAll, findByText, fireEvent
} from './helpers/fake-dom.js';
import * as db from '../app/db.js';
import { STORES } from '../app/schema.js';
import { el } from '../app/ui/dom.js';
import { saveInvoice } from '../app/invoice-store.js';
import { createReimbursement } from '../app/reimburse-store.js';
import { renderInvoices } from '../app/ui/invoice-view.js';
import { openReimbursement } from '../app/ui/reimburse-view.js';

installFakeBrowser();
installFakeDom();
// app/router.js 的 currentTab() 读的是**裸全局** location（不是 window.location），
// 而本视图每次渲染都拿它做「还是发票 Tab 吗」的守卫。不装上就是 ReferenceError。
globalThis.location = { hash: '#/invoice' };

const NOW = 1700000000000;

async function clearAll() {
  await db.replaceAllRecords({ clears: Object.keys(STORES), puts: [] });
}

// IndexedDB 桩的每个请求都在 setTimeout(0) 上（fake-browser.js 的 settledRequest），而一次渲染
// 要串好几个 await。**不能用 setImmediate**：它跑在 check 阶段、连跑几十次也花不到 1ms，而
// setTimeout(0) 实际被 clamp 到 1ms——回合数写少一点就等于没推进（与 reimburse-view.test.js 同）。
const tick = () => new Promise(resolve => setTimeout(resolve, 1));

async function flush(rounds = 10) {
  for (let i = 0; i < rounds; i += 1) await tick();
}

// 等一个条件成立，而不是睡固定轮数：一次渲染的 await 轮数与数据量有关，写死轮数就是随机红。
async function waitFor(pred, label, rounds = 80) {
  for (let i = 0; i < rounds; i += 1) {
    if (pred()) return;
    await tick();
  }
  throw new Error(`等了 ${rounds} 轮，${label} 还没出现`);
}

// 判据本身要读库时用它（读库是异步的，而 waitFor 的判据是同步的）。
// 它比「睡 N 轮再断言」诚实：库还没写完就是等，而不是碰运气。
async function waitForAsync(pred, label, rounds = 80) {
  for (let i = 0; i < rounds; i += 1) {
    if (await pred()) return;
    await tick();
  }
  throw new Error(`等了 ${rounds} 轮，${label} 还没出现`);
}

// 被测视图挂在自己的容器上（真机里是 index.html 的 #view）。**不能直接挂 document.body**：
// sheet 也挂在 body 上，而 renderInvoices 每次都会 mount 自己的 root——挂 body 的话，
// 「创建报销单」这类会触发重绘的流程会顺手把刚打开的面板清掉，那是测试自己造出来的假象。
let view;

function buttonsIn(root, text) {
  return findAll(root, n => n.tagName === 'BUTTON' && n.textContent === text);
}

// 取一个**必须存在**的节点。写成 `null.click()` 的话，还没实现时红出来的是
// 「TypeError: Cannot read properties of null」——那是崩溃，说不清哪条断言没成立。
// 本文件照着「先看到断言级红」的纪律写，所以这一层不能省。
function need(node, label) {
  assert.ok(node, label);
  return node;
}

function button(text) {
  const hit = buttonsIn(view, text)[0];
  if (!hit) throw new Error(`视图里没有文本为「${text}」的按钮`);
  return hit;
}

// 分段条上的两个按钮。按文本取而不是按下标：换顺序时该红的是「切段不生效」，不是这条断言。
function segButton(text) {
  const bar = findAll(view, n => n.classList.contains('seg-bar'))[0];
  return bar ? (buttonsIn(bar, text)[0] ?? null) : null;
}

// 工具条上那个「选择 / 取消」按钮。
function toolButton(text) {
  const bar = findAll(view, n => n.classList.contains('inv-tools'))[0];
  return bar ? (buttonsIn(bar, text)[0] ?? null) : null;
}

// 筛选行里当前**选中**的那一个（按钮文本）。
function selectedFilter() {
  const bar = findAll(view, n => n.classList.contains('inv-filters'))[0];
  if (!bar) return null;
  const hit = findAll(bar, n => n.tagName === 'BUTTON' && n.getAttribute('aria-selected') === 'true')[0];
  return hit ? hit.textContent : null;
}

function filterButton(text) {
  const bar = findAll(view, n => n.classList.contains('inv-filters'))[0];
  if (!bar) throw new Error('屏幕上没有筛选行');
  const hit = buttonsIn(bar, text)[0];
  if (!hit) throw new Error(`筛选行里没有「${text}」`);
  return hit;
}

function items() {
  return findAll(view, n => n.classList.contains('inv-item'));
}

// 搜索框（本页只有一个）。它写的是 filter / keyword 之外那半个模块级状态——上一句 input 改到的
// keyword 会跟着模块活到下一个用例。
function searchBox() {
  return findAll(view, n => n.tagName === 'INPUT' && n.getAttribute('type') === 'search')[0] ?? null;
}

// 按金额取列表项：票的标题是销售方（两张票的 seller 可以相同），金额才是它们之间
// 一眼可分辨的那一项。每次点击之后 paint() 会重建整块列表，所以这个函数必须**每次重新查**。
function itemByAmount(text) {
  const hit = items().find(i => i.textContent.includes(text));
  if (!hit) throw new Error(`列表里没有金额为 ${text} 的那一行`);
  return hit;
}

function bar() {
  return findAll(view, n => n.classList.contains('reimburse-bar'))[0] ?? null;
}

function barButton() {
  const b = bar();
  return b ? (findAll(b, n => n.tagName === 'BUTTON')[0] ?? null) : null;
}

function sheetOverlay() {
  return findAll(document.body, n => n.classList.contains('sheet-overlay'))[0] ?? null;
}

function sheetButtons(text) {
  const overlay = sheetOverlay();
  if (!overlay) throw new Error('没有打开的面板');
  return buttonsIn(overlay, text);
}

function cards() {
  return findAll(view, n => n.classList.contains('reimb-card'));
}

function cardByTitle(title) {
  const hit = cards().find(c => c.textContent.includes(title));
  if (!hit) throw new Error(`报销单列表里没有标题含「${title}」的卡片`);
  return hit;
}

async function mkInvoice(id, amountCents, { seller = '某公司', archived = false } = {}) {
  await saveInvoice({ id, number: '', amountCents, issuedAt: NOW, seller, type: 'other', archived });
}

test.beforeEach(async () => {
  await clearAll();
  resetFakeDom();
  view = el('div', {});
  document.body.append(view);
  // 复位模块级的分段 / 多选状态。它们是**故意**留在模块里的（切走再回来不该被重置），
  // 于是也会跨用例残留——这里用**真实分支**复位：分段条上那个「发票」按钮的语义就是
  // 「回到普通发票列表」（清多选、清加票目标），而不是给生产代码开一个只有测试用的 reset 口子。
  await renderInvoices(view);
  // 先看它在不在，再点：这段复位跑在每个用例之前，而它依赖的正是本任务要新增的东西。
  // 写成无条件的 waitFor 的话，实现之前八条用例会一起卡死在 setup 上——那时红的不是断言、
  // 而是 setup 崩溃，正好绕开了「先看到断言级红」这条纪律。
  if (segButton('发票')) {
    await segButton('发票').click();
    await flush();
  }
  // filter 也是**故意**留在模块级的状态（切走再回来不该被重置），于是同样会跨用例残留：
  // 第 3 条「默认筛选是全部」今天成立只因为它最先跑，将来谁在前面插一条用例，那条断言就会在
  // 一个与被测行为无关的地方变红（而它读起来像是「默认值坏了」）。这里用**真实分支**复位：
  // 筛选按钮的 onclick 就是唯一写 filter 的地方，不给生产代码开一个只有测试用的 reset 口子。
  const filterRow = findAll(view, n => n.classList.contains('inv-filters'))[0];
  const allBtn = filterRow
    ? findAll(filterRow, n => n.tagName === 'BUTTON' && n.textContent === '全部')[0]
    : null;
  // 只在真的不在「全部」上时才点：多点一次会多触发一次 paint()，而 paint 里那几批缩略图读库
  // 在桩上不便宜（一次全量跑几十秒，见文件头的 tick 说明）。
  if (allBtn && allBtn.getAttribute('aria-selected') !== 'true') {
    await allBtn.click();
    await flush();
  }
  // keyword 同病同治：第 4 条会把搜索框设成一个匹配不到任何票的词，留着它，后面每条用例看到的
  // 都是一个空列表。写 keyword 的唯一入口就是搜索框的 input 处理函数，所以这也是走真实分支。
  const box = searchBox();
  if (box && box.value) {
    box.value = '';
    await fireEvent(box, 'input');
    await flush();
  }
});

test('分段：切到「报销单」画出报销单列表，切回「发票」回到发票列表', async () => {
  await mkInvoice('i1', 100000);
  await createReimbursement({ invoiceIds: ['i1'], title: '九月报销', now: NOW });

  await renderInvoices(view);
  assert.ok(toolButton('选择'), '默认停在发票段（工具条在）');
  assert.equal(findByText(view, '九月报销'), null, '发票段不该出现报销单');

  await need(segButton('报销单'), '分段条上要有「报销单」这个按钮').click();
  await waitFor(() => findByText(view, '九月报销') !== null, '报销单列表里的那张单');

  await need(segButton('发票'), '分段条上要有「发票」这个按钮').click();
  await waitFor(() => toolButton('选择') !== null, '回到发票段');
  assert.equal(findByText(view, '九月报销'), null, '切回发票段后不该还留着报销单的内容');
});

test('分段：切到报销单段之后，重新渲染仍停在报销单段（状态是模块级的）', async () => {
  await mkInvoice('i1', 100000);
  await createReimbursement({ invoiceIds: ['i1'], title: '九月报销', now: NOW });

  await renderInvoices(view);
  await need(segButton('报销单'), '分段条上要有「报销单」这个按钮').click();
  await waitFor(() => findByText(view, '九月报销') !== null, '报销单列表');

  // 切到别的 Tab 再切回来时，main.js 会**重新调一次** renderInvoices（同一个分段状态被复用）。
  // 少了这条，实现如果把 segment 写成 renderInvoices 里的局部变量，用户每次切回来都会被打回发票段。
  await renderInvoices(view);
  await waitFor(() => findByText(view, '九月报销') !== null, '重渲染后仍在报销单段');
  assert.equal(toolButton('选择'), null, '报销单段不该出现发票段的工具条');
});

test('多选：点「选择」进多选，筛选跳到「待报销」，列表项带勾选框', async () => {
  await mkInvoice('i1', 100000);
  await mkInvoice('i2', 202500);

  await renderInvoices(view);
  assert.equal(selectedFilter(), '全部', '前置：默认筛选是「全部」');
  assert.equal(findAll(view, n => n.classList.contains('inv-check')).length, 0,
    '没进多选时列表项上不该有勾选框');
  assert.equal(items().length, 2, '前置：两张票都在屏幕上');

  await need(toolButton('选择'), '工具条上要有「选择」').click();
  await waitFor(() => toolButton('取消') !== null, '「选择」变成「取消」');
  await waitFor(() => findAll(view, n => n.classList.contains('inv-check')).length === 2, '两个勾选框');

  // 进多选时筛选要自动跳到「待报销」：否则用户可能把已经报出去的票又选进来，而那种票会被
  // createReimbursement 跳过——他白选一场还不知道为什么。
  assert.equal(selectedFilter(), '待报销', '进多选时筛选自动跳到「待报销」');
});

test('多选：勾两张底部条金额是两张之和，取消一张数字跟着变', async () => {
  await mkInvoice('i1', 100000);
  await mkInvoice('i2', 202500);

  await renderInvoices(view);
  await need(toolButton('选择'), '工具条上要有「选择」').click();
  await waitFor(() => toolButton('取消') !== null, '进入多选');

  await itemByAmount('¥1000.00').click();
  await waitFor(() => bar() !== null, '底部操作条');
  assert.ok(bar().textContent.includes('¥1000.00'),
    `只勾一张时底部条应是 ¥1000.00，实际是「${bar().textContent}」`);
  assert.ok(items().find(i => i.textContent.includes('¥1000.00')).classList.contains('is-checked'),
    '被勾中的那一行要带上勾选态');

  await itemByAmount('¥2025.00').click();
  // 断的是**那个数**：100000 + 202500 = 302500 分 → ¥3025.00。
  // 写成「底部条里有金额」是不够的——只勾一张时的 ¥1000.00 也满足，那种断言分不出合计有没有算。
  await waitFor(() => bar().textContent.includes('¥3025.00'),
    '两张之和 ¥3025.00 出现在底部条上');

  await itemByAmount('¥2025.00').click();
  await waitFor(() => bar().textContent.includes('¥1000.00') && !bar().textContent.includes('¥3025.00'),
    '取消一张之后合计跟着变小');
  assert.ok(bar().textContent.includes('已选 1 张'), '张数也要跟着变');

  // 空结果分支也必须重画操作条（paint() 里那个 `if (rows.length === 0)` 分支自己调了一次 paintBar）。
  // 真实后果：用户勾着一张票、又把搜索词改成一个匹配不到的词 → 列表空了，条也跟着消失，
  // 他看到的是「已选 0 张」的假象，还会以为刚才的勾选丢了（勾选其实还在 selecting 里）。
  // 这段是补的：把那个分支里的 paintBar() 注释掉时，本文件其余断言全绿——真空白。
  const box = need(searchBox(), '发票页要有一个搜索框');
  box.value = '一个匹配不到任何票的词';
  await fireEvent(box, 'input');
  await waitFor(() => findByText(view, '没有符合条件的发票') !== null, '空结果的空态文案');
  assert.ok(bar() !== null, '列表被筛空之后，底部操作条不该跟着消失');
  assert.ok(bar().textContent.includes('已选 1 张 · ¥1000.00'),
    `筛掉的是屏幕上的行，不是用户已经勾中的票——条上仍该写着「已选 1 张 · ¥1000.00」，实际是「${bar().textContent}」`);

  // 再切走再切回来：main.js 会重新调一次 renderInvoices，而那一次是**新建的 barBox 空节点**，
  // 所以「列表空 + 还勾着 1 张」这个组合下，条只能由空结果分支那次 paintBar() 画出来。
  // **咬住变异的是这两条**，不是上面那两条：同一次渲染里条还挂在 barBox 上、内容也正好是对的，
  // 把那句 paintBar() 注释掉它们照样绿（实测过）。少了这一次重画，用户回到发票页看到的是一片
  // 空列表、连「已选 1 张」的痕迹都没有，只会以为自己的勾选丢了。
  await renderInvoices(view);
  await waitFor(() => findByText(view, '没有符合条件的发票') !== null, '重渲染之后列表仍是空的');
  assert.ok(bar() !== null, '重渲染之后底部操作条必须还在（空结果分支自己重画它）');
  assert.ok(bar().textContent.includes('已选 1 张 · ¥1000.00'),
    `重渲染之后条上的数也要在，实际是「${bar().textContent}」`);
});

test('多选：已在报销单里、以及「仅存档」的票点不动（不改变选中集合）', async () => {
  await mkInvoice('i1', 100000);                       // 可选
  await mkInvoice('i2', 202500);                       // 已经在另一张单里
  await mkInvoice('i3', 55500, { archived: true });    // 仅存档

  await createReimbursement({ invoiceIds: ['i2'], title: '已有的单', now: NOW });

  await renderInvoices(view);
  await need(toolButton('选择'), '工具条上要有「选择」').click();
  await waitFor(() => toolButton('取消') !== null, '进入多选');
  // 进多选后筛选是「待报销」，那两张本来就不在这个筛选里——这正是第一道保护。
  assert.equal(items().length, 1, '「待报销」里只该有那一张可选');

  await itemByAmount('¥1000.00').click();
  await waitFor(() => bar()?.textContent.includes('¥1000.00') === true, '选中一张');

  // 切回「全部」把它们露出来再点：路径②（列表上真的看得到它们）比「它们恰好被筛掉」更值得钉，
  // 因为用户完全可能先切筛选再点——那时拦住他的必须是 onclick 里的守卫，不是筛选。
  await filterButton('全部').click();
  await waitFor(() => items().length === 3, '三张票都在屏幕上');

  await itemByAmount('¥2025.00').click();
  await itemByAmount('¥555.00').click();
  await flush();

  // 两张都点不动：金额与张数一个都不该变。已在单里的票会被 createReimbursement / addInvoicesTo
  // 跳过（白选一场），仅存档的票会直接抛错（界面给了他一个不该给的选择）。
  assert.ok(bar().textContent.includes('已选 1 张 · ¥1000.00'),
    `选中集合不该被它们改动，实际底部条是「${bar().textContent}」`);
  assert.equal(findAll(view, n => n.classList.contains('is-checked')).length, 1,
    '屏幕上只该有一行是勾选态');
});

test('多选：勾上之后票在别处被设成「仅存档」——仍然取消得掉', async () => {
  await mkInvoice('i1', 100000);
  await mkInvoice('i2', 202500);

  await renderInvoices(view);
  await need(toolButton('选择'), '工具条上要有「选择」').click();
  await waitFor(() => toolButton('取消') !== null, '进入多选');
  await itemByAmount('¥1000.00').click();
  await waitFor(() => bar()?.textContent.includes('已选 1 张') === true, '先把它勾上');

  // 勾上之后它在别处被标成「仅存档」。**只改库不够**：列表里的那几行是上一次渲染的快照
  // （`all` 数组），所以这里要重新渲染一次——这正是真机上的顺序：另一个标签页改了这张票，
  // 用户切回来，main.js 会重新调 renderInvoices，而多选态是模块级的、活得比那次渲染长。
  await mkInvoice('i1', 100000, { archived: true });
  await renderInvoices(view);
  await waitFor(() => toolButton('取消') !== null, '重渲染之后仍在多选态');

  // 进多选时筛选自动跳到「待报销」，仅存档的票不在那一档里——切到「全部」把它露出来。
  // 真机上用户完全会这么做：他要去找自己刚才勾中的那一张。
  await filterButton('全部').click();
  await waitFor(() => items().length === 2, '两张票都在屏幕上');

  // 守卫若写成 `if (inv.reimbursementId || inv.archived) return;`，这一张就**既加不进也取消不掉**：
  // 它还在选中集合里、底部条还按它算钱，用户只剩「取消多选」一条出口（那会把整批勾选都退掉）。
  // 这一条钉住的是守卫里 `!checked &&` 那一半。
  await itemByAmount('¥1000.00').click();
  await waitFor(() => bar() === null, '取消勾选之后底部操作条消失（选中集合空了）');
  assert.equal(findAll(view, n => n.classList.contains('is-checked')).length, 0,
    '屏幕上不该还有勾选态的行');
});

test('多选：点「发起报销」→ 面板改名 → 真的落库，标题用的是输入框里的值', async () => {
  await mkInvoice('i1', 100000);
  await mkInvoice('i2', 202500);

  await renderInvoices(view);
  await need(toolButton('选择'), '工具条上要有「选择」').click();
  await waitFor(() => toolButton('取消') !== null, '进入多选');
  await itemByAmount('¥1000.00').click();
  await itemByAmount('¥2025.00').click();
  await waitFor(() => bar()?.textContent.includes('¥3025.00') === true, '底部条出现合计');

  await need(barButton(), '底部操作条上要有一个按钮').click();
  await waitFor(() => sheetOverlay() !== null, '确认面板');

  const input = findAll(sheetOverlay(), n => n.tagName === 'INPUT')[0];
  assert.ok(input, '面板里要有一个标题输入框');
  // 默认标题来自 autoTitle，用**本地时间**取月份：写成 /^\d+月报销 · 2 张$/ 而不是钉死「11月」，
  // 否则换一台机器（或换时区）就红，而代码是对的（reimburse-view.test.js 的日期那条同理）。
  assert.match(input.value, /^\d+月报销 · 2 张$/, `默认标题应是自动生成的，实际「${input.value}」`);

  input.value = '九月打车报销';
  await sheetButtons('创建报销单')[0].click();

  await waitForAsync(async () => (await db.getAll('reimbursements')).length === 1, '报销单落到库里');
  const all = await db.getAll('reimbursements');
  assert.equal(all[0].title, '九月打车报销', '标题必须用输入框里的那个值，不是自动生成的那句');
  const invs = await db.getAll('invoices');
  assert.deepEqual(
    invs.filter(i => i.reimbursementId === all[0].id).map(i => i.id).sort(),
    ['i1', 'i2'],
    '勾中的两张票要真的挂进这一单'
  );

  // 建完停在那一单的详情：用户刚做完一件事，应该看到它的结果，而不是回到列表里自己找。
  await waitFor(() => view.textContent.includes('九月打车报销')
    && findAll(view, n => n.tagName === 'BUTTON' && n.textContent === '← 报销单').length === 1,
  '创建之后停在新建那一单的详情');
});

test('加票：从详情页进多选，底部条写目标单标题、按下去票真的进了那一单', async () => {
  // **这里必须有第二张单（A）**：只建一张单时，「加完停回那一单的详情」这条断言是**碰巧**通过的
  // ——用户本来就是从那一单的详情点进来的，openId 早就是它了，把终点写坏也照样绿。
  // 有了 A 做对照，下面那条「屏幕上不该有 A 的标题」才真的有牙。
  await mkInvoice('a1', 100000);
  await createReimbursement({ invoiceIds: ['a1'], title: '八月报销', now: NOW - 1000 });
  await mkInvoice('b0', 30000);
  const { reimb } = await createReimbursement({ invoiceIds: ['b0'], title: '九月报销', now: NOW });
  await mkInvoice('b1', 202500);
  await mkInvoice('b2', 55500);

  await renderInvoices(view);
  await need(segButton('报销单'), '分段条上要有「报销单」这个按钮').click();
  await waitFor(() => findByText(view, '八月报销') !== null && findByText(view, '九月报销') !== null,
    '报销单列表');
  await cardByTitle('九月报销').click();
  await waitFor(() => buttonsIn(view, '← 报销单').length === 1, '报销单详情页');
  // 前置断言：此刻在 **B**（九月报销）的详情里。少了它，下面「停在 B」在一个把票加进 A 的
  // 实现上也是绿的（那样屏幕上会写着「八月报销」，而 user 以为自己加的是九月那一单）。
  assert.equal(findByText(view, '八月报销'), null, '前置条件：进来的必须是九月那一单，不是八月那单');

  // 详情页的「加票」：它调的是 onSwitchToInvoices?.({ startSelecting: true, targetId: id })，
  // 也就是跨文件契约的另一半——少了这个按钮，addInvoicesTo 在用户那一侧根本不存在。
  await button('加票').click();
  await waitFor(() => toolButton('取消') !== null, '回到发票段且进了多选');
  assert.equal(selectedFilter(), '待报销', '加票也走「待报销」筛选');

  await itemByAmount('¥2025.00').click();
  await itemByAmount('¥555.00').click();
  await waitFor(() => barButton()?.textContent === '加到「九月报销」',
    '底部条的按钮要说清它往哪加');
  assert.ok(bar().textContent.includes('九月报销'), '底部条上要有目标单的标题');

  await need(barButton(), '底部操作条上要有一个按钮').click();
  await waitForAsync(async () => {
    const b1 = await db.get('invoices', 'b1');
    const b2 = await db.get('invoices', 'b2');
    return b1?.reimbursementId === reimb.id && b2?.reimbursementId === reimb.id;
  }, '两张票进了那一单');
  // 加完停回**那一单**的详情（不是列表、也不是新建一张单）。
  await waitFor(() => view.textContent.includes('九月报销')
    && buttonsIn(view, '← 报销单').length === 1, '加完停在目标单的详情');
  assert.equal(findByText(view, '八月报销'), null, '终点是九月那一单，不是列表里的另一张单');
  assert.equal((await db.getAll('reimbursements')).length, 2, '加票不该顺手建出新单');
});

test('加票：勾的票在别处进了别的单时，把话说清楚并把那张从勾选里摘掉', async () => {
  await mkInvoice('a1', 100000);
  await createReimbursement({ invoiceIds: ['a1'], title: '八月报销', now: NOW - 1000 });
  await mkInvoice('b0', 30000);
  const { reimb } = await createReimbursement({ invoiceIds: ['b0'], title: '九月报销', now: NOW });
  await mkInvoice('b1', 202500);
  await mkInvoice('b2', 55500);

  await renderInvoices(view);
  await need(segButton('报销单'), '分段条上要有「报销单」这个按钮').click();
  await waitFor(() => findByText(view, '八月报销') !== null && findByText(view, '九月报销') !== null,
    '报销单列表');
  await cardByTitle('九月报销').click();
  await waitFor(() => buttonsIn(view, '← 报销单').length === 1, '报销单详情页');
  assert.equal(findByText(view, '八月报销'), null, '前置条件：进来的是九月那一单');
  await button('加票').click();
  await waitFor(() => toolButton('取消') !== null, '回到发票段且进了多选');

  await itemByAmount('¥2025.00').click();
  await itemByAmount('¥555.00').click();
  await waitFor(() => barButton()?.textContent === '加到「九月报销」', '底部条上出现目标单的标题');

  // 勾完之后、按按钮之前，其中一张在别处（另一个标签页）进了**另一张**单：addInvoicesTo 会把它跳过
  // （规格 §6.4）。界面必须把这件事说出来，而且**不能让那张继续勾着**——留着它，用户再点一次
  // 还是被跳过，他只会以为按钮坏了，而真正的原因是那张票已经不归这一单了。
  const { reimb: other } = await createReimbursement({ invoiceIds: ['b2'], title: '别人的单', now: NOW });

  await need(barButton(), '底部操作条上要有一个按钮').click();
  await waitFor(() => bar()?.textContent.includes('别的报销单') === true, '底部条上那句提示');

  assert.ok(bar().textContent.includes('有 1 张已经进了别的报销单，这次没加进去。'),
    `提示要说清是几张、以及为什么没加进去，实际是「${bar().textContent}」`);
  // 张数要缩到 1：被跳过的 b2（¥555.00）从选中集合里摘掉，只剩 b1（¥2025.00）。
  // 只断「提示出现了」是不够的——那句话在「两张都还勾着」的实现里照样会出现。
  assert.ok(bar().textContent.includes('已选 1 张 · ¥2025.00'),
    `被跳过的票要从勾选里摘掉，实际底部条是「${bar().textContent}」`);

  // 加票是**部分成功**：能加的那张（b1）真的进了这一单，被跳过的那张（b2）不进——`skipped`
  // 说的是「哪几张没进来」，不是「整批都没动」。这两条把上面那句提示的语义钉死：
  // 不然「一张都没加进去」的实现也会让那句话出现（用户看到的解释与事实不符）。
  assert.equal((await db.get('invoices', 'b1')).reimbursementId, reimb.id, '没被跳过的那张确实进了这一单');
  assert.equal((await db.get('invoices', 'b2')).reimbursementId, other.id, '被跳过的那张留在别人那张单里');
  // 停在原地：没有跳去详情页（用户改一改再点一次就行）。
  await waitFor(() => toolButton('取消') !== null && findAll(view, n => n.classList.contains('is-checked')).length === 1,
    '留在多选态，只勾着还能加的那一张');
});

test('跨文件契约：报销单空状态的「去发票里选几张」真的会让人进入多选', async () => {
  await mkInvoice('i1', 100000);

  await renderInvoices(view);
  await need(segButton('报销单'), '分段条上要有「报销单」这个按钮').click();
  await waitFor(() => findByText(view, '还没有报销单') !== null, '报销单的空状态');

  // 这条钉的是 onSwitchToInvoices 的**参数形状与收参数**：任务 8 那一侧写的是
  // `onSwitchToInvoices?.({ startSelecting: true })`，而把回调写成无参箭头函数不会报错、
  // 只会让用户点完「去发票里选几张」之后停在普通发票列表上（按钮说了谎）。
  await button('去发票里选几张').click();
  await waitFor(() => toolButton('取消') !== null, '回到发票段并进了多选');
  assert.equal(selectedFilter(), '待报销', '筛选要跟着跳到「待报销」');
  assert.equal(findAll(view, n => n.classList.contains('inv-check')).length, 1,
    '列表项上要出现勾选框（真的进了多选，不是只切了段）');
});

test('openReimbursement：屏幕停在列表时打开某一单，下一次渲染真的进它的详情', async () => {
  // 这条钉的是「发起报销」与「加票」两条路收尾时调用的那个导出（reimburse-view 的 openReimbursement）。
  // 把它写成空壳（不写 openId）**不会报错**，而上面那两条加票用例**抓不住它**：用户本来就是从
  // 某一单的详情点进加票的，openId 早就是那一单了，屏幕照样停在它身上。所以这里刻意从**列表**
  // 出发——openId 为 null 时调用它，屏幕必须变成那一单的详情；空壳实现会留在列表上，这条立刻红。
  await mkInvoice('a1', 100000);
  await createReimbursement({ invoiceIds: ['a1'], title: '八月报销', now: NOW - 1000 });
  await mkInvoice('b1', 202500);
  const { reimb: B } = await createReimbursement({ invoiceIds: ['b1'], title: '九月报销', now: NOW });

  await renderInvoices(view);
  await need(segButton('报销单'), '分段条上要有「报销单」这个按钮').click();
  await waitFor(() => buttonsIn(view, '← 报销单').length === 1 || cards().length > 0, '报销单那一段画出来');
  // 先确保自己站在**列表**上：openId 是 reimburse-view 的模块状态，会跨用例残留（这是有意的设计——
  // 切走再回来用户该还在那一单上），所以上一轮留下的详情页要先用返回按钮退掉。
  if (buttonsIn(view, '← 报销单').length === 1) {
    await buttonsIn(view, '← 报销单')[0].click();
  }
  await waitFor(() => cards().length === 2 && buttonsIn(view, '← 报销单').length === 0,
    '回到报销单列表（两张卡）');

  openReimbursement(B.id);
  await renderInvoices(view);
  await waitFor(() => buttonsIn(view, '← 报销单').length === 1, '被打开那一单的详情页');
  assert.ok(findByText(view, '九月报销') !== null, '打开的必须是传进去的那一单（B）');
  assert.equal(findByText(view, '八月报销'), null, '不该打开列表里的另一张单（A）');
  assert.equal(cards().length, 0, '进了详情页，屏幕上不该还留着列表卡片');
});
