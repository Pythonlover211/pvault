// 到账面板（app/ui/settle-sheet.js）的行为探针。
//
// 为什么这里能测 UI：面板的依赖全是可替换的——DOM 由 tests/helpers/fake-dom.js 顶上，
// IndexedDB 由 tests/helpers/fake-browser.js 顶上，中间的 store / reimburse-store 是**真的**。
// 所以下面断言的是全链路的行为（点了按钮之后库里多了什么），不是 DOM 结构：
// **一条断言都不该因为改了样式或挪了节点而红**。
//
// 建这个文件的原因是一次审查：删掉面板里的 `if (busy) return;` 与 `if (!accountId) createTxn = false;`
// 之后，全仓 355 条测试**全绿**——两个真问题（连点两次记出两笔收入、没有账户时记出一笔
// accountId:null 的收入）在原来的测试集里完全没有声音。文件里的第 2、3 条就是那两处。
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeBrowser, transactionCount, failNextWrite } from './helpers/fake-browser.js';
import {
  installFakeDom, resetFakeDom, setConfirmAnswer, fireEvent,
  findAll, findOne, findByText, topOf
} from './helpers/fake-dom.js';
import * as db from '../app/db.js';
import { STORES, seedAccounts, seedCategories } from '../app/schema.js';
import { saveInvoice } from '../app/invoice-store.js';
import {
  createReimbursement, submitReimbursement, getReimbursement
} from '../app/reimburse-store.js';
import { openSettleSheet } from '../app/ui/settle-sheet.js';

installFakeBrowser();
installFakeDom();

const NOW = 1700000000000;

async function clearAll() {
  await db.replaceAllRecords({ clears: Object.keys(STORES), puts: [] });
}

// IndexedDB 桩的每个请求都走 setTimeout(0)（见 fake-browser.js 的 settledRequest），
// 而面板的 build() 串了好几个 await，所以推进事件循环再断言。
// **不能用 setImmediate 代替 setTimeout**：setImmediate 跑在 check 阶段，连续几十次也花不到 1ms，
// 而 setTimeout(0) 实际被 clamp 到 1ms——结果是桩里的回调一次都没跑，断言看到的是空面板（假红）。
const tick = () => new Promise(resolve => setTimeout(resolve, 1));

async function flush(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) await tick();
}

// 等一个条件成立，比「睡固定轮数」少赌一点：面板的 build() 里有几个 await，
// 轮数写少了就是随机红，写多了每条测试白等。
async function waitFor(pred, label, rounds = 40) {
  for (let i = 0; i < rounds; i += 1) {
    if (pred()) return;
    await tick();
  }
  throw new Error(`等了 ${rounds} 轮，${label} 还没出现`);
}

// 账户用的**不是**列表里的第一个：这样「上次用的账户」这条默认值一旦静默退化成
// 「第一个账户」，测试立刻红（那个退化在屏幕上看不出来，只有多个账户时才发现）。
const LAST_ACCOUNT = 'acc-bank';

async function seedWorld({ accounts = true, refundArchived = false, lastAccountId = LAST_ACCOUNT } = {}) {
  // 一次 putAll 写完全部种子：桩里每次 put 都是「一个事务 + 一个定时器轮次」，
  // 十几条逐个写会让每条测试白等几百毫秒（而真实的首启动种子也是这么批量写的）。
  const entries = [];
  if (accounts) for (const a of seedAccounts()) entries.push({ store: 'accounts', value: a });
  for (const c of seedCategories()) {
    entries.push({ store: 'categories', value: refundArchived && c.id === 'cat-refund' ? { ...c, archived: true } : c });
  }
  if (lastAccountId) entries.push({ store: 'settings', value: { key: 'lastAccountId', value: lastAccountId } });
  await db.putAll(entries);
}

// 造一张已提交的报销单（到账面板只对已提交的单子开放）。
async function mkSubmittedReimb({ amountCents = 302500 } = {}) {
  await saveInvoice({
    id: 'i1', number: '', amountCents, issuedAt: NOW, seller: '某公司', type: 'other', archived: false
  });
  const { reimb } = await createReimbursement({ invoiceIds: ['i1'], title: '9月报销 · 1 张', now: NOW });
  await submitReimbursement(reimb.id, NOW);
  const invoices = await db.getAll('invoices');
  return { reimb: await getReimbursement(reimb.id), invoices };
}

function confirmButton() {
  return findByText(document.body, '确认到账');
}

