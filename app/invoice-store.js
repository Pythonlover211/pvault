// 发票仓库层：UI 与 IndexedDB 之间的唯一通道。
// 依赖 db.js（进而依赖 indexedDB），**不能在 Node 里 import**；验证靠 fake-IndexedDB 探针与真机。

import * as db from './db.js';
import { uid } from './store.js';
import { dedupeKey, validateInvoice } from './invoice-model.js';
import { deleteFile } from './image-store.js';

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
  return db.getAllByIndex('invoices', 'by_txn', txnId);
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
  await db.put('invoices', inv);
  if (oldFileId && oldFileId !== inv.fileId) {
    await deleteFile(oldFileId);
  }
  return inv;
}

/** 只改挂靠关系，不碰其它字段。传 null 表示解除挂靠。 */
export async function linkToTxn(invoiceId, txnId) {
  const inv = await getInvoice(invoiceId);
  if (!inv) throw new Error('发票不存在');
  await db.put('invoices', { ...inv, txnId: txnId ?? null, updatedAt: Date.now() });
}

export async function deleteInvoice(id) {
  const inv = await getInvoice(id);
  if (!inv) return;
  await db.removeAll([{ store: 'invoices', key: id }]);
  // 图片跟着发票走：没有别的发票引用它，留着就是垃圾
  if (inv.fileId) await deleteFile(inv.fileId);
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
