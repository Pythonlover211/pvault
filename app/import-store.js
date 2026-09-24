// 导入仓库层：把 import-schema.js 解析出来的记录落进库里，并管理导入格式配置。
// 依赖 db.js（进而依赖 indexedDB 浏览器全局），因此不能在 Node 里被 import，
// 验证方式见 docs/手动验证清单.md 的「台账导入」小节。

import * as db from './db.js';
import { uid, getSetting, setSetting } from './store.js';
import { makeFingerprint } from './import-parse.js';

// ── 去重口径 ────────────────────────────────────────────────────────────────
// 指纹 = 时间 + 金额 + 收支方向 + 商户（实现见 import-parse.js 的 makeFingerprint）。
// 取舍：宁可少导，也不重复导。同一笔在微信和支付宝各导出一次、或同一个文件导入两次，
// 都会被认成重复；代价是「同一秒、同一商户、同一金额、同一方向」的两笔真实消费也会被
// 误判成重复。所以向导里必须把跳过条数显示出来，让用户看得见丢了多少。
//
// 商户的反解必须与写入侧严格对称：导入时 note 由 [merchant, note].filter(Boolean).join(' · ')
// 拼成（见 import-schema.js），交易表里没有单独的 merchant 字段，所以这里按同一个分隔符
// 取回第一段。已知边界：若商户列没有参与映射（merchant 为空）而 note 非空，写出的 note
// 不带分隔符，反解会把整条 note 当成商户，而写入时的指纹用的是空商户——两者对不上，
// 这类记录重导时会二次入库（多导一次，不会丢数据）。

const NOTE_SEPARATOR = ' · ';

export function merchantFromNote(note) {
  const s = String(note ?? '');
  const at = s.indexOf(NOTE_SEPARATOR);
  return (at === -1 ? s : s.slice(0, at)).trim();
}

// 库里已有交易的指纹集合。每条都现算而不是存字段：指纹算法将来改了，
// 存量数据不需要迁移也能跟上。
export async function existingFingerprints() {
  const all = await db.getAll('txns');
  return new Set(all.map(txn => makeFingerprint({
    occurredAt: txn.occurredAt,
    amountCents: txn.amountCents,
    kind: txn.kind,
    merchant: merchantFromNote(txn.note)
  })));
}

function fingerprintOf(record) {
  // mapRows 已经算好指纹（那时还没丢掉 merchant，比事后从 note 反解更准），优先用它；
  // 调用方直接构造记录时再回退到现算。
  return record.fingerprint ?? makeFingerprint({
    occurredAt: record.occurredAt,
    amountCents: record.amountCents,
    kind: record.kind,
    merchant: merchantFromNote(record.note)
  });
}

// 过滤掉库里已有的（以及同一批里自己重复的），给剩下的补上入库所需的字段。
// 只准备、不写入：用户要先在向导里看到「新增 N 条、跳过 M 条」再确认。
export async function prepareImport(records, { defaultCategoryId = null, defaultAccountId = null } = {}) {
  const existing = await existingFingerprints();
  const fresh = [];
  const duplicates = [];
  const seen = new Set();
  const now = Date.now();
  for (const record of records ?? []) {
    const fingerprint = fingerprintOf(record);
    if (existing.has(fingerprint) || seen.has(fingerprint)) {
      duplicates.push(record);
      continue;
    }
    seen.add(fingerprint);
    fresh.push({
      id: uid(),
      kind: record.kind,
      amountCents: record.amountCents,
      categoryId: defaultCategoryId ?? null,
      accountId: defaultAccountId ?? null,
      toAccountId: null,
      occurredAt: record.occurredAt,
      note: record.note ?? '',
      shares: [],
      recurringId: null,
      source: 'import',
      createdAt: now,
      updatedAt: now
    });
  }
  return { fresh, duplicates };
}

// 单事务批量写入：中途任一条写失败（配额满、标签页被杀）就整批回滚，
// 不会留下「导入了一半」的库，用户重试也不会撞上重复。
export async function commitImport(records) {
  const list = records ?? [];
  if (list.length === 0) return [];
  await db.putAll(list.map(value => ({ store: 'txns', value })));
  return list.map(r => r.id);
}

// 只删本次导入生成的 id：撤销一次导入不会碰到用户已有的账。
export async function undoImport(ids) {
  const list = ids ?? [];
  if (list.length === 0) return;
  await db.removeAll(list.map(key => ({ store: 'txns', key })));
}

export async function listProfiles() {
  const value = await getSetting('importProfiles', []);
  return Array.isArray(value) ? value : [];
}

// 带 id 且能命中已有项就是覆盖，否则追加。
export async function saveProfile({ id = null, name, mapping }) {
  const profiles = await listProfiles();
  const target = id ? profiles.find(p => p.id === id) : null;
  const next = {
    id: target ? target.id : uid(),
    name: String(name ?? ''),
    mapping: { ...(mapping ?? {}) }
  };
  const out = target
    ? profiles.map(p => (p.id === target.id ? next : p))
    : [...profiles, next];
  await setSetting('importProfiles', out);
  return out;
}

export async function deleteProfile(id) {
  const out = (await listProfiles()).filter(p => p.id !== id);
  await setSetting('importProfiles', out);
  return out;
}
