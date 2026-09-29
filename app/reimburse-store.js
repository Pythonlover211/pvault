// 报销单的数据层：UI 与 IndexedDB 之间的唯一通道。
// 依赖 db.js（进而依赖 indexedDB），**不能在 Node 里 import**；验证靠 fake-IndexedDB 探针与真机。
//
// 本模块最重要的一条纪律：**每条写操作只用一次批量写调用**（db.putAll 或 db.replaceAllRecords）。
// 报销流程天然是多处写入的（一单对应 N 张票、到账对应一笔交易 + 一条报销单 + 一个 txnId），
// 拆成两次写一旦中途失败，就会留下自相矛盾的库——「报销单建好了、票还没挂上去」
// 或者「钱记上了、报销单还停在已提交」（后者更糟：用户会重试，于是记出第二笔收入）。
// db.replaceAllRecords 与 importBackup 的注释讲的是同一条纪律。
//
// 这条纪律由 tests/reimburse-store.test.js 的**事务计数**守着：
// 拆成两次调用会让计数变成 2，那条断言立刻红。

import * as db from './db.js';
import { uid } from './store.js';
// canSubmit / canSettle / isStatus 在本文件里暂时**没有调用点**：提交、到账、删除这三个写函数
// 由计划任务 5 追加在同一个文件里，判据就用它们。现在把它们一起引进来，是为了让「状态机只从
// reimburse-model 进」这条线一眼看得出来——数据层不许自己写 `status === 'draft'` 那种字面量判断，
// 否则状态机一改（比如允许草稿直接到账），改的是一处、漏的是另一处，而且不报错。
import { canEdit, canSubmit, canSettle, isStatus, STATUS } from './reimburse-model.js';

// 与 invoices 侧的那一对常量同名同值（app/schema.js 里没有它们的定义，
// 键名散在 invoice-store / theme-store 两处）。这里只需要发票侧的 reimbursementId 字段名。
const INVOICE_STORE = 'invoices';
const REIMB_STORE = 'reimbursements';

export class ReimburseError extends Error {
  constructor(message, code = 'BAD_INPUT') {
    super(message);
    this.name = 'ReimburseError';
    this.code = code;
  }
}

// ===== 读 =====

export async function listReimbursements() {
  const all = await db.getAll(REIMB_STORE);
  // 创建时间倒序；同一毫秒的按 id 兜底，保证顺序稳定（否则每次打开列表顺序都在变）。
  return all.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || String(a.id).localeCompare(String(b.id)));
}

export async function getReimbursement(id) {
  if (!id) return null;
  return (await db.get(REIMB_STORE, id)) ?? null;
}

/**
 * 某一单里的发票。走 by_reimbursement 索引——**这里可以走索引**，
 * 因为索引键（reimbursementId）非空；要查的正是「键等于某个值」的记录。
 */
