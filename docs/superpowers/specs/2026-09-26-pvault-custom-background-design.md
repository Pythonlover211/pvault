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
- `sw.js`：`ASSETS` 是**手写白名单**，`CACHE` 当时是 `pvault-v15`（**这个数字一直在动，别照抄**：任务 5 / 10 / 11 / 14 都碰过它——要看就以 `sw.js` 里那一行为准。改了 `ASSETS` 要不要顺手升版本号，按 `sw.js` 开头那条例外的边界判：只有「这个版本已经在设备上服役过」时才必须 +1）。**漏加文件的后果不是 404**：它不影响 install，直到真的去请求那个模块——离线时缓存未命中 → 回退 `index.html` → 模块脚本被 MIME 检查拒绝，import 链一断 app 起不来（404 属于另一条路：清单里写了一条不存在的路径，那时 `addAll` 会整批 reject、install 失败）。

---

## 4. 数据模型

### 4.1 settings 新增三个键

| key | 形状 | 默认值 |
|---|---|---|
| `themePreset` | `'default' \| 'paper' \| 'sage' \| 'wisteria' \| 'seaglass'` | `'default'` |
| `themeMode` | `'auto' \| 'light' \| 'dark'` | `'auto'` |
| `backgroundImage` | `{ assetId: string, overlay: number, createdAt: number \| null } \| null` | `null` |

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
export function normalizeOverlay(v)         // 数字，或非空可解析的数字字符串（滑块的 el.value）→ 取整 → clamp 到 0..60；
                                            // 其余（undefined / null / '' / [] / true / false / NaN / Infinity / '45px'）→ 30
export function normalizeBackground(v)      // 校验形状，非法 → null
export function scrimAlpha(overlay)         // 0..60 → 0..0.6（小数）
export function themeCssVars(themeId, mode, { photo })  // → { '--bg': '#…', … } 的扁平对象
```

`themeCssVars()` 是**唯一**把 (皮肤, 深浅, 有无照片) 翻译成 CSS 变量的地方。开启照片时，它只把 `--surface` 换成 `rgba(r,g,b, .9)`——那三个通道由 `--surface` 自己解出来（色板里**不存** `--surface-rgb`，见 §5.2）；`--surface-2` **保持不透明**——垫在它上面的是输入框、次级按钮这些必须看清文字的控件（见 §6.3）。

`app/theme.js` 必须是**纯模块**：不 import `db.js`、不碰 `document`、不碰 `window`，否则 Node 测试跑不起来（与 `file-info.js` 同一纪律）。

### 5.2 变量清单

每套皮肤 × 每种深浅都必须给全下面这一组，一个都不能少：

`--bg`、`--surface`、`--surface-2`、`--border`、`--text`、`--text-2`、`--text-3`、`--accent`、`--accent-weak`、`--on-accent`、`--shadow`、`--scrim-rgb`

一共 12 个。**没有 `--surface-rgb`**：它与 `--surface` 是同一个颜色的两种写法，存两份必然漂移，而漂移只在「开了背景照片」这个状态下才看得出来（卡片半透明用的正是它的通道值）——不开照片的人永远碰不到。卡片半透明的 `rgba(...)` 由 `themeCssVars()` 从 `--surface` 现算（`#rrggbb` → `r,g,b`），于是物理上不可能跟 `--surface` 对不上；它也因此**不是**一个写到页面上的变量，CSS 里没有它的消费点（写「CSS 里不会出现 `var(--surface-rgb)`」这种字面说法会被注释自身命中——它自己就含这个串）。

这份清单在 `tests/theme.test.js` 里**写死**（正典清单），基准不拿 `default.light` 自指——自指的基准下「十组一起少一个变量」也是绿的。

（`--scrim-rgb` 只有两个取值：浅色皮肤 `255,255,255`、深色皮肤 `0,0,0`，但它属于「皮肤 × 深浅」这个维度，所以放在同一张表里由 `themeCssVars()` 一起给。）

**不由 `themeCssVars()` 负责的三个变量**，它们取决于运行时状态而不是配色选择，由 `theme-store.js` 单独 `setProperty`：

