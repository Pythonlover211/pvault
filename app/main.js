import { el, mount } from './ui/dom.js';
import { tabs, currentTab, go, onChange, hashQuery } from './router.js';
import { renderLedgerHome } from './ui/ledger-home.js';
import { renderInvoices } from './ui/invoice-view.js';
import { renderStats } from './ui/stats-view.js';
import { renderVault } from './ui/vault-view.js';
import { openEntryPanel, dueRecurringsToday } from './ui/entry-panel.js';
import * as store from './store.js';

const app = document.getElementById('app');
const view = el('main', { class: 'screen' });

function renderTabBar(active) {
  return el('nav', { class: 'tabbar' }, tabs().map(t =>
    el('button', {
      type: 'button',
      'aria-selected': String(t.id === active),
      onclick: () => go(t.id)
    }, [el('span', { class: 'tab-icon', text: t.icon }), el('span', { text: t.label })])
  ));
}

// 快速连点两个 Tab 会起两个并发渲染，先发起的那个未必先完成（统计页要查 6~12 个月数据，
// 比首页慢）。没有这个序号就是「后完成者决定界面」——界面与 Tab 高亮会停在统计页，
// 而 hash 已经是 #/ledger，且此后不会再有 hashchange，这个不一致不会自愈。
let renderSeq = 0;

async function render(id) {
  const seq = ++renderSeq;
  const renderers = { ledger: renderLedgerHome, invoice: renderInvoices, stats: renderStats, vault: renderVault };
  // 未注册的 Tab id 落到记账页，而不是抛 undefined is not a function。
  // （原来的 PLACEHOLDER 占位表在密码箱接上真实视图后就空了，已删掉。）
  const fn = renderers[id] || renderers.ledger;
  // 单个视图失败不能拖垮整个外壳：视图渲染会 await store.*（依赖 IndexedDB），
  // 数据层一旦抛错，没有这个 try/catch 就是整页白屏、连 Tab 栏都点不到。
  try {
    await fn(view);
  } catch (err) {
    mount(view, el('div', { class: 'empty' }, ['页面加载失败：' + (err?.message || err)]));
    console.error(err);
  }
  // 只有最后发起的那次渲染有权挂载，语义从「后完成者胜」改为「最后发起者胜」。
  if (seq !== renderSeq) return;
  mount(app, view, renderTabBar(id));
  // 角标跟着「今天待办」走，而待办会随记账变化，所以每次整页渲染后重算一次
  // （页面首次加载与每次切 Tab 都会走到这里；不 await，免得拖慢界面）。
  updateBadge();
}

// —— 桌面图标角标（Badging API）——

// 还款日是否落在「今天起 days 天内」（含今天）。跨月靠「本月的这一天已经过去就顺延到下个月」处理：
// 9 月 30 日看 dueDay=2 时，本月 2 号早已过去，真正要到的是 10 月 2 日（还有 2 天）；
// 若直接算 9 月 2 日 − 9 月 30 日会得到 −28 天，被当成「早就过期」，
// 角标会在每个月的最后几天整段失灵——而末尾几天恰恰是最接近还款日的。
function dueWithinDays(dueDay, days, now = Date.now()) {
  const day = Number(dueDay);
  // 账户表单把 billDay/dueDay 限制在 1~28，所以每个月都有这一天，new Date(y, m, day) 不会
  // 进位到下个月。越界（29~31 或垃圾值）直接判不成立，不去猜用户想表达什么。
  if (!Number.isInteger(day) || day < 1 || day > 28) return false;
  const t = new Date(now);
  const today = new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
  let due = new Date(t.getFullYear(), t.getMonth(), day).getTime();
  if (due < today) due = new Date(t.getFullYear(), t.getMonth() + 1, day).getTime();
  // 两端都是本地 0 点，差值本就是整天；用 round 而非 floor，规避理论上夏令时造成的 ±1 小时偏移。
  const diff = Math.round((due - today) / 86400000);
  return diff >= 0 && diff <= days;
}

// 今天待办 = 今天该记的固定支出 + 3 天内要还款的信用卡。
// 固定支出的判定复用录入面板里那份（dueRecurringsToday），不在这里重写一遍：
// 角标数字与面板顶部提示必须永远一致。
async function countDueToday(now = Date.now()) {
  const [recurring, categories, monthTxns, accounts] = await Promise.all([
    // 固定支出读失败兜成空数组，与录入面板里的处理一致：提示只是锦上添花，不能挡着记账。
    store.getSetting('recurring', []).catch(() => []),
    store.listAllCategories(),
    store.listTransactionsInMonths(1, now),
    store.listAccounts()
  ]);
  const dueRecurring = dueRecurringsToday(recurring, categories, monthTxns).length;
  const dueCredit = accounts.filter(a => a && a.kind === 'credit' && dueWithinDays(a.dueDay, 3, now)).length;
  return dueRecurring + dueCredit;
}

