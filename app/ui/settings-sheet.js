// 设置面板（任务 17 的入口聚合）：账户管理 / 分类管理 / 预算设置。
//
// 为什么入口在首页的齿轮而不是统计页底部：账户、分类、预算都是「记账配置」，
// 用户不会去统计页找它们；统计页只回答「钱花哪了」。
//
// —— 嵌套面板的时序（重要）——
// sheet.js 的每一层都会把 document.body.style.overflow 设成 'hidden'，而 close() 一律把它清空。
// 于是「先开子面板、再关父面板」会让子面板开着、背景却能滚动；两层同时挂着也同理
// （关掉任意一层就把另一层的锁解了）。所以本模块的纪律是：**任何时刻只有一层 sheet 存在**。
//
// 做法：点入口 → 先把「待打开的子面板」放进**当前这层自己的闭包**里 → 关掉当前层 →
// 等它 180ms 的摘除动画走完（200ms）→ 再开子面板。
// 「等」这一段时间里旧遮罩还盖着整屏，用户随时可能点它反悔：遮罩一点就把计划作废，
// 绝不让子面板凭空冒出来（否则背景滚动还会被锁死）。
import { el } from './dom.js';
import { openSheet } from './sheet.js';
import { openAccountsSheet } from './accounts-view.js';
import { openCategoriesSheet } from './categories-view.js';
import { openBudgetSheet } from './budget-view.js';

// 与 sheet.js 内部摘除节点的延时保持一致，再加一点余量：早于它开下一层，
// 就是两层同时挂在 DOM 上。
const SWAP_DELAY = 200;

// 模块级只放「当前活跃的那一层」，它是跨面板的（新面板要知道该先收掉谁）：
// sheet 的关闭动画有 180ms，只靠 DOM 查询会看到「还在摘除中的旧层」。
let activeSheet = null;
// 等待换层的计划。换层是「用户点了当前层的入口」引发的，所以句柄由那一层的闭包持有；
// 但取消它需要由新开的/正在关的那一层来触发，故这里留一个全局引用。
let pendingSwap = null;

// 作废并返回当前的换层计划（没有则返回 null）。
function takePendingSwap() {
  const plan = pendingSwap;
  pendingSwap = null;
  return plan;
}

// 关掉当前活跃层（如果有），并取消待打开的计划。
function dropActive() {
  takePendingSwap();
  const prev = activeSheet;
  activeSheet = null;
  if (prev) prev.close();
}

// 设置项定义。label 是列表里显示的入口名，open 负责开对应的子面板。
// 导出是为了让测试探针能按 id 定位入口（真实 UI 只用 openSettingsSheet）。
export const SETTINGS_ENTRIES = [
  { id: 'accounts', label: '账户管理', open: openAccountsSheet },
  { id: 'categories', label: '分类管理', open: openCategoriesSheet },
  { id: 'budget', label: '预算设置', open: openBudgetSheet }
];

export function openSettingsSheet({ onChanged } = {}) {
  // 兜底：子面板还开着时用户又点了首页齿轮（面板后面的首页依然可点）。
  // 不先收掉旧层就会叠出第二层 sheet，两层的 overflow 锁会互相拆台。
  dropActive();

  // 当前这层的计划句柄。放在闭包里而不是模块级：swapTo 里 sheet.close() 会**同步**
  // 触发下面的 onClose，如果计划存在模块级变量里，就会在真正打开之前被 onClose 清掉。
  let myPlan = null;

  const body = el('div', { class: 'stack' }, SETTINGS_ENTRIES.map(entry =>
    el('button', {
      class: 'btn manage-entry',
      type: 'button',
      text: entry.label + ' ›',
      // data-entry 是稳定钩子：文案随时可能改，测试与后续任务按它定位。
      dataset: { entry: entry.id },
      onclick: () => swapTo(entry)
    })
  ));

  // 子面板改动过就通知首页重渲染。两层都挂同一个回调：用户的改动可能发生在
  // 子面板里（保存/归档），也可能只是回到设置面板后直接关掉，两种路径都要刷新。
  const notify = () => { if (onChanged) onChanged(); };

  const sheet = openSheet({
    title: '设置',
    body,
    onClose: () => {
      // 换层时（myPlan 已排队）这一层是被程序关掉的，计划要留着给延迟里的 setTimeout 用；
      // 其它情况都是用户自己关的，那就把计划作废——他既然关了，就不该再冒出别的面板。
      if (!myPlan) {
        pendingSwap = null;
        if (activeSheet === sheet) activeSheet = null;
        notify();
      }
    }
  });
  activeSheet = sheet;

  // 等待期里用户点遮罩 = 反悔：取消待打开的子面板。
  // 这里必须自己挂一个监听：sheet.close() 是幂等的，父面板在换层开始时就已经 close 过了，
  // 所以用户这时的点击不会再触发 sheet.js 内部那个「点遮罩关闭」的分支。
  sheet.overlay.addEventListener('click', e => {
    if (e.target === sheet.overlay) myPlan = null;
  });

  // 先关当前层、等它摘掉之后再开下一层，全程只有一层 sheet。
  // 用 setTimeout 而不是 onClose 回调：onClose 是在 close() 里同步调的，那一刻遮罩还在
  // DOM 上（180ms 后才摘除），此时开子面板就是两层并存。
  function swapTo(entry) {
    // 同一层被连点两次入口（比如双击「账户管理」）：第二次不再排队，
    // 否则会排两个 setTimeout，各开一层。
    if (myPlan) return;
    myPlan = () => { activeSheet = entry.open({ onChanged: notify }); };
    pendingSwap = myPlan;
    sheet.close();
    setTimeout(() => {
      const plan = myPlan;
      myPlan = null;
      if (pendingSwap === plan) pendingSwap = null;
      if (plan) plan();
    }, SWAP_DELAY);
  }

  return sheet;
}