| 变量 | 谁设置 | 取值 |
|---|---|---|
| `--bg-image` | 选图/移除时 | `url(blob:…)` 或 `none` |
| `--bg-scrim` | 选图/移除时（写一次；切深浅由值里的 `var(--scrim-rgb)` 间接跟随，见下） | `linear-gradient(rgba(var(--scrim-rgb), var(--scrim-a)), rgba(var(--scrim-rgb), var(--scrim-a)))`；没有照片时 `none` |
| `--scrim-a` | 遮罩滑块每次变化时 | `scrimAlpha(overlay)` 的结果，0–0.6 |

`--bg-scrim` **只在选图 / 移除时写一次**（不是每次切深浅）：写进 DOM 的是**表达式**而不是算好的颜色——`linear-gradient` 里的 `--scrim-rgb` 要等到使用点（`body::before` 的 `background-image`）才求值，而 `paint()` 每次切深浅都会重写 `--scrim-rgb`，遮罩颜色因此自动跟着变。切深浅时再写一次只是把同一条表达式重设一遍，还会让「有没有照片」这件事再漏进 `paint()` 的合同里。

`--radius*`、`--font-*`、`--tab-h`、`--safe-b` 等**不属于皮肤**，继续留在 `base.css` 的 `:root` 里不动。

语义色 `--success` / `--warning` / `--error` / `--overlay` **本次不按皮肤分化**（保持现状一套），理由是它们表达的是固定语义（赚了/警示/出错），而现状的值在五套皮肤的背景上都能用。这条如果将来要改，改的是 `base.css` 而不是 `theme.js`。

### 5.3 五套皮肤的色值

> 下表是设计稿。实现时以 `tests/theme.test.js` 的对比度断言为准——**任何一对不达标的色值当场调整**，不迁就下表。
>
> 表里没有 `--surface-rgb` 这一行：它是 `--surface` 的派生值（`r,g,b` 三个通道），由 `themeCssVars()` 现算，既不进色板也不写到页面上。
>
> 表里也**不列** `--shadow` / `--scrim-rgb`：它们不随皮肤变，所以每张表只列随皮肤变的 10 个变量——`--shadow` 只随深浅（浅色 `0 6px 18px rgba(0, 0, 0, .22)`、深色 `… .5`），`--scrim-rgb` 只有 `255,255,255` 与 `0,0,0` 两个取值（见 §5.2）。

#### 默认 default（浅色即现状）

| 变量 | 浅色 | 深色 |
|---|---|---|
| `--bg` | `#f2f2f5` | `#131315` |
| `--surface` | `#ffffff` | `#1e1e21` |
| `--surface-2` | `#e9e9ec` | `#2b2b30` |
| `--border` | `#d5d5da` | `#3a3a40` |
| `--text` | `#1d1d1f` | `#f2f2f5` |
| `--text-2` | `#63636a` | `#9a9aa0` |
| `--text-3` | `#a1a1a6` | `#6e6e73` |
| `--accent` | `#0a6ef0` | `#3b8ef5` |
| `--accent-weak` | `#e6f0fe` | `#16273d` |
| `--on-accent` | `#ffffff` | `#101216` |

**一处顺带修正**：浅色的 `--text-2` 由现状的 `#6e6e73` 调深为 `#63636a`。原因是它落在 `--surface-2` 上时对比度只有 **4.19:1**（精确值 4.1854），达不到 AA 的 4.5:1（它出现在输入框、次级按钮这些真的垫在 `--surface-2` 上的地方）。调深后是 **4.92:1**，肉眼几乎看不出差别。这是本次唯一一处**对现有外观的改动**。

深色的 `--on-accent` 由白改为近黑：现状深色强调色 `#3b8ef5` 上的白字只有约 3.3:1。深色模式下「亮底 + 深字」也是更常见的做法。

#### 暖纸 paper（取自 Book & Reading Tracker：暖棕 + 页黄）