export async function listInvoicesOf(reimbId) {
  if (!reimbId) return [];
  const hits = await db.getAllByIndex(INVOICE_STORE, 'by_reimbursement', reimbId);
  // 索引查询的顺序实际是随机的（同一个索引键下按随机 uid 排），
  // 与 invoice-store.js 的 listInvoices 用同一套排序，保证每次打开顺序一致。
  return hits.sort((a, b) => (b.issuedAt ?? 0) - (a.issuedAt ?? 0) || (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

/**
 * 待报销的发票：既没存档、也不在任何报销单里。
 *
 * **必须 getAll 之后自己 filter，绝不能用 by_reimbursement 索引去查「没有报销单」的票**：
 * 真实 IndexedDB **不索引**键值为 null / undefined 的记录，`IDBKeyRange.only(null)`
 * 还会直接抛 DataError（app/schema.js:25 那段注释讲的就是这个坑，连 index.count()
 * 都会给出一个偏小的数而且看不出来错）。
 */
export async function listPendingInvoices() {
  const all = await db.getAll(INVOICE_STORE);
  return all
    .filter(inv => !inv.archived && !inv.reimbursementId)
    .sort((a, b) => (b.issuedAt ?? 0) - (a.issuedAt ?? 0) || (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

// ===== 内部：发票进出的校验 =====

/**
 * 把一批发票的 reimbursementId 改掉（置为 reimbId，或置 null 表示移出）。
 *
 * 返回 `{ entries, skipped }`：entries 是**待写入的条目**，由调用方并进自己那一次批量写——
 * 这个函数自己**不发事务**，否则「建单 + 挂票」就变成两次写了（见文件头那条纪律）。
 *
 * 两种处置不一样，判据是**用户有没有做错事**：
 *  · 已经在**别的**单里 → 跳过。这多半是列表打开之后的状态变化（另一个标签页先建了单），
 *    用户没做错，不该被一个报错打断整批操作；
 *  · `archived` → **抛错**。「仅存档」是用户亲手动过的标记，它在这条流水线里是明确的排除项
 *    （发票规格 §6.1），选中它说明界面给了他一个不该给的选择，必须停下来讲清楚。
 */
async function invoiceEntriesFor(invoiceIds, reimbId) {
  const entries = [];
  const skipped = [];
  for (const id of invoiceIds ?? []) {
    const inv = await db.get(INVOICE_STORE, id);
    if (!inv) continue;                                   // 已经被删掉的票：静默略过
    if (inv.archived) {
      throw new ReimburseError('这张发票标了「仅存档」，不参与报销', 'ARCHIVED_INVOICE');
    }
    const current = inv.reimbursementId ?? null;
    if (current === reimbId) continue;                    // 已经在本单里：幂等跳过
    if (current) { skipped.push(id); continue; }          // 在别的单里：跳过并报出来
    entries.push({
      store: INVOICE_STORE,
      value: { ...inv, reimbursementId: reimbId, updatedAt: Date.now() }
    });
  }
  return { entries, skipped };
}

// ===== 写（每条一个事务）=====

/**
 * 建一张报销单，并把 invoiceIds 里能挂的票挂上去。
 * 报销单本身与 N 张发票的归属关系**在同一个事务里**落地：分两次写会留下
 * 「单建好了、票还没挂上去」——用户看到一张空单，而票还在待报销里。
 */
export async function createReimbursement({ invoiceIds = [], title = '', now = Date.now() } = {}) {
  const reimb = {
    id: uid(),
    title: String(title ?? '').trim() || '未命名报销',
    status: STATUS.DRAFT,
    createdAt: now,
    submittedAt: null,
    settledAt: null,
    accountId: null,
    txnId: null,
    settledCents: null,
    note: ''
  };
  const { entries, skipped } = await invoiceEntriesFor(invoiceIds, reimb.id);
  await db.putAll([{ store: REIMB_STORE, value: reimb }, ...entries]);
  return { ...reimb, skipped };
}

export async function renameReimbursement(id, title) {
  const reimb = await getReimbursement(id);
  if (!reimb) throw new ReimburseError('这张报销单不在了', 'NOT_FOUND');
  if (!canEdit(reimb)) throw new ReimburseError('已经提交给公司的报销单不能修改', 'NOT_EDITABLE');
  const next = { ...reimb, title: String(title ?? '').trim() || reimb.title };
  await db.putAll([{ store: REIMB_STORE, value: next }]);
  return next;
}

export async function addInvoicesTo(id, invoiceIds) {
  const reimb = await getReimbursement(id);
  if (!reimb) throw new ReimburseError('这张报销单不在了', 'NOT_FOUND');
  if (!canEdit(reimb)) throw new ReimburseError('已经提交给公司的报销单不能修改', 'NOT_EDITABLE');
  const { entries, skipped } = await invoiceEntriesFor(invoiceIds, id);
  // 空清单要早退：db.putAll([]) 里 names 是空数组，db.transaction([]) 抛的是 InvalidAccessError，
  // **不是** no-op（db.js 中 putAll 上方那段注释就是这条调用方契约）。加的都是已在别的单里的票时
  // 就会走到这里——那本该是「什么都没发生」，不该反过来把界面炸掉。
  if (entries.length === 0) return { skipped };
  await db.putAll(entries);
  return { skipped };
}

export async function removeInvoiceFrom(id, invoiceId) {
  const reimb = await getReimbursement(id);
  if (!reimb) throw new ReimburseError('这张报销单不在了', 'NOT_FOUND');
  if (!canEdit(reimb)) throw new ReimburseError('已经提交给公司的报销单不能修改', 'NOT_EDITABLE');
  const inv = await db.get(INVOICE_STORE, invoiceId);
  if (!inv || inv.reimbursementId !== id) return;
  await db.putAll([
    { store: INVOICE_STORE, value: { ...inv, reimbursementId: null, updatedAt: Date.now() } }
  ]);
}
