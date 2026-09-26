# pvault · OFD 导入 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 发票的文件区多认一种格式 OFD——原样存下来、记住原始文件名、需要时能导出到手机用别的 App 打开。

**架构：** 纯逻辑（类型判定、文件名处理）落在新的纯模块 `app/file-info.js`，可以在 Node 里直接单测；浏览器编排（读文件、落库）留在 `app/image-store.js`；下载触发从 `app/ui/backup-view.js` 抽到共用的 `app/ui/download.js`；界面改动集中在 `app/ui/invoice-editor.js`。

**技术栈：** 原生 ES Modules、零依赖（无 `node_modules`）、IndexedDB、`node:test`、Service Worker 预缓存。

**规格：** `docs/superpowers/specs/2026-09-26-pvault-ofd-import-design.md`

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `app/file-info.js` | 文件类型判定、mime 归一化、文件名净化与兜底名、单文件上限常量。纯函数，不碰 DOM / indexedDB | 创建 |
| `app/ui/download.js` | 触发一次浏览器下载（Blob → 文件）。只做这一件事 | 创建 |
| `tests/file-info.test.js` | `file-info.js` 的单测 | 创建 |
| `app/image-store.js` | 增：认 OFD；把原始文件名一并落库。删：私有的 `isPdf()` | 修改 |
| `app/ui/backup-view.js` | 改用共用的 `downloadBlob()` | 修改 |
| `app/ui/invoice-editor.js` | 选择器 accept 与按钮文案、20 MB 拦截、预览占位、导出按钮 | 修改 |
| `app/ui/invoice-view.js` | 列表占位块补无障碍文案 | 修改 |
| `sw.js` | 任务 3：`CACHE` 提到 v14、白名单加 `file-info.js`；任务 9：提到 v15、白名单加 `ui/download.js` | 修改 |
| `docs/手动验证清单.md` | 补 OFD 一节 | 修改 |

**为什么把纯函数单独建文件**：`app/image-store.js` 顶部第一行注释写着「依赖 Canvas / Blob / indexedDB，**不能在 Node 里 import**」。判定表放在那里就等于放弃单测——而「mime 与扩展名哪个优先」恰恰是这次最容易写错、也最该有测试钉死的地方。

---

### 任务 1：文件类型判定（`app/file-info.js`）

**文件：**
- 创建：`app/file-info.js`
- 创建：`tests/file-info.test.js`

- [ ] **步骤 1：编写失败的测试**

创建 `tests/file-info.test.js`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_FILE_BYTES, fileKind, mimeForKind, extForKind
} from '../app/file-info.js';

test('fileKind：mime 说是 OFD 就判 OFD', () => {
  assert.equal(fileKind('application/ofd', ''), 'ofd');
  assert.equal(fileKind('application/OFD', 'x.bin'), 'ofd');
});

test('fileKind：mime 说是 PDF 就判 PDF', () => {
  assert.equal(fileKind('application/pdf', ''), 'pdf');
  assert.equal(fileKind('application/pdf; charset=binary', 'x'), 'pdf');
});

test('fileKind：mime 空或没说什么时由扩展名接管', () => {
  assert.equal(fileKind('', 'a.ofd'), 'ofd');
  assert.equal(fileKind('', 'a.PDF'), 'pdf');
  assert.equal(fileKind('application/octet-stream', 'b.OFD'), 'ofd');
});

test('fileKind：mime 与扩展名打架时以 mime 为准', () => {
  assert.equal(fileKind('application/pdf', 'c.ofd'), 'pdf');
  assert.equal(fileKind('application/ofd', 'c.pdf'), 'ofd');
});

test('fileKind：其余一律当图片', () => {
  assert.equal(fileKind('image/jpeg', 'd.jpg'), 'image');
  assert.equal(fileKind('', ''), 'image');
  assert.equal(fileKind(null, null), 'image');
  assert.equal(fileKind(undefined, undefined), 'image');
});

test('mimeForKind：存库前归一化', () => {
  assert.equal(mimeForKind('ofd', 'application/octet-stream'), 'application/ofd');
  assert.equal(mimeForKind('pdf', ''), 'application/pdf');
  assert.equal(mimeForKind('image', 'image/png'), 'image/png');
  assert.equal(mimeForKind('image', 'image/png; charset=binary'), 'image/png');
  assert.equal(mimeForKind('image', 'IMAGE/PNG'), 'image/png');
  assert.equal(mimeForKind('image', ''), 'image/jpeg');
});

