// 外观系统的纯逻辑层：五套配色皮肤、深浅解析、遮罩换算。
//
// 本模块是**纯模块**：不 import db.js、不碰 document / window / Canvas，
// 因此能在 Node 里直接单测（与 file-info.js 同一条纪律）。
// 真正「把变量写进页面」的动作在 theme-store.js，那里才允许碰 DOM 与数据库。
//
// 为什么色板在这里而不在 CSS 里：如果写在 CSS，就是「5 套皮肤 × 2 种深浅 = 10 组规则」
// 写死在样式表里，而对比度测试在 Node 里读不到 CSS——要么写一个 CSS 解析器，
// 要么把色值再抄一份进测试。两份真相必然漂移，而漂移的后果是「某套皮肤在深色下
// 数字看不清」这种没人会发现的问题。放在这里，测试可以直接遍历它。

export const THEMES = [
  { id: 'default', name: '默认' },
  { id: 'paper', name: '暖纸' },
  { id: 'sage', name: '鼠尾草' },
  { id: 'wisteria', name: '紫藤' },
  { id: 'seaglass', name: '海玻璃' }
];

export const THEME_IDS = THEMES.map(t => t.id);
export const MODES = ['auto', 'light', 'dark'];
export const DEFAULT_PRESET = 'default';
export const DEFAULT_MODE = 'auto';
export const OVERLAY_MIN = 0;
export const OVERLAY_MAX = 60;
export const OVERLAY_DEFAULT = 30;

// 开背景照片时卡片的透明度。0.9 是刻意的：再透一点文字就和照片纹理打架，
// 完全不透又白瞎了一张背景图。
export const PHOTO_SURFACE_ALPHA = 0.9;

// 每套皮肤 × 每种深浅都要给全同一组变量，正典清单写死在 tests/theme.test.js 里。
// 那份清单不拿 default.light 当基准——自指的基准下「十组一起少一个变量」也是绿的。
//
// 这里**没有** --surface-rgb：它与 --surface 是同一个颜色的两种写法，存两份必然漂移，
// 而漂移只在「开了背景照片」这个状态下才看得出来（卡片半透明用的正是它的通道值），
// 不开照片的人永远碰不到这种 bug。卡片半透明的 rgba(...) 改由 themeCssVars()
// 从 --surface 现算，于是物理上不可能跟 --surface 对不上。
//
// --scrim-rgb 是背景遮罩的颜色（浅色皮肤用白遮罩压亮、深色皮肤用黑遮罩压暗），
// 它属于「皮肤 × 深浅」这个维度，所以和其他变量放在一起由 themeCssVars 统一给出。
export const THEME_TOKENS = {
  default: {
    light: {
      '--bg': '#f2f2f5', '--surface': '#ffffff', '--surface-2': '#e9e9ec',
      '--border': '#d5d5da',
      '--text': '#1d1d1f', '--text-2': '#63636a', '--text-3': '#a1a1a6',
      '--accent': '#0a6ef0', '--accent-weak': '#e6f0fe', '--on-accent': '#ffffff',
      '--shadow': '0 6px 18px rgba(0, 0, 0, .22)', '--scrim-rgb': '255,255,255'
    },
    dark: {
      '--bg': '#131315', '--surface': '#1e1e21', '--surface-2': '#2b2b30',
      '--border': '#3a3a40',
      '--text': '#f2f2f5', '--text-2': '#9a9aa0', '--text-3': '#6e6e73',
      '--accent': '#3b8ef5', '--accent-weak': '#16273d', '--on-accent': '#101216',
      '--shadow': '0 6px 18px rgba(0, 0, 0, .5)', '--scrim-rgb': '0,0,0'
    }
  },
  paper: {
    light: {
      '--bg': '#fbf7ee', '--surface': '#ffffff', '--surface-2': '#f3ece0',
      '--border': '#e4d9c6',
      '--text': '#241c12', '--text-2': '#6b5d4a', '--text-3': '#a2917a',
      '--accent': '#b45309', '--accent-weak': '#f7ebdc', '--on-accent': '#ffffff',
      '--shadow': '0 6px 18px rgba(0, 0, 0, .22)', '--scrim-rgb': '255,255,255'
    },
    dark: {
      '--bg': '#1c1712', '--surface': '#262019', '--surface-2': '#332a20',
      '--border': '#463a2c',
      '--text': '#f5efe6', '--text-2': '#b9a78e', '--text-3': '#8a7a62',
      '--accent': '#e0a458', '--accent-weak': '#3a2e1e', '--on-accent': '#1c1712',
      '--shadow': '0 6px 18px rgba(0, 0, 0, .5)', '--scrim-rgb': '0,0,0'
    }
  },
  sage: {
    light: {
      '--bg': '#f2f4ef', '--surface': '#ffffff', '--surface-2': '#e8ece3',
      '--border': '#d9e0d2',
      '--text': '#232a22', '--text-2': '#5e6857', '--text-3': '#9aa694',
      '--accent': '#0f766e', '--accent-weak': '#dff2ef', '--on-accent': '#ffffff',
      '--shadow': '0 6px 18px rgba(0, 0, 0, .22)', '--scrim-rgb': '255,255,255'
    },
    dark: {
      '--bg': '#141a14', '--surface': '#1e261e', '--surface-2': '#29332a',
      '--border': '#3a463a',
      '--text': '#edf2ea', '--text-2': '#a9b8a4', '--text-3': '#7c8a78',
      '--accent': '#2dd4bf', '--accent-weak': '#1b3a34', '--on-accent': '#0e1a16',
      '--shadow': '0 6px 18px rgba(0, 0, 0, .5)', '--scrim-rgb': '0,0,0'
    }
  },
  wisteria: {
    light: {
      '--bg': '#f7f4fc', '--surface': '#ffffff', '--surface-2': '#efe9f8',
      '--border': '#e1d8f0',
      '--text': '#241a33', '--text-2': '#6b5f80', '--text-3': '#9c90b0',
      '--accent': '#6d28d9', '--accent-weak': '#efe7fd', '--on-accent': '#ffffff',
      '--shadow': '0 6px 18px rgba(0, 0, 0, .22)', '--scrim-rgb': '255,255,255'
    },
    dark: {
      '--bg': '#17131f', '--surface': '#211b2c', '--surface-2': '#2c2439',
      '--border': '#3d3350',
      '--text': '#f0ebf7', '--text-2': '#b0a6c2', '--text-3': '#837a96',
      '--accent': '#a78bfa', '--accent-weak': '#33245c', '--on-accent': '#17131f',
      '--shadow': '0 6px 18px rgba(0, 0, 0, .5)', '--scrim-rgb': '0,0,0'
    }
  },
  seaglass: {
    light: {
      '--bg': '#eff7f8', '--surface': '#ffffff', '--surface-2': '#e3f0f2',
      '--border': '#cde2e6',
      '--text': '#12303a', '--text-2': '#4e6b74', '--text-3': '#87a3aa',
      '--accent': '#0e7490', '--accent-weak': '#dcf0f4', '--on-accent': '#ffffff',
      '--shadow': '0 6px 18px rgba(0, 0, 0, .22)', '--scrim-rgb': '255,255,255'
    },
    dark: {
      '--bg': '#0e1a1d', '--surface': '#16262a', '--surface-2': '#1f3438',
      '--border': '#2c474c',
      '--text': '#e6f1f3', '--text-2': '#9bb3b8', '--text-3': '#6f8a90',
      '--accent': '#22d3ee', '--accent-weak': '#123a42', '--on-accent': '#0e1a1d',
      '--shadow': '0 6px 18px rgba(0, 0, 0, .5)', '--scrim-rgb': '0,0,0'
    }
  }
};

