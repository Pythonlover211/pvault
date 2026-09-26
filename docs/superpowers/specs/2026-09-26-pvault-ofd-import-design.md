# pvault · OFD 导入 设计规格

> 状态：待用户审查
> 日期：2026-09-26
> 项目目录：`E:\codex-project\pvault`
> 前置：发票模块 v1.1.0（HEAD `e8f99aa`）
> 形态：PWA + 本地打包 APK（两条分发路径并存）

---

## 0. 一句话

发票的文件区多认一种格式 OFD：**原样存下来、记住它的文件名、需要时能导出到手机用别的 App 打开**。

---

## 1. 澄清阶段的两个决定（逐条来自用户选择）

| 问题 | 用户的选择 |
|---|---|
| OFD 支持到哪一步 | **B · 只存不解析**——不读字段、不自动填表、不在 App 内渲染票面 |
| 存进去之后给不给出口 | **加导出 + 记住文件名** |

**用户原话（保留措辞）**

- 「再改进一下，发票可以支持导入ofd文件」

**给出的三个深度选项与用户的取舍**

| 选项 | 内容 | 代价 | 用户 |
|---|---|---|---|
| A | 读出号码/金额/销售方/开票日期自动填表 | 需解开 OFD 内部 zip 读 XML，鸿蒙 WebView 对 `DecompressionStream` 的支持未验证 | 未选 |
| B | 原样存档，不解析 | 省不了手输 | **选中** |
| C | 在 App 内看到票面 | OFD 是版式文档，需手写排版引擎，代价极大且不保真 | 未选（我建议放弃） |

---

## 2. 明确不做（防止范围蔓延）

| 不做 | 原因 |
|---|---|
| 解析 OFD 内部 XML 自动填表 | 用户明确选了「只存不解析」；且要先解开 OFD 内部的 zip（deflate），需要 `DecompressionStream('deflate-raw')` 或手写 inflate，鸿蒙那台的 WebView 是否支持未验证 |
| 在 App 内渲染 OFD 票面 | OFD 是固定版式文档（定位到坐标的文字对象 + 嵌入字体），浏览器不原生支持。零依赖手写排版引擎代价极大且不保真 |
| 支持 XML 原件（数电票也常发 XML） | 用户只要 OFD。XML 若将来要支持，走的也是同一条「原样存」的路，届时只是在 `fileKind` 里多一个分支 |
| OFD 转 PDF / 转图片 | 需要 OFD 渲染引擎，同上 |
| 从 OFD 里抽电子签章 / 验真 | 需要联网与签名验证链，与「数据不离开手机」冲突 |

---

## 3. 现状（改动前）

- `app/image-store.js` 有模块私有的 `isPdf(mime, name)`，只把文件分成「PDF」和「图片」两类
- `invoiceFiles` 记录形状：`{ id, blob, thumbBlob, mime, size, createdAt }`——**没有原始文件名**
- 编辑器预览（`app/ui/invoice-editor.js` 的 `paintPreview`）：`mime` 不以 `image/` 开头就显示「📄 PDF 已保存」
- **存下来的 PDF 没有任何出口**：点不开、导不出。这是本次要一并补上的缺口
- `app/ui/backup-view.js` 里有一套已验证可用的下载触发，真机上导出过 97 KB 的备份文件
- 列表页（`app/ui/invoice-view.js`）对没有缩略图的记录保留占位节点，现状即如此

---

## 4. 数据模型

`invoiceFiles` 记录新增一个字段：

```js
{ id, blob, thumbBlob, mime, size, name, createdAt }
```

- `name`：用户选中文件的原始文件名（如 `25517000000012345678.ofd`），已 trim。
- 老记录没有这个字段——**不加迁移、不动 `DB_VERSION`（保持 2）**。读取侧一律 `String(rec.name ?? '').trim()`，空则回退到按 mime 的默认文案。
- `blob` / `thumbBlob` / `mime` / `size` / `createdAt` 语义不变。

**为什么不动 `DB_VERSION`**：只加一个可选字段。IndexedDB 是无 schema 的键值存储，多写一个键不需要版本升级；升版本反而会让所有开着旧连接的页面（比如同时开了两个 Tab）撞上阻塞提示——这个代价远大于收益。发票模块那次从 1 升到 2 是因为真的新建了三张表。