| 变量 | 浅色 | 深色 |
|---|---|---|
| `--bg` | `#fbf7ee` | `#1c1712` |
| `--surface` | `#ffffff` | `#262019` |
| `--surface-2` | `#f3ece0` | `#332a20` |
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
export async function setPhoto(file)       // 压缩 → 存 assets → 写库 → 应用（file 是相册 input 给的 File）
export async function removePhoto()        // 删 assets 记录 + 清设置 + 应用
export async function setOverlay(pct)      // 只改遮罩，不重编码图片
export function currentTheme()             // 同步读当前已应用的状态（面板用）
```

应用 = 把 `themeCssVars()` 的每个键 `setProperty` 到 `document.documentElement.style`，加上三个属性：`data-theme` / `data-mode`（**解析后的值**，不是 `'auto'`）/ `data-photo`。

**这份清单就是 `paint()` 的合同**：`themeCssVars()` 返回多少个键就写多少个，一个不筛、一个不落；三个属性一个不少。少写一个变量不会表现为「没变化」，而是「上一套皮肤的值留在 DOM 上」——从深色切回浅色时 `--scrim-rgb` 会留着深色那套的 `0,0,0`，于是浅色皮肤 + 背景照片的遮罩发黑、字压不住，而界面上零报错。`base.css` 的 `:root` 里**有** `--scrim-rgb` 的兜底（任务 9 加的），但它救不了这条路：兜底只在「这个变量从未被写过」时有值，而残留是「写过之后又漏写」——inline style 压过样式表；何况兜底给的是浅色那一份，深色档下遮罩会发白而不是发黑。它只是**部分掩盖**了这个问题，没有消除它。这条合同**没有自动测试能覆盖**（测试看得见的是 `themeCssVars()` 的键集与色板的键集，看不见 `paint()` 的循环本身），所以手动验证清单里补了三条 Console 核对（`theme` / `mode` / `photo`）。

**首屏不闪色的保证（到「内容挂载之前」为止）**：`main.js` 里加一个模块级的 promise：

```js
let themeReady = null;
async function render(id) {
  // 主题必须在 render 这条路径上先于它的 mount 应用：晚一帧就是「先闪一下默认蓝，再变成暖纸」。
  await (themeReady ??= initTheme().catch(err => { console.error('主题初始化失败，用默认外观', err); }));
  ...
}
```

放在 `render()` 里面而不是 `main.js` 顶部，是因为 `onChange(render)` 是同步注册、可能同步触发第一次渲染；把它挂在渲染路径上，两条路（首次渲染、以及切 Tab / 保存后的重渲染）谁先到，都保证**这一次 `render()` 的 `mount`** 在主题之后。**它不覆盖一切挂载**：主屏快捷方式那条路（`openFromShortcut()` → `openEntryPanel()`）直接开录入面板、不经过 `render()`，它自己 `await` 一次 IndexedDB 读之后挂载，与 `initTheme()` 是并发的，谁先完成没有保证——任务 15 的清单里有一条「带 `new=1` 的冷启动顺带看一眼面板首帧」。`.catch` 兜底保证主题出错不拖垮整页（照常渲染，只是外观是默认的）；兜住之后**不再重试**（promise 缓存在 `themeReady` 里，失败同样是 settled），一次主题失败＝本次页面生命周期停在默认外观、刷新才恢复。

**这条保证的边界（验收时按这个判据）**：它管的是「**内容挂载之前**主题已应用」，不是「第一帧就是皮肤色」。JS 起跑之前的那几帧，浏览器画的是 `base.css` 的 `:root` 兜底（默认皮肤的浅 / 深，见下面那段），而 `index.html` 的 `<body>` 里只有空的 `<div id="app">`——那几帧看到的是「一片默认底色、什么都还没有」。把 §11 的「先看到的就是已选皮肤」读成「连那一片底色也得是皮肤色」，是个**永远不可能通过**的判据；要消掉它只能把用户皮肤内联进 `index.html`，那不在本设计里（§11 那一条已按这个判据改写）。

**跟随系统**：`initTheme()` 里挂一次 `matchMedia('(prefers-color-scheme: dark)').addEventListener('change', ...)`，仅在当前 `themeMode === 'auto'` 时重新解析并应用。监听只挂一次（用一个模块级标志），否则每开一次面板就多一个监听。

**blob URL 生命周期**：照片的 `URL.createObjectURL()` 结果缓存在 `theme-store.js` 的模块级变量里；换图或移除时先 `revokeObjectURL` 旧的再换新的（否则每换一次图泄漏一份 blob）。

`base.css` 保留一份 `:root`（默认皮肤浅色）+ 一条 `@media (prefers-color-scheme: dark) { :root { …默认皮肤深色… } }` 作为「JS 还没跑完的那一帧」的兜底。带属性的规则特异性 `(0,2,0)`／`(0,3,0)` 天然压过 `:root` 的 `(0,1,0)`——但**因为实际值由 JS 写进 inline style，这一条其实用不上**，留着只是让 `base.css` 单独看仍然是完整可用的（也方便将来做纯 CSS 的预览页）。

任务 9 在同一个 `:root` 里加了背景照片那四个变量的兜底（`--bg-image` / `--bg-scrim` / `--scrim-rgb` / `--scrim-a`）。四条性质一样：只在「这个变量从未被写过 inline」时生效，作用是让这一层的默认状态在 CSS 里自文档化、并给将来的改动上保险，**当前都不产生可见的渲染差异**。逐条：

- `--bg-image` 与 `--bg-scrim` 的兜底都是 `none`，与「两个都没写过」画出来一样（`var()` 没有回退值，缺一个会让整条 `background-image` 在 computed-value 求值时失效、两层一起没）。兜底值必须是这种「等于不存在」的东西——写成真遮罩或真色块，首帧就会看到一整块遮罩盖住整个 app。但它**不是零风险的装饰**：把将来「只写 `--bg-image`、漏写 `--bg-scrim`」这种缺陷，从显眼的失败（`var()` 未定义 → 整条声明失效 → 两层都不画 → 用户看到「照片没了」）换成隐蔽的失败（`none, url(…)` → 照片裸奔、没有遮罩 → 功能「看起来正常」，缺的是那层压住照片的遮罩）。**受损到什么程度没有实测**：**卡片 / 面板内的读数**垫在 `rgba(r,g,b, 0.9)`（`PHOTO_SURFACE_ALPHA`）上，但**首页大数字与页面上那些亮色文字不在卡片里**——`ledger-home.js` 把「本月支出」挂在空 class 的 div 上，`.ledger-amount` / `.ledger-total` 只有字号字重、没有 background，`.stack` / `.screen` 也没有（`background: var(--surface)` 只挂在 `.card` 上），所以它们**直接压在照片层上**。这一条属于 §6.3 与手动验证清单留给真机验收的范围，不在文档里写成断言。兜底仍然保留（四行一组，把「默认状态等于不存在」显式写出来），代价如实记在 `styles/base.css` 的注释里。
- `--scrim-rgb` 与 `--scrim-a` 在 CSS 里**没有第二个消费点**（消费它们的是 JS 写进 inline style 的那条表达式；`--bg-scrim` 的兜底是字面量 `none`，不引用它们），所以在这一帧同样没有可见效果。它们唯一可能生效的情形与前提写在 `styles/base.css` 的注释里：`--scrim-a` 连那条路都没有（`setPhotoVars` 里两行 `setProperty` 相邻、不会只写一行）；`--scrim-rgb` 需要「这个键从头到尾没被写过」，而 `paint()` 的循环本来一定会写它，所以只剩两种可能——循环被改坏漏掉了它，或 `paint()` 抛错（它唯一的 `throw` 是 `theme.js` 的 `hexToRgb`，要色板违反 HEX6 才触发，见下面那条已知项；而那种色板**进不了仓库**——`SHAPES` 的 `HEX6` 正则比 `hexToRgb` 的更严，它会先在单测里红）。
- 这四条兜底与 JS 运行值的**逐字符相等**是硬要求，而 CSS 这一侧**没有测试守卫**（仓库里没有任何测试解析 `base.css` 的内容）。守它的是仓库里的 `scripts/check-theme-css.mjs` 的 ③：四个值 === JS 运行值，逐字符。`--scrim-a: 0.3` 正是 `OVERLAY_DEFAULT` 在 CSS 里的**第二份真相**，少了那条断言就会静默漂移——注意说的是副本漂移，**不是**显示上的差异（按上一条，这行兜底在现有代码里不会被消费）。

这四个变量在深色那一份 `:root` 里都不补：`--scrim-rgb` 在「JS 没跑完那一帧」本来就没有作用对象（`--bg-scrim` 也是 `none`）。**注意这与 `--bg` 不同**——`--bg` 在 `@media` 深色块里是补了的（`--bg: #131315`）；代价要说清：这条兜底一旦真的生效（也就是 `paint()` 漏写 `--scrim-rgb` 的那条路），深色档下拿到的是**白色**遮罩，极性是错的。

