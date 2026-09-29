// 仓库层：UI 与 IndexedDB 之间的唯一通道。
// 所有视图只通过本模块读写数据，不直接引用 db.js。
// 本模块依赖 db.js（进而依赖 indexedDB / IDBKeyRange 浏览器全局），所以**它的读写行为**不能在
// Node 里直接验，验证方式见 docs/手动验证清单.md 的「仓库层」小节。
// （订正：原文写的是「因此不能在 Node 里被 import」，那是句站不住的全称判断——模块体本身不碰
// 浏览器全局，装好 tests/helpers/fake-browser.js 之后可以在 Node 里 import：tests/store-transaction.test.js
// 就是这么做的。它钉住的是 addTransaction 的**数据形状**；真实浏览器的事务语义、配额与失败路径
// 仍然只能在上面那份清单的真机条目里验。）

import * as db from './db.js';
import { monthRange } from './dates.js';

// crypto.randomUUID 只在安全上下文（HTTPS / localhost）可用；用手机通过局域网地址
// （http://192.168.1.8:8080）打开时它是 undefined，一点「完成」就报错。
// 因此回落成时间戳 + 随机数：同一毫秒内碰撞概率极低，且与 UUID 一样只要求本地唯一。
export const uid = () =>
  (globalThis.crypto?.randomUUID?.() ??
    `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

export async function listAccounts() {
  const all = await db.getAll('accounts');
  return all.filter(a => !a.archived).sort((a, b) => a.sort - b.sort);
}

export async function listAllAccounts() {
  return (await db.getAll('accounts')).sort((a, b) => a.sort - b.sort);
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

// extraEntries：调用方要把自己的条目写进**同一个事务**时用它。
//
// 存在的理由是报销到账：那一步要同时写一笔收入交易、更新报销单状态、再把 txnId 记回报销单。
// 分两次写一旦中途失败，会留下「钱记上了、报销单还停在已提交」——而用户看到没成功就会
// 再点一次「标记到账」，于是记出**第二笔收入**。宁可控整笔失败。
// （db.replaceAllRecords 的注释、backup-store 的导入注释讲的是同一条纪律。）
//
// 默认参数保证了既有调用点一个字都不用改。
export async function addTransaction(input, { extraEntries = [] } = {}) {
  const now = Date.now();
  const txn = {
    // 允许调用方指定 id：报销到账要在**同一个事务**里把 txnId 写进报销单，
    // 而那要求交易 id 在调用之前就已知（见 reimburse-store.js 的 settleReimbursement——
    // 那个文件由计划任务 4 建立、settleReimbursement 由任务 5 补上，现在都还不存在）。
    // 既有调用点都不传，行为不变。
    // 传一个**已存在**的 id 会静默覆盖那笔交易（db.putAll 走 objectStore.put，同主键即覆盖），
    // 而它先前派生的应收**不会**跟着变——那条 receivables 的 sourceTxnId 仍指向它，主交易却已被
    // 改写，库里留下一对自相矛盾的记录，全程不报错。要改一笔已有的交易请用 updateTransaction。
    id: input.id ?? uid(),
    kind: input.kind,
    amountCents: input.amountCents,
    categoryId: input.categoryId ?? null,
    accountId: input.accountId ?? null,
    toAccountId: input.toAccountId ?? null,
    occurredAt: input.occurredAt ?? now,
    note: input.note ?? '',
    shares: input.shares ?? [],
    recurringId: input.recurringId ?? null,
    source: input.source ?? 'manual',
    // 报销到账生成的收入账会带上它。这个对象是**重建**出来的，没列在这里的字段
    // 会被静默丢掉——而删除保护（删报销单时问「那笔收入要不要一起删」）正是靠
    // 报销单上的 txnId 找回这条交易的，链子断在这里不会报错，只会在删除时找不到它。
    reimbursementId: input.reimbursementId ?? null,
    createdAt: now,
    updatedAt: now
  };
  // 交易与它派生的应收必须同一个事务写入：分次写一旦中途失败（配额满、标签页被杀），
  // 会留下「钱记上了、别人欠我的却少了」的半截数据，而用户重试还会插入第二笔交易。
  const entries = [{ store: 'txns', value: txn }];
  for (const share of txn.shares) {
    entries.push({
      store: 'receivables',
      value: {
        id: uid(),
        personName: share.personName,
        direction: 'owedToMe',
        amountCents: share.amountCents,
        occurredAt: txn.occurredAt,
        dueAt: null,
        settledAt: null,
        note: txn.note,
        sourceTxnId: txn.id
      }
    });
  }
  // 额外的条目追加在最后，由**同一个** putAll 写下去——这就是「同事务」的全部实现。
  // 追加在**主交易之后**有代价：同主键时后面的赢（objectStore.put 逐条覆盖），额外条目若也写
  // `txns` 且撞上 txn.id，就会顶掉刚写下去的主交易，而函数返回的还是被顶掉的那个对象——
  // 调用方拿到一个与库里对不上的 txn。所以额外条目别写 `txns`。
  await db.putAll(entries.concat(extraEntries));
  return txn;
}

export async function updateTransaction(txn) {
  await db.put('txns', { ...txn, updatedAt: Date.now() });
}

export async function deleteTransaction(id) {
  const receivables = await db.getAll('receivables');
  // 只删未结清的派生应收：已结清的是真实发生过的债权历史，删除交易不该抹掉它。
  const entries = receivables
    .filter(r => r.sourceTxnId === id && !r.settledAt)
    .map(r => ({ store: 'receivables', key: r.id }));
  entries.push({ store: 'txns', key: id });
  await db.removeAll(entries);
}

/**
 * 按 id 取单笔交易；没这条记录返回 null。
 *
 * 存在的理由：**有些地方要问的不是「这段时间有哪些账」，而是「那一笔还在不在」**。
 * 眼下唯一的调用点是报销单详情页——它要判断自己生成的那笔收入是不是已经被删掉了
 * （规格 §8 要求显示「那笔收入已被删除」，而报销到账的那笔收入可能落在任何时间点上）。
 *
 * 在此之前，仓库层只有按时间范围取的口子，于是一模一样的问题在 invoice-editor.js 里
 * 只能用一次 **120 个月**的时间窗去猜（见那里 LINKED_LOOKBACK_MONTHS 的注释：票往往是
 * 过后才挂上去的，窗口开小了会把还在的账误报成「已不存在」——那是没有这条路时的退路）。
 * 新调用点请用这个函数，别再拉一个宽到离谱的时间窗回来自己 find。
 */
export async function getTransaction(id) {
  if (!id) return null;
  // 空 id 直接返回，不把 undefined 当主键塞给 db.get：那是英文的 DataError，而调用方的
  // 语义只是「没有 id 就没有这笔账」——与 reimburse-store.getReimbursement 同一处置。
  return (await db.get('txns', id)) ?? null;
}

// end 为开上界，调用方应传「下月/次日 0 点」（与 dates.js 的 monthRange/dayRange 的 end 一致）
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

export async function addReceivable(input) {
  const record = {
    id: uid(),
    personName: input.personName,
    direction: input.direction,
    amountCents: input.amountCents,
    occurredAt: input.occurredAt ?? Date.now(),
    dueAt: input.dueAt ?? null,
    settledAt: null,
    note: input.note ?? '',
    sourceTxnId: input.sourceTxnId ?? null
  };
  await db.put('receivables', record);
  return record;
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
