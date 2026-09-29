// 发票编辑器里「仅存档」与报销单互斥（发票规格 §6.1）的行为探针。
//
// 为什么这个文件能测 app/ui/invoice-editor.js：与 tests/invoice-view.test.js 走的是同一条路——
// DOM 由 tests/helpers/fake-dom.js 顶上、IndexedDB 由 tests/helpers/fake-browser.js 顶上，
// 中间的 invoice-store / reimburse-store 全是**真的**。被测的 openInvoiceEditor 是导出，
// 它的依赖（image-store / download / keypad）在**模块体**里都不碰浏览器全局，所以能在 Node 里
// import（这一条是实测过的，不是猜的）。
//
// 断的是「点一下勾选框之后库里多了什么、勾选框回到什么状态、错误行写着什么」，不是 DOM 结构。
//
// 桩的语义偏差里有两条与这个文件直接相关，先写清楚：
//  1. `checkbox.click()` 在桩里**不切换 checked、也不派发 change**（fake-dom.js 文件头第 3 条）。
//     所以下面的每一步都显式写 `box.checked = true` 再 `fireEvent(box, 'change')`——
//     这两行合起来才等于真机上「用户点了一下勾选框」。
//  2. 桩没有样式，`style.display` 之类验不了、也不在这里验。
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeBrowser } from './helpers/fake-browser.js';
import {
  installFakeDom, resetFakeDom, findAll, fireEvent
} from './helpers/fake-dom.js';
import * as db from '../app/db.js';
import { STORES } from '../app/schema.js';
import { saveInvoice, getInvoice, findByNumber } from '../app/invoice-store.js';
import { createReimbursement, removeInvoiceFrom } from '../app/reimburse-store.js';
import { openInvoiceEditor } from '../app/ui/invoice-editor.js';

installFakeBrowser();
installFakeDom();

const NOW = 1700000000000;
// 给票一个非空号码有两个用处：① 保存路径会真的走一遍查重（号码为空时那条分支根本不跑）；
// ② 「编辑器把票读回来了没有」有一个能等的判据——下面的 waitFor 等就是这个号码出现在输入框里。
const NUMBER = '044001900111';

async function clearAll() {
  await db.replaceAllRecords({ clears: Object.keys(STORES), puts: [] });
}

// IndexedDB 桩的每个请求都在 setTimeout(0) 上（fake-browser.js 的 settledRequest），
// 而打开面板要串好几个 await（读发票、读流水、画预览）。**不能用 setImmediate**：它跑在 check 阶段，
// 连跑几十次也花不到 1ms，而 setTimeout(0) 实际被 clamp 到 1ms——回合数写少一点就等于没推进。
// （与 invoice-view.test.js / reimburse-view.test.js 同。）
const tick = () => new Promise(resolve => setTimeout(resolve, 1));

async function flush(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) await tick();
}

// 等一个同步条件成立，而不是睡固定轮数：一次渲染的 await 轮数与数据量有关，写死轮数就是随机红。
async function waitFor(pred, label, rounds = 80) {
  for (let i = 0; i < rounds; i += 1) {
    if (pred()) return;
    await tick();
  }
  throw new Error(`等了 ${rounds} 轮，${label} 还没出现`);
}

// 等一个**异步**条件成立（判据本身要读库）。与 waitFor 分开是因为它的判据是 await 出来的，
// 写死轮数去等库，红出来的时候说不清是「没发生」还是「库还没写完」（与 reimburse-view.test.js 同）。
async function waitForGone(getter, label, rounds = 80) {
  for (let i = 0; i < rounds; i += 1) {
    if (!(await getter())) return;
    await tick();
  }
  throw new Error(`等了 ${rounds} 轮，${label} 还没发生`);
}

// 取一个**必须存在**的节点。写成 `null.click()` 的话，还没实现时红出来的是
// 「TypeError: Cannot read properties of null」——那是崩溃，说不清哪条断言没成立。
function need(node, label) {
  assert.ok(node, label);
  return node;
}