**写入口的顺序：先画、再写库。** `setPreset()` / `setMode()` 都是「改内存 → `paint()` → `await setSetting()`」。反过来的话，写库一抛（`db.js` 的 `onblocked` 是真实可达路径，配额满也是）就留下「内存已改、DOM 还是旧皮肤」：面板拿 `currentTheme()` 重绘会显示「已经选中」，页面却还是上一个颜色，用户下次打开又变回去。先画，内存与 DOM 永远一致，写库失败只影响「下次启动记不记得住」。这两个写入口**不 catch**，rejection 交给调用方（面板）去提示「没保存成功」；它们与 `setPhoto` / `removePhoto` / `setOverlay` 一样 `return currentTheme()`。

**`setOverlay()` 的判据是 `applied.photo`**（此刻画面上真的有没有照片），不是设置里那条 `backgroundImage` 记录：两者会不一致——读 `assets` 失败被 `applyPhoto` 的 `catch` 收住、或清设置那一步写库失败时，设置说有背景、照片却没加载出来。那时按设置走会改内存并写库，而 DOM 上的 `--scrim-a` **一个字符都不写**，正是上面刚说不许出现的那种不一致。所以「有没有照片」这条判据全模块只留一份 `applied.photo`。

**已知、接受：`paint()` 自身抛错时不回滚**（内存已改、DOM 未改）。触发前提是色板常量违反了 HEX6——外观系统这两个模块里唯一的 `throw` 就在 `theme.js` 的 `hexToRgb`（`theme-store.js` 一处都没有）。而 `tests/theme.test.js` 的形状断言比它的正则更严（`HEX6 = /^#[0-9a-f]{6}$/`，只认小写 6 位，且对 5 套皮肤 × 2 档深浅逐值断言），所以**能让 `hexToRgb` 抛的色板，必定先在单测红**——实测把 `default.light.--surface` 改成 `'red'`，单测先报 `default.light.--surface 的形状不对：red`，而 `hexToRgb` 那条要到运行时才炸。不回滚的坏状态还是**自愈**的：下一次成功的 `paint()` 会把 DOM 追平。**为什么不加回滚**：真回滚得同时快照 `applied` 与 DOM、再重画一次，而 `paint()` 若因色板坏掉而抛、回滚那次 `paint()` 同样会抛——换来的只是一个更复杂的抛错路径。

