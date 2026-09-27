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
`styles/base.css` 的 commit 单独看时，本计划里两个代码块分别失配 35/35 行与 22/25 行，要等到同一
任务的文档同步 commit 才补上。所以在这里写成成文条款：

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
| `sw.js` | `ASSETS` 加 5 个新文件（`canvas-image.js` 在任务 5、`theme-store.js` 在任务 10 提前加，其余 3 个在任务 14）；`CACHE` 依次升到 `pvault-v17`（任务 10）与 `pvault-v18`（任务 14），任务 5 已用到 v16。 |
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

**下面三处原文没写、但漏了就直接坏（或让旁边的注释变成假话），执行时补上：**

1. `canvas-image.js` 里要加 `import { computeTargetSize } from './image-scale.js';`——`drawTo` 用它，
   原来靠 `image-store.js` 那份 import 供着，搬走就断了。漏掉的后果是浏览器里的 `ReferenceError`，
   而这两个文件都在 Node 测试范围之外，全量测试不会报出来。
2. `image-store.js` 侧要从 `image-scale.js` 的 import 清单里删掉 `computeTargetSize`——它随 `drawTo`
   一起搬走了，留在这边已经没人用。
3. 这次搬移会让两处**既有**注释变成假话，要一并改掉（前四个任务被打回的正是这一类）：`app/image-scale.js`
   第 2 行「真正的 Canvas 压缩在 image-store.js 里」改成 `canvas-image.js`；`app/file-info.js` 第 4 行
   「那个文件依赖 Canvas / Blob / indexedDB」改成「那个文件（以及它 import 的 canvas-image.js）依赖
   Canvas / Blob / indexedDB」——Canvas 依赖现在是间接的，而那句的论证（在 Node 里 import 不了）靠的是
   indexedDB / Blob，仍然成立。

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
canvas-image` 这一环：那一个 module 404、import 链一断是**整个 app 白屏**（不只是发票面板）。这与 v14 那次
（`file-info.js`）是同一条规矩：**白名单必须跟产生依赖的那次提交一起走，不能等到收尾再补**。具体改法：
`ASSETS` 加 `'./app/canvas-image.js'`（排在 `budget.js` 与 `chart.js` 之间，保持 ASC 书写风格）、`CACHE`
升到 `'pvault-v16'` 并写下这一版的说明。外观功能其余四个文件（theme / theme-store / ui/appearance-sheet /
appearance.css）此刻还不存在：`theme-store.js` 由任务 10 进清单（那一步让 `main.js` 静态依赖它），其余三个仍由
任务 14 负责。

**白名单要全量校验一遍**（`cache.addAll` 是原子的，一个 404 就让整次 install 失败，表现是"离线打开白屏"）：
把 `sw.js` 里所有 `'./…'` 路径抽出来逐个 `Test-Path`。任务 14 步骤 2 里有现成脚本，这里跑完的实测结果是
**`全部存在，共 56 个`**（`ASSETS` 里是 57 个条目，其中 `'./'` 不匹配那条正则、脚本不数它）。

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
         一起没。所以「JS 还没跑完那一帧」「applyPhoto 在写变量之前就抛错（库里那张图读不
         出来）」「JS 主动写 none」这三种状态渲染完全相同。兜底值必须让这一层等于不存在：
         这里若写成一个真遮罩或真色块，那一帧就会看到一整块遮罩盖住整个 app。
       · --scrim-rgb / --scrim-a 在 CSS 里**没有第二个消费点**（消费它们的是 JS 写进 inline
         style 的那条表达式，theme-store.js 的 setPhotoVars；styles/ 与 app/ 里再无第二处
         var(--scrim-rgb) / var(--scrim-a)，规格与计划文档里的同名文本不是消费点）。
         --bg-scrim 的兜底是字面量 none，不引用它们，所以它们在这一帧同样没有可见效果。
         它们唯一可能生效的情形是「这个键从头到尾没被 inline 写过、而 --bg-scrim 那条表达式
         已经写进 DOM 了」：--scrim-a 连这条都没有——要写下那条表达式，setPhotoVars 里两行
         setProperty 就会一起跑完（自定义属性的值不做校验，这两行之间不会抛），它留在这里的
         作用只是把 OVERLAY_DEFAULT 这个默认值在 CSS 里有一份。--scrim-rgb 要走这条，前提是
         这个键从头到尾没被写过，而 paint() 那条路本来一定会写它（initTheme 里那次是
         photo=false，themeCssVars 连 hexToRgb 都不会调用），所以只剩两种可能：paint() 的
         循环漏掉它（那份「整条写出去」的合同被改坏了），或者 initTheme 在 paint() 之前就
         失败、此后那次 paint() 抛错——它唯一的 throw 是 theme.js 的 hexToRgb，要色板违反
         HEX6 才触发（规格 §5.4 把这个记成已知项）。真走到那里时：没有兜底是整条
         background-image 失效（照片与遮罩一起没），有兜底至少留下一层浅色遮罩。
     四条都救不了「写过之后再漏写」的残留：inline 值优先于样式表里的 :root，真漏写时 DOM 上
     留着的是上一次写进去的旧值（--scrim-rgb 就是深色那套的 '0,0,0'）——这正是 paint() 注释
     里那句合同的原意，与这里给不给兜底无关。
     显式写出 none 而不是干脆不写，还挡住一种将来的半套写法：只写 --bg-scrim（不写
     --bg-image）时，没有兜底是整层失效、有兜底则会在空背景上单独冒出一层遮罩。
     写法与 JS 对齐，免得同一份真相在仓库里出现两种写法：--scrim-rgb 不带空格（JS 色板里
     就是 '255,255,255'，tests/theme.test.js 的 SHAPES 把它钉成 /^\d{1,3},\d{1,3},\d{1,3}$/）、
     --scrim-a 带前导 0（scrimAlpha(OVERLAY_DEFAULT) 的结果是 '0.3'，JS 那边 String() 不会
     写出 '.3'）。
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
     照片」，改成写清前提（`initTheme` 在 `paint()` 之前就失败、且此后那次 `paint()` 抛错），并
     说明它唯一的 `throw` 是 `theme.js` 的 `hexToRgb`（要色板违反 HEX6 才触发，规格 §5.4 记成
     已知项）、而 `initTheme` 里那次 `paint()` 是 `photo=false`、不会调用 `hexToRgb`。
4. **四行统一成一种性质**（同一次返工）：`--bg-image` / `--bg-scrim` 两行同样**没有可见的渲染
   差异**（与「两个都没写过」等价），所以四条一律写成「自文档化 + 防御将来的改动」，不再只把
   `--scrim-rgb` / `--scrim-a` 叫「防御性」。

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
——命中测试按绘制层序自上而下，位于所有内容之下的层不可能截走内容区域的点击；内容没覆盖到的位置，
命中的目标也是宿主 `body`（与不画这一层时相同）。结论不变（该写 `pointer-events: none`），理由改成
「不依赖『内容正好铺满视口』这个布局前提 + 让『这层不接收交互』在样式里自明」。改的是因果，不是结论。

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

这四条里，**能静态核对的那些说法**由任务 9 的静态核对脚本覆盖：`var(…)` 两个方向的交叉比对、
兜底值 ⇄ JS 输出的逐字符比对、规格 §6.2 ⇄ 实现的逐属性比对、本计划两个代码块 ⇄ `base.css` 的
逐字符比对。**那个脚本是仓库外的一次性脚本**（不在 `tests/` 也不在 `scripts/`；`38d9f7c` 只提交了
`styles/base.css` 一个文件），重跑方式与全部结论见那个 commit 的 message；任务 14 会把它收进
`scripts/`，变成后来人能重跑的守卫（见那一步的步骤 5）。

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
- 修改：`app/main.js`
- 修改：`sw.js`（步骤 4：`theme-store.js` 进预缓存白名单、缓存版本升到 `pvault-v17`）

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

- [ ] **步骤 4：`theme-store.js` 进预缓存白名单（顺带把新的 `schema.js` 铺到设备上）**

**为什么必须跟这一步一起走**：本步让 `main.js` 静态 `import` 了 `theme-store.js`（步骤 1），与任务 5 让
`image-store.js` 依赖 `canvas-image.js` 是**同一条纪律**——白名单必须跟产生依赖的那次提交一起走，不能等到任务 14
收尾再补。`cache.addAll` 是原子的：清单里漏了它，已装旧缓存的设备离线启动就断在 `main → theme-store` 这一环，
一个 module 404、import 链一断就是整个 app 白屏。

**顺带效果才是它非做不可的原因**：`CACHE` 一变，已装旧缓存的设备会重新 `install`（`addAll` 把清单重新抓一遍
全量）、`activate` 时删掉旧缓存，再加上 `skipWaiting` 与 `clients.claim`，设备下一次冷启动拿到的就是新缓存里的
`schema.js`——**任务 6 已把它升到 `DB_VERSION = 3`，不做这一步，那次数据库升级永远不会发生**：SW 是缓存优先，
设备一直命中缓存里的旧 `schema.js`（`DB_VERSION = 2`），`assets` 表建不出来，背景图一存就抛错。

改法：`CACHE` 从 `'pvault-v16'` 升到 `'pvault-v17'`，`ASSETS` 里加一条（保持 ASC 书写风格，插在
`'./app/summary.js'` 与 `'./app/vault-model.js'` 之间）：

```js
  './app/theme-store.js',
