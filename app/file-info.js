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

/**
 * 存库时写的 mime。理由与当初 PDF 那一处相同：选择器给的可能是空 type、
 * application/octet-stream、或带 charset 参数，归一化之后备份的元数据里才不会
 * 出现五花八门的写法。
 *
 * 图片这条分支比 pdf / ofd 多两道手：剥掉 `;` 之后的参数（charset 之类），
 * 以及只放行 image/*。kind 传错、或选择器给了个非图片的 type 时，宁可回落到
 * image/jpeg，也不能把一个非图片 mime 跟着图片记录存进库——下游是按 mime 前缀
 * 决定要不要塞进 <img> 的。
 */
export function mimeForKind(kind, mime) {
  if (kind === 'ofd') return 'application/ofd';
  if (kind === 'pdf') return 'application/pdf';
  const m = String(mime ?? '').split(';')[0].trim().toLowerCase();
  return m.startsWith('image/') ? m : 'image/jpeg';
}

/**
 * 导出时的文件扩展名。**要吃 mime**：图片记录里可能是 image/png ——
 * prepareFile 有两条路径会把原始 mime 原样存下来（图片够小、不需要压缩；
 * 或压缩失败回退了原图），而兜底文件名恰恰只在「记录里没有原始文件名」时才用，
 * 那种记录常常来自相册或拍照。一律叫 .jpg 会让手机按 .jpg 去派发一个 PNG 文件，
 * 而「把原件交出去让别的 App 打开」正是这次功能的目的之一。
 *
 * 只认 png / webp：它们在安卓相册与截图里真的常见，其余一律按 jpg
 * （照片经压缩后的实际格式就是它）。
 */
export function extForKind(kind, mime) {
  if (kind === 'ofd') return 'ofd';
  if (kind === 'pdf') return 'pdf';
  const sub = String(mime ?? '').split(';')[0].trim().toLowerCase();
  if (sub === 'image/png') return 'png';
  if (sub === 'image/webp') return 'webp';
  return 'jpg';
}