**多标签页不做同步。** 两个标签页是两个模块实例，内存不共享（只有 IndexedDB 共享）：A 页选了暖纸，B 页的面板仍显示默认；用户在 B 里点一次「确认」就把库写回默认。`storage` 事件不覆盖 IndexedDB，接它也没用；要同步得引入 `BroadcastChannel` 或轮询，对一个自用记账 app 不值得。**已知、接受。**

### 5.5 系统栏颜色

这件事在改动前**没有任何人决定过**：规格与计划里 grep 不到任何一处，而现状是两条互不相干的写死值——

- `index.html` 的两条 `meta[name=theme-color]`（默认皮肤的浅色 / 深色，各带一条 `prefers-color-scheme` 的 media）；
- 安卓壳 `android/app/src/main/res/values/themes.xml`：`statusBarColor` / `navigationBarColor` 写死 `#f2f2f5`，`windowLightStatusBar=true`（状态栏图标恒为深色）。

后果：用户在浅色系统上手动选深色（或选暖纸 / 紫藤等任意非默认皮肤）→ 页面近黑或换色，而状态栏与导航栏仍是浅灰 + 深色图标，上下两条硬边。APK 里 `meta theme-color` 完全无效，只有 `themes.xml` 生效。

**决定一（做）：浏览器 / PWA 这条路让它跟随。** `paint()` 里同步把 `meta[name=theme-color]` 的 `content` 写成当前 resolved 的 `--bg`，并把 `index.html` 的两条带 media 的 meta **合并成一条不带 media 的**。按 HTML 规范，多条 `meta[name=theme-color]` 只会挑**树序上第一条 media 匹配**的那条，而且**从不重新求值**——所以旧写法比「手动选深浅不看」坏得更彻底：**换皮肤它也不看**，浅色系统下选暖纸（`#fbf7ee`）系统栏仍停在默认的 `#f2f2f5`，紫藤、海玻璃同理（5 套皮肤里 4 套 + 手动深浅，旧写法全错）。合并成一条不带 media 的，是唯一能表达「当前实际皮肤」的写法。`paint()` 是唯一知道 resolved `--bg` 的地方，这件事该它干；静态那份 `content` 留作「JS 还没跑起来那一帧」的兜底。