```

`theme-store.js` 是任务 7 建好的，跑这一步时**必须已在磁盘上**——一个 404 会让整次 install 失败。

再跑一遍白名单全量校验（脚本在任务 14 步骤 2）：

预期：`全部存在，共 57 个`（任务 5 之后是 56 个；本步加的那条就是 `app/theme-store.js`。这个数在 `sw.js` 副本
上实测过：当前 56 条加本步 1 条，再加任务 14 的 3 条，正好是那一步预期的 60 条）

- [ ] **步骤 5：Commit**

```bash
git add app/main.js
git commit -m 'feat(theme): 首屏渲染前应用外观设置，避免闪色'
git add sw.js
git commit -m 'chore(sw): theme-store.js 提前进预缓存白名单，缓存版本升到 v17'
```

**两个 commit 分开**：白名单要跟产生依赖的那次提交一起走，与任务 5 的两个 commit 是同一个道理。

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

**`canvas-image.js` 已在任务 5、`theme-store.js` 已在任务 10 提前进清单**（那两步分别让 `image-store.js` 与
`main.js` 静态依赖了它们，白名单必须跟产生依赖的提交一起走），`CACHE` 那时已经用到 `pvault-v17`。所以这一步只加
剩下的这三个文件，版本号再升一版：

```js
const CACHE = 'pvault-v18';
```

在 `ASSETS` 数组里加（位置与其它条目保持一致的书写风格：`'./app/theme.js'` 按 ASC 排在任务 10 已加的
`'./app/theme-store.js'` **之后**——`'-'`(0x2D) 小于 `'.'`(0x2E)；`'./app/ui/appearance-sheet.js'` 排在
`'./app/ui/accounts-view.js'` **之前**；`'./styles/appearance.css'` 排在 styles 段的**最前**——
`appearance.css` < `base.css`）：

```js
  './app/theme.js',
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

