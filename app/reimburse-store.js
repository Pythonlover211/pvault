// 报销单的数据层：UI 与 IndexedDB 之间的唯一通道。
// 依赖 db.js（进而依赖 indexedDB），**不能在 Node 里 import**；验证靠 fake-IndexedDB 探针与真机。
//
// 本模块最重要的一条纪律：**每条写操作只用一次批量写调用**（db.putAll 或 db.replaceAllRecords）。
// 报销流程天然是多处写入的（一单对应 N 张票、到账对应一笔交易 + 一条报销单 + 一个 txnId），
// 拆成两次写一旦中途失败，就会留下自相矛盾的库——「报销单建好了、票还没挂上去」
// 或者「钱记上了、报销单还停在已提交」（后者更糟：用户会重试，于是记出第二笔收入）。
// db.replaceAllRecords 与 importBackup 的注释讲的是同一条纪律。
//
// 这条纪律由两处一起守着：结构上是下面的 writeAll——本文件所有写都从它出去，想拆成两次就绕不开它；
// 断言上是 tests/reimburse-store.test.js 的**事务计数**（拆成两次调用会让计数变成 2，那条立刻红）。
// 两者缺一不可：只有计数时，writeAll 里那句「英文异常翻成人话」照样没人管；只有 writeAll 时，
// 一个逐张写十次、每次都合法地走一次 writeAll 的实现也不会被谁发现。

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
  // 索引查询的顺序与时间无关：同一个索引键下的多条记录按**主键**排，而主键是随机 uid
  // （两次调用其实拿到的顺序相同，但用户看不出任何道理，换一次数据迁移就可能变）。
  // 所以这里统一排成「开票日期倒序、同一日的按录入时间倒序」，与 invoice-store.js 的
  // listInvoices 同一套口径——同一个单里的票，在发票列表和报销单详情里顺序不一致是说不通的。
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

// ===== 内部：写的前置检查与唯一的写入出口 =====

/**
 * 这张报销单必须还在，否则 NOT_FOUND。
 *
 * 单列一层不是为了少写一行：**判据漏写不报错**。少了这句，一个不存在的 id 会继续往下走，
 * 一直走到某个更远的地方才变成「往库里写了一条没有归属的记录」或者「把别的单的票摘走了」，
 * 而那些都是静默失败——出错现场早就不在原处了。本文件的三个写函数与计划任务 5 的
 * submit / settle 第一步逐字相同，五处都从这里过。
 */
async function requireReimbursement(id) {
  const reimb = await getReimbursement(id);
  if (!reimb) throw new ReimburseError('这张报销单不在了', 'NOT_FOUND');
  return reimb;
}

/**
 * 这张报销单必须处于 predicate 放行的状态，否则抛出 message / code。
 *
 * 谓词**整个传进来**（canEdit / canSubmit / canSettle），不在这里写 `status === 'draft'`：
 * 状态机只从 reimburse-model 进，白名单放行谁，改一处就够。也**不要**传 `() => canEdit(r)`
 * 那样的 lambda——包一层之后「这个函数按哪条白名单放行」就藏进闭包里了，
 * 读代码的人要多跳一次才能确认它到底在挡什么。
 *
 * `deleteReimbursement`（任务 5）写的是 `if (!reimb) return`，与这里抛 NOT_FOUND 不一致。
 * 那是任务 5 的范围，本文件不替它决定，留这句话只是免得后来者以为是漏改。
 */
function requireStatus(reimb, predicate, message, code) {
  if (!predicate(reimb)) throw new ReimburseError(message, code);
  return reimb;
}

/**
 * 「必须存在 + 必须还能编辑」——本文件三个写函数的入口。
 * 合成一个而不是让三处各写两行，是因为那句文案要**一模一样**地出现在每一处：
 * 复制到五份（任务 5 还会再加两处）之后，改文案时只要漏掉一处，
 * 用户就会在同一个 App 里看到两种说法，而没有任何地方会报错。
 */
async function requireEditable(id) {
  const reimb = await requireReimbursement(id);
  return requireStatus(reimb, canEdit, '已经提交给公司的报销单不能修改', 'NOT_EDITABLE');
}