// ── 归一化：设置是从库里读出来的，可能是用户手改过的、也可能是老版本留下的 ──
// 这几个函数只做一件事：把外部的脏值收拾成后面能安全消费的形状。判据一律是「不认识就退回默认」，
// 不抛错——一个坏设置不该让整个 app 打不开，也不该一路走到界面上变成透明的黑块。

export function normalizePreset(value) {
  // 用 includes 精确匹配，不 trim、不忽略大小写：带空格或大小写不符的 id 不属于这五套里的任何一套，
  // 猜成某一套看起来正常的皮肤，等于把一个坏值悄悄洗掉，回 default 才是安全的那一套。
  return THEME_IDS.includes(value) ? value : DEFAULT_PRESET;
}

export function normalizeMode(value) {
  return MODES.includes(value) ? value : DEFAULT_MODE;
}

/** 把用户的选择（可能是 'auto'）解析成真正要用的 'light' | 'dark'。 */
export function resolveMode(mode, systemDark) {
  // 先归一化再判断：库里读到 'nonsense' 时不能抛错，当成 auto 即可。
  const m = normalizeMode(mode);
  if (m === 'auto') return systemDark ? 'dark' : 'light';
  return m;
}

/**
 * 遮罩强度：数字、或非空的可解析数字字符串（滑块的 el.value）→ 取整 → 夹到 0..60；其余一律回默认 30。
 * 判据是「类型 + 非空字符串」而不是直接 Number()：Number(null) / Number('') / Number([]) /
 * Number(false) 都是 0、Number(true) 是 1，直接转换会把「这个设置没有」静默变成 0% 或 1% 的遮罩
 * ——照片上的字就再也压不住了，而用户根本没动过滑块。返回值若是 NaN，它替换进 rgba() 之后是个无效值，
 * background-image 属性会在 computed-value time 失效并回退到初始值 none——遮罩与照片是同一句里的
 * 两层（var(--bg-scrim), var(--bg-image)），回退时两层一起没，所以宁可回默认。
 */
export function normalizeOverlay(value) {
  let n = NaN;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && value.trim() !== '') n = Number(value);
  if (!Number.isFinite(n)) return OVERLAY_DEFAULT;
  return Math.min(OVERLAY_MAX, Math.max(OVERLAY_MIN, Math.round(n)));
}

