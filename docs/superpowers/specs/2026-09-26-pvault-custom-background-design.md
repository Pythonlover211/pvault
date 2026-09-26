# pvault · 自定义背景 设计规格

> 状态：待用户审查
> 日期：2026-09-26
> 项目目录：`E:\codex-project\pvault`
> 前置：OFD 导入 v1.2.0（HEAD `792db9e`）
> 形态：PWA + 本地打包 APK（两条分发路径并存）

---

## 0. 一句话

给 pvault 加一套**外观系统**：五套配色皮肤（各带浅色与深色两版，深浅可跟随系统或手动指定），外加**用自己相册里的照片当背景**——并且保证开了照片之后，数字依然看得清。

---

## 1. 澄清阶段的两个决定（逐条来自用户选择）

| 问题 | 用户的选择 |
|---|---|
| 自定义到什么程度 | **C · 配色 + 照片都要** |
| 是否用 UI 设计技能来做 | **是**——用户原话：「利用那个ui skill设计」 |

**用户原话（保留措辞）**

- 「帮我添加一个功能，可以自定义背景」
- 「利用那个ui skill设计」

**给出的三个范围选项与用户的取舍**

| 选项 | 内容 | 用户 |
|---|---|---|
| A | 只做配色皮肤（换色调，不涉及图片） | 未选 |
| B | 只做照片背景（配色沿用现状） | 未选 |
| C | 配色 + 照片都要 | **选中** |

---

## 2. 明确不做（防止范围蔓延）

| 不做 | 原因 |
|---|---|
| **毛玻璃（`backdrop-filter: blur`）** | `ui-ux-pro-max` 的 Glassmorphism 条目推荐它，但首页是长列表，安卓 WebView 上滚动时逐帧实时模糊会掉帧，而这台机器是日常在用的。改用半透明纯色 + 阴影，视觉差一点，滚动是稳的。**留作后续可选开关，本次不做。** |
| 自定义字体 / 字号 | 用户没提；`Lanxi-*` 系列字体在 PWA 里可用、在 APK 壳里需要额外打包字体文件，是另一件事 |
| 每套皮肤分别配一套圆角/间距 | 皮肤只换颜色。记账首页的布局、圆角、字号一律不动 |
| 多张背景图、轮播、定时切换 | YAGNI。只存一张 |
| 从网络下载壁纸 | 与「数据不离开手机」冲突 |
| 给背景图加滤镜 / 灰度 / 模糊滑块 | 遮罩滑块已经解决可读性；多一个滑块就多一份「调坏了不知道怎么办」 |
| 让用户自己填十六进制色值 | 五套皮肤已经覆盖；自由色盘会带来「任何组合都可能不达标」的对比度责任，而我无法在运行时替他保证 |
| 深色 / 浅色之外的第三态（如「护眼」） | 深浅两态 × 五套皮肤已经是 10 组配色 |

---

## 3. 现状（改动前）

- `styles/base.css` 第 1–44 行：颜色全部集中在 `:root` 的一组 CSS 变量上；深色靠 `@media (prefers-color-scheme: dark)` 覆盖同一批变量。**没有手动指定深浅的能力，也没有第二套配色。**
- `app/store.js` 有 `getSetting(key, fallback)` / `setSetting(key, value)`，底层是 `settings` 表的 `{ key, value }`。
- `app/schema.js`：`DB_VERSION = 2`；`settings` 是 `{ keyPath: 'key' }` 的键值表。`applyMigrations()` 已经能在升版本时补建新表（遍历 `STORES`，谁不在就建谁），所以加表不用改迁移逻辑。
- `app/main.js`：`onChange(render)` 在文件末尾注册；`render()` 内部 `await` 数据后再 `mount()`。**首屏颜色正确的最后一道闸口就在这里。**
- `app/image-scale.js`：纯函数模块（`MAX_EDGE`、`computeTargetSize`、`shouldCompress`…），真正的 Canvas 压缩在 `app/image-store.js`。
- `app/backup-store.js`：`vault` 从 settings 里**单独取出**放进 `data.vault`；`invoiceFiles` 走 `encodeFiles()` 手写字段清单转 base64。
- `scripts/build-apk.ps1`：整个 `app/`、`styles/`、`icons/` 目录递归复制进 `android/app/src/main/assets/www`，**新增文件会自动同步，脚本不用改**。
- `sw.js`：`ASSETS` 是**手写白名单**，`CACHE` 当前 `pvault-v15`。漏加文件 = 离线时 404 = 那个模块加载失败。

