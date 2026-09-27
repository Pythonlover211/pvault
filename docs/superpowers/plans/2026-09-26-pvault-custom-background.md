# pvault · 自定义背景 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 给 pvault 加一套外观系统——五套配色皮肤（各带浅/深两版，深浅可跟随系统或手动指定）+ 用相册里的照片当背景，并保证开了照片之后关键数字依然看得清。

**架构：** 色板数据与换算规则放在纯模块 `app/theme.js`（能在 Node 里跑对比度断言，这是唯一能防住「某套皮肤在深色下数字看不清」的机制）；碰 DOM/IndexedDB/Canvas 的应用逻辑放在 `app/theme-store.js`；背景层是一个 `body::before` 伪元素，靠 CSS 变量驱动；照片存进新建的 `assets` 表，并随备份包走 `data.background` 字段。**色板的唯一真相在 JS 里**（写进 `documentElement` 的 inline style），CSS 只留一份默认值作首帧兜底——避免同一组色值在 CSS 与测试里各存一份而漂移。

**技术栈：** 原生 ES Modules + 手写 CSS 变量，零依赖、无构建。测试：`D:\node.exe --test --test-isolation=none`（**必须带 `--test-isolation=none`**，裸 `node --test` 会 EPERM）。

**动手前的基准：** 247 pass / 0 fail（已实测）。

**规格：** `docs/superpowers/specs/2026-09-26-pvault-custom-background-design.md`

## 代码块与仓库的镜像纪律

**本计划里贴出的每一段代码块，都必须与仓库里的实际内容逐字符一致（含注释、空行与缩进）。**
这条纪律以前只以口头说明散落在各任务里（「谁该同步、什么时候同步」全靠自觉），实测吃过亏：一个只改
`styles/base.css` 的 commit（`38d9f7c`）单独看时，两个代码块与本计划里那两份**根本对不上**——计划里
块 1 只有 6 行（实现 35 行）、块 2 只有 17 行（实现 25 行），逐行对齐后块 1 有 0 行相同、块 2 只有
3 行相同（口径：`git show <rev>:<path>` 取两边、按锚点抽段、逐行对齐比较；可复现）；要等到同一任务的
文档同步 commit（`9fb1c86`）才补上。所以在这里写成成文条款：

1. **适用范围**：每一段宣称对应仓库文件的代码块（任务里写成「与 `xxx` 逐字符一致」的那些）都必须与
   那份文件一致，注释与空行也算。规格里引用的 CSS 骨架（如 §6.2）不在此列——它是设计契约，按声明
   比对，不要求逐字符。
2. **粒度是任务的 HEAD，不是每个 commit。** 同一个任务允许「先 feat 提交、再文档同步提交」——两笔
   各自的信息密度更高，评审也好读；但**该任务收尾时 HEAD 上必须一致**。逐 commit 一致的代价会落到
   每个历史 commit 上（改一行注释就要在同一个提交里同时动代码与文档），收益不抵成本。
3. **行尾以提交内容为准，不要按工作区字节比对。** 版本库里一律是 LF（实测：`git cat-file blob
   HEAD:<path>` 对 `styles/base.css`、`app/main.js`、本计划、规格都是 0 个 CRLF），而**工作区是混杂
   的**——同一个目录里都可能不同（实测 `styles/base.css` 是 CRLF、`styles/invoice.css` 是 LF；
   `app/theme-store.js` 是 LF、`app/main.js` 是 CRLF）。仓库里没有 `.gitattributes`、`core.autocrlf=true`，
   所以工作区行尾取决于「最后一次写它的工具」。按工作区字节跑的镜像脚本会把一批文件判成假红；
   比对前按 `\n` 归一化即可。
4. **文档同步是本任务的一部分，不是额外动作。** 任务收尾时，凡是被本次改动变成假话的既有说法（代码
   注释、规格、计划、手动验证清单）都要在同一任务里改准。这是被点名最多的一类返工：任务 9 的第一轮
   返工就是它——把 `--scrim-rgb` 加进 `:root` 之后，`app/theme-store.js` 的 `paint()` 注释里那句
   「兜底清单里没有 --scrim-rgb」当场变成假话。

---

## 文件结构

**创建**

| 文件 | 职责 |
|---|---|
| `app/theme.js` | 纯模块：五套皮肤的色板数据、归一化函数、`themeCssVars()`。**不 import `db.js`、不碰 `document`**，否则 Node 测试跑不起来。 |
| `app/theme-store.js` | 应用层：读写 settings、把变量写进 `documentElement`、管理背景照片（压缩、存取、blob URL 回收）。 |
| `app/canvas-image.js` | 浏览器侧图片编解码工具（`loadViaImg` / `decode` / `releaseSource` / `drawTo`），从 `image-store.js` 搬出来共用。 |
| `app/ui/appearance-sheet.js` | 「外观与背景」面板。 |
| `styles/appearance.css` | 面板的样式（皮肤卡、遮罩滑块）。 |
| `tests/theme.test.js` | 主题纯逻辑测试（含 WCAG 对比度断言）。 |
| `scripts/check-theme-css.mjs` | 外观 CSS 的静态核验脚本（任务 9 的产物，任务 14 复核/扩展）：变量名两个方向、兜底值 ⇄ JS 运行值逐字符（**必备断言**）、`body::before` 的声明集合、规格 §6.2 ⇄ 实现、计划代码块 ⇄ `base.css` 逐字符、Markdown 围栏完整性（反引号与波浪号两种）、git blob 行尾形态；`--self-test` 做变异自检。**不写仓库**：核验模式只往 `os.tmpdir()` 落两个 git blob 探针（`<tmp>/blob-probe/`）；自检模式另有「`--tmp` 不得落在 `--root` 内」的**启动即拒**护栏。 |

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
| `sw.js` | `ASSETS` 加 5 个新文件（`canvas-image.js` 在任务 5；`theme-store.js` 与 `theme.js` 在任务 10 一起提前加——它们在同一条首屏依赖链上；`appearance.css` 在任务 11 提前加——`index.html` 挂了它的 `<link>`，它因此也是首屏依赖；最后一个 `appearance-sheet.js` **实际落在任务 12**——那一步把它接进 `settings-sheet.js` 的 `import`，比计划里写的任务 14 早了两步，理由同前四次「白名单跟产生依赖的那次提交一起走」）；`CACHE` 依次升到 `pvault-v17`（任务 10，任务 5 用的是 v16）、`pvault-v18`（任务 14——任务 11 与任务 12 两次加条目时 v17 都还没发布，按 `sw.js` 开头那条例外都没 +1）。 |
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
// 这一步只有这三个符号：归一化那 6 个函数与 MODES / DEFAULT_PRESET / DEFAULT_MODE 到任务 3 才存在，
// 那一步再把它们合并进这一条 import（此刻写进来会红在 does not provide an export named）。
import { THEMES, THEME_TOKENS, THEME_IDS } from '../app/theme.js';

// 「5 套皮肤 × 浅/深」共 10 组色板的遍历骨架，本文件里遍历色板的测试都要用它。抽成一个函数是为了让
// 那两道前置守卫只写一次——皮肤缺色板、某一档深浅缺色板时先给一句能读的断言，否则后面会死在
// TypeError: Cannot read properties of undefined 上；红是红了，但读起来像色值坏了。
//
// 深浅写死 ['light', 'dark']，不用 MODES 来遍历：MODES 里还含 'auto'，那是「跟随系统」这个选项值、
// 不是色板里的一档，混进来会去取不存在的 THEME_TOKENS[id].auto。（MODES 本身被归一化那一节 import
// 去断言 DEFAULT_MODE 合法，与这里的遍历无关。）
function forEachTokens(fn) {
  for (const id of THEME_IDS) {
    assert.ok(THEME_TOKENS[id], `缺少皮肤 ${id} 的色板`);
    for (const mode of ['light', 'dark']) {
      const tokens = THEME_TOKENS[id][mode];
      assert.ok(tokens, `${id}.${mode} 缺失`);
      fn(tokens, id, mode);
    }
  }
}

// 色板的正典清单：每套皮肤 × 每种深浅都必须**正好**是这 12 个键。
//
// 为什么写死在这里，而不是拿 THEME_TOKENS.default.light 当基准：那个基准是**自指**的，
// 在它下面「10 个 map 一起少一个变量」永远是绿的。而任务 1 只落数据，消费这些变量的 CSS
// 要到后面几个任务才写，中间这段时间 --border、--accent-weak 看起来就像没人用的死变量，
// 「顺手清理死变量」是个完全合理的动作——清理完不会有任何测试响。
//
// 为什么这份清单里**没有** --surface-rgb：它与 --surface 是同一个颜色的两种写法，
// 两份手写真相一旦不同步，卡片颜色就**只在开了背景照片时**变掉——不开照片的人永远看不见，
// 任何测试也覆盖不到。改为由 themeCssVars() 从 --surface 现算 rgba(...) 之后，
// 物理上不可能漂移，这个键也就不该再存在于色板里。
const TOKEN_NAMES = [
  '--bg', '--surface', '--surface-2', '--border',
  '--text', '--text-2', '--text-3',
  '--accent', '--accent-weak', '--on-accent',
  '--shadow', '--scrim-rgb'
];

// 每个变量的**形状**。这张表和正典清单一样是手工维护的，测试遍历它逐值断言。
//
// 为什么不写成「hex 的那些共用一条正则、其余手工单测」：那样新增一个变量时，作者只要忘了
// 给它加断言，它就没有任何测试覆盖——而「漏登记了一个」这件事在派生出来的集合里根本表达
// 不出来（派生集合永远等于它自己，拿它当守卫等于写一句恒真的话）。能真的红的那一层是
// 「这张表 ↔ 正典清单」的对照断言，任何计数式的守卫都不是。
//
// 顺带记下被换掉的那条守卫为什么有害：`assert.equal(hex 变量的个数, 10)` 既拦不住值写错
// （新变量的值会被这张表自动断言），又会把合法的扩展判红，而且报出来的是一个数字、
// 不是一条可执行的指令。
const HEX6 = /^#[0-9a-f]{6}$/;
const SHAPES = {
  '--bg': HEX6,
  '--surface': HEX6,
  '--surface-2': HEX6,
  '--border': HEX6,
  '--text': HEX6,
  '--text-2': HEX6,
  '--text-3': HEX6,
  '--accent': HEX6,
  '--accent-weak': HEX6,
  '--on-accent': HEX6,
  // 一整条 box-shadow，按当前数据的实际形状约束：三段长度 + rgba 四元组。
  // 曾经这里只查「含 rgba(」，于是 '--shadow': 'rgba(' 是绿的——而 box-shadow: var(--shadow)
  // 会因此整条失效、阴影静默消失（深色皮肤上本来就几乎看不见，更没人会发现）。
  '--shadow': /^0 \d+px \d+px rgba\(0, 0, 0, [\d.]+\)$/,
  // 三个裸通道数字，不是 hex。写成 '#ffffff' 会让 rgba(#ffffff, .3) 不是合法的 <color>，
  // CSS 在 computed-value time 判整条声明失效 → background-image: none，遮罩整层消失、
  // 卡片背景全透明。而且它比「漏写变量」更糟——漏写会退回 base.css 的 :root 兜底，
  // **写错的值会覆盖兜底**，兜底救不回来。
  '--scrim-rgb': /^\d{1,3},\d{1,3},\d{1,3}$/
};

test('theme：五套皮肤 × 深浅的变量集合与正典清单完全一致', () => {
  forEachTokens((tokens, id, mode) => {
    // 判据是「键集合与正典清单完全一致」，既不是「数量够」也不是「和 default.light 一样」：
    // 少一个变量，界面上那块会**静默**退回 base.css 里默认皮肤的颜色——它不会变成黑块或透明，
    // 只是「这块看着有点不对」，比报错难发现得多；多一个则说明这套皮肤偷偷开了新维度。
    assert.deepEqual(
      Object.keys(tokens).sort(), [...TOKEN_NAMES].sort(),
      `${id}.${mode} 的变量集合与正典清单不一致`
    );
  });
});

test('theme：正典清单里的每个变量都登记了形状', () => {
  // 两张手工维护的表必须一一对应。漏登记 → 那个变量不会被任何断言覆盖（静默漏测）；
  // 多登记 → 断言了一个色板里不存在的键。报出来的是「该去哪儿补一行」，不是一个数字。
  assert.deepEqual(
    Object.keys(SHAPES).sort(), [...TOKEN_NAMES].sort(),
    '新增/删除色板变量时，SHAPES 与 TOKEN_NAMES 必须同步登记（新变量的形状要写进 SHAPES）'
  );
});

test('theme：色值的形状与 --scrim-rgb 的明暗极性', () => {
  // 只断言键名存在等于没测：值是空串、是 'red'、是别的颜色，测试一样全绿。
  // 所以这一条逐值断言形状——它是这套测试里唯一能拦住「值写错」的关卡。
  forEachTokens((t, id, mode) => {
    for (const key of Object.keys(SHAPES)) {
      // 值缺失或被写成非字符串时 assert.match 抛的是 TypeError（信息量为零），
      // 先过一道 typeof，报出来的才是「哪个皮肤的哪个变量不对」。
      assert.equal(typeof t[key], 'string', `${id}.${mode}.${key} 不存在或不是字符串：${t[key]}`);
      assert.match(t[key], SHAPES[key], `${id}.${mode}.${key} 的形状不对：${t[key]}`);
    }

    for (const ch of t['--scrim-rgb'].split(',')) {
      const n = Number(ch);
      assert.ok(n >= 0 && n <= 255, `${id}.${mode}.--scrim-rgb 的通道越界：${ch}`);
    }
    // 极性写死：浅色皮肤用白遮罩压亮、深色皮肤用黑遮罩压暗。写反了遮罩会朝反方向走，
    // 而且越调滑块越看不清字——这是「值级」断言，不是「键级」。
    assert.equal(
      t['--scrim-rgb'], mode === 'light' ? '255,255,255' : '0,0,0',
      `${id}.${mode}.--scrim-rgb 的明暗极性写反了`
    );
  });
});

test('theme：THEME_IDS 与 THEMES、THEME_TOKENS 三者一一对应且含 default', () => {
  assert.deepEqual(THEME_IDS, THEMES.map(t => t.id));
  assert.ok(THEME_IDS.includes('default'));
  assert.equal(new Set(THEME_IDS).size, THEME_IDS.length, '皮肤 id 有重复');
  // 反向也要校验：只往 THEME_TOKENS 里加一套半成品皮肤（还没住进 THEMES）时，
  // 上面那条单向断言是绿的，而 THEME_TOKENS 里会多出一个没有名字、界面上也选不到的幽灵皮肤。
  assert.deepEqual(
    Object.keys(THEME_TOKENS).sort(), [...THEME_IDS].sort(),
    'THEME_TOKENS 的键与 THEME_IDS 不一致'
  );
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
```

- [ ] **步骤 4：运行测试确认通过**

运行：`D:\node.exe --test --test-isolation=none tests/theme.test.js`

预期：5 个测试全部 PASS

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

追加到 `tests/theme.test.js` 的**文件末尾**，作为自包含的一节（不插进已有的色板断言之间）：

```js
// ── WCAG 对比度 ───────────────────────────────────────────────────────────────
// 自己实现而不是引依赖：整套换算只用到相对亮度一个公式，而零依赖是这个项目的底线。

function parseHex(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) throw new Error(`不是 #rrggbb 形式的颜色：${hex}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// sRGB 的传递函数：把 8bit 通道值换算成线性光。低亮度段走线性，其余走 2.4 次幂。
// 名字不叫 channel——那在调用点上只说明「跟通道有关」，看不出它在做哪一步换算。
//
// 0.03928 这个分段点是 WCAG 2.x 的写法（2.2 起改成 0.04045）。这两个数在 8bit 色值上不可能
// 产生分歧——它们之间夹着的 s 区间换算回 0..255 是 (10.02, 10.31]，里面没有任何整数——
// 所以逐值算出来的结果与用新数一致，不必为了对齐新标准去改。
function srgbToLinear(v) {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

// 0.2126 / 0.7152 / 0.0722 是 sRGB 的三原色亮度权重（Rec.709）。绿色占七成，
// 所以「把红色调深一点」对对比度的贡献远小于「把绿色调深一点」——
// 这也是调色值时最容易判断失误的地方。
function luminance(hex) {
  const [r, g, b] = parseHex(hex);
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

// WCAG 的对比度是 (较亮者 + 0.05) / (较暗者 + 0.05)，谁亮谁暗由公式自己排，
// 不靠调用方保证顺序。
function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

// 「文字色 vs 它可能落在的每一种底」——方向固定是「左是文字、右是底」。
// contrast() 对调两侧得到的是同一个数，所以写反了不会有任何测试响；但意图会变成
// 「拿底色当文字色去比」，后来的人照着这一对去调色，就会朝着错误的方向使劲。
//
// surface-2 必须算进去：输入框、次级按钮都垫在它上面。--text-2 落在它上面是每一组配色里最紧的
// text 类配对（浅色皮肤里它是最暗的底、深色皮肤里它是最亮的底，两个方向都在往文字色挤；
// 默认皮肤的老值 #6e6e73 落在这里只有 4.19:1）。这话只限 text 类——这 70 对里最紧的一对是
// default.light 的 --on-accent on --accent（当前 4.665:1），它不在 text 类里。
//
// 有意排除的两类，不是漏测：--text-3 作文字色的那三对、--accent 作文字色的那一对
// （components.css 里 --accent 就是文字色，父容器是 background: var(--accent-weak)）。
// 按规格 §5.3 它们不在本断言的范围内，其中**有一部分**低于 4.5——10 组逐对算过：
// --text-3 那 30 个组合里 27 个低于（浅色三对全在 2.12~3.06；dark 下只有落在 --bg 上的三对够高，
// 4.51~4.85），--accent on --accent-weak 只有 2 对低于（default.light 4.06、paper.light 4.27），
// 另外 8 对在 4.55~6.80。所以把它们补进 CONTRAST_PAIRS 只会红一部分、不是全红，别据此以为
// 守卫坏了。要处理它们只有两条路：改色值，或者改规格；
// **不要为了让它们变绿去放松 MIN_CONTRAST**——那会连 --text、--text-2 的守卫一起废掉。
const CONTRAST_PAIRS = [
  ['--text', '--bg'], ['--text', '--surface'], ['--text', '--surface-2'],
  ['--text-2', '--bg'], ['--text-2', '--surface'], ['--text-2', '--surface-2'],
  ['--on-accent', '--accent']
];

const MIN_CONTRAST = 4.5;

test('theme：对比度对用到的变量都是 #rrggbb 形式的色值', () => {
  // 判据是**形状**，不是「在正典清单里」。区别很实在：--scrim-rgb 也在正典清单里、也是同一份
  // 色板里的变量，往 CONTRAST_PAIRS 里补一对时最容易手滑抓到它，可它不是 hex（是三个裸通道
  // 数字），按清单判定会放过它，然后主断言死在「不是 #rrggbb 形式的颜色：255,255,255」上，
  // 连是哪一对、哪套皮肤都不说。按形状判定就能当场指名。
  // 这里没有新增任何数据：SHAPES 早就被「正典清单 ↔ 形状表」那条断言钉住了。
  for (const [fg, bg] of CONTRAST_PAIRS) {
    assert.equal(SHAPES[fg], HEX6, `对比度对的文字色不是 #rrggbb 的色值变量：${fg}`);
    assert.equal(SHAPES[bg], HEX6, `对比度对的背景色不是 #rrggbb 的色值变量：${bg}`);
  }
});

test('theme：对比度公式与 WCAG 的已知值一致', () => {
  // 上面那几行公式没人会去复核，抄错了整套色板就会在错误的标准下全绿——写测试的人和写实现
  // 的人是同一个，两边一起错时没有东西会响。这条用与色板无关的已知向量把公式钉住。
  //
  // 为什么偏偏是这几个颜色：把典型抄错逐个试过之后挑的，每一类都得真有向量拦得住——
  //   0.7152 → 0.7512（绿权重抄错）      → 黑白向量红（21 变成 21.7）
  //   +0.05 偏移量漏掉或写错              → 黑白向量红（21 变成 Infinity / 201 / 3）
  //                                          （同色向量对它不敏感：两侧一起改时 (x+on)/(x+od) 恒等于 1）
  //   0.2126 ↔ 0.0722（红蓝权重对调）      → 纯红对黑红（5.252 变成 2.444）
  //   parseHex 把 rrggbb 读成 bbggrr       → 纯红对黑红（同上，红蓝一换就露）
  //   2.4 → 2.41（幂次抄错）               → 中灰对白红（偏差约 0.02，够把 4.49 判成 4.51）
  //   12.92 → 12.9（线性段除数抄错）        → 深灰对白红（只有 ≤10 的通道走线性段，黑和中灰
  //                                          都不经过它，所以必须单独放一个 #0a0a0a）
  //   0.03928 → 0.04045（换 WCAG 版本）    → 全绿，且**应该**全绿：8bit 上没有值落在这两个数
  //                                          之间（见 srgbToLinear 的注释），结果本来就不会变。
  //
  // 最后一行是这张表存在的另一半意义：分清「抄错但无感」和「抄错又有感」，免得后来的人为了让
  // 测试红，去改一个其实正确的常量。几条消息里都带上实际算出来的值——只报「应为 21:1」而看不到
  // 21.72，修的人不知道自己偏了多少。
  //
  // 容差 1e-4：浮点误差在这套运算里是 1e-15 量级，而被拦住的每一类偏差都在 1.7e-3 以上
  // （逐类算过，最小的是 12.92 → 12.9 偏 1.757e-3；0.03928 → 0.04045 那一类偏差是 0，本来就该全绿）。
  assert.ok(
    Math.abs(contrast('#ffffff', '#000000') - 21) < 1e-4,
    `黑白对比度应为 21:1，实际算出 ${contrast('#ffffff', '#000000').toFixed(4)}:1`
  );
  assert.ok(
    Math.abs(contrast('#ffffff', '#ffffff') - 1) < 1e-4,
    `同色的对比度应为 1:1，实际算出 ${contrast('#ffffff', '#ffffff').toFixed(4)}:1（+0.05 偏移量写错了？）`
  );
  assert.ok(
    Math.abs(contrast('#ff0000', '#000000') - 5.252) < 1e-4,
    `纯红对黑的对比度应为 5.252:1，实际算出 ${contrast('#ff0000', '#000000').toFixed(4)}:1（亮度权重或通道顺序错了？）`
  );
  assert.ok(
    Math.abs(contrast('#808080', '#ffffff') - 3.94944) < 1e-4,
    `中灰对白的对比度应为 3.94944:1，实际算出 ${contrast('#808080', '#ffffff').toFixed(5)}:1（2.4 次幂错了？）`
  );
  assert.ok(
    Math.abs(contrast('#0a0a0a', '#ffffff') - 19.79815) < 1e-4,
    `深灰对白的对比度应为 19.79815:1，实际算出 ${contrast('#0a0a0a', '#ffffff').toFixed(5)}:1（线性段的 12.92 错了？）`
  );
  // 参数对调必须同值：如果亮度比较那一步被写成「拿第一个减第二个」，这里立刻红。
  assert.equal(contrast('#0a6ef0', '#ffffff'), contrast('#ffffff', '#0a6ef0'));
});

test(`theme：${THEME_IDS.length} 套皮肤的文字对比度都不低于 ${MIN_CONTRAST}:1`, () => {
  // 一次跑完全部 70 对再断言，而不是每对 assert 一次：第一对不达标就中断的话，
  // 调色的人要「改一处—重跑—再看到下一处」，而这几套皮肤的色值是彼此独立的，
  // 攒齐一次报出来才能一轮改完。
  const bad = [];
  forEachTokens((tokens, id, mode) => {
    for (const [fg, bg] of CONTRAST_PAIRS) {
      // 变量被删掉或被写成非字符串时先给一句能读的断言：否则 contrast() 会死在 parseHex 抛出的
      // 「不是 #rrggbb 形式的颜色：undefined」上——红是红了，但读起来像色值写坏了，实际是这一对
      // 引用的变量没了。（与「色值的形状」那条同一个纪律：先过 typeof，再谈值对不对。）
      assert.equal(typeof tokens[fg], 'string', `${id}.${mode}.${fg} 不存在或不是字符串：${tokens[fg]}`);
      assert.equal(typeof tokens[bg], 'string', `${id}.${mode}.${bg} 不存在或不是字符串：${tokens[bg]}`);
      const ratio = contrast(tokens[fg], tokens[bg]);
      if (ratio < MIN_CONTRAST) {
        // 比值给三位小数而不是两位：色值就是在小数点后第四位做取舍的（4.6651 那对就卡在线上），
        // 两位会把 4.498 印成「4.50」——报出「4.50 却说不达标」，读的人第一反应是阈值或断言坏了，
        // 而正确的动作恰恰不是去动阈值。
        bad.push(`${id}.${mode}  ${fg} on ${bg} = ${ratio.toFixed(3)}:1  (${tokens[fg]} / ${tokens[bg]})`);
      }
    }
  });
  // 阈值从常量插值，不在这里写死第二个「4.5」：写死的话，把 MIN_CONTRAST 改成别的值，
  // 报错还在说 4.5，读的人会去核对一个早就不是阈值的数字。
  // 报出「皮肤.深浅 + 哪一对 + 实际比值 + 用到的两个色值」，四项缺一不可：这条断言的唯一修法是
  // 改色值（或查出上面那条公式自证也红了——那是公式抄错，不是色板的问题），信息不全的报错
  // 等于把活原样退回给读日志的人。判失败用 `<`：AA 正文标准要求的是 ≥ 4.5。
  assert.equal(
    bad.length, 0,
    `这些配色达不到 ${MIN_CONTRAST}:1（AA 正文标准），必须调色值：\n${bad.join('\n')}`
  );
});
```

- [ ] **步骤 2：运行并处理结果**

运行：`D:\node.exe --test --test-isolation=none tests/theme.test.js`

预期：**全绿**（规格里的色值本来就是按这条规则挑的）。

**如果报红**：先看「对比度公式与 WCAG 的已知值一致」那条是不是也红了——它也红就说明是公式抄错了（亮度权重、2.4 次幂、线性段的 12.92），**不是色板的问题**，这时候去调色值只会把本来正确的颜色改坏。只有主断言单独红时，才按报告里的那一对去调那个皮肤的色值（`--text-2` 最深、`--on-accent` 往背景色方向靠、`--accent` 往深色方向压），改到全绿为止。这是设计规格 §5.3 里写明「以测试为准、不迁就表格」的意思。

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

追加到 `tests/theme.test.js`，并把 `MODES` / `DEFAULT_PRESET` / `DEFAULT_MODE` 与这 6 个归一化函数合并进文件顶部那一条 import（它们的实现在本任务才出现，所以任务 1 那一步的 import 里没有它们）：

> 下面 `normalizePreset` 那条注释里提到的「themeCssVars 那一节」是**任务 4 才追加**的：重放到本任务时文件里还没有那一节，那时拼错 `DEFAULT_PRESET` 只会红上面这一条。任务 4 落地之后那句才成立（两边的期望值都来自 `default` 的色板）。

```js
// ── 归一化与解析 ─────────────────────────────────────────────────────────────
// 这一节处理的都是外来的脏值：设置从库里读出来（可能被用户用 devtools 手改过、可能是老版本写下的
// 另一种形状、也可能某一版压根没写过），滑块的 el.value 送进来的是字符串。判据统一是「不认识就
// 退回一个安全的默认值」，而不是抛错——外观读不出来不该让整个 app 打不开，一个坏值也不该一路走到
// 界面上变成透明的黑块。
// 这一节用到的函数与常量都在文件顶部那一条 import 里，不再单独 import 一次同一个模块。

// 断言消息里的输入标签：用 String() 而不是 JSON.stringify()——后者把 NaN 与 Infinity 都印成
// "null"，跟真正的 null 撞成同一句话，失败时分不清是哪一个输入漏了。typeof 一并带上：
// '' 与 [] 的 String() 都是空串，只有靠类型才分得开。数组再单列一支：String([]) 是空串，
// 不特判的话标签会退化成「(object)」，跑日志时读不出是哪一个。
const junkLabel = v => (Array.isArray(v) ? '[](array)' : `${String(v)}(${typeof v})`);

test('normalizePreset：认识的留下，其余一律回默认', () => {
  // 常量本身合法是这一节的前置条件，不是兜底逻辑的功劳。两种漂移看到的报错不一样，别弄混：
  //   · 改成拼错的 'defualt' → 紧下面这条断言当场抓住、消息直指常量，本节的 junk 循环根本不会执行
  //     （但 themeCssVars 那一节会跟着一起红——它的期望值同样来自 default，那边有一道前置守卫把
  //     它变成一句能读的话，实测就是这两张红）；
  //   · 改成另一套合法皮肤 'paper' → 这条放行，轮到 junk 循环报「输入 undefined(undefined) 没被兜住」，
  //     那时读者才会误以为坏的是兜底实现（themeCssVars 那一节也会跟着红，不过它跑在这条之后，
  //     抢不到前面，且那边的守卫消息同样直指常量）。
  // （normalizePreset('default') 那条查不出这件事——'default' 只要还在 THEME_IDS 里就直接返回自己。）
  assert.ok(
    THEME_IDS.includes(DEFAULT_PRESET),
    `DEFAULT_PRESET 应当是可选皮肤之一，实际 ${DEFAULT_PRESET}`
  );
  assert.equal(normalizePreset('paper'), 'paper');
  assert.equal(normalizePreset('seaglass'), 'seaglass');
  // 默认值自己也得是合法返回值：读出来是 default、写回去仍是 default，这条路径不能把设置洗掉。
  assert.equal(normalizePreset('default'), 'default');
  // 两类最真实的误写各占一项：'Paper' 拼对了但大小写不对（写成大小写归一的实现会把它返回成
  // 'paper'），'PA' 是大写的前缀（写成前缀匹配的实现会返回 'paper'）。只放 'PA' 拦不住前一类——
  // 大小写归一那条实现下 'PA' 也会被判成不认识。
  for (const junk of [undefined, null, '', 'PA', 'Paper', 42, {}, [], 'light']) {
    assert.equal(normalizePreset(junk), 'default', `输入 ${junkLabel(junk)} 没被兜住`);
  }
  // 不 trim、不忽略大小写是判据而不是疏忽：带空格或大小写不符的 id 不属于这五套里的任何一套，
  // 猜成某一套看起来正常的皮肤，等于把一个坏值悄悄洗掉。
  assert.equal(normalizePreset(' paper '), 'default', '带空格的 id 不该被认成 paper');
});