/**
 * 背景设置：形状不对就当「没有背景」，而不是抛错或留下半截数据。
 * 只有 assetId 是非空字符串才算有背景——它被拿去 assets 表查那张图，空串查不到任何记录，
 * 「设置说有背景、界面上却什么都没有」比直接当没有更难查。
 * overlay 坏掉时只补它自己的默认值、不作废整条背景：坏的是滑块那一个数，照片还在库里躺着。
 */
export function normalizeBackground(value) {
  // 数组的 typeof 也是 'object'，它会一路走到下面「没有 assetId」那一关才被判 null——结果没差，
  // 但别以为类型判据拦住了它。
  if (!value || typeof value !== 'object') return null;
  const assetId = typeof value.assetId === 'string' ? value.assetId.trim() : '';
  if (!assetId) return null;
  // createdAt 比 overlay 紧，只认数字：Number(null) / Number('') / Number(false) 都是 0，而 0 是
  // 1970-01-01——一个像真实时间的哨兵值，会污染将来任何要展示或比较它的地方（这个字段目前没有消费点，
  // 正因为还没有，才不该让 0 混进去）。它也没有字符串来源（背景记录的时间就是 Date.now() 写进去的
  // 毫秒数字），所以收紧不会拒绝任何真实数据。
  const createdAt = typeof value.createdAt === 'number' && Number.isFinite(value.createdAt)
    ? value.createdAt
    : null;
  return {
    assetId,
    overlay: normalizeOverlay(value.overlay),
    createdAt
  };
}

/** 遮罩百分比 → CSS 里要用的 0..0.6 小数。越界与非法输入都走同一条归一化。 */
export function scrimAlpha(overlay) {
  return normalizeOverlay(overlay) / 100;
}

/**
 * 把 `#rrggbb` 解成 `r,g,b`。
 *
 * 存在的理由：卡片半透明的 `rgba(...)` 必须从 `--surface` **现算**。色板里早先另存过一份
 * `--surface-rgb`（同一个颜色的两种写法），两份手写真相一旦不同步，卡片颜色就只在
 * 「开了背景照片」这个状态下变掉——不开照片的人永远看不见这个 bug。现算之后不可能漂移。
 *
 * 只认 6 位十六进制。调用它的那一处读的是 `--surface`，10 组色板里它都是这个写法
 * （tests/theme.test.js 的 SHAPES 把 `--surface` 钉成 HEX6，10 组逐值断言过），所以这不是一条
 * 宽容度不够的判据；万一有人把色板里的色值改成别的写法，先红的会是那条形状断言，
 * 这里的抛错只是最后一道「宁可当场炸掉，也不要猜一个看起来合理的颜色兜过去」的兜底。
 *
 * 但**这条判据自己没有任何测试钉住**：hexToRgb 是私有函数、测试 import 不到，而它的 10 组输入恒为
 * 小写 6 位 hex——实测把正则放宽成 `/^#?([0-9a-f]{3,8})$/i`、或者去掉 `/i`（大写不再认），测试都照样
 * 全绿。将来若把它复用到别处（比如去解一个从 getSetting 读来的色值），这两条行为得自己补守卫。
 */
function hexToRgb(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex ?? ''));
  if (!m) throw new Error(`hexToRgb：不认识的色值 ${hex}`);
  const n = parseInt(m[1], 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}

/**
 * 把 (皮肤, 深浅, 有无照片) 翻译成一组要写到 <html> 上的 CSS 变量。
 * 这是**唯一**做这件事的地方——theme-store 只把这里返回的键逐个 setProperty 出去。
 * （另外三个变量不归它管：--bg-image / --bg-scrim / --scrim-a 取决于运行时状态而不是配色选择，
 * 由 theme-store 自己单独设置。）
 *
 * mode 传进来的应该是已经解析过的 'light' | 'dark'（resolveMode 的结果）。
 * 这里仍然自己兜一次底：万一有人漏了那一步，退成浅色也比抛错好。
 *
 * 返回的是副本。THEME_TOKENS 是全模块共享的常量，返回值一旦就是它本身，调用方一次就地写
 * （`vars['--bg'] = '#000000'`）就永久改掉了那一套皮肤那一档深浅的色板——而只要新值仍是合法的
 * hex，形状断言照样绿，改坏的颜色会一路带到界面上。照片那条分支自己就在写 vars，更必须落在副本上。
 */
export function themeCssVars(themeId, mode, { photo = false } = {}) {
  const preset = normalizePreset(themeId);
  const resolved = mode === 'dark' ? 'dark' : 'light';
  const base = THEME_TOKENS[preset][resolved];
  const vars = { ...base };
  if (photo) {
    // 只动 --surface：卡片本体的半透明。--surface-2 保持不透明，
    // 因为垫在它上面的是输入框、次级按钮这些必须看清文字的控件。
    // 通道值从 --surface 现算——色板里没有第二份真相可以跟它对不上。
    vars['--surface'] = `rgba(${hexToRgb(base['--surface'])}, ${PHOTO_SURFACE_ALPHA})`;
  }
  return vars;
}
