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

// 文件名的长度上限（按码点算）。取 100：安卓上单个文件名的上限是 255 字节，
// 一个汉字占 3 字节，所以 100 个汉字会顶到 300 字节 —— 这条注释是承认这个近似，
// 不是保证。真实场景里没有哪个外部 App 会给出 100 个汉字的发票文件名。
const NAME_MAX = 100;

/**
 * 截断到上限，但**保住扩展名**。
 *
 * 为什么不能直接 slice：原始文件名是外部 App 给的（扫描类 App、从聊天或浏览器另存下来的
 * 名字经常又长又啰嗦），一刀切下去很容易正好切在扩展名上。名字没了扩展名，手机就失去了
 * 派发依据 —— 而导出的本意正是「交给别的 App 打开」，那一步会变成一个看起来像环境问题的失败。
 *
 * 按码点切（Array.from）而不是按 UTF-16 码元：直接 slice 会把 emoji 的代理对劈成两半，
 * 留下一个孤立的高位代理，落到文件系统上是乱码、或被直接拒掉。
 */
function truncateKeepingExt(name, max) {
  const chars = Array.from(name);
  if (chars.length <= max) return name;
  // 最后一个点之后才算扩展名；点在开头（.hidden 这种）或压根没有点，都当作没有扩展名
  const dot = chars.lastIndexOf('.');
  const ext = dot > 0 ? chars.slice(dot) : [];
  // 扩展名自己就长到没有保留价值（甚至比上限还长）：按普通截断处理，别为了它把正文切光
  if (ext.length === 0 || ext.length >= max) return chars.slice(0, max).join('');
  return chars.slice(0, max - ext.length).join('') + ext.join('');
}

/**
 * 净化文件名：它会落到手机的文件系统上。路径分隔符、控制字符、首尾的点都不能留
 * （".." 与结尾的点在 Windows 上会被截掉、或产生一个看不出问题的怪文件）。
 *
 * 顺序有讲究：**先截断、再清首尾**。反过来的话，截断处会重新长出一个点或空格
 * （「aaa…a.tail」切到 100 位正好留在一个点上），而那正是上面说不该留的东西；
 * 顺带地，函数也就不再幂等 —— 同一个名字过两遍净化会得到两个不同结果。
 *
 * 整串只有扩展名时（'.ofd'）前导点会被清掉、退化成 'ofd'：这是已知且接受的，
 * 安卓选择器给出这种名字的概率极低。
 * 同理，原本就没有扩展名的名字（「发票」）净化后也仍然没有——导出时系统就没有派发依据。
 * 当前接受这个代价：库里存的是用户给的原始名，替它编一个扩展名反而可能与字节不符。
 */
export function sanitizeFilename(name, fallback = 'file') {
  const raw = String(name ?? '')
    .replace(/[/\\:*?"<>|]/g, '_')
    // 控制字符单独一条：塞进上面的字符类里会写成不可见的字面量，读代码的人会以为这里漏了
    .replace(/[\u0000-\u001f]/g, '_');
  const cleaned = truncateKeepingExt(raw, NAME_MAX)
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '');
  // fallback 也要过一道净化：它可能是调用方随手传进来的（比如记录里的某个字段）。
  // 不过这一道，这个函数就会同时存在「净化过的返回值」和「没净化的返回值」两种形态，
  // 而它唯一的用途是喂给 <a download> 的 filename —— 那里不能出现路径分隔符。
  // 递归是安全的：默认值 'file' 净化后非空，所以最多再走一层就停。
  return cleaned === '' ? sanitizeFilename(fallback ?? 'file') : cleaned;
}

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

/**
 * 没有原始文件名时的兜底名。号码是用户最认得出的东西，放在最前面；
 * 没填就直接写「无号」——空字符串会让文件名变成「发票--1700000000000.ofd」这种看着像出错的东西。
 *
 * 结尾的时间戳**不是**用来区分同一天的多张票的（那些票共享同一个 issuedAt，名字会一模一样）：
 * 它的作用有两个——让「同一张票重复导出」稳定落到同一个文件名上（真重名时浏览器自己会加 (1)），
 * 以及让 issuedAt 不合法时退化成一个确定的常量 0。真正区分多张票的是号码。
 */
export function fallbackFileName({ number, issuedAt, kind, mime } = {}) {
  const n = String(number ?? '').trim() || '无号';
  const t = Number.isSafeInteger(issuedAt) ? issuedAt : 0;
  // 扩展名要吃 mime：图片记录的 mime 可能是 image/png，而这条路恰恰只在
  // 「没有原始文件名」时才走（见 extForKind 的注释）。
  const ext = extForKind(kind, mime);
  return sanitizeFilename(`发票-${n}-${t}.${ext}`, `发票.${ext}`);
}
