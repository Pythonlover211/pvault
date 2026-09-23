// 录入面板（设计规格 5.2）：本任务只打桩，真实实现在任务 15。
// 首页的 FAB 已经按最终签名调用这里，任务 15 直接替换函数体即可，不需要改调用方。
//
// 约定（任务 15 要满足的契约）：
// - 从底部滑出半屏面板，不遮住今天的流水；
// - 记完收起面板并调用 onSaved()，由调用方决定重渲染（首页会整体重渲染）。
export function openEntryPanel({ onSaved } = {}) {
  console.log('entry panel not implemented yet', onSaved);
}