function errorNode() {
  // 错误就用既有的 .form-error（与 entry-panel.js 同一个类）——这是仓里的显示约定，
  // 不是本测试对布局的假设：换个类名，两处一起换即可。
  return findAll(document.body, n => n.className === 'form-error' && n.tagName === 'DIV')[0] ?? null;
}

function errorText() {
  const node = errorNode();
  return node ? node.textContent : '';
}

function checkbox() {
  return findOne(document.body, n => n.tagName === 'INPUT' && n.type === 'checkbox', '「只标记到账」勾选框');
}

function selectFor(prefix) {
  const sel = findAll(document.body, n => n.tagName === 'SELECT')
    .find(s => s.options.some(o => o.value.startsWith(prefix)));
  if (!sel) throw new Error(`桩里找不到选项以「${prefix}」开头的下拉`);
  return sel;
}

// 按键盘上的某个键。用「按钮 + 文本完全相等」而不是 findByText：后者是 includes，
// 而屏幕上到处都是含「0」的文本（合计 ¥3,025.00 之类），撞上哪个全看节点深度。
function keypadKey(label) {
  return findOne(document.body, n => n.tagName === 'BUTTON' && n.textContent === label, `键盘上的「${label}」键`);
}

// 真实用户把金额清空就是一路按 ⌫：这么走一遍同时验了键盘 → 面板的连线（onChange 给的是 null）。
async function clearKeypad() {
  const back = findByText(document.body, '⌫');
  for (let i = 0; i < 12; i += 1) await back.click();
}

async function open({ reimb, invoices, onSettled } = {}) {
  openSettleSheet({ reimb, invoices, onSettled });
  await waitFor(() => findByText(document.body, '确认到账') !== null, '面板的「确认到账」按钮');
}

test.beforeEach(async () => { await clearAll(); resetFakeDom(); setConfirmAnswer(true); });

test('面板：三个默认值真的落到控件上，并原样记进库里', async () => {
  await seedWorld();
  const { reimb, invoices } = await mkSubmittedReimb({ amountCents: 302500 });
  await open({ reimb, invoices });

  assert.equal(selectFor('acc-').value, LAST_ACCOUNT, '账户默认取 settings.lastAccountId（读错 key 会静默退到第一个账户）');
  assert.equal(selectFor('cat-').value, 'cat-refund', '分类默认是「退款」');

  const before = transactionCount();
  const btn = confirmButton();
  await btn.click();
  await flush();
  assert.equal(transactionCount() - before, 1, '交易 + 报销单必须落在同一个事务里');

  const settled = await getReimbursement(reimb.id);
  assert.equal(settled.status, 'settled');
  // 金额这条**不能**只看键盘显示的数字：默认值是由 setFromCents 写进键盘、再由 onChange 回填的，
  // 落库值才是它真的生效了的证据（少一环就是一个静默的 0）。
  assert.equal(settled.settledCents, 302500, '金额默认值 = 发票合计');

  const txns = await db.getAll('txns');
  assert.equal(txns.length, 1);
  assert.equal(txns[0].amountCents, 302500);
  assert.equal(txns[0].accountId, LAST_ACCOUNT);
  assert.equal(txns[0].categoryId, 'cat-refund');
});

test('面板：连点两次「确认到账」只记出 1 笔收入', async () => {
  await seedWorld();
  const { reimb, invoices } = await mkSubmittedReimb();
  await open({ reimb, invoices });

  const btn = confirmButton();
  // 两次点击之间**故意不 await**：面板收起有 180ms 动画，那段时间按钮还在屏幕上、还能再点一下。
  await Promise.all([btn.click(), btn.click()]);
  await flush();

  assert.equal((await db.getAll('txns')).length, 1, 'busy 闸门必须在第一次点击时就把第二下挡住');
  assert.equal((await getReimbursement(reimb.id)).status, 'settled');
});

test('面板：一个账户都没有时不记收入、勾选框呈「已勾 + 禁用」', async () => {
  await seedWorld({ accounts: false, lastAccountId: null });
  const { reimb, invoices } = await mkSubmittedReimb();
  await open({ reimb, invoices });

  const check = checkbox();
  assert.equal(check.checked, true, '没有账户时本来就是「只标记到账」');
  assert.equal(check.disabled, true, '解开它会得到一笔没有账户的收入，所以禁用');

  await confirmButton().click();
  await flush();

  const settled = await getReimbursement(reimb.id);
  assert.equal(settled.status, 'settled');
  assert.equal(settled.accountId, null);
  assert.equal(settled.settledCents, 302500, '金额照样记下来：到账了多少钱与记不记账是两件事');
  assert.deepEqual(await db.getAll('txns'), [], '没有账户就不该凭空记出一笔 accountId:null 的收入');
});

