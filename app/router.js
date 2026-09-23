// hash 路由：三个 Tab 各对应一个 hash（#/ledger、#/stats、#/vault）。
// 纯静态站点没有服务端改写，用 hash 是为了刷新后能停在同一 Tab，
// 也让手机上「加到主屏」后直接打开某个视图成为可能。
const TABS = [
  { id: 'ledger', label: '记账', icon: '📒' },
  { id: 'stats', label: '统计', icon: '📊' },
  { id: 'vault', label: '密码箱', icon: '🔒' }
];

export function tabs() {
  return TABS;
}

// 允许 hash 带 query（如 #/ledger?new=1，任务 20 的「记一笔」快捷入口），
// 先剥掉 ?query 再取第一段路径，否则 'ledger?new=1' 匹配不上任何 Tab、会被误判成非法路由。
export function currentTab() {
  const raw = location.hash.replace(/^#\/?/, '').split('?')[0];
  const id = raw.split('/')[0];
  return TABS.some(t => t.id === id) ? id : 'ledger';
}

// 供任务 20 判断是否要直接打开录入面板：('new=1') → searchParams.get('new') === '1'
export function hashQuery() {
  const q = location.hash.split('?')[1];
  return new URLSearchParams(q || '');
}

export function go(id) {
  location.hash = `#/${id}`;
}

export function onChange(handler) {
  window.addEventListener('hashchange', () => handler(currentTab()));
  handler(currentTab());
}