---

## 4. 数据模型

### 4.1 settings 新增三个键

| key | 形状 | 默认值 |
|---|---|---|
| `themePreset` | `'default' \| 'paper' \| 'sage' \| 'wisteria' \| 'seaglass'` | `'default'` |
| `themeMode` | `'auto' \| 'light' \| 'dark'` | `'auto'` |
| `backgroundImage` | `{ assetId: string, overlay: number, createdAt: number } \| null` | `null` |

- `overlay` 是遮罩强度百分比，整数，取值 0–60，默认 30。
- 三个键**不加种子、不动 `seedSettings()`**：读取侧一律走 `getSetting(key, fallback)` 的兜底，老库里没有这些键时行为与今天完全一致。这与 `backupReminderDays` 的既有做法一致。

### 4.2 新表 `assets`

```js
assets: { keyPath: 'id', indexes: [] }
```

记录形状：`{ id, blob, mime, size, createdAt }`。

- 背景图固定用 `id: 'bg'`（只存一张，重复选图 = 覆盖同一条）。
- 建表要把 `DB_VERSION` 从 **2 升到 3**。`applyMigrations()` 不用改。
- **为什么不塞进 settings**：settings 是 JSON 值，图片只能存 base64，体积膨胀 33%，而且每次 `getAll('settings')` 都会把几百 KB 的字符串读进内存。这与 `invoiceFiles` 单独一张表是同一个理由。

### 4.3 备份包新增一个顶层字段

```js
data.background = { overlay, createdAt, mime, image /* base64 */ } | null
```

**背景图无条件进备份，不受「不含图片」开关影响。** 理由：它是外观设置的一部分，不是用户的内容图片；压缩后只有一两百 KB，而「换手机后背景丢了、还找不回来」是没法补救的。它进的是与 `vault` 同一个位置（`data` 下面单独一个字段），不走 `invoiceFiles` 那条整表编码的路。

---

## 5. 主题系统

### 5.1 单一数据源：`app/theme.js`

**色板数据全部放在 `app/theme.js` 里，不写在 CSS 里。** CSS 只保留默认皮肤的默认值作为首帧兜底；实际生效的变量由 JS 写进 `document.documentElement` 的 inline style。

这么做的理由（这是本规格最重要的一条决策）：

- 如果色板写在 CSS 里，就是「5 套皮肤 × 2 种深浅 = 10 组规则」写死在样式表里，而对比度测试在 Node 里读不到 CSS（要么写一个 CSS 解析器，要么把色值再抄一份到测试里——**两份真相，必然漂移**）。
- 放在 JS 里，`tests/theme.test.js` 可以直接遍历所有皮肤算对比度，**这才是真正能防住「某套皮肤在深色下数字看不清」的机制**。
- inline style 的优先级天然高于样式表，不存在「哪条规则赢」的问题。

模块导出：

```js
export const THEMES = [ { id, name }, ... ]        // 五套，顺序即面板里的顺序
export const THEME_IDS = THEMES.map(t => t.id)
export const MODES = ['auto', 'light', 'dark']
export const OVERLAY_MIN = 0
export const OVERLAY_MAX = 60
export const OVERLAY_DEFAULT = 30
export const THEME_TOKENS = { [themeId]: { light: {...}, dark: {...} } }

export function normalizePreset(v)          // 未知/缺失 → 'default'
export function normalizeMode(v)            // 未知/缺失 → 'auto'
export function resolveMode(mode, systemDark)   // 'auto' + 系统状态 → 'light' | 'dark'
export function normalizeOverlay(v)         // Number → 取整 → clamp 到 0..60；非数字 → 30
export function normalizeBackground(v)      // 校验形状，非法 → null
export function scrimAlpha(overlay)         // 0..60 → 0..0.6（小数）
export function themeCssVars(themeId, mode, { photo })  // → { '--bg': '#…', … } 的扁平对象
```

