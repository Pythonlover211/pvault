// 发票文件的类型判定与命名：纯函数 + 常量。
// 不碰 DOM / indexedDB / Canvas，因此可以在 Node 里直接 import 并单测（见 tests/file-info.test.js）。
//
// 为什么不放进 image-store.js：那个文件依赖 Canvas / Blob / indexedDB，
// 在 Node 里 import 不了，判定表就只能经由 prepareFile 去间接猜。

/**
 * 单个发票文件的字节上限。全电票的 OFD 通常一两百 KB，20 MB 已经大到不像发票了。
 * 这个上限唯一的目的是拦住误选（比如手滑选了个几百 MB 的扫描 PDF），不是业务限制。
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
 */
export function mimeForKind(kind, mime) {
  if (kind === 'ofd') return 'application/ofd';
  if (kind === 'pdf') return 'application/pdf';
  return String(mime ?? '') || 'image/jpeg';
}

/** 导出时的文件扩展名。 */
export function extForKind(kind) {
  if (kind === 'ofd') return 'ofd';
  if (kind === 'pdf') return 'pdf';
  return 'jpg';
}