function updateBadge() {
  // iOS Safari / 桌面 Firefox 都没有这套 API：静默跳过，功能一个都不少（角标纯属加分项）。
  if (!('setAppBadge' in navigator)) return;
  countDueToday().then(n => {
    // 0 要显式清除：不然昨天的角标会一直挂在图标上，看起来像「还有一笔没记」。
    // clearAppBadge 在极老的实现里可能缺失，用可选调用兜住。
    const p = n > 0 ? navigator.setAppBadge(n) : navigator.clearAppBadge?.();
    // 失败只是角标没更新（未安装到桌面、系统不支持等），不该冒到控制台吓人。
    p?.catch?.(() => {});
  }).catch(err => console.error('角标更新失败', err));
}

// —— 「记一笔」桌面快捷方式 ——
// manifest.shortcuts 指向 ./index.html#/ledger?new=1，启动时若带 new=1 就直接打开录入面板。
function openFromShortcut() {
  // 用 hashQuery() 解析而不是 location.hash.includes('new=1')：后者对参数顺序变化
  // （#/ledger?from=shortcut&new=1）会失灵，对 new=10 这种前缀巧合又会误判。
  if (hashQuery().get('new') !== '1') return;
  // 清理必须放在打开面板**之前**，而且这两行之间不能有 await：
  // replaceState 不派发 hashchange，Tab 高亮与已完成的渲染都不受影响，而 URL 从此不带 new=1，
  // 用户此刻手动刷新不会又弹一次面板。若把清理挪到 openEntryPanel 之后，
  // 就会出现「面板已开始加载、URL 还挂着 new=1」的窗口，这期间刷新会再弹一次。
  history.replaceState(null, '', location.pathname + location.search + '#/ledger');
  openEntryPanel({ onSaved: () => render(currentTab()) });
}

// —— Service Worker ——
//
// 关于「首屏会不会多刷一次」的推演（任务 20a 要求逐条说明）：
// controllerchange 在首次安装时也会触发——activate 里的 clients.claim() 会接管当前页面。
// 按规范，这个事件是在「设置 controller」之后才派发的，所以回调执行时
// navigator.serviceWorker.controller **已经非空**，`!navigator.serviceWorker.controller`
// 拦不住首次安装，首屏会白白多刷一次（用户会看到闪一下）。
// 可靠的判据是「注册那一刻页面是否已经被 SW 控制」：hadController 为 false 就是首次安装，
// 此时页面本来就是刚从网络拿的最新代码，接管不需要刷新；为 true 才是「旧页面被新 SW 接管」，
// 这时刷一次才能把新版本的模块脚本换掉（已加载的 ES module 不会自动重取）。
// 所以这里在 register 之前把状态存进闭包。
// 安卓壳（本地打包版）里静态资源本来就在 APK 内，Service Worker 既没有意义、
// 又注册不上 —— 脚本由 Java 层的 shouldInterceptRequest 提供，SW 的脚本获取走不到
// 那条路径，注册必定失败并在控制台刷一条 error。靠壳盖在 UA 上的戳识别。
const IN_ANDROID_SHELL = /pvault-shell\//.test(navigator.userAgent);

if ('serviceWorker' in navigator && !IN_ANDROID_SHELL) {
  window.addEventListener('load', async () => {
    const hadController = !!navigator.serviceWorker.controller;
    let refreshing = false;
    // 监听放在 register 之前：首次安装时 controllerchange 可能来得很快，
    // 等 register() 的 promise resolve 之后再挂监听就有漏掉它的风险。
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      // refreshing 防止反复刷新；hadController 保证首次安装不刷。
      if (refreshing || !hadController) return;
      refreshing = true;
      location.reload();
    });
    try {
      const reg = await navigator.serviceWorker.register('./sw.js');
      // 主动查一次更新：sw.js 自身会被 HTTP 缓存，不 update 的话用户可能要到下次
      // 导航才发现有新版本（手机上「加到主屏」后很少真正重新导航）。
      reg.update?.();
    } catch (err) {
      console.error('Service Worker 注册失败', err);
    }
  });
}

onChange(render);
// 放在 onChange 之后：render 是异步的，先让它开始拉数据，再同步处理快捷方式入口。
openFromShortcut();
