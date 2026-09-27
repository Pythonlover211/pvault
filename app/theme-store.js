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
  normalizePreset, normalizeMode, normalizeBackground, normalizeOverlay,
  resolveMode, scrimAlpha, themeCssVars
} from './theme.js';
// 解码 / 缩放 / JPEG 导出与发票那条路共用同一份（理由见 canvas-image.js 的头注释），
// 压缩参数也用发票同一套（长边 1600、质量 0.72），背景图不另立一套。
import { decode, drawTo, releaseSource } from './canvas-image.js';
import { MAX_EDGE, JPEG_QUALITY } from './image-scale.js';

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
 * 从深色切回浅色时 --scrim-rgb 会留着深色那套的 '0,0,0'，于是浅色皮肤 + 背景照片时遮罩发黑、
 * 字压不住，而界面上零报错。styles/base.css 的 :root 里**有** --scrim-rgb 的兜底（任务 9 加的），
 * 但它救不了这条路：兜底只在「这个变量从未被写过」时有值，而残留恰恰是「写过之后又漏写」，
 * inline style 压过样式表（见下面那段）。退一步说，真走到「从未被写过」那条路（比如 paint 的
 * 循环漏掉它），它给的也是浅色那一份，深色档下遮罩会发白而不是发黑。所以它只是**部分掩盖**
 * 了这个问题，没有消除它。
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
 * main.js（任务 10）把 `initTheme().catch(...)` 挂在渲染路径上正是为此；少了那个 catch，那次 await 会抛在
 * render() 的 try 之外（try 只管视图那一段），整个 render() 以 rejected promise 收场——**一次 mount 都不会
 * 发生**：页面纯空白，控制台只有一条未处理的拒绝，连 main.js 里那句「页面加载失败」都渲染不出来
 * （那句在 try 内，走的是视图渲染失败那条路）。这条路径失败时页面上是 0 个变量、0 个 dataset、0 个监听
 * ——连「半套主题」都不是，所以宁可要默认外观也不要它冒到视图层。
 * 兜住之后也不会重试：main.js 把结果缓存在模块级的 themeReady 里，失败同样是一个 settled 的结果，于是
 * 一次主题失败＝本次页面生命周期停在默认外观、只有刷新才恢复（走到这条路的是 db.js 的 onblocked：
 * 另一个标签页占着旧连接；视图那边会自愈，主题这边不会）。要手动补一次，就再调一次本函数。
 *
 * **它现在是首屏挂载的前置依赖**（任务 10 挂上去的）：mount 要等它跑完。它做的 IndexedDB 操作是
 * settings 三条读（下面那次 Promise.all），有照片时再加 assets 一条读与一次 blob URL 创建
 * （**不做解码**——decode 只在 setPhoto 那条路上）。将来若把慢操作搬进这里（比如启动就解码背景图），
 * 要重新评估这个依赖，别默默加重首屏。
 *
 * 可以重复调用：第二次会从库里重读并重画（12 个变量全部重写；有照片时还会重读一次 assets，
 * 重建 blob URL 并当场释放上一个），监听不重复挂。
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
  // 照片要 await 出来，**不能**挂成 fire-and-forget：上面这次 paint() 画的是内存里的 applied，
  // 而卡片的不透明度（--surface）与背景图（--bg-image）要等 applyPhoto 里的第二次 paint() 才到位。
  // 不 await 的话那次补画落在 initTheme 返回之后（常常已经 mount 完了），冷启动时用户看到的是
  // 「卡片先实心、再突然变半透明并冒出一张照片」——规格 §5.4 要求主题在任何 mount 之前应用，
  // 照片是同一层外观，没有理由把它排除在外。代价只有首屏多等一次 assets 读（settings 那条
  // 上面已经读过，直接传给 applyPhoto，不再重复读），与 mount 之后读交易列表同量级。
  // 失败只记一条日志：一次照片读取失败不该升级成主题失败，initTheme 照常返回、监听照常挂上。
  await applyPhoto(bgRaw).catch(err => console.error('背景照片加载失败，按没有背景处理', err));
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