---

## 5. 文件类型识别

新建 `app/file-info.js`——**纯模块**，不碰 DOM / indexedDB / Canvas，可以在 Node 里直接 import 并单测。为什么不放进 `image-store.js`：那个文件的第一行注释就写着「依赖 Canvas / Blob / indexedDB，**不能在 Node 里 import**」，判定逻辑摆在那儿等于放弃单测。

```js
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export function fileKind(mime, name)      // → 'image' | 'pdf' | 'ofd'
export function mimeForKind(kind, mime)    // → 归一化后的 mime
export function extForKind(kind, mime)     // → 导出用的扩展名
export function sanitizeFilename(name, fallback)
export function fallbackFileName({ number, issuedAt, kind, mime })
```

`image-store.js` 里那个模块私有的 `isPdf()` **删掉**（唯一调用点就在 `prepareFile` 内），改调 `fileKind()`。

判定规则，**mime 优先、扩展名兜底**（沿用「选择器给的 mime 不可信」这个已经踩过的坑）：

| 顺序 | 条件 | 判定 |
|---|---|---|
| 1 | mime 含 `ofd`（不分大小写） | `'ofd'` |
| 2 | mime 含 `pdf`（不分大小写） | `'pdf'` |
| 3 | mime 没给出有用信息（空 / `application/octet-stream` / 其它），文件名以 `.ofd` 结尾 | `'ofd'` |
| 4 | 同上，文件名以 `.pdf` 结尾 | `'pdf'` |
| 5 | 其余 | `'image'` |

**为什么不是「任一命中就算」**：真出现了 mime = `application/pdf`、文件名却是 `x.ofd` 时，两套规则会给出相反答案。mime 是选择器/系统给的、扩展名是发送方起的，前者更可信，所以 mime 先判；而 mime 为空或 `application/octet-stream` 这类「什么也没说」的值时，扩展名接管。这个顺序必须写死，不能含糊——它决定了一个文件到底是当 PDF 存还是当 OFD 存。

**存库前归一化 mime**：`'ofd'` → `application/ofd`，`'pdf'` → `application/pdf`，`'image'` → 原 mime 或 `image/jpeg`。理由与 PDF 那一处相同：备份的元数据里不该出现 `application/pdf; charset=binary`、空字符串这类五花八门的写法。

上面五个导出全是纯函数或纯常量：判定表能被单测逐条覆盖，而不是只能经由 `prepareFile` 去间接猜。

**`sanitizeFilename`**：去掉 `/ \ : * ? " < > |` 与控制字符，去掉首尾的点和空格，截断到 100 字符，结果为空则用调用方给的 fallback（**fallback 自己也要过一遍净化**，否则这个函数会同时存在「净化过的返回值」和「没净化的返回值」两种形态，而它唯一的用途是喂给 `<a download>`）。**顺序是先截断、再清首尾**：反过来的话截断处会重新长出一个点或空格，函数也就不再幂等。截断时**保住扩展名**——原始文件名来自外部 App，一刀切在扩展名上会让手机失去派发依据。

**`fallbackFileName`**：没有原始文件名时的兜底，产出 `发票-<号码，没填就用「无号」>-<时间戳>.<ext>`，扩展名由 `extForKind` 推。

---

## 6. `prepareFile` / `saveFile`

`prepareFile(inputFile)` 新增 OFD 分支，与 PDF 分支同形：

```js
{ blob: inputFile, thumbBlob: null, mime: 'application/ofd',
  size, name: inputFile.name, compressed: false }
```

- **不压缩**：OFD 内部本就是压缩过的 XML 包，再压没有意义
- **不做缩略图**：本来就没有可渲染的东西
- PDF 分支同样补上 `name`

`saveFile(prepared)` 把 `name` 一并写进记录（`String(prepared.name ?? '').trim()`）。**这个字段总是写入，值可能是空串**——不写键的话，读出来是 `undefined`，各处就都得写 `?? ''`；统一成「永远有键、可能是空串」只有一处要记。其余写入逻辑与配额错误的中文提示不动。