`themeCssVars()` 是**唯一**把 (皮肤, 深浅, 有无照片) 翻译成 CSS 变量的地方。开启照片时，它只把 `--surface` 换成 `rgba(var(--surface-rgb), .9)`；`--surface-2` **保持不透明**——垫在它上面的是输入框、次级按钮这些必须看清文字的控件（见 §6.3）。

`app/theme.js` 必须是**纯模块**：不 import `db.js`、不碰 `document`、不碰 `window`，否则 Node 测试跑不起来（与 `file-info.js` 同一纪律）。

### 5.2 变量清单

每套皮肤 × 每种深浅都必须给全下面这一组，一个都不能少：

`--bg`、`--surface`、`--surface-2`、`--surface-rgb`、`--border`、`--text`、`--text-2`、`--text-3`、`--accent`、`--accent-weak`、`--on-accent`、`--shadow`、`--scrim-rgb`

（`--scrim-rgb` 只有两个取值：浅色皮肤 `255,255,255`、深色皮肤 `0,0,0`，但它属于「皮肤 × 深浅」这个维度，所以放在同一张表里由 `themeCssVars()` 一起给。）

**不由 `themeCssVars()` 负责的三个变量**，它们取决于运行时状态而不是配色选择，由 `theme-store.js` 单独 `setProperty`：

| 变量 | 谁设置 | 取值 |
|---|---|---|
| `--bg-image` | 选图/移除时 | `url(blob:…)` 或 `none` |
| `--bg-scrim` | 选图/移除 + 每次切深浅时 | `linear-gradient(rgba(var(--scrim-rgb), var(--scrim-a)), rgba(var(--scrim-rgb), var(--scrim-a)))`；没有照片时 `none` |
| `--scrim-a` | 遮罩滑块每次变化时 | `scrimAlpha(overlay)` 的结果，0–0.6 |

`--radius*`、`--font-*`、`--tab-h`、`--safe-b` 等**不属于皮肤**，继续留在 `base.css` 的 `:root` 里不动。

语义色 `--success` / `--warning` / `--error` / `--overlay` **本次不按皮肤分化**（保持现状一套），理由是它们表达的是固定语义（赚了/警示/出错），而现状的值在五套皮肤的背景上都能用。这条如果将来要改，改的是 `base.css` 而不是 `theme.js`。

### 5.3 五套皮肤的色值

> 下表是设计稿。实现时以 `tests/theme.test.js` 的对比度断言为准——**任何一对不达标的色值当场调整**，不迁就下表。

#### 默认 default（浅色即现状）

| 变量 | 浅色 | 深色 |
|---|---|---|
| `--bg` | `#f2f2f5` | `#131315` |
| `--surface` | `#ffffff` | `#1e1e21` |
| `--surface-2` | `#e9e9ec` | `#2b2b30` |
| `--surface-rgb` | `255,255,255` | `30,30,33` |
| `--border` | `#d5d5da` | `#3a3a40` |
| `--text` | `#1d1d1f` | `#f2f2f5` |
| `--text-2` | `#63636a` | `#9a9aa0` |
| `--text-3` | `#a1a1a6` | `#6e6e73` |
| `--accent` | `#0a6ef0` | `#3b8ef5` |
| `--accent-weak` | `#e6f0fe` | `#16273d` |
| `--on-accent` | `#ffffff` | `#101216` |

**一处顺带修正**：浅色的 `--text-2` 由现状的 `#6e6e73` 调深为 `#63636a`。原因是它落在 `--surface-2` 上时对比度只有约 4.25:1，达不到 AA 的 4.5:1（它出现在输入框、次级按钮这些真的垫在 `--surface-2` 上的地方）。调深后约 4.9:1，肉眼几乎看不出差别。这是本次唯一一处**对现有外观的改动**。

