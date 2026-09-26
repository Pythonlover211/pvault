// 外观的应用层：读设置、把变量写进页面、管理背景照片。
// 与 theme.js 的分工：theme.js 只「算」（纯函数、可以在 Node 里单测），
// 这里只「做」（碰 document、IndexedDB、Canvas），两边都不越界。
// 本模块依赖 DOM 与 indexedDB：Node 里 import 它会成功（模块体不碰这两个全局），
// 但导出函数一调用就会碰到它们（只有 currentTheme() 例外，它只读内存里的状态），
// 所以它不能像 theme.js 那样进 node --test 的黑盒单测——
// 要验证行为得先造桩（假 document / 假 indexedDB）再调用。

import * as db from './db.js';
import { getSetting, setSetting } from './store.js';
import {
  DEFAULT_PRESET, DEFAULT_MODE, OVERLAY_DEFAULT,
  normalizePreset, normalizeMode, normalizeBackground,
  resolveMode, scrimAlpha, themeCssVars
} from './theme.js';

/** 背景图在 assets 表里的固定主键。只存一张，重复选图就是覆盖同一条。 */
export const BACKGROUND_ASSET_ID = 'bg';

const PRESET_KEY = 'themePreset';
const MODE_KEY = 'themeMode';
const BACKGROUND_KEY = 'backgroundImage';

// 当前已应用的状态。面板要**同步**读它（读库是异步的，而面板重绘是同步的）。
// modeChoice 是用户的选择（可能是 'auto'），mode 是解析后真正写进 data-mode 的值——
// 两个都要留着：面板上要显示「跟随系统」被选中，而样式要用解析后的那个。
let applied = {
  preset: DEFAULT_PRESET,
  modeChoice: DEFAULT_MODE,
  mode: 'light',
  photo: false,
  overlay: OVERLAY_DEFAULT
};

// 背景图的 blob URL（这里存着当前建好的那一个）。换图/移除时先把旧的 revoke 掉——
// 漏掉 revoke 就是每建一次 URL 泄漏一整张照片的内存。
let photoUrl = null;

// 跟随系统深浅的监听只挂一次。每开一次面板就挂一个的话，切一次系统主题会连跑 N 次应用，
// 而且旧监听永远不释放。
let systemListenerAttached = false;

function systemDark() {
  return typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function currentTheme() {
  return { ...applied };
}

/**
 * 把 themeCssVars 给出的那组变量与三个属性一次性写到 <html> 上，顺带更新系统栏颜色。
 *
 * **改这个函数时要整条守住这份合同**：themeCssVars 返回多少个键就写多少个（不筛、不挑），
 * 三个 dataset 一个不少。少写一个变量的后果不是「没变化」而是「上一套皮肤的值留在 DOM 上」——
 * styles/base.css 的 :root 兜底清单里没有 --scrim-rgb 这类变量，从深色切回浅色时它会留着
 * 深色那套的 '0,0,0'，于是浅色皮肤 + 背景照片时遮罩发黑、字压不住，而界面上零报错。
 * 这份合同眼下只有注释在守：tests/theme.test.js 钉住的是 themeCssVars 的键集与色板的键集，
 * 没有一条测试看得见 paint 的循环本身；手动清单里那三条 Console 核对是唯一的兜底。
 *
 * 用 inline style 而不是切 class：色板的唯一真相在 theme.js 里，
 * 若同时存在一份 CSS 规则表，两处就会各自漂移——而测试读不到 CSS，
 * 漂移的结果是「某套皮肤在深色下数字看不清」这种没人会发现的问题。
 * inline style 的优先级天然高于样式表里的普通规则（本仓库的样式表里一处 !important 都没有），
 * 不存在「哪条赢」的疑问。
 *
 * data-* 三个属性是留给 CSS 与调试用的钩子：现在还没有 CSS 用到它们，
 * 但验收时靠它们在 Console 里肉眼确认状态（刷新后 dataset.theme 应等于选中的那套皮肤）。
 */
function paint() {
  const root = document.documentElement;
  const vars = themeCssVars(applied.preset, applied.mode, { photo: applied.photo });
  for (const [key, value] of Object.entries(vars)) root.style.setProperty(key, value);
  root.dataset.theme = applied.preset;
  root.dataset.mode = applied.mode;
  root.dataset.photo = applied.photo ? 'on' : 'off';
  // 系统栏 / 浏览器 UI 的颜色跟着背景走。index.html 里那条 meta 刻意不带 media 属性：
  // 带 media 的两条只按系统深浅挑一条，用户手动选皮肤、手动选深浅时它根本不看——
  // 而 resolved 的 --bg 只有这里知道（照片只改 --surface，不动 --bg）。
  // 拿不到这条 meta 就跳过：它不在时不该让整个主题应用失败。
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', vars['--bg']);
}

function attachSystemListener() {
  if (systemListenerAttached) return;
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const onSystemChange = () => {
    // 只有「跟随系统」才跟着变：用户手动选了深色，系统怎么切都不该影响他。
    if (applied.modeChoice !== 'auto') return;
    const next = resolveMode('auto', mq.matches);
    if (next === applied.mode) return;
    applied.mode = next;
    paint();
  };
  // addEventListener 是较新的写法；老内核只有 addListener。两条都挂上，
  // 免得在鸿蒙那台的老 WebView 上「跟随系统」变成一个死开关。
  if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onSystemChange);
  else if (typeof mq.addListener === 'function') mq.addListener(onSystemChange);
  systemListenerAttached = true;
}