test('mimeForKind：非空却不是 image/* 的，回落中性值而不是伪造 image/jpeg', () => {
  // 伪造 image/jpeg 会骗过 invoice-editor 那道 startsWith('image/') 守卫，
  // 把一个塞不进 <img> 的文件当成图片、显示成裂图。
  assert.equal(mimeForKind('image', 'application/octet-stream'), 'application/octet-stream');
  assert.equal(mimeForKind('', 'application/octet-stream'), 'application/octet-stream');
  assert.equal(
    mimeForKind('image', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    'application/octet-stream'
  );
});

test('extForKind：ofd / pdf 只看 kind', () => {
  assert.equal(extForKind('ofd', 'application/pdf'), 'ofd');
  assert.equal(extForKind('pdf', 'application/octet-stream'), 'pdf');
});

test('extForKind：图片按真实子类型给扩展名', () => {
  // 库里的 PNG 记录不算罕见：prepareFile 有两条路径会把原始 mime 原样存下来
  // （图片够小、不需要压缩；或压缩失败回退了原图），而兜底名恰恰只在「没有原始文件名」
  // 时才用。一律叫 .jpg 会让手机按 .jpg 去派发一个 PNG 文件。
  assert.equal(extForKind('image', 'image/png'), 'png');
  assert.equal(extForKind('image', 'image/webp'), 'webp');
  assert.equal(extForKind('image', 'image/jpeg'), 'jpg');
  assert.equal(extForKind('image', 'image/jpg'), 'jpg');
  assert.equal(extForKind('image', 'image/gif'), 'gif');
  assert.equal(extForKind('image', 'image/png; charset=binary'), 'png');
  assert.equal(extForKind('image', 'IMAGE/PNG'), 'png');
  assert.equal(extForKind('image', ''), 'jpg');
  assert.equal(extForKind('image', null), 'jpg');
  // 带 `+` 的 subtype，以及被塞进来的路径片段，都不该变成扩展名
  assert.equal(extForKind('image', 'image/svg+xml'), 'jpg');
  assert.equal(extForKind('image', 'image/../../etc'), 'jpg');
});

test('三个 kind 各自都有确定的 mime 与扩展名', () => {
  assert.equal(mimeForKind('image', ''), 'image/jpeg');
  assert.equal(mimeForKind('pdf', ''), 'application/pdf');
  assert.equal(mimeForKind('ofd', ''), 'application/ofd');
  assert.equal(extForKind('image', ''), 'jpg');
  assert.equal(extForKind('pdf', ''), 'pdf');
  assert.equal(extForKind('ofd', ''), 'ofd');
});

test('同一条记录走完三个函数，口径一致', () => {
  // 三个函数各自被测得很好，但审查发现的问题全长在「函数之间的缝」上：
  // 把真实输入串成一条，能挡住 kind / mime / 扩展名三者互相矛盾。
  for (const [mime, name, kind, stored, ext] of [
    ['image/png; charset=binary', 'a.png', 'image', 'image/png', 'png'],
    ['application/pdf', 'b.pdf', 'pdf', 'application/pdf', 'pdf'],
    ['application/octet-stream', 'c.ofd', 'ofd', 'application/ofd', 'ofd']
  ]) {
    assert.equal(fileKind(mime, name), kind, `${name} 应判成 ${kind}`);
    assert.equal(mimeForKind(kind, mime), stored, `${name} 存库 mime 应为 ${stored}`);
    assert.equal(extForKind(kind, mime), ext, `${name} 导出扩展名应为 ${ext}`);
  }
});

test('MAX_FILE_BYTES 是 20 MB', () => {
  assert.equal(MAX_FILE_BYTES, 20 * 1024 * 1024);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`D:\node.exe --test --test-isolation=none tests/file-info.test.js`

预期：FAIL —— `ERR_MODULE_NOT_FOUND`，提示找不到 `.../app/file-info.js`（文件还不存在）。

（`--test-isolation=none` 是必须的，bare `node --test` 在这个环境里会撞 EPERM。）

- [ ] **步骤 3：实现 `fileKind` / `mimeForKind` / `extForKind` / `MAX_FILE_BYTES`**

创建 `app/file-info.js`：

```js
// 发票文件的类型判定与命名：纯函数 + 常量。
// 不碰 DOM / indexedDB / Canvas，因此可以在 Node 里直接 import 并单测（见 tests/file-info.test.js）。
//
// 为什么不放进 image-store.js：那个文件依赖 Canvas / Blob / indexedDB，
// 在 Node 里 import 不了，判定表就只能经由 prepareFile 去间接猜。

/**
 * 单个发票文件的字节上限。全电票的 OFD 通常一两百 KB，20 MB 已经大到不像发票了。
 * 这个上限唯一的目的是拦住误选（比如手滑选了个几百 MB 的扫描 PDF），不是业务限制。
 *
 * 与 app/ui/import-view.js 里那个同名的 MAX_FILE_BYTES 无关——那是 CSV 解析的
 * 内存 / 耗时上限，数值相同纯属巧合。两个模块不会互相 import，但 grep 时会同时
 * 冒出来，先说清楚。
 */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

/**
 * 判断这是哪一类文件。
 *
 * **mime 优先、扩展名兜底**，顺序不能含糊：安卓的文件选择器给 OFD 的 type 很可能是
 * 空的、application/octet-stream，甚至乱给一个，光看 mime 会漏；而真给出
 * application/pdf、文件名却挂着 .ofd 时，两套规则会给出相反答案——mime 是系统给的、
 * 扩展名是发送方起的，前者更可信，所以 mime 先判。
 *
 * **已知代价**（写在这里，免得下一个人以为这个场景没想过）：系统若把一个 .ofd 报成
 * application/pdf，我们会按 pdf 处理——预览显示「PDF 已保存」、导出的兜底名也带 .pdf，
 * 而内容其实是 OFD，PDF 阅读器打不开它。.ofd 进系统 MIME 表较晚，老 WebView 的 type 表
 * 把它归到相邻的 PDF 一族并非不可能。真在真机上撞到，要改的就是这几行的顺序，
 * 以及 tests 里那条「mime 与扩展名打架」的用例。
 *
 * 返回 'image' | 'pdf' | 'ofd'。
 */
export function fileKind(mime, name) {
  const m = String(mime ?? '');
  const n = String(name ?? '');
  if (/ofd/i.test(m)) return 'ofd';
  if (/pdf/i.test(m)) return 'pdf';
  if (/\.ofd$/i.test(n)) return 'ofd';
  if (/\.pdf$/i.test(n)) return 'pdf';
  return 'image';
}

/** 归一化 mime：小写、去掉 `;` 之后的参数（charset 之类）。两个函数共用同一个口径，不各写一份。 */
function normalizeMime(mime) {
  return String(mime ?? '').split(';')[0].trim().toLowerCase();
}

/**
 * 存库时写的 mime。理由与当初 PDF 那一处相同：选择器给的可能是空 type、
 * application/octet-stream、或带 charset 参数，归一化之后备份的元数据里才不会
 * 出现五花八门的写法。
 *
 * 图片这条分支比 pdf / ofd 多三道手：
 * - 剥掉 `;` 之后的参数；
 * - **空 mime 回落 image/jpeg**——走到这条分支说明 fileKind 已经判定它是图片
 *   （扩展名不是 pdf/ofd），而安卓选择器给空 type 是常态（见 fileKind 的注释）；
 * - **非空又不是 image/* 的，回落 application/octet-stream，而不是伪造一个
 *   image/jpeg**。下游 app/ui/invoice-editor.js 的守卫是「mime 以 image/ 开头才
 *   塞进 <img>」——伪造 image/jpeg 会让它失去辨别力（`<img src="blob:…docx">`
 *   得到的是裂图加一行浅灰 alt 文字，比干脆不显示更糟）。实践中这类文件到不了
 *   调用点（图片分支要先 decode 成功），但把不诚实的值挡在源头比依赖下游关卡稳。
 */
export function mimeForKind(kind, mime) {
  if (kind === 'ofd') return 'application/ofd';
  if (kind === 'pdf') return 'application/pdf';
  const m = normalizeMime(mime);
  if (m === '') return 'image/jpeg';
  return m.startsWith('image/') ? m : 'application/octet-stream';
}

/**
 * 导出时的文件扩展名。**要吃 mime，而且 mime 是必填的**——漏传会静默退回 jpg，
 * PNG 记录就白修了。
 *
 * 为什么必须吃 mime：图片记录里可能是 image/png —— prepareFile 有两条路径会把
 * 原始 mime 原样存下来（图片够小、不需要压缩；或压缩失败回退了原图），而兜底文件名
 * 恰恰只在「记录里没有原始文件名」时才用，那种记录常常来自相册或拍照。一律叫 .jpg
 * 会让手机按 .jpg 去派发一个 PNG 文件，而「把原件交出去让别的 App 打开」正是这次
 * 功能的目的之一。
 *
 * 扩展名直接从 subtype 推，判据与 mimeForKind 的白名单同源（都是 `image/` 前缀）：
 * 这样才不会出现「mime 说是 gif、导出名却写 jpg」这种长在函数之间的缝上的不一致。
 *
 * 已知局限：mime 为空时推不出真实格式，只能回落 jpg。真实场景是「安卓选择器给了
 * 空 type + 用户选了 PNG 截图 + 这条记录又没有原始文件名」——名字会不准，但字节是
 * 完整的。要根治得让 prepareFile 在 mime 为空时从文件名反推 mime（不在本次范围）。
 */
export function extForKind(kind, mime) {
  if (kind === 'ofd') return 'ofd';
  if (kind === 'pdf') return 'pdf';
  const m = normalizeMime(mime);
  if (!m.startsWith('image/')) return 'jpg';
  const sub = m.slice('image/'.length);
  if (sub === 'jpeg' || sub === 'jpg') return 'jpg';
  // 只放行纯字母数字的 subtype：`svg+xml` 这类带符号的、以及被塞进来的路径片段
  // （image/../../x）都会落到这里，一律按 jpg。
  return /^[a-z0-9]+$/.test(sub) ? sub : 'jpg';
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`D:\node.exe --test --test-isolation=none tests/file-info.test.js`

预期：PASS，12 个测试全过。

- [ ] **步骤 5：Commit**

```bash
git add app/file-info.js tests/file-info.test.js
git commit -m "feat(ofd): 文件类型判定与 mime 归一化（纯模块，可单测）"
```

---

### 任务 2：文件名工具（`app/file-info.js` 续）

**文件：**
- 修改：`app/file-info.js`
- 修改：`tests/file-info.test.js`

- [ ] **步骤 1：追加失败的测试**

先把 `tests/file-info.test.js` 顶部的 import 段改成：

```js
import {
  MAX_FILE_BYTES, fileKind, mimeForKind, extForKind,
  sanitizeFilename, fallbackFileName
} from '../app/file-info.js';
```

再在文件末尾追加：

```js
test('sanitizeFilename：去掉路径分隔符与非法字符', () => {
  assert.equal(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j', 'fb'), 'a_b_c_d_e_f_g_h_i_j');
});

test('sanitizeFilename：去掉首尾的点与空格', () => {
  assert.equal(sanitizeFilename('  ..name..  ', 'fb'), 'name');
  assert.equal(sanitizeFilename('...', 'fb'), 'fb');
});

test('sanitizeFilename：空、全空白、非字符串都用 fallback', () => {
  assert.equal(sanitizeFilename('   ', 'fb'), 'fb');
  assert.equal(sanitizeFilename('', 'fb'), 'fb');
  assert.equal(sanitizeFilename(null, 'fb'), 'fb');
  assert.equal(sanitizeFilename(undefined, 'fb'), 'fb');
});

test('sanitizeFilename：超长截断到 100 字符', () => {
  assert.equal(sanitizeFilename('x'.repeat(300), 'fb').length, 100);
});

test('sanitizeFilename：正常的文件名原样保留', () => {
  assert.equal(sanitizeFilename('25517000000012345678.ofd', 'fb'), '25517000000012345678.ofd');
});

test('fallbackFileName：带号码与时间戳', () => {
  assert.equal(
    fallbackFileName({ number: '123', issuedAt: 1700000000000, kind: 'ofd' }),
    '发票-123-1700000000000.ofd'
  );
});

test('fallbackFileName：没号码时用「无号」，issuedAt 无效时用 0', () => {
  assert.equal(
    fallbackFileName({ number: '  ', issuedAt: null, kind: 'pdf' }),
    '发票-无号-0.pdf'
  );
});

test('fallbackFileName：号码里的非法字符会被净化', () => {
  assert.equal(
    fallbackFileName({ number: 'A/B', issuedAt: 1, kind: 'image' }),
    '发票-A_B-1.jpg'
  );
});

test('fallbackFileName：图片带 PNG 的 mime 时扩展名跟着变', () => {
  assert.equal(
    fallbackFileName({ number: '9', issuedAt: 5, kind: 'image', mime: 'image/png' }),
    '发票-9-5.png'
  );
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`D:\node.exe --test --test-isolation=none tests/file-info.test.js`

预期：FAIL —— `sanitizeFilename is not a function`（8 个旧测试仍应通过）。

- [ ] **步骤 3：实现两个函数**

追加到 `app/file-info.js` 末尾：

```js
/**
 * 净化文件名：它会落到手机的文件系统上。路径分隔符、控制字符、首尾的点都不能留
 * （".." 与结尾的点在 Windows 上会被截掉、或产生一个看不出问题的怪文件）。
 * 净化后为空时用调用方给的 fallback——空文件名在下载时会退化成一个乱码名。
 */
export function sanitizeFilename(name, fallback = 'file') {
  const cleaned = String(name ?? '')
    .replace(/[/\\:*?"<>|]/g, '_')
    // 控制字符（含 \x00-\x1f）单独一条：放在上面的字符类里会写成不可见字面量，看的人会以为漏了
    .replace(/[\u0000-\u001f]/g, '_')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
    .slice(0, 100);
  return cleaned === '' ? fallback : cleaned;
}

/**
 * 没有原始文件名时的兜底名。号码是用户最认得出的东西，放在最前面；
 * 没填就直接写「无号」——空字符串会让文件名变成「发票--1700000000000.ofd」这种看着像出错的东西。
 * 时间戳保证同一天的多张票不会重名。
 */
export function fallbackFileName({ number, issuedAt, kind, mime } = {}) {
  const n = String(number ?? '').trim() || '无号';
  const t = Number.isSafeInteger(issuedAt) ? issuedAt : 0;
  // 扩展名要吃 mime：图片记录的 mime 可能是 image/png，而这条路恰恰只在
  // 「没有原始文件名」时才走（见 extForKind 的注释）。
  const ext = extForKind(kind, mime);
  return sanitizeFilename(`发票-${n}-${t}.${ext}`, `发票.${ext}`);
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`D:\node.exe --test --test-isolation=none tests/file-info.test.js`

预期：PASS，25 个测试全过。

- [ ] **步骤 5：Commit**

```bash
git add app/file-info.js tests/file-info.test.js
git commit -m "feat(ofd): 文件名净化与兜底命名（纯函数，可单测）"
```

---

### 任务 3：`image-store` 认 OFD 并记住文件名

**文件：**
- 修改：`app/image-store.js`（删 `isPdf`：88-95 行；改 `prepareFile`：106-149 行；改 `saveFile`：152-177 行）
- 修改：`app/backup-store.js`（`encodeFiles` 与 `importBackup` 各加一个 `name`）
- 修改：`sw.js`（`./app/file-info.js` 进白名单，`CACHE` 提到 v14）
- 修改：`tests/file-info.test.js`（`replaceExt` 的单测）

**为什么后三个文件也归本任务**（代码审查带出来的，不是范围蔓延）：

1. **`file-info.js` 从本任务起是首屏静态依赖**：`main.js → invoice-view → invoice-editor / invoice-store → image-store → file-info`。而 SW 是 cache-first——白名单里没有它，已装旧缓存的设备离线启动会回退到 `index.html`、import 链一断**整个 app 白屏**（不是「发票面板打不开」那么局部）。所以白名单与版本号必须跟产生依赖的那次提交一起走，不能等到任务 9。
2. **`name` 必须同时进备份的两份手写字段清单**：`backup-store.js` 的 `encodeFiles`（`out.push` 那个字面量）与 `importBackup`（`puts.push` 那个）都不含 `name`，而 `invoiceFiles` 从来没走过 `ARRAY_STORES` 的整表路径（blob 进不了 JSON）。漏掉的后果是文件名在备份往返里**静默消失**——本机验证全绿，换机恢复之后才现形。

**具体的三处改动：**

`app/backup-store.js` 的 `encodeFiles`，在 `mime:` 那一项旁边加：

```js
      name: String(f.name ?? '').trim(),
```

`app/backup-store.js` 的 `importBackup`，在写入 `invoiceFiles` 的那个字面量里加同一个键。

`sw.js`：

```js
const CACHE = 'pvault-v14';
```

并加一条注释说明 v14 是什么，然后在 `'./app/dates.js',` 与 `'./app/image-scale.js',` 之间插入：

```js
  './app/file-info.js',
```

`tests/file-info.test.js` 为下面新增的 `replaceExt` 补测试（放在 `sanitizeFilename` 那组附近）：

```js
test('replaceExt：换掉扩展名，主干保留', () => {
  assert.equal(replaceExt('IMG_1234.HEIC', 'jpg'), 'IMG_1234.jpg');
  assert.equal(replaceExt('a.png', 'jpg'), 'a.jpg');
  assert.equal(replaceExt('没有扩展名', 'jpg'), '没有扩展名.jpg');
  // 开头的点是「隐藏文件」不是扩展名，不能把整个名字当扩展名切掉
  assert.equal(replaceExt('.hidden', 'jpg'), '.hidden.jpg');
  // 空名字保持空——兜底名是导出时的事，这里不替它做主
  assert.equal(replaceExt('', 'jpg'), '');
  assert.equal(replaceExt(null, 'jpg'), '');
});
```

**`replaceExt` 本身**（加进 `app/file-info.js`，放在 `sanitizeFilename` 附近）：

```js
/**
 * 换掉文件名的扩展名，主干保留。
 *
 * 存在的理由：图片那条路上 prepareFile 会把原图重编码成 JPEG（手机照片基本都超过
 * 跳过压缩的阈值），字节与用户给的扩展名从此对不上——相册里的 PNG / HEIC 照片会挂着
 * 一个 `.HEIC` 的名字存下去，而导出时手机是按扩展名派发打开方式的。名字与字节必须自洽。
 *
 * 开头的点不算扩展名（`.hidden` 是隐藏文件的写法，整串就是它的名字）；
 * 没有扩展名就直接接上。
 */
export function replaceExt(name, ext) {
  const base = String(name ?? '').trim();
  if (base === '') return '';
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return `${stem}.${ext}`;
}
```

这个任务**没有新单测**：`prepareFile` / `saveFile` 依赖 `Blob`、`Canvas`、`indexedDB`，在 Node 里跑不了（文件头注释已声明）。本次改动的判定逻辑已全部落在任务 1、2 的纯函数里，这里剩下的只有编排——验证靠「全量测试不回归」+ 任务 10 的模拟器实测。

**顺手统一 mime 口径**：图片分支原本写 `mime || 'image/jpeg'`，会把 `image/png; charset=binary` 这种带参数的写法原样存进库。改成走 `mimeForKind(kind, mime)` 之后，全库的 mime 只有一处产生，`extForKind(kind, rec.mime)` 推扩展名也就不必去猜库里会出现什么写法。（唯一例外是最后那条「压缩成功」的 return，产物确实是 JPEG，直接写死 `image/jpeg`。）

- [ ] **步骤 1：改 import，删掉 `isPdf`**

把 `app/image-store.js` 顶部的 import 段改成：

```js
import * as db from './db.js';
import { uid } from './store.js';
import {
  MAX_EDGE, THUMB_EDGE, JPEG_QUALITY, THUMB_QUALITY,
  computeTargetSize, shouldCompress, useCompressed, estimateBackupMB
} from './image-scale.js';
import { fileKind, mimeForKind } from './file-info.js';
```

删除原有的 `isPdf` 函数（连同它上面那段「只看 mime 太严」的注释，那段话的价值已经搬进 `file-info.js` 的 `fileKind` 注释里）：

```js
// —— 删掉这一整段 ——
function isPdf(mime, name) {
  return /pdf/i.test(mime) || /\.pdf$/i.test(name || '');
}
```

- [ ] **步骤 2：改 `prepareFile` 的文件分支**

把 `prepareFile` 开头到 PDF 分支（原 106-115 行）改成：

```js
export async function prepareFile(inputFile) {
  const mime = String(inputFile?.type || '');
  const size = Number(inputFile?.size) || 0;
  // 原始文件名：选择器有时不给（name 为空），所以这里只做取值、不做兜底，
  // 兜底名等到导出时用发票号码现算（那时才知道号码）。
  const name = String(inputFile?.name ?? '');
  const kind = fileKind(mime, inputFile?.name);

  if (kind === 'pdf' || kind === 'ofd') {
    // PDF / OFD 都不压缩、都没有缩略图：
    // - OFD 内部本就是压缩过的 XML 包，再压一遍没有意义；
    // - 这两类都没有能直接渲染成缩略图的东西。
    // mime 一律归一化：选择器给的可能是空 type、application/octet-stream 或带 charset 参数，
    // 归一化后备份里的元数据才不会五花八门（理由同 file-info.mimeForKind）。
    return {
      blob: inputFile, thumbBlob: null, mime: mimeForKind(kind, mime),
      size, name, compressed: false
    };
  }
```

- [ ] **步骤 3：给图片那三个 return 补上 `name`**

`prepareFile` 里图片路径原有的三个 `return` 全部加上 `name`：

```js
    if (!shouldCompress(size, w, h)) {
      return { blob: inputFile, thumbBlob, mime: mimeForKind(kind, mime), size, name, compressed: false };
    }
    const out = await drawTo(source, MAX_EDGE, JPEG_QUALITY);
    if (!useCompressed(size, out.size)) {
      return { blob: inputFile, thumbBlob, mime: mimeForKind(kind, mime), size, name, compressed: false };
    }
    return {
      // 这一条是压缩产物，格式确实就是 JPEG，不必过 mimeForKind
      blob: out, thumbBlob, mime: 'image/jpeg',
      size: out.size, originalSize: size, name, compressed: true
    };
```

以及 `catch` 分支里的那个：

```js
    return {
      blob: inputFile, thumbBlob,
      mime: mime || 'application/octet-stream', size, name, compressed: false, failed: true
    };
```

- [ ] **步骤 4：`saveFile` 落库时写入 `name`**

```js
export async function saveFile(prepared) {
  const id = uid();
  try {
    await db.put('invoiceFiles', {
      id,
      blob: prepared.blob,
      thumbBlob: prepared.thumbBlob,
      mime: prepared.mime,
      size: prepared.size ?? prepared.blob.size,
      // 原始文件名，可能是空串。**总是写这个键**：不写的话读出来是 undefined，
      // 每个消费方就都得记得写 ?? ''，漏一处就是界面上一个 undefined。
      name: String(prepared.name ?? '').trim(),
      createdAt: Date.now()
    });
```

（后面的配额错误处理原样不动。）

- [ ] **步骤 5：跑全量测试确认没有回归**

运行：`D:\node.exe --test --test-isolation=none`

预期：PASS，**247 通过 / 0 失败**（原 221 + 任务 1 的 12 + 任务 2 的 13 + 本任务为 `replaceExt` 新增的 1）。

- [ ] **步骤 6：Commit**

```bash
git add app/image-store.js
git commit -m "feat(ofd): prepareFile 认 OFD，原始文件名一并落库"
```

---

### 任务 4：抽出共用的下载触发（`app/ui/download.js`）

**文件：**
- 创建：`app/ui/download.js`
- 修改：`app/ui/backup-view.js`（删 229-242 行的私有 `download`，改调共用函数，改 import）

这个任务是纯搬运，**行为必须一模一样**：备份导出的真机验证是这套步骤唯一的证据，搬的时候不能顺手改。

- [ ] **步骤 1：创建 `app/ui/download.js`**

```js
// 触发一次浏览器下载：把 Blob 存成 filename 命名的文件。
//
// 两条是踩过的坑，搬过来的时候一句都不能改：
// 1. 必须 append 到 document 再 click：Firefox 里游离（不在文档中）的 <a> 点击不触发下载。
// 2. revokeObjectURL 延后 1 秒：立刻撤销会让部分浏览器在下载真正开始前就拿到一个失效 URL。
//
// 这一整段必须同步跑完，中间不要插 await。但**click 本身并不要求用户手势**——
// 备份导出就是先 await 完 exportBackup() 再点这里的，安卓真机验过、能落文件。
// （`<input type="file">` 的 click 才受手势限制，那是另一回事，别把它的约束搬过来。）
// 真在某个浏览器上撞到「点了没反应」，先怀疑这一条，别先去重构调用方。
//
// 约定：filename 由调用方给全——非空、已经过 app/file-info.js 的 sanitizeFilename、
// 带好扩展名。本函数不净化、也不补扩展名：扩展名只认 filename，不看 blob.type
// （createObjectURL 不会把 MIME 变成文件后缀）。
/** 把 blob 存成 filename 命名的文件。同步触发，不报告成败（下载被拦截不会抛错）。 */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
```

- [ ] **步骤 2：`backup-view.js` 改用共用函数**

在 `app/ui/backup-view.js` 的 import 段加一行：

```js
import { downloadBlob } from './download.js';
```

把它内部那个私有函数（原 229-242 行）整个换成：

```js
  // blob 与 mime 是业务决定（备份文件是 JSON），留在这里；下载动作本身走 app/ui/download.js。
  function download(filename, text) {
    downloadBlob(new Blob([text], { type: 'application/json' }), filename);
  }
```

原有的调用点 `download(filename, text)` **一个字都不用改**。

- [ ] **步骤 3：跑全量测试确认没有回归**

运行：`D:\node.exe --test --test-isolation=none`

预期：PASS，247 通过 / 0 失败。（`backup-view.js` 是视图，没有单测；这里只确认没有别的文件被带崩。）

- [ ] **步骤 4：人工核对搬运是否等价**

逐条对照新旧实现，确认这四件事没变：`a.download` 赋的是 filename；`a` 被 append 到 `document.body`；`click()` 之后有 `remove()`；`revokeObjectURL` 是 `setTimeout(..., 1000)`。任何一条变了都不要提交——备份导出的真机结论只对原实现成立。

- [ ] **步骤 5：Commit**

```bash
git add app/ui/download.js app/ui/backup-view.js
git commit -m "refactor(download): 把下载触发抽到 app/ui/download.js 共用"
```

---

### 任务 5：发票编辑器的选择器与 20 MB 拦截

**文件：**
- 修改：`app/ui/invoice-editor.js`（import：1-13 行；`pickFile`：160-162 行；`fileInput` 调用与按钮：203、508 行）

- [ ] **步骤 1：加 import**

在 `app/ui/invoice-editor.js` 的 import 段（`image-store.js` 那一行之后）加：

```js
import { MAX_FILE_BYTES } from '../file-info.js';
```

（只 import 本任务真正用到的那一个。`fileKind` 归任务 6，`sanitizeFilename` / `fallbackFileName` / `downloadBlob` 归任务 7——一次加一堆用不到的 import，会让审查看不出每一步到底该动什么。）

- [ ] **步骤 2：`pickFile` 开头加 20 MB 拦截**

```js
  async function pickFile(file) {
    if (!file) return;
    // 上限在 prepareFile **之前**判：那个函数的契约是「任何一步失败都回退原图，
    // 不能因为省体积就把用户的发票弄丢」，往里塞一个「直接拒绝」的分支会把契约弄浑。
    // 这里直接 return，不碰 previewSeq、不碰 state.fileId——上一次选的文件继续有效，
    // 用户也不该因为选错了一个大文件就丢掉上一张已经选好的票。
    if ((Number(file.size) || 0) > MAX_FILE_BYTES) {
      errorNode.textContent = '这个文件太大了（超过 20 MB）。发票一般没这么大——原来选好的那张没有变';
      return;
    }
    const seq = ++previewSeq;
```

- [ ] **步骤 3：放宽 accept 与按钮文案**

`albumInput` 那一行（原 203 行）：

```js
  const albumInput = fileInput('image/*,application/pdf,.ofd,application/ofd');
```

按钮文案（原 508 行）：

```js
      el('button', { class: 'btn', type: 'button', text: '选图片 / PDF / OFD', onclick: () => albumInput.click() })
```

- [ ] **步骤 4：跑全量测试**

运行：`D:\node.exe --test --test-isolation=none`

预期：PASS，247 通过 / 0 失败。（视图层没有单测，这里确认没有连带损坏。）

- [ ] **步骤 5：Commit**

```bash
git add app/ui/invoice-editor.js
git commit -m "feat(ofd): 编辑器接受 OFD 文件，并在 20 MB 处拦下误选"
```

---

### 任务 6：预览区按类型与文件名显示

**文件：**
- 修改：`app/ui/invoice-editor.js`（`paintPreview`：128-158 行）

- [ ] **步骤 1：加一个占位块构造助手**

放在 `paintPreview` 上面（`mountPreview` 之后）：

```js
  // 非图片文件（PDF / OFD）在预览区只能给一个占位块：它们没有缩略图，也不能塞进 <img>
  // （getFullUrl 对任何存在的记录都返回 blob URL，直接塞进去得到的是裂图加一行浅灰 alt 文字）。
  // 有原始文件名就显示文件名——存进去的文件从此有了「长相」，不然一堆票在界面上全长一样。
  function filePlaceholder(rec, kind) {
    const name = String(rec?.name ?? '').trim();
    const text = name || (kind === 'ofd' ? 'OFD 已保存' : 'PDF 已保存');
    // title 放完整名字：块里的文字会被 CSS 截断，长文件名只有悬停/长按才看得全。
    return el('div', { class: 'inv-thumb', style: 'width:100%;height:130px', title: text, text });
  }
```

- [ ] **步骤 2：改 `paintPreview` 的分支**

把原来的三处占位（「还没有图片」两处「PDF 已保存」）换成：

```js
  async function paintPreview() {
    // ⚠️ 原文件里从「这里**不能**自增 previewSeq」开始的那段注释（约 6 行）**一字不改地保留**，
    // 它记的是真实踩过的坑（自增之后 pickFile 的 finally 永远清不掉 busy，发票存不下去）。
    // 本次只改它下面的分支。
    const seq = previewSeq;
    const fileId = state.fileId;
    if (!fileId) {
      mountPreview(el('div', { class: 'inv-thumb', style: 'width:100%;height:130px', text: '🧾 还没有文件' }));
      return;
    }
    const rec = await getFile(fileId).catch(() => null);
    if (seq !== previewSeq) return;
    // 判类型要看 mime 与文件名两样，统一走 file-info.fileKind——不要在视图里另写一套正则，
    // 否则「OFD 该按什么算」这件事就有了两个说法。
    const kind = rec ? fileKind(rec.mime, rec.name) : 'image';
    if (!rec || kind !== 'image') {
      mountPreview(filePlaceholder(rec, kind));
      return;
    }
    const url = await getFullUrl(fileId).catch(() => null);
    if (seq !== previewSeq) return;
    if (!url) {
      // 记录在、URL 却建不出来：按图片算但只能给占位。老记录没有 name，会落到默认文案上。
      mountPreview(filePlaceholder(rec, kind));
      return;
    }
    mountPreview(el('img', { class: 'inv-preview', src: url, alt: '发票' }));
  }
```

注意：`rec` 为 null 时 `kind` 兜底成 `'image'`，走到 `filePlaceholder(null, 'image')` 会显示「PDF 已保存」——这是**有意**的：记录读不出来时给一句「已保存」比一句「读不出来」更接近事实（文件确实曾经存下去过），
而这里原本就是这个行为。

- [ ] **步骤 3：跑全量测试**

运行：`D:\node.exe --test --test-isolation=none`

预期：PASS，247 通过 / 0 失败。

- [ ] **步骤 4：Commit**

```bash
git add app/ui/invoice-editor.js
git commit -m "feat(ofd): 预览区按类型给占位，有文件名就显示文件名"
```

---

### 任务 7：导出按钮

**文件：**
- 修改：`app/ui/invoice-editor.js`（节点构造：67-86 行附近；`paintPreview`；新增 `exportCurrentFile`；`mount` 调用：503-534 行）

- [ ] **步骤 1：构造按钮与它的容器**

在 `const previewBox = el('div', {});` 之后加：

```js
  // 导出按钮只在真的有文件时出现：没有文件时它按下去也没用，
  // 而一个按了没反应的按钮比没有按钮更让人困惑。
  const exportBtn = el('button', {
    class: 'btn', type: 'button', text: '导出这份文件',
    onclick: () => { exportCurrentFile(); }
  });
  // 用 style.display 显隐而不是 hidden 属性：.row 这类类选择器带 display:flex，
  // 会盖掉 hidden 自带的 display:none。置空字符串是让元素回到 CSS 自己的 display。
  const exportRow = el('div', { class: 'row', style: 'display:none' }, [exportBtn]);
```

- [ ] **步骤 2：在 `paintPreview` 开头同步显隐**

在 `const seq = previewSeq;` 之后加：

```js
    // 跟着「有没有文件」走，与下面的分支一一对应。放在序号检查之前，
    // 因为它是同步的、不依赖任何 await 结果。
    exportRow.style.display = state.fileId ? '' : 'none';
```

- [ ] **步骤 3：实现 `exportCurrentFile`**

放在 `pickFile` 之后：

```js
  // 把当前文件导出到手机的下载目录。
  // 为什么不是「预览」：OFD / PDF 在这个 WebView 里都渲染不了，能做的只有把原件交出去，
  // 让系统里的 OFD 阅读器 / PDF 阅读器去打开它。
  //
  // 顺序：先 await 把 blob 和名字都取好，再调 downloadBlob。await 之后调没有任何问题
  // （备份导出就是这么干的，真机验过），要求的是**不要在 downloadBlob 内部再插 await**。
  async function exportCurrentFile() {
    const fileId = state.fileId;
    if (!fileId) return;
    try {
      const rec = await getFile(fileId);
      if (!rec?.blob) {
        errorNode.textContent = '文件读不出来了，请重新选择一次';
        return;
      }
      const kind = fileKind(rec.mime, rec.name);
      const fallback = fallbackFileName({
        number: state.number, issuedAt: state.issuedAt, kind, mime: rec.mime
      });
      // 有原始名就用它（用户认得出这是哪个文件），没有才用兜底名。
      const filename = sanitizeFilename(rec.name, fallback);
      downloadBlob(rec.blob, filename);
      errorNode.textContent = `已导出到手机的下载目录：${filename}`;
    } catch (err) {
      console.error('导出发票文件失败', err);
      errorNode.textContent = '导出失败：' + (err?.message || err);
    }
  }
```

（成功提示借用 `errorNode` 这个节点：它在文件区上方、位置正好，而且项目里已有先例——压缩成功的「已压缩，省了约 X%」就写在这里。）

- [ ] **步骤 4：把 `exportRow` 挂进面板**

`mount(body, ...)` 调用改成（只加 `exportRow` 这一项，位置紧跟在 `previewBox` 之后）：

```js
  mount(body,
    errorNode,
    previewBox,
    exportRow,
    el('div', { class: 'stack', style: 'gap:6px' }, [
      el('button', { class: 'btn', type: 'button', text: '拍照', onclick: () => cameraInput.click() }),
      el('button', { class: 'btn', type: 'button', text: '选图片 / PDF / OFD', onclick: () => albumInput.click() })
    ]),
```

（其余参数原样保留到最后。）

- [ ] **步骤 5：跑全量测试**

运行：`D:\node.exe --test --test-isolation=none`

预期：PASS，247 通过 / 0 失败。

- [ ] **步骤 6：Commit**

```bash
git add app/ui/invoice-editor.js
git commit -m "feat(ofd): 发票编辑器加「导出这份文件」"
```

---

### 任务 8：列表占位块的无障碍文案

**文件：**
- 修改：`app/ui/invoice-view.js`（145-147 行）

- [ ] **步骤 1：改占位节点**

把这一行：

```js
      const thumb = el('div', { class: 'inv-thumb', text: inv.fileId ? '📄' : '🧾' });
```

改成：

```js
      // 占位块（没图 / PDF / OFD 都会留在这里）。文案固定成「发票文件」而不区分 PDF / OFD：
      // getThumbUrl 只回 URL、不回 mime，要区分就得为列表每一行多读一次 IndexedDB 记录。
      const thumb = el('div', {
        class: 'inv-thumb',
        title: inv.fileId ? '发票文件' : '没有文件',
        'aria-label': inv.fileId ? '发票文件' : '没有文件',
        text: inv.fileId ? '📄' : '🧾'
      });
```

- [ ] **步骤 2：跑全量测试**

运行：`D:\node.exe --test --test-isolation=none`

预期：PASS，247 通过 / 0 失败。

- [ ] **步骤 3：Commit**

```bash
git add app/ui/invoice-view.js
git commit -m "feat(ofd): 列表占位块补 title 与 aria-label"
```

---

### 任务 9：Service Worker 版本与白名单

**文件：**
- 修改：`sw.js`（36 行的 `CACHE`；44-99 行的 `ASSETS`）

漏一个文件进白名单的后果不是「少一份缓存」：`cache.addAll()` 是原子的，数组里只要有一条 404，整个 install 就失败，离线能力直接归零。

- [ ] **步骤 1：提版本号**

```js
const CACHE = 'pvault-v15';
```

- [ ] **步骤 2：加 v15 的说明注释**

紧接 v13 那条注释之后加：

```js
// v15：下载触发从 backup-view 抽到 app/ui/download.js 共用，它要进预缓存清单。
// （file-info.js 在任务 3 就随 v14 进过清单了 —— 它从那时起是首屏静态依赖，
//  必须在消费方 import 它之前就位；晚一步的后果是整个 app 白屏，不只是发票面板。）
// 漏掉 download.js 的后果与上面各次相同：离线时这个 module 404，import 链断。
```

- [ ] **步骤 3：白名单按 ASCII 顺序插入一条**

在 `'./app/ui/dom.js',` 与 `'./app/ui/entry-panel.js',` 之间插入：

```js
  './app/ui/download.js',
```

（`'./app/file-info.js',` 在任务 3 就已经加进去了，这里不要重复插。）

- [ ] **步骤 4：核对白名单与磁盘逐条对齐**

运行：

```powershell
$sw = Get-Content sw.js -Raw
$listed = [regex]::Matches($sw, "\./[^']+") | ForEach-Object { $_.Value } | Where-Object { $_ -ne './' }
$missing = $listed | Where-Object { -not (Test-Path $_.Substring(2)) }
if ($missing) { "缺失: $missing" } else { "白名单 $($listed.Count) 条，全部存在" }
```

预期：`白名单 55 条，全部存在`（原有的 53 条 + 新增 2 条。`'./'` 不计入，它匹配不上脚本的正则）。

- [ ] **步骤 5：Commit**

```bash
git add sw.js
git commit -m "chore(sw): 缓存版本提到 v15，白名单加 ui/download"
```

---

### 任务 10：手动验证清单与实机复验

**文件：**
- 修改：`docs/手动验证清单.md`

- [ ] **步骤 1：在「发票」一节补 OFD 小节**

追加以下条目（沿用该文件既有的编号与勾选框格式）：

```markdown
### 发票 · OFD 文件

- [ ] 点「图片 / PDF / OFD」能选到一个 `.ofd` 文件，选完面板不报错
- [ ] **这一条决定整个功能的成败**：确认 `.ofd` 在系统选择器里**真的能被选中**。安卓把 OFD 报成 `application/octet-stream`、或 WebView 忽略扩展名过滤，都会让它在选择器里被置灰——那时功能等于没做，而且是静默的（用户只会以为这个 App 不支持 OFD）。选不中的话把 accept 放宽（加 `application/octet-stream`，或干脆 `*/*`），但**必须同时加类型白名单**：`fileKind` 对不认识的一律返回 `'image'`，一放宽就会把 xlsx / docx 也收进来，以「图片未能压缩，已按原样保存」的姿态存进库，导出时还会被命名成 `.jpg`
- [ ] 保存后列表里出现这张票，缩略图位置是占位块而不是裂图
- [ ] 重新点开这张票，预览区显示的**是文件的原始名字**（不是「OFD 已保存」）
- [ ] 点「导出这份文件」，提示「已导出到手机的下载目录：xxx.ofd」
- [ ] 用手机的文件管理器去下载目录，确认文件在、**字节数与电脑上的原文件一致**
- [ ] 点开这个导出的文件，手机里的 OFD 阅读器能正常打开它
- [ ] 老票（OFD 功能之前存的 PDF）：预览显示「PDF 已保存」，导出用的是「发票-号码-时间戳.pdf」这样的兜底名
- [ ] 选一个超过 20 MB 的文件（随便从相册挑个视频试试），提示「这个文件太大了」，且**上一次已经选好的发票文件没有被清掉**
- [ ] 导出一份**含 OFD 的备份** → 恢复 → 预览区仍显示原始文件名（验证 `name` 真的穿越了备份；少了这一步，本机验证会全绿，而换机恢复之后名字静默消失）
- [ ] 从相册选一张 **PNG / HEIC 照片**存下并导出，确认扩展名与字节一致（这类照片会被重编码成 JPEG，名字必须跟着变成 `.jpg`）。**要挑一张超过 300 KB 的**——低于 `SKIP_COMPRESS_BYTES` 的图根本不走重编码那条路，验不到这个修复
- [ ] 断网（开飞行模式）后重复一次「选 OFD → 保存 → 导出」，全程应正常——这就是 v15 预缓存清单在起作用
- [ ] 用一个**名字超过 100 字符**的 PDF / OFD 试一次导出：名字要被截短，但**扩展名必须还在**（审查里这是「导出的文件打不开」的潜在根因）
- [ ] 已知代价复验：找一个系统把 type 报成 `application/pdf` 的 `.ofd`（或临时改 mime 模拟）试一遍，确认此时预览与导出名都会说 PDF。这是 mime 优先的既定代价，**记下来即可，不必修**
```

- [ ] **步骤 2：起模拟器并实测**

模拟器与 CDP 的用法与之前几轮相同：启动模拟器 → `adb forward` 把 WebView 的 devtools socket 映射到本地端口 → 用 Node 24 的全局 `WebSocket` 发 CDP 命令驱动页面。（系统文件选择器驱动不了，所以「选文件」这一步要在页面里用 `new File([...])` + `DataTransfer` 造出来注入。）要点：

1. 启动模拟器需要**完整权限**：受限沙箱下它写 `~/.android` 与 AVD 目录会被拒，并刷 `error: 5` 起不来。
2. `D:\temp\android\sdk\emulator\emulator.exe -avd pvault-test -no-snapshot-load`（后台跑），再 `adb wait-for-device`。
3. 用 `& 'E:\codex-project\pvault\scripts\build-apk.ps1'` 出包（同样需要完整权限：Gradle 要写 `D:\temp\android\gradle-home`，否则报 `native-platform.dll` 加载失败——那个报错是假象），再 `adb install -r`。
4. 需要**真实 OFD 样本**才能验；手上没有的话，先在电脑上造一个最小 OFD（任意 zip，里放一个 `OFD.xml`，改后缀成 `.ofd`）用来验证「存 / 显示名字 / 导出字节一致」这条链路，**不要**用它验证「阅读器能打开」。
5. 导出后从设备把文件拉回来比对字节：`adb shell ls -l /sdcard/Download/` 再 `adb pull`。

- [ ] **步骤 3：把实测结果填进清单**

哪条没验过就**不要勾**，并在条目后补一句为什么没验（真机条件不具备、样本缺失等）。仓库里这份清单的价值全在「哪些已验证、哪些没有」是诚实的。

- [ ] **步骤 4：Commit**

```bash
git add docs/手动验证清单.md
git commit -m "docs(verify): 补 OFD 导入的手动验证清单"
```

---

## 中途不要 push

任务 3 起 `image-store.js` / `invoice-editor.js` 会真正 `import './file-info.js'`，而 Service Worker 的预缓存白名单要到任务 9 才补上。这中间如果 push 了 main，Pages 会自动部署，于是存在一个很窄但真实的窗口：「部署后从未在线打开过发票面板 → 直接离线启动」时 import 链 404、发票面板打不开（`sw.js` 的运行时补缓存只兜得住在线打开过的页面）。

所以：**任务 3 到任务 9 之间不要 push，全部做完一起推。**每个任务照常本地 commit。

---

## 收尾

全部任务完成后跑一次完整回归：

```powershell
D:\node.exe --test --test-isolation=none
cd E:\codex-project\pvault; git status --porcelain
```

预期：247 通过 / 0 失败，工作区干净，`main` 上多出 10 个提交。

**这次不做的事**（写在这里是为了防止实现过程中范围蔓延）：解析 OFD 内容、渲染票面、支持 XML 原件、动 `DB_VERSION`、给列表加文件名。
