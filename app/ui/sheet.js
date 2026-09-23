// 从底部滑出的半屏面板（设计规格 5.2）。
//
// 为什么是半屏而不是全屏：录入面板打开时，上半屏仍要能看到今天的流水，
// 方便一边记账一边核对刚记的账。所以面板贴底、最大高度 78vh，上半屏留给页面本身。
//
// 约定：
// - body 传入的是节点（调用方自己构造内容），会被塞进 `.sheet-body`；
// - onClose 在面板开始收起时同步触发，调用方据此判断「是否真的保存了」；
// - 返回 { close, panel, overlay }，调用方可以直接往 panel 里补内容（例如把
//   键盘挂到面板底部），也可以自己调 close()。
import { el } from './dom.js';

export function openSheet({ title, body, onClose }) {
  const overlay = el('div', {
    class: 'sheet-overlay',
    onclick: e => { if (e.target === overlay) close(); }
  });
  const panel = el('section', { class: 'sheet' }, [
    el('header', { class: 'sheet-head' }, [
      el('span', { text: title || '' }),
      el('button', { class: 'btn', type: 'button', text: '关闭', onclick: () => close() })
    ]),
    el('div', { class: 'sheet-body' }, [body])
  ]);
  overlay.append(panel);
  document.body.append(overlay);
  // 先挂到 DOM 再在下一帧加 .open，否则浏览器会把「初始 opacity:0」和「.open」
  // 合并成一次样式计算，过渡动画不会播放。
  requestAnimationFrame(() => overlay.classList.add('open'));
  // 面板打开时锁住背景滚动，关闭时恢复。
  document.body.style.overflow = 'hidden';

  function close() {
    overlay.classList.remove('open');
    document.body.style.overflow = '';
    // 等过渡（.18s）走完再摘节点，否则面板会瞬间消失、没有滑出动画。
    setTimeout(() => overlay.remove(), 180);
    onClose?.();
  }

  return { close, panel, overlay };
}