深色的 `--on-accent` 由白改为近黑：现状深色强调色 `#3b8ef5` 上的白字只有约 3.3:1。深色模式下「亮底 + 深字」也是更常见的做法。

#### 暖纸 paper（取自 Book & Reading Tracker：暖棕 + 页黄）

| 变量 | 浅色 | 深色 |
|---|---|---|
| `--bg` | `#fbf7ee` | `#1c1712` |
| `--surface` | `#ffffff` | `#262019` |
| `--surface-2` | `#f3ece0` | `#332a20` |
| `--surface-rgb` | `255,255,255` | `38,32,25` |
| `--border` | `#e4d9c6` | `#463a2c` |
| `--text` | `#241c12` | `#f5efe6` |
| `--text-2` | `#6b5d4a` | `#b9a78e` |
| `--text-3` | `#a2917a` | `#8a7a62` |
| `--accent` | `#b45309` | `#e0a458` |
| `--accent-weak` | `#f7ebdc` | `#3a2e1e` |
| `--on-accent` | `#ffffff` | `#1c1712` |

#### 鼠尾草 sage（取自 Yoga：暖灰绿 + 青）

| 变量 | 浅色 | 深色 |
|---|---|---|
| `--bg` | `#f2f4ef` | `#141a14` |
| `--surface` | `#ffffff` | `#1e261e` |
| `--surface-2` | `#e8ece3` | `#29332a` |
| `--surface-rgb` | `255,255,255` | `30,38,30` |
| `--border` | `#d9e0d2` | `#3a463a` |
| `--text` | `#232a22` | `#edf2ea` |
| `--text-2` | `#5e6857` | `#a9b8a4` |
| `--text-3` | `#9aa694` | `#7c8a78` |
| `--accent` | `#0f766e` | `#2dd4bf` |
| `--accent-weak` | `#dff2ef` | `#1b3a34` |
| `--on-accent` | `#ffffff` | `#0e1a16` |

#### 紫藤 wisteria（取自 Meditation：薰衣草 + 紫）

| 变量 | 浅色 | 深色 |
|---|---|---|
| `--bg` | `#f7f4fc` | `#17131f` |
| `--surface` | `#ffffff` | `#211b2c` |
| `--surface-2` | `#efe9f8` | `#2c2439` |
| `--surface-rgb` | `255,255,255` | `33,27,44` |
| `--border` | `#e1d8f0` | `#3d3350` |
| `--text` | `#241a33` | `#f0ebf7` |
| `--text-2` | `#6b5f80` | `#b0a6c2` |
| `--text-3` | `#9c90b0` | `#837a96` |
| `--accent` | `#6d28d9` | `#a78bfa` |
| `--accent-weak` | `#efe7fd` | `#33245c` |
| `--on-accent` | `#ffffff` | `#17131f` |

#### 海玻璃 seaglass（取自 Healthcare：冷青）

| 变量 | 浅色 | 深色 |
|---|---|---|
| `--bg` | `#eff7f8` | `#0e1a1d` |
| `--surface` | `#ffffff` | `#16262a` |
| `--surface-2` | `#e3f0f2` | `#1f3438` |
| `--surface-rgb` | `255,255,255` | `22,38,42` |
| `--border` | `#cde2e6` | `#2c474c` |
| `--text` | `#12303a` | `#e6f1f3` |
| `--text-2` | `#4e6b74` | `#9bb3b8` |
| `--text-3` | `#87a3aa` | `#6f8a90` |
| `--accent` | `#0e7490` | `#22d3ee` |
| `--accent-weak` | `#dcf0f4` | `#123a42` |
| `--on-accent` | `#ffffff` | `#0e1a1d` |

`--shadow` 各皮肤深浅各给一条，浅色沿用现状 `0 6px 18px rgba(0,0,0,.22)`，深色用更重的 `0 6px 18px rgba(0,0,0,.5)`（深色底上的阴影要更黑才看得出层次）。