test('normalizeMode：认识的留下，其余一律回 auto', () => {
  // 与 DEFAULT_PRESET 同一个前置条件，两种漂移同样分岔：改成另一套合法值 'light' 时这条放行、先红的
  // 是 junk 循环（原因在常量本身）；改成非法的 'DARK' 时则由紧下面这条当场抓住。
  assert.ok(
    MODES.includes(DEFAULT_MODE),
    `DEFAULT_MODE 应当是可选模式之一，实际 ${DEFAULT_MODE}`
  );
  assert.equal(normalizeMode('light'), 'light');
  assert.equal(normalizeMode('dark'), 'dark');
  assert.equal(normalizeMode('auto'), 'auto');
  // 'DARK' 回 auto 同一个道理：它不是深浅三个值里的任何一个，归成 auto 顶多是「跟系统走」，
  // 比自作主张按深色处理安全。
  for (const junk of [undefined, null, '', 'DARK', 0, {}, true]) {
    assert.equal(normalizeMode(junk), 'auto', `输入 ${junkLabel(junk)} 没被兜住`);
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
  // 系统深浅是探出来的（matchMedia(...).matches），取不到时可能是 undefined 这类 falsy 值。
  // 这时按浅色走：与「浏览器给不出深色偏好、页面本来就是浅色」一致，也不会抛错。
  assert.equal(resolveMode('auto', undefined), 'light');
});

test('normalizeOverlay：取整、夹到 0..60，非法值回默认 30', () => {
  assert.equal(normalizeOverlay(0), 0);
  assert.equal(normalizeOverlay(60), 60);
  assert.equal(normalizeOverlay(30.4), 30);
  assert.equal(normalizeOverlay(30.6), 31);
  assert.equal(normalizeOverlay(-5), 0);
  assert.equal(normalizeOverlay(999), 60);
  assert.equal(normalizeOverlay('45'), 45, '字符串数字要认（滑块的 el.value 是字符串）');
  // '0' 与 '' 是判据的分界线：'0' 是用户明确要求「不要遮罩」、'' 是「这个设置没有」。
  // 滑块那条路径看不出 `if (!value) return 30` 这个错法：滑块送的是字符串，'0' 是 truthy，照样返回
  // 0（实测）。真正钉住它的是上面那条数字 0 的断言——滑块拉到 0 会以数字形式存库，下次启动读到的就是
  // 数字 0，`!0` 为真，遮罩跳回 30，而用户并没有再动过它（实测这个错法当场红两条：normalizeOverlay(0)
  // 与 scrimAlpha(0)）。
  // 比它更早出错的写法是 `if (!Number(value))`：连字符串路径都过不去，下面那条当场红。
  assert.equal(normalizeOverlay('0'), 0);
  // 下面这批「非数字」里有五个是 Number() 的陷阱：null / '' / [] / false 给的是 0（不是 NaN）、
  // true 给的是 1。也就是说「先 Number() 再判 isFinite」这条路会把它们静默变成 0% 或 1% 的遮罩，
  // 而不是回默认值。逐个算过：这 5 个里 4 个变 0、1 个变 1；剩下的 5 项里，undefined / {} /
  // '45px' / NaN 本身给的是 NaN，Infinity 给的是 Infinity（靠 isFinite 拦下）。
  for (const junk of [undefined, null, '', NaN, Infinity, {}, [], true, false, '45px']) {
    assert.equal(normalizeOverlay(junk), 30, `输入 ${junkLabel(junk)} 没被兜住`);
  }
});

test('normalizeBackground：形状不对就是「没有背景」', () => {
  assert.equal(normalizeBackground(null), null);
  assert.equal(normalizeBackground(undefined), null);
  assert.equal(normalizeBackground('bg'), null);
  assert.equal(normalizeBackground(0), null);
  assert.equal(normalizeBackground({}), null, '没有 assetId 不算有背景');
  assert.equal(normalizeBackground({ assetId: '' }), null);
  assert.equal(normalizeBackground({ assetId: '   ' }), null);
  assert.equal(normalizeBackground({ assetId: 42 }), null);
  // 规格 §9.1 举过 { overlay: 999 } 这个例子：有 overlay、缺 assetId，仍然是「没有背景」——
  // 一个坏 overlay 不能凭空造出一个指向不存在的图的背景。（实测把 assetId 判据放宽成「有 overlay
  // 也算」，这条会红：返回值变成 { assetId: '', overlay: 60, createdAt: null }。）
  assert.equal(normalizeBackground({ overlay: 999 }), null);
  // 数组的 typeof 也是 'object'，所以它不是被类型判据拦下的，而是走到「没有 assetId」那一关才被判
  // null。单列这一条只是为了钉住结果：[] 与 0 都必须回 null。
  // 它钉不住 typeof 判据——实测把判据削成只看 truthy（`if (!value) return null`）时这两条仍然全绿，
  // 因为 0 走 `!value` 短路、[] 走到 assetId 关，两条路都不经过 typeof 判据。真能区分 typeof 的是
  // 「带 assetId 的函数对象」这种合成输入（削掉判据后它会返回 { assetId: 'bg', … }），它没有真实
  // 来源，不值得为它加断言。
  assert.equal(normalizeBackground([]), null);

  assert.deepEqual(
    normalizeBackground({ assetId: 'bg', overlay: 45, createdAt: 1700000000000 }),
    { assetId: 'bg', overlay: 45, createdAt: 1700000000000 }
  );
  // assetId 首尾空白要去掉：它被拿去 assets 表查那张图，' bg ' 查不到任何记录，表现出来是
  // 「设置说有背景、界面上却是空的」，而库里那张图其实好端端躺着。
  assert.deepEqual(
    normalizeBackground({ assetId: ' bg ' }),
    { assetId: 'bg', overlay: 30, createdAt: null }
  );
  // overlay 缺失或非法时补默认值，不能让一个坏 overlay 把整条背景作废——坏掉的只是滑块那一个数，
  // 作废等于把用户选的那张照片也一起丢了。
  assert.deepEqual(
    normalizeBackground({ assetId: 'bg' }),
    { assetId: 'bg', overlay: 30, createdAt: null }
  );
  assert.deepEqual(
    normalizeBackground({ assetId: 'bg', overlay: 'nonsense' }),
    { assetId: 'bg', overlay: 30, createdAt: null }
  );
  // 只留这三个字段：返回值会被任务 8 用 `{ ...bg, overlay }` 原样写回库，透传出去的脏字段会被持久化
  // 下来，之后每读一次都在。（实测把 return 改成 `{ ...value, assetId, overlay, createdAt }`，其余
  // 断言全绿，只有这一条拦得住。）
  assert.deepEqual(
    normalizeBackground({ assetId: 'bg', junk: 1 }),
    { assetId: 'bg', overlay: 30, createdAt: null }
  );
  // 不就地改写传入的对象：现在的调用点都是从 getSetting 拿到的新对象，看不出问题，但「把入参改掉再返回
  // 它」属于换一个调用点才炸的写法，一条断言就能钉住。
  const raw = { assetId: 'bg', overlay: 45 };
  normalizeBackground(raw);
  assert.deepEqual(raw, { assetId: 'bg', overlay: 45 }, 'normalizeBackground 不该改写传入的对象');
  // createdAt 的判据比 overlay 紧，只认真正的数字：Number() 会把 null / '' / false 都变成 0，而 0 是
  // 1970-01-01——一个像真实时间的哨兵值，会污染将来任何要展示或比较它的地方（这个字段目前没有消费点，
  // 正因为还没有，才不该让 0 混进去）。overlay 必须认字符串是因为滑块的 el.value 天生是字符串；
  // createdAt 没有这样的来源（它是 Date.now() 写进去的），所以收紧不会误伤真实数据。
  assert.deepEqual(
    normalizeBackground({ assetId: 'bg', createdAt: null }),
    { assetId: 'bg', overlay: 30, createdAt: null }
  );
  assert.deepEqual(
    normalizeBackground({ assetId: 'bg', createdAt: '1700000000000' }),
    { assetId: 'bg', overlay: 30, createdAt: null }
  );
});

test('scrimAlpha：百分比换算成 0..0.6 的小数', () => {
  assert.equal(scrimAlpha(0), 0);
  assert.equal(scrimAlpha(60), 0.6);
  assert.equal(scrimAlpha(30), 0.3);
  // 越界值走的是同一条归一化，不是另一套判据：--scrim-a 会被原样送进 rgba(..., var(--scrim-a))，
  // 而滑块能表达的只有 0..60——「送出去的一定落在 0..0.6」这件事只能由这里保证。
  assert.equal(scrimAlpha(999), 0.6);
  assert.equal(scrimAlpha(-5), 0);
  // 非法输入走 normalizeOverlay 的默认值 30，而不是 NaN——NaN 不是合法的 alpha，替换进 rgba() 之后
  // background-image 属性会在 computed-value time 失效并回退到初始值 none，遮罩与照片两层一起没了。
  assert.equal(scrimAlpha('nonsense'), 0.3);
  // 规格 §9.1 点名的 NaN 单列一条：它落在「类型是数字但非有限」那条分支上，跟字符串解析失败不是同一条
  // 路，别用一个 'nonsense' 代表全部非法值。
  assert.equal(scrimAlpha(NaN), 0.3);
  // 这里用 === 而不是容差是逐值比对过才敢写的：0/100、30/100、60/100 与字面量 0、0.3、0.6 在
  // 双精度下是同一个数，除法结果恰好落回同一个双精度值上。
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`D:\node.exe --test --test-isolation=none tests/theme.test.js`

预期：FAIL —— `normalizePreset is not a function`（或 `does not provide an export named`）

- [ ] **步骤 3：在 `app/theme.js` 末尾追加实现**

```js
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

追加到 `tests/theme.test.js`，并把 `themeCssVars` 合并进文件顶部那一条 import（它的实现在本任务才出现，所以任务 1~3 那几步的 import 里没有它）：

```js
// ── (皮肤, 深浅, 有无照片) → CSS 变量 ────────────────────────────────────────
// themeCssVars 是整个外观系统里**唯一**做这层翻译的地方：theme-store 只把它给的键逐个 setProperty
// 出去（另外三个取决于运行时状态的变量由那边自己设），所以它的输出形状就是那个契约——多一个键、
// 少一个键都会直接漏到页面上，这一节测的就是它。
// 用到的 themeCssVars 合并进了文件顶部那一条 import，不再单独 import 一次同一个模块。

test('themeCssVars：不认识的皮肤/深浅都退回默认', () => {
  // 前置守卫，不是兜底逻辑的功劳：下面每一条都拿 default 的色板当期望值，所以「DEFAULT_PRESET 真的
  // 指向 default」是这一节的前提。少了它，DEFAULT_PRESET 被拼错时这里会死在
  // `THEME_TOKENS['defualt'][...]` 的 TypeError: Cannot read properties of undefined 上——红是红了，
  // 读起来却像色板缺了一档（实测拼成 'defualt' 与改成 'paper' 都会红这一条，消息直指常量）。
  assert.equal(
    DEFAULT_PRESET, 'default',
    `这一节的期望值全部来自 THEME_TOKENS.default，DEFAULT_PRESET 实际是 ${DEFAULT_PRESET}`
  );

  // 三种「不认识」各走一条不同的路，不能互相代表：
  //   · 皮肤和深浅都坏 → 退 default.light；
  //   · 皮肤坏、深浅传进来的是好的 'dark' → 必须是 default.**dark**。写成「拿原始 themeId 去索引、
  //     兜底落回 default.light」（`THEME_TOKENS[themeId]?.[resolved] ?? THEME_TOKENS.default.light`）
  //     时，themeCssVars('nope', 'nope') 那一条是全绿的（兜回来的正好就是它），下面这几条里只有
  //     'nope', 'dark' 会响——而它会让「用户选了深色、皮肤 id 又恰好被改坏」的人看到浅色卡片。
  //     实测：那个写法下红的就是这一条，actual 是 default.light 那一套、expected 是 default.dark 那一套。
  //   · 'auto' 不是色板里的一档（它该先被 resolveMode 解析成 light/dark）；万一漏传进来，
  //     按浅色处理，不能抛错。
  assert.deepEqual(themeCssVars('nope', 'nope'), THEME_TOKENS.default.light);
  assert.deepEqual(themeCssVars('nope', 'dark'), THEME_TOKENS.default.dark);
  assert.deepEqual(themeCssVars('default', 'auto'), THEME_TOKENS.default.light);

  // 组合也要测：「不认识的皮肤」×「开着照片」。这一节前面那十几项全是 photo: false，照片那两张又全用
  // 合法 id——两条路径各自被测、组合没人测。实测：把照片分支的取值换成未归一化的 id
  // （`hexToRgb(THEME_TOKENS[themeId]?.[resolved]?.['--surface'])`）时 18 条全绿，而它在「用户手改坏
  // preset、同时又开着背景照片」时会抛 `hexToRgb：不认识的色值 undefined`——抛点在任务 7/10 的首屏路径上。
  assert.deepEqual(
    themeCssVars('nope', 'dark', { photo: true }),
    { ...THEME_TOKENS.default.dark, '--surface': 'rgba(30,30,33, 0.9)' },
    '不认识的皮肤在开着照片时也要退到 default.dark 的半透明卡片（照片这条路径同样得先归一化）'
  );

  // 深浅这一维的脏值逐个列：来源各不相同（'DARK' 是大小写写错、undefined 是字段缺失、42 是类型
  // 搞错），判据只有一条——不是 'dark' 就按浅色。
  for (const junk of ['auto', undefined, null, 'DARK', 42, {}, []]) {
    assert.deepEqual(
      themeCssVars('default', junk), THEME_TOKENS.default.light,
      `深浅 ${junkLabel(junk)} 没被兜成浅色`
    );
  }

  // 皮肤这一维：themeCssVars 的入参常常直接来自 getSetting，可能被用户在 devtools 里手改过。
  // 'Paper' 与 ' paper ' 单列，是因为 trim / 转小写这类看起来更「贴心」的归一化会静默把它们洗成
  // paper——那等于把一个坏值变成一个看着正常的皮肤，回 default 才是安全的那一套。
  for (const junk of [undefined, null, '', 42, {}, [], 'Paper', ' paper ']) {
    assert.deepEqual(
      themeCssVars(junk, 'light'), THEME_TOKENS.default.light,
      `皮肤 ${junkLabel(junk)} 没被兜成默认皮肤`
    );
  }
});

test('themeCssVars：开照片时只有 --surface 变成半透明', () => {
  const plain = themeCssVars('paper', 'light');
  const withPhoto = themeCssVars('paper', 'light', { photo: true });

  assert.equal(plain['--surface'], '#ffffff');
  assert.equal(plain['--surface-2'], '#f3ece0', '不开照片时 surface-2 就是皮肤原值');
  assert.equal(withPhoto['--surface'], 'rgba(255,255,255, 0.9)');

  // --surface-2 必须一动不动：垫在它上面的是输入框、次级按钮这类必须看清文字的控件，
  // 透了它们会跟着照片纹理一起花掉（规格 §6.3 的硬要求）。
  assert.equal(withPhoto['--surface-2'], plain['--surface-2'], 'surface-2 不许被改成半透明');

  // 「只有 --surface 变」用一个差集来钉（`Object.keys(plain)` 里过滤出值不一样的键），不逐键写死期望值：
  // 差集失败时直接报出被改动的键名（`实际改动了这些变量：--surface、--surface-2`），而逐键断言只会说
  // 某个键的值不对，读的人还得自己去拼「到底改了几个」。这两种写法在「以后新增变量」上没有区别——
  // 差集和逐键比较遍历的都是 Object.keys(plain)，新变量都会自动进圈，别把「自动进圈」当成选差集的理由。
  const changed = Object.keys(plain).filter(key => withPhoto[key] !== plain[key]);
  assert.deepEqual(
    changed, ['--surface'],
    `照片模式只该改 --surface，实际改动了这些变量：${changed.join('、') || '（无）'}`
  );

  // 两种模式的键集合必须完全一致，而且必须正好是正典清单本身。只和「彼此一样」还不够：
  // --surface-rgb 是任务 1 删掉的那份副本（同一个颜色的两种写法），它一旦从这条路漏出去，
  // paint() 会把它一路 setProperty 到 <html> 上——两份真相就换一种形式长回来了。
  assert.deepEqual(Object.keys(withPhoto).sort(), Object.keys(plain).sort(), '两种模式的变量集合必须完全一致');
  assert.deepEqual(
    Object.keys(withPhoto).sort(), [...TOKEN_NAMES].sort(),
    `themeCssVars 的输出必须正好是正典清单里的 ${TOKEN_NAMES.length} 个变量（不该多出 --surface-rgb 这类内部中间值）`
  );
});

test('themeCssVars：半透明的通道从 --surface 现算，10 组逐组比对', () => {
  // 浅色那 5 套的 --surface 全是 #ffffff，所以「只测浅色」的断言挡不住「hexToRgb 其实没换算」这类错
  // ——把实现换成硬编码的 '255,255,255'，浅色那条仍然绿。整份文件实测红两条：先红的是上一张测试里那条
  // 「不认识的皮肤 × 开着照片」的组合断言（它要的是 default.dark 的 rgba(30,30,33, 0.9)，拿到的是白色），
  // 然后才是这张里的 seaglass dark（`+ 'rgba(255,255,255, 0.9)' - 'rgba(22,38,42, 0.9)'`）。
  // 但 seaglass dark 也只是排在这张的最前面，不是「只有它拦得住」：实测把它注释掉再跑，规格 §6.3 点名的
  // default.dark 那条立刻红（`+ 'rgba(255,255,255, 0.9)' - 'rgba(30,30,33, 0.9)'`）；三条字面量全注释掉
  // 就轮到下面的循环，第一个红的还是 default.dark
  // （`default.dark 的 rgba 通道不是从 --surface #1e1e21 现算的`）。
  // 深色 5 套的 --surface 各不相同（逐组算过：default #1e1e21 → 30,30,33；paper #262019 → 38,32,25；
  // sage #1e261e → 30,38,30；wisteria #211b2c → 33,27,44；seaglass #16262a → 22,38,42），所以深色的
  // 每一组都能被这三层里的某一层拦下（seaglass.dark 与 default.dark 上面实测过，paper/sage/wisteria
  // 由那个循环兜住）。
  // 顺带记一笔通道顺序写反（红蓝对调）的覆盖面：10 组里只有 4 组的 r 与 b 不同（default.dark、
  // paper.dark、wisteria.dark、seaglass.dark），另外 6 组 r=b（5 组 #ffffff 与 sage.dark 的 30/30）
  // ——也就是说只测浅色的话，连通道写反都发现不了。
  assert.equal(themeCssVars('seaglass', 'light', { photo: true })['--surface'], 'rgba(255,255,255, 0.9)');
  assert.equal(themeCssVars('seaglass', 'dark', { photo: true })['--surface'], 'rgba(22,38,42, 0.9)');
  // 规格 §6.3 点名的这一组单列一条：它是文档与实现之间唯一写死过的例子。
  assert.equal(themeCssVars('default', 'dark', { photo: true })['--surface'], 'rgba(30,30,33, 0.9)');

  // 上面三条字面量只能证明「这三组对」，证明不了「十组都是现算的」。逐组把输出里的通道与该组
  // --surface 解出来的通道对上，这才是「现算」这个说法的判据（10 组全跑，用的是文件里已有的 parseHex）。
  forEachTokens((tokens, id, mode) => {
    const vars = themeCssVars(id, mode, { photo: true });
    const m = /^rgba\((\d+),(\d+),(\d+), ([\d.]+)\)$/.exec(vars['--surface']);
    // 形状不对时先给一句能读的：否则下一行的 m[1] 会死在 TypeError: Cannot read properties of null 上。
    assert.ok(m, `${id}.${mode} 的 --surface 不是 rgba(r,g,b, a) 的形状：${vars['--surface']}`);
    assert.deepEqual(
      [Number(m[1]), Number(m[2]), Number(m[3])], parseHex(tokens['--surface']),
      `${id}.${mode} 的 rgba 通道不是从 --surface ${tokens['--surface']} 现算的：${vars['--surface']}`
    );
    // 0.9 写成字面量而不是 PHOTO_SURFACE_ALPHA：这个数是规格 §6.3 定死的（太透文字和照片纹理打架、
    // 完全不透又白瞎一张背景图），常量真被改动时测试本来就该响一声。
    assert.equal(Number(m[4]), 0.9, `${id}.${mode} 的半透明度不是 0.9：${vars['--surface']}`);
  });
});

test('themeCssVars：返回值是副本，改它不会污染色板', () => {
  // 调用方（theme-store 的 paint()，任务 7）只把返回的键逐个 setProperty 出去、不往里面写；副本挡的是
  // 「下一个调用方」：返回值一旦就是色板对象本身，任何一次就地写（`vars['--bg'] = '#000000'`）就永久改
  // 掉了全模块共享的 THEME_TOKENS，而且改动只落在「那一套皮肤 × 那一档深浅」上——形状断言只认 HEX6
  // 这一层，'#000000' 照样匹配，所以它不会响，改坏的颜色会一路带到界面上。
  const vars = themeCssVars('sage', 'dark');
  vars['--bg'] = '#000000';
  assert.notEqual(THEME_TOKENS.sage.dark['--bg'], '#000000', '色板被调用方改掉了');

  // 但上面那条 notEqual 走的是 photo: false 这条路，抓不到「照片分支改的是色板本身」那种写法
  // （`if (photo) base['--surface'] = ...`，返回值仍是副本）：实测换上去之后那条 notEqual 照样绿
  // （它只碰 sage.dark 的 --bg），能直接抓住它的只有下面这个快照比对——这一条单独跑会红在
  // 「不该改动 THEME_TOKENS 本身」。
  // 跑整份文件时轮不到它出声：那个写法一共红四条，这一条死在 hexToRgb 的抛错上——
  // `hexToRgb：不认识的色值 rgba(30,30,33, 0.9)`（最先那张测试里的组合断言先把 default.dark 的
  // --surface 写脏了）。另三条：「不认识的皮肤/深浅都退回默认」红在组合断言的 deepEqual 上（副本里
  // 的 --surface 还是 hex），「开照片时只有 --surface 变成半透明」与「半透明的通道从 --surface 现算」
  // 都报 `+ '#ffffff' - 'rgba(255,255,255, 0.9)'`（副本是在写色板之前复制的，返回的还是原值）。
  // 等价的「返回值就是色板本身」（`const vars = base`）红法完全不同：这一条死在上面那条 notEqual 的
  // 「色板被调用方改掉了」上（快照同样轮不到），「10 组逐组比对」则死在 hexToRgb 上——别把某一次的
  // 红法当成这类写法的通用红法。
  const snapshot = JSON.parse(JSON.stringify(THEME_TOKENS));
  themeCssVars('default', 'dark', { photo: true });
  themeCssVars('paper', 'light', { photo: true });
  assert.deepEqual(THEME_TOKENS, snapshot, 'themeCssVars 不该改动 THEME_TOKENS 本身');
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`D:\node.exe --test --test-isolation=none tests/theme.test.js`

预期：FAIL —— 整个文件加载不起来：

```
SyntaxError: The requested module '../app/theme.js' does not provide an export named 'themeCssVars'
```

（ESM 的命名导入在**模块实例化**阶段就检查，所以红法不是「`themeCssVars is not a function`」这种运行期
报错——真要是死在函数体里，说明 import 已经成功了，那就不是这一步该有的红。实测：`ℹ tests 1 / pass 0 /
fail 1`，整个文件算一条失败记录，前面 14 条老断言一条都没跑到。）

- [ ] **步骤 3：实现**

追加到 `app/theme.js`：

```js
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

把 `image-store.js` 里那四个函数（`loadViaImg` / `decode` / `releaseSource` / `drawTo`）**连同注释原样搬过来**，四个函数都加 `export`，并在文件头写：

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

**下面三处原文没写、但漏了就直接坏（或让旁边的注释变成假话），执行时补上：**

1. `canvas-image.js` 里要加 `import { computeTargetSize } from './image-scale.js';`——`drawTo` 用它，
   原来靠 `image-store.js` 那份 import 供着，搬走就断了。漏掉的后果是浏览器里的 `ReferenceError`，
   而这两个文件都在 Node 测试范围之外，全量测试不会报出来。
2. `image-store.js` 侧要从 `image-scale.js` 的 import 清单里删掉 `computeTargetSize`——它随 `drawTo`
   一起搬走了，留在这边已经没人用。
3. 这次搬移会让两处**既有**注释变成假话，要一并改掉（前四个任务被打回的正是这一类）：`app/image-scale.js`
   里「真正的 Canvas 压缩在 `image-store.js` 里」改成 `canvas-image.js`；`app/file-info.js`
   里「那个文件依赖 Canvas / Blob / indexedDB」改成「那个文件（以及它 import 的 canvas-image.js）依赖
   Canvas / Blob / indexedDB」——Canvas 依赖现在是间接的，而那句的论证（在 Node 里 import 不了）靠的是
   indexedDB / Blob，仍然成立。（两处都用**引文本身**定位，不写行号——它们都在文件头那几行注释里，
   文件名一改位置就飘；**这两句后来在任务 5 实现时都已经改准**：实测 `app/image-scale.js` 里现在写的是
   「真正的 Canvas 压缩在 canvas-image.js 里」、`app/file-info.js` 里是「那个文件（以及它 import 的
   canvas-image.js）依赖」，所以这一条对**任务 5 的实现者**是待办，对**今天读计划的人**是历史。）

- [ ] **步骤 2：改 `app/image-store.js`**

删掉 `loadViaImg` / `decode` / `releaseSource` / `drawTo` 四个函数（第 15–86 行），在 import 区加上：

```js
import { decode, drawTo, releaseSource } from './canvas-image.js';
```

其余代码一行都不动（`prepareFile` 里的调用点签名完全相同）。

- [ ] **步骤 3：确认没有残留的引用**

运行：`D:\node.exe --test --test-isolation=none`

预期：265 pass / 0 fail（任务 1-4 完成后基准线就是这个数；`image-store.js` 不在 Node 测试范围里，这一步只是确认没有把 import 图改坏）

再运行一次搜索确认 `image-store.js` 里已经没有这四个函数的定义：

```powershell
Select-String -Path app/image-store.js -Pattern 'function (loadViaImg|decode|releaseSource|drawTo)'
```

预期：无输出

- [ ] **步骤 4：Commit**

```bash
git add app/canvas-image.js app/image-store.js app/image-scale.js app/file-info.js docs/superpowers/plans/2026-09-26-pvault-custom-background.md
git commit -m 'refactor(image): 图片编解码工具抽到 canvas-image.js 供背景图复用'
git add sw.js
git commit -m 'chore(sw): canvas-image.js 提前进预缓存白名单，避免消费方先行的 404 白屏'
```

**第二个 commit 不能挪到任务 14**：本步让 `image-store.js` 静态依赖 `canvas-image.js`，而 SW 是 cache-first——
清单里没有它，已装旧缓存的设备离线启动就会断在 `main → invoice-view → invoice-editor → image-store →
canvas-image` 这一环：那个模块加载不了（缓存未命中 → 离线回退 `index.html` → 模块脚本被 MIME 检查拒绝，
机制写在 `sw.js` 开头那段；**不是 404**），import 链一断是**整个 app 白屏**（不只是发票面板）。这与 v14 那次
（`file-info.js`）是同一条规矩：**白名单必须跟产生依赖的那次提交一起走，不能等到收尾再补**。具体改法：
`ASSETS` 加 `'./app/canvas-image.js'`（排在 `budget.js` 与 `chart.js` 之间，保持 ASC 书写风格）、`CACHE`
升到 `'pvault-v16'` 并写下这一版的说明。外观功能其余的文件此刻还不存在：`theme-store.js` 与 `theme.js`
由任务 10 一起进清单（那一步让 `main.js` 静态依赖 `theme-store`，而 `theme-store` 又静态依赖 `theme`），
`ui/appearance-sheet.js` 与 `appearance.css` 那时都还没建——后来分别由任务 11（`appearance.css`：
`index.html` 挂了它的 `<link>`，它因此是首屏依赖）与任务 14（`appearance-sheet.js`，要等任务 12 把
`settings-sheet.js` 的 import 接上）进清单。

**白名单要全量校验一遍**（`cache.addAll` 是原子的，一个 404 就让整次 install 失败——那时 SW 不激活，
表现是「离线能力为 0」；而**漏掉一条**的机制完全不同，见 `sw.js` 开头那段）：把 `sw.js` 里的 `'./…'`
路径抽出来逐个 `Test-Path`。任务 14 步骤 2 里有现成脚本（**任务 10 返工时已把它收紧到 `ASSETS` 切片内**，
见那一步），这里跑完的实测结果是 **`全部存在，共 56 个`**（`ASSETS` 里是 57 个条目，其中 `'./'`
不匹配那条正则、脚本不数它）。

- [ ] **步骤 5：发票图片的回归验证（不能省）**

**这一步的执行位置是任务 15 步骤 3 的第 5 条**——本机没有可用的浏览器环境（`puppeteer-core` 未安装、系统
Edge 的 `--headless` 输出为空）。任务 5 交付时只做静态验证：`node --check` 两个文件、真 import 两个模块、以及在
Node 里真调 `prepareFile` 的 PDF / OFD / 图片三条非 Canvas 分支（图片那条会走到 `decode → loadViaImg` 才抛错，
恰好证明跨模块调用与失败回退都还在）。**下面这四步必须由任务 15 步骤 3 的第 5 条逐项接住**——不点名就会漏：
任务 15 步骤 1 新增的那个清单章节只管皮肤与背景，接不住发票这条路径。

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

`tests/schema.test.js` 三处（**定位一律用锚点，不要数行号**——这份文件还在长，行号是消耗品）：

`test('STORES 覆盖全部 9 个仓库且每个都有 keyPath', …)` 那条，`8 个仓库` 改成 `9 个仓库` 并把 `assets` 加进数组（`sort()` 之后 `assets` 排在最前）：

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

`applyMigrations 不重复创建已存在的仓库` 那条里的 `assert.deepEqual([...db.created.keys()], […])`（锚点：那串以
`'reimbursements'` 结尾的仓库名数组），把 `assets` 追加到末尾：

```js
  assert.deepEqual(
    [...db.created.keys()],
    ['accounts', 'categories', 'receivables', 'invoices', 'invoiceFiles', 'reimbursements', 'assets']
  );
```

新增一条（文件末尾那几条的后面即可）：

```js
test('DB_VERSION 已提到 3', () => {
  assert.equal(DB_VERSION, 3);
});
```

再在 `test('STORES 里有发票相关的三张表', …)` 那组之后追加一条：

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
//
// 新增表必须**同时**上调这个数字：applyMigrations 只在 versionchange 时被调用（生产代码里唯一
// 调用点是 db.js 的 onupgradeneeded），老库不会补建缺的表。漏了这一步没有任何测试能发现
// （实测：加第 10 张表、把 tests/schema.test.js 那两处清单都改对、只有这里不动，测试仍旧全绿）；
// 症状要等「新功能一用就抛错」才暴露（db.transaction 对不存在的表抛 NotFoundError）。
// 反方向不成立：只改代码、不动结构时可以不动版本号（OFD 那次就刻意保持 2），所以这里不加
// 机械断言——那会逼出假阳性。
export const DB_VERSION = 3;
```

在 `STORES` 里 `reimbursements` 之后追加：

```js
  // 外观系统的资源表：目前只有一张背景照片，id 固定 'bg'。
  // 为什么不塞进 settings：settings 是 JSON 值，图片只能存 base64（体积膨胀 1/3），
  // 而且导出备份时 getAll('settings') 会把这几百 KB 的字符串整表读进内存。
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
- 修改：`index.html`（步骤 5：两条 `meta[name=theme-color]` 合成一条不带 media 的）

- [ ] **步骤 1：写模块骨架与「应用」逻辑**

```js
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
 * 当前背景图在用的那个 blob URL（没有照片时是 null）。给「外观与背景」面板的缩略图用。
 * **调用方不要 revoke 它**：背景层正拿它当 --bg-image，释放掉背景就没了；它的生命周期归本模块
 * （setPhotoVars 在换图 / 移除时释放上一个）。
 * 为什么让调用方共享这一个、而不是自己 createObjectURL 一份：面板的缩略图**每次重绘都要一个新 src**，
 * 自建就得在每次重绘前 revoke 上一个——漏一次多一个 URL 条目，而这里重绘很频繁（每点一次皮肤 / 深浅
 * 都会重建面板）。共享这一份的 revoke 责任只有一处。
 * **这条「不要 revoke」是注释约定，没有运行时机制拦着**：真要防住得每次现建一个副本、由调用方负责
 * 还回来，代价大于收益，所以只写在这里。
 */
export function currentPhotoUrl() {
  return photoUrl;
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

```

- [ ] **步骤 2：加 `initTheme` 与三个写入口**

继续追加：

```js
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
 * 一次主题失败＝本次页面生命周期停在「DOM 上 0 个变量、外观走 CSS 兜底那套」的状态，只有刷新才会重新
 * 走一遍 initTheme（走到这条路的是 db.js 的 onblocked：另一个标签页占着旧连接；视图那边会自愈，主题
 * 这边不会）。
 * **上面这段描述只维持到「有人点过皮肤 / 深浅」那一刻**——setPreset / setMode 各自 paint() 一次、把整条变量
 * 写出去，DOM 就从「0 个变量」回到有值，那时「停在默认外观」不再成立（停在的是用户刚点的那套，只是本页
 * 启动时没从库里读出来）。而它们现在点得到了：唯一一处调用方是「外观与背景」面板的皮肤 / 深浅按钮
 * （app/ui/appearance-sheet.js，任务 11 建好），那个面板由设置面板里的入口打开（任务 12 接上）。
 * 要手动补一次，也可以直接再调一次本函数。
 *
 * **它现在是首屏渲染路径上的前置依赖**（任务 10 挂上去的）：`render()` 的那次 mount 要等它跑完——
 * **只覆盖 `render()` 这条路**：主屏快捷方式那条（openFromShortcut → openEntryPanel）不经过它、与它
 * 并发（见 main.js 里那段注释与规格 §5.4 的边界段）。它做的 IndexedDB 操作是
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
  // 「卡片先实心、再突然变半透明并冒出一张照片」——规格 §5.4 要求它在 render() 那条路径上先于 mount，
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
```

- [ ] **步骤 3：语法自检**

运行：`D:\node.exe --check app/theme-store.js`

预期：无输出（退出码 0）

- [ ] **步骤 4：`index.html` 的 `theme-color` 合并成一条**

`paint()` 现在会更新 `meta[name=theme-color]` 的 `content`（写成解析后的 `--bg`），所以要先把
`index.html` 里那两条**带 media** 的 meta 合并成一条**不带 media** 的——带 media 的两条只按
系统深浅挑一条，用户手动选皮肤、手动选深浅时它根本不看，`paint()` 改了也不生效。

改成（保留默认皮肤浅色作为「JS 还没跑起来那一帧」的兜底，与 `base.css` 的 `:root` 同一个道理）：

```html
<!-- 系统栏 / 浏览器 UI 的颜色。这里只留一条**不带 media** 的：
     带 media 的两条只按系统深浅挑一条，用户手动选皮肤、手动选深浅时它根本不看，
     于是页面变了、系统栏还是默认色。真正写它的是 app/theme-store.js 的 paint()
     （按当前 resolved 的 --bg）；这一份只是 JS 还没跑起来那一帧的兜底。
     注意：APK（安卓壳）里这条 meta 完全无效，壳的状态栏由 themes.xml 写死，
     原因见 docs/superpowers/specs/2026-09-26-pvault-custom-background-design.md 的「系统栏颜色」一节。 -->
<meta name="theme-color" content="#f2f2f5">
```

- [ ] **步骤 5：Commit**

```bash
git add app/theme-store.js index.html
git commit -m 'feat(theme): theme-store 读取并应用外观设置'
```

---

## 任务 8：背景照片的压缩、存取与遮罩

**文件：**
- 修改：`app/theme-store.js`

- [ ] **步骤 1：加照片相关实现**

在 `app/theme-store.js` 顶部的 import 区补（`normalizeOverlay` 并进 `./theme.js` 那条 import 的清单）：

```js
// 解码 / 缩放 / JPEG 导出与发票那条路共用同一份（理由见 canvas-image.js 的头注释），
// 压缩参数也用发票同一套（长边 1600、质量 0.72），背景图不另立一套。
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
```

（`normalizeOverlay` 已并进 `./theme.js` 那条 import 的清单里，见本节开头。）

**任务 13 之后这个文件的现状**：上面那份是**任务 8 的 HEAD**（计划里的代码块镜的是各任务自己的 HEAD，
不是最终 HEAD）。任务 13 只动了其中一处——`applyPhoto` 的 JSDoc 里「这种记录有两个真实来源：
① 导入一份『设置里有 backgroundImage、备份包里却没有 assets』的备份」那一句：导入侧改成成对处理
之后，**导入不再能造出那种记录**，剩下的两个来源是「`removePhoto` 删库成功、清设置那一步失败」
与「用户在库里手改」（历史那一段在源码里改成了过去时，留在注释里是为了说明这段兜底当初在挡什么）。
现状见 `app/theme-store.js`。

**还要把 `applyPhoto()` 的调用补回 `initTheme()`。** 任务 7 交付时那里**故意**留空：当时
`applyPhoto` 还不存在，调它会立刻让 `initTheme` reject，而那时变量已经写进页面、监听却还没挂上
——一个「半套主题」的中间态。现在实现有了，在 `initTheme()` 的 `attachSystemListener();` **之前**插入：

```js
  await applyPhoto(bgRaw).catch(err => console.error('背景照片加载失败，按没有背景处理', err));
```

（`bgRaw` 就是上面 `Promise.all` 里读到的那份设置，直接传下去——`applyPhoto` 不再自己读一次
`settings`，冷启动总共读 3 次 `settings`（`initTheme` 那三条），不是 4 次。）

**为什么是 `await` 而不是 fire-and-forget**：`paint()` 画的是内存里的 `applied`，而卡片的不透明度
（`--surface`）与背景图（`--bg-image`）要等 `applyPhoto()` 里的第二次 `paint()` 才到位。不 await 的话
那次补画落在 `initTheme()` 返回之后（通常已经 mount 完了），冷启动时用户看到的是「卡片先实心、
再突然变半透明并冒出一张照片」。规格 §5.4 要求主题在任何 mount 之前
应用，照片是同一层外观，没有理由把它排除在外。代价只有首屏多等一次 `assets` 读（`settings` 那条
上面已经读过、直接传下去），与 mount 之后读交易列表同量级；`catch` 收在这里，一次照片读取失败
不会升级成主题失败。

顺手把任务 7 留下的那三行「这里先不调用它」的注释删掉：那三行是给「还没有 applyPhoto」这个
中间态写的，实现补上之后再留着，它就成了与代码相反的假话。同时把 `initTheme()` 那句
「可以重复调用」的注释补全：第二次会连照片一起重读，重建 blob URL 并释放上一个。

**本步做完才算关闭任务 7 的中间态**：到这里 `initTheme()` 才是一条完整的启动路径
（读设置 → 写变量 → 加载照片 → 挂监听），提交说明里要点明这一点。

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

在 `styles/base.css` 的 `:root` 块末尾（`color-scheme` 那一行之前）加（下面这一段与
`styles/base.css` **逐字符一致**——本计划的一条硬纪律，见开头「代码块与仓库的镜像纪律」一节）：

```css
  /* 背景照片相关（最终都落在下面 body::before 那一层）。四条一组，性质一样：**只在对应的
     变量从未被写过 inline 时生效**，作用是让这一层的默认状态在 CSS 里自文档化、并给将来的
     改动上保险，当前都不产生可见的渲染差异。逐条：
       · --bg-image / --bg-scrim 的值是两个 none。它俩与「两个都没写过」画出来一样——var()
         不带回退值，谁缺一个都会让整条 background-image 在 computed-value 求值时失效、两层
         一起没。所以「JS 还没跑完那一帧」「applyPhoto 在写变量之前就抛错（读 assets 抛错，
         不是记录不存在——记录不存在走 setPhotoVars(null)，DOM 上写的是显式的 none）」
         「JS 主动写 none」这三种状态渲染完全相同。兜底值必须让这一层等于不存在：
         这里若写成一个真遮罩或真色块，那一帧就会看到一整块遮罩盖住整个 app。
       · --scrim-rgb / --scrim-a 在 CSS 里**没有第二个消费点**（消费它们的是 JS 写进 inline
         style 的那条表达式，theme-store.js 的 setPhotoVars。注意这一句自己就含那两个变量名，
         按字面 grep 会命中本注释——注释里的字串不算消费点；规格 §5.2 用的是同一个口径）。
         --bg-scrim 的兜底是字面量 none，不引用它们，所以它们在这一帧同样没有可见效果。
         它们唯一可能生效的情形是「这个键从头到尾没被 inline 写过、而 --bg-scrim 那条表达式
         已经写进 DOM 了」：--scrim-a 连这条都没有——要写下那条表达式，setPhotoVars 里两行
         setProperty 就会一起跑完（自定义属性的值不做校验，这两行之间不会抛），它留在这里的
         作用只是把 OVERLAY_DEFAULT 这个默认值在 CSS 里有一份。--scrim-rgb 要走这条，前提是
         这个键从头到尾没被写过，而 paint() 那条路本来一定会写它（initTheme 里那次是
         photo=false，themeCssVars 连 hexToRgb 都不会调用），所以只剩两种可能：paint() 的
         循环漏掉它（那份「整条写出去」的合同被改坏了），或者 initTheme 在 paint() 之前就
         失败、此后那次 paint() 抛错——它唯一的 throw 是 theme.js 的 hexToRgb，要色板违反
         HEX6 才触发（规格 §5.4 把它记成已知项；而且那种色板**进不了仓库**——SHAPES 的 HEX6
         正则比 hexToRgb 的更严，它会先在单测里红）。两条路加在一起：这条兜底在能进仓库的
         状态下基本不可达。真走到那里时：没有兜底是整条
         background-image 失效（照片与遮罩一起没），有兜底至少留下一层浅色遮罩。
     四条都救不了「写过之后再漏写」的残留：inline 值优先于样式表里的 :root，真漏写时 DOM 上
     留着的是上一次写进去的旧值（--scrim-rgb 就是深色那套的 '0,0,0'）——这正是 paint() 注释
     里那句合同的原意，与这里给不给兜底无关。
     这两行兜底**不是纯粹无风险的装饰**：它把将来可能的半套写法从「显眼的失败」换成了
     「隐蔽的失败」，两个方向都写在这里，读者有权知道：
       · 只写 --bg-image、漏写 --bg-scrim（有照片、没遮罩）：没有兜底时 var(--bg-scrim) 未定义
         会让整条 background-image 失效、两层都不画，用户看到的是「照片没了」——显眼；有了
         这条兜底，它替换成 none，效果是 `none, url(…)`：**照片裸奔、没有遮罩**——功能「看起来
         正常」，缺的是那层压住照片的遮罩，所以失败更**隐蔽**。严重性要如实说：**卡片 / 面板内的
         读数**垫在 `rgba(r,g,b, 0.9)`（theme.js 的 PHOTO_SURFACE_ALPHA）上；但**首页大数字与
         页面上那些亮色文字不在卡片里**——`ledger-home.js` 把「本月支出」挂在空 class 的 div 上，
         `.ledger-amount` / `.ledger-total` 只有字号字重、没有 background，`.stack` / `.screen`
         也没有（`background: var(--surface)` 只挂在 `.card` 上），所以它们**直接压在这一层上面**。
         **受损到什么程度没有实测**：那正是规格 §6.3 与任务 15 留给真机验收的事——手动清单里
         点名要验收的就是「遮罩 0% 时还能看清首页大数字」，别在这里写成断言。
       · 只写 --bg-scrim、漏写 --bg-image：没有兜底是整层失效，有兜底则会在空背景上单独冒出
         一层遮罩。
     保留这两行的理由不是「它没有风险」，而是：四行是一组（把那句「默认状态等于不存在」显式
     写出来），而真出上面那种事时该修的是写半套的那个缺陷。代价如实记在这里。
     写法与 JS 对齐，免得同一份真相在仓库里出现两种写法：--scrim-rgb 不带空格（JS 色板里
     就是 '255,255,255'，tests/theme.test.js 的 SHAPES 把它钉成 /^\d{1,3},\d{1,3},\d{1,3}$/）、
     --scrim-a 带前导 0（scrimAlpha(OVERLAY_DEFAULT) 的结果是 '0.3'，JS 那边 String() 不会
     写出 '.3'）。
     这四条与 JS 运行值的**逐字符相等**是硬要求，而它在 CSS 这一侧**没有测试守卫**：仓库里没有
     任何测试解析 base.css 的内容（tests/theme.test.js 钉的是 JS 侧的 scrimAlpha(NaN) === 0.3，
     那条走默认分支、改 OVERLAY_DEFAULT 时它会响，但它不会提醒 CSS 这份没跟上）。--scrim-a 的
     0.3 恰恰是 OVERLAY_DEFAULT 的第二份真相：将来常量改了而这里没改，留下的就是一份**静默漂移**
     的副本。注意这里说的是副本漂移，**不是**显示上的差异——按上面的论证，这行兜底在现有代码里
     根本不会被消费，「改了常量界面会不会变」这个问题在这里不成立。仓库里守这件事的是
     `scripts/check-theme-css.mjs` 的 ③：四个兜底值 === JS 运行值，逐字符。
     --scrim-rgb 这里给的是**浅色**那份，与 --bg **不同**：--bg 在下面的 @media 深色块里补了
     深色档（`--bg: #131315` 就在那儿），--scrim-rgb 没有补。不补的理由是它在「JS 没跑完那一
     帧」本来就没有作用对象（--bg-scrim 也是 none，遮罩层不存在）；但代价要写明白——一旦这条
     兜底真的生效（就是上面那条 paint() 漏写它的路），深色档下拿到的是**白色**遮罩，极性是错的。 */
  --bg-image: none;
  --bg-scrim: none;
  --scrim-rgb: 255,255,255;
  --scrim-a: 0.3;
```

四处与初版计划的写法不同，都是刻意的：

1. **`--scrim-rgb` 不带空格**。`rgba(255, 255, 255, .3)` 与 `rgba(255,255,255,.3)` 等价，所以这不是
   渲染问题，是「同一份真相的形态」问题：`app/theme.js` 的色板（运行时唯一的真相）写的是无空格
   那一份，`tests/theme.test.js` 的 `SHAPES` 也用 `/^\d{1,3},\d{1,3},\d{1,3}$/` 把它的形状钉成
   无空格。CSS 兜底若另写一种，拿兜底与 JS 输出对表的人只能把比对放松成「忽略空格」——那等于
   把守卫调松。规格 §5.2 与 §6.2 里写的 `255,255,255` 本来就是无空格那一份，这一改是让
   `base.css` 与它们对齐。
2. **`--scrim-a` 写 `0.3` 而不是 `.3`**：同上，JS 那边 `String(scrimAlpha(OVERLAY_DEFAULT))`
   的结果就是 `'0.3'`。
3. **注释改准了（返工了两轮）**：
   - (a) 初版那句「这几个值必须让整层等于不存在，否则会看到一块纯黑或纯白的遮罩盖住整个 app」
     的因果不成立：`--bg-image`/`--bg-scrim` 缺失时，`var()` 没有回退值会让整条 `background-image`
     在 computed-value 求值时失效、两层一起没——**不写兜底也不会**冒出遮罩。这句话真正要防的是
     「兜底值本身写成真遮罩或真色块」。
   - (b) 质量审查指出「`--scrim-rgb` 给的是浅色那份，**与 `--bg` 的兜底同一个道理**」这个类比
     是**反的**：`--bg` 在 `@media` 深色块里补了深色档（`--bg: #131315`），`--scrim-rgb` 没补。
     已改成「与 `--bg` **不同**」，并写明代价——这条兜底一旦真的生效，深色档下拿到的是白色遮罩、
     极性是错的。
   - (c) 同一轮还改掉了可达性说过强的一句：「本次会话里 `paint()` 一次都没成功跑完、用户仍然选了
     照片」，改成写清前提——这个键要「从未被写过」，而 `initTheme` 里那次 `paint()` 是
     `photo=false`、不会调用 `hexToRgb`，一定会先写上它，所以只剩两种可能：循环被改坏漏掉了它，
     或 `paint()` 抛错（它唯一的 `throw` 是 `theme.js` 的 `hexToRgb`，要色板违反 HEX6 才触发，
     规格 §5.4 记成已知项）。
   - (d) 第三轮返工把「库里那张图读不出来」收窄成「读 `assets` 抛错，不是记录不存在——记录不存在
     走 `setPhotoVars(null)`，DOM 上写的是显式的 `none`」：原措辞有歧义，读成「记录不存在」就与
     实现不符了。
4. **四行统一成一种性质**（同一次返工）：`--bg-image` / `--bg-scrim` 两行同样**没有可见的渲染
   差异**（与「两个都没写过」等价），所以四条一律写成「自文档化 + 防御将来的改动」，不再只把
   `--scrim-rgb` / `--scrim-a` 叫「防御性」。
5. **`--scrim-a: 0.3` 是第二份真相，它的守卫在仓库里的脚本里**（第三轮返工补、第四轮改准）：`0.3`
   就是 `OVERLAY_DEFAULT = 30` 在 CSS 里的副本。实测仓库里**没有任何测试解析 `base.css` 的内容**
   （`tests/theme.test.js` 钉的是 JS 侧的 `scrimAlpha(NaN) === 0.3`——那条走默认分支、改常量时它会
   响；而 `scrimAlpha(30)` 与 `OVERLAY_DEFAULT` 无关，把它当例子是错的），所以 CSS 这一侧的漂移是
   静默的。`scripts/check-theme-css.mjs` 的 ③ 带着「这四条兜底值 === JS 运行值，逐字符」这条断言；
   **保留 `--scrim-a` 那一行的正当性完全建立在这条断言上**——这句**只针对 `--scrim-a`**，另外两行
   的保留理由见下一条。还要把两件事分开：这里是**副本漂移**，不是显示差异——按 base.css 注释里的
   论证，这行兜底在现有代码里不会被消费。
6. **这两行兜底不是零风险的装饰**（第三轮返工补）：`--bg-scrim: none` 会把将来「只写
   `--bg-image`、漏写 `--bg-scrim`」这种缺陷从**显眼的失败**（没有兜底 → `var()` 未定义 → 整条
   `background-image` 失效 → 两层都不画 → 用户看到「照片没了」）换成**隐蔽的失败**（有兜底 →
   `none, url(…)` → 照片裸奔、没有遮罩 → 功能「看起来正常」，缺的是那层压住照片的遮罩）。
   **受损到什么程度没有实测**：**卡片 / 面板内的读数**垫在 `rgba(r,g,b, 0.9)`
   （`PHOTO_SURFACE_ALPHA`）上，但**首页大数字与页面上那些亮色文字不在卡片里**——`ledger-home.js`
   把「本月支出」挂在空 class 的 div 上，`.ledger-amount` / `.ledger-total` 只有字号字重、没有
   background，`.stack` / `.screen` 也没有（`background: var(--surface)` 只挂在 `.card` 上），
   所以它们**直接压在照片层上**。这一条归任务 15 的真机验收（手动清单点名要验收的就是「遮罩 0%
   时还能看清首页大数字」），不写成断言。
   兜底仍然保留（四行一组、把「默认状态等于不存在」显式写出来），但这条权衡如实写进了
   `styles/base.css` 的注释。

这一段的论证如实写在 `styles/base.css` 的注释里，与上面这段代码块一样逐字符一致。

- [ ] **步骤 2：加背景层**

在 `body { … }` 规则之后追加（同样与 `styles/base.css` 逐字符一致）：

```css
/* 背景照片层。
   为什么用伪元素而不是给 body 加 background-image：body 的背景要与 --surface 的卡片、
   遮罩的层叠顺序分开管，伪元素能单独拿到 z-index: -1。
   为什么 z-index 是负的：装饰层不参与内容层叠，负值让它在 body 背景之上、在所有真实内容
   之下——比给内容逐个抬 z-index 干净得多。为什么负值不会把它藏到 --bg 底下：body::before
   的层叠上下文是根元素（body 上没有 position / z-index / transform，不建立自己的层叠
   上下文），而 html 自己没有背景——body 的 background: var(--bg) 按 HTML 的规则被传播到
   canvas、画在最底层，body 盒子上反而不再画它。所以这一层落在底色之上、内容之下。
   两层背景叠在一起：第一层是遮罩（--bg-scrim）、第二层是照片（--bg-image）；运行时由
   JS 写这两个变量（theme-store.js 的 setPhotoVars），这里一个色值都不写。
   没有照片时两个都是 none（JS 写 none，或走 :root 的兜底），整层等于不存在。
   不要加 background-attachment: fixed：移动端 WebView 对它的 cover 处理不一致，
   而这个伪元素本来就是 position: fixed，不随滚动移动。 */
body::before {
  content: '';
  position: fixed;
  inset: 0;
  z-index: -1;
  background-image: var(--bg-scrim), var(--bg-image);
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
  /* 纯装饰层，不参与命中测试。按上面的层叠关系它位于所有真实内容之下，正常情况下命中测试
     轮不到它——当前 `html, body` 是 `height: 100%`、`.app` 是 `min-height: 100%`，视口内处处
     有内容层覆盖。但这一条不该依赖那个布局前提：哪个容器的高度规则一变，或者某处内容被
     `pointer-events: none` 穿透，那个位置的命中测试就会轮到这一层。显式写死它不参与，
     既是给将来的改动上保险，也让「这层不接收交互」在样式里自明。 */
  pointer-events: none;
}
```

**不要**用 `background-attachment: fixed`：移动端 WebView 对它的 `cover` 处理不一致，而这个伪元素本来就是 `position: fixed`，不随滚动移动。

步骤 2 的注释也在第二轮返工里改过一处：`pointer-events` 那句原写作「这一层盖住整屏，不关掉命中测试
就会把所有的点击都吃掉」，质量审查指出它与同一段里「负 z-index 让它在所有真实内容之下」**自相矛盾**
——命中测试按绘制层序自上而下，位于所有内容之下的层不可能截走内容区域的点击。结论不变（该写
`pointer-events: none`），理由改成「不依赖『内容正好铺满视口』这个布局前提 + 让『这层不接收交互』在
样式里自明」。改的是因果，不是结论。

**这一段是规范推理、不是实测**（本机没有浏览器：`puppeteer-core` 未装、Edge headless 被沙箱拒绝），
所以注释里只写到「那个位置的命中测试就会轮到这一层」，没有往下断言命中之后事件落到谁身上——那一层
细节没有实测过。落点同样是任务 15 的真机验收。

- [ ] **步骤 3：静态核对默认状态没变化（本机没法渲染，这一步改成静态核对）**

这台机器上**没法在浏览器里看一眼**：`vision_html_screenshot` 报 `puppeteer-core is not installed`，
系统 Edge 的 headless 又被沙箱的命名管道权限挡住。所以「肉眼确认」挪到任务 15：「背景照片」清单里
那条「没有照片时整屏只有 `--bg` 的底色」就是它的落地——**这是一笔挂账**：`docs/手动验证清单.md`
里此刻**还没有**这条（实测该文件 821 行里「外观 / 皮肤 / 背景照片 / `--bg` / `body::before` 全是
0 命中），任务 15 步骤 1 执行时才写进去；在那之前，这一节的「肉眼确认」处于未完成状态。

这里做静态核对——**默认状态**（没有照片、JS 还没跑）下逐项确认：

1. `:root` 里 `--bg-image` 与 `--bg-scrim` 都是 `none`（改动前是「两个都没写过」，两者画出来
   都是不画：`var()` 没有回退值，缺一个就让整条 `background-image` 在 computed-value 求值时失效）；
2. `body::before` 里 `background-image: var(--bg-scrim), var(--bg-image)` 替换后是 `none, none`，
   合法、两层都不画，整层等于不存在；
3. `z-index: -1`、`pointer-events: none`、`content: ''`、`position: fixed; inset: 0` 都在；
4. `styles/` 里没有第二条 `body::before` 规则（不会与别的层打架）。

这四条里，**能静态核对的那些说法**由 `scripts/check-theme-css.mjs` 覆盖（这个脚本随本任务一起进了
仓库，跑 `D:\node.exe scripts\check-theme-css.mjs` 即可——**不写仓库**：它只往 `os.tmpdir()` 落两个
git blob 探针）：`var(…)` 两个方向的交叉比对、兜底值 ⇄ JS 输出的逐字符比对、规格 §6.2 ⇄ 实现的
逐属性比对、本计划两个代码块 ⇄ `base.css` 的逐字符比对，外加 Markdown 围栏完整性（反引号与波浪号
两种）。**条数不写死**：脚本每次都会打印一张「分组计数」
表，以它为口径。

**上面注释里那几条渲染因果**（层叠顺序、不用 `background-attachment: fixed`、命中测试）**静态脚本
核对不了**——本机没有浏览器，它们只能停在规范推理上，落点是任务 15 的真机验收。人工这边只剩
「读一遍确认逻辑没问题」。

- [ ] **步骤 4：跑全量测试（回归）**

这一节只改 CSS 与注释，但规格 §9.2 要求「现有测试全绿」，所以这一步不能省：

运行：`D:\node.exe --test --test-isolation=none`

预期：全部 PASS、**0 fail，总数与改动前一致**（实测：改动前后都是 266 pass / 0 fail）。这一节
**不新增自动化测试**——纯 CSS 改动，Node 侧没有可断言的渲染；能断言的文本约定由上面那个静态脚本
管，而它按纪律进 `scripts/`（任务 14）而不是 `tests/`。

- [ ] **步骤 5：Commit**

```bash
git add styles/base.css
git commit -m 'feat(styles): body::before 背景照片层'
```

---

## 任务 10：`main.js` 首屏接入（不闪色）

**文件：**
- 修改：`app/main.js`（步骤 1、2）
- 修改：`app/theme-store.js`（步骤 1 末：`initTheme()` 的文档注释——本步让它变成了假话）
- 修改：`sw.js`（步骤 4：`theme-store.js` 与 `theme.js` 一起进预缓存白名单）
- 创建：`tests/boot-order.test.js`（步骤 3 末：首屏启动顺序与预缓存清单的守卫）
- 修改：`scripts/check-theme-css.mjs`（步骤 3 末：加 ⑬ 与变异 M18）

- [ ] **步骤 1：加 import 与模块级 promise**

在 `app/main.js` 的 import 区加（实测落在第 9 行，紧接着 `import * as store from './store.js';`）：

```js
import { initTheme } from './theme-store.js';
```

加在 `render()` 函数之后、那段讲并发渲染的注释**之前**——也就是 `let renderSeq = 0;` 之前，但**不要**插进
那段注释与它要说明的那行变量之间（那段注释在 `let renderSeq = 0;` 上面，讲的是它为什么要存在，
插进去就散了）。**位置用锚点描述，不写行号**（本步的注释块后来被任务 12 从 1 行补成 3 行，行号当场就飘了）：

```js
// 主题必须在 render() 这条路径上先于它的 mount 应用，否则冷启动会「先闪一下默认色、再变成选中的皮肤」。
// 不写成「任何 mount」「每次冷启动」：默认皮肤 + 默认深浅档下闪的就是它自己（看不出差别），但**不是
// 所有默认皮肤的组合都看不出**——手动选深色而系统是浅色时，兜底帧走 base.css 的 :root（浅色），应用后
// 是深色，这一档照样会闪；而 openFromShortcut() 直接开录入面板的那次 mount 不走 render()，与 initTheme() 并发。
// 为什么不放在文件末尾直接 await：onChange(render) 是同步注册、可能同步触发第一次渲染，
// 把它挂在渲染路径上，两条路谁先到都保证「这一次 render 的 mount 在主题之后」。
// .catch 兜底：主题出错不该拖垮整页——照常渲染，只是外观是默认的（比白屏好得多）。兜住之后**不再重试**：
// themeReady 从此 settled，本次页面生命周期里主题就停在「DOM 上 0 个变量、外观走 CSS 兜底」的状态、
// 要刷新才恢复（典型触发是 db.js 的 onblocked——另一个标签页占着旧连接；用户关掉它，视图数据会自愈，
// 主题不会。setPreset / setMode 的调用方只有外观面板（app/ui/appearance-sheet.js，任务 11 建、设置入口
// 任务 12 接上）：点一次皮肤或深浅就会 paint()，此后「停在默认外观」这半句不再成立（停在的是他刚点的
// 那套，只是本页启动时没从库里读出来），只有「不再重试 initTheme、要刷新才恢复」这一半仍然成立）。
// 代价见 theme-store.js 的 initTheme。
let themeReady = null;
```

（上面这段注释本身也是本步改过的，返工那轮：原话是「主题必须在**任何** mount 之前应用」「**每次**冷启动
都会先闪一下」「**无论谁先触发**都保证主题先行」——三个全称都有反例，见下面步骤 3 的「核不到什么」。
现在改成限定式：「在 `render()` 这条路径上」先于「这一次 `render()` 的 `mount`」，并补上了 `.catch`
兜住之后**不再重试**的语义。）

**同一份提交里还要改准 `app/theme-store.js` 的 `initTheme()` 文档注释**（注释诚实性：本步让它变成假话）。
原文写着「少了那个 catch，一次主题失败就会升级成整页『页面加载失败』」——**实测是错的**：把 `main.js` 的
`.catch` 删掉（变异 B，见下面步骤 3 的守卫小节）之后 `mount(app, …)` 一次都不执行、整页纯空白；那句
「页面加载失败」在 `try` 内（它走的是视图渲染失败那条路），主题失败根本到不了它。改后的措辞是
「一次 mount 都不会发生：页面纯空白，控制台只有一条未处理的拒绝」，并补两条本步新产生的语义：
兜住之后不再重试（一次失败＝本次页面生命周期不再重走 `initTheme`、要刷新才恢复——**任务 12 把设置入口接上
之后**，「停在默认外观」只在没人点过皮肤 / 深浅时才成立：点一次就会 `paint()`、停在的是他刚点的那套，
典型触发是 `db.js` 的 `onblocked`）、
以及 `initTheme()` 现在是首屏挂载的前置依赖（含它到底做几次 IndexedDB 操作——**不含解码**，
`decode` 只在 `setPhoto` 那条路上）。

- [ ] **步骤 2：在 `render()` 里 await 它**

`render()` 函数体开头（`const seq = ++renderSeq;` 之后、`const renderers = …` 之前）插入（**位置用锚点描述**：
它在 `async function render(id) {` 里、那两次 `mount()`——`mount(view, …)` 与 `mount(app, view, renderTabBar(id))`
——都**在它之后**）：

```js
  await (themeReady ??= initTheme().catch(err => {
    console.error('主题初始化失败，用默认外观', err);
  }));
```

- [ ] **步骤 3：静态核对「主题先于首屏」（本机没法渲染，这一步改成静态核对）**

这台机器上**没法在浏览器里看一眼**——原因与任务 9 那一步相同：`vision_html_screenshot` 报
`puppeteer-core is not installed`，系统 Edge 的 headless 被沙箱的命名管道权限挡住。所以原步骤 3 的
「起服务、硬刷新、肉眼看有没有闪色」**在本机做不了**，它挪到任务 15：「皮肤与深浅」小节里那条
「**冷启动不闪色**」就是它的落地——**这是一笔挂账**：`docs/手动验证清单.md` 此刻**还没有**那条
（实测该文件 821 行里「冷启动 / 首屏 / 皮肤 / 外观与背景」全是 0 命中；「闪」有 2 处命中，但都在别处——
469 行讲的是改默认分类后界面不闪、733 行讲的是换图不闪退），任务 15 步骤 1 执行时才写进去；
在那之前，这一节的「肉眼确认」处于未完成状态。

原步骤 3 的第 4 条（用性能面板确认 `data-theme="paper"` 在首次绘制前就已设在 `<html>` 上）同样是浏览器
才能做的事，与上面一起挂到任务 15——它比新增的那条更严（要在 devtools 的 Performance 面板里看首帧），
真机上不一定做得到，能做就做。

这里做静态核对。逐条都是文本层的事实，命令都以 `E:\codex-project\pvault` 为工作目录、可复现：

**这一节里的行号是任务 10 当时的快照，核对时以锚点描述为准。** 任务 11 收尾时逐条实测过：`main.js` 那批
仍然逐条对得上（那一步只改了它第 33 行那一句注释、行数没变），而 `sw.js` 的两处紧接着就失效了
（同一步往 `sw.js` 的注释里加了 5 行）——它们已经改成锚点定位、不再写死行号。行号在这种文件上是消耗品：
**能写锚点就别写行号**。**任务 12 又验证了一次这条规矩**：那一步把 `main.js` 第 33 行那句注释从 1 行补成
3 行（`setPreset / setMode` 的调用方接上了），于是 `let themeReady` 从第 35 行挪到第 37 行、那次
`await (themeReady ??= …)` 从第 44 行挪到第 46 行（实测：`sw.js` 的 `const CACHE` 也从第 76 行挪到第 77 行）
——下面第 1 / 3 / 4 条里写死的行号**当场全部失效**，已改成锚点描述；**核对时不要拿行号去对，拿锚点**。
（第 5 条那两处本来就是锚点定位，任务 12 之后仍对得上：`'./app/theme-store.js'` 之后紧跟 `'./app/theme.js'`。）

1. **`initTheme()` 先于 `render()` 自己的两次 `mount()`**：`render()` 里那行 `await (themeReady ??= …)`
   （锚点：`await (themeReady ??= initTheme().catch(`）在 `mount(view, …)`（视图渲染失败那条路）与
   `mount(app, view, renderTabBar(id))` 之前；各视图内部的 `mount(root, …)` 都由那行 `await fn(view)`
   间接调用，同样晚于它。
2. **`.catch` 兜底在**：`render()` 里那次主题初始化整个表达式就是
   `initTheme().catch(err => { console.error('主题初始化失败，用默认外观', err); })`——主题初始化失败
   既不会冒成未处理的拒绝，也不会挡住渲染。
3. **只初始化一次**：`themeReady` 在 `main.js` 的**代码**里只出现 **2 处**——`let themeReady = null;` 那行
   与上面那次 `await (themeReady ??= …)`（`??=` 同时是读与写，同一个变量名只写一次，所以那行只算一处）。
   **口径要说清**：`Select-String -Path app\main.js -Pattern themeReady`
   返回的是 **3 行**——注释里「themeReady 从此 settled…」那句也含这个词（**别拿行号
   去找它**，任务 11 与任务 12 都在附近加过话，行号就是这么飘的）。文本层的行数与
   代码层的处数不是一回事，`tests/boot-order.test.js` 那条断言数的是**剥掉注释之后**的代码行。
   `??=` 是「读-判断-写」的同步整体，并发的第二次 `render()` 只会复用同一个 promise，不会把 `initTheme()`
   跑两遍。
4. **没有 TDZ 陷阱**：`let themeReady = null;` 那行在 `render()` 之前，而 `render()` 的第一次调用来自文件
   末尾的 `onChange(render)`（`router.js` 的 `onChange` 会**同步**调一次 `handler(currentTab())`），
   所以那行 `await` 求值时声明早已初始化。反过来看更清楚：声明要是写在 `onChange(render)` 之后，
   冷启动第一帧会是 `ReferenceError`，而不是「主题先行」。
5. **`theme-store.js` 与 `theme.js` 都在 `sw.js` 的 `ASSETS` 里、且路径与磁盘一致**：清单里那两条是
   `'./app/theme-store.js'` 与**紧跟其后**的 `'./app/theme.js'`（ASC 里 `'-'`(0x2D) < `'.'`(0x2E)，
   所以 `theme-store` 在前），磁盘上两份都在。**这里刻意不写行号**：任务 11 往 `sw.js` 的注释里加了
   5 行，原先写死的「第 115 / 116 行」当场作废（实测现在是 122 / 123）——`sw.js` 是这条链上最爱被追加
   注释的文件。任务 14 步骤 2 那支存在性校验脚本当时跑出来是 `全部存在，共 58 个`；任务 11 往清单里
   加了 `appearance.css` 之后是 **59 个**（实测），**任务 12 又加了 `appearance-sheet.js`，所以那支脚本
   现在数是 60 个**（任务 14 完成时仍是 60——那一步只升版本号，不再加文件）。
6. **`CACHE` 只有一处常量声明**：任务 10 / 11 / 12 那几轮它是 `const CACHE = 'pvault-v17'`（全文件唯一
   一处 `const CACHE` 声明）；**任务 14 已按计划升到 `'pvault-v18'`**，行号也随之从 77 挪到 84。
   **同样不写死行号**——任务 10 时它在第 76 行、任务 11 与任务 12 各往上面的注释里加过话之后是第 77 行、
   任务 14 又往同一段注释里加了 7 行；`sw.js` 是这条链上最爱被追加注释的文件，写死一次就作废一次。
7. **首屏资源集合与 `ASSETS` 已经完全对齐**（本步实测）：从 `index.html` 里那 8 条 `./` 引用出发
   （`manifest.webmanifest`、`icons/icon.svg`、5 个 CSS、`app/main.js`），沿 `import` 走一遍闭包，
   得到首屏资源集合 **57 条**（其中 50 个 `.js`，含本步新引入的传递依赖 `main → theme-store → theme`）。
   `ASSETS` 是 **59 条**，两者差的正好是 `'./'` 与 `'./index.html'` 这两条**入口自身**——即清单里没有
   一条是首屏用不上的，反过来首屏也没有一条漏在外面（两个方向都实测过）。
   **任务 11 之后这三个数各 +1**：`index.html` 的 `./` 引用 9 条、首屏资源集合 58 条、`ASSETS` 60 条
   （那一步挂了 `appearance.css` 的 `<link>`，同时把它加进了清单）。**任务 12 之后只有资源集合再 +1**
   （58 → 59：那一步让 `settings-sheet.js` 静态 `import` 了 `appearance-sheet.js`），`ASSETS` 也 +1
   （60 → 61，加的是同一条）——所以「两个方向的差」仍然只有 `'./'` 与 `'./index.html'` 两条。**任务 14
   不再加文件**（`ASSETS` 已补齐，那一步只剩升版本号），届时以那一步的实测为准。

**这一节核不到什么**（与任务 9 那节同一个边界，如实写）：

- 「第一眼看到的就是已选皮肤」里的「第一眼」，静态核对一个字都证明不了。`render()` 里那行
  `await (themeReady ??= …)` 只保证「**内容被挂载之前**主题已应用」；在它之前浏览器可能已经画过一到几帧，
  那几帧的底色走 `styles/base.css` 的 `:root` 兜底（默认皮肤的浅 / 深），不是用户选的那套。**改前改后都是
  这样**——区别在于改前连「内容挂载时」都还是默认色。这条边界只能靠真机看（任务 15）。
- 「任何 mount 之前」这个全称**有一个反例**，先列出来再落笔：`main.js` 末尾那行裸调用
  `openFromShortcut()`（函数定义在同文件的 `function openFromShortcut() {`）——hash 带 `new=1` 时它直接调
  `openEntryPanel()`，这条路**不经过** `render()` 的那次 `await`；它自己先 `await` 一次 IndexedDB 读
  （`app/ui/entry-panel.js` 里那次 `Promise.all`）再挂载面板，与 `initTheme()` 是**并发**的，谁先完成没有
  保证。后果限于「主屏快捷方式冷启动时，面板的第一帧可能还是默认色」；这条**没有实测**（本机没有浏览器），
  本步也不改它（超出这一步的范围），如实记在这里，不算进「已保证」。（这三处的行号在任务 12 已全部飘掉，
  都改成锚点描述了。）
- 「主题在任何 mount 之前应用」这句话本身，本步能核的是上面第 1 条那个范围（`render()` 路径）；
  把它读成「app 里一切挂载都晚于主题」是**读过头**了，上面那条反例就是边界。

**`theme.js` 跟本步一起进清单（复审裁定，本步复核后同意）**

本步让 `main.js` 静态 import `theme-store.js`，而 `theme-store.js` 自己静态 import `theme.js`
（`app/theme-store.js` 第 15 行）——这是**间接依赖**。仓库对间接依赖的规矩是写死的：`sw.js` 的 v14 段
（`file-info.js` 走的正是 `main → invoice-view → invoice-editor → image-store → file-info` 这条链，
「必须在消费方 import 之前就位，不能等到收尾再补」）、v16 段（`canvas-image.js`，「所以不等任务 14」），
还有任务 5 那条：**白名单必须跟产生依赖的那次提交一起走**。两个文件都在首屏依赖链上，就一起进。
只加 `theme-store.js` 的代价是清楚的：断点并没有被消除，只是从 2 环缩到 1 环（`theme-store → theme`），
离线白屏照旧——而「装好这份缓存之后第一次打开即离线」对桌面图标启动的 PWA 是常见路径，不是窄窗口。

连带改动（都实测过）：本步步骤 4 的预期从 57 变成 **58**；任务 14 步骤 1 改成「只加剩下这两个文件」
（`app/ui/appearance-sheet.js`、`styles/appearance.css`），它代码块里 `theme.js` 那一行删掉；
任务 14 步骤 2 的预期 **60 不变**（58 + 2 = 60）。

**任务 11 又动了同一处（返工记录）**：那一步往 `index.html` 挂了 `appearance.css` 的 `<link>`，于是
`appearance.css` 提前到任务 11 进清单（**不升版本号**：v17 只在未发布的分支上，`addAll` 写的还不是一份
服役中的缓存），任务 14 只剩 `appearance-sheet.js` 一个文件——它那一步的预期仍是 **60 不变**
（59 + 1 = 60，进任务 11 之后是 59）。

**守卫（本步新增）：`tests/boot-order.test.js` + `scripts/check-theme-css.mjs` 的 ⑬**

**为什么非加不可（实测）**：加它之前把三个变异逐个做在仓库外的副本上——A 把那次 `await` 挪到
`mount(app, …)` 之后、B 删掉 `.catch`、C 把 `??=` 改成 `=`——**在那之前全量测试与静态核验都是全绿的**
（零告警）。原因是 `tests/` 里唯一碰 `main.js` 的是 `dev-server.test.js`（只断言 200 与 MIME），
而核验脚本当时不读 `ASSETS` / `CACHE`（它现在读了：⑬ 是后来补的）。首屏关键路径不能这么裸着走。

**守卫自己也要能被证伪（返工第二轮的教训）**：第一版守卫的抽取正则只认双引号，兜底又只有
「引用数 ≥ 5」，于是「一个模块都没抽到、断言照样全绿」——实测：把 `index.html` 的 `src` 改成单引号之后，
那一版抽到 7 条引用、其中 `.js` **0 条**，而全量测试 272 pass / 0 fail。现在每一处抽取都配了**失效断言**，
而且第 1 条就是专门守这件事的自检：它红了，下面几条的行号与闭包都不可信。

新文件做**不依赖 DOM 的文本级断言**（读文件、定位行、按结构断言），七条：

1. **守卫自身的前提**：剥注释不改变 `main.js` 的行数；`index.html` 的引用里必须抽到入口
   `./app/main.js`；首屏闭包里的 `.js` 数不得低于 45（实测基线 50，少 5 个就得来查）；
2. `initTheme()` 在**代码**里只出现一次，且必须写成 `await (themeReady ??= initTheme().catch(…))`
   （`??=` 与 `.catch` 少一个就红）；
3. 那次 `await` 的行号 < 第一处 `mount(` 的行号、也 < `mount(app,` 的行号（顺序反了就红）；
4. `themeReady` 只有「一次声明 + 一次使用」（多一处说明有人在渲染路径上又调了一次）；
5. `sw.js` 的 `ASSETS` 里有 `'./app/theme-store.js'` 与 `'./app/theme.js'`，`CACHE` 是单处 `const` 声明；
6. **首屏资源集合 ⊆ `ASSETS`**（`index.html` 的引用 + 入口的 `import` 闭包，逐个查清单）——
   这条正是本轮那个缺口的守卫：将来任务 11 / 12 往首屏链上挂新文件时，它也会先红一次；
7. `sw.js` 里带引号的相对路径集合 ⇄ `ASSETS` 清单集合（**双向**；与核验脚本的 ⑬ 同一条，两个入口）。

**边界（都写在文件注释里）**：只认静态 `from '…'` / `from "…"`，动态 `import('…')` 看不见——那是漏检，
不是误报；剥注释是字符串感知的（`'http://…'` 里的 `//` 不当注释，仓库里真有这种行），但不解析正则字面量
内部、也不展开模板串的 `${}`；第 7 条**故意不剥注释**——注释里举例写的带引号路径正是它要抓的东西。

**A/B/C 三个变异（首屏顺序那三个，返工第一轮）**——副本建在仓库外，跑完删掉，`runBASE` 是未变异的对照：

| 副本 | 变异 | 全量测试结果 |
|---|---|---|
| `runBASE` | 无（对照） | 272 pass / 0 fail |
| `runA` | 把那次 `await` 挪到 `mount(app, …)` 之后 | 271 pass / **1 fail**：「主题那次 await 在 render() 的两次 mount() 之前」 |
| `runB` | 删掉 `.catch` | 270 pass / **2 fail**：「main.js 里主题初始化只有一处…」+ 上面那条（锚点失效） |
| `runC` | `??=` 改成 `=` | 270 pass / **2 fail**：同上两条 |

**守卫自身的变异（返工第二轮，证的是「修好了」而不是「看起来绿」）**：

| 变异 | 结果 |
|---|---|
| `index.html` 的 `src` 改单引号 | 新守卫 **273 pass / 0 fail**（抽取认两种引号：探针 8 条引用、`.js` 1 条）；**旧守卫（HEAD 版）272 pass / 0 fail，而那正是静默失明**（探针：旧抽取 7 条、`.js` **0 条**） |
| `index.html` 的 `src` 改成**无引号**（抽取真失效） | **271 pass / 2 fail**——第 1 条自检与第 6 条闭包断言同时报 |
| `main.js` 的 `import` 改双引号 | 273 pass / 0 fail（新抽取认两种引号） |
| `ASSETS` 里一条少了 `./` 前缀（`'app/db.js'`） | 核验脚本 **exit=1**：「⑬ ASSETS 里这些条目没有对应的 ./ 同形写法」；**HEAD 版脚本 exit=0（绿）**——单向判据的盲区，已复现并修好 |
| `ASSETS` 里一条指向磁盘上不存在的路径（`'./app/nowhere.js'`） | ⑬ **绿**（它不管磁盘存在性，如实写清）；任务 14 那支存在性脚本报「缺失：app/nowhere.js」 |

核验脚本这一侧的 ⑬ 另有 **M18**（注释里塞一条清单外的带引号路径）与 **M19**（清单条目少 `./` 前缀）。
本行原来的「19/19」是任务 10 当时的快照，**在任务 11 就过期了**（那一步给 ⑭ 补了 M20–M23）。
任务 12 收尾与任务 13 返工的实测都是 **23/23 全被抓**；变异条数会随任务增长，
**别把它当基线**，以脚本当次打印的那两行为准。

- [ ] **步骤 4：`theme-store.js` 与 `theme.js` 进预缓存白名单（顺带把新的 `schema.js` 铺到设备上）**

**为什么必须跟这一步一起走**：本步让 `main.js` 静态 `import` 了 `theme-store.js`（步骤 1），而
`theme-store.js` 又静态 `import` 了 `theme.js`（`app/theme-store.js` 第 15 行）——两个都在首屏依赖链上，
与任务 5 让 `image-store.js` 依赖 `canvas-image.js` 是**同一条纪律**：白名单必须跟产生依赖的那次提交一起走，
不能等到任务 14 收尾再补。

**机制要说准（这条返工轮改过）**：漏掉一条**不是** `cache.addAll` 原子性的问题——原子性管的是「清单里
**某条**路径 404（拼错、文件改名），整批 reject、install 失败」；漏掉一条是清单里根本没写它，install
照常成功。它的后果出现在运行时：那个模块请求缓存未命中 → 走网络（在线就自愈，响应会被顺手补进缓存）
→ 离线则回退到 `index.html`，回给模块脚本的是一个 200 的 `text/html`，浏览器按严格 MIME 检查拒绝执行，
import 链一断，app 起不来（页面只剩 body 的底色）。**不是 404**——404 属于上面那条「清单里写错了路径」的路。
同一段机制写在 `sw.js` 开头（那里是唯一一处；v3 / v13 / v15 / v16 各段原来都写成「离线时 404」，
本轮一并改准）。

**顺带效果才是它非做不可的原因**：`CACHE` 一变，已装旧缓存的设备会重新 `install`（`addAll` 把清单重新抓一遍
全量）、`activate` 时删掉旧缓存，再加上 `skipWaiting` 与 `clients.claim`，设备下一次冷启动拿到的就是新缓存里的
`schema.js`——**任务 6 已把它升到 `DB_VERSION = 3`，不做这一步，那次数据库升级永远不会发生**：SW 是缓存优先，
设备一直命中缓存里的旧 `schema.js`（`DB_VERSION = 2`），`assets` 表建不出来，背景图一存就抛错。

改法：`CACHE` 从 `'pvault-v16'` 升到 `'pvault-v17'`；`ASSETS` 里加两条（保持书写风格，插在
`'./app/summary.js'` 与 `'./app/vault-model.js'` 之间；ASC 里 `'-'`(0x2D) < `'.'`(0x2E)，所以
`theme-store` 在 `theme` 前）：

```js
  './app/theme-store.js',
  './app/theme.js',
```

两个文件跑这一步时都**必须已在磁盘上**：`theme-store.js` 是任务 7 建的、`theme.js` 是任务 1-4 建的；
路径拼错就是上面那条「在线 404 → 整批 install 失败」的路。

**`CACHE` 保持 v17、不为这次返工再 +1**：`sw.js` 开头那条「每次改代码都要 +1」守的是「改了 CSS / JS
却没碰 `sw.js`、设备永远吃旧缓存」——返工改的正是 `sw.js` 本身（字节变了 → 触发 update → `addAll` 重抓
全量），而 v17 从未发布（它只存在于 `feat/appearance` 分支），不存在拿着 v17 缓存的设备。再 +1 会把
任务 14 已经写好的 `pvault-v18` 顶掉，那一整步的版本号、预期数字与 commit message 都得跟着改。

再跑一遍白名单全量校验（脚本在任务 14 步骤 2）：

预期：`全部存在，共 58 个`（任务 5 之后是 56 个；本步加的两条是 `app/theme-store.js` 与 `app/theme.js`。
56 + 2 = 58，再加任务 14 的 2 条，正好是那一步预期的 60 条。**本步实测就是 58 个**。）

**顺带记一个坑（上一轮实测踩到的，本轮把它堵住了）**：那支校验脚本按 `sw.js` 的**全文**匹配、不看上下文
——注释里带引号的路径照样命中。上一轮的 v17 注释里举了个例子、写了带引号的路径，那支脚本立刻把清单数
从 57 数成 58：路径全都 `Test-Path` 通过、只有数字悄悄多了 1。这类「校验全绿、数字自己变了」的形态比报错
难发现得多。本轮两处一起堵：① 把那支脚本**收紧到 `ASSETS` 数组切片内**（改法见任务 14 步骤 2）；
② `scripts/check-theme-css.mjs` 加断言 ⑬（`sw.js` 全文里带引号的相对路径去重后必须**等于** `ASSETS`
清单集合），并在 `tests/boot-order.test.js` 里也钉了同一条——两个入口都守。

**同一份提交里，`sw.js` 的注释改了三处**（注释诚实性；三处的理由各不相同）

1. **v17 段整段重写**。上一轮的 v17 段为了讲清「只加了一半」，写了一整段自我说明（缺口在哪个环节、
   什么时候咬人、什么时候自愈、要提前堵怎么改）。现在 `theme.js` 一起进来了，那一段**整段删掉**，
   换成本轮那四行：加了哪两个、它们都在 `main → theme-store → theme` 这条链上、与 v14（同样是间接依赖）
   同一个形状、剩下的 `ui/appearance-sheet.js` 与 `appearance.css` 归任务 14（**这一句后来又被任务 11 改准**：
   `appearance.css` 由那一步提前加，见上面那条连带改动）。
2. **「漏一条」的机制写准**（文件开头新增一段）。原文把两件事混着说成 404，见上面这一节第一段的机制说明；
   现在开头那段把两条路分开写——「清单里某条路径写错」= 在线 404 = `addAll` 整批 reject；
   「清单里漏一条」= 运行时缓存未命中 = 离线回退 `index.html`、被 MIME 检查拒绝。**这不是本轮新引入的
   错**：v3 / v13 / v15 / v16 段原来都写着「离线时 404」，本轮一并改成「加载不了」并指向开头那段。
3. **上一轮写下的那句「theme.js 已经建好（任务 1-4），但此刻没有任何模块 import 它——不请求就不会 404」
   整条删掉**：本步之后它是假话（`theme-store.js` 静态 import 了它，它从此会被请求）。

改注释与加清单条目同属 `sw.js` 那一个 commit。

- [ ] **步骤 5：Commit（本步五个：代码 / 测试 / 核验脚本 / 文档分开）**

```bash
git add app/main.js app/theme-store.js
git commit -m 'fix(theme): 注释改准——catch 的后果、全称的边界、首屏新增的依赖'
git add sw.js
git commit -m 'chore(sw): theme.js 一起进预缓存白名单，并把「漏一条」的机制写准'
git add tests/boot-order.test.js
git commit -m 'test(theme): 首屏启动顺序与预缓存清单的文本级守卫'
git add scripts/check-theme-css.mjs
git commit -m 'chore(scripts): 核验脚本加 ⑬ 与变异 M18'
git add docs/superpowers/plans/2026-09-26-pvault-custom-background.md docs/superpowers/specs/2026-09-26-pvault-custom-background-design.md
git commit -m 'docs(appearance): 同步任务 10 返工（theme.js 入清单、机制更正、§11 判据）'
```

**前两个 commit 分开**：白名单要跟产生依赖的那次提交一起走，与任务 5 的两个 commit 是同一个道理。
**后三个也各占一个**：守卫测试、核验脚本、文档是三摊东西，混在一起以后没人能单独回滚其中一摊。

---

## 任务 11：「外观与背景」面板

**文件：**
- 创建：`app/ui/appearance-sheet.js`
- 创建：`styles/appearance.css`
- 修改：`index.html`
- 修改：`app/theme-store.js`（**返工那轮**：为面板顶部的缩略图导出 `currentPhotoUrl()`——`photoUrl` 本来就是它的状态，让它多一个只读出口，比让面板自己 `createObjectURL` 再加一份 revoke 责任更安全）
- 修改：`scripts/check-theme-css.mjs`（**返工那轮**：加 ⑭「`el(...)` 的类名必须有 CSS 规则」与变异 M20）

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
  currentTheme, currentPhotoUrl, setPreset, setMode, setPhoto, removePhoto, setOverlay
} from '../theme-store.js';

const MODE_OPTIONS = [
  { id: 'auto', label: '跟随系统' },
  { id: 'light', label: '浅色' },
  { id: 'dark', label: '深色' }
];

// 拖动遮罩时两次写库之间的最小间隔（毫秒）。理由写在 queueOverlay 那一段。
const OVERLAY_WRITE_MS = 100;

// 皮肤卡上的小色块：底色用该皮肤的 --bg、描边用它的 --border、中间的圆点用 --accent
// ——三处都取**浅色档**那一组（THEME_TOKENS[id].light），与当前深浅档无关。
// 这是刻意的，不是漏考虑深浅：五张卡要横向比「哪套是什么样」，取同一档才比得出来；而深色档那五组
// --bg（#131315 / #1c1712 / #141a14 / #17131f / #0e1a1d）彼此几乎一样，跟着深浅档走反而让这块预览
// 失去分辨力。代价如实说：深色用户看到的预览是浅色档的样子，不是他当前屏幕的样子。
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

  // ── 写库失败与重绘 ──────────────────────────────────────────
  // 这个面板碰到的每一次写库都是「操作已经发生、只是没记住」，而 setPreset / setMode / setPhoto /
  // removePhoto / setOverlay 的 JSDoc 都把 rejection 交给了调用方（也就是这里）。不接住的后果本仓库
  // 判过：未捕获的 rejection 在页面上就是「点了没反应」。这里给一句能照着做的话，再把原始错误接上，
  // 与发票图片那条路同一条口径。**但这句口径里只有前半是硬承诺**：err.message 通常是可读的中文
  //（db.js 的 onblocked 就写好了「请关掉其它 pvault 页面后重试」），实测也有英文的
  //（比如 `Image is not defined`）——那句话别读成「永远是中文」。
  // tail 由调用方给，而且**它必须在这个操作的所有失败点上都为真**：「界面已经变了」这种话只在
  // 「先画后写库」那条路上成立，对「先删库、成功后改内存」以及有两个失败点的 setOverlay 就是假话
  // （这两种各自都判过一次，见下面两处注释）。
  function reportWriteFailure(title, err, tail) {
    console.error(title, err);
    alert(`${title}：${err?.message || err}\n${tail}`);
  }

  // 重绘这一层自己也会抛（构造节点、挂载失败），而它挂在 finally 里——抛出去就是一个**没人接**的
  // rejection（这次点击的业务结果其实已经定了，提示也弹过了）。所以重绘单独兜住，只记一条日志。
  async function safeRerender() {
    try {
      // 先把滑块待写的值交出去：不先交，面板会画回一个旧值（原因见 flushOverlay）。
      await flushOverlay();
      await rerender();
    } catch (err) {
      console.error('外观面板重绘失败', err);
    }
  }

  // 点皮肤 / 点深浅：这两个函数是「先画后写库」（见 theme-store.js），而它们**只有一个 await**（写设置），
  // 并且排在 paint() 之后——所以写库失败时内存与 DOM 一定已经改了，「界面已经按你点的换了」这句话
  // 在这里是真的。（别把它照抄到失败点更多的路上去。）写库失败只影响「下次启动记不记得住」。
  async function applyThemeChange(fn, title) {
    try {
      await fn();
    } catch (err) {
      reportWriteFailure(title, err, '界面已经按你点的换了，但下次打开可能会变回去。');
    } finally {
      // 失败也要重绘：内存里的状态已经变了，不重绘就会留下「按钮高亮与页面颜色对不上」。
      // 成功那条路同样要重绘，否则高亮根本不会跟着走。
      await safeRerender();
    }
  }

  // 移除背景：removePhoto 是「先删库、成功之后再改内存与 DOM」，所以失败时界面**可能**一点没变
  //（第一步就失败），也可能删了图却没清设置（第二步失败）——对它不能说「界面已经变了」。
  async function removeBackground() {
    try {
      await removePhoto();
    } catch (err) {
      reportWriteFailure('移除背景没能完成', err,
        '照片可能还在，也可能只剩一半——重开一次 app 看看现在是什么样子。');
    } finally {
      await safeRerender();
    }
  }

  // ── 遮罩滑块的写库节流 ──────────────────────────────────────
  // 每次 setOverlay 要做一次 getSetting + 一次 setSetting（两次 IndexedDB 事务），而 range 的 input
  // 在拖动时按帧触发（触摸屏上一秒几十次）。所以这里做**节流**而不是防抖：
  //   · 画面必须跟手——防抖（等停手再写）会让遮罩在松手之前一动不动，而「所见即所得」正是这个面板
  //     的全部卖点；节流让第一次拖动立刻生效，之后的更新最多滞后 OVERLAY_WRITE_MS。
  //   · **尾部那次补写是必需的**：只做「首帧 + 间隔」会在用户停手时丢掉最后一个值，留下
  //     「面板显示 50%、库里还是 40%」——重启后遮罩自己跳回去。
  //   · **串行（overlayChain）同样是必需的**：两次 setOverlay 并发跑，各自 getSetting 读到旧记录、
  //     各自写回，后完成的那次可能盖掉更新的值，库里最终留哪个值取决于时序。
  // 已知代价：画面上遮罩的实际变化最多每 OVERLAY_WRITE_MS 更新一次，拖动时的平滑度取决于这个值。
  // 本机没有浏览器，这个数只能靠任务 15 的真机验收（清单里有一条：拖动跟手、松手后重启仍是那个值）。
  let overlaySent = null;      // 已经交给写库链路的值（失败时会被回滚，见 writeOverlay）
  let overlayQueued = null;    // 最近一次要写的值（可能还没落库）
  let overlayTimer = null;
  let overlayChain = Promise.resolve();
  let overlayAlerted = false;  // 见 writeOverlay：拖动时的失败只提示一次

  function writeOverlay(value) {
    overlaySent = value;
    overlayChain = overlayChain.then(() => setOverlay(value)).catch(err => {
      // **失败要把它回滚**（只回滚自己那一次，别把后来者的标记抹掉）：不回滚的话，下一次补写会被
      // `overlayQueued !== overlaySent` 判成「这个值已经写过了」而跳过——于是首帧失败一次之后，
      // 就算写库恢复了也永远补不上：库停在旧值、画面上是新值，重启后跳回去。
      //（实测过这条：首帧写失败、50ms 后恢复 → 尾部补写被跳过、put 次数 0、库里还是 30。）
      if (overlaySent === value) overlaySent = null;
      console.error('背景遮罩没能记住', err);
      // 这条尾句**不能照抄上面那两条**：`setOverlay` 的失败点有两个，而它们之间隔着「改内存 / 写 DOM」——
      //   · `await getSetting(...)` 失败：内存与 DOM 都还没改，**画面上一点变化都没有**；
      //   · `await setSetting(...)` 失败：内存与 DOM 已经改了，画面是新值、库里是旧值。
      // 所以说「画面上已经变了」在第一种情况下就是假话。这个坑在皮肤 / 深浅那条路上判过一次
      //（那两条只有一个 await、且排在 paint() 之后），滑块这里是同一件事，别只修一处。
      // 下面这句在两种失败下都为真：来自 getSetting 时 setSetting 根本没跑，来自 setSetting 时写库
      // 没成功——两种情况下库里留着的都是旧值，所以「没记住」与「重开后会退回旧值」都成立。
      // 另外**只提示一次**：拖动时每次失败都 alert 会连弹，而 alert 会阻塞主线程——正在拖的那只手
      // 会被卡住，一个提示反而把「跟手」这件事搞坏。
      if (overlayAlerted) return;
      overlayAlerted = true;
      alert(`遮罩没能存进手机：${err?.message || err}\n这个值没有记住——重开一次 app 会退回上一次存下的那个。`);
    });
  }

  // 把待写的值立刻交出去（不再等 OVERLAY_WRITE_MS），并返回整条写库链。
  // 拖动途中去点皮肤时，rerender 会拿 currentTheme().overlay 重建滑块：不先把 pending 值交出去，
  // 面板会画回「上一次已经写过的那个值」，而库里与画面上都是新值——三处两个真相
  //（实测：面板 35%、库 55、DOM 0.55）。
  function flushOverlay() {
    if (overlayTimer) { clearTimeout(overlayTimer); overlayTimer = null; }
    if (overlayQueued !== null && overlayQueued !== overlaySent) writeOverlay(overlayQueued);
    return overlayChain;
  }

  function queueOverlay(value) {
    overlayQueued = value;
    if (overlayTimer) return;                  // 间隔内：交给下面那次补写
    writeOverlay(value);                       // 首帧立刻应用，遮罩跟着手指走
    overlayTimer = setTimeout(() => {
      overlayTimer = null;
      if (overlayQueued !== overlaySent) writeOverlay(overlayQueued);
    }, OVERLAY_WRITE_MS);
  }

  // 规格 §8 第 4 条：面板顶部一行小字说明当前皮肤名——一列色块看不出「我现在是哪套」。
  function renderCurrent(state) {
    const name = THEMES.find(t => t.id === state.preset)?.name ?? state.preset;
    return el('div', { class: 'hint-text', text: '当前皮肤：' + name });
  }

  function renderPresets(state) {
    return el('div', { class: 'field' }, [
      el('label', { text: '配色' }),
      el('div', { class: 'theme-row' }, THEMES.map(t => {
        const selected = t.id === state.preset;
        return el('button', {
          class: selected ? 'theme-card on' : 'theme-card',
          type: 'button',
          dataset: { theme: t.id },
          'aria-pressed': String(selected),
          onclick: () => applyThemeChange(() => setPreset(t.id), '皮肤没能存进手机')
        }, [themeChip(t.id), el('span', { class: 'theme-name', text: t.name })]);
      }))
    ]);
  }

  function renderModes(state) {
    return el('div', { class: 'field' }, [
      el('label', { text: '深浅' }),
      el('div', { class: 'seg-row' }, MODE_OPTIONS.map(m => {
        const selected = m.id === state.modeChoice;
        return el('button', {
          class: selected ? 'seg on' : 'seg',
          type: 'button',
          dataset: { mode: m.id },
          'aria-pressed': String(selected),
          text: m.label,
          onclick: () => applyThemeChange(() => setMode(m.id), '深浅没能存进手机')
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
          // 与发票图片那条路一致：给一句能照着做的话，再把原始错误接上。
          // 尾句取中性说法：setPhoto 有四个失败点（编码 → 写 assets → 写设置 → 应用），其中「图和设置
          // 都已经写进去了、只是这一次没画出来」那一种会让重启后背景反而出现——所以不能替它下结论。
          alert('这张照片没能设成背景：' + (err?.message || err) + '\n重开一次 app 看看背景有没有出现。');
        } finally {
          // picking 先复位、再重绘：重绘失败（safeRerender 兜住）也不该把 picking 卡在 true 上，
          // 否则用户此后每次选图都被 `if (!file || picking) return` 挡掉。
          picking = false;
          await safeRerender();
        }
      }
    });

    const pick = el('button', {
      class: 'btn', type: 'button', dataset: { action: 'pick-photo' },
      text: state.photo ? '换一张' : '选择图片',
      onclick: () => fileInput.click()
    });

    if (!state.photo) {
      return el('div', { class: 'field' }, [
        el('label', { text: '背景照片' }),
        el('div', { class: 'photo-row' }, [pick, fileInput]),
        // 只说这一版真做得到的事：照片缩到最长边**最大** 1600 后存在这台手机上（`image-scale.js` 对
        // 最长边已经 ≤1600 的图**不放大**，所以写「压到 1600」是错的——一张 800px 的图进去还是 800px）。
        // **不写「跟着备份一起走」**：导出包现在还不带背景（`buildBackup` 的 data 里没有它，那是任务 13
        // 的事），面板不该向用户承诺一件这个版本做不到的事。
        el('div', { class: 'hint-text', text: '选一张照片铺在卡片下面。照片的最长边最多留 1600 像素，然后存在这台手机上。' })
      ]);
    }

    const slider = el('input', {
      type: 'range', class: 'ov-range',
      min: String(OVERLAY_MIN), max: String(OVERLAY_MAX), step: '5',
      'aria-label': '背景遮罩强度',
      oninput: e => {
        // 数字每帧跟手（它就在滑块旁边，滞后一眼就看得出来）；写库走上面的节流。
        valueLabel.textContent = e.target.value + '%';
        queueOverlay(e.target.value);
      }
    });
    // range 的初值用 property 设而不是属性：setAttribute('value') 在部分内核上
    // 只改默认值、不改当前值，滑块会停在最左端。
    slider.value = String(state.overlay);
    const valueLabel = el('span', { class: 'ov-value', text: state.overlay + '%' });

    // 缩略图用 theme-store 正在给背景层用的那个 blob URL（规格 §8 第 3 条）。
    // 为什么复用它、而不是面板自己 createObjectURL 一份：renderPhoto **每次重绘都会跑一遍**（每点一次
    // 皮肤 / 深浅都会重绘），自建就得在每次重绘前先 revoke 上一个，漏一次就多一个 URL 条目；共享这一份
    // 的 revoke 责任只有一处，由 theme-store 的 setPhotoVars 在换图 / 移除时统一释放。
    // **注意**：「不要 revoke 它」只是注释约定，没有机制拦着——面板若去 revoke，背景层会当场没掉。
    const thumbUrl = currentPhotoUrl();

    // 一条已知的降级，本面板**不**替它兜底，这里只把这层写清：若 settings 里那条 backgroundImage
    // 被外部清掉、而内存里的 applied.photo 还是 true（判据与来源见 theme-store.js 的 setOverlay），
    // 拖这个滑块只会改画面、不会重建设置——重启后照片按「没有背景」处理，用户的观感是「我调了遮罩、
    // 照片却没了」。面板看不出这件事：currentTheme() 只给 photo: true / false，没有「设置还在不在」
    // 这一层，要在这里提示就得给 theme-store 加一条新通道；而自愈的正确位置也**不在面板**——能判断
    // 「设置丢了」的只有 theme-store 自己。所以本步保持原行为（任务 8 那段注释已经把这个选择写死），
    // 只留下这段说明。
    return el('div', { class: 'field' }, [
      el('label', { text: '背景照片' }),
      el('div', { class: 'photo-row' }, [
        thumbUrl ? el('img', { class: 'photo-thumb', src: thumbUrl, alt: '当前背景照片' }) : null,
        pick, fileInput,
        el('button', {
          class: 'btn btn-danger', type: 'button', dataset: { action: 'remove-photo' },
          text: '移除',
          onclick: () => removeBackground()
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
    mount(container, [renderCurrent(state), renderPresets(state), renderModes(state), renderPhoto(state)]);
  }

  safeRerender();
  return sheet;
}
```

**任务 13 之后这个文件的现状**：上面那份是**任务 11 的 HEAD**（计划里的代码块镜的是各任务自己的 HEAD，不是最终 HEAD）。
其中 `if (!state.photo)` 分支里那段注释与那句 `hint-text` 都在任务 13 里改过——**「不写「跟着备份一起走」」这条判断
的前提（导出包还不带背景）随任务 13 消失**，面板上那句承诺已经加回来了（并注明了它的边界：`encodeBackground`
失败的那一次导出不带背景，而那条降级是静默的）。现状见 `app/ui/appearance-sheet.js` 与任务 13 开头那条第 4 点。

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
  font: inherit;
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
  font: inherit;
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

/* 当前背景的缩略图。定宽定高 + object-fit：竖拍 / 横拍的照片都不能把这一行撑变形。 */
.photo-thumb {
  width: 44px;
  height: 44px;
  flex: none;
  object-fit: cover;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}

/* 真正的 file input 藏起来：它的原生外观在五套皮肤下都没法看，
   而它必须留在 DOM 里（用按钮的 click() 触发）。
   与 vault.css 里那条 .vault-file-input 同义（都是一行 display: none），**不合并**：
   那条的名字与注释都写在「备份与恢复」那一段里、属于 backup-view.js，合并要在两个既有文件之间
   搬命名；而 display: none 不随皮肤变，不存在「同一视觉两份真相会漂移」的问题。 */
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

- [ ] **步骤 4：手动验证（本机做不了，落点在任务 15）**

起本地服务，打开设置 → 外观与背景（**本步做的时候入口还没接上，那一行由任务 12 加**；当时的替代办法是
在 Console 里调 `import('./app/ui/appearance-sheet.js').then(m => m.openAppearanceSheet())`）。

预期：面板打开，**顶部一行小字写着当前皮肤名**；五张皮肤卡显示各自的底色与强调色圆点；点一张，整个界面立刻换色；深浅三个按钮可切换；没有照片时只有「选择图片」按钮；**设过照片后**出现当前背景的缩略图、「换一张」（普通 `btn`）与「移除」（`btn-danger`，看得出是破坏性操作）+ 遮罩滑块与右侧百分比。

**本机没有可用浏览器，这一步实际做不了**（`puppeteer-core` 未安装、系统 Edge 的 `--headless` 输出为空），所以本步只做静态核对（`node --check`、真 `import` 模块、逐行核对事件绑定与错误路径），把「渲染与交互」明确挂到任务 15。**那一条落点已经核实存在**（不是一句「挪到任务 15」了事）：面板的视觉与本步新增的三件事都有对应条目——
皮肤卡预览色块、面板里只有「选择图片」、照片设好后的三个控件 → 「皮肤与深浅」与「背景照片」两节里本步追加的三条；
未处理的拒绝 → 同节的 Console 条目；滑块节流的两半（跟手 + 尾部补写）→ 「背景照片」里那条「拖动跟手、松手后重启仍是那个值」。

- [ ] **步骤 5：Commit**

**首交付（第一次收尾）分了四个**：

```bash
git add app/ui/appearance-sheet.js styles/appearance.css index.html
git commit -m 'feat(appearance): 外观与背景面板'
git add app/theme-store.js app/main.js
git commit -m 'fix(theme): 注释改准——面板接上后「停在默认外观」的前提'
git add sw.js
git commit -m 'chore(sw): appearance.css 提前进预缓存白名单'
git add docs/superpowers/plans/2026-09-26-pvault-custom-background.md
git commit -m 'docs(appearance): 同步任务 11（面板代码、白名单归属、任务 15 落点）'
```

**返工（两份复审之后）另开四个，不改写历史**：

```bash
git add app/ui/appearance-sheet.js styles/appearance.css app/theme-store.js
git commit -m 'fix(appearance): 面板返工——用户可见文案、类名、三个真 bug、规格 §8 两项'
git add scripts/check-theme-css.mjs
git commit -m 'chore(scripts): 核验脚本加 ⑭ 类名守卫与变异 M20'
git add docs/superpowers/specs/2026-09-26-pvault-custom-background-design.md
git commit -m 'docs(spec): 规格回扫——CACHE 版本号去写死、白名单归属改准'
git add docs/superpowers/plans/2026-09-26-pvault-custom-background.md
git commit -m 'docs(appearance): 同步任务 11 返工（镜像、行号锚点化、落点与口径更正）'
```

**第二个 commit 是注释诚实性，理由不是「面板接上了」**：被删掉的原文写的是「这个结论**在任务 11 之后会变窄**：面板接上…之后 `setPreset` / `setMode` 会被用户点到」——那是一句**预言**，而任务 11 做完之后它**没有变窄**（这一步只建了面板文件，入口在任务 12，用户根本点不到它），预言落空，所以它在 HEAD 上就是假的。两句改成本步的措辞时**也没有跟着任务号走**——写成「面板文件由任务 11 建好、设置入口任务 12 接」，这样在任务 12 接上之后读仍然是准的。（**本步确实没接上入口**：`from './appearance-sheet` 在 `app/` 里实测 0 命中。）

**第三个 commit 不能挪到任务 14**：本步让 `index.html` 挂上 `styles/appearance.css` 的 `<link>`，它从此是首屏静态依赖；SW 是 cache-first，白名单里没有它，已装旧缓存的设备离线启动就会走到「缓存未命中 → 回退 `index.html` → 模块/样式表被 MIME 检查拒绝」那条路（机制写在 `sw.js` 开头那段），**白名单必须跟产生依赖的那次提交一起走**（v14 / v16 / v17 三次都是这么做的）。
**`ui/appearance-sheet.js` 这一步不进清单**：本步只是把它建出来，还没有任何模块 import 它（**入口那时还没接**，任务 12 才把 `settings-sheet.js` 的 import 接上），它此刻不在首屏依赖链上；它必须在任务 12 那一次提交里进来——**任务 12 实测正是这么做的**（`ASSETS` 加了一条、`CACHE` 按边界判没升），且那一步的收尾里记着 `tests/boot-order.test.js` 第 6 条先红过一次（那正是它被设计出来要挡的事）。
**`CACHE` 这一步不升版本**：v17 只存在于还没发布的分支上、没有任何设备装着它，所以按 `sw.js` 开头那条例外的边界（「已经在设备上服役过的版本，改 `ASSETS` 就得 +1」）还不到该 +1 的时候——`addAll` 写的还不是一份服役中的缓存。
**两个守卫的分工本步也实测过**：把 `appearance.css` 那一行从清单里删掉之后，`tests/boot-order.test.js` 立刻报「这些首屏资源不在 ASSETS 里：./styles/appearance.css」（exit=1），而 `scripts/check-theme-css.mjs` 仍是全绿（当时 64 项，⑬ 报「`ASSETS` 60 条 / 带引号路径 60 个」）——⑬ 抓不住「清单里少一条」，这条边界脚本自己的注释里写明了，所以两个入口都得留。（**这几个数字是任务 11 当时的快照，别当基线**：断言条数每个任务都在涨〔任务 12 收尾是 69 项、⑬ 报 61 条 / 61 个〕，要以脚本当次打印的那张分组计数表为准；另外 ⑬ 报的是**去重后的字符串集合**，与「数组内条目数」在有无重复项时并不相等，三个数的口径在任务 12 那节写清了。）

**返工记录（两份复审 + 一次自查；三条真 bug 都做了对照变异）**

1. **用户可见的假话（最严重的一条）**：面板原来对用户说照片「并跟着备份一起走」——而这一版
   `buildBackup` 的 `data` 键里根本没有背景（那正是任务 13；规格 §4.3 / §7 也把它列在任务 13）。
   改成「会压到长边 1600 像素后存在这台手机上」，不再承诺任何与备份有关的事。**面板上其余文案逐句核过**
   （按钮、字段标签、四条 alert、两条说明）：都是当下为真的话。
   **⚠ 任务 13 把这一条的结论推翻了，读到别照它改回去**（这是历史记载，不是现行纪律）：任务 13 让
   备份真的带上了背景，于是「不再承诺任何与备份有关的事」这个结论随之过期——面板文案现在是
   「……然后存在这台手机上，导出备份时会一起带走」，并注明了边界（读图失败的那一次导出不带背景，
   而备份面板会当场告知）。**「面板不该承诺备份」的前提是「备份不带背景」，那个前提已经不存在了。**
   现状见任务 13 开头第 4 点。
2. **两个类名全仓零定义**（`field-label` / `btn-ghost`）：实测 `styles/*.css` 里一条规则都没有。后果不只是
   「标签没有层级」——破坏性的「移除」与「换一张」长得一模一样，而仓库本来就有 `.field` + `<label>`
  （`ledger.css`，账户 / 分类 / 预算 / 备份四个面板都在用）与 `.btn-danger`（仓库全部 6 处删除类操作都用它）。
   改成这两套既有写法，**不在 `appearance.css` 里另立一份同名样式**：那会造出「同一视觉的第二份真相」，
   而类名漂移没有任何守卫看得见。**这一条现在有守卫了**——见 `scripts/check-theme-css.mjs` 的 ⑭。
3. **注释过度断言**：`themeChip` 原来写「这两个颜色就是用户切换时最先感受到的差异」，而它取的是**浅色档**
   那一组——深色用户看到的预览并不是他屏幕上的样子（`borderColor` 也一样取自浅色档）。核实后判定
   「取浅色档是刻意的」，并把这个代价写进注释：深色档那五组 `--bg`（`#131315` / `#1c1712` / `#141a14` /
   `#17131f` / `#0e1a1d`）彼此几乎一样，跟着深浅档走反而让这块预览失去分辨力。
4. **三条真 bug**（用假 IndexedDB + DOM stub 把节流那条路跑通，并各做了一个对照变异）：
   · **首帧写失败后尾部补写被跳过**：`overlaySent` 失败时不回滚，于是 `overlayQueued !== overlaySent`
     被读成「这个值写过了」。实测：首帧失败、50ms 后写库恢复 → put 次数 0、库里仍是 30，而画面上
     `--scrim-a` 已是 0.5。修法：失败时回滚 `overlaySent`（只回滚自己那一次，别抹掉后来者的标记）。
   · **拖动途中点皮肤 → 面板显示回退**：`rerender` 重建滑块时拿的是内存里的旧值，而 pending 值还没交出去。
     实测：面板 35%、库 55、DOM 0.55——三处两个真相。修法：重绘前先 `flushOverlay()`（把 pending 值立刻
     交出去，并等它落地再重绘）。
   · **`finally` 里重绘抛错会逃逸**：`catch` 只保护被点的那个函数，重绘抛在 `finally` 里没人接——实测得到
     一个未处理的拒绝（正是这个面板要消灭的那种「点了没反应」的另一面）。修法：重绘走 `safeRerender()`
     （自带 catch + 一条日志）；`picking` 仍在 `await` 之前复位，不会被重绘失败卡住。
5. **规格 §8 的两条声明补实现**（原来只是「计划里没记、实现里没有」）：已选图时显示**当前背景的缩略图**
   （用 `theme-store` 新导出的 `currentPhotoUrl()`——面板**不 revoke** 它：它是背景层正在用的那个 URL，
   而且 `renderPhoto` 每次重绘都跑、自建 URL 就得每次重绘前 revoke 上一个，漏一次多一个条目），
   以及面板**顶部一行小字**写明当前皮肤名。两条都补进了任务 15 的真机清单。

**第二次返工（质量复审通过之后的一轮打磨，四条）**

1. **滑块那条 alert 的尾句是假话**：原来写「画面上已经变了，但下次打开可能会变回去」——而 `setOverlay`
   的失败点有两个、中间隔着「改内存 / 写 DOM」：`await getSetting(...)` 失败时内存与 DOM **都还没改**，
   画面上一点变化都没有（这个判断在皮肤 / 深浅那条路上做过一次，滑块这里是同一件事，别只修一处）。
   改成在两种失败下都为真的说法：「这个值没有记住——重开一次 app 会退回上一次存下的那个」（来自
   getSetting 时 setSetting 根本没跑，来自 setSetting 时写库没成功，两种情况下库里留的都是旧值）。
   **同一轮把其余四条 alert 逐条按「哪一步会失败」重核了一遍**：皮肤 / 深浅那条只有一个 `await` 且排在
   `paint()` 之后（「界面已经按你点的换了」是真的）；移除背景那条本来就覆盖了两种；设照片那条有四个
   失败点（编码 → 写 assets → 写设置 → 应用），补了一句中性的「重开一次 app 看看背景有没有出现」——
   因为「图和设置都写进去了、只是这一次没画出来」那一种会让重启后背景反而出现。
2. **⑭ 的三处覆盖缺口补上**：① 白名单条目必须是活的（没人用了就该删——实测过：删掉用法之后它变成一张
   免检牌，而 ⑭ 照旧全绿）；② 白名单免检的**理由**所依赖的规则必须还在（实测过：把 `.stats-month button`
   改名之后白名单仍绿）；③ 抽取扩到 `className = '…'` 与 `classList.add/remove/toggle('…')`（仓库里实测
   22 处、11 个类名，此前完全不受检查）。为此给核验脚本加了 `--app-file` 参数（⑭ 扫的是整个 `app/`
   目录，它的变异必须能覆盖到目录里的某一个文件），并让 self-test 的 fakeRoot 支持指定改哪个文件
   （`styles/` 里某条规则被删改走不了 `--css` 的覆盖）。**新增变异 M21 / M22 / M23 各抓住一条**；
   M22 第一版没抓住，原因是白名单理由的正则太松被 `.stats-month button:disabled` 骗过去了——收紧要
   「button 后面直接跟 `{`」之后才红（这条教训写在 `CLASS_WHITELIST` 的注释里）。
3. **⑭ 的边界声明与实测对齐**：拼接类名**是误报、不是漏检**（实测 `class: 'zz-concat-' + x` → 报
   「zz-concat- 没有规则」而红）；`dataset: { class: 'x' }` 会被当成 CSS 类名而**假红**（构造出来实测过，
   现在抽取前先挖掉；仓库里这种写法 0 处）；模板串里的 `${}` 与变量抽不到（模板串在仓库里实测 0 处）；
   `setAttribute('class', …)` 也不抽（仓库里实测 0 处）；下限只挡「整体塌掉」——把 3 处 `class:`
   写成 `class :` 实测 174→171，仍然绿。
4. **两处措辞**：缩略图「为什么不自建 URL」的理由链收窄——「误 revoke 会让背景层消失」只适用于
   「面板去 revoke 那个共享 URL」这种写法，真正否定自建方案的是「每次重绘都要 revoke 上一个、漏一次
   多一个 URL 条目」；并补一句「『不要 revoke』只有注释约束、没有机制」。照片说明里的「压到长边 1600
   像素」改成「最长边**最多** 1600 像素」（`image-scale.js` 对最长边已经 ≤1600 的图**不放大**，实测那句
   `if (longest <= edge) return { … scale: 1 }`）。

---

## 任务 12：设置入口

**文件：**
- 修改：`app/ui/settings-sheet.js`
- 修改：`sw.js`（连带改动 1）
- 修改：`app/theme-store.js` 与 `app/main.js`（连带改动 2 的注释；两处同型句）

- [ ] **步骤 1：加 import 与入口**

import 与 `SETTINGS_ENTRIES` 都按下面两段改（**实现后的镜像**：两段代码块与仓库里的 `app/ui/settings-sheet.js`
逐字符一致，读者照抄即可）：

import 区加（排在 `import { openImportSheet } from './import-view.js';` 之后）：

```js
import { openAppearanceSheet } from './appearance-sheet.js';
```

`SETTINGS_ENTRIES` 里，在 `budget` 那一项之后、`backup` 之前插入：

```js
  // 外观排在记账配置之后、数据进出之前：它既不是每天要改的记账配置，
  // 也不是「把数据搬进搬出」那种一次性动作，但它是用户会想反复调的那一类。
  // 它是这里**唯一**不收 { onChanged } 的入口（openAppearanceSheet 声明的是无参）——不影响 swapTo：
  // 多传一个对象 JS 本来就允许，函数忽略它即可；而它也确实不需要父面板刷新（改的是 CSS 变量，
  // 不是设置面板的内容）。
  { id: 'appearance', label: '外观与背景', open: openAppearanceSheet },
```

**同一次改动还顺手改准了三句旁边的话（老实交代：`open` 签名那句是任务 11 建的，另两句是原有的）**：
① 入口上方那两条注释原文写着「`open` 的签名与其它三个一致（都收 `{ onChanged }`）」，本步插进来的这一项
是**无参**的，那句就此变假，已改成「与账户/分类/预算三个一致」并补上面那两条注释说明它为什么可以是例外
（调用形态与「不需要父面板刷新」的理由）；② `backup` 上面那句里的「其它三个」跟着收窄；
③ 账单导入那条注释原文写「上面四行都是每天要用的」，插入后上面变成**五行**（且第五行不是「每天要用的记账
配置」），已改成「上面五行都是每天要用的记账配置、外观与数据保险」。

注意 `open` 的签名不必与其它入口一致——`swapTo` 会传 `{ onChanged }` 进去，`openAppearanceSheet` 忽略它没
问题，也不会因此报错（它声明的是无参，多传一个对象 JS 本来就允许）；主题变化**不需要**父面板刷新。

- [ ] **步骤 2：手动验证（本机做不了，静态核对见下，肉眼确认落点在任务 15）**

起本地服务 → 首页右下角齿轮 → 设置面板。

预期：列表里出现「外观与背景 ›」，位置在「预算设置」和「备份与恢复」之间；点它，设置面板先关闭、约 200ms 后外观面板滑出（**不能两层同时挂着**——这是 `swapTo` 机制的既有约定）。

**本机没有可用浏览器**（`puppeteer-core` 未装、系统 Edge 的 headless 被沙箱挡住），这一步的「点开看一眼」
做不了。按任务 9–11 的同一思路改成**静态核对**，核了四件事（都可复现，命令以仓库根为工作目录）：

| 核什么 | 怎么核 | 实测结果 |
|---|---|---|
| 位置在 `budget` 之后、`backup` 之前 | 读 `SETTINGS_ENTRIES` 数组顺序 | `accounts / categories / budget / appearance / backup / import`——符合 |
| `open` 指向 `openAppearanceSheet` | 该条目的 `open` 标识符 | 是 `openAppearanceSheet`，与 import 进来的那个同名 |
| `import` 真的建立了首屏依赖 | 从 `index.html` 出发走静态 `from '…'` 闭包（`tests/boot-order.test.js` 的 `firstPaintRefs` 就是这套逻辑） | 闭包里出现 `./app/ui/appearance-sheet.js`（这条依赖是**诱导出来的**：把 `ASSETS` 那一行删掉，boot-order 第 6 条立刻报「这些首屏资源不在 ASSETS 里」） |
| `swapTo` 的调用形态 | 读 `settings-sheet.js` 里 `entry.open({ onChanged: notify })` 那行 | 与本步无关、一行未改；多传的对象被无参函数忽略 |

**「肉眼确认」的落点已有对应条目**（不是一句「挪到任务 15」了事）：本步把这两条**已经写进**
`docs/手动验证清单.md` 的**「账户与分类管理」小节末尾**（入口在不在、位置对不对、点它会不会两层同时
挂着）——位置就是那条「从子面板返回设置面板…页面能正常滚动」之后、`## 预算设置与固定支出` 标题之前
（唯一锚点见任务 15 那一节：那两条分别含有「第四行是「外观与背景」」与「两层不会同时挂着」两句原文），
**追加在末尾**是那边的规矩（任务 15 那张对照表按子节内顺序定位，往中间插会让编号错位；而这里追加不影响
任何编号：那张表的落点全在「背景照片」与「备份」两节）。任务 15 步骤 1 那段代码块里没有这两条、也不该有
（否则会重复）。

- [ ] **步骤 3：Commit（五条：代码 / 注释 / 白名单 / 文档同步 ×2）**

```bash
git add app/ui/settings-sheet.js
git commit -m 'feat(appearance): 设置面板加入外观入口'
git add app/theme-store.js app/main.js
git commit -m 'fix(theme): 入口接上后「停在默认外观」的半句改准'
git add sw.js
git commit -m 'chore(sw): appearance-sheet.js 进预缓存白名单'
git add docs/superpowers/specs/2026-09-26-pvault-custom-background-design.md docs/superpowers/plans/2026-09-26-pvault-custom-background.md docs/手动验证清单.md
git commit -m 'docs(appearance): 同步任务 12（入口、白名单、口径收窄与肉眼落点）'
git add docs/superpowers/plans/2026-09-26-pvault-custom-background.md
git commit -m 'docs(appearance): 任务 12 收尾——镜像核对口径与行号锚点化'
```

（**第五条不在最初列的清单里**——它是收尾自查时补的：把「镜像怎么核的」「哪些行号这次飘了」写进上面的实录。
原计划这里只列了四条，实测多出一条；计划已按实际的五条补齐，免得下一个人对不上 `git log`。）

**本步实录（做完之后回填，数字都可复现）**

- **镜像核对**：五处代码块（`settings-sheet.js` 的两段、`main.js` 的那段注释、`theme-store.js` 的 JSDoc、
  `sw.js` 的 `ASSETS` 条目）都按 **HEAD 的 git blob**（`git show HEAD:<文件>`，行尾是 LF）逐字符比过——
  五处全部一致；比对用的探针是一支临时的 `.mjs`（跑完即删，不留在仓库里）。**方法上踩过一次坑**：探针里
  不能直接 `execFileSync('git', …)`（本机沙箱下管道捕获子进程输出会 EPERM），改成 PowerShell 那侧
  `git show … | node 探针 <锚点> <标签>`、探针从 stdin 读内容才跑通。白名单那条还与任务 14 那段代码块的
  位置约定比过一次：`appearance-sheet.js` 在 `accounts-view.js` **之后**（`app/ui/` 段内 ASC），**原计划写的
  「之前」是错的、照抄会破坏段内顺序，实现时按 ASC 改成了「之后」**，任务 14 那一步的文字已同步改准。
- **白名单**：`ASSETS` 加了 `'./app/ui/appearance-sheet.js'`，`CACHE` 留在 `'pvault-v17'`（判断见上面连带
  改动 1）。**三个数各说各的，口径都写在这里**（返工一轮里「61 还是 60」吵过一次，根因是三个数被当成同一个）：
  · **数组内条目数**（含 `'./'` 那条）：60 → **61**。
  · **任务 14 步骤 2 那支存在性脚本数的「文件」**（数组内去掉 `'./'`）：59 → **60**。
  · **`scripts/check-theme-css.mjs` ⑬ 报的「`ASSETS` 条数 / 全文带引号路径」**（**去重后的 `'./…'` 字符串
    集合**，且全文比对是双向的）：60 → **61**。
  **实测三段**（用与 ⑬ 同一套正则对 `git show <commit>:sw.js` 各算一次）：`eeaa217`（基线）60 条 / 60 个；
  `0ba10f7`（只加了 import 的代码 commit，白名单未动）60 / 60；`f140ae6`（白名单 commit）**61 / 61**。
  「数组内条目数」可以在仓库里直接数出来：`Select-String -Path sw.js -Pattern "'\./"` 现在命中 **62 行**——
  其中 **61 行**是数组条目（含 `'./'` 那条），第 62 行是文件末尾回退路径里那处 `caches.match('./index.html')`
  （它与清单里那条同串，所以 ⑬ 的去重集合仍是 61）。
- **两个守卫的实测**：
  · `tests/boot-order.test.js` 第 6 条在**只加 import、还没加白名单**时红过一次，报文正是设计好要挡的那句
    「这些首屏资源不在 ASSETS 里：./app/ui/appearance-sheet.js」；白名单补上之后全量测试 **273 pass / 0 fail**。
  · `scripts/check-theme-css.mjs` 全程 **69 项全绿**（⑬ 本次 60 → 61）——**它抓不住「清单里少一条」**，
    所以两个守卫缺一不可（⑬ 的绿不能当成白名单已经处理过）。
- **只做了静态核对、没有实测渲染**：入口的位置、`open` 的指向、`import` 建立的依赖、`swapTo` 的调用形态
  都是文本层的事实；「点一下会不会两层同时挂着」「位置看着对不对」只有真机能验，已挂到任务 15（见步骤 2）。
  **本步没有任何一行是「在浏览器里跑出来的」。**

**返工一轮实录（复审判不通过；代码本身全部核实正确，成因是文档同步没做全）**

复审裁定：入口位置、白名单 ASC、`CACHE` 判断、连带改动 2 的收窄——**代码全部正确**；不通过的每一处都在
文档侧，其中最大的一处在**本步当时没改的另一个文件**里。改了什么：

1. **跨文件的序数全部 +1（本轮最大的漏）**：`docs/手动验证清单.md` 里三处「设置面板第 N 行」在插入入口后
   全部错位（「预算设置下面出现第四行『备份与恢复』」→ 预算下面现在是第四行「外观与背景」、备份是第五行；
   「入口是设置面板的第五行『账单导入』」与「设置面板第五行是『账单导入』」→ 都是第六行）。**其中一处还与本步
   新加的条目直接冲突**：新条目写着「第五行是『备份与恢复』」，而账单导入那节写着「第五行是『账单导入』」
   ——同一份文件两处对「第五行」给了相反答案。已全部改准，并把整份清单里所有序数型描述扫了一遍（其余命中
   都是「CSV 文件的第 N 行」「摘要第四个数字」这类与设置面板无关的，逐条核过）。**这类描述没有任何机器守卫
   看着**（`tests/` 对 `SETTINGS_ENTRIES` 零断言），所以另在 `app/ui/settings-sheet.js` 的 `SETTINGS_ENTRIES`
   上方加了一段注释，写明这份列表的顺序/条数被清单里哪几条引用、改动时要一起改准（给的是引文锚点，不是行号）。
2. **`settings-sheet.js` 两处**：① 账单导入那条注释我上一次改成「上面五行都是每天要用的**记账配置**、外观与
   数据保险」——与同一文件里「外观既不是每天要改的记账配置」**谓语打架**，已按那一处的口径改准；
   ② 模块头「设置面板（任务 17 的入口聚合）：账户管理 / 分类管理 / 预算设置」只列三项，已改成六个入口全列
   （这一处在插入前就已陈旧，本步让它更陈旧了，顺手改准）。
3. **计划内部矛盾**：任务 10 那一节的「任务 14 还会再加 `appearance-sheet.js`（+1）」与任务 14 段落的
   「一个文件都不用再加」互相打架，已按实测改准（资源集合与 `ASSETS` 在任务 12 各 +1，任务 14 只升版本号）。
4. **行号锚点化**：上一次只覆盖了 3 条，本轮把任务 10 那一节里**实测已经飘掉**的 7 处（`renderSeq` 那一行的
   注释、`let themeReady` 的落点、`render()` 里那次 `await`、两处 `mount()`、`openFromShortcut()` 的调用与
   定义、`entry-panel.js` 那次 `Promise.all`、§「核不到什么」里那条）全部改成**锚点描述**，不再写数字。
   顺带把复审附带发现的 `tests/schema.test.js` 两处（「第 186–188 行」「第 166 行」）与任务 5 的两处
   （`image-scale.js` / `file-info.js`）**一并锚点化**（那几处引用的原文同时也对不上——实测
   `image-scale.js` 与 `file-info.js` 里这两句在任务 5 实现时就已经改准，那些数字从写下那天起就是错的）。
5. **口径**：本步实际是 **5 个 commit**（上一次报告里写成 4 个，步骤 3 也漏列了第五条），已补齐；「同型句」
   那张表拆成**两个不同口径**（A＝这句话本身变没变假；B＝要不要跟着任务号返工），两者**不能相加**；规格
   §5.4 那句「下一段」的措辞改准（它与上一句同在 `:283` 同一个自然段里，是段中与段末的关系）。
6. **任务号从清单里拿掉**：上一步新加的那条曾写着「**任务 12 建的入口**」——那份清单通篇不写实现任务号
   （它记的是「真机上该看到什么」，不是「哪个任务做的」），已改成不带任务号的措辞（「也是『没有浏览器时
   只能挂在真机上确认』的那一条」）。**任务号仍然留在本计划与代码注释里**：那里它有用（能对上 commit）。
7. **`ASSETS` 那三个数**：「数组内条目数」「存在性脚本数的文件数」「⑬ 报的去重字符串数」在本步一度被当成
   同一个数（复审看到 ⑬ 从 61 掉到 60、我这边量到的是 60 → 61）。本轮把三个口径与**逐 commit 的实测**
   都写在下面「白名单」那条里：用与 ⑬ 同一套正则对 `eeaa217` / `0ba10f7` / `f140ae6` 三份 `sw.js` 各算
   一次，得到 `60/60 → 60/60 → 61/61`——**没有任何一步是 61 → 60**（`0ba10f7` 只加 import、没动白名单，
   数当然不变；白名单那一 commit 才 +1）。

**连带改动（两件，都不能延后）——任务 11 收尾时补的提示，来源标在这里免得被当成原计划的话**

1. **`appearance-sheet.js` 要跟这一次提交一起进 `sw.js` 的 `ASSETS`**：这一步让 `settings-sheet.js` 静态
   `import` 它（`main.js` → 设置面板 → 外观面板），它从此是**首屏静态依赖**，而 SW 是 cache-first——白名单
   晚一步，已装旧缓存的设备离线启动就断在这一环（机制见 `sw.js` 开头那段；与 v14 / v16 / v17 三次同一个
   形状）。这一步做完，`tests/boot-order.test.js` 的第 6 条会先红一次，那正是它被设计出来要挡的事。
   **`CACHE` 要不要 +1 按 `sw.js` 开头那条例外的边界判**：`pvault-v17` 若仍没发布（没有任何设备装着它）
   就不必 +1；一旦它已经在设备上服役过，改 `ASSETS` 就得 +1。**这一步实测判为「不 +1」**：`main` 上还是
   `pvault-v15`，`pvault-v17` 只存在于这条还没发布的分支上（`git show main:sw.js` → `const CACHE =
   'pvault-v15'`），所以 `addAll` 写的还不是一份服役中的缓存。于是任务 14 那一步**不用顺延**，照写它已经
   写好的 `pvault-v18` 即可（它那段「若任务 12 已经升到 v18 就顺延到 v19」的调和口径因此不触发）。边界
   原文见 `sw.js` 开头那段：**「已经在设备上服役过的版本，改 ASSETS 就得 +1。」**
2. **两句既有的话在这一步变窄，要一起改准**（注释诚实性）：设计规格 §5.4 末尾那句「一次主题失败＝本次
   页面生命周期停在默认外观、刷新才恢复」，以及本计划任务 10 那一节里的同型句（「兜住之后不再重试
   （一次失败＝本次页面生命周期停在默认外观、刷新才恢复，典型触发是 `db.js` 的 `onblocked`）」）。
   入口接上之后，用户点一次皮肤或深浅就会 `paint()` 把整条变量写出去——「停在默认外观」不再成立
   （停在的是他刚点的那套，只是本页启动时没从库里读出来）。**「不再重试 `initTheme`、刷新才恢复」那一半
   仍然成立**，要改的只是「停在默认外观」这半句。`app/theme-store.js` 的 `initTheme()` 注释与 `app/main.js`
   里同型的那句已在任务 11 按这个口径改过（写的是「面板文件由任务 11 建好、设置入口任务 12 接」），
   照着那个口径写。

   **这一步的全仓搜索与逐条判断。两张表的口径不同，别把它们相加**（这是返工时被指出的一处混淆）：

   **口径 A —— 「这句话本身变没变假」**（判断依据：入口接上之后，原句在那个**新的用户能力**下还成不成立）。
   搜索命令：`Select-String -Path app\*.js,app\ui\*.js,docs\...\*.md -Pattern '停在默认外观','外观是默认'`。
   含同型句的位置 **6 处**（同一处若有两句，各算一处）：**改 4、不改 2**。

   | 位置 | A：变假了吗 | 依据 |
   |---|---|---|
   | 设计规格 §5.4 那句（**在 `:283` 这同一个自然段里**，是该段**段末**的那句：「一次主题失败＝本次页面生命周期停在默认外观、刷新才恢复」） | **变假 → 改** | 原句把两件事用「＝」绑在一起；「停在默认外观」这半句在入口接上后不成立，另半句仍成立，所以只改这半句 |
   | 本计划任务 10 那一节里的同型句 | **变假 → 改** | 同上一行；连带把「`pvault-v17` 仍未发布」这类只在当时成立的判断标了时点 |
   | `app/theme-store.js` 的 `initTheme()` JSDoc | **变假 → 改** | 原文「**这个结论以『没有人能点到 setPreset / setMode』为前提**……在那之前用户点不到它」——入口一接上这两句就假了（反过来了：现在点得到）；新写的首句是「上面这段描述只维持到有人点过皮肤 / 深浅那一刻」（不能写成「这个结论只在没人点时成立」——那会把「不再重试」这半句真正的结论也一起说没） |
   | `app/main.js` 里同型的那段注释 | **变假 → 改** | 它写的是「点一次皮肤或深浅就会 paint()」+ 那半句结论的组合，入口接上后需要补上「哪半句不成立了」 |
   | 设计规格 §5.4 那句（**同一个自然段里的前半句**：「`.catch` 兜底保证主题出错不拖垮整页（照常渲染，只是外观是默认的）」） | **没变 → 不改** | 它说的是「那一次渲染用的是兜底值」——`catch` 路径确实照常渲染、那一帧确实是默认外观；与「此后用户能不能点皮肤」无关，加进限定反而变啰嗦。（**注意它不在「下一段」**：与上一行那句同在 `:283` 这一段里，返工时按段数说法被指出不准确） |
   | `app/main.js` 里 `.catch` 的日志串 `'主题初始化失败，用默认外观'` | **没变 → 不改** | 描述的是那次失败本身（此刻外观确实是默认的），不是失败之后整个生命周期的状态 |

   **口径 B —— 「要不要跟着任务号返工」**（只针对任务 11 留下的「（面板接上之前）」这类**限定语**）。
   搜索命令：`Select-String -Path app\*.js,app\ui\*.js,docs\...\*.md -Pattern '才接上','接上之前','用户点不到'`。
   命中 **6 处**：**本步变假、改 3 处**；**仍然成立、不改 3 处**。**B 与 A 是两组不同的位置，只有
   `app/main.js` 与 `app/theme-store.js` 那两处在两组里都出现过**——但出现的原因不同：在 A 里它们是「那句话本身变假了」，
   在 B 里它们是「**不**因为任务号而返工」（任务 11 特意把措辞写成不跟任务号走）。两处都不是「B 里的不改
   推翻了 A 里的改」：A 改的是句子的内容，B 的结论是那处**不必**为了「任务 12」这三个字再改一遍。

   **B 的逐条**：
   · **本步变假、已改**（3 处）：`sw.js` 开头那段「ui/appearance-sheet.js **这次没进**……（设置入口在任务 12
     才接上）」——要加的那一行正是它说的那一行；本计划任务 11 步骤 4 的「（入口在任务 12 才接上，本步可以
     临时在 Console 里调……）」；任务 11 收尾的「**`ui/appearance-sheet.js` 这一步不进清单**……（入口在任务
     12）」。改法都是把「才接上」改成「本步做时还没接、由任务 12 接上」，保住那句在它自己那一步读也对。
   · **仍然成立、不改**（3 处）：① `app/main.js` 的「（…任务 11 建、设置入口任务 12 接上）」与
     `app/theme-store.js` 里那句同型的话——接上之后读仍然准，这正是任务 11 当时的用意；②
     `app/ui/appearance-sheet.js` 里滑块节流那条「本机没有浏览器，这个数只能靠任务 15 的真机验收」——入口
     接没接与它无关；③ 同文件里「自愈的正确位置**不在面板**」——说的是职责归属（那条降级的判据只有
     theme-store 自己拿得到），与入口无关。

---

## 任务 13：备份带上背景照片

**这个任务是本次最容易漏的接缝。** `invoiceFiles` 那次就是因为在设计里写了「备份是整表导出、不用改」而漏掉 `name` 字段，直到换机才暴露。所以导出与导入两段代码必须**成对**写，评审时逐行对照。

**文件：**
- 修改：`app/backup.js`（`buildBackup` 带 `background`；`summarizeBackup` 加 `hasBackground`）
- 修改：`app/backup-store.js`（导出侧编码、导入侧成对处理）
- 修改：`app/db.js`（`replaceAll` 加 `deletes` 通道，见下第 2 条）
- 修改：`app/theme-store.js`、`app/ui/appearance-sheet.js`（注释与用户文案的同步）
- 修改：`app/ui/backup-view.js`（导出结果里的背景通道 + 摘要页那两处文案）
- 新增：`tests/helpers/fake-browser.js`（内存版 IndexedDB + FileReader 桩，本步为了能自动测）
- 新增：`tests/backup-store.test.js`（导出与导入成对跑的守卫）
- 修改：`tests/backup.test.js`（`data` 的键集断言 + 两条新的 background 断言）

**本步相对计划原文的五处改动**（原文的判断经不起下面给出的事实，逐条列在这里；理由同时写进了代码注释）：

1. **`overlay` 的判据**。原文是 `Number(meta?.overlay) >= 0 ? Number(meta.overlay) : null`。
   `Number(null)` / `Number('')` / `Number(false)` 都是 `0`，而 `0` 在这里是**合法**的遮罩强度
   （`theme.js` 的 `OVERLAY_MIN` 就是 0，滑块能拖到那一格），于是「设置里根本没有这一项」会被写成
   「用户选了 0% 遮罩」——一个从没发生过的值，而备份包是换机时唯一的数据面。改用 `overlayOrNull()`：
   **一个判据只回答一个问题**（0 是「无遮罩」，`null` 才是「没有」）。它同时**夹紧取整**——
   值域交给 `theme.js` 的 `normalizeOverlay`（`Math.round` + 夹到 0..60），不在这里另写一套：
   同一个数字会在「设置 → 备份包 → 设置」这条路上走一圈，两套判据差一点就会让用户调过的值变样
   （第一轮只判类型不夹紧，`-5 / 9999 / 30.7` 会原样进包）。
2. **`assets` 的处置：按主键删（不是整表清），而且「图有设置无」要补设置行**。原文的「不要加
   `clears`」只说了一半，另一半（有图时保证 `settings` 里有一行指向它）没说，于是第一轮实现留下
   一个**真实的成对缺口**：源状态「`assets` 有图、`settings` 里没有那一行」被导出（`encodeBackground`
   只认 assets、不看设置）再导入之后，仍然是「图在库里、没人引用、背景不显示」——而那个源状态
   会被这份代码**自我复制**下去（`setPhoto` 写 assets 成功、写设置失败就会造出它）。
   现在三件事各有机制：
   · 备份带图 → `put('assets', {id:'bg'})` 覆盖同一条，**不碰**表里别的资源记录；
   · 备份带图、而备份的 `settings` 里没有 `backgroundImage` 那一行 → 用背景包里的
     `overlay`/`createdAt` **现造一行补上**（这也正是 `data.background.overlay` 存在的意义：
    在此之前它没有任何消费方，是空转的）；
   · 备份不带图 → 把本机那条**按主键删掉**，并跳过备份 `settings` 里那一行。
   为此给 `app/db.js` 的 `replaceAll` 加了 `deletes: [{ store, key }]` 通道（与 `clears` 同事务）：
   第一轮用的是 `clears.push('assets')`＝**整表清空**，在 `assets` 真多出第二条资源记录时会把它
   一起端掉，而代码注释、规格、本计划三处都写着「清单不该靠『现在只有一条』活着」——说一套做一套。
   （真要在「备份不带背景」时保住本机背景，得把设置行也一起保留、两处都不动——像 `vault` 那样；
   规格 §13 里那条「恢复的是一台机器上的图（不是当前这台残留的）」的验收项与它冲突。）
3. **失败降级要有通道，不能只写进 Console**。`encodeBackground` 失败仍按原文降级成「这次不带背景」
   （账目比背景重要），但**不能是静默的**：`exportBackup` 现在返回 `backgroundSkipped`（布尔，
   与 `skipped` 那个张数分开——背景只有一张，文案与后果都不同），`app/ui/backup-view.js` 在导出
   结果里落一行警示。理由与 `encodeFiles` 那边写着的一样：「备份少了一张图却显示成功，
   等用户换手机那天才发现，那就太晚了」。同时 `encodeBackground` 的返回值从「对象或 null」变成
   `{ background, skipped }`：**「库里没有背景」与「有背景但没读出来」必须能分开**——前者不是降级、
   不该报警，后者必须报警，而两者的 `background` 都是 `null`。
4. **面板上那句被删掉的备份承诺加回来了**。`app/ui/appearance-sheet.js`（任务 11 的产物）里原本写着
   「**不写「跟着备份一起走」**：导出包现在还不带背景（…那是任务 13 的事）」，用户可见的文案里因此
   没有备份这回事。本步把这个前提消掉了（导出、导入两侧都有测试钉住），所以：文案改成
   「……然后存在这台手机上，导出备份时会一起带走」，注释同步改准**并写明边界**——`encodeBackground`
   失败的那一次导出不带背景，而界面会当场告知（见第 3 条），所以这句是「会」不是「永远会」。
   判断依据：一句真话且对用户有用的话，不该因为「上一版做不到」而永久留在删除状态；用户最担心的正是
   「换手机后背景没了」，而备份是他唯一能主动保住它的手段。`theme-store.js` 里那句「当前的备份包就没有
   assets（规格 §7 的任务 13 接缝）」也是同一件事的另一种说法，一并对齐。
5. **摘要页必须有一行「背景照片」**。背景的处置方向与发票图片**相反**（备份不带背景 → 本机那张被
   删掉），而那一屏是用户点「确认覆盖并恢复」之前唯一一次知情机会——`backup-view.js` 自己在那段
   注释里立了纪律：「图片这一行的判据必须与 `backup-store` 的 `clears` 严丝合缝地一致」。
   所以 `summarizeBackup` 加 `hasBackground`，摘要页加一行（不包含时写明「本机那张背景会被一起
   清掉」），底部那句「上面写着『不包含』的那几项，本机现有的数据会保留」也补上背景这个**例外**——
   用户会拿那句话去推，推错一次就是本机唯一一份照片。判据取的是导入侧那两条必要条件
   （`image` 是非空字符串、长度是 4 的倍数），边界（长度合法但字符非法的 base64 两边不一致）
   如实写在 `app/backup.js` 的注释里。

- [ ] **步骤 1：`buildBackup` 带上 background**

`app/backup.js` 的 `buildBackup` 里，在 `vault` 那一行之前加：

```js
      // 背景照片（base64）与它的遮罩强度。与 invoiceFiles 同理**刻意不深拷贝**：
      // 它是一个几百 KB 的 base64 串，structuredClone 会白复制一份，而对象由调用方现造现交。
      background: payload.background ?? null,
```

- [ ] **步骤 2：导出侧**

`app/backup-store.js`：在文件顶部常量区（`ARRAY_STORES` 附近）加：

```js
// 背景照片那一对名字。图片本身存在 assets 表里（见 schema.js），设置里那一行只存引用与遮罩强度
// （`{ assetId, overlay, createdAt }`，见 theme-store.js 的 setPhoto）。
// `'bg'` 与 theme-store.js 导出的 BACKGROUND_ASSET_ID **是同一把钥匙**，这里刻意再定义一次而不从
// 那边 import：theme-store 会牵进 DOM 与 Canvas 一整串模块，这一层不需要它们（image-scale.js 那次
// 也是同一个理由）。两个常量同名同值，改一处就得改另一处。
// 导出与导入两侧都要用到它们，而且必须成对——只改一处就会留下「设置指向一张不存在的图」
// （theme-store 的 applyPhoto 会按「没有背景」兜住并顺手清掉设置）或「图在库里、没人引用」
// （界面看不出来，但下一次导出会把它带走）。文件头第 7 条讲的就是这件事。
const BACKGROUND_KEY = 'backgroundImage';
const BACKGROUND_ASSET_ID = 'bg';
```

在 `exportBackup` 里，`encodeFiles` 那一段之后、`buildBackup` 之前加：

```js
  // 背景照片单独打包成 data.background。它与「不含图片」开关**无关**：
  // 它是外观设置的一部分，压缩后的照片只有一两百 KB，而「换机后背景丢了、找不回来」是没法补救的
  // （用户自己选的那张照片可能早就删了、设备上只剩这一份，与图片那条路同源）。
  // 上面那道几十 MB 的体量闸门（MAX_INLINE_FILES_BYTES）只盯着 invoiceFiles，不会把这一张挡在外面：
  // 它是 KB 量级，而拦下它的代价是用户换机后背景再也找不回来，收益接近零。
  // skipped 与 backgroundSkipped 是两件事，界面必须分开说（前者是张数、后者只有一张）。
  const { background, skipped: backgroundSkipped } = await encodeBackground(settings);
```

并把 `buildBackup` 那一行改成：

```js
  const pkg = buildBackup({ ...arrays, settings, vault, invoiceFiles, background }, now);
```

在 `encodeFiles` 的定义之后加（`overlayOrNull` 挨着它一起加）：

```js
// 遮罩强度：先回答「有没有这个值」，有才把它交给 theme.js 的 normalizeOverlay 去夹紧取整。
//
// **两件事必须分开做，判据必须与 normalizeOverlay 同源**：
// · 「有没有」不能靠 normalizeOverlay——它对坏值一律回默认 30，表达不了「没有」；
// · 「归一化成什么」也不能在这里另写一遍——normalizeOverlay 会 Math.round 并夹到
//   OVERLAY_MIN..OVERLAY_MAX（0..60），而 0 是**合法**值（「完全不加遮罩」，滑块能拖到那一格）。
//   自己写一个只判范围的版本，会让 -5 / 9999 / 30.7 这种值原样进备份包，再被导入侧写回设置：
//   同一个数字在「设置 → 备份包 → 设置」这条路上走一圈就变了样。
// **为什么不能图省事写 `Number(x) >= 0 ? Number(x) : null`**：Number(null) / Number('') /
// Number(false) 都是 0，那句写法会把「设置里根本没有这一项」写成「用户选了 0% 遮罩」——
// 一个从没发生过的值。备份包是换机时唯一的数据面，写进去的假值会一直被当真
// （theme.js 的 normalizeOverlay 早已为同一件事写过一段注释，这里是同一个坑的第二次出现）。
function overlayOrNull(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? normalizeOverlay(value) : null;
  if (typeof value === 'string' && value.trim() !== '') {
    return Number.isFinite(Number(value)) ? normalizeOverlay(value) : null;
  }
  return null;
}

/**
 * 把背景照片编码进备份包（data.background）。
 * 返回值是 `{ background, skipped }`——**两个都为 null / true 时含义完全不同**，调用方要分开说：
 *   · `{ background: null, skipped: false }`：库里压根没有背景（没设过，或用户已经「移除」过）。
 *     这是正常结果，不是降级，什么都不用提示。
 *   · `{ background: null, skipped: true }`：库里有那张图，但这次没能读出来／编进包。
 *     **这是降级**，必须让用户知道（见 exportBackup 的 backgroundSkipped）。
 *
 * 任何失败都返回 null 而不是抛错：一张背景图不该把整次导出打回去——导出是用户保住账目的唯一手段，
 * 而账目比背景重要得多（与 encodeFiles 里「跳过脏记录」同一条纪律）。
 * **catch 里分不清「读失败时库里到底有没有那张图」**（读库那一步本身就失败了），那边一律按
 * `skipped: true` 报——宁可多提示一次，也不要让一次真的丢图混在「正常导出」里过去。
 *
 * settings 传进来是为了在背景包里一并记下遮罩强度（data.background.overlay）。导入侧会用它补写
 * settings 那一行（备份的 settings 里没有 backgroundImage 时，见 importBackup），这是它**目前唯一
 * 的消费方**；备份 settings 里正常有那一行时，遮罩随 settings 表整体覆盖走，与这个字段同源、
 * 不会打架。
 */
async function encodeBackground(settings) {
  try {
    const row = await db.get('assets', BACKGROUND_ASSET_ID);
    const blob = row?.blob ?? null;
    // 没有图 = 没有背景，不是降级。
    if (!blob) return { background: null, skipped: false };
    const image = await blobToBase64(blob);
    // 这个不一样：图在库里、只是这一次没能读出来——**是**降级。
    if (!image) return { background: null, skipped: true };
    const meta = settings.find(r => r?.key === BACKGROUND_KEY)?.value ?? null;
    return {
      background: {
        overlay: overlayOrNull(meta?.overlay),
        // 只认有值的数字：0 是 1970-01-01，一个像真实时间的哨兵值，宁可写成 null 也不让它混进去
        // （theme.js 的 normalizeBackground 给 createdAt 判过同一件事，那边连字符串都不认）。
        createdAt: Number(row.createdAt) || null,
        mime: row.mime || 'image/jpeg',
        image
      },
      skipped: false
    };
  } catch (err) {
    console.warn('背景照片读不出来，这次备份不带它', err);
    return { background: null, skipped: true };
  }
}
```

- [ ] **步骤 3：导入侧**

在 `importBackup` 里，`invoiceFiles` 那个循环之后、`settings` 校验之前加：

```js
  // 背景照片：与 invoiceFiles 同一条路（Blob 进不了 JSON，只能单独反解），但处置**正好相反**，
  // 而且两处必须成对，见文件头第 7 条。这里只做前半段（写），后半段（清）在下面 clears/deletes
  // 那一段——那里才拿得到那个数组。两段合起来是一条规则：
  //   备份里**带**了可恢复的背景 → assets 里那条 'bg' 写回去（id 固定，put 即覆盖），
  //      **并且保证 settings 里有一行指向它**（备份自己的 settings 里没有就现造一行，见下）；
  //   备份里**没有**（老备份根本没有这个键、那次导出时读图失败、或这段 base64 解不开）
  //     → 本机那条一并**按主键删掉**，并且不让设置里留下指向它的 backgroundImage 行。
  // 为什么「没有」时要清、而 invoiceFiles 却保留：settings 是整表覆盖的，本机那条 backgroundImage
  // 必然被这次导入清掉——本机那张图**已经失去引用**，画面上也不再显示它。此时把字节留在库里不等于
  // 「保住用户的东西」，只会让它在下一次导出里复活（encodeBackground 只认 assets 那条记录、
  // 不看设置里有没有引用）并跟着备份跑到第三台设备上去。真要在这种情况下保住本机背景，得把设置行
  // 也一起保留（像 vault 那样两处都不动），那是另一个决定：规格 §13 里那条「恢复的是一台机器上的图
  // （不是当前这台残留的）」的验收项与它冲突——「留图 + 备份的设置行」恰恰会做出「图上来了、
  // 但不是备份里那张」的混合状态，比干脆没有更难解释。
  const bg = data.background;
  // 判据只看「能不能解出一张图」：形状不对（字符串、数组、null、老备份的 undefined）与 base64 坏了
  // 走同一条路——都没有可恢复的背景。base64ToBlob 自己会挡住空串/非 4 倍数/解不开的串。
  const bgBlob = (bg && typeof bg === 'object') ? base64ToBlob(bg.image, bg.mime) : null;
  // 备份的 settings 里有没有那一行——下面补行与跳过行两处都要用，所以在这里先问一次。
  const bgSettingInBackup = data.settings.some(row => row?.key === BACKGROUND_KEY);
  if (bgBlob) {
    puts.push({
      store: 'assets',
      value: {
        id: BACKGROUND_ASSET_ID,
        blob: bgBlob,
        mime: bg.mime || 'image/jpeg',
        size: Number(bgBlob.size) || 0,
        // 与 theme-store 的 setPhoto 同一个字段含义（这条记录是什么时候写下的）。
        // 备份里没有这个时间（老格式、或那段导出失败）就用导入时刻。
        createdAt: Number(bg.createdAt) || Date.now()
      }
    });
    // 备份带了图，但它的 settings 里**没有** backgroundImage 那一行——源机器上就是「图在库里、
    // 没人引用」的状态（`setPhoto` 写 assets 成功、写设置那一步失败就会留下它；而 `encodeBackground`
    // 只认 assets 那条记录，会把这种状态原样导出来，于是它会**自我复制**下去）。
    // 不补这一行的话，导入端复制出来的还是「图写进去了、没有引用」：背景不显示，而且下一次导出
    // 又把它带给第三台设备。所以这里用背景包里的 overlay / createdAt 现造一行补上——
    // **这正是 data.background.overlay 存在的意义**：在此之前它没有任何消费方，
    // 那份「照片自己的记录」是空转的，而补这一行正好需要它（也正因如此，那个值必须先夹紧取整，
    // 见 overlayOrNull：它现在会直接进 settings）。
    if (!bgSettingInBackup) {
      puts.push({
        store: 'settings',
        value: {
          key: BACKGROUND_KEY,
          value: {
            assetId: BACKGROUND_ASSET_ID,
            // normalizeOverlay 兜住 null / 脏值（回 OVERLAY_DEFAULT）并夹紧取整——与 theme-store
            // 的应用侧用的是同一个函数，所以补出来的这一行和用户自己在面板上设过的行长得一样。
            overlay: normalizeOverlay(bg.overlay),
            createdAt: Number(bg.createdAt) || Date.now()
          }
        }
      });
    }
  }
```

`settings` 那个**入队**循环里加一行跳过（校验循环不动：只查 key 是不是字符串）：

```js
  for (const row of data.settings) {
    if (row.key === VAULT_KEY) continue; // 密码箱只认 data.vault，避免文件里两份互相打架
    // 备份里没有可恢复的背景时不写回这一行：写了就是一条指向不存在记录的**悬空设置**
    // （theme-store 的 applyPhoto 会按「没有背景」兜住它并顺手把设置清掉，但那要等到下一次启动，
    // 中间这段时间里库里的状态是自相矛盾的）。它与上面「按主键删掉 assets 那条记录」是同一件事的两半。
    if (!bgBlob && row.key === BACKGROUND_KEY) continue;
    puts.push({ store: 'settings', value: row });
  }
```

`clears` 那一段加**另一半**（成对的第二半）——注意它走的是 `deletes`，**不是 `clears`**：

```js
  // 清空哪些仓库，与「这份备份到底带没带这张表」严格对齐，一个都不能多：
  //   · ARRAY_STORES 里的表：备份里真有这个数组才清；
  //   · invoiceFiles：它不在 ARRAY_STORES 里，所以必须**显式**写在这个清单里（不能靠派生），
  //     但它同样只在备份里真的带了图片时才清——清空的目的就是「覆盖恢复之后不留下上一份数据的
  //     图片残留」，备份里没有图片时就没有可覆盖的东西，此时清空只会删掉本机唯一一份原图，
  //     而备份文件里并没有它们的替补。这与文件头第 4 条「备份里没有密码箱就保留现有密码箱」
  //     是同一条纪律：**没有替补的东西，一律不删**。
  // 无条件清 clears 的代价（也就是「问 a」的答案）：老备份根本没有 invoices 键，
  // 而它很可能被导入到一台**已经有发票和图片**的设备上（用户在用的就是这个新版本）。
  // 那时无条件清会把本机发票和图片一起抹掉，而备份文件里没有它们的替补——
  // 「恢复备份」这条唯一的救命通道就变成了毁数据的开关。
  // 反过来，备份里带了图（正常含图导出）时**必须**清：不清就会留下上一份数据的图片残留。
  // 背景那一条走的是 deletes，**不是 clears**（成对处理的另一半，写在那一段在发票图片循环的后面）：
  //   · 只有备份里**没有**可恢复的背景时才删，与上面那条对图片的处置正好相反——因为「没有背景」时
  //     本机那条记录的引用已经被 settings 的整体覆盖拿走了（settings 整表覆盖，备份里没有
  //     backgroundImage 行），留着它只是不合规的残留；而图片那边本机的原图仍然挂在发票上、
  //     仍然看得到，删了才是真丢。
  //   · **为什么必须是 deletes 而不是 clears**：assets 是通用资源表，这一层要删的只有 'bg' 一条。
  //     clear('assets') 会把整张表端掉——那正是这条注释上一段说的「多余的删除」，也正是在
  //     「清单不该靠『现在只有一条』活着」那句里承诺过不做的事（说一套做一套是最容易被下一轮
  //     评审抓住的形态）。备份真的带了背景时更不需要清：那个 id 固定是 'bg'，上面那条 put 已经
  //     把同一条记录覆盖掉了。
  const clears = ARRAY_STORES.filter(name => Array.isArray(data[name]));
  if (arrayOrEmpty(data.invoiceFiles).length > 0) clears.push('invoiceFiles');
  clears.push('settings');

  const deletes = [];
  if (!bgBlob) deletes.push({ store: 'assets', key: BACKGROUND_ASSET_ID });

  // 清空、删除与写入必须在同一个事务里，否则中途失败会留下一个空库（或半截状态）。
  await db.replaceAll({ clears, puts, deletes });
```

**注意**：`assets` 那条 delete 是**有条件的**（只在备份没带背景时可恢复时删），而且**按主键删**，
不是整表清。无条件清会在「备份真的带了背景」时做一次多余的删除（那时上面那条 `put` 已经把同一个
id 覆盖掉了）；整表清在 `assets` 里多出第二条资源记录时会把那条也删掉——后者是复审实测出来的真事故。
理由与 `invoiceFiles` 那句 `if (arrayOrEmpty(...))` 同构：**清空要么是为覆盖、要么是为不留下上一份
数据的残留，两件事都得先有「可覆盖的东西」。**

**另外**：这个代码块里那个 `deletes` 通道是任务 13 给 `app/db.js` 的 `replaceAll` 新加的
（`{ clears = [], puts = [], deletes = [] }`，执行顺序 clear → delete → put，与 `clears` 同事务）。
那里有一句注释解释为什么不能拿 `clears` 顶替它，改这一层时要两边一起看。

- [ ] **步骤 4：跑测试**

运行：`D:\node.exe --test --test-isolation=none`

**实测（两个时点各测一次，口径写在一起）：**

- **返工后（当前状态）：296 pass / 0 fail，exit=0，duration ≈ 17.0s**；
- 第一轮落地时：285 pass / 0 fail，≈11.1s；基线（任务 12 收尾）是 273 pass / 0 fail、≈0.8s。
- 新增 **23** 条 = `tests/backup-store.test.js` 的 **21** 条 + `tests/backup.test.js` 的 2 条
  （第一轮那两份分别是 10 与 2；返工把 backup-store 那一份从 10 加到 21，见下面的补充）。
  口径：`273 + 21 + 2 = 296`，与总数对得上。
- 耗时涨在 PBKDF2 上：`exportBackup` 与 `importBackup` 都按 600000 轮跑，这是真机口径，
  不为了测试快而调低；返工新增的导出侧用例（遮罩夹紧三例、`backgroundSkipped` 等）又跑了几次 600000 轮。

**返工新增的那 11 条逐条对着评审发现的一处缺口或一个变异**：成对缺口（「图在库里、设置那条丢了」
→ 补设置行）、按主键删（`assets` 里的第二条记录必须留着）、遮罩夹紧取整、两侧的 `mime` 兜底、
`createdAt` 兜底、摘要与实删行为同向、静默降级有了通道（`backgroundSkipped`）、桩的索引筛选
（`getAllByIndex` 曾经一条都不过滤）。**其中 7 个变异第一轮「改了也不红」**，现在都能红——
逐条的对照记录写在返工提交的说明里。

**`data` 字段形状那条断言确实被打红了**（`buildBackup 带上格式标识、版本与时间戳`）——它写的是
「键集**完全相等**」。判断：**把 `background` 加进那份清单，保持「完全相等」不改宽成「包含」**。
理由：`data` 里有哪些键本身是有意义的决定（导入侧靠「键在不在」判断要不要清本机的表、靠「值是什么」
判断要不要清本机那条背景），加一个键就该在这里显式改一次、顺手想清楚导入端认不认它；改成「包含」
等于让新键悄悄溜进备份包——`invoiceFiles` 那次漏掉 `name` 正是「新字段没人在清单上过一遍」的后果。
理由已写进 `tests/backup.test.js` 的注释里。同时补了两条：`payload` 没有背景时键在、值为 `null`，
以及背景对象原样进包。

- [ ] **步骤 5：手动跑一次完整往返（这一步不能省；本机没有浏览器，落点在任务 15）**

本机（开发机）没有可用浏览器，下面 5 条**一条都没跑过**。步骤 4 的自动化只盖住了「数据形状」那一层
（导入导出之后库里剩下什么），真机上的渲染、文件下载、真实 IndexedDB 的事务语义都不在里面
（桩盖不住什么，写在 `tests/helpers/fake-browser.js` 的开头）。清单里对应的是任务 15 的
「备份导出携带背景，导入后背景还在」那一条。

1. 起本地服务，设置一张背景照片（遮罩调成非默认值，比如 45%）
2. 备份 → 导出（记下文件大小；顺手对一下它与规格 §13 那条「约 +100~400KB」的预期）
3. 在站点的 IndexedDB 里清空 `assets` 表（DevTools → Application → IndexedDB → pvault → assets → 右键 Clear），刷新页面确认背景消失
4. 备份 → 导入刚才那个文件，输入密码
5. 确认：背景回来了，且遮罩是 45% 而不是默认的 30%

**第 5 步的「45%」是关键**：只验「背景回来了」会漏掉「遮罩强度没跟着走」这种一半成功的恢复。
（自动化里已经有对应的一条：`成对①` 断言导入后 `settings.backgroundImage.overlay === 45`——
但它验的是库里的值，不是画面上真的按 45% 遮罩渲染。）

**再加一条本步新增的真机条目**（任务 15 落到清单里）：**导入一份「没有背景」的备份到一台有背景的
手机上**，确认导入后背景**和**它的设置行一起消失（不是「图还在、只是不显示」）。这条是本次成对处置
在真实设备上的落点；包在浏览器里导不出十几种形状，只能人工造这一种。

- [ ] **步骤 6：Commit（三条：代码 / 测试 / 文档同步）**

```bash
git add app/backup.js app/backup-store.js app/theme-store.js app/ui/appearance-sheet.js tests/backup.test.js
git commit -m 'feat(backup): 备份携带背景照片与遮罩强度'

git add tests/helpers/fake-browser.js tests/backup-store.test.js
git commit -m 'test(backup): 背景导出与导入的成对守卫'

git add docs/
git commit -m 'docs(appearance): 同步任务 13（计划镜像、规格 §7、面板承诺与手动清单）'
```

三条的顺序有理由：**第一次提交后全量测试就是绿的**（`tests/backup.test.js` 的键集断言与代码在同一条
提交里改，它是形状契约的一半）；第二条只加测试设施与守卫，不动生产代码；第三条只碰文档。
`tests/backup.test.js` 跟着代码走而不是跟着测试走，就是为了不让中间那次提交红。
后两条文件（`app/theme-store.js` 与 `app/ui/appearance-sheet.js`）进第一条，因为它们改的是**注释与
用户文案**——那些句子在代码改动落地的那一刻就变成假话了（「备份包还没有 assets」「不写『跟着备份一起走』」），
让它们和代码分两次提交会留下一个「代码说带了、注释说没带」的中间状态。

**返工（两份复审之后）另有三条提交，同样的拆分与顺序、同样不动第一轮那三条**（不 amend）：
`fix(backup): 背景成对处理的缺口（补设置行、按主键删）与遮罩夹紧、失败通道`（`app/` 五个文件，
含 `db.js` 的 `deletes` 通道与 `backup-view.js` 的两处用户文案）、
`test(backup): 返工补 11 条断言；桩的索引筛选与差异清单`（`tests/`）、
`docs(appearance): 同步任务 13 返工（数字口径、节号、两处小注与前向指针）`（`docs/`）。

---

## 任务 14：Service Worker 白名单与缓存版本

**文件：**
- 修改：`sw.js`（步骤 1：`CACHE` 升到 `pvault-v18` + 那段说明）
- 修改：`scripts/check-theme-css.mjs`（步骤 4：⑩ 扩到 §11、新增 ⑮ 与 ⑯、变异 M24–M37）
- 修改：`tests/backup-store.test.js`（步骤 4：那条前向指针的注释按现状改写，测试本身保留）

- [ ] **步骤 1：只改 `CACHE`（`ASSETS` 已由任务 12 补齐，下面只作核对）**

**`canvas-image.js` 已在任务 5 进清单，`theme-store.js` 与 `theme.js` 已在任务 10 一起进清单**（那两步
分别让 `image-store.js` 与 `main.js` 多了静态依赖，白名单必须跟产生依赖的提交一起走），`appearance.css`
已在任务 11 进清单（那一步让 `index.html` 挂上了它的 `<link>`，同一个道理），`appearance-sheet.js` 已在
**任务 12** 进清单（那一步让 `settings-sheet.js` 静态 `import` 它，同一个道理），`CACHE` 那时已经用到
`pvault-v17`。所以这一步**一个文件都不用再加**（原计划这里是「只加剩下的**一个**文件」，任务 12 已经把它
补上了），只需要把版本号再升一版：

```js
const CACHE = 'pvault-v18';
```

**下面这个 `v18` 与任务 12 里那句「按边界判、可能不必 +1」不冲突**：任务 12 只是说「若 `pvault-v17` 仍未
发布，就不必升」（那时升不升都合法），而这一步的口径是**收尾**——无论前面升没升，都要保证「改完这一次
`ASSETS` 之后，已经在设备上服役过的那个版本必须被换掉」。所以：任务 12 若已经升到 `pvault-v18`，这一步
**顺延到 `pvault-v19`**；任务 12 若没升（v17 仍未发布），这一步用上面的 `pvault-v18` 即可。**照下面这段
抄之前先看一眼 `sw.js` 里当前那一行**，别把版本号抄成回退——回退会让所有已装旧缓存的设备永远吃旧代码。
（**任务 12 实测的选择**：`main` 上还是 `pvault-v15`、v17 只存在于未发布的分支上，按边界判**没升**，
所以这一步照抄 `pvault-v18` 即可，不顺延。）

`ASSETS` 这一步**不用改**：`'./app/ui/appearance-sheet.js'` 已由任务 12 加在 `'./app/ui/accounts-view.js'`
**之后**（`app/ui/` 段内按 ASC：accounts-view → appearance-sheet → backup-view；与下面这段代码块逐字符
一致）。位置按的是这份清单**已有的分段约定**（根 → `styles/` 段 → `icons/` → `app/` 顶层 `.js` 段 →
`app/ui/` 段；每段内部按 ASC，**不是**全清单一个字符串序）。留在这里只作为位置与形态的参照，执行时核对
一眼即可——**任务 12 实现时这里踩过一次**：原计划这一步写的是「插在 `accounts-view.js` **之前**」，
那会破坏段内的 ASC 书写风格，实测改成了「之后」：

```js
  './app/ui/appearance-sheet.js',
```

- [ ] **步骤 2：核对每个文件都真的存在**

`cache.addAll` 是**原子**的：一个 404 就让整次安装失败，而失败的表现是「SW 不激活、离线能力为 0」
——很难联想到是一个路径写错。**但这一条与上面那支脚本管的只是「清单里写对了没有」**（路径拼错、
文件改名、文件漏建）；「清单里**漏了一整条**」是另一条路，它不会让 install 失败，后果要到运行时才出现
（离线缓存未命中 → 回退 `index.html` → 模块脚本被 MIME 检查拒绝）。两条路的完整说明写在 `sw.js`
开头那段，别再把它们混成一句话（本轮返工改的就是这处混淆）。

```powershell
# 只从 ASSETS 数组切片里数。旧版按**全文**匹配，注释里带引号的路径会被算成一条清单条目——实测踩到过：
# 在副本的注释里塞一句 './app/nowhere.js'，旧版报 59（真清单是 58），而 Test-Path 全通过、只有数字变了。
$block = ((Get-Content sw.js -Raw) -split 'const ASSETS = \[')[1] -split '\];' | Select-Object -First 1
$paths = [regex]::Matches($block, "'\./([^']+)'") | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
$missing = $paths | Where-Object { -not (Test-Path $_) }
if ($missing) { Write-Host "缺失：`n$($missing -join "`n")" } else { Write-Host "全部存在，共 $($paths.Count) 个" }
```

预期：`全部存在，共 60 个`（61 个条目里 `'./'` 不匹配这条正则、脚本不数它；任务 5 之后跑是 56 个、
任务 10 之后是 58 个、任务 11 之后是 59 个、**任务 12 之后就是本步预期的 60 个**——本步不再往清单里加文件）

**与旧版的差别只有一处**：先把 `const ASSETS = [` 到 `];` 之间的切片切出来，再在切片里匹配。
`Get-Content sw.js -Raw` 是整文件读（**不是**逐行数组——这台机器上逐行读的大文件 `.Count` 会莫名其妙地
少几百行，实测过），切片用两次 `-split`；`[regex]::Matches` 是 .NET 静态方法，PowerShell 里可直接用。
**它只补了「数错」这一半**：反方向（`sw.js` 全文里出现清单外的带引号路径）由 `scripts/check-theme-css.mjs`
的 ⑬ 与 `tests/boot-order.test.js` 守着。

- [ ] **步骤 3：验证离线可用（本机做不了；真机那一遍的落点在任务 15）**

1. 起本地服务，打开一次（让 SW 装上）
2. DevTools → Application → Service Workers 勾 Offline
3. 刷新页面

预期：页面正常打开、账目都在。**如果白屏**，看 Application → Cache Storage 里 `pvault-v18` 是否存在——不存在就是 `addAll` 被某个 404 整批拒绝了。

**本机没有可用浏览器，上面这三步实际做不了**（与任务 9–13 同一种情况），所以这一步改成静态核对：`ASSETS`
逐条存在性、`CACHE` 单处声明、`install` / `activate` / `fetch` 三条路径逐行读一遍——核了什么、结果如何
见下面的「实现记录」。**真机 / 模拟器上的「断网刷新」挂到任务 15**，落点两处：清单里的「### 离线与缓存」
小节、以及步骤 3「模拟器上跑一遍」的第 6 项。**这两处都是本轮补的**：原先任务 15 里没有任何离线条目
（`离线` / `Cache Storage` 在那一整段里 0 命中，实测），只说「挂到任务 15」会挂到一个不存在的落点上。

- [ ] **步骤 4：复核/扩展 `scripts/check-theme-css.mjs`（它已经在仓库里了）**

任务 9 收尾时就把这个脚本入库了——**不再有「等到这一步再从会话临时目录搬」**：那个源路径是会话临时
目录，随时可能被清理，真到这一步可能已经无从搬起。这一步做三件事：

1. **跑一遍**（两种模式都**不写仓库**：核验只往 `os.tmpdir()` 落两个 git blob 探针；自检在
   `--tmp` 下造变异副本，并且 `--tmp` 落在 `--root` 内会被当场拒绝）：

```powershell
D:\node.exe scripts\check-theme-css.mjs               # 核验
D:\node.exe scripts\check-theme-css.mjs --self-test   # 变异自检
```

2. **核对它的必备断言还在不在**（逐条读脚本，别只看退出码）：

   · ③ **`:root` 兜底的四个值 === JS 运行值，逐字符**——`--bg-image` / `--bg-scrim` 对 `'none'`、
     `--scrim-rgb` 对 `themeCssVars('default','light')['--scrim-rgb']`、`--scrim-a` 对
     `String(scrimAlpha(OVERLAY_DEFAULT))`。**这条是必备断言**：`--scrim-a: 0.3` 是
     `OVERLAY_DEFAULT` 在 CSS 里的第二份真相，而仓库里没有任何测试解析 `base.css` 的内容；少了它
     留下的就是一份静默漂移的副本（是**副本漂移，不是显示差异**——那行兜底在现有代码里不会被消费）。
   · ⑫ **Markdown 围栏完整性**（内容行不许粘反引号/波浪线串、块内不许出现非法的结束围栏、结尾不许
     有未闭合的围栏；反引号与波浪号两种都认）。这条是补过一次真实事故的：把代码块同步进计划的那次
     操作丢过结尾换行，制造出两处粘连围栏——CommonMark 要求结束围栏独占一行，于是两个 CSS 块解析
     破裂，而按惰性正则取块的那些断言全都看不见（块内容仍然「看起来」是对的）。
   · 其余：**⑥ `body::before` 在 `styles/` 里只有一条规则**、① 变量名两个方向、
     ② 四个背景变量各有写入者/消费者、④ `body::before` 的声明集合、⑤ 规格 §6.2 ⇄ 实现、
     ⑦ 计划代码块 ⇄ `base.css` 逐字符、⑧ 镜像纪律的两个事实（非 git 环境会记成**未验证**并在
     末尾单独报，总数会少——不要把它当成通过）、⑩ 规格 §13 ⇄ 任务 15 清单、⑪ 被否掉的旧说法不回流、
     ⑬ `sw.js` 的 `ASSETS` ⇄ 全文带引号路径（双向）、⑭ 类名 ⇄ `styles/` 里的规则（含白名单与它的理由），
     外加「自检」组的两条（`--css` / `--store` 的文件名必须在扫描集合里，否则变异会被静默忽略）。
     本轮又加了**两条**：**⑮ 计划镜像（按任务分段的表）** 与 **⑯ 照片模式只动 `--surface` ⇄ 六处副本 0.9**
（常量 + `base.css` 注释 + 规格 4 处——后 3 处是复审时补上的，见「复审后的三条修补」）。

3. **按本次新增的文件扩展它**：`appearance-sheet.js` 与 `appearance.css` 进来之后，① 的两个方向会多出
   新条目；照片模式下的 `--surface` 取值（`rgba(r,g,b, 0.9)`）也值得钉一条。扩展**必须同时补变异**
   （`--self-test` 里的 cases 数组），否则新断言只是恒真的绿。

4. **把 ⑩ 从规格 §13 扩到规格 §11（任务 10 返工时发现的口子）**：⑩ 现在只锚 §13 那 7 条手动项，
   而「冷启动不闪色」这条**验收标准**出自 §11——脚本里 `## 11` / `§11` / `验收标准` 这些串是 **0 命中**，
   所以把任务 15 清单里那一整条删掉，⑩ 一声不响（它只查关键词命中，不查条目该不该在）。
   补法照 ⑩ 现有的形状：给 §11 的条目（现在也是 7 条）做第二张关键词表，逐条断言在任务 15 的清单里
   命中，并给新断言补一个变异（删掉任务 15 里对应的一条 → 必须报红）。选词照 ⑩ 的老教训：
   **每个词必须在清单里唯一**（第一版 ⑩ 用了「深色」，而「皮肤与深浅」小节里也有「深色」，
   于是删掉目标条目后它照样命中，是假绿）。这条是本次扩展的一部分，不要留成待办：⑩ 的覆盖面缺一半，
   等于「有一类验收标准没人机器守卫」，正是这个脚本存在要防的事。

**这个脚本要不要进 `sw.js` 的 `ASSETS`、要不要进 APK、要不要被 dev-server 提供**——三条都自己验
（现状实测都不需要：`ASSETS` 里 `./scripts/` 是 0 条——**任务 10 收尾时它是 58 条**（任务 11 加
`appearance.css`、任务 12 加 `appearance-sheet.js` 之后是 60 条），这个数随任务 13/14
的文件增减，别照抄，数一眼当前清单就行；`build-apk.ps1` 只复制 `index.html` /
`manifest.webmanifest` / `sw.js` 与 `app` / `styles` / `icons`；`dev-server.js` 的
`ALLOWED_ROOT_FILES` 是那三个文件、`ALLOWED_DIRS` 是 `app`/`styles`/`icons`）：

```powershell
(Select-String -Path sw.js -Pattern "'\./scripts/" | Measure-Object).Count             # 预期 0
Select-String -Path scripts\build-apk.ps1 -Pattern 'foreach \(\$d in'                   # 预期只有一处，值含 app styles icons
Select-String -Path scripts\dev-server.js -Pattern 'ALLOWED_DIRS|ALLOWED_ROOT_FILES'    # 预期 app/styles/icons 与那三个文件
```

预期：核验全部通过、自检**所有变异都被抓住**。**条数与变异个数都不写死**——脚本每次都会打印「分组
计数」与「全部变异都被抓住（N/N）」两张表，以那两张表为准；写死的数字会随扩展漂移，而这一轮已经吃
过一次「一个漂亮的数字掩盖了坏围栏」的亏。

- [ ] **步骤 5：Commit（三条：代码 / 脚本 / 文档）**

```bash
git add sw.js
git commit -m 'chore(sw): 缓存版本升到 v18（外观系统交付定版）'
git add scripts/check-theme-css.mjs tests/backup-store.test.js
git commit -m 'chore(scripts): 核验脚本扩到 §11、加镜像表 ⑮ 与照片模式 ⑯（+11 个变异）'
git add docs/
git commit -m 'docs(appearance): 同步任务 14（离线落点、行号锚点化、实测记录）'
```

**第一条的 message 与原计划那句不同**：原句是「新模块进预缓存白名单，缓存版本升到 v18」，而本步
**没有新模块**进白名单（外观面板的两个文件在任务 11 / 任务 12 就进过了，理由见步骤 1 开头那段）——
照抄那句会让提交历史里出现一条与实际改动不符的说明。

**任务 14 的实现记录（本步落地时的实测：2026-09-27 · 分支 `feat/appearance`）**

**步骤 1**：`sw.js` 那一行改成 `const CACHE = 'pvault-v18';`，并在它上面的注释里补了一段 v18 的说明——
写法按开头那条例外如实交代：本步**不加条目**，若只看「改的是 `sw.js` 自己」，这一版其实可以不升；升号
与不升号的实际差别只在 `addAll` 写进哪一份缓存（写新名字时中途失败只让新缓存作废、旧缓存完好）。
实测：`main` 上仍是 `pvault-v15`（`git show main:sw.js`），所以这一次是**定版**，不是「换掉一个在设备上
出过问题的版本」（v15 的设备拿到这次改动本来就会重装一次）；`const CACHE` 升版后落在第 84 行——
**这个数字会随注释长短动，别照抄**（它上一轮在第 77 行，计划里那两处就是这么写的，本轮又动了一次）。

**步骤 2**：那支脚本改用 `[System.IO.File]::ReadAllText` 读（`sw.js` 是含中文的文件，按本项目的纪律
不用 `Get-Content` 读），实测 `全部存在，共 60 个`，与预期逐字一致（61 个条目里 `'./'` 不匹配那条正则、
不被数）。

**步骤 3**：**本机没有可用浏览器**，所以按任务 9–13 的思路改成静态核对，核了三件事——
① `ASSETS` 61 个条目 / 60 条路径逐条 `Test-Path`，全部存在；
② `CACHE` 全文件**唯一一处** `const` 声明（`Select-String` 实测 1 处命中）；
③ `install` / `activate` / `fetch` 三条路径逐行读了一遍：`addAll`（原子）+ `skipWaiting()`；
`caches.keys()` 过滤掉 `!== CACHE` 的那些再删 + `clients.claim()`；只接管 GET、缓存优先 → 网络 →
`res.clone()` 补缓存（写入失败带 `.catch(() => {})`，不产生未处理的拒绝）→ 离线回退
`caches.match('./index.html')`。**「断网刷新」本机验不了**，落点见上面步骤 3 那一段（任务 15 的
「### 离线与缓存」小节 + 「模拟器上跑一遍」第 6 项，两处都是本轮补的）。

**步骤 4**：三件事都做了，另外把镜像守卫从「碎的」推广成了一张**按任务分段的表**。
1. 核验 **170 项全通过**（以脚本自己打印的分组计数为准：① 2、② 9、③ 9、④ 12、⑤ 4、⑥ 1、⑦ 6、⑧ 2、
   ⑩ 7、⑪ 6、⑫ 3、⑬ 5、⑭ 5、⑮ 90、⑯ 6、自检 3）；`--self-test` **37/37 变异全被抓住**。
   （这两个数是**复审修补之后**的最终值；修补前是 168 项与 34/34，多出来的三项见下面「复审后的三条修补」。）
2. 必备断言逐条读过（③ / ⑫ / ⑥ / ① / ② / ④ / ⑤ / ⑦ / ⑧ / ⑩ / ⑪ 都在，⑧ 在本机拿得到 git，
   所以是「跑去且通过」而不是「未验证」）。
3. **新增 ⑮**（镜像表：任务 2–7 与 10–13 共 10 段、33 个块；任务 11 那个 298 行的块用「整文件逐字符
   相等 + 一处已声明偏差的补丁」，其余是「块必须是目标文件的连续子串」）与 **⑯**（照片模式只动
   `--surface`、`0.9` 的六处副本一致（`styles/base.css` 注释 + 规格里**四处**全覆盖）、
   `appearance.css` 不自造变量）。⑮ 把原先散落的三处入口收进一张表，
   并且**显式写下没进表的段与原因**：任务 1 与任务 8 各有一块与现状不一致（本轮逐块实测过），任务 9
   的 2 块由 ⑦ 逐段更精确地守着。这一步没有引入 JS 解析器，⑭ 的边界声明（模板串抽不到）仍是有意的。
4. **⑩ 扩到 §11**：加了第二张关键词表（7 条）。其中第 6 条「tests 全绿」是**自动化**验收，落点在任务 15
   步骤 2 的回归命令、不在 markdown 清单里，所以断言的作用域分 `box`（清单块）与 `t15`（任务 15 整段）
   两种——这是对上面第 4 点那套补法的一处**偏离**，理由写在脚本注释里（不为凑「都在清单里」去改清单）。
   另外给每个词加了「在该作用域内**恰好命中 1 次**」的断言：只断言「命中」时，一个词在两处出现就等于
   把这条变回假绿（⑩ 第一版用「深色」栽过一次，本轮实测：`冷启动不闪色` 在清单里出现 2 次——一条是
   条目本身、一条是它下面的解释——所以第 4 条的关键词取的是带列表标记的 `- [ ] **冷启动不闪色**`）。
   新增变异 **M24–M37 共 14 个**，全部**真的红过**（`--self-test` 逐条打印 `exit=1` 与它报出的预期项；
   其中 M27 / M29 第一版没抓住，原因与本轮修法写在脚本注释里；M35–M37 是复审后的三条修补带来的，
   见下）。
5. 那三条「脚本要不要进 `ASSETS` / APK / 被 dev-server 提供」也按上面的命令核过：`sw.js` 里
   `'./scripts/` **0 条**；`build-apk.ps1` 只复制 `index.html` / `manifest.webmanifest` / `sw.js` 与
   `app` / `styles` / `icons`；`dev-server.js` 的 `ALLOWED_ROOT_FILES` 是那三个文件、`ALLOWED_DIRS`
   是 `app`/`styles`/`icons`。三条都不需要动。

**步骤 5**：实际提交三条（见上面的代码块），文件分组与计划一致。`tests/backup-store.test.js` 跟着脚本
走：它那句「届时应把这条挪到脚本里去」的前向指针本轮兑现了——**纪律的覆盖面搬进了 ⑮，这条测试本身保留**
（`node --test` 与静态核验脚本是两个入口，删掉等于净减少一道守卫），注释已改成与该现状一致的说法，
并写明块数常量 8 现在有两份。

**顺带清掉的（本步发现、不属于原计划范围）**：任务 15 步骤 3 第 5 项里那 7 处对
`docs/手动验证清单.md` 的**绝对行号**（`619–623`、`722–724`、`730`、`666`、`641–645`、`661`、`629`），
改成「小节名 + 条目关键词」定位——实测那 7 处**全部已经飘掉**（那份清单被任务 11 / 12 / 13 各追加过
一次），照着行号核对会撞到别的小节，而它看起来「有个精确的落点」。全计划其余的行号式表述逐条判过：
`main.js` 的「第 9 行」、`theme-store.js` 的「第 15 行」、`sw.js` 的「62 行」（含 `'./'` 的条目 + 结尾
回退路径）三处**仍准**；任务 10 / 12 段落里那几处**是历史叙述**（在讲「行号为什么会飘」这条规矩），
原样保留。

**复审后的三条修补（结论是「通过」，另附三条建议——其中 P1 / P2 是真漏洞，不是风格问题）**

1. **⑯ 的「三处 0.9」盘点不准（P1）**：规格里写死透明度的其实是 **4 处**（§5.1 / §5.4 / §6.3 / §9.1），
   而当时用 `exec` + `indexOf('### 6.3')` 只守到了 §6.3——**复审实测**：把 §5.1 或 §9.1 的 `.9` 改成
   `.8` 都是 `exit=0`、0 条失败，而那段注释正写着「谁改谁漏就是一份静默漂移的副本」。改成 `matchAll`
   对**全部 4 处**逐一比对，并加一条处数断言（处数 ≠ 4 也红：新副本不许没人守）。加上常量本身与
   `base.css` 注释，这个数一共是**六处**，注释里的处数已改成实测值。变异 **M35**（改规格 §9.1 的
   `.9` → 必须红）证明修好了。
2. **`--app-file` 缺一条覆盖自检（P2）**：`load()` 的兜底按 **basename** 匹配，副本一旦改名，覆盖整条
   不发生、变异被静默忽略——**复审第一轮三个变异全部 `exit=0`、0 条失败**就是这个原因（`--self-test`
   自己踩不到，因为 `mutate()` 保住了文件名）。补了一条自检（`--app-file` 的文件名必须在 `app/` 或
   `styles/` 里找得到同名），并给 `mutate()` 加 `as` 参数把这件事**变成常驻变异 M37**（故意换个仓库里
   没有的名字 → 脚本自己拒绝这次覆盖）。
3. **⑩ 的 §13 表缺唯一性断言（P4）**：`0%` 在清单块里实测出现 **6 次**，删掉「遮罩 0% 时还能看清首页
   大数字」那一条（§13 第 2 条）时它照样命中别处——与 §11 第一版用「深色」栽的是同一个坑。第 2 条的
   关键词换成唯一锚定它的 `0% 这一档要特意看首页大数字`，并补上唯一性断言与变异 **M36**，两张表现在
   形态一致。

**再两条非硬性项**：**P3**——任务 15 那处锚点原先把内层引号写成 `『拍照』`，与清单原文的 `「拍照」`
不同，从计划复制整串去 grep 是 0 命中；已改成与清单**逐字相同**的连续子串，并把 7 处锚点（6 条条目 +
3 个小节名）在清单里各 grep 了一遍：**各命中 1 次**。**P5**——任务 5 的一行 import 在
`app/image-store.js` 与 `app/theme-store.js` 里逐字符相同，任何基于文本的守卫都分辨不出抄的是哪一个
（复审也判「无实质影响」），只做了零成本的那一半：把任务 5 表项的候选文件收窄掉 `app/theme-store.js`
（它后来才有那一行），别让候选集合自己把巧合算成命中。

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
- [ ] **冷启动不闪色**：先换成一套底色反差大的皮肤（暖纸 / 紫藤这类），再硬刷新（Ctrl+Shift+R）或完全退出重开，
      第一眼看到的就是那套皮肤的底色。**对照组分两种**：默认皮肤 **+ 默认深浅**（跟随系统、且系统的深浅与
      兜底那档一致）这一档看不出差别是正常的（闪的就是它自己）；而**默认皮肤 + 手动深色、系统却是浅色**
      这一档照样会闪——兜底帧走 `base.css` 的 `:root`（浅色）、应用后是深色，得单独试一次。
      顺带看一眼**主屏快捷方式**那条路（带 `new=1` 启动）：录入面板的首帧也不该是默认色——那条路不经过
      `render()` 的那次 `await`（见设计规格 §5.4 的边界段），是本条**唯一**可能看到闪色的入口，专门盯它。
      **这条是任务 10 步骤 3 在本机的替代做不了、挂到这里的落地**：那边只能做静态核对，而且只核到「内容挂载
      之前主题已应用」，「第一眼」这三个字只有这里能验；真机上若仍看到一闪的默认灰蓝，记下来并对照任务 10
      步骤 3 那条边界（`base.css` 的 `:root` 兜底那一帧）。（落的是设计规格 §11 验收标准里「冷启动不闪色」
      那一条——它在返工轮被改写成可判的判据；规格 §13 那 7 条手动项里没有它，所以下面那张对照表不动。）
- [ ] 深浅选「跟随系统」，然后改系统的深色开关，app 实时跟着变
- [ ] 深浅选「浅色」，系统切到深色，app **不**跟着变（手动选择必须压过系统）
- [ ] Console 里核对 `document.documentElement.dataset.theme` = 当前皮肤 id（换一套皮肤后立刻变）
- [ ] Console 里核对 `document.documentElement.dataset.mode` = 解析后的 `light` / `dark`（选「跟随系统」时它**不是** `auto`）
- [ ] Console 里核对 `document.documentElement.dataset.photo` 随照片开关在 `on` / `off` 之间变
      （这三条是 `paint()` 那份「整条写出去」合同的唯一兜底，见设计规格 §5.4）
- [ ] （已知项，不是 bug）浏览器 / PWA 里系统栏颜色应跟着皮肤变；**APK 里不会变**——壳的状态栏由
      `themes.xml` 写死，原因与将来怎么改见设计规格 §5.5
- [ ] 五张皮肤卡上的小色块与当前深浅档**无关**：底色是各皮肤浅色档的 `--bg`、圆点是它的 `--accent`
      （`themeChip` 取的就是 `THEME_TOKENS[id].light`）。任意两张卡看起来应当不一样，选中那张有强调色
      描边与淡底色——这条核的是「切换时最先感受到的差异」有没有被如实呈现
- [ ] **全程 Console 不许出现未处理的拒绝**（`Uncaught (in promise)`）：把五套皮肤逐一点一遍、深浅三种
      各切一次、选一张照片、再点「移除」、来回拖几次遮罩——这一串动作做完，Console 里不该冒出未处理的
      拒绝（面板的五个写入口 setPreset / setMode / setPhoto / removePhoto / setOverlay 都接住了 rejection；
      没接住时页面上的表现就是「点了没反应」）

### 背景照片
- [ ] **没有照片时（冷启动的首屏、以及点「移除」之后）整屏只有 `--bg` 的底色**：看不到任何多出来的
      色块、遮罩或黑边（`body::before` 那一层等于不存在）。**这条是任务 9 步骤 3 在本机的替代做不了、
      挂到这里的落地**——那边只能做静态核对，「肉眼」只能在这台真机上补。
- [ ] 从相册选一张**竖拍手机照片（长边远大于 1600）**，确认背景铺满、没有拉伸变形、方向正确，
      **并且压缩后不糊**（背景进库前是长边 1600 的 JPEG）
- [ ] 遮罩 0% / 30% / 60% 各看一眼，确认数字的可读性变化符合直觉（**0% 这一档要特意看首页大数字**）
- [ ] **深色 + 照片 + 遮罩 0%**：卡片上的次要文字（日期、账户名）仍然能读
- [ ] 开启照片后确认**密码箱里的密码正文、账户余额、记账首页的大数字**仍然清晰（这些不该半透明）
- [ ] 点「移除」，确认背景消失且卡片恢复不透明
- [ ] 换一张图，确认旧图没有残留在界面上
- [ ] 老库升级：用 v1.2.0 的数据打开新版本，确认账目 / 发票 / 密码箱一条不少（**这是 assets 表迁移的验证**）
- [ ] 没设照片时面板里**只有**「选择图片」与说明文字（没有遮罩滑块）；设过之后出现**当前背景的缩略图**、
      「换一张」「移除」与遮罩滑块 + 右侧百分比，**且「移除」与「换一张」看得出主次**（前者是
      `btn btn-danger` 的破坏性样式、只有红字没有底，后者是普通 `btn`）
- [ ] 面板**顶部那行小字**写着当前皮肤名（规格 §8 第 4 条），切一套皮肤之后它跟着变
- [ ] 拖动遮罩是**跟手**的（不是松手才变），来回拖几次后停手，**松手时那个值就是最终值**：完全退出 app
      再打开，遮罩仍是它（既不是拖动中间某个值、也不是默认的 30%）。这条同时验节流的两个半边——
      首帧立刻生效、尾部那次补写把停手时的值落了库
- [ ] 拖动遮罩**拖到一半就去点皮肤卡**（同一个面板里）：点完之后滑块上显示的数字、页面上的遮罩、以及
      重启后的值三者一致（都不该回退到拖动中途那个刻度）——这条验的是 `safeRerender` 里的 flush

### 备份
- [ ] 导出含背景的备份，确认体积增幅在预期内（约 +100~400KB）
- [ ] 清掉 assets 表后导入该备份，确认背景回来了、**且遮罩强度与导出前一致**；「清掉再导入」这一步
      同时证明**恢复的是备份里那张图**，不是这台设备上的残留（换一台设备恢复时同理）
- [ ] 导入一份**没有背景**的老备份，确认 app 不报错、背景按「没有」处理
- [ ] 导出时勾「不含图片」→ 导出的备份里**仍然带背景**（外观设置不受那个开关影响）；导入后背景还在
- [ ] **导入一份没有背景的备份到一台有背景的手机上**：背景**与它的设置行**一起消失（`assets` 里不再有
      `bg`），不留悬空设置；若在 DevTools 里往 `assets` 加过第二条记录，那条**必须还在**
      （导入侧按主键删，不是整表清空）
- [ ] 导出结果里若出现「本机那张背景照片没能写进这份备份」一行，说明那次导出没带上背景
      （`backgroundSkipped` 通道；正常情况下不该出现）
- [ ] **注**：上面「不含图片仍带背景」「导入没有背景的备份到有背景的手机」「导出结果里的
      `backgroundSkipped` 警示」这三条，**任务 13 已经落进 `docs/手动验证清单.md` 的
      「## 备份与恢复」小节末尾**（连同「加表 / 加字段相关的回归」那一节的反方向条目）。
      这一步落地时**择一保留、别在清单里写两遍**。

### 离线与缓存
- [ ] **升版之后离线仍能用**：先起本地服务打开一次（让 SW 装上），再断网刷新——页面正常打开、账目都在。
      然后在 DevTools → Application → Cache Storage 里确认 `pvault-v18` 在、旧版本（`pvault-v15` 之类）
      已经不在（`activate` 会删掉所有不等于 `CACHE` 的缓存）。**白屏时先分辨是哪条路**：`pvault-v18`
      不存在 → `cache.addAll` 被清单里某个 404 整批拒绝了（install 失败、SW 根本没激活）；它在、页面仍是
      白底 → 去看 Console 里那条模块请求，离线回退到 `index.html` 时模块脚本会被 MIME 检查拒绝，
      import 链一断整页只剩底色（两条路的机制都写在 `sw.js` 开头那段，**别混成一句「离线坏了」**）。
      **这条是任务 14 步骤 3 在本机的替代做不了、挂到这里的落地**：那边只能做静态核对（`ASSETS` 逐条
      存在、`install` / `activate` / `fetch` 三条路径读一遍、`CACHE` 单处声明），「断网刷新」这四个字
      只有这里能验。（它既不在设计规格 §13 那 7 条手动项里，也不在 §11 的验收标准里——两张单子都不动。）
```

**上面的清单与设计规格 §13 的 7 条要逐条对齐**（规格那 7 条是「跑不了自动化的部分」的完整清单，
漏一条就等于某个风险没人验）。对照表如下，**任何一边增删条目时这张表一起改**：

| 规格 §13 | 本清单里的落点（**子节名一并写出**，因为同一段里有多个编号；条目按所在子节的顺序数） |
|---|---|
| 竖拍手机照片、确认压缩后不糊 | 「背景照片」第 2 条 |
| 遮罩 0% 时还能看清首页大数字 | 「背景照片」第 3 条（0% / 30% / 60% 各看一眼里头） |
| 深色 + 照片 + 遮罩 0%、卡片次要文字仍可读 | 「背景照片」第 4 条（**本轮补的**，原来没有等价条目） |
| 密码正文 / 余额等关键读数仍不透明、清晰 | 「背景照片」第 5 条 |
| 老库（v1.2.0）升级后数据一条不少 | 「背景照片」第 8 条 |
| 备份体积增幅在预期内 | 「备份」第 1 条 |
| 恢复后背景还在、且是备份里那张图 | 「备份」第 2 条（**本轮把「是备份里那张图」这层补进同一条**） |

**任务 11 追加的这几条不是 §13 缺项，别写进这张表**（§13 那 7 条是规格定死的手动项；这些来自任务 11
的面板与错误路径）。它们**追加在各自小节的末尾**——理由是这张表按「子节内顺序数」定位，而**它那 7 条的
落点全在「背景照片」与「备份」两节里**（关键词是竖拍 / 0% / 深色 + 照片 + 遮罩 0% / 密码正文 / v1.2.0 /
体积增幅 / 备份里那张图，**一条都不在「皮肤与深浅」**）：往「背景照片」小节**中间插**会让表里那 5 个编号
整体错位，往「皮肤与深浅」小节里插则不影响那张表。**一律追加到末尾**是按最严的那一半定的规矩，不是
「两节都会错位」。这些条目覆盖：皮肤卡的预览色块（`themeChip` 恒取浅色档）、面板在两个状态下的控件集合
（含缩略图与顶部那行皮肤名小字）、以及任务 11 新加的三条（未处理的拒绝、遮罩节流的两半、拖动中的重绘）。

**任务 12 那两条（入口位置、换层不叠层）已经提前落进 `docs/手动验证清单.md`**——落点在**「账户与分类管理」
小节的末尾**（那两条本身就是「设置面板里有哪几行、点开会不会叠层」，与已经在那里的「首页月份行右侧有齿轮
按钮」「设置面板里能进入『账户管理』『分类管理』」「从子面板返回设置面板…页面能正常滚动」是同一条线；且
那时清单里还没有「外观与背景」章节，写进那里会立刻造出第二个同名小节）。所以本步执行时**不要重复添加**
这两条，照上面那段代码块覆盖一遍即可；它们不是 §13 缺项，不进上面那张表（同一条理由）。

**「已提前落盘」的那两条怎么找**（给一个能 grep 的唯一锚点，别再靠「某小节末尾」这种会飘的描述）：
它们分别含有这两句原文，在仓库里各只有一处：
· `第三行是「预算设置」、**第四行是「外观与背景」**、第五行是「备份与恢复」`
· `点「外观与背景」之后：设置面板先关闭、外观面板随后滑出，**两层不会同时挂着**`
（核验：`Select-String -Path docs\手动验证清单.md -Pattern '第四行是「外观与背景」','两层不会同时挂着'`
两串各命中 1 处。**任务 15 执行时**若又写出等价条目，先按这两句去重，别把同一件事写成两条。）

- [ ] **步骤 2：全量回归**

运行：`D:\node.exe --test --test-isolation=none`

预期：全部 PASS，0 fail。**总数必须大于 247**（新增了 theme 与 schema 的测试）。

- [ ] **步骤 3：模拟器上跑一遍**

模拟器与 CDP 的用法见 `docs/手动验证清单.md` 的「模拟器实测记录」一节。至少覆盖：

1. 五套皮肤 × 深/浅逐个切换并截图
2. 用 CDP 往页面里注入一个 `File`（走 `DataTransfer`，系统选择器驱动不了）验证背景照片全流程
3. 备份往返（导出 → 清 assets → 导入）
4. 从 v1.2.0 的库升级到 v3（把旧库的 IndexedDB 目录保留、换新代码打开）
5. **发票路径回归**（任务 5 把图片编解码工具搬进 `canvas-image.js` 后，它那四步回归的落点只有这里）：按
   `docs/手动验证清单.md` 的「发票」章节走一遍——竖拍原图的 **EXIF 方向**（「### 图片：压缩与方向」小节
   第 1 条「用一张**手机竖着拍**的发票原图（EXIF 带方向那种）」；两条入口各来一次是同一个小组的第 2 条，
   它那一句的原文（与清单**逐字相同**，整串拿去 grep 应当命中 1 次）是
   同一个文件分别走「拍照」与「选图片 / PDF / OFD」两条入口各来一次；
   再往下列表里的缩略图方向（同小组的
   「列表里的缩略图方向也是正的」一条）、PNG / HEIC 被重编码后扩展名跟着变（「### OFD 文件」小节里
   「从相册选一张 **PNG / HEIC 照片**」那一条）、再选一个 PDF 走一遍（「### 入口与新建」小节里
   「选一个 **PDF** 后预览区显示的名字」那一条连同它下面那条占位说明，加上「### OFD 文件」小节里
   「老票（OFD 功能之前存的 PDF）」那一条）；四步里「保存后重新打开还在」在清单里没有对应条目，
   按「### 入口与新建」小节的动作走到列表后再点开一次。
   **这一条一律用小节名 + 条目关键词定位，不写行号**：这份清单每完成一个任务就被追加一次（任务 11 /
   12 / 13 都追加过），原先那一组行号到这一步**已经全部飘掉**（实测：`619–623` 现在落在「解析能力的
   已知边界」那个小组里，而它指的是发票的 EXIF 方向；`641–645` 落在「`imageOrientation: 'from-image'`」
   那一段，指的是 PDF 预览与占位）——照着行号核对会撞到别的内容，而它看起来「有个精确的落点」。
6. **离线与缓存**：按清单里「### 离线与缓存」那一节走一遍（起本地服务让 SW 装上一次 → 断网刷新 →
   在 Cache Storage 里确认 `pvault-v18` 在、旧版本已删）。**任务 14 步骤 3 在本机做不了**（没有可用
   浏览器），那边只做了静态核对，真机 / 模拟器这一遍是它的落地。

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
| §5.5 系统栏颜色（PWA 跟随 / APK 不跟随） | 任务 7（`index.html` 的 meta 与 `paint()`）、任务 15（已知项核对） |
| §6.1 存储与压缩 | 任务 5、8 |
| §6.2 渲染（`body::before`） | 任务 9 |
| §6.3 可读性（`--surface` 半透明、`--surface-2` 不变） | 任务 4、9 |
| §7 备份与恢复 | 任务 13 |
| §8 UI | 任务 11、12 |
| §9 测试 | 任务 1–4、6、13、15 |
| §10 接缝清单 | 任务 5、6、13、14；`build-apk.ps1` 不用改（整目录复制） |
| §11 验收标准 | 任务 1–4（对比度与变量测试）、任务 7–10（应用与首屏）、任务 13（备份往返）；7 条的人工落点在任务 15，由核验脚本的 ⑩ 第二张关键词表逐条钉住 |
| §13 手动验证清单 | 任务 15 |

**占位符扫描**：无「待定 / TODO / 后续实现」；每个代码步骤都给了可直接粘贴的代码。

**类型与命名一致性**（跨任务核对）

- `BACKGROUND_ASSET_ID`：任务 7 定义并导出，任务 13 的 `backup-store.js` 里**再定义一次**（模块之间不共享常量是有意的——`backup-store.js` 不该 import 一个依赖 DOM 的模块；两处都用 `'bg'` 这个字面量，任务 13 的注释里写明了它是同一把钥匙）。
- `encodeBackground`：**两个模块各有一个同名函数，语义不同，不要互相 import 也不要互相参照**——`theme-store.js`（任务 8）那个收一个 `File`、把用户选的照片压成 JPEG 再写进 `assets`；`backup-store.js`（任务 13）那个收 `settings` 数组、把库里那张图转成 base64 塞进备份包。名字撞车是因为两处都是「背景图编码」，签名与职责是正交的；要改其中一处时先看清是哪一个（`backup-store.js` 里那份的 JSDoc 写明了它的失败语义与降级）。
- `normalizeOverlay`：任务 3 定义，任务 8 的 `setOverlay()` 使用（任务 8 步骤 1 特别提醒把它补进 import 清单）。
- `setPhoto` / `removePhoto` / `setOverlay` / `setPreset` / `setMode` / `currentTheme`：任务 7–8 导出，任务 11 的面板按这套名字 import。
- `themeCssVars(themeId, mode, { photo })`：任务 4 定义，任务 7 的 `paint()` 调用。
- `decode` / `drawTo` / `releaseSource`：任务 5 从 `canvas-image.js` 导出，任务 8 的 `encodeBackground()` 使用。
- `mount`：任务 11 从 `./dom.js` import（`dom.js` 确实导出 `mount`）。
