// 导入仓库层：把 import-schema.js 解析出来的记录落进库里，并管理导入格式配置。
// 依赖 db.js（进而依赖 indexedDB 浏览器全局），因此不能在 Node 里被 import，
// 验证方式见 docs/手动验证清单.md 的「台账导入」小节。

import * as db from './db.js';
import { uid, getSetting, setSetting } from './store.js';
import { makeFingerprint } from './import-parse.js';

// ── 去重口径 ────────────────────────────────────────────────────────────────
// 指纹 = 时间 + 金额 + 收支方向 + 商户（实现见 import-parse.js 的 makeFingerprint）。
// 取舍：宁可少导，也不重复导。同一笔在微信和支付宝各导出一次、或同一个文件导入两次，
// 都会被认成重复；代价是**解析精度内**同商户同金额同方向的两笔真实消费也会被判重复
// （只有日期没有时间的源文件，这个窗口是一整天）。所以向导里必须把跳过条数显示出来，
// 让用户看得见丢了多少，并且必须给一个「仍然导入」的出口。
//
// 两侧口径必须严格对称：库里的交易没有 merchant 字段，只有 note，所以 makeFingerprint
// 统一从 note 用 merchantFromNote 反解商户（写入侧与读库侧都调它）。这里**不再**自己
// 实现一份反解——两处实现一旦漂移，同一份账单二次导入就会静默翻倍。
// 反解函数只有一份实现（import-parse.js），这里转出去只是让老调用方与探针能按原路径取用。
export { merchantFromNote } from './import-parse.js';

// 库里已有交易的指纹集合。每条都现算而不是存字段：指纹算法将来改了，
// 存量数据不需要迁移也能跟上。
export async function existingFingerprints() {
  const all = await db.getAll('txns');
  return new Set(all.map(txn => makeFingerprint({
    occurredAt: txn.occurredAt,
    amountCents: txn.amountCents,
    kind: txn.kind,
    note: txn.note
  })));
}

function fingerprintOf(record) {
  // mapRows 已经算好指纹（那时 note 还在手上），优先用它；调用方直接构造记录时再回退到
  // 现算——两条路径都经过 makeFingerprint 的同一个 note 反解，所以结果必然一致。
  return record.fingerprint ?? makeFingerprint({
    occurredAt: record.occurredAt,
    amountCents: record.amountCents,
    kind: record.kind,
    note: record.note
  });
}

// 过滤掉库里已有的（以及同一批里自己重复的），给剩下的补上入库所需的字段。
// 只准备、不写入：用户要先在向导里看到「新增 N 条、跳过 M 条」再确认。
//
// defaultIncomeCategoryId 是 L1 修复加的参数：收入记录必须拿**收入**分类。原来所有记录
// 都套用支出默认分类，导入一份含收入的账单（微信/支付宝必有「二维码收款」「退款」）就会
// 写出 kind: 'income' + categoryId: 'cat-food'，而 summary.byCategory 只按交易的 kind 过滤、
// 不校验分类自身的 kind —— 收入环形图里冒出「🍜 餐饮 ¥88」，首页工资显示成「🍜 餐饮 +12000」。
// 兼容：不传它时回落到 defaultCategoryId（旧调用方的行为不变）。
// 一条解析记录 → 一条可入库的交易。
// prepareImport（新增记录）与 materializeImport（「仍然导入」那批重复记录）共用它，
// 否则强行导入写出来的记录会和正常路径长得不一样（缺 id / 缺 source / 缺分类），
// 撤销也删不掉。
function toTransaction(record, { defaultCategoryId, incomeCategoryId, defaultAccountId, now }) {
  // 按收支方向取对应 kind 的默认分类；transfer 保持 null，由统计页的内置「转账」伪分类
  // （summary.js 的 TRANSFER_CATEGORY_ID）兜住——它本来就没有真实分类。
  let categoryId = null;
  if (record.kind === 'expense') categoryId = defaultCategoryId ?? null;
  else if (record.kind === 'income') categoryId = incomeCategoryId ?? null;
  return {
    id: uid(),
    kind: record.kind,
    amountCents: record.amountCents,
    categoryId,
    accountId: defaultAccountId ?? null,
    toAccountId: null,
    occurredAt: record.occurredAt,
    note: record.note ?? '',
    shares: [],
    recurringId: null,
    source: 'import',
    createdAt: now,
    updatedAt: now
  };
}

const resolveIncomeCategoryId = (defaultCategoryId, defaultIncomeCategoryId) =>
  (defaultIncomeCategoryId === undefined ? defaultCategoryId : defaultIncomeCategoryId);

export async function prepareImport(records, {
  defaultCategoryId = null, defaultIncomeCategoryId = undefined, defaultAccountId = null
} = {}) {
  const existing = await existingFingerprints();
  const incomeCategoryId = resolveIncomeCategoryId(defaultCategoryId, defaultIncomeCategoryId);
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
    fresh.push(toTransaction(record, { defaultCategoryId, incomeCategoryId, defaultAccountId, now }));
  }
  return { fresh, duplicates };
}

// 「仍然导入」出口用：把一批**已被判为疑似重复**的记录补成可入库的交易。
// 不做去重（用户已经看过提醒并确认「明知重复也要导」），其余与 prepareImport 完全一致。
export function materializeImport(records, {
  defaultCategoryId = null, defaultIncomeCategoryId = undefined, defaultAccountId = null
} = {}) {
  const incomeCategoryId = resolveIncomeCategoryId(defaultCategoryId, defaultIncomeCategoryId);
  const now = Date.now();
  return (records ?? []).map(record =>
    toTransaction(record, { defaultCategoryId, incomeCategoryId, defaultAccountId, now }));
}

// 单事务批量写入：中途任一条写失败（配额满、标签页被杀）就整批回滚，
// 不会留下「导入了一半」的库，用户重试也不会撞上重复。
export async function commitImport(records) {
  const list = records ?? [];
  // 空数组在这里就返回，是**隐式调用方契约的一半**：db.putAll([]) 的 db.transaction([])
  // 抛的是 InvalidAccessError（不是 no-op），传空数组进来会 reject 而不是安静地不做。
  if (list.length === 0) return [];
  for (const r of list) {
    // 撤销靠 id 定位（undoImport 只删本次导入的 id）。少了 id 的记录写得进去却删不掉，
    // 撤销会留下半截数据，所以宁可在写入前就整批拒绝。
    if (typeof r?.id !== 'string' || r.id === '') {
      throw new Error('导入记录缺少 id：请先经 prepareImport / materializeImport 生成记录再写入');
    }
  }
  await db.putAll(list.map(value => ({ store: 'txns', value })));
  return list.map(r => r.id);
}

// 只删本次导入生成的 id：撤销一次导入不会碰到用户已有的账。
// 空数组直接返回的原因同 commitImport：db.removeAll([]) 会因 InvalidAccessError 而 reject。
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