### 5.4 应用机制

新增 `app/theme-store.js`（**不在 `theme.js` 里**，因为它要碰 `db` 和 `document`，而 `theme.js` 必须保持纯净）：

```js
export async function initTheme()          // 读设置 → 应用；返回已应用的 { preset, mode, photo }
export async function setPreset(id)        // 写库 + 立即应用
export async function setMode(mode)        // 写库 + 立即应用（'auto' 时解析当前系统状态）
export async function setPhoto(blob, mime) // 压缩 → 存 assets → 写库 → 应用
export async function removePhoto()        // 删 assets 记录 + 清设置 + 应用
export async function setOverlay(pct)      // 只改遮罩，不重编码图片
export function currentTheme()             // 同步读当前已应用的状态（面板用）
```

应用 = 把 `themeCssVars()` 的每个键 `setProperty` 到 `document.documentElement.style`，加上三个属性：`data-theme` / `data-mode`（**解析后的值**，不是 `'auto'`）/ `data-photo`。

**首屏不闪色的保证**：`main.js` 里加一个模块级的 promise：

```js
let themeReady = null;
async function render(id) {
  // 主题必须在任何 mount 之前应用：晚一帧就是「先闪一下默认蓝，再变成暖纸」。
  await (themeReady ??= initTheme().catch(err => { console.error('主题初始化失败，用默认外观', err); }));
  ...
}
```

放在 `render()` 里面而不是 `main.js` 顶部，是因为 `onChange(render)` 是同步注册、可能同步触发第一次渲染；把它挂在渲染路径上，无论谁先触发都保证「主题先行」。`.catch` 兜底保证主题出错不拖垮整页（照常渲染，只是外观是默认的）。

**跟随系统**：`initTheme()` 里挂一次 `matchMedia('(prefers-color-scheme: dark)').addEventListener('change', ...)`，仅在当前 `themeMode === 'auto'` 时重新解析并应用。监听只挂一次（用一个模块级标志），否则每开一次面板就多一个监听。

**blob URL 生命周期**：照片的 `URL.createObjectURL()` 结果缓存在 `theme-store.js` 的模块级变量里；换图或移除时先 `revokeObjectURL` 旧的再换新的（否则每换一次图泄漏一份 blob）。

`base.css` 保留一份 `:root`（默认皮肤浅色）+ 一条 `@media (prefers-color-scheme: dark) { :root { …默认皮肤深色… } }` 作为「JS 还没跑完的那一帧」的兜底。带属性的规则特异性 `(0,2,0)`／`(0,3,0)` 天然压过 `:root` 的 `(0,1,0)`——但**因为实际值由 JS 写进 inline style，这一条其实用不上**，留着只是让 `base.css` 单独看仍然是完整可用的（也方便将来做纯 CSS 的预览页）。

---

## 6. 照片背景

### 6.1 存储与压缩

- 选图入口复用现成的相册 input（`accept="image/*"`）。
- 压缩：复用 `image-scale.js` 的 `computeTargetSize(w, h, 1600)` 与 `JPEG_QUALITY`；若原图小于 `SKIP_COMPRESS_BYTES` 且不需要缩放，**仍然重新编码为 JPEG**——背景图要进备份，统一的编码格式比省那一次重编码重要（也顺带处理掉 HEIC 这类 WebView 渲染不了但 Canvas 能解的情况）。
- 压缩动作放在浏览器侧（Canvas），与 `image-store.js` 里已有的做法一致；`theme-store.js` 里写一个私有的 `encodeBackground(file)`。
- 尺寸上限：长边 1600px（`MAX_EDGE`）。背景铺满手机屏（1080×2400 左右）时，1600 的长边在 `cover` 下够用，而体积从几 MB 降到一两百 KB。
- 存进 `assets`（`id: 'bg'`），设置里只留 `{ assetId, overlay, createdAt }`。

### 6.2 渲染

背景层用 `body::before`（伪元素，不新增 DOM 节点）：