// 面板取**最后一个** sheet-overlay：上一个用例被关掉的面板要等 180ms 才摘节点，
// 而用例开头只清 body 的子节点、不管各节点自己的 parentNode 引用，取第一个会撞上残留。
function panelRoot() {
  const all = findAll(document.body, n => n.classList.contains('sheet-overlay'));
  return need(all[all.length - 1], '屏幕上没有打开的面板');
}

function archivedCheckbox() {
  const hit = findAll(panelRoot(), n => n.tagName === 'INPUT' && n.type === 'checkbox')[0];
  return need(hit, '面板里没有「仅存档」勾选框');
}

// 面板里有**两个** .vault-error：顶部的通用错误行，和「仅存档」勾选框旁边那条互斥专用提示
// （为什么要两个：勾选框在面板靠下，顶部那条在手机上落在视野之外）。
// topErrorLine 取**顶部**那个（文档序里的第一个）；errorLine 取「屏幕上写着什么」的那一个
// ——既有用例关心的都是后者，没提示时两者都空，就退回第一个，让 `textContent === ''` 照常成立。
function topErrorLine() {
  const all = findAll(panelRoot(), n => n.classList.contains('vault-error'));
  return need(all[0], '面板里没有错误行');
}

function errorLine() {
  const all = findAll(panelRoot(), n => n.classList.contains('vault-error'));
  return all.find(n => n.textContent !== '') || topErrorLine();
}

// 就地提示节点：**紧跟在勾选框那一行（.vault-check）之后**的那个 .vault-error。
// 不用「第几个 .vault-error」定位——将来面板里多一个错误节点，按下标取就会悄悄指错人；
// 而「紧贴着勾选框」恰恰就是这条提示存在的**理由本身**，断它等于断需求。
// 桩没有 previousSibling（见 fake-dom.js 文件头：它不是 DOM 仿真器），自己从父节点的 childNodes 里找。
function archivedHintLine() {
  const afterCheckRow = n => {
    const siblings = n.parentNode?.childNodes ?? [];
    const i = siblings.indexOf(n);
    return i > 0 && siblings[i - 1].classList.contains('vault-check');
  };
  const hit = findAll(panelRoot(), n => n.classList.contains('vault-error') && afterCheckRow(n))[0];
  return need(hit, '勾选框旁边没有互斥提示节点');
}

function saveButton() {
  const hit = findAll(panelRoot(), n => n.tagName === 'BUTTON' && n.textContent === '保存')[0];
  return need(hit, '面板里没有「保存」按钮');
}

// 删除按钮：面板里唯一那个危险色按钮（`.btn-danger` 是仓里的显示约定，与「保存」的区分靠它）。
function deleteButton() {
  const hit = findAll(panelRoot(), n => n.tagName === 'BUTTON' && n.classList.contains('btn-danger'))[0];
  return need(hit, '面板里没有「删除这张发票」按钮');
}

// 删除确认态的就地提示：**紧跟在删除按钮之前**的那个 .vault-error。
// 与 archivedHintLine 同一立场——不按下标取（面板里已经有三个 .vault-error 了），
// 而「紧贴着删除按钮」恰恰就是这条提示存在的理由本身，断它等于断需求。
function deleteHintLine() {
  const beforeDeleteBtn = n => {
    const siblings = n.parentNode?.childNodes ?? [];
    const i = siblings.indexOf(n);
    return i >= 0 && i + 1 < siblings.length && siblings[i + 1].classList.contains('btn-danger');
  };
  const hit = findAll(panelRoot(), n => n.classList.contains('vault-error') && beforeDeleteBtn(n))[0];
  return need(hit, '删除按钮旁边没有提示节点');
}

async function mkInvoice(id, number = NUMBER) {
  await saveInvoice({
    id, number, amountCents: 300000, issuedAt: NOW, seller: '某公司', type: 'other', archived: false
  });
}