test('面板：金额为空 + 记账 → 本地报「请输入到账金额」，一次写都不发起', async () => {
  await seedWorld();
  const { reimb, invoices } = await mkSubmittedReimb();
  await open({ reimb, invoices });
  await clearKeypad();

  const before = transactionCount();
  await confirmButton().click();
  await flush();

  assert.match(errorText(), /请输入到账金额/, '规格 §8 的原文提示，而不是 store 那句「到账金额不对，这次没记上」');
  assert.equal(transactionCount() - before, 0, '本地就该拦住，不该发起一次注定失败的写入');
  assert.equal((await getReimbursement(reimb.id)).status, 'submitted', '单子状态不能变');
  assert.deepEqual(await db.getAll('txns'), []);
});

test('面板：金额为空 + 只标记到账 → 落 settledCents: null（不是 0）', async () => {
  await seedWorld();
  const { reimb, invoices } = await mkSubmittedReimb();
  await open({ reimb, invoices });
  await clearKeypad();

  const check = checkbox();
  check.checked = true;
  await fireEvent(check, 'change');

  await confirmButton().click();
  await flush();

  const settled = await getReimbursement(reimb.id);
  assert.equal(settled.status, 'settled');
  // 这一条是审查抓到的真问题：折成 0 之后详情页会显示「实际到账 ¥0.00 / 差额 −¥3,025.00」，
  // 把「没填」写成了「公司给了 0 元」。
  assert.equal(settled.settledCents, null, '「没填」与「真的是 0 元」必须分开');
  assert.deepEqual(await db.getAll('txns'), [], '不记账这条路上没有交易');
});

test('面板：写入失败 → 显示中文错误，且按钮可以再点', async () => {
  await seedWorld();
  const { reimb, invoices } = await mkSubmittedReimb();
  await open({ reimb, invoices });

  const quota = new Error('the quota has been exceeded');
  quota.name = 'QuotaExceededError';
  const restore = failNextWrite('txns', quota);
  try {
    await confirmButton().click();
    await flush();
  } finally {
    restore();
  }

  assert.match(errorText(), /存储空间/, '存储异常必须被翻成人话（QuotaExceededError 的原样冒泡会直达屏幕）');
  assert.equal(confirmButton().disabled, false, '失败必须把闸门放回去，否则用户改完金额再点就没反应');
  assert.equal((await getReimbursement(reimb.id)).status, 'submitted', '写入失败时单子不能变成已到账');
});

test('面板：onSettled 抛错 → 不写进已经收起的面板，busy 也不回滚', async () => {
  await seedWorld();
  const { reimb, invoices } = await mkSubmittedReimb();
  // 调用方（未来的报销单详情页）重绘时抛错。它此刻**已经不是**本次操作的失败：
  // 钱记上了、单子也到账了，把它的错误写进面板只会让用户以为到账没成功。
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => { logged.push(args); };
  let btn = null;
  try {
    await open({ reimb, invoices, onSettled: () => { throw new Error('重绘炸了'); } });
    btn = confirmButton();
    await btn.click();
    await flush();
  } finally {
    console.error = originalError;
  }

  // 从面板的根看，而不是从 document.body 看：close() 之后 180ms 面板会被摘出去，
  // 只查 body 会得到一条永远是绿的断言（节点都找不着了）。
  assert.equal(findByText(topOf(btn), '重绘炸了'), null, '面板此刻已经收起，写进去用户根本看不到（照 invoice-editor.js 的口径）');
  assert.equal(btn.disabled, true, '成功路径的 busy 一律不恢复：单子已经到账了，按钮不该再是可点的样子');
  assert.equal((await db.getAll('txns')).length, 1, '重试也不该再记一笔');
  assert.equal((await getReimbursement(reimb.id)).status, 'settled');
  assert.ok(logged.length > 0, '错误不能静默丢掉，必须留痕（console.error）');
});