/**
 * **所有写都走这里**：一处发起事务、一处把英文异常翻成人话。
 *
 * 为什么不让 db.putAll 的错误直接冒泡：界面上会显示「保存失败：QuotaExceededError: …」，
 * 用户既不知道发生了什么，也不知道下一步该做什么。app/invoice-store.js 的 putInvoice
 * 已经为同一个异常写过一句能照着做的中文——同一个异常在两处必须说同一种人话，
 * 否则一处给建议、一处甩英文，政策就不统一了。
 *
 * 顺带把「一次写 = 一次批量调用」变成结构性的：四个写函数全部经过它，
 * 谁再想拆出第二次 db.putAll，得先绕开这一层——那是个显眼的动作，不是随手多写一行 await。
 */
async function writeAll(entries) {
  try {
    await db.putAll(entries);
  } catch (err) {
    // 配额写满是这台手机上最可能撞到的失败：挂十几张票的批量更新，一次就是几十 KB。
    if (err?.name === 'QuotaExceededError') {
      const quota = new Error('手机存储空间不够了，这次报销改动没存下。可以先去「记账 → 备份」导出一份并清理旧数据再试。');
      // 沿用原 name：界面读的是 message（已经是中文人话），控制台与排查时仍认得出这是配额失败，
      // 不至于退化成一个无从追查的普通 Error。
      quota.name = err.name;
      throw quota;
    }
    // 其余存储失败（UnknownError / AbortError / DatabaseClosedError……，以及 enqueue 里同步抛出的
    // DataError）给用户一句中文，原文进控制台留给排查——这里**不**沿用 err.name
    // （那些 name 对用户毫无信息量，界面只读 message）。
    console.error('报销单写入失败', err);
    throw new Error('这次报销改动没存下来（手机存储出错）。请确认存储空间还够，然后重试一次。');
  }
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
  await writeAll([{ store: REIMB_STORE, value: reimb }, ...entries]);
  // 返回两件，而不是 `{ ...reimb, skipped }`：后者会让**同一个实体有两种形状**——
  // getReimbursement 读回来的是纯记录（规格字段表里没有 skipped），这里却是个混了界面信息的对象。
  // 谁照着返回值把字段抄进下一次写入（改名、改状态那类代码就是照抄这个字段列表写的），
  // skipped 就跟着进了库，而这件事没有任何地方会报错。与 addInvoicesTo 的返回形状对齐。
  return { reimb, skipped };
}

export async function renameReimbursement(id, title) {
  const reimb = await requireEditable(id);
  const next = { ...reimb, title: String(title ?? '').trim() || reimb.title };
  await writeAll([{ store: REIMB_STORE, value: next }]);
  return next;
}

export async function addInvoicesTo(id, invoiceIds) {
  await requireEditable(id);
  const { entries, skipped } = await invoiceEntriesFor(invoiceIds, id);
  // 空清单要早退：db.putAll([]) 里 names 是空数组，db.transaction([]) 抛的是 InvalidAccessError，
  // **不是** no-op（db.js 中 putAll 上方那段注释就是这条调用方契约）。加的都是已在别的单里的票时
  // 就会走到这里——那本该是「什么都没发生」，不该反过来把界面炸掉。
  if (entries.length === 0) return { skipped };
  await writeAll(entries);
  return { skipped };
}

export async function removeInvoiceFrom(id, invoiceId) {
  await requireEditable(id);
  const inv = await db.get(INVOICE_STORE, invoiceId);
  // 归属校验：只动**属于本单**的票。少了这一行，对 A 单调 removeInvoiceFrom 一张其实属于 B 单的
  // 票，会把 B 单里那张票的 reimbursementId 置成 null——B 单凭空少一张票，A 单什么也没变，
  // 用户根本看不出是哪一步弄丢的。界面不会给出这种选择，但列表是几分钟前渲染的：
  // 详情页或另一个标签页完全可能已经把这张票挪走了，这个函数的入参是 id，不是它读到的对象。
  // （票不存在、也不在本单 → 静默返回，与 invoiceEntriesFor 里「已被删掉的票静默略过」同一条口径。）
  if (!inv || inv.reimbursementId !== id) return;
  await writeAll([
    { store: INVOICE_STORE, value: { ...inv, reimbursementId: null, updatedAt: Date.now() } }
  ]);
}