预期：`全部存在，共 60 个`（61 个条目里 `'./'` 不匹配这条正则、脚本不数它；任务 5 之后跑是 56 个、任务 10 之后是 57 个）

- [ ] **步骤 3：验证离线可用**

1. 起本地服务，打开一次（让 SW 装上）
2. DevTools → Application → Service Workers 勾 Offline
3. 刷新页面

预期：页面正常打开、账目都在。**如果白屏**，看 Application → Cache Storage 里 `pvault-v18` 是否存在——不存在就是 `addAll` 被某个 404 整批拒绝了。

- [ ] **步骤 5：把任务 9 的静态核对脚本收进 `scripts/`（让它变成能重跑的守卫）**

任务 9 交付时那些核验是**仓库外的一次性脚本**（`38d9f7c` 只提交了 `styles/base.css` 一个文件）；
计划里「逐字符一致」与「默认状态不变」两处守卫都指着它，而后来人重跑不了。这一步把它落进仓库：

```powershell
# 搬进来时一并改三件事：
#   1) 路径参数的默认值指向仓库根（用 import.meta.dirname 往上找一层，别写死绝对路径）
#   2) 读文件一律按 \n 归一化后再比对——工作区行尾是混杂的，见本计划开头「代码块与仓库的镜像纪律」第 3 条
#   3) 变异验证那部分（mutate-and-verify）并进同一个脚本的 --self-test 模式，
#      别让仓库里躺两个临时脚本
Copy-Item <任务 9 的会话临时目录>\check-bg-vars.mjs scripts\check-theme-css.mjs
```

**新文件不必进 `sw.js` 的 `ASSETS` 白名单**，也不需要 `build-apk.ps1` 改复制清单。这两条**别照抄，
自己核对一遍**（现状实测：`ASSETS` 里 57 条中 `./scripts/…` 是 0 条；`build-apk.ps1` 只复制
`index.html` / `manifest.webmanifest` / `sw.js` 与 `app` / `styles` / `icons` 三个目录）：

```powershell
(Select-String -Path sw.js -Pattern "'\./scripts/" | Measure-Object).Count    # 预期 0
Select-String -Path scripts\build-apk.ps1 -Pattern 'foreach \(\$d in'          # 预期只有一处，值含 app styles icons
```

搬进来之后再跑一遍脚本本身，确认它在新位置上仍然全绿：

```powershell
D:\node.exe scripts\check-theme-css.mjs
```