**决定二（不做）：APK 里系统栏不跟随页面主题。** 评估结论与理由：

1. 状态栏 / 导航栏是**窗口级**状态，只有 Java 侧能改；而页面侧唯一的知情点是 `paint()`。要做就得在壳里新增一条「页面 → Java」的桥（`PvaultShell.setThemeColors(...)`），也就是本项目第一处**把渲染状态复制到宿主**的耦合——现有三条桥（落盘、剪贴板、壳版本）都是无状态的能力，主题不是。
2. 复制出去的状态还得自己维护一致性：WebView 重载、`onPageFinished` 的时序、旋转、「系统深色 + 页面手动浅色」等组合各是一条要真机验证的路径，而收益只是两条硬边。
3. **时间窗**：`targetSdk` 现在是 34，`setStatusBarColor` / `setNavigationBarColor` 仍然有效；升到 35（Android 15）后强制 edge-to-edge，这两个 API 被忽略，跟随要改成 `WindowInsetsController` + 让内容延伸到系统栏后面（连带 `viewport-fit=cover` 与 safe-area 的布局处理）。**现在写的实现会在下一次 `targetSdk` 升级时作废**，不如等那一步一起做。
4. `values-night/themes.xml`（纯资源、零代码）看着便宜，但它只跟**系统**深浅、不跟页面主题：用户在系统深色下手动选浅色皮肤时，得到的反而是「状态栏深、页面浅」——把一种不一致换成另一种，且很难向用户解释。不做。

**已知项**：任务 15 的「五套皮肤 × 深浅逐个截图」会拍到这两条硬边，这是上面这个决定的结果，不是 bug。

---

## 6. 照片背景

### 6.1 存储与压缩

- 选图入口复用现成的相册 input（`accept="image/*"`）。
- 压缩：复用 `image-scale.js` 的 `computeTargetSize(w, h, 1600)` 与 `JPEG_QUALITY`；若原图小于 `SKIP_COMPRESS_BYTES` 且不需要缩放，**仍然重新编码为 JPEG**——背景图要进备份，统一的编码格式比省那一次重编码重要（也顺带处理掉 HEIC 这类 WebView 渲染不了但 Canvas 能解的情况）。
- 压缩动作放在浏览器侧（Canvas），与发票那条路已有的做法一致——那份实现在 `canvas-image.js`（任务 5 从 `image-store.js` 搬出来共用）；`theme-store.js` 里写一个私有的 `encodeBackground(file)`。
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

- `--bg-image`：由 JS 设为 `url(blob:…)`；未开照片时 `none`（此时 `--bg-scrim` 也是 `none`，整层等于不存在）。
- `--bg-scrim`：`linear-gradient(rgba(var(--scrim-rgb), var(--scrim-a)), rgba(var(--scrim-rgb), var(--scrim-a)))`。两层背景叠在一起：第一层是遮罩色，第二层是照片。
- `--scrim-rgb`：浅色皮肤 `255,255,255`，深色皮肤 `0,0,0`（深浅切换时由 `themeCssVars` 一起给）。
- `--scrim-a`：由遮罩滑块控制，`scrimAlpha(overlay)`，0–0.6。
- 这四个变量的 `:root` 兜底值见 §5.4 末尾（连同「只在从未被 inline 写过时生效」的说明）。
- `background-attachment: fixed` **不用**：移动端 Safari/WebView 上它对 `cover` 的处理不一致，而这里是 `position: fixed` 的伪元素，本来就不随滚动移动。
- **照片也在首屏之前就位**：`initTheme()` 里是 `await applyPhoto(bgRaw)`，不是 fire-and-forget。`paint()` 画的是内存里的 `applied`，卡片的不透明度（`--surface`）与背景图（`--bg-image`）要等 `applyPhoto()` 里的第二次 `paint()` 才到位；不 await 的话那次补画落在 `initTheme()` 返回之后（通常已经 mount 完了），冷启动时用户看到的是「卡片先实心、再突然变半透明并冒出一张照片」。代价只有首屏多等一次 `assets` 读（`settings` 那条 `initTheme()` 已经读过、直接传下去，不再重复读）。