// 打开编辑器并等它把票读回来。判据是「关联账目」那一行从加载中变成结果——它是**最后**一段异步
// （load 读发票、回填控件 → loadTxns 读流水 → paintTxnField 写字），所以它落定时票一定已经读回来了。
// 依赖 `inv-link-status` 与「未关联」这两个**仓里的既有显示约定**（换文案时两处一起换）。
// 不用「睡几轮」：load 没走完时 state 还是空的，保存路径会拿一张空票去校验。
// onSavedCalls 用来区分「保存真的成功了」与「面板还挂在屏幕上没走」——
// sheet.close() 之后节点还要留 180ms，光看节点在不在分不出这两件事。
async function openEditorOn(id, onSavedCalls) {
  openInvoiceEditor({
    id,
    onSaved: onSavedCalls ? () => { onSavedCalls.push(id); } : undefined
  });
  await waitFor(
    () => findAll(document.body, n => n.classList.contains('inv-link-status'))
      .some(n => n.textContent === '未关联'),
    '编辑器读回发票与流水'
  );
  // 后面还有 paintPreview 一次异步收尾，让它跑完再开始操作。
  await flush();
}

async function typeNumber(value) {
  const input = findAll(panelRoot(), n => n.tagName === 'INPUT' && n.type === 'text'
    && n.getAttribute('placeholder') === '发票号码')[0];
  need(input, '面板里没有发票号码输入框');
  input.value = value;
  await fireEvent(input, 'input');
}

// 模拟用户「点了一下勾选框」：桩不会自己切换 checked，也不会派发 change（见文件头）。
async function clickCheckbox(box) {
  box.checked = true;
  await fireEvent(box, 'change');
}

test.beforeEach(async () => {
  await clearAll();
  resetFakeDom();
});

test('票在一张报销单里：勾「仅存档」被拒、勾选框弹回未勾、库里 archived 仍是 false', async () => {
  await mkInvoice('inv-linked');
  await createReimbursement({ invoiceIds: ['inv-linked'], title: '9月报销', now: NOW });
  await openEditorOn('inv-linked');

  const box = archivedCheckbox();
  assert.equal(box.checked, false, '这张票没标过仅存档，勾选框本来就该是未勾的');

  await clickCheckbox(box);

  assert.equal(box.checked, false, '票在报销单里时，勾选必须被弹回未勾');
  // 断在**就地**节点上（不是笼统的 errorLine）：这条互斥的文案必须落在勾选框旁边——用户被拒时
  // 目光正在这里，而顶部那条在手机上落在视野之外，他能看到的只有「勾选框自己弹了回去」。
  assert.match(archivedHintLine().textContent, /报销单/, '必须给一句中文说明，而不是静默弹回');
  assert.equal(topErrorLine().textContent, '', '同一句话不许同时写在面板的两头');
  const inv = await getInvoice('inv-linked');
  assert.equal(inv.archived, false, '被拒之后不许把 archived 写进库');
});

test('票不在任何单里：勾「仅存档」放行，保存后库里 archived === true', async () => {
  await mkInvoice('inv-free');
  const saved = [];
  await openEditorOn('inv-free', saved);

  const box = archivedCheckbox();
  await clickCheckbox(box);
  assert.equal(box.checked, true, '票不在单里，勾选应当保住');
  assert.equal(errorLine().textContent, '', '正常勾选不该留下错误文案');

  await saveButton().click();
  await waitFor(
    () => saved.length === 1, '保存成功回调（保存没落在库里就走不到这一步）'
  );
  const inv = await getInvoice('inv-free');
  assert.equal(inv.archived, true, '勾了仅存档并保存，库里那张票必须真的变成仅存档');
});

test('保存路径兜底：勾完之后票被塞进单里（onchange 时它还没在单里）→ 保存被拦、不落库', async () => {
  await mkInvoice('inv-race');
  const saved = [];
  await openEditorOn('inv-race', saved);

  // 勾的那一瞬间票确实不在任何单里，所以 onchange 放行——这正是要复现的竞态：
  // 用户勾完到点保存之间，另一个标签页把它加进了报销单。
  const box = archivedCheckbox();
  await clickCheckbox(box);
  assert.equal(box.checked, true);

  await createReimbursement({ invoiceIds: ['inv-race'], title: '9月报销', now: NOW });

  await saveButton().click();
  await flush(3);

  // 断言顺序是刻意的：先说「库里发生了什么」，最后才碰面板上的文案。保存被放进去了的那一版
  // 会顺手 sheet.close()，面板节点 180ms 后从 body 上摘掉——先读文案的话红出来的是
  // 「屏幕上没有打开的面板」这句崩溃式断言，而不是「票被错误地标成了仅存档」这个真问题。
  assert.deepEqual(saved, [], '被拦住的保存不该走到成功回调');
  const inv = await getInvoice('inv-race');
  assert.equal(inv.archived, false, '被拦住的保存不许把 archived 写进库');
  assert.match(archivedHintLine().textContent, /报销单/, '保存路径必须再拦一次并讲清楚原因');
  assert.equal(topErrorLine().textContent, '',
    '兜底拦的与勾选框是同一件事：用户在勾选框附近点保存，提示也得写在那里');
});