预期：全部通过（任务 9 交付时是 **46 项检查 + 10 个变异全被抓**；搬进仓库时若又长了几项，以脚本
自己的输出为准）。这一步的产物同时也是**给后来人的守卫**：改了 `base.css` 的背景层或兜底值，跑它
就知道计划里的代码块有没有跟着漂。

- [ ] **步骤 6：Commit**

```bash
git add sw.js
git commit -m 'chore(sw): 新模块进预缓存白名单，缓存版本升到 v18'
git add scripts/check-theme-css.mjs
git commit -m 'chore(scripts): 把外观 CSS 的静态核对脚本收进仓库'
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
- [ ] Console 里核对 `document.documentElement.dataset.theme` = 当前皮肤 id（换一套皮肤后立刻变）
- [ ] Console 里核对 `document.documentElement.dataset.mode` = 解析后的 `light` / `dark`（选「跟随系统」时它**不是** `auto`）
- [ ] Console 里核对 `document.documentElement.dataset.photo` 随照片开关在 `on` / `off` 之间变
      （这三条是 `paint()` 那份「整条写出去」合同的唯一兜底，见设计规格 §5.4）
- [ ] （已知项，不是 bug）浏览器 / PWA 里系统栏颜色应跟着皮肤变；**APK 里不会变**——壳的状态栏由
      `themes.xml` 写死，原因与将来怎么改见设计规格 §5.5

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

### 备份
- [ ] 导出含背景的备份，确认体积增幅在预期内（约 +100~400KB）
- [ ] 清掉 assets 表后导入该备份，确认背景回来了、**且遮罩强度与导出前一致**；「清掉再导入」这一步
      同时证明**恢复的是备份里那张图**，不是这台设备上的残留（换一台设备恢复时同理）
- [ ] 导入一份**没有背景**的老备份，确认 app 不报错、背景按「没有」处理
```

**上面的清单与设计规格 §13 的 7 条要逐条对齐**（规格那 7 条是「跑不了自动化的部分」的完整清单，
漏一条就等于某个风险没人验）。对照表如下，**任何一边增删条目时这张表一起改**：

| 规格 §13 | 本清单里的落点 |
|---|---|
| 竖拍手机照片、确认压缩后不糊 | 「背景照片」第 2 条 |
| 遮罩 0% 时还能看清首页大数字 | 第 3 条（0% / 30% / 60% 各看一眼里头） |
| 深色 + 照片 + 遮罩 0%、卡片次要文字仍可读 | 第 4 条（**本轮补的**，原来没有等价条目） |
| 密码正文 / 余额等关键读数仍不透明、清晰 | 第 5 条 |
| 老库（v1.2.0）升级后数据一条不少 | 第 8 条 |
| 备份体积增幅在预期内 | 「备份」第 1 条 |
| 恢复后背景还在、且是备份里那张图 | 「备份」第 2 条（**本轮把「是备份里那张图」这层补进同一条**） |

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
   `docs/手动验证清单.md` 的「发票」章节走一遍——竖拍原图的 **EXIF 方向**（619–623 那条躺倒的坑、
   722–724 两个入口方向）、列表里的缩略图方向（730）、PNG / HEIC 被重编码后扩展名跟着变（666）、
   再选一个 PDF 走一遍（641–645 的预览与占位、661 的老票导出名）；四步里「保存后重新打开还在」在清单里
   没有对应条目，按「入口与新建」（629 起）那一节的动作走到列表后再点开一次。

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
| §13 手动验证清单 | 任务 15 |

**占位符扫描**：无「待定 / TODO / 后续实现」；每个代码步骤都给了可直接粘贴的代码。

**类型与命名一致性**（跨任务核对）

- `BACKGROUND_ASSET_ID`：任务 7 定义并导出，任务 13 的 `backup-store.js` 里**再定义一次**（模块之间不共享常量是有意的——`backup-store.js` 不该 import 一个依赖 DOM 的模块；两处都用 `'bg'` 这个字面量，任务 13 的注释里写明了它是同一把钥匙）。
- `normalizeOverlay`：任务 3 定义，任务 8 的 `setOverlay()` 使用（任务 8 步骤 1 特别提醒把它补进 import 清单）。
- `setPhoto` / `removePhoto` / `setOverlay` / `setPreset` / `setMode` / `currentTheme`：任务 7–8 导出，任务 11 的面板按这套名字 import。
- `themeCssVars(themeId, mode, { photo })`：任务 4 定义，任务 7 的 `paint()` 调用。
- `decode` / `drawTo` / `releaseSource`：任务 5 从 `canvas-image.js` 导出，任务 8 的 `encodeBackground()` 使用。
- `mount`：任务 11 从 `./dom.js` import（`dom.js` 确实导出 `mount`）。
