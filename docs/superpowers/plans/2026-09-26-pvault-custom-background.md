# pvault · 自定义背景 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 给 pvault 加一套外观系统——五套配色皮肤（各带浅/深两版，深浅可跟随系统或手动指定）+ 用相册里的照片当背景，并保证开了照片之后关键数字依然看得清。

**架构：** 色板数据与换算规则放在纯模块 `app/theme.js`（能在 Node 里跑对比度断言，这是唯一能防住「某套皮肤在深色下数字看不清」的机制）；碰 DOM/IndexedDB/Canvas 的应用逻辑放在 `app/theme-store.js`；背景层是一个 `body::before` 伪元素，靠 CSS 变量驱动；照片存进新建的 `assets` 表，并随备份包走 `data.background` 字段。**色板的唯一真相在 JS 里**（写进 `documentElement` 的 inline style），CSS 只留一份默认值作首帧兜底——避免同一组色值在 CSS 与测试里各存一份而漂移。

**技术栈：** 原生 ES Modules + 手写 CSS 变量，零依赖、无构建。测试：`D:\node.exe --test --test-isolation=none`（**必须带 `--test-isolation=none`**，裸 `node --test` 会 EPERM）。

**动手前的基准：** 247 pass / 0 fail（已实测）。

**规格：** `docs/superpowers/specs/2026-09-26-pvault-custom-background-design.md`

---

## 文件结构

**创建**

| 文件 | 职责 |
|---|---|
| `app/theme.js` | 纯模块：五套皮肤的色板数据、归一化函数、`themeCssVars()`。**不 import `db.js`、不碰 `document`**，否则 Node 测试跑不起来。 |
| `app/theme-store.js` | 应用层：读写 settings、把变量写进 `documentElement`、管理背景照片（压缩、存取、blob URL 回收）。 |
| `app/canvas-image.js` | 浏览器侧图片编解码工具（`decode` / `drawTo` / `releaseSource`），从 `image-store.js` 搬出来共用。 |
| `app/ui/appearance-sheet.js` | 「外观与背景」面板。 |
| `styles/appearance.css` | 面板的样式（皮肤卡、遮罩滑块）。 |
| `tests/theme.test.js` | 主题纯逻辑测试（含 WCAG 对比度断言）。 |

**修改**

| 文件 | 改什么 |
|---|---|
| `styles/base.css` | 加 `body::before` 背景层；`:root` 补 `--scrim-a` 与背景相关变量的兜底值。 |
| `app/image-store.js` | 删掉私有的 `loadViaImg`/`decode`/`releaseSource`/`drawTo`，改为从 `canvas-image.js` import。**行为必须完全不变。** |
| `app/schema.js` | 加 `assets` 表；`DB_VERSION` 2 → 3。 |
| `app/main.js` | 首屏渲染前 `await` 主题初始化。 |
| `app/ui/settings-sheet.js` | 加「外观与背景」入口（插在 `budget` 与 `backup` 之间）。 |
| `app/backup-store.js` | 导出/导入 `data.background`。 |
| `app/backup.js` | `buildBackup` 里带上 `background`。 |
| `sw.js` | `ASSETS` 加 6 个新文件；`CACHE` 升 `pvault-v16`。 |
| `index.html` | 加一行 `styles/appearance.css`。 |
| `tests/schema.test.js` | 三处会被这次改动打红的断言（见任务 6）。 |
| `docs/手动验证清单.md` | 加外观章节。 |

**为什么 `--surface-2` 在照片模式下保持不透明**：垫在它上面的是输入框、次级按钮这些必须看清文字的控件（规格 §6.3）。只有卡片本体的 `--surface` 变半透明。

---

## 任务 1：`app/theme.js` 的色板数据与「变量齐全」测试

**文件：**
- 创建：`app/theme.js`
- 测试：`tests/theme.test.js`

- [ ] **步骤 1：编写失败的测试**

创建 `tests/theme.test.js`：

```js
// 外观系统的纯逻辑测试。theme.js 不碰 DOM 与 IndexedDB，所以这一套能直接在 Node 里跑。
import test from 'node:test';
import assert from 'node:assert/strict';
import { THEMES, THEME_TOKENS, THEME_IDS } from '../app/theme.js';

test('theme：五套皮肤 × 深浅的变量集合完全一致', () => {
  const base = Object.keys(THEME_TOKENS.default.light).sort();
  assert.ok(base.length > 0, 'default.light 一个变量都没有');
  for (const id of THEME_IDS) {
    assert.ok(THEME_TOKENS[id], `缺少皮肤 ${id} 的色板`);
    for (const mode of ['light', 'dark']) {
      const tokens = THEME_TOKENS[id][mode];
      assert.ok(tokens, `${id}.${mode} 缺失`);
      // 判据是「键集合与 default.light 完全一致」而不是「数量够」：
      // 少一个变量就是界面上某处变成透明/黑块，而多一个说明这套皮肤偷偷开了新维度。
      assert.deepEqual(
        Object.keys(tokens).sort(), base,
        `${id}.${mode} 的变量集合与 default.light 不一致`
      );
    }
  }
});

test('theme：THEME_IDS 与 THEMES 一一对应且含 default', () => {
  assert.deepEqual(THEME_IDS, THEMES.map(t => t.id));
  assert.ok(THEME_IDS.includes('default'));
  assert.equal(new Set(THEME_IDS).size, THEME_IDS.length, '皮肤 id 有重复');
});

test('theme：每套皮肤都有非空的中文名', () => {
  for (const t of THEMES) {
    assert.equal(typeof t.name, 'string', `${t.id} 没有名字`);
    assert.ok(t.name.trim(), `${t.id} 的名字是空的`);
  }
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`D:\node.exe --test --test-isolation=none tests/theme.test.js`

预期：FAIL —— `Cannot find module '...\app\theme.js'`

- [ ] **步骤 3：写 `app/theme.js` 的色板部分**

```js
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
```

- [ ] **步骤 4：运行测试确认通过**

运行：`D:\node.exe --test --test-isolation=none tests/theme.test.js`

预期：3 个测试全部 PASS

- [ ] **步骤 5：Commit**

```bash
git add app/theme.js tests/theme.test.js
git commit -m 'feat(theme): 五套皮肤的色板数据与变量齐全性测试'
```

---

## 任务 2：对比度断言（本计划最有价值的一条测试）

**文件：**
- 修改：`tests/theme.test.js`

- [ ] **步骤 1：加对比度工具与断言**

在 `tests/theme.test.js` 的 import 之后追加：

```js
// ── WCAG 对比度 ──────────────────────────────────────────────
// 自己实现而不是引依赖：只用到相对亮度一个公式，零依赖是这个项目的底线。