test('保存路径不误拦：票曾经在单里、后来被移出 → 勾仅存档 → 保存照常成功', async () => {
  await mkInvoice('inv-back');
  const { reimb } = await createReimbursement({ invoiceIds: ['inv-back'], title: '9月报销', now: NOW });
  await removeInvoiceFrom(reimb.id, 'inv-back');

  const saved = [];
  await openEditorOn('inv-back', saved);

  const box = archivedCheckbox();
  await clickCheckbox(box);
  assert.equal(box.checked, true, '票已经不在单里了，勾选该放行');
  assert.equal(errorLine().textContent, '');

  await saveButton().click();
  await waitFor(() => saved.length === 1, '保存成功回调');
  const inv = await getInvoice('inv-back');
  assert.equal(inv.archived, true, '移出报销单之后必须能标成仅存档');
});

test('兜底排在查重之前：同号票存在时，第一次点保存报的是互斥而不是查重', async () => {
  // 要让「查重的软提示」与「互斥的硬拦截」在同一张票上真的撞在一起，得保证 findByNumber
  // 命中的是**别人**：它只取索引命中里的第一条，而被编辑的这张如果号码也是 NUMBER，
  // 命中的可能是它自己（真机上索引按主键排序，谁在前是随机的）——那样查重分支根本不触发，
  // 下面那条顺序断言就成了一句空话。所以：库里的别人写 NUMBER，被编辑的这张**号码为空**
  // （空号码不进索引、不会命中自己），再在面板里把号码改成 NUMBER——正是用户「补扫一张
  // 已经录过的票」那条路。
  await mkInvoice('inv-dup-other', NUMBER);
  await mkInvoice('inv-dup-mine', '');

  const saved = [];
  await openEditorOn('inv-dup-mine', saved);
  await typeNumber(NUMBER);

  // 前置断言：查重这条分支确实会命中另一张票。它不成立的话，下面那条「先报互斥」就是在
  // 一个永远不会触发的分支上空转——绿得毫无意义。
  const dup = await findByNumber(NUMBER);
  assert.equal(dup?.id, 'inv-dup-other', '前置条件：查重必须真的命中另一张票');

  // 同样的竞态：勾的时候不在单里，勾完之后被加进单里。
  const box = archivedCheckbox();
  await clickCheckbox(box);
  await createReimbursement({ invoiceIds: ['inv-dup-mine'], title: '9月报销', now: NOW });

  await saveButton().click();
  await flush(3);

  // 互斥是**硬**拦截、查重是**软**提示。顺序反了的话，用户得先点一次看到查重提示、
  // 再点一次才被告知真正的问题——同一个按钮按两遍才说清一件事。
  // 同样先断言库、后断言文案（理由见上一条用例）。
  assert.deepEqual(saved, []);
  assert.equal((await getInvoice('inv-dup-mine')).archived, false, '被互斥拦下时不该存成仅存档');
  assert.match(archivedHintLine().textContent, /报销单/, '第一次点保存就该说互斥，而不是先说查重');
  assert.doesNotMatch(errorLine().textContent, /已经录过/, '硬拦截不该被软提示挡在前面');
});