### 6.3 可读性（这才是照片背景的真正难点）

- **卡片半透明**：开启照片时 `--surface` 变为从它自己现算的 `rgba(r,g,b, .9)`（通道由该皮肤的 `--surface` 解出，色板里没有 `--surface-rgb` 这份副本）。0.9 是刻意的：太透会让文字与照片纹理打架，不透就看不出背景。`--surface-2` **不参与**——见下一条。
- **输入框、密码箱正文、数字大屏保持不透明**：输入框与密码箱正文垫在 `--surface-2` 上，而 `--surface-2` 在照片模式下**刻意不改**——这正是它们不参与半透明化的原因。会用 `--surface` 变透的只有卡片本体与 sheet 面板。**但「数字大屏」这半句在实现里没有对应的规则**（任务 9 复核时实测）：首页的大数字（`.ledger-amount.ledger-total`）挂在空 class 的 div 上，`.stack` / `.screen` 都没有背景，所以它**既不在卡片里、也没有 `--surface-2` 垫底**，直接压在照片层上——它的可读性正是任务 15 手动清单第 2 条要验的东西（「遮罩 0% 时还能看清首页大数字」）。实现时仍要逐个确认（**看不清数字的记账 app 是废的**）：若发现某个关键读数垫在 `--surface` 上，就地给它一条不依赖 `--surface` 的不透明规则；**直接压在照片上**的那一类（当前是首页大数字），只能靠遮罩 + 真机验收兜。
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
- **任务 13 落地之前，导入必然留下一次悬空设置**：现在的 `importBackup` 整表覆盖 `settings`，而 `assets` 既不进 `clears` 也不在导出内容里（`data` 只有 `txns/accounts/categories/receivables/settings/invoices/invoiceFiles/vault`）。于是在 A 机开过背景的用户把备份导进 B 机之后，`settings.backgroundImage` 指向 `'bg'`，而 B 机的 `assets` 是空的。这不会崩——`theme-store.js` 的 `applyPhoto` 按「没有背景」兜住它、顺手把设置清掉——但用户看到的是「导入后背景没了」，而**任务 13 的导入侧必须把 `assets` 与 `settings.backgroundImage` 成对处理**（有则一起写回、无则一起清掉），否则每次导入都留一条悬空设置。

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

1. **变量齐全 + 色值格式**：五套皮肤 × 深浅，每组的 key 集合与**写死的正典清单**完全一致（多一个少一个都失败；基准不拿 `default.light` 自指——自指的基准下「十组一起少一个变量」也是绿的）；并且逐值断言形状——由一张手工维护的 `SHAPES` 表按变量名给出形状（10 个 hex 键匹配 `#rrggbb`、`--shadow` 是 `0 <n>px <n>px rgba(0, 0, 0, <alpha>)` 这样的完整一条、`--scrim-rgb` 是 `r,g,b` 三个 ≤255 的通道且浅色为 `255,255,255`、深色为 `0,0,0`），且 `SHAPES` 的键集合必须与正典清单**一一对应**——新增变量忘了登记形状会当场红，报出的是「该去补一行」，而不是一个计数。**不要用「hex 变量应恰好 N 个」这类计数守卫**：它拦不住值写错（新值会被形状表自动断言），却会把合法的扩展判红。防的是「新加一套皮肤时漏了一个变量 → 那块界面**静默**退回 `base.css` 的默认皮肤色」（比变透明/变黑难发现），以及值写错——只断言键名的写法拦不住值写错（同一条标准见 `tests/schema.test.js`）。
2. **对比度**：对每组配色断言
   - `--text` vs `--bg` / `--surface` / `--surface-2` ≥ 4.5
   - `--text-2` vs `--bg` / `--surface` / `--surface-2` ≥ 4.5
   - `--on-accent` vs `--accent` ≥ 4.5
   对比度用 WCAG 相对亮度公式，测试文件里实现（不引入依赖）。这是本次最有价值的测试：**它把「哪套皮肤在深色下数字看不清」变成一条会红的断言**。