/**
 * 启动时读设置并应用。**必须在首屏渲染之前完成**，晚一帧就是
 * 「先闪一下默认蓝、再变成暖纸」。
 *
 * **调用方必须 catch**：主题读不出来时照常渲染，只是外观是 CSS 里的兜底默认值。
 * （任务 10）的 main.js 把 `initTheme().catch(...)` 挂在渲染路径上正是为此；少了那个 catch，
 * 一次主题失败就会升级成整页「页面加载失败」。这条路径失败时页面上是 0 个变量、0 个 dataset、
 * 0 个监听——连「半套主题」都不是，所以宁可要默认外观也不要它冒到视图层。
 *
 * 可以重复调用：第二次会从库里重读并重画（12 个变量全部重写），监听不重复挂。
 * 将来需要「不刷新页面就把外部改动读进来」（比如导入备份之后）就用这个入口。
 */
export async function initTheme() {
  const [presetRaw, modeRaw, bgRaw] = await Promise.all([
    getSetting(PRESET_KEY, DEFAULT_PRESET),
    getSetting(MODE_KEY, DEFAULT_MODE),
    getSetting(BACKGROUND_KEY, null)
  ]);
  applied.preset = normalizePreset(presetRaw);
  applied.modeChoice = normalizeMode(modeRaw);
  applied.mode = resolveMode(applied.modeChoice, systemDark());
  applied.overlay = normalizeBackground(bgRaw)?.overlay ?? OVERLAY_DEFAULT;
  paint();
  // 背景照片的加载（applyPhoto）在任务 8 才实现。这里先不调用它：调一个尚不存在的函数
  // 会让 initTheme 直接 reject，而那时变量已经写进页面、监听却还没挂上——一个「半套主题」的中间态。
  // 任务 8 实现 applyPhoto 后，把调用补在下面这行之前，并在提交说明里点明它关闭了这个中间态。
  attachSystemListener();
  return currentTheme();
}

/**
 * 换皮肤：立即应用 + 写库。**不 catch**：写库失败时 rejection 交给调用方，
 * 由调用方（面板）决定怎么提示「没保存成功」。
 */
export async function setPreset(themeId) {
  const preset = normalizePreset(themeId);
  applied.preset = preset;
  // 先画再写库。反过来的话，写库一抛（db.js 的 blocked、配额满都是真实路径）就留下
  // 「内存已改、DOM 还是旧皮肤」——面板拿 currentTheme() 重绘会显示「已经选中」，
  // 页面却还是上一个颜色，用户下次打开又变回去。先画，内存与 DOM 永远一致，
  // 写库失败只影响「下次启动记不记得住」。
  paint();
  await setSetting(PRESET_KEY, preset);
  return currentTheme();
}

/** 换深浅（含「跟随系统」）：立即应用 + 写库，失败处置与 setPreset 同。 */
export async function setMode(mode) {
  applied.modeChoice = normalizeMode(mode);
  applied.mode = resolveMode(applied.modeChoice, systemDark());
  paint();                                  // 同 setPreset：先画再写库
  await setSetting(MODE_KEY, applied.modeChoice);
  return currentTheme();
}
