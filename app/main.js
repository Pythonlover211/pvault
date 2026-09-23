import { el, mount } from './ui/dom.js';
import { tabs, currentTab, go, onChange } from './router.js';
import { renderLedgerHome } from './ui/ledger-home.js';
import { renderStats } from './ui/stats-view.js';

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

const PLACEHOLDER = {
  vault: () => el('div', { class: 'empty' }, ['密码箱将在下一步实现'])
};

// 快速连点两个 Tab 会起两个并发渲染，先发起的那个未必先完成（统计页要查 6~12 个月数据，
// 比首页慢）。没有这个序号就是「后完成者决定界面」——界面与 Tab 高亮会停在统计页，
// 而 hash 已经是 #/ledger，且此后不会再有 hashchange，这个不一致不会自愈。
let renderSeq = 0;

async function render(id) {
  const seq = ++renderSeq;
  const renderers = { ledger: renderLedgerHome, stats: renderStats };
  const fn = renderers[id] || PLACEHOLDER[id] || renderers.ledger;
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
}

// 注意：Service Worker 的注册放在任务 20（sw.js 到那时才存在），
// 现在注册只会对一个不存在的文件刷 404。
onChange(render);