3. **归一化**：`normalizePreset` / `normalizeMode` / `normalizeOverlay` / `normalizeBackground` 对 `undefined`、`null`、`''`、`42`、`'paper'`、`{ overlay: 999 }`、`{ assetId: '' }` 等输入的行为。
4. **`resolveMode`**：`auto` × {系统深、系统浅}、`light` × {系统深}、`dark` × {系统浅}。
5. **`scrimAlpha`**：0 → 0，60 → 0.6，越界输入被 clamp，`NaN` → 默认 30 对应的值。
6. **`themeCssVars(..., { photo: true })`**：只有 `--surface` 变成 `rgba(r,g,b, .9)`（通道从该皮肤的 `--surface` 现算，例如 `default.dark` → `rgba(30,30,33, 0.9)`），**其余变量（含 `--surface-2`）一个都不许变**；`{ photo: false }` 时 `--surface` 就是该皮肤的不透明值。色板里也不该再有 `--surface-rgb` 这个键。

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
| `sw.js` 的 `ASSETS` | `./app/canvas-image.js`（任务 5，v16）、`./app/theme-store.js` 与 `./app/theme.js`（任务 10，v17，两个一起加——它们在同一条首屏依赖链上）、`./styles/appearance.css`（**任务 11**：`index.html` 挂上它的 `<link>` 之后它就是首屏依赖，所以不等任务 14）都已经加完；只剩 `./app/ui/appearance-sheet.js` 在任务 14——那要等任务 12 把 `settings-sheet.js` 的 `import` 接上，它才真的进首屏依赖链。`CACHE` 到任务 14 再升（任务 11 加 `appearance.css` 时 `pvault-v17` 还没发布，按 `sw.js` 开头那条例外不必 +1） | 漏加一个模块：离线启动时它的请求缓存未命中 → 回退 `index.html` → 模块脚本被 MIME 检查拒绝，app 起不来。**这不是 404**——404 属于「清单里写了一条不存在的路径」，那时 `addAll` 会整批 reject、install 失败 |
| `backup-store.js` 的导出与导入 | `data.background` 两处成对写 | 换机后背景静默消失（与 `name` 字段同一个坑） |
| `DB_VERSION` 2 → 3 | `schema.js` 加 `assets` + 升版本号 | 新表建不出来，存图直接抛错 |
| `main.js` 的 `render()` | 在 `render()` 这条路径上、内容挂载前 `await themeReady`（边界见 §5.4） | 内容先挂载、再上色：**默认皮肤 + 默认深浅之外的档**冷启动会闪一下默认色 |
| `settings-sheet.js` | 新入口插对位置 | 设置面板里出现两个「备份」或漏掉一行 |
| `build-apk.ps1` | **不用改**（整目录复制） | —（写在这里是为了让评审确认「真的不用改」） |

---

## 11. 验收标准

- [ ] 设置 → 外观与背景，五套皮肤可切换，切换立即生效，切 Tab / 重进 app 后保持
- [ ] 深浅可跟随系统 / 手动指定；设成「跟随系统」后改系统设置，app 实时跟着变
- [ ] 能从相册选一张照片当背景；卡片半透明、遮罩可调；**关掉照片后完全恢复原样**
- [ ] 冷启动不闪色：**内容出现之前**主题已应用（`body::before` 与卡片都已是选中的那套）
      ——判据到此为止：`base.css` 的 `:root` 兜底那一帧（JS 还没跑起来、页面本来也还没有内容）必然是默认皮肤，
      改不掉，判据写成「连那一帧也得是皮肤色」就是个永远不可能通过的验收项（详见 §5.4 末段）
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
