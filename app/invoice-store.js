// 发票仓库层：UI 与 IndexedDB 之间的唯一通道。
// 依赖 db.js（进而依赖 indexedDB），**不能在 Node 里 import**；验证靠 fake-IndexedDB 探针与真机。

import * as db from './db.js';
import { uid } from './store.js';
import { dedupeKey, validateInvoice } from './invoice-model.js';
import { deleteFile, getThumbUrl, getFullUrl, getEditingFile } from './image-store.js';

export async function listInvoices() {
  const all = await db.getAll('invoices');
  // 开票日期倒序；同日的按录入时间倒序，保证顺序稳定
  return all.sort((a, b) => (b.issuedAt ?? 0) - (a.issuedAt ?? 0) || (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

export async function getInvoice(id) {
  return (await db.get('invoices', id)) ?? null;
}

/**
 * 按发票号码查已有记录。空号码一律返回 null（不查重）。
 * 只做精确匹配——号码是印在票上的，不需要模糊。
 */
export async function findByNumber(number) {
  const key = dedupeKey({ number });
  if (key === null) return null;
  const hits = await db.getAllByIndex('invoices', 'by_number', key);
  return hits[0] ?? null;
}

export async function listByTxn(txnId) {
  if (!txnId) return [];
  const hits = await db.getAllByIndex('invoices', 'by_txn', txnId);
  // 索引查询的顺序实际是随机的：同一个索引键下的多条记录按主键排，而主键是随机 uid，
  // 于是「这笔账挂的三张票」每次打开顺序都不一样。与 listInvoices 用同一套排序：
  // 开票日期倒序，同日的按录入时间倒序。
  return hits.sort((a, b) => (b.issuedAt ?? 0) - (a.issuedAt ?? 0) || (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

/**
 * 写发票记录。db.put 抛出来的英文异常不能原样丢给用户：界面上会显示
 * 「保存失败：QuotaExceededError: …」，用户既不知道发生了什么，也不知道下一步该做什么。
 * 翻译的口气与 image-store.js 的 saveFile 保持一致——同一个异常在图片和发票两处
 * 必须说同一种人话，否则一处给建议、一处甩英文，政策就不统一了。
 */
async function putInvoice(record) {
  try {
    await db.put('invoices', record);
  } catch (err) {
    if (err?.name === 'QuotaExceededError') {
      const quota = new Error('手机存储空间不够了，这张发票没存下。可以先去「记账 → 备份」导出一份并清理旧数据再试。');
      // 沿用原 name：界面读的是 message（已经是中文人话），控制台与排查时仍认得出这是配额失败，
      // 不至于退化成一个无从追查的普通 Error。
      quota.name = err.name;
      throw quota;
    }
    // 其余存储失败（UnknownError / AbortError / DatabaseClosedError……，以及 enqueue 里
    // 同步抛出的 DataError）原来走的是最后那个 `throw err`：界面上直接显示
    // 「UnknownError: …」那样的英文原文，用户既看不懂，也不知道是不是自己操作错了。
    // 与上面配额那句同一个处置：给用户一句能照着做的中文，原文进控制台留给排查——
    // 这里**不**沿用 err.name（这些错误的 name 对用户毫无信息量，界面只读 message）。
    console.error('发票写入失败', err);
    throw new Error('这张发票没存下来（手机存储出错）。请确认存储空间还够，然后重试一次。');
  }
}

/** 每笔账挂了发票的条数，形如 { [txnId]: n }。记账列表用它显示「发票（N）」。 */
export async function countByTxn() {
  const all = await db.getAll('invoices');
  const out = {};
  for (const inv of all) {
    if (!inv.txnId) continue;
    out[inv.txnId] = (out[inv.txnId] ?? 0) + 1;
  }
  return out;
}

/**
 * 新建或更新一张发票。fileId 为 null 表示「没图」；传 undefined 表示「不改动图片」。
 * 调用方负责先调 prepareFile/saveFile 拿到 fileId。
 */
export async function saveInvoice(input) {
  const now = Date.now();
  const existing = input.id ? await getInvoice(input.id) : null;

  const inv = {
    id: input.id ?? uid(),
    number: String(input.number ?? '').trim(),
    issuedAt: input.issuedAt ?? now,
    amountCents: input.amountCents,
    seller: String(input.seller ?? '').trim(),
    type: input.type ?? 'other',
    buyerTitle: String(input.buyerTitle ?? '').trim(),
    buyerTaxId: String(input.buyerTaxId ?? '').trim(),
    taxCents: input.taxCents ?? null,
    note: String(input.note ?? '').trim(),
    fileId: input.fileId === undefined ? (existing?.fileId ?? null) : input.fileId,
    txnId: input.txnId === undefined ? (existing?.txnId ?? null) : input.txnId,
    reimbursementId: existing?.reimbursementId ?? null,
    archived: input.archived ?? existing?.archived ?? false,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };

  const check = validateInvoice(inv);
  if (!check.ok) throw new Error(check.errors.join('；'));

  // 换了图就把旧图删掉，否则 invoiceFiles 会越攒越多、备份也跟着虚胖
  const oldFileId = existing?.fileId;
  await putInvoice(inv);
  if (oldFileId && oldFileId !== inv.fileId) {
    await deleteFile(oldFileId);
  }
  return inv;
}

/** 只改挂靠关系，不碰其它字段。传 null 表示解除挂靠。 */
export async function linkToTxn(invoiceId, txnId) {
  const inv = await getInvoice(invoiceId);
  if (!inv) throw new Error('发票不存在');
  await putInvoice({ ...inv, txnId: txnId ?? null, updatedAt: Date.now() });
}

export async function deleteInvoice(id) {
  const inv = await getInvoice(id);
  if (!inv) return;
  await db.removeAll([{ store: 'invoices', key: id }]);
  // 图片跟着发票走：没有别的发票引用它，留着就是垃圾
  if (inv.fileId) await deleteFile(inv.fileId);
}

/**
 * 清掉没有任何发票引用的图片记录（拍完照又取消保存会留下这种孤儿）。
 * 上面「换图删旧图」「删发票删图」只覆盖了走得完的流程，取消保存那条路没人管——
 * 用久了就是一堆白占配额的 blob，而手机上的配额恰恰是最缺的东西。
 *
 * 两条保护，缺一不可：
 * 1. **24 小时**只是概率保护（刚拍好的图此刻也是「没人引用」的），不是可靠边界——
 *    页面活过一天（安卓 WebView 被系统挂着没杀）、或系统时间被往前调，它就形同虚设；
 * 2. 真正护住「用户正在编辑那张图」的是 setEditingFile 这个标记：编辑器拿到 fileId 就挂上、
 *    保存成功才摘掉，与时间无关，所以同时满足「无引用」和「够旧」的那张图也不会被删。
 * 惰性调用，不需要定时器。
 */
export async function cleanupOrphanFiles(now = Date.now()) {
  const cutoff = now - 24 * 60 * 60 * 1000;
  const [files, invoices] = await Promise.all([db.getAll('invoiceFiles'), db.getAll('invoices')]);
  const used = new Set(invoices.map(inv => inv.fileId).filter(Boolean));
  let removed = 0;
  for (const file of files) {
    if (used.has(file.id)) continue;
    // 编辑器正拿在手里的那张：删掉它，用户接下来点保存就会存下一条没有图的发票。
    // 逐个问一次、而不是循环外读一份快照：这轮清理要 await 删掉几十条 blob，
    // 期间用户完全可能刚在编辑器里选好一张新图。
    if (file.id === getEditingFile()) continue;
    // 写法刻意是「不是明确的旧记录就跳过」：createdAt 缺失或坏掉时 Number() 得到 NaN，
    // NaN < cutoff 为 false，于是留下。清理是删数据，拿不准的时候宁可漏清也不能误删。
    if (!(Number(file.createdAt) < cutoff)) continue;
    await deleteFile(file.id);
    removed += 1;
  }
  return removed;
}

/** 汇总：本月合计、待报销合计（「仅存档」的票不计入待报销）。 */
export async function summary(now = Date.now()) {
  const all = await listInvoices();
  const d = new Date(now);
  const monthStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  const monthEnd = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();

  let monthCents = 0;
  let pendingCents = 0;
  let pendingCount = 0;
  for (const inv of all) {
    const amt = Number(inv.amountCents) || 0;
    if ((inv.issuedAt ?? 0) >= monthStart && (inv.issuedAt ?? 0) < monthEnd) monthCents += amt;
    if (!inv.archived && !inv.reimbursementId) {
      pendingCents += amt;
      pendingCount += 1;
    }
  }
  return { monthCents, pendingCents, pendingCount, total: all.length };
}

// UI 只认仓库层，不直接碰 image-store：发票列表要缩略图、编辑器要原图，
// 由这里转发，将来换存储实现（比如改成 blob 直存）时改一处就够。
export async function thumbUrlFor(fileId) {
  return getThumbUrl(fileId);
}

export async function fullUrlFor(fileId) {
  return getFullUrl(fileId);
}

// 同理转发：发票列表重画完一批后要回收这批不再需要的缩略图 URL，但这个动作属于图片模块的缓存，
// 视图层不该自己 import image-store（也就不该知道「URL 是缓存出来的」这件事）。
export { pruneUrlCache } from './image-store.js';
