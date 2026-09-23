// 记账主页：本任务只保留最小实现（外壳 + 路由），真实内容由后续任务填充。
import { el, mount } from './dom.js';

export async function renderLedgerHome(root) {
  mount(root, el('div', { class: 'empty' }, ['记账主页将在后续任务实现']));
}
