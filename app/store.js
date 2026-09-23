// 仓库层：UI 与 IndexedDB 之间的唯一通道。
// 所有视图只通过本模块读写数据，不直接引用 db.js。
// 本模块依赖 db.js（进而依赖 indexedDB / IDBKeyRange 浏览器全局），因此不能在 Node 里被 import，
// 验证方式见 docs/手动验证清单.md 的「仓库层」小节。

import * as db from './db.js';
import { monthRange } from './dates.js';

export const uid = () => crypto.randomUUID();

export async function listAccounts() {
  const all = await db.getAll('accounts');
  return all.filter(a => !a.archived).sort((a, b) => a.sort - b.sort);
}

export async function listCategories(kind) {
  const all = await db.getAll('categories');
  return all
    .filter(c => !c.archived && (kind ? c.kind === kind : true))
    .sort((a, b) => a.sort - b.sort);
}

export async function listAllCategories() {
  return (await db.getAll('categories')).sort((a, b) => a.sort - b.sort);
}

export async function addTransaction(input) {
  const now = Date.now();
  const txn = {
    id: uid(),
    kind: input.kind,
    amountCents: input.amountCents,
    categoryId: input.categoryId ?? null,
    accountId: input.accountId ?? null,
    toAccountId: input.toAccountId ?? null,
    occurredAt: input.occurredAt ?? now,
    note: input.note ?? '',
    shares: input.shares ?? [],
    source: input.source ?? 'manual',
    createdAt: now,
    updatedAt: now
  };
  await db.put('txns', txn);
  for (const share of txn.shares) {
    await db.put('receivables', {
      id: uid(),
      personName: share.personName,
      direction: 'owedToMe',
      amountCents: share.amountCents,
      occurredAt: txn.occurredAt,
      dueAt: null,
      settledAt: null,
      note: txn.note,
      sourceTxnId: txn.id
    });
  }
  return txn;
}

export async function updateTransaction(txn) {
  await db.put('txns', { ...txn, updatedAt: Date.now() });
}

export async function deleteTransaction(id) {
  const receivables = await db.getAll('receivables');
  for (const r of receivables) {
    if (r.sourceTxnId === id && !r.settledAt) {
      await db.remove('receivables', r.id);
    }
  }
  await db.remove('txns', id);
}

export async function listTransactionsInRange(start, end) {
  return db.getByRange('txns', 'by_occurredAt', start, end);
}

export async function listTransactionsInMonths(count, anchorTs = Date.now()) {
  const now = new Date(anchorTs);
  const start = new Date(now.getFullYear(), now.getMonth() - (count - 1), 1).getTime();
  const { end } = monthRange(anchorTs);
  return db.getByRange('txns', 'by_occurredAt', start, end);
}

export async function listReceivables() {
  return db.getAll('receivables');
}

export async function settleReceivable(id) {
  const all = await db.getAll('receivables');
  const target = all.find(r => r.id === id);
  if (!target) return null;
  const next = { ...target, settledAt: Date.now() };
  await db.put('receivables', next);
  return next;
}

export async function getSetting(key, fallback = null) {
  const row = await db.get('settings', key);
  return row ? row.value : fallback;
}

export async function setSetting(key, value) {
  await db.put('settings', { key, value });
  return value;
}

export async function saveAccount(account) {
  const next = { ...account, updatedAt: Date.now() };
  await db.put('accounts', next);
  return next;
}

export async function saveCategory(category) {
  await db.put('categories', category);
  return category;
}