test('先被拒、票被移出报销单后再勾一次：上一次的提示必须清空、archived 真落库', async () => {
  await mkInvoice('inv-retry');
  const { reimb } = await createReimbursement({ invoiceIds: ['inv-retry'], title: '9月报销', now: NOW });
  const saved = [];
  await openEditorOn('inv-retry', saved);

  const box = archivedCheckbox();
  await clickCheckbox(box);
  // 前置断言：第一次必须真的被拒、且提示**真的上了屏**。少这一条，下面那句「提示已清空」
  // 在一个从来没写过提示的分支上也是绿的——正是这条用例要防的那种假绿。
  assert.equal(box.checked, false, '前置条件：票在单里时第一次勾必须被弹回');
  assert.match(archivedHintLine().textContent, /报销单/, '前置条件：被拒时提示已经上屏');

  // 用户去另一个标签页（或报销单页）把这票移出报销单。面板里 state 那份副本仍是旧的，
  // 靠 onchange 现查库才看得到这个变化。
  await removeInvoiceFrom(reimb.id, 'inv-retry');

  await clickCheckbox(box);
  assert.equal(box.checked, true, '票已经不在单里了，这一次勾选该放行');
  assert.equal(archivedHintLine().textContent, '',
    '上一次被拒的提示必须清掉：它说的是上一次的事实，与此刻的成功状态正好相反');

  await saveButton().click();
  await waitFor(() => saved.length === 1, '保存成功回调');
  const inv = await getInvoice('inv-retry');
  assert.equal(inv.archived, true, '提示清空之后，这一次勾选必须真的能存进库');
});

test('删除确认：票在一张报销单里时，提示要带上那张单的标题并说清后果', async () => {
  await mkInvoice('inv-del');
  await createReimbursement({ invoiceIds: ['inv-del'], title: '9月报销', now: NOW });
  await openEditorOn('inv-del');

  // 面板刚打开、还没点删除：一个字都不该有（这一行挂在面板最底下，留着就是一条没有来由的提示）。
  assert.equal(deleteHintLine().textContent, '', '还没点删除时不该有任何提示');

  // 第一下只进确认态。规格 §8：删一张属于某单的票时界面要提示
  // 「这张票在「X 报销」里，删掉后那一单会少一张」——X 是那张单的标题，这句是**读到**的，
  // 不是界面自己编的（编的话用户根本不知道会牵动哪一张单）。
  await deleteButton().click();
  await waitFor(() => deleteHintLine().textContent !== '', '删除确认态的报销提示');
  assert.match(deleteHintLine().textContent, /9月报销/, '提示里要出现那张报销单的标题');
  assert.match(deleteHintLine().textContent, /少一张/, '要说清后果：那一单会少一张');
  assert.ok(await getInvoice('inv-del'), '第一下只是确认，不许真删');

  // 第二下才真删——提示不许把删除本身挡住。
  await deleteButton().click();
  await waitForGone(async () => db.get('invoices', 'inv-del'), '票从库里消失');
});

test('删除确认：读不到那张报销单时退回原文案，且删除照常能走完', async () => {
  await mkInvoice('inv-orphan');
  const { reimb } = await createReimbursement({ invoiceIds: ['inv-orphan'], title: '9月报销', now: NOW });
  // 造出「票还指着一张不存在的单」：把 reimbursements 表里那条记录删掉，票不动。
  // 老备份导入、手工改过的数据都可能长这样；而发票规格那条互斥保护恰恰允许这种票存在。
  await db.removeAll([{ store: 'reimbursements', key: reimb.id }]);
  assert.equal((await getInvoice('inv-orphan')).reimbursementId, reimb.id,
    '前置条件：票上仍留着指向已删单的 reimbursementId');

  await openEditorOn('inv-orphan');
  await deleteButton().click();
  await flush(3);

  // 这句提示是**附加信息**：读不到那张单就不写，绝不能因为它自己出问题把删除卡住
  // （删除是用户明确按了两次的动作，没有理由为一句提示失败）。
  assert.equal(deleteHintLine().textContent, '', '读不到那张单就不加这句提示');
  assert.equal(topErrorLine().textContent, '', '读库失败也不该把错误糊到面板顶上（这是正常的缺单，不是异常）');

  await deleteButton().click();
  await waitForGone(async () => db.get('invoices', 'inv-orphan'), '票照样被删掉');
});