---

## 7. 界面

### 7.1 发票编辑器 · 选择按钮

- `accept`：`'image/*,application/pdf,.ofd,application/ofd'`
- 文案：「选图片或 PDF」→「**图片 / PDF / OFD**」（相机那个「拍照」按钮不动）

### 7.2 发票编辑器 · 预览区

`paintPreview()` 现在的分支是「`mime` 以 `image/` 开头 → `<img>`，否则 → 占位」。改成：

| 记录 | 显示 |
|---|---|
| `image/*` | `<img class="inv-preview">`（不变） |
| pdf / ofd，有 `name` | 占位块，文字 = 文件名 |
| pdf，无 `name` | 占位块，文字 =「PDF 已保存」 |
| ofd，无 `name` | 占位块，文字 =「OFD 已保存」 |
| 没有文件 | 「🧾 还没有文件」（原为「🧾 还没有图片」；这里现在也可能装的是 PDF / OFD，图标保留） |

占位块带 `title` 属性放完整文件名（长了会被 CSS 截断）。原有的 `previewSeq` 序号防抖逻辑一字不改。

### 7.3 发票编辑器 · 导出按钮

- **位置**：预览区正下方，**只有已有文件时才出现**
- **文案**：「导出这份文件」
- **行为**：`getFile(state.fileId)` 取记录 → `downloadBlob(rec.blob, filename)`
- **文件名**：有 `rec.name` 就用它；没有则兜底 `发票-<号码，没填就用「无号」>-<时间戳>.<ext>`，`ext` 由 mime 推（ofd / pdf / jpg）
- 点击直接来自用户手势，满足「`.click()` 必须在用户手势里发起」这条既有约定

### 7.4 发票列表

- 无缩略图的记录继续用占位节点（现状如此，不新增逻辑）
- 占位节点补 `title` 与 `aria-label`，**固定文案「发票文件」**，不做 PDF / OFD 的类型区分：要区分就得为列表每一行多读一次 IndexedDB 记录（`getThumbUrl` 只回 URL，不带 mime），这个代价不值得
- 列表**不显示文件名**：一行放不下，列表已经够密。要看全名去编辑器

### 7.5 记账首页

不改。`🧾N` 角标的逻辑与文件类型无关。

---

## 8. 导出（新增 `app/ui/download.js`）

把 `backup-view.js` 里那段下载触发抽出来共用：

```js
export function downloadBlob(blob, filename)
```

（`sanitizeFilename` 不在这个文件里——它是纯函数，归 `app/file-info.js`；放在这个碰 DOM 的模块里就同样测不了了。）

- `downloadBlob` 是现有 `download(filename, text)` 的泛化：接受 Blob。步骤一字不改——`createObjectURL` → 隐藏 `<a download>` → **append 到 document**（Firefox 里游离的 `<a>` 点击不触发下载）→ `click` → `remove` → **延后 1 秒** `revokeObjectURL`（立刻撤销会让部分浏览器在下载真正开始前拿到失效 URL）。这两条理由随代码一起搬进注释，别丢。
- `backup-view.js` 的 `download()` 改为调 `downloadBlob(new Blob([text], { type: 'application/json' }), filename)`，行为完全不变
- `sanitizeFilename` 与 `fallbackFileName` 的规则见第 5 节，它们归 `app/file-info.js`

---

## 9. 错误处理与边界

| 情况 | 处理 |
|---|---|
| 文件超过 20 MB | 选文件后立刻拦下：不写库、不设 `state.fileId`，提示「这个文件太大了（超过 20 MB）。发票一般没这么大，确认一下是不是选错了」 || 配额写满 | 沿用 `saveFile` 现有的中文提示，不改 |
| 文件名超长 / 含非法字符 | 导出时过 `sanitizeFilename` |
| OFD 内容损坏 | **不报错**——不解析，只按字节存。这是「只存不解析」的直接代价，写进手动验证清单 |
| 老 PDF 记录（无 `name`） | 预览显示回退文案，导出用兜底名 |
| 手机里没有 OFD 阅读器 | 不是本 App 的问题：文件已落到下载目录，用户自己找 App 打开。导出成功提示里写明「已导出到手机的下载目录」 |