// ── 背景照片 ────────────────────────────────────────────────

/**
 * 把用户选的照片压成背景图：长边 1600、JPEG。
 *
 * 为什么不复用 image-store.prepareFile：那个函数还要生成缩略图、还要判断
 * 「压完是不是比原图更小」（压小了才用压缩版）。背景图这里**必须**走 JPEG——
 * HEIC 之类格式 WebView 画不出来，而背景层是 CSS 直接引用的；
 * 即使压完比原图大也得用这个编码结果。
 */
async function encodeBackground(inputFile) {
  const source = await decode(inputFile);
  try {
    return await drawTo(source, MAX_EDGE, JPEG_QUALITY);
  } finally {
    // finally 而不是只写在成功路径上：drawTo 抛错（尺寸无效、toBlob 返回空）时同样要放掉位图。
    // ImageBitmap 背后是一整张解压后的像素，漏一张就是几十 MB。
    releaseSource(source);
  }
}

/**
 * 把照片相关的变量写进页面。
 *
 * 有图时三个都写：--bg-image（照片本身）、--bg-scrim（压在上面的遮罩层）、--scrim-a（遮罩强度）。
 * url 为 null 表示「没有背景」：两层背景都设成 none、整层等于不存在，此时 --scrim-a 没有作用对象，
 * 不再写它（下一次选图时会被重写）。
 */
function setPhotoVars(url) {
  const root = document.documentElement;
  if (photoUrl && photoUrl !== url) URL.revokeObjectURL(photoUrl);
  photoUrl = url;
  if (!url) {
    root.style.setProperty('--bg-image', 'none');
    root.style.setProperty('--bg-scrim', 'none');
    return;
  }
  // url(...) 里的引号是必须的：blob URL 本身不含特殊字符，但一旦有人把这里
  // 换成 file:// 或含括号的地址，没有引号就会把整条声明打断。
  root.style.setProperty('--bg-image', `url("${url}")`);
  // 遮罩层压着照片。这里写进去的是**表达式**（颜色取自 --scrim-rgb、强度取自 --scrim-a），
  // 不是算好的颜色：自定义属性在使用点求值，所以 paint() 每次切深浅重写 --scrim-rgb 时，
  // body::before 的 background-image 会跟着重新求值——不必在切深浅时再写一次 --bg-scrim。
  root.style.setProperty('--bg-scrim',
    'linear-gradient(rgba(var(--scrim-rgb), var(--scrim-a)), rgba(var(--scrim-rgb), var(--scrim-a)))');
  root.style.setProperty('--scrim-a', String(scrimAlpha(applied.overlay)));
}

/**
 * 从库里读出背景图并应用。bgRaw 是 settings.backgroundImage 的**原始值**，由调用方传进来：
 * initTheme 传它 Promise.all 里刚读到的那份、setPhoto 传它刚写进去的那条——两处都已经有它了，
 * 让这里再读一次 settings 是纯重复（冷启动那条路上就是白读一次）。
 *
 * 「设置指向一张库里已经没有的图」按「没有背景」处理：走到这一步本来就没有照片可画，抛错
 * 对调用方没有意义。同时把设置清掉——留着它只会让每次启动都多读一次 assets：
 * 清了之后传进来的 bgRaw 就是 null，下面 `db.get('assets', …)` 那一步被跳过。
 * 这种记录有两个真实来源：① 导入一份「设置里有 backgroundImage、备份包里却没有 assets」的
 * 备份——当前的备份包就没有 assets（规格 §7 的任务 13 接缝）；② removePhoto 删库成功、
 * 清设置那一步失败。
 */