```css
body::before {
  content: '';
  position: fixed;
  inset: 0;
  z-index: -1;                    /* 负 z-index：装饰层不参与内容层叠，见设计依据 */
  background-image: var(--bg-scrim), var(--bg-image);
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
  pointer-events: none;
}
```

- `--bg-image`：由 JS 设为 `url(blob:…)`；未开照片时 `none`（配合 `--bg-scrim` 为透明，整层等于不存在）。
- `--bg-scrim`：`linear-gradient(rgba(var(--scrim-rgb), var(--scrim-a)), rgba(var(--scrim-rgb), var(--scrim-a)))`。两层背景叠在一起：第一层是遮罩色，第二层是照片。
- `--scrim-rgb`：浅色皮肤 `255,255,255`，深色皮肤 `0,0,0`（深浅切换时由 `themeCssVars` 一起给）。
- `--scrim-a`：由遮罩滑块控制，`scrimAlpha(overlay)`，0–0.6。
- `background-attachment: fixed` **不用**：移动端 Safari/WebView 上它对 `cover` 的处理不一致，而这里是 `position: fixed` 的伪元素，本来就不随滚动移动。

### 6.3 可读性（这才是照片背景的真正难点）

- **卡片半透明**：开启照片时 `--surface` 变为 `rgba(var(--surface-rgb), .9)`。0.9 是刻意的：太透会让文字与照片纹理打架，不透就看不出背景。`--surface-2` **不参与**——见下一条。
- **输入框、密码箱正文、数字大屏保持不透明**：这些元素垫在 `--surface-2` 上，而 `--surface-2` 在照片模式下**刻意不改**——这正是它不参与半透明化的原因。会用 `--surface` 变透的只有卡片本体与 sheet 面板。实现时仍要逐个确认（**看不清数字的记账 app 是废的**）：若发现某个关键读数垫在 `--surface` 上，就地给它一条不依赖 `--surface` 的不透明规则。
- **遮罩默认 30%**：这是「照片还看得出来」与「卡片文字达标」之间的折中点，用户可以在 0–60% 之间自己挪。
- **表格与小字**：`ui-ux-pro-max` 的 Glassmorphism 条目自己标注了 `requires: contrast-text-4.5`，这正是照片背景最大的坑；对比度测试只能保证「色板本身达标」，照片之下的实际对比度只能靠遮罩 + 半透明度的组合来兜。**这是本次唯一无法用自动化测试完全覆盖的风险**，所以它进手动验证清单。

---

## 7. 备份与恢复

- 导出：`exportBackup()` 里读 `assets` 的 `'bg'` 记录 → base64 → 放进 `data.background = { overlay, createdAt, mime, image }`。读失败时置 `null` 并 `console.warn`，**不能让一张背景图把整次导出打回去**（与 `encodeFiles` 里「跳过脏记录」同一纪律）。
- 导入：`importBackup()` 里若 `data.background` 有值且能解出 Blob，就写回 `assets`（`id: 'bg'`）并更新 `settings.backgroundImage`；否则清掉这两处（备份里没有背景，恢复后就不该留着上一台设备的背景）。
- **这是本次最容易漏的接缝**：`invoiceFiles` 那次就是因为在设计里写了「备份是整表导出，不用改」而漏掉 `name` 字段，直到换机才暴露。所以：
  - `data.background` 的读写**必须在同一个函数里成对出现**（导出与导入放在相邻的代码段，由评审逐行对照）；
  - 恢复后的背景图必须能被 `theme-store.js` 正常读到并应用（验证方式见手动清单）；
  - `assets` 表在 `importBackup` 里**不进 `clears` 列表**——它只在背景这一条路上被写，整表清空会让「备份里没有背景」这种正常情况变成一次多余的删除。

---

## 8. UI

新增一行设置入口与一个新面板：

- `app/ui/settings-sheet.js` 的 `SETTINGS_ENTRIES` 加一项：
  `{ id: 'appearance', label: '外观与背景', open: openAppearanceSheet }`，**插在 `budget` 之后、`backup` 之前**（前三个是记账配置，后两个是数据进出，外观属于「让 app 好看」，紧挨配置）。
