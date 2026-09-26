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

// 每套皮肤 × 每种深浅都要给全同一组变量（缺一个都会被任务 1 的测试拦下）。
// --scrim-rgb 是背景遮罩的颜色（浅色皮肤用白遮罩压亮、深色皮肤用黑遮罩压暗），
// 它属于「皮肤 × 深浅」这个维度，所以和其他变量放在一起由 themeCssVars 统一给出。
export const THEME_TOKENS = {
  default: {
    light: {
      '--bg': '#f2f2f5', '--surface': '#ffffff', '--surface-2': '#e9e9ec',
      '--surface-rgb': '255,255,255', '--border': '#d5d5da',
      '--text': '#1d1d1f', '--text-2': '#63636a', '--text-3': '#a1a1a6',
      '--accent': '#0a6ef0', '--accent-weak': '#e6f0fe', '--on-accent': '#ffffff',
      '--shadow': '0 6px 18px rgba(0, 0, 0, .22)', '--scrim-rgb': '255,255,255'
    },
    dark: {
      '--bg': '#131315', '--surface': '#1e1e21', '--surface-2': '#2b2b30',
      '--surface-rgb': '30,30,33', '--border': '#3a3a40',
      '--text': '#f2f2f5', '--text-2': '#9a9aa0', '--text-3': '#6e6e73',
      '--accent': '#3b8ef5', '--accent-weak': '#16273d', '--on-accent': '#101216',
      '--shadow': '0 6px 18px rgba(0, 0, 0, .5)', '--scrim-rgb': '0,0,0'
    }
  },
  paper: {
    light: {
      '--bg': '#fbf7ee', '--surface': '#ffffff', '--surface-2': '#f3ece0',
      '--surface-rgb': '255,255,255', '--border': '#e4d9c6',
      '--text': '#241c12', '--text-2': '#6b5d4a', '--text-3': '#a2917a',
      '--accent': '#b45309', '--accent-weak': '#f7ebdc', '--on-accent': '#ffffff',
      '--shadow': '0 6px 18px rgba(0, 0, 0, .22)', '--scrim-rgb': '255,255,255'
    },
    dark: {
      '--bg': '#1c1712', '--surface': '#262019', '--surface-2': '#332a20',
      '--surface-rgb': '38,32,25', '--border': '#463a2c',
      '--text': '#f5efe6', '--text-2': '#b9a78e', '--text-3': '#8a7a62',
      '--accent': '#e0a458', '--accent-weak': '#3a2e1e', '--on-accent': '#1c1712',
      '--shadow': '0 6px 18px rgba(0, 0, 0, .5)', '--scrim-rgb': '0,0,0'
    }
  },
  sage: {
    light: {
      '--bg': '#f2f4ef', '--surface': '#ffffff', '--surface-2': '#e8ece3',
      '--surface-rgb': '255,255,255', '--border': '#d9e0d2',
      '--text': '#232a22', '--text-2': '#5e6857', '--text-3': '#9aa694',
      '--accent': '#0f766e', '--accent-weak': '#dff2ef', '--on-accent': '#ffffff',
      '--shadow': '0 6px 18px rgba(0, 0, 0, .22)', '--scrim-rgb': '255,255,255'
    },
    dark: {
      '--bg': '#141a14', '--surface': '#1e261e', '--surface-2': '#29332a',
      '--surface-rgb': '30,38,30', '--border': '#3a463a',
      '--text': '#edf2ea', '--text-2': '#a9b8a4', '--text-3': '#7c8a78',
      '--accent': '#2dd4bf', '--accent-weak': '#1b3a34', '--on-accent': '#0e1a16',
      '--shadow': '0 6px 18px rgba(0, 0, 0, .5)', '--scrim-rgb': '0,0,0'
    }
  },
  wisteria: {
    light: {
      '--bg': '#f7f4fc', '--surface': '#ffffff', '--surface-2': '#efe9f8',
      '--surface-rgb': '255,255,255', '--border': '#e1d8f0',
      '--text': '#241a33', '--text-2': '#6b5f80', '--text-3': '#9c90b0',
      '--accent': '#6d28d9', '--accent-weak': '#efe7fd', '--on-accent': '#ffffff',
      '--shadow': '0 6px 18px rgba(0, 0, 0, .22)', '--scrim-rgb': '255,255,255'
    },
    dark: {
      '--bg': '#17131f', '--surface': '#211b2c', '--surface-2': '#2c2439',
      '--surface-rgb': '33,27,44', '--border': '#3d3350',
      '--text': '#f0ebf7', '--text-2': '#b0a6c2', '--text-3': '#837a96',
      '--accent': '#a78bfa', '--accent-weak': '#33245c', '--on-accent': '#17131f',
      '--shadow': '0 6px 18px rgba(0, 0, 0, .5)', '--scrim-rgb': '0,0,0'
    }
  },
  seaglass: {
    light: {
      '--bg': '#eff7f8', '--surface': '#ffffff', '--surface-2': '#e3f0f2',
      '--surface-rgb': '255,255,255', '--border': '#cde2e6',
      '--text': '#12303a', '--text-2': '#4e6b74', '--text-3': '#87a3aa',
      '--accent': '#0e7490', '--accent-weak': '#dcf0f4', '--on-accent': '#ffffff',
      '--shadow': '0 6px 18px rgba(0, 0, 0, .22)', '--scrim-rgb': '255,255,255'
    },
    dark: {
      '--bg': '#0e1a1d', '--surface': '#16262a', '--surface-2': '#1f3438',
      '--surface-rgb': '22,38,42', '--border': '#2c474c',
      '--text': '#e6f1f3', '--text-2': '#9bb3b8', '--text-3': '#6f8a90',
      '--accent': '#22d3ee', '--accent-weak': '#123a42', '--on-accent': '#0e1a1d',
      '--shadow': '0 6px 18px rgba(0, 0, 0, .5)', '--scrim-rgb': '0,0,0'
    }
  }
};