**上限在哪里判**：在 `app/ui/invoice-editor.js` 的 `pickFile` 里、调 `prepareFile` **之前**判。`prepareFile` 的既有契约是「任何一步失败都回退原图，不能因为省体积就把用户的发票弄丢」，往里塞一个「直接拒绝」的分支会把这个契约弄浑。上限常量 `MAX_FILE_BYTES = 20 * 1024 * 1024` 由 `app/file-info.js` 导出，编辑器与测试共用同一个数，避免两处各写一个字面量。

**20 MB 这个数怎么来的**：全电票的 OFD 通常一两百 KB，20 MB 已经大到不像发票了。这个上限唯一的目的是拦住误选（比如手滑选了个几百 MB 的扫描 PDF），不是业务限制，所以不做成可配置项。

---

## 10. 测试

单元测试（新增 `tests/file-info.test.js`；命令 `D:\node.exe --test --test-isolation=none`，当前基线 221 通过 / 0 失败）：

1. **`fileKind`**：`('', 'a.ofd')`、`('application/ofd', '')`、`('application/octet-stream', 'b.OFD')`、`('application/pdf', 'c.ofd')`（mime 优先判成 pdf）、`('image/jpeg', 'd.jpg')`、空 mime + 空名字
2. **`prepareFile` 的 OFD 分支**：mime 归一化成 `application/ofd`、`thumbBlob === null`、`name` 原样带出、`compressed === false`
3. **`sanitizeFilename`**：路径分隔符、控制字符、`..`、全空白、超长截断（保住扩展名）、fallback 自己也要净化、幂等、正常名保持不动
4. 现有 221 个测试保持全绿

真机 / 模拟器验证（条目写进 `docs/手动验证清单.md`）：

- 选一个真实 OFD 能存下来，列表出现该张发票
- 编辑器预览显示文件名
- 导出后文件落在下载目录，能被手机里的阅读器打开，**字节数与设备上的原文件一致**
- 老 PDF 记录（无 `name`）显示回退文案、导出用兜底名
- 超过 20 MB 的文件被拦下，且没有留下孤儿文件

---

## 11. 收尾

- `sw.js` 的 `CACHE`：`pvault-v13` → **`pvault-v14`**，并把新增的 `app/ui/download.js` 加进 `ASSETS` 白名单（白名单里漏一个文件，`cache.addAll` 会原子性失败，整个离线缓存都装不上）
- `docs/手动验证清单.md` 的「发票」一节补 OFD 条目
- 备份**要改两处**：`invoiceFiles` 并不是整表导出。`app/backup-store.js` 的 `encodeFiles` 与 `importBackup` 各有一份**手写字段清单**（`id / mime / size / createdAt / blob / thumbBlob`）——blob 进不了 JSON，只能 base64 单走一条路，所以它从来没走过 `ARRAY_STORES` 那条整表路径。`name` 两处都要加，否则它在备份往返里静默消失：用户在手机上存了 OFD、导出备份、换机恢复之后，预览退回「OFD 已保存」、导出退回兜底名。而手动清单里那两条是在本机直接选的 OFD 上验的，会全绿——缺陷只在换机之后出现，不报错、不留痕。
  （本稿早先在这里写过一句「备份不需要改」的断言，是错的；改掉它，免得下一个人照它办事。）
- 不动 `DB_VERSION`、不加索引、不动列表的排序与筛选

---

## 12. 已知的未验证项（要在真机上复验）

1. **导出链路在 WebView 里能否真的落文件**——备份导出已在真机验证过（97 KB 文件落到设备上），OFD 走同一条路，但 OFD 本身的导出要复验一次
2. **鸿蒙那台 WebView 的下载行为**——与备份导出同一机制，风险等级相同
3. **`<a download>` 对 `application/ofd` 这个 MIME 的处理**——浏览器是否会因为「不认识这个类型」而改存成 `.bin` 或直接打开，需实测确认；若真的发生，退路是给导出文件名强制带上 `.ofd` 扩展名（本来就是这么做的）