- 新面板 `app/ui/appearance-sheet.js`：
  1. **皮肤**：五张卡片横向排（每张显示该皮肤的 `--bg` 底色 + `--accent` 色块 + 名称），选中的那张有描边。点击立即应用，不点保存。
  2. **深浅**：三个按钮「跟随系统 / 浅色 / 深色」，选中态同皮肤卡。
  3. **背景照片**：一行「选择图片」按钮；已选图时显示缩略图 + 「移除」+ 遮罩滑块（`input[type=range]`，0–60，实时生效）。
  4. 面板顶部一行小字说明当前皮肤名，避免用户看到一堆色块却不知道点了什么。
- 面板的开关时序复用 `settings-sheet.js` 的 `swapTo` 机制（**任何时刻只有一层 sheet**，那条纪律在新面板上同样适用）。
- 改动通过 `onChanged` 通知首页重渲染——**但颜色不需要重渲染**（变量已经生效）。只有照片从「无」到「有」时首页的渲染才有区别（其实也没有），所以这里 `onChanged` 可以照传，不必为它特判。

---

## 9. 测试

### 9.1 新增 `tests/theme.test.js`（纯逻辑，Node 可跑）

1. **变量齐全**：五套皮肤 × 深浅，每组的 key 集合与 `default.light` 完全一致（多一个少一个都失败）。防的是「新加一套皮肤时漏了一个变量 → 那块界面变透明/变黑」。
2. **对比度**：对每组配色断言
   - `--text` vs `--bg` / `--surface` / `--surface-2` ≥ 4.5
   - `--text-2` vs `--bg` / `--surface` / `--surface-2` ≥ 4.5
   - `--on-accent` vs `--accent` ≥ 4.5
   对比度用 WCAG 相对亮度公式，测试文件里实现（不引入依赖）。这是本次最有价值的测试：**它把「哪套皮肤在深色下数字看不清」变成一条会红的断言**。
3. **归一化**：`normalizePreset` / `normalizeMode` / `normalizeOverlay` / `normalizeBackground` 对 `undefined`、`null`、`''`、`42`、`'paper'`、`{ overlay: 999 }`、`{ assetId: '' }` 等输入的行为。
4. **`resolveMode`**：`auto` × {系统深、系统浅}、`light` × {系统深}、`dark` × {系统浅}。
5. **`scrimAlpha`**：0 → 0，60 → 0.6，越界输入被 clamp，`NaN` → 默认 30 对应的值。
6. **`themeCssVars(..., { photo: true })`**：只有 `--surface` 变成 `rgba(var(--surface-rgb), .9)`，**其余变量（含 `--surface-2`）一个都不许变**；`{ photo: false }` 时 `--surface` 就是该皮肤的不透明值。

### 9.2 不新增测试但必须回归的

- 现有 247 个测试全绿（基准不能掉）。
- `tests/backup*.test.js` 里若有对备份包 `data` 字段形状的断言，导入/导出背景的加入会不会让它失败（实现时逐个跑）。

### 9.3 模拟器 / 真机验证（CDP）

- 五套皮肤逐个切一遍，截图确认颜色真的变了、没有元素变成透明或黑块。
- 深色 + 每套皮肤各看一眼（`data-mode="dark"`）。
- 照片：往相册推一张测试图 → 选图 → 确认背景出现、卡片半透明、数字仍可读；遮罩滑到 0 和 60 各看一眼。
- 备份往返：导出（含背景）→ 清库 → 导入 → 背景还在。
- 迁移：用 v1.2.0 的库（`DB_VERSION = 2`）打开新版本，确认 `assets` 表建出来、老数据一条不少。

---

## 10. 接缝清单（上次就是栽在这些地方）

