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

async function render(id) {
  const renderers = { ledger: renderLedgerHome, stats: renderStats };
  const fn = renderers[id] || PLACEHOLDER[id] || renderers.ledger;
  // 单个视图失败不能拖垮整个外壳：视图渲染会 await store.*（依赖 IndexedDB），
  // 数据层一旦抛错，没有这个 try/catch 就是整页白屏、连 Tab 栏都点不到。
  try {
    await fn(view);
  } catch (err) {
    mount(view, el('div', { class: 'empty' }, ['页面加载失败：' + err.message]));
    console.error(err);
  }
  mount(app, view, renderTabBar(id));
}

// 注意：Service Worker 的注册放在任务 20（sw.js 到那时才存在），
// 现在注册只会对一个不存在的文件刷 404。
onChange(render);