test('面板：onSettled 返回 Promise 且 rejection 时 → 不出现未捕获 rejection，busy 也不回滚', async () => {
  await seedWorld();
  const { reimb, invoices } = await mkSubmittedReimb();
  // 上面那条用的是**同步**回调，而任务 8 的真实调用点 `renderReimbursements` 是 async 函数、
  // 返回的是 Promise：只写同步 try/catch 的话它的 rejection 会漏成 unhandled rejection——
  // 那时候屏幕上什么都没有、控制台里也找不到「到账成功但刷新失败」这条线索。
  // 所以这条必须单独钉住：回调用例是 async 的，同步版本测不到这件事。
  const logged = [];
  const unhandled = [];
  const originalError = console.error;
  const onUnhandled = reason => { unhandled.push(reason); };
  console.error = (...args) => { logged.push(args); };
  // 装上监听器既是为了收集，也是为了让未处理的 rejection 停在这里、不去炸掉整个测试文件进程。
  process.on('unhandledRejection', onUnhandled);
  let btn = null;
  try {
    await open({ reimb, invoices, onSettled: async () => { throw new Error('异步重绘炸了'); } });
    btn = confirmButton();
    await btn.click();
    await flush();
    // unhandledRejection 是「一轮事件循环结束时还没人接」才判定的，多等一轮再断言，
    // 否则这条测试会在**修好之后**仍然因为判早了而假红。
    await flush();
  } finally {
    console.error = originalError;
    process.off('unhandledRejection', onUnhandled);
  }

  assert.deepEqual(unhandled.map(r => String(r)), [],
    'async 回调的 rejection 必须被面板接住——漏出去就是 unhandled rejection，用户那头什么都看不到');
  assert.equal(findByText(topOf(btn), '异步重绘炸了'), null, '面板此刻已经收起，写进去用户根本看不到');
  assert.equal(btn.disabled, true, '到账已经成功，busy 一律不恢复');
  assert.equal((await db.getAll('txns')).length, 1, '回调抛错不该让这笔收入消失');
  assert.equal((await getReimbursement(reimb.id)).status, 'settled');
  assert.ok(logged.length > 0, '错误不能静默丢掉，必须留痕（console.error）');
});

test('面板：金额显式为 0 走二次确认（0 是合法到账，不是「没填」）', async () => {
  await seedWorld();
  const { reimb, invoices } = await mkSubmittedReimb();
  // 公司拒报、一分没报回来时用户会真的输 0；这与「输入框空着」（null）是两件事，
  // 规格 §8 明写 0 是合法值、只多问一次。把面板那句判空写成 `!settledCents`
  // 就会把这条路静默变成「请输入到账金额」，下面这组断言是唯一会响的地方。

  // ① 取消：单子不该动
  setConfirmAnswer(false);
  await open({ reimb, invoices });
  await clearKeypad();
  await keypadKey('0').click();
  await confirmButton().click();
  await flush();

  assert.equal((await getReimbursement(reimb.id)).status, 'submitted', '取消确认时不能落库');
  assert.deepEqual(await db.getAll('txns'), [], '取消确认时不该记收入');
  assert.equal(confirmButton().disabled, false, '取消后闸门要放回去，用户能接着改金额');

  // ② 确认：落 0（不是 null，也不是「请输入到账金额」）
  resetFakeDom();
  setConfirmAnswer(true);
  await open({ reimb: await getReimbursement(reimb.id), invoices });
  await clearKeypad();
  await keypadKey('0').click();
  await confirmButton().click();
  await flush();

  const settled = await getReimbursement(reimb.id);
  assert.equal(settled.status, 'settled');
  assert.equal(settled.settledCents, 0, '0 是合法到账金额（公司拒报），不是「没填」');
  const txns = await db.getAll('txns');
  assert.equal(txns.length, 1);
  assert.equal(txns[0].amountCents, 0, '这笔收入的金额就是 0');
});

test('面板：cat-refund 被归档时，分类回退到「无分类」而不是静默记成工资', async () => {
  await seedWorld({ refundArchived: true });
  const { reimb, invoices } = await mkSubmittedReimb();
  await open({ reimb, invoices });

  const catSel = selectFor('cat-');
  // 显示与值必须一致：回退成 categories[0] 的话，下拉显示的是「工资」，
  // 于是到账会记成一笔工资收入——那是一个比「无分类」更错误的断言。
  assert.equal(catSel.value, '', '回退到 null 时下拉也该是空值那一项');
  assert.match(catSel.options.find(o => o.selected)?.textContent ?? '', /不选分类/, '空值项要有说明文字，不能是一片空白');

  await confirmButton().click();
  await flush();

  const txns = await db.getAll('txns');
  assert.equal(txns.length, 1);
  assert.equal(txns[0].categoryId, null, '回退到「无分类」，不是列表里的第一个（工资）');
});