function parseHex(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) throw new Error(`不是 #rrggbb 形式的颜色：${hex}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function channel(v) {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function luminance(hex) {
  const [r, g, b] = parseHex(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

// 文字色 vs 它可能落在的每一种底。surface-2 必须算进去：输入框、次级按钮都垫在它上面，
// 而这一对恰恰是最容易不达标的（默认皮肤的老值 #6e6e73 就是在这里只有 4.25:1）。
const CONTRAST_PAIRS = [
  ['--text', '--bg'], ['--text', '--surface'], ['--text', '--surface-2'],
  ['--text-2', '--bg'], ['--text-2', '--surface'], ['--text-2', '--surface-2'],
  ['--on-accent', '--accent']
];

const MIN_CONTRAST = 4.5;

test('theme：所有皮肤的文字对比度都不低于 4.5:1', () => {
  const bad = [];
  for (const id of THEME_IDS) {
    for (const mode of ['light', 'dark']) {
      const tokens = THEME_TOKENS[id][mode];
      for (const [fg, bg] of CONTRAST_PAIRS) {
        const ratio = contrast(tokens[fg], tokens[bg]);
        if (ratio < MIN_CONTRAST) {
          bad.push(`${id}.${mode}  ${fg} on ${bg} = ${ratio.toFixed(2)}:1  (${tokens[fg]} / ${tokens[bg]})`);
        }
      }
    }
  }
  assert.deepEqual(bad, [], '这些配色达不到 AA 的 4.5:1，必须调色值：\n' + bad.join('\n'));
});
```

- [ ] **步骤 2：运行并处理结果**

运行：`D:\node.exe --test --test-isolation=none tests/theme.test.js`

预期：**全绿**（规格里的色值本来就是按这条规则挑的）。

**如果报红**：不要放宽 `MIN_CONTRAST`，也不要删掉报红的那一对——按报告里的那一对去调那个皮肤的色值（`--text-2` 最深、`--on-accent` 往背景色方向靠、`--accent` 往深色方向压），改到全绿为止。这是设计规格 §5.3 里写明「以测试为准、不迁就表格」的意思。

- [ ] **步骤 3：Commit**

```bash
git add tests/theme.test.js
git commit -m 'test(theme): 五套皮肤的 WCAG 对比度断言'
```

---

## 任务 3：归一化与解析函数

**文件：**
- 修改：`app/theme.js`（追加导出）
- 修改：`tests/theme.test.js`

- [ ] **步骤 1：编写失败的测试**

追加到 `tests/theme.test.js`：

```js
import {
  normalizePreset, normalizeMode, resolveMode, normalizeOverlay,
  normalizeBackground, scrimAlpha
} from '../app/theme.js';

test('normalizePreset：认识的留下，其余一律回默认', () => {
  assert.equal(normalizePreset('paper'), 'paper');
  assert.equal(normalizePreset('seaglass'), 'seaglass');
  for (const junk of [undefined, null, '', 'PA', 42, {}, [], 'light']) {
    assert.equal(normalizePreset(junk), 'default', `输入 ${JSON.stringify(junk)} 没被兜住`);
  }
});

test('normalizeMode：认识的留下，其余一律回 auto', () => {
  assert.equal(normalizeMode('light'), 'light');
  assert.equal(normalizeMode('dark'), 'dark');
  assert.equal(normalizeMode('auto'), 'auto');
  for (const junk of [undefined, null, '', 'DARK', 0, {}, true]) {
    assert.equal(normalizeMode(junk), 'auto', `输入 ${JSON.stringify(junk)} 没被兜住`);
  }
});

test('resolveMode：auto 看系统，手动指定压过系统', () => {
  assert.equal(resolveMode('auto', true), 'dark');
  assert.equal(resolveMode('auto', false), 'light');
  // 用户明确选了深色，系统是浅色也必须是深色——反过来同理。
  assert.equal(resolveMode('dark', false), 'dark');
  assert.equal(resolveMode('light', true), 'light');
  // 垃圾值归一化成 auto 之后再看系统，别抛错也别瞎猜。
  assert.equal(resolveMode('nonsense', true), 'dark');
});

test('normalizeOverlay：取整、夹到 0..60，非法值回默认 30', () => {
  assert.equal(normalizeOverlay(0), 0);
  assert.equal(normalizeOverlay(60), 60);
  assert.equal(normalizeOverlay(30.4), 30);
  assert.equal(normalizeOverlay(30.6), 31);
  assert.equal(normalizeOverlay(-5), 0);
  assert.equal(normalizeOverlay(999), 60);
  assert.equal(normalizeOverlay('45'), 45, '字符串数字要认（滑块的 value 是字符串）');
  for (const junk of [undefined, null, '', NaN, Infinity, {}, []]) {
    assert.equal(normalizeOverlay(junk), 30, `输入 ${JSON.stringify(junk)} 没被兜住`);
  }
});

test('normalizeBackground：形状不对就是「没有背景」', () => {
  assert.equal(normalizeBackground(null), null);
  assert.equal(normalizeBackground(undefined), null);
  assert.equal(normalizeBackground('bg'), null);
  assert.equal(normalizeBackground({}), null, '没有 assetId 不算有背景');
  assert.equal(normalizeBackground({ assetId: '' }), null);
  assert.equal(normalizeBackground({ assetId: '   ' }), null);
  assert.equal(normalizeBackground({ assetId: 42 }), null);

  assert.deepEqual(
    normalizeBackground({ assetId: 'bg', overlay: 45, createdAt: 1700000000000 }),
    { assetId: 'bg', overlay: 45, createdAt: 1700000000000 }
  );
  // overlay 缺失或非法时补默认值，不能让一个坏 overlay 把整条背景作废。
  assert.deepEqual(
    normalizeBackground({ assetId: 'bg' }),
    { assetId: 'bg', overlay: 30, createdAt: null }
  );
});

test('scrimAlpha：百分比换算成 0..0.6 的小数', () => {
  assert.equal(scrimAlpha(0), 0);
  assert.equal(scrimAlpha(60), 0.6);
  assert.equal(scrimAlpha(30), 0.3);
  // 非法输入走 normalizOverlay 的默认值 30，而不是 NaN——NaN 会让整条 background 声明失效。
  assert.equal(scrimAlpha('nonsense'), 0.3);
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`D:\node.exe --test --test-isolation=none tests/theme.test.js`

预期：FAIL —— `normalizePreset is not a function`（或 `does not provide an export named`）

- [ ] **步骤 3：在 `app/theme.js` 末尾追加实现**

```js
// ── 归一化：设置是从库里读出来的，可能是用户手改过的、也可能是老版本留下的 ──
// 每一个都必须在入口处兜住，否则一个坏值会一路走到界面上变成透明的黑块。

export function normalizePreset(value) {
  return THEME_IDS.includes(value) ? value : DEFAULT_PRESET;
}

export function normalizeMode(value) {
  return MODES.includes(value) ? value : DEFAULT_MODE;
}

/** 把用户的选择（可能是 'auto'）解析成真正要用的 'light' | 'dark'。 */
export function resolveMode(mode, systemDark) {
  const m = normalizeMode(mode);
  if (m === 'auto') return systemDark ? 'dark' : 'light';
  return m;
}

/** 遮罩强度：取整后夹到 0..60；非数字一律回默认 30（NaN 会让整条 background 声明失效）。 */
export function normalizeOverlay(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return OVERLAY_DEFAULT;
  return Math.min(OVERLAY_MAX, Math.max(OVERLAY_MIN, Math.round(n)));
}

/** 背景设置：形状不对就当「没有背景」，而不是抛错或留下半截数据。 */
export function normalizeBackground(value) {
  if (!value || typeof value !== 'object') return null;
  const assetId = typeof value.assetId === 'string' ? value.assetId.trim() : '';
  if (!assetId) return null;
  const createdAt = Number(value.createdAt);
  return {
    assetId,
    overlay: normalizeOverlay(value.overlay),
    createdAt: Number.isFinite(createdAt) ? createdAt : null
  };
}

/** 遮罩百分比 → CSS 里要用的 0..0.6 小数。 */
export function scrimAlpha(overlay) {
  return normalizeOverlay(overlay) / 100;
}
```

- [ ] **步骤 4：运行测试确认通过**

运行：`D:\node.exe --test --test-isolation=none tests/theme.test.js`

预期：全部 PASS

- [ ] **步骤 5：Commit**

```bash
git add app/theme.js tests/theme.test.js
git commit -m 'feat(theme): 设置项的归一化与深浅解析'
```

---

## 任务 4：`themeCssVars()` —— 唯一把「皮肤 + 深浅 + 有无照片」翻译成变量的地方

**文件：**
- 修改：`app/theme.js`
- 修改：`tests/theme.test.js`

- [ ] **步骤 1：编写失败的测试**

追加到 `tests/theme.test.js`：

```js
import { themeCssVars } from '../app/theme.js';

test('themeCssVars：不认识的皮肤/深浅都退回默认', () => {
  const fallback = themeCssVars('nope', 'nope');
  assert.deepEqual(fallback, THEME_TOKENS.default.light);
  // 'auto' 不是合法的深浅（它该先被 resolveMode 解析掉）；万一漏传进来，按浅色处理，不能抛错。
  assert.deepEqual(themeCssVars('default', 'auto'), THEME_TOKENS.default.light);
});

test('themeCssVars：开照片时只有 --surface 变半透明', () => {
  const plain = themeCssVars('paper', 'light');
  const withPhoto = themeCssVars('paper', 'light', { photo: true });

  assert.equal(plain['--surface'], '#ffffff');
  assert.equal(plain['--surface-2'], '#f3ece0', '不开照片时 surface-2 是皮肤原值');

  assert.equal(withPhoto['--surface'], 'rgba(255,255,255, 0.9)');
  // --surface-2 必须保持不变：输入框、次级按钮垫在它上面，透了就看不清了（规格 §6.3）。
  assert.equal(withPhoto['--surface-2'], plain['--surface-2'], 'surface-2 不许被改成半透明');

  // 除 --surface 外，其余变量一个都不能变。
  for (const key of Object.keys(plain)) {
    if (key === '--surface') continue;
    assert.equal(withPhoto[key], plain[key], `${key} 不该被照片模式改动`);
  }
});

test('themeCssVars：深色皮肤的 surface-rgb 与浅色不同', () => {
  const light = themeCssVars('seaglass', 'light', { photo: true });
  const dark = themeCssVars('seaglass', 'dark', { photo: true });
  assert.equal(light['--surface'], 'rgba(255,255,255, 0.9)');
  assert.equal(dark['--surface'], 'rgba(22,38,42, 0.9)');
});

test('themeCssVars：返回值是副本，改它不会污染色板', () => {
  const vars = themeCssVars('sage', 'dark');
  vars['--bg'] = '#000000';
  assert.notEqual(THEME_TOKENS.sage.dark['--bg'], '#000000', '色板被调用方改掉了');
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`D:\node.exe --test --test-isolation=none tests/theme.test.js`

预期：FAIL —— `themeCssVars is not a function`

- [ ] **步骤 3：实现**

追加到 `app/theme.js`：

```js
/**
 * 把 (皮肤, 深浅, 有无照片) 翻译成一组要写到 <html> 上的 CSS 变量。
 * 这是**唯一**做这件事的地方——theme-store 只负责把结果 setProperty 出去。
 *
 * mode 传进来的应该是已经解析过的 'light' | 'dark'（resolveMode 的结果）。
 * 这里仍然自己兜一次底：万一有人漏了那一步，退成浅色也比抛错好。
 *
 * 返回的是副本：调用方拿到后往往会就地补几个键（比如 --bg-image），
 * 直接返回色板对象会把 THEME_TOKENS 改脏，而它是全模块共享的常量。
 */
export function themeCssVars(themeId, mode, { photo = false } = {}) {
  const preset = normalizePreset(themeId);
  const resolved = mode === 'dark' ? 'dark' : 'light';
  const base = THEME_TOKENS[preset][resolved];
  const vars = { ...base };
  if (photo) {
    // 只动 --surface：卡片本体的半透明。--surface-2 保持不透明，
    // 因为垫在它上面的是输入框、次级按钮这些必须看清文字的控件。
    vars['--surface'] = `rgba(${base['--surface-rgb']}, ${PHOTO_SURFACE_ALPHA})`;
  }
  return vars;
}
```

- [ ] **步骤 4：运行测试确认通过**

运行：`D:\node.exe --test --test-isolation=none tests/theme.test.js`

预期：全部 PASS

- [ ] **步骤 5：Commit**

```bash
git add app/theme.js tests/theme.test.js
git commit -m 'feat(theme): themeCssVars 统一翻译皮肤/深浅/照片'
```

---

## 任务 5：抽出 `app/canvas-image.js`（行为必须完全不变）

**为什么做这个重构**：背景图要用「解码 → 缩放到长边 → 导出 JPEG」这一整套，而它现在以私有函数的形态锁在 `image-store.js` 里。复制一份是 60 行重复代码，两份将来必然漂移（比如 EXIF 方向那条纪律只改了其中一份）。

**这个任务动的是已发布的发票功能**，所以最后一步必须做回归验证。

**文件：**
- 创建：`app/canvas-image.js`
- 修改：`app/image-store.js`（删私有实现，改 import）

- [ ] **步骤 1：创建 `app/canvas-image.js`**

把 `image-store.js` 第 15–86 行的 `loadViaImg` / `decode` / `releaseSource` / `drawTo` **连同注释原样搬过来**，四个函数都加 `export`，并在文件头写：

```js
// 浏览器侧的图片编解码工具：解码（含 EXIF 方向）、缩放到指定长边、导出 JPEG。
// 依赖 Image / createImageBitmap / canvas / URL，**不能在 Node 里 import**。
// 纯计算（尺寸取舍、质量取值）在 image-scale.js 里单测，这里只做 API 编排。
//
// 发票图片（image-store）与外观背景图（theme-store）共用这一份：
// 两边都要「解码 → 缩放 → JPEG」，而 EXIF 方向这类纪律只要有一边漏了，
// 用户看到的就是一张躺倒的图——复制两份实现迟早会漂成一个对一个错。
```

**搬过去时一个字都不要改**——包括 `imageOrientation: 'from-image'` 那条注释、`drawTo` 里的 `imageSmoothingQuality = 'high'` 与铺白底、`releaseSource` 的可选调用。这个任务只搬位置，不改进。

- [ ] **步骤 2：改 `app/image-store.js`**

删掉 `loadViaImg` / `decode` / `releaseSource` / `drawTo` 四个函数（第 15–86 行），在 import 区加上：

```js
import { decode, drawTo, releaseSource } from './canvas-image.js';
```

其余代码一行都不动（`prepareFile` 里的调用点签名完全相同）。

- [ ] **步骤 3：确认没有残留的引用**

运行：`D:\node.exe --test --test-isolation=none`

预期：247 pass / 0 fail（`image-store.js` 不在 Node 测试范围里，这一步只是确认没有把 import 图改坏）

再运行一次搜索确认 `image-store.js` 里已经没有这四个函数的定义：

```powershell
Select-String -Path app/image-store.js -Pattern 'function (loadViaImg|decode|releaseSource|drawTo)'
```

预期：无输出

- [ ] **步骤 4：Commit**

```bash
git add app/canvas-image.js app/image-store.js
git commit -m 'refactor(image): 图片编解码工具抽到 canvas-image.js 供背景图复用'
```

- [ ] **步骤 5：发票图片的回归验证（不能省）**

这条路径没有自动化测试，只能手动走一遍：

1. 起本地服务：`D:\node.exe scripts/dev-server.js`
2. 打开账单 → 记一笔 → 关联发票 → **从相册选一张竖拍的照片**（关键：验证 EXIF 方向那一条没在搬运中丢掉）
3. 确认：预览正立、缩略图出现在发票列表里、保存后重新打开还在
4. 再选一个 PDF 走一遍（验证 `prepareFile` 里 PDF 分支没被影响）

**任何一步不对就停下修**，不要带着这个问题往下做——后面 10 个任务都建立在「发票功能没坏」这个前提上。

---

## 任务 6：`assets` 表与 `DB_VERSION` 3

**文件：**
- 修改：`app/schema.js`
- 修改：`tests/schema.test.js`

- [ ] **步骤 1：改测试（先让它红）**

`tests/schema.test.js` 三处：

第 107–111 行，`8 个仓库` 改成 `9 个仓库` 并把 `assets` 加进数组（`sort()` 之后 `assets` 排在最前）：

```js
test('STORES 覆盖全部 9 个仓库且每个都有 keyPath', () => {
  assert.deepEqual(
    Object.keys(STORES).sort(),
    ['accounts', 'assets', 'categories', 'invoiceFiles', 'invoices', 'receivables', 'reimbursements', 'settings', 'txns']
  );
  for (const [name, def] of Object.entries(STORES)) {
    assert.equal(typeof def.keyPath, 'string', `${name} 缺少 keyPath`);
    assert.ok(Array.isArray(def.indexes), `${name} 缺少 indexes 数组`);
  }
});
```

第 156–159 行，加 `assets`：

```js
  assert.deepEqual(
    [...db.created.keys()],
    ['accounts', 'categories', 'receivables', 'invoices', 'invoiceFiles', 'reimbursements', 'assets']
  );
```

第 186–188 行：

```js
test('DB_VERSION 已提到 3', () => {
  assert.equal(DB_VERSION, 3);
});
```

再在第 166 行那组「发票三张表」之后追加一条：

```js
test('STORES 里有外观系统的 assets 表', () => {
  assert.ok(STORES.assets, '缺少 assets 表');
  assert.equal(STORES.assets.keyPath, 'id');
  assert.deepEqual(STORES.assets.indexes, [], 'assets 不需要索引：它只有一个固定主键');
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`D:\node.exe --test --test-isolation=none tests/schema.test.js`

预期：4 个测试 FAIL（仓库清单少一个、迁移清单少一个、DB_VERSION 是 2、assets 不存在）

- [ ] **步骤 3：改 `app/schema.js`**

```js
// 2 → 3：外观系统新增 assets 表（背景照片）。
export const DB_VERSION = 3;
```

在 `STORES` 里 `reimbursements` 之后追加：

```js
  // 外观系统的资源表：目前只有一张背景照片，id 固定 'bg'。
  // 为什么不塞进 settings：settings 是 JSON 值，图片只能存 base64（体积膨胀 1/3），
  // 而且每次 getSetting/getAll('settings') 都会把这几百 KB 的字符串一起读进内存。
  // 与 invoiceFiles 单独一张表是同一个理由。
  assets: { keyPath: 'id', indexes: [] }
```

- [ ] **步骤 4：运行测试确认通过**

运行：`D:\node.exe --test --test-isolation=none`

预期：全部 PASS（总数应为 247 + 任务 1~4 新增的 + 本任务新增的 1 个）

- [ ] **步骤 5：Commit**

```bash
git add app/schema.js tests/schema.test.js
git commit -m 'feat(schema): 新增 assets 表存放背景照片，DB_VERSION 升到 3'
```

---

## 任务 7：`app/theme-store.js` —— 读取、应用、跟随系统

**文件：**
- 创建：`app/theme-store.js`

- [ ] **步骤 1：写模块骨架与「应用」逻辑**

```js
// 外观的应用层：读设置、把变量写进页面、管理背景照片。
// 与 theme.js 的分工：theme.js 只「算」（纯函数、可以在 Node 里单测），
// 这里只「做」（碰 document、IndexedDB、Canvas），两边都不越界。
// 本模块依赖 DOM 与 indexedDB，因此不能在 Node 里 import。

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

// 背景图的 blob URL。同一份 Blob 只建一次，换图/移除时先 revoke 旧的——
// 漏掉 revoke 就是每换一次图泄漏一整张照片的内存。
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
 * 把所有变量与三个属性一次性写到 <html> 上。
 *
 * 用 inline style 而不是切 class：色板的唯一真相在 theme.js 里，
 * 若同时存在一份 CSS 规则表，两处就会各自漂移——而测试读不到 CSS，
 * 漂移的结果是「某套皮肤在深色下数字看不清」这种没人会发现的问题。
 * inline style 的优先级天然高于任何样式表规则，不存在「哪条赢」的疑问。
 *
 * data-* 三个属性是留给 CSS 与调试用的钩子（也是验收时肉眼确认状态的抓手）。
 */
function paint() {
  const root = document.documentElement;
  const vars = themeCssVars(applied.preset, applied.mode, { photo: applied.photo });
  for (const [key, value] of Object.entries(vars)) root.style.setProperty(key, value);
  root.dataset.theme = applied.preset;
  root.dataset.mode = applied.mode;
  root.dataset.photo = applied.photo ? 'on' : 'off';
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
```

- [ ] **步骤 2：加 `initTheme` 与三个写入口**

继续追加：

```js
/**
 * 启动时读设置并应用。**必须在首屏渲染之前完成**，晚一帧就是
 * 「先闪一下默认蓝、再变成暖纸」。main.js 的 render() 会 await 它。
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
  applyPhoto().catch(err => console.error('背景照片加载失败，按没有背景处理', err));
  attachSystemListener();
  return currentTheme();
}

export async function setPreset(themeId) {
  const preset = normalizePreset(themeId);
  applied.preset = preset;
  await setSetting(PRESET_KEY, preset);
  paint();
}

export async function setMode(mode) {
  applied.modeChoice = normalizeMode(mode);
  applied.mode = resolveMode(applied.modeChoice, systemDark());
  await setSetting(MODE_KEY, applied.modeChoice);
  paint();
}
```

- [ ] **步骤 3：语法自检**

运行：`D:\node.exe --check app/theme-store.js`

预期：无输出（退出码 0）

- [ ] **步骤 4：Commit**

```bash
git add app/theme-store.js
git commit -m 'feat(theme): theme-store 读取并应用外观设置'
```

---

## 任务 8：背景照片的压缩、存取与遮罩

**文件：**
- 修改：`app/theme-store.js`

- [ ] **步骤 1：加照片相关实现**

在 `app/theme-store.js` 顶部的 import 区补：

```js
import { decode, drawTo, releaseSource } from './canvas-image.js';
import { MAX_EDGE, JPEG_QUALITY } from './image-scale.js';
```

在文件末尾追加：

```js
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
    releaseSource(source);
  }
}

/**
 * 把照片相关的三个变量写进页面。
 * url 为 null 表示「没有背景」，此时两层背景都撤掉，整层等于不存在。
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
  // 遮罩层压着照片：颜色由 --scrim-rgb（皮肤 × 深浅决定，切深浅时自动跟着变）
  // 与 --scrim-a（滑块决定）合成。
  root.style.setProperty('--bg-scrim',
    'linear-gradient(rgba(var(--scrim-rgb), var(--scrim-a)), rgba(var(--scrim-rgb), var(--scrim-a)))');
  root.style.setProperty('--scrim-a', String(scrimAlpha(applied.overlay)));
}

/**
 * 从库里读出背景图并应用。
 * 「设置里指向一张不存在的图」是真实存在的情况：备份里只有设置没有图、
 * 或用户在导入后删掉了 assets 记录。这种时候按「没有背景」处理，
 * 并把设置一并清掉——留着它只会让每次启动都白读一次库。
 */
async function applyPhoto() {
  const bg = normalizeBackground(await getSetting(BACKGROUND_KEY, null));
  const row = bg ? await db.get('assets', bg.assetId) : null;
  const blob = row?.blob ?? null;
  if (!blob) {
    if (bg) await setSetting(BACKGROUND_KEY, null);
    applied.photo = false;
    applied.overlay = OVERLAY_DEFAULT;
    setPhotoVars(null);
    paint();
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
  await setSetting(BACKGROUND_KEY, { assetId: BACKGROUND_ASSET_ID, overlay: applied.overlay, createdAt });
  await applyPhoto();
  return currentTheme();
}

/** 移除背景：删记录、清设置、撤掉两层背景。照片是**用户自己选的**，删掉就是删掉。 */
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
  const bg = normalizeBackground(await getSetting(BACKGROUND_KEY, null));
  if (!bg) return currentTheme(); // 没有背景图时滑块不该存在，走到这里说明状态不同步，忽略
  applied.overlay = normalizeOverlay(value);
  await setSetting(BACKGROUND_KEY, { ...bg, overlay: applied.overlay });
  if (photoUrl) document.documentElement.style.setProperty('--scrim-a', String(scrimAlpha(applied.overlay)));
  return currentTheme();
}
```

（`normalizeOverlay` 要补进从 `./theme.js` 的 import 清单里。）

- [ ] **步骤 2：语法自检**

运行：`D:\node.exe --check app/theme-store.js`

预期：无输出（退出码 0）

- [ ] **步骤 3：Commit**

```bash
git add app/theme-store.js
git commit -m 'feat(theme): 背景照片的压缩、存取与遮罩调节'
```

---

## 任务 9：`body::before` 背景层与兜底变量

**文件：**
- 修改：`styles/base.css`

- [ ] **步骤 1：在 `:root` 里补兜底变量**

在 `styles/base.css` 的 `:root` 块末尾（`color-scheme` 那一行之前）加：

```css
  /* 背景照片相关。JS 没跑完的那一帧、或主题初始化失败时，这几个值必须让整层「等于不存在」，
     否则会看到一块纯黑或纯白的遮罩盖住整个 app。 */
  --bg-image: none;
  --bg-scrim: none;
  --scrim-rgb: 255, 255, 255;
  --scrim-a: .3;
```

- [ ] **步骤 2：加背景层**

在 `body { … }` 规则之后追加：

```css
/* 背景照片层。
   为什么用伪元素而不是给 body 加 background-image：body 的背景要与 --surface 的卡片、
   遮罩的层叠顺序分开管，伪元素能单独拿到 z-index: -1。
   为什么 z-index 是负的：装饰层不参与内容层叠，负值让它在 body 背景之上、
   在所有真实内容之下——比给内容逐个抬 z-index 干净得多。 */
body::before {
  content: '';
  position: fixed;
  inset: 0;
  z-index: -1;
  background-image: var(--bg-scrim), var(--bg-image);
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
  /* 这一层盖住整屏，不关掉命中测试就会把所有的点击都吃掉。 */
  pointer-events: none;
}
```

**不要**用 `background-attachment: fixed`：移动端 WebView 对它的 `cover` 处理不一致，而这个伪元素本来就是 `position: fixed`，不随滚动移动。

- [ ] **步骤 3：肉眼确认默认状态没变化**

起本地服务：`D:\node.exe scripts/dev-server.js`，打开首页。

预期：**与改动前完全一样**（没有照片时 `--bg-image` 与 `--bg-scrim` 都是 `none`，两层都是空）。

- [ ] **步骤 4：Commit**

```bash
git add styles/base.css
git commit -m 'feat(styles): body::before 背景照片层'
```

---

## 任务 10：`main.js` 首屏接入（不闪色）

**文件：**
- 修改：`app/main.js`

- [ ] **步骤 1：加 import 与模块级 promise**

在 `app/main.js` 的 import 区加：

```js
import { initTheme } from './theme-store.js';
```

在 `let renderSeq = 0;` 之前加：

```js
// 主题必须在任何 mount 之前应用，否则每次冷启动都会「先闪一下默认色、再变成选中的皮肤」。
// 为什么不放在文件末尾直接 await：onChange(render) 是同步注册、可能同步触发第一次渲染，
// 把它挂在渲染路径上，无论谁先触发都保证「主题先行」。
// .catch 兜底：主题出错不该拖垮整页——照常渲染，只是外观是默认的（比白屏好得多）。
let themeReady = null;
```

- [ ] **步骤 2：在 `render()` 里 await 它**

`render()` 函数体开头（`const seq = ++renderSeq;` 之后、`const renderers = …` 之前）插入：

```js
  await (themeReady ??= initTheme().catch(err => {
    console.error('主题初始化失败，用默认外观', err);
  }));
```

- [ ] **步骤 3：验证不闪色**

1. 起本地服务，打开 app
2. 设置 → 外观与背景 → 选「暖纸」
3. **硬刷新**（Ctrl+Shift+R）

预期：刷新后第一眼就是暖纸的米色底，看不到一闪而过的默认灰蓝。

4. 再打开浏览器的性能面板确认 `data-theme="paper"` 在首次绘制前就已设在 `<html>` 上（在 Console 里执行 `document.documentElement.dataset.theme` 应返回 `'paper'`）。

- [ ] **步骤 4：Commit**

```bash
git add app/main.js
git commit -m 'feat(theme): 首屏渲染前应用外观设置，避免闪色'
```

---

## 任务 11：「外观与背景」面板

**文件：**
- 创建：`app/ui/appearance-sheet.js`
- 创建：`styles/appearance.css`
- 修改：`index.html`

- [ ] **步骤 1：创建 `app/ui/appearance-sheet.js`**

```js
// 「外观与背景」面板：皮肤 / 深浅 / 背景照片。
//
// 所有改动**立即生效**，没有「保存」按钮：外观是所见即所得的东西，
// 多一步确认只会让人犹豫「我到底改没改」。关掉面板就是接受当前的样子。
import { el, mount } from './dom.js';
import { openSheet } from './sheet.js';
import { THEMES, THEME_TOKENS, OVERLAY_MIN, OVERLAY_MAX } from '../theme.js';
import {
  currentTheme, setPreset, setMode, setPhoto, removePhoto, setOverlay
} from '../theme-store.js';

const MODE_OPTIONS = [
  { id: 'auto', label: '跟随系统' },
  { id: 'light', label: '浅色' },
  { id: 'dark', label: '深色' }
];

// 皮肤卡上的小色块：底色用该皮肤的 --bg，中间的圆点用 --accent。
// 这两个颜色就是用户切换时最先感受到的差异，所以拿它们当预览。
function themeChip(themeId) {
  const tokens = THEME_TOKENS[themeId].light;
  const chip = el('span', { class: 'theme-chip' });
  chip.style.background = tokens['--bg'];
  chip.style.borderColor = tokens['--border'];
  const dot = el('span', { class: 'theme-dot' });
  dot.style.background = tokens['--accent'];
  chip.append(dot);
  return chip;
}

export function openAppearanceSheet() {
  const container = el('div', { class: 'stack' });
  // 选图期间用户可能连点两次「选择图片」：第二次进来时第一次的压缩还没写完，
  // 两条流程会各自写一次 assets 并各自建一个 blob URL，先建的那个就漏了。
  let picking = false;

  const sheet = openSheet({ title: '外观与背景', body: container });

  function renderPresets(state) {
    return el('div', { class: 'stack' }, [
      el('div', { class: 'field-label', text: '配色' }),
      el('div', { class: 'theme-row' }, THEMES.map(t => {
        const selected = t.id === state.preset;
        return el('button', {
          class: selected ? 'theme-card on' : 'theme-card',
          type: 'button',
          dataset: { theme: t.id },
          'aria-pressed': String(selected),
          onclick: async () => {
            await setPreset(t.id);
            await rerender();
          }
        }, [themeChip(t.id), el('span', { class: 'theme-name', text: t.name })]);
      }))
    ]);
  }

  function renderModes(state) {
    return el('div', { class: 'stack' }, [
      el('div', { class: 'field-label', text: '深浅' }),
      el('div', { class: 'seg-row' }, MODE_OPTIONS.map(m => {
        const selected = m.id === state.modeChoice;
        return el('button', {
          class: selected ? 'seg on' : 'seg',
          type: 'button',
          dataset: { mode: m.id },
          'aria-pressed': String(selected),
          text: m.label,
          onclick: async () => {
            await setMode(m.id);
            await rerender();
          }
        });
      }))
    ]);
  }

  function renderPhoto(state) {
    const fileInput = el('input', {
      type: 'file', accept: 'image/*', class: 'hide-file',
      onchange: async e => {
        const file = e.target.files?.[0];
        // 先清空 value：同一张图连选两次不会触发 change，用户会觉得按钮坏了。
        e.target.value = '';
        if (!file || picking) return;
        picking = true;
        try {
          await setPhoto(file);
        } catch (err) {
          console.error('背景图设置失败', err);
          // 与发票图片那条路一致：给一句能照着做的话，而不是把 IndexedDB 的英文异常甩出去。
          alert('这张照片没能设成背景：' + (err?.message || err));
        } finally {
          picking = false;
          await rerender();
        }
      }
    });

    const pick = el('button', {
      class: 'btn', type: 'button', dataset: { action: 'pick-photo' },
      text: state.photo ? '换一张' : '选择图片',
      onclick: () => fileInput.click()
    });

    if (!state.photo) {
      return el('div', { class: 'stack' }, [
        el('div', { class: 'field-label', text: '背景照片' }),
        el('div', { class: 'photo-row' }, [pick, fileInput]),
        el('div', { class: 'hint-text', text: '选一张照片铺在卡片下面。照片会压到长边 1600 像素后存进手机，并跟着备份一起走。' })
      ]);
    }

    const slider = el('input', {
      type: 'range', class: 'ov-range',
      min: String(OVERLAY_MIN), max: String(OVERLAY_MAX), step: '5',
      'aria-label': '背景遮罩强度',
      oninput: e => {
        valueLabel.textContent = e.target.value + '%';
        setOverlay(e.target.value);
      }
    });
    // range 的初值用 property 设而不是属性：setAttribute('value') 在部分内核上
    // 只改默认值、不改当前值，滑块会停在最左端。
    slider.value = String(state.overlay);
    const valueLabel = el('span', { class: 'ov-value', text: state.overlay + '%' });

    return el('div', { class: 'stack' }, [
      el('div', { class: 'field-label', text: '背景照片' }),
      el('div', { class: 'photo-row' }, [pick, fileInput,
        el('button', {
          class: 'btn btn-ghost', type: 'button', dataset: { action: 'remove-photo' },
          text: '移除',
          onclick: async () => { await removePhoto(); await rerender(); }
        })
      ]),
      el('div', { class: 'ov-row' }, [el('span', { class: 'ov-label', text: '遮罩' }), slider, valueLabel]),
      el('div', { class: 'hint-text', text: '遮罩是压在照片上的一层。数字看不清就把它调大。' })
    ]);
  }

  // 每次状态变化整块重建：面板内容不多，重建比逐节点同步简单得多，
  // 也不会出现「按钮的高亮和实际皮肤不一致」这种两处状态各写一半的问题。
  async function rerender() {
    const state = currentTheme();
    mount(container, [renderPresets(state), renderModes(state), renderPhoto(state)]);
  }

  rerender();
  return sheet;
}
```

- [ ] **步骤 2：创建 `styles/appearance.css`**

```css
/* 外观与背景面板的样式。变量全部来自主题（--surface / --accent / …），
   所以这几十行在五套皮肤 × 深浅下都自动成立，不需要任何一套单独的特例。 */

.theme-row {
  display: flex;
  gap: 8px;
}

.theme-card {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 10px 4px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
}

/* 选中的皮肤：描边 + 一点点底色。不用阴影：面板本身就是浮层，
   再叠阴影会让「哪张被选中」变得要靠猜。 */
.theme-card.on {
  border-color: var(--accent);
  background: var(--accent-weak);
}

.theme-chip {
  width: 34px;
  height: 34px;
  border-radius: 9px;
  border: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: center;
}

.theme-dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
}

.theme-name {
  font-size: var(--font-xs);
}

.seg-row {
  display: flex;
  gap: 8px;
}

.seg {
  flex: 1;
  padding: 9px 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: var(--text);
  font-size: var(--font-md);
  cursor: pointer;
}

.seg.on {
  border-color: var(--accent);
  background: var(--accent-weak);
  color: var(--accent);
  font-weight: 600;
}

.photo-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 真正的 file input 藏起来：它的原生外观在五套皮肤下都没法看，
   而它必须留在 DOM 里（用按钮的 click() 触发）。 */
.hide-file {
  display: none;
}

.ov-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-top: 4px;
}

.ov-label {
  font-size: var(--font-sm);
  color: var(--text-2);
}

.ov-range {
  flex: 1;
  accent-color: var(--accent);
}

/* 数值单独占一列定宽，拖动时右侧数字变化不会把左边滑块挤来挤去。 */
.ov-value {
  width: 40px;
  text-align: right;
  font-size: var(--font-sm);
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}

.hint-text {
  font-size: var(--font-xs);
  color: var(--text-2);
  line-height: 1.6;
}
```

- [ ] **步骤 3：在 `index.html` 里引入样式**

在 `styles/invoice.css` 那一行之后加：

```html
<link rel="stylesheet" href="./styles/appearance.css">
```

- [ ] **步骤 4：手动验证**

起本地服务，打开设置 → 外观与背景（入口在任务 12 才接上，本步可以临时在 Console 里调 `import('./app/ui/appearance-sheet.js').then(m => m.openAppearanceSheet())` 验证）。

预期：面板打开，五张皮肤卡显示各自的底色与强调色圆点；点一张，整个界面立刻换色；深浅三个按钮可切换；没有照片时只有「选择图片」按钮。

- [ ] **步骤 5：Commit**

```bash
git add app/ui/appearance-sheet.js styles/appearance.css index.html
git commit -m 'feat(appearance): 外观与背景面板'
```

---

## 任务 12：设置入口

**文件：**
- 修改：`app/ui/settings-sheet.js`

- [ ] **步骤 1：加 import 与入口**

import 区加：

```js
import { openAppearanceSheet } from './appearance-sheet.js';
```

`SETTINGS_ENTRIES` 里，在 `budget` 那一项之后、`backup` 之前插入：

```js
  // 外观排在记账配置之后、数据进出之前：它既不是每天要改的记账配置，
  // 也不是「把数据搬进搬出」那种一次性动作，但它是用户会想反复调的那一类。
  { id: 'appearance', label: '外观与背景', open: openAppearanceSheet },
```

注意 `open` 的签名要与其它入口一致（都收 `{ onChanged }`）——`swapTo` 会传这个参数进去，`openAppearanceSheet` 忽略它没问题，但不能因此报错（它接的是无参调用，多传一个对象不会有影响）。

- [ ] **步骤 2：手动验证**

起本地服务 → 首页右下角齿轮 → 设置面板。

预期：列表里出现「外观与背景 ›」，位置在「预算设置」和「备份与恢复」之间；点它，设置面板先关闭、约 200ms 后外观面板滑出（**不能两层同时挂着**——这是 `swapTo` 机制的既有约定）。

- [ ] **步骤 3：Commit**

```bash
git add app/ui/settings-sheet.js
git commit -m 'feat(appearance): 设置面板加入外观入口'
```

---

## 任务 13：备份带上背景照片

**这个任务是本次最容易漏的接缝。** `invoiceFiles` 那次就是因为在设计里写了「备份是整表导出、不用改」而漏掉 `name` 字段，直到换机才暴露。所以导出与导入两段代码必须**成对**写，评审时逐行对照。

**文件：**
- 修改：`app/backup.js`
- 修改：`app/backup-store.js`

- [ ] **步骤 1：`buildBackup` 带上 background**

`app/backup.js` 的 `buildBackup` 里，在 `vault` 那一行之前加：

```js
      // 背景照片（base64）与它的遮罩强度。与 invoiceFiles 同理**刻意不深拷贝**：
      // 它是一张一两百 KB 的 base64 串，structuredClone 会白复制一份，而数组由调用方现造现交。
      background: payload.background ?? null,
```

- [ ] **步骤 2：导出侧**

`app/backup-store.js`：在文件顶部常量区（`ARRAY_STORES` 附近）加：

```js
// 外观设置里的三个键名。背景图本身存在 assets 表里（见 schema.js），
// 这里只需要知道设置里那一行叫什么。
const BACKGROUND_KEY = 'backgroundImage';
const BACKGROUND_ASSET_ID = 'bg';
```

在 `exportBackup` 里，`encodeFiles` 那一段之后、`buildBackup` 之前加：

```js
  // 背景照片单独打包成 data.background。它与「不含图片」开关**无关**：
  // 它是外观设置的一部分，压缩后只有一两百 KB，而「换机后背景丢了、找不回来」
  // 是没法补救的（用户自己选的那张照片可能早就删了）。
  const background = await encodeBackground(settings);
```

并把 `buildBackup` 那一行改成：

```js
  const pkg = buildBackup({ ...arrays, settings, vault, invoiceFiles, background }, now);
```

在 `encodeFiles` 的定义之后加：

```js
/**
 * 把背景照片编码进备份包。
 * 任何一步失败都返回 null 而不是抛错：一张背景图不该把整次导出打回去——
 * 导出是用户保住账目的唯一手段，而账目比背景重要得多（与 encodeFiles 里
 * 「跳过脏记录」同一条纪律）。
 * settings 传进来是为了取那份设置里的遮罩强度：照片与遮罩必须一起走，
 * 否则恢复回来的是张原图配默认强度的背景，而用户调过的那个值悄悄丢了。
 */
async function encodeBackground(settings) {
  try {
    const row = await db.get('assets', BACKGROUND_ASSET_ID);
    const blob = row?.blob ?? null;
    if (!blob) return null;
    const image = await blobToBase64(blob);
    if (!image) return null;
    const meta = settings.find(r => r?.key === BACKGROUND_KEY)?.value ?? null;
    return {
      overlay: Number(meta?.overlay) >= 0 ? Number(meta.overlay) : null,
      createdAt: Number(row.createdAt) || null,
      mime: row.mime || 'image/jpeg',
      image
    };
  } catch (err) {
    console.warn('背景照片读不出来，这次备份不带它', err);
    return null;
  }
}
```

- [ ] **步骤 3：导入侧**

在 `importBackup` 里，`invoiceFiles` 那个循环之后、`settings` 校验之前加：

```js
  // 背景照片：与 invoiceFiles 同一条路（Blob 进不了 JSON，只能单独反解），
  // 但**不参与 clears**，也不在「备份里没有就删本机」的范畴里：
  //   · 备份里带了背景 → 覆盖 assets 里那一条（id 固定 'bg'，直接 put 就是覆盖）；
  //     遮罩强度不需要在这里写回，它随 settings 表整体覆盖，已经跟着走了。
  //   · 备份里没带背景（老备份，或那次导出时读图失败）→ 什么都不做。
  //     此时设置里那条 backgroundImage 会被 settings 的整体覆盖带走，
  //     即使残留一个指向不存在记录的 assetId，theme-store 的 applyPhoto 也会
  //     按「没有背景」优雅降级并顺手清掉它。
  const bg = data.background;
  if (bg && typeof bg === 'object') {
    const bgBlob = base64ToBlob(bg.image, bg.mime);
    if (bgBlob) {
      puts.push({
        store: 'assets',
        value: {
          id: BACKGROUND_ASSET_ID,
          blob: bgBlob,
          mime: bg.mime || 'image/jpeg',
          size: Number(bgBlob.size) || 0,
          createdAt: Number(bg.createdAt) || Date.now()
        }
      });
    }
  }
```

**注意**：`clears` 列表**不要**加 `assets`（保持原样）。理由写在 `clears` 那段注释已有的纪律里：没有替补的东西一律不删——备份里没带背景时清空 assets，只会删掉本机唯一一张背景图，而文件里并没有它的替补。

- [ ] **步骤 4：跑测试**

运行：`D:\node.exe --test --test-isolation=none`

预期：全部 PASS。**如果 `tests/backup*.test.js` 里有对 `data` 字段形状的断言被打红**，说明那条断言是「只认这几个键」的写法——读一下它是想守住什么，然后决定是把 `background` 加进白名单，还是把断言改成「包含」而非「完全相等」。把判断理由写进注释。

- [ ] **步骤 5：手动跑一次完整往返（这一步不能省）**

1. 起本地服务，设置一张背景照片（遮罩调成非默认值，比如 45%）
2. 猜一下：备份 → 导出（记下文件大小）
3. 在站点的 IndexedDB 里清空 `assets` 表（DevTools → Application → IndexedDB → pvault → assets → 右键 Clear），刷新页面确认背景消失
4. 备份 → 导入刚才那个文件，输入密码
5. 确认：背景回来了，且遮罩是 45% 而不是默认的 30%

**第 5 步的「45%」是关键**：只验「背景回来了」会漏掉「遮罩强度没跟着走」这种一半成功的恢复。

- [ ] **步骤 6：Commit**

```bash
git add app/backup.js app/backup-store.js
git commit -m 'feat(backup): 备份携带背景照片与遮罩强度'
```

---

## 任务 14：Service Worker 白名单与缓存版本

**文件：**
- 修改：`sw.js`

- [ ] **步骤 1：改 `CACHE` 与 `ASSETS`**

```js
const CACHE = 'pvault-v16';
```

在 `ASSETS` 数组里加（位置与其它条目保持一致的书写风格）：

```js
  './app/canvas-image.js',
  './app/theme.js',
  './app/theme-store.js',
  './app/ui/appearance-sheet.js',
  './styles/appearance.css',
```

- [ ] **步骤 2：核对每个文件都真的存在**

`cache.addAll` 是**原子**的：一个 404 就让整次安装失败，而失败的表现是「离线打开是白屏」——很难联想到是一个路径写错。

```powershell
$paths = Select-String -Path sw.js -Pattern "'\./([^']+)'" -AllMatches |
  ForEach-Object { $_.Matches } | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
$missing = $paths | Where-Object { -not (Test-Path $_) }
if ($missing) { Write-Host "缺失：`n$($missing -join "`n")" } else { Write-Host "全部存在，共 $($paths.Count) 个" }
```

预期：`全部存在，共 61 个`（56 + 5 个新增）

- [ ] **步骤 3：验证离线可用**

1. 起本地服务，打开一次（让 SW 装上）
2. DevTools → Application → Service Workers 勾 Offline
3. 刷新页面

预期：页面正常打开、账目都在。**如果白屏**，看 Application → Cache Storage 里 `pvault-v16` 是否存在——不存在就是 `addAll` 被某个 404 整批拒绝了。

- [ ] **步骤 4：Commit**

```bash
git add sw.js
git commit -m 'chore(sw): 新模块进预缓存白名单，缓存版本升到 v16'
```

---

## 任务 15：手动验证清单、全量回归与模拟器验收

**文件：**
- 修改：`docs/手动验证清单.md`

- [ ] **步骤 1：清单里加外观章节**

在 `docs/手动验证清单.md` 末尾追加：

```markdown
## 外观与背景

### 皮肤与深浅
- [ ] 设置 → 外观与背景，五套皮肤逐一点一遍，界面立刻换色
- [ ] 每套皮肤在浅色与深色下各看一眼，确认没有元素变成透明块或黑块
- [ ] 选一套非默认皮肤，切到别的 Tab 再切回来，颜色保持
- [ ] 完全退出 app 再打开（不是刷新），皮肤仍然是选中的那套
- [ ] 深浅选「跟随系统」，然后改系统的深色开关，app 实时跟着变
- [ ] 深浅选「浅色」，系统切到深色，app **不**跟着变（手动选择必须压过系统）

### 背景照片
- [ ] 从相册选一张竖拍照片，确认背景铺满、没有拉伸变形、方向正确
- [ ] 遮罩 0% / 30% / 60% 各看一眼，确认数字的可读性变化符合直觉
- [ ] 开启照片后确认**密码箱里的密码正文、账户余额、记账首页的大数字**仍然清晰（这些不该半透明）
- [ ] 点「移除」，确认背景消失且卡片恢复不透明
- [ ] 换一张图，确认旧图没有残留在界面上
- [ ] 老库升级：用 v1.2.0 的数据打开新版本，确认账目 / 发票 / 密码箱一条不少（**这是 assets 表迁移的验证**）

### 备份
- [ ] 导出含背景的备份，确认体积增幅在预期内（约 +100~400KB）
- [ ] 清掉 assets 表后导入该备份，确认背景回来了、**且遮罩强度与导出前一致**
- [ ] 导入一份**没有背景**的老备份，确认 app 不报错、背景按「没有」处理
```

- [ ] **步骤 2：全量回归**

运行：`D:\node.exe --test --test-isolation=none`

预期：全部 PASS，0 fail。**总数必须大于 247**（新增了 theme 与 schema 的测试）。

- [ ] **步骤 3：模拟器上跑一遍**

模拟器与 CDP 的用法见 `docs/手动验证清单.md` 的「模拟器实测记录」一节。至少覆盖：

1. 五套皮肤 × 深/浅逐个切换并截图
2. 用 CDP 往页面里注入一个 `File`（走 `DataTransfer`，系统选择器驱动不了）验证背景照片全流程
3. 备份往返（导出 → 清 assets → 导入）
4. 从 v1.2.0 的库升级到 v3（把旧库的 IndexedDB 目录保留、换新代码打开）

- [ ] **步骤 4：Commit**

```bash
git add docs/手动验证清单.md
git commit -m 'docs: 手动验证清单加入外观与背景章节'
```

---

## 自检

**规格覆盖度**

| 规格章节 | 对应任务 |
|---|---|
| §4.1 settings 三个键 | 任务 7、8 |
| §4.2 `assets` 表 + DB_VERSION 3 | 任务 6 |
| §4.3 备份包 `data.background` | 任务 13 |
| §5.1 单一数据源 `theme.js` | 任务 1–4 |
| §5.2 变量清单 | 任务 1（齐全性测试）、任务 4 |
| §5.3 五套皮肤色值 | 任务 1 |
| §5.4 应用机制 / 首屏不闪 / 跟随系统 / blob URL | 任务 7、8、10 |
| §6.1 存储与压缩 | 任务 5、8 |
| §6.2 渲染（`body::before`） | 任务 9 |
| §6.3 可读性（`--surface` 半透明、`--surface-2` 不变） | 任务 4、9 |
| §7 备份与恢复 | 任务 13 |
| §8 UI | 任务 11、12 |
| §9 测试 | 任务 1–4、6、13、15 |
| §10 接缝清单 | 任务 5、6、13、14；`build-apk.ps1` 不用改（整目录复制） |
| §13 手动验证清单 | 任务 15 |

**占位符扫描**：无「待定 / TODO / 后续实现」；每个代码步骤都给了可直接粘贴的代码。

**类型与命名一致性**（跨任务核对）

- `BACKGROUND_ASSET_ID`：任务 7 定义并导出，任务 13 的 `backup-store.js` 里**再定义一次**（模块之间不共享常量是有意的——`backup-store.js` 不该 import 一个依赖 DOM 的模块；两处都用 `'bg'` 这个字面量，任务 13 的注释里写明了它是同一把钥匙）。
- `normalizeOverlay`：任务 3 定义，任务 8 的 `setOverlay()` 使用（任务 8 步骤 1 特别提醒把它补进 import 清单）。
- `setPhoto` / `removePhoto` / `setOverlay` / `setPreset` / `setMode` / `currentTheme`：任务 7–8 导出，任务 11 的面板按这套名字 import。
- `themeCssVars(themeId, mode, { photo })`：任务 4 定义，任务 7 的 `paint()` 调用。
- `decode` / `drawTo` / `releaseSource`：任务 5 从 `canvas-image.js` 导出，任务 8 的 `encodeBackground()` 使用。
- `mount`：任务 11 从 `./dom.js` import（`dom.js` 确实导出 `mount`）。