async function applyPhoto(bgRaw) {
  const bg = normalizeBackground(bgRaw);
  const row = bg ? await db.get('assets', bg.assetId) : null;
  const blob = row?.blob ?? null;
  if (!blob) {
    applied.photo = false;
    // 遮罩强度一并复位：没有照片时它没有作用对象，留着只会让「当前状态」多带一个没有意义的数。
    applied.overlay = OVERLAY_DEFAULT;
    setPhotoVars(null);
    paint();
    // 清设置排在最后：它只是「省掉下次启动的一次 assets 读」的顺手动作，失败不该拦住上面
    // 那两步——否则页面上会继续显示一张库里已经没有的照片。清失败时设置留着，下一次成功的
    // 调用会再清一次（自愈），代价只是多读一次 assets。
    if (bg) await setSetting(BACKGROUND_KEY, null);
    return;
  }
  applied.photo = true;
  applied.overlay = bg.overlay;
  setPhotoVars(URL.createObjectURL(blob));
  // 照片影响 --surface（半透明），所以 paint 必须跟着走一次。
  paint();
}

/** 选一张照片当背景：压缩 → 存 assets → 写设置 → 应用。 */
export async function setPhoto(inputFile) {
  const blob = await encodeBackground(inputFile);
  const createdAt = Date.now();
  await db.put('assets', {
    id: BACKGROUND_ASSET_ID,
    blob,
    mime: 'image/jpeg',
    size: blob.size,
    createdAt
  });
  // overlay 沿用内存里当前的值：换一张图不该把用户已经调好的遮罩打回默认。
  const setting = { assetId: BACKGROUND_ASSET_ID, overlay: applied.overlay, createdAt };
  // 已知、可接受的降级：assets 那一步已经成功了，设置这一步再失败就留下「库里是新图、
  // 设置还是旧记录（overlay 与 createdAt 都是旧值）」，而画面上停着上一张图。没有数据丢失，
  // 重启后看到的是「新图 + 旧遮罩」；再选一次图或随便拖一下滑块，设置就会被补齐。
  await setSetting(BACKGROUND_KEY, setting);
  await applyPhoto(setting);
  return currentTheme();
}

/**
 * 移除背景：删记录、清设置、撤掉两层背景。
 *
 * 顺序是**先删库、成功之后再改内存与 DOM**：反过来的话删库一失败，页面上已经「移除成功」，
 * 而记录还在库里，下次启动背景图又回来了。反方向（删库成功、清设置失败）会留下一条
 * 「设置指向已经不存在的图」的记录，那种记录由 applyPhoto 按「没有背景」兜住并清掉。
 * 照片是**用户自己选的**，删掉就是删掉。
 */
export async function removePhoto() {
  await db.remove('assets', BACKGROUND_ASSET_ID);
  await setSetting(BACKGROUND_KEY, null);
  applied.photo = false;
  applied.overlay = OVERLAY_DEFAULT;
  setPhotoVars(null);
  paint();
  return currentTheme();
}

/** 只改遮罩强度：不重编码图片，也不重写 assets。 */
export async function setOverlay(value) {
  // 唯一的判据是 applied.photo，它回答的是「此刻画面上真的有一张照片吗」。不拿设置里那条
  // 记录当判据：两者会不一致——读 assets 失败被 catch 收住、或上一次清设置失败时，设置说
  // 有背景、照片却没加载出来；那时按设置走会改内存并写库，而 DOM 上的 --scrim-a 一个字符
  // 都不写，正是「面板显示新刻度、页面纹丝不动」的那种不一致。
  if (!applied.photo) return currentTheme();
  const bg = normalizeBackground(await getSetting(BACKGROUND_KEY, null));
  applied.overlay = normalizeOverlay(value);
  // 先写 DOM 再写库，与 setPreset / setMode 同一条纪律：反过来的话写库一抛就留下「内存已改、
  // DOM 还是旧值」。
  document.documentElement.style.setProperty('--scrim-a', String(scrimAlpha(applied.overlay)));
  // bg 为 null 只可能是设置被外部清掉（applied.photo 为 true 意味着上一次 applyPhoto 读到过
  // 它）：那时不拿一条空记录去覆盖设置，只把遮罩改在画面上，下次启动按「没有背景」自愈。
  if (bg) await setSetting(BACKGROUND_KEY, { ...bg, overlay: applied.overlay });
  return currentTheme();
}