| 接缝 | 具体动作 | 漏掉的后果 |
|---|---|---|
| `sw.js` 的 `ASSETS` | 加 `./app/theme.js`、`./app/theme-store.js`、`./app/ui/appearance-sheet.js`；`CACHE` 升到 `pvault-v16` | 离线 / APK 里这三个模块 404，整个 app 白屏 |
| `backup-store.js` 的导出与导入 | `data.background` 两处成对写 | 换机后背景静默消失（与 `name` 字段同一个坑） |
| `DB_VERSION` 2 → 3 | `schema.js` 加 `assets` + 升版本号 | 新表建不出来，存图直接抛错 |
| `main.js` 的 `render()` | 首屏前 `await themeReady` | 每次冷启动闪一下默认色 |
| `settings-sheet.js` | 新入口插对位置 | 设置面板里出现两个「备份」或漏掉一行 |
| `build-apk.ps1` | **不用改**（整目录复制） | —（写在这里是为了让评审确认「真的不用改」） |

---

## 11. 验收标准

- [ ] 设置 → 外观与背景，五套皮肤可切换，切换立即生效，切 Tab / 重进 app 后保持
- [ ] 深浅可跟随系统 / 手动指定；设成「跟随系统」后改系统设置，app 实时跟着变
- [ ] 能从相册选一张照片当背景；卡片半透明、遮罩可调；**关掉照片后完全恢复原样**
- [ ] 冷启动不闪色（先看到的就是已选皮肤）
- [ ] 备份导出携带背景，导入后背景还在
- [ ] `tests/theme.test.js` 全绿，含对比度断言；总数 ≥ 247 + 新增
- [ ] 真机上：五套皮肤 × 深/浅，没有看不清的数字，没有透明到看不见的控件

---

## 12. 设计依据（`ui-ux-pro-max` 检索结论与取舍）

| 检索 | 采纳 | 拒绝 / 修正 |
|---|---|---|
| `--domain style` "glassmorphism background image readability" | 半透明叠层 + 细描边的层次思路；它自带的 `Accessibility: requires contrast-text-4.5` 被当成硬约束写进测试 | `backdrop-filter: blur(15px)` 不采纳（安卓 WebView 长列表滚动掉帧）；`-webkit-backdrop-filter` 同理 |
| `--domain color` "personal finance calm reading numbers" | 四套现成调色作为皮肤底色：Book & Reading Tracker（暖纸）、Meditation（紫藤）、Yoga（鼠尾草）、Healthcare（海玻璃） | 它给的 Personal Finance Tracker 那套是深色优先（`#0F172A` 底），本次皮肤要深浅两版，所以只取其「蓝 + 绿」的语义，不取其具体值 |
| `--stack html-tailwind` "css variables theming dark mode custom background" | **Negative z-index for backgrounds**：装饰性背景层用负 z-index（`body::before` 的 `z-index: -1`）；**Theme color variables**：语义 token 映射到主题（本项目的 CSS 变量就是这套 token） | Tailwind 的 `dark:` 前缀、`@theme`、`@utility` 等语法全部不适用（本项目零依赖手写 CSS） |
| `--domain ux`（检索到的是 Focus Appearance 一条，与主题无关） | — | **没有可用的匹配**，本条不采纳任何结论，改用项目已有的无障碍纪律 |

---

## 13. 手动验证清单新增项（跑不了自动化的部分）

以下写进 `docs/手动验证清单.md`：

- [ ] 真机上选一张**竖拍手机照片**（长边远大于 1600），确认压缩后背景不糊
- [ ] 遮罩 0% 时是否还能看清首页大数字（这个只能人眼judge）
- [ ] 深色 + 照片 + 遮罩 0%，确认卡片上的次要文字（日期、账户名）仍可读
- [ ] 密码箱里的密码正文、账户余额等**关键读数**在开启照片后是否仍然不透明、清晰
- [ ] 老库（v1.2.0 的数据）升级后，账目/发票/密码箱一条不少
- [ ] 备份文件（含背景）的体积增幅是否在预期内（约 +100~400KB）
- [ ] 从备份恢复后背景还在，且**恢复的是一台机器上的图**（不是当前这台残留的）
