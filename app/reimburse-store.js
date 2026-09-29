// 报销单的数据层：UI 与 IndexedDB 之间的唯一通道。
// 依赖 db.js（进而依赖 indexedDB），**不能在 Node 里 import**；验证靠 fake-IndexedDB 探针与真机。
//
// 本模块最重要的一条纪律：**每条写操作只用一次批量写调用**（db.putAll 或 db.replaceAllRecords）。
// 报销流程天然是多处写入的（一单对应 N 张票、到账对应一笔交易 + 一条报销单 + 一个 txnId），
// 拆成两次写一旦中途失败，就会留下自相矛盾的库——「报销单建好了、票还没挂上去」
// 或者「钱记上了、报销单还停在已提交」（后者更糟：用户会重试，于是记出第二笔收入）。
// db.replaceAllRecords 与 importBackup 的注释讲的是同一条纪律。
//
// 这条纪律由两处一起守着：结构上是下面的 writeAll——**能一次 putAll 写完的写都从这里出去**，
// 想拆成两次就绕不开它；断言上是 tests/reimburse-store.test.js 的**事务计数**
// （拆成两次调用会让计数变成 2，那条立刻红）。
// 两者缺一不可：只有计数时，writeAll 里那句「英文异常翻成人话」照样没人管；只有 writeAll 时，
// 一个逐张写十次、每次都合法地走一次 writeAll 的实现也不会被谁发现。
//
// **writeAll 不是唯一出口，有两处例外**——这句「所有写都从这里出去」曾经是假的（settle 的记账支
// 与 delete 绕过它，「英文异常翻成人话」也就跟着漏了），所以清单写在这里，免得再被读成一句空话：
//  · settleReimbursement 的记账那支走 addTransaction 的 extraEntries——报销单那一条必须与交易
//    同批写下去，而 writeAll 只会 putAll 一次、拿不到 addTransaction 的事务。它**自己翻异常**，
//    用的是与 writeAll 同一句人话（同一个 toUserError）；
//  · deleteReimbursement 走 db.replaceAllRecords——它要在同一个事务里既删记录（删单、可选的删交易）
//    又写记录（把票退回待报销），而 putAll 只会写、不会删。它**不翻异常**，与
//    invoice-store.deleteInvoice 同一处置，理由写在它自己的 JSDoc 里。

import * as db from './db.js';
import { uid, addTransaction } from './store.js';
// isStatus 在本文件里暂时**没有调用点**：它留给「读到一个脏 status」时兜底用（备份恢复、
// 手改过的记录都可能带进来）。提交 / 到账 / 删除这三个写函数用的是 canSubmit / canSettle，
// 判据都从这一个 import 进。把状态机集中在这一行，是为了让「数据层不许自己写
// `status === 'draft'` 那种字面量判断」这条线一眼看得出来——否则状态机一改（比如允许
// 草稿直接到账），改的是一处、漏的是另一处，而且不报错。
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

/**
 * 「把票退回待报销」那一条 entry：清掉 reimbursementId、更新时间戳。
 *
 * 抽出来是因为它有**两个写点**——removeInvoiceFrom 的手动移票、deleteReimbursement 的删单退票——
 * 而两处各写一遍同一个字面量时，将来加一个字段（比如给票记上「曾被哪一单用过」）只改一处，
 * 就会让「手动移出」与「删单退回」得到两种形状的票，且不报错。这与 createReimbursement
 * 那里警告的「同一实体两种形状」是同一种病。
 */
function detachEntry(inv, now) {
  return { store: INVOICE_STORE, value: { ...inv, reimbursementId: null, updatedAt: now } };
}

// ===== 内部：写的前置检查与唯一的写入出口 =====

/**
 * 这张报销单必须还在，否则 NOT_FOUND。
 *
 * 单列一层不是为了少写一行：**判据漏写不报错**。少了这句，一个不存在的 id 会继续往下走，
 * 一直走到某个更远的地方才变成「往库里写了一条没有归属的记录」或者「把别的单的票摘走了」，
 * 而那些都是静默失败——出错现场早就不在原处了。本文件的**五处写**（rename / addInvoicesTo /
 * removeInvoiceFrom / submitReimbursement / settleReimbursement）第一步逐字相同，都从这里过；
 * 另外两处是**有意的不同**，不是漏改：createReimbursement 得先生成 id 才能挂票，
 * deleteReimbursement 对不存在的单当幂等成功（见它自己的 JSDoc）。
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
 * `deleteReimbursement` 刻意不用这里抛 NOT_FOUND 的处置（删一张不存在的单当幂等成功），
 * 见它自己的 JSDoc——那是**有意的不同**，不是漏改。
 */
function requireStatus(reimb, predicate, message, code) {
  if (!predicate(reimb)) throw new ReimburseError(message, code);
  return reimb;
}

/**
 * 「必须存在 + 必须还能编辑」——可编辑的那三个写函数的入口。
 * 合成一个而不是让每个调用方各写两行，是因为那句文案要**一模一样**地出现在每一处：
 * 复制到多份之后，改文案时只要漏掉一处，用户就会在同一个 App 里看到两种说法，
 * 而没有任何地方会报错。（submit / settle 要的是别的状态、别的文案，走的是 requireStatus 那一层。）
 */
async function requireEditable(id) {
  const reimb = await requireReimbursement(id);
  return requireStatus(reimb, canEdit, '已经提交给公司的报销单不能修改', 'NOT_EDITABLE');
}

/**
 * 把存储异常翻成用户看得懂的一句中文——**本文件唯一一处翻译**。
 *
 * 为什么不让 db 的错误直接冒泡：界面上会显示「保存失败：QuotaExceededError: …」，
 * 用户既不知道发生了什么，也不知道下一步该做什么。app/invoice-store.js 的 putInvoice
 * 已经为同一个异常写过一句能照着做的中文——同一个异常在两处必须说同一种人话，
 * 否则一处给建议、一处甩英文，政策就不统一了。
 *
 * 独立成一个函数、而不是留在 writeAll 的 catch 里：**writeAll 不是唯一出口**（见文件头那份清单），
 * 而「翻成人话」这件事不该因为走了另一条写入路径就失效——settleReimbursement 的记账那支
 * 走的是 addTransaction，那里的异常必须由它自己接上这一层。
 */
function toUserError(err) {
  // 配额写满是这台手机上最可能撞到的失败：挂十几张票的批量更新，一次就是几十 KB。
  if (err?.name === 'QuotaExceededError') {
    const quota = new Error('手机存储空间不够了，这次报销改动没存下。可以先去「记账 → 备份」导出一份并清理旧数据再试。');
    // 沿用原 name：界面读的是 message（已经是中文人话），控制台与排查时仍认得出这是配额失败，
    // 不至于退化成一个无从追查的普通 Error。
    quota.name = err.name;
    return quota;
  }
  // 其余存储失败（UnknownError / AbortError / DatabaseClosedError……，以及 enqueue 里同步抛出的
  // DataError）给用户一句中文，原文进控制台留给排查——这里**不**沿用 err.name
  // （那些 name 对用户毫无信息量，界面只读 message）。
  console.error('报销单写入失败', err);
  return new Error('这次报销改动没存下来（手机存储出错）。请确认存储空间还够，然后重试一次。');
}

/**
 * **能一次 putAll 写完的写都走这里**：一处发起事务、一处把英文异常翻成人话（toUserError）。
 *
 * 顺带把「一次写 = 一次批量调用」变成结构性的：谁再想拆出第二次 db.putAll，得先绕开这一层——
 * 那是个显眼的动作，不是随手多写一行 await。绕开它的那两处见文件头清单：
 * 一处自己翻异常（settle 的记账支）、一处有意不翻（delete）。
 */
async function writeAll(entries) {
  try {
    await db.putAll(entries);
  } catch (err) {
    throw toUserError(err);
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
  await writeAll([detachEntry(inv, Date.now())]);
}

export async function submitReimbursement(id, now = Date.now()) {
  // 前置检查走本文件已有的两层 helper：`requireReimbursement` 管「必须存在」、
  // `requireStatus` 管「必须处于某状态」。别再手写那几行——判据来自 reimburse-model 的
  // 白名单，漏写一行不会报错（静默失败面），而同一句话在多处各抄一遍迟早会分叉。
  const reimb = await requireReimbursement(id);
  requireStatus(
    reimb, canSubmit,
    reimb.status === STATUS.SUBMITTED ? '这张报销单已经提交过了' : '已经到账的报销单不能重复提交',
    'NOT_SUBMITTABLE'
  );
  const next = { ...reimb, status: STATUS.SUBMITTED, submittedAt: now };
  // 写走 writeAll：一处发起事务、一处把英文异常翻成人话。
  await writeAll([{ store: REIMB_STORE, value: next }]);
  return next;
}

/**
 * 标记到账。这是本模块唯一一个**跨三张表**的写：
 *   ① 更新报销单（状态 / 到账时间 / 账户 / 实际到账金额 / txnId）
 *   ② 若 createTxn，写一笔收入交易
 * 两件事必须落在**一个**事务里：先写交易、后写报销单，中途失败会留下「钱记上了、
 * 报销单还停在已提交」——用户看到没到账，再点一次「标记到账」，于是记出**第二笔收入**。
 * 而那个半截状态没有任何自愈路径（重启应用也不会去比对）。
 *
 * 实现方式是把「更新报销单」那一条作为 extraEntries 交给 addTransaction，
 * 由它那一次 db.putAll 一并写下去（见 store.js 的 addTransaction 注释）。
 */
export async function settleReimbursement(id, {
  // 默认值是 **null，不是 0**：这两个值在这条路上必须分开——0 是合法业务值（公司拒报、一分没报回来，
  // 界面上专门为它做了二次确认），而「没传」是漏传或写错字段名。默认成 0 会把后者伪装成前者，
  // 于是 `settleReimbursement(id, { amountCents: 100 })` 这种调用会安静地记一笔 ¥0 收入。
  settledCents = null, accountId = null, categoryId = null, createTxn = true, now = Date.now()
} = {}) {
  const reimb = await requireReimbursement(id);
  requireStatus(
    reimb, canSettle,
    reimb.status === STATUS.DRAFT ? '这张报销单还没提交给公司，不能标记到账' : '这张报销单已经到账了',
    'NOT_SETTLEABLE'
  );

  // 金额校验，判据与本仓既有的「非法金额」口径一致（invoice-model 的 validateInvoice 把「缺失」与
  // 「不合法」分成两种提示，reimburse-model 的 diffCents 对非安全整数返回 null 而不是 0）：
  //  · **不合法**（给了、但不是安全整数，比如 '100' 或 1.5）→ 两个分支都拒绝；
  //  · **缺失**（漏传、或写错字段名）→ 只在**要记账**时拒绝。createTxn:false 那条路
  //    （公司没打钱、只把单子标成到账）本来就没有金额，那里缺失是正常的。
  //
  // 为什么不能像第一版那样兜底成 0：0 是**合法业务值**，而漏传与「真的 0」折成同一个数之后，
  // `settleReimbursement(id, {})` 会替用户记一笔没人要的 ¥0 收入、还顺手把单子标成已到账，
  // 全程不报错。**0 只能由调用方显式传进来**（配合上面那个 null 默认值）。
  const hasCents = Number.isSafeInteger(settledCents);
  const missingCents = settledCents === null || settledCents === undefined;
  // 负数不是合法的到账金额（规格 §8：「报销到账不会是负数；真填了负数只可能是误触了减号」）。
  // **数据层必须自己挡**，不能指望界面：keypad 的正则输不出负号只是**当前那个输入控件**的巧合，
  // 导入的备份、手改过的记录、将来换掉的输入控件都会撞上这条路。放行的代价是库里多一笔
  // −100 的收入（还会被算进当月收支），而全程不报错——这正是「判据漏写不报错」那一类。
  // 与上面那条金额校验同一口径（ReimburseError + BAD_INPUT），文案也同一个说法（「…，这次没记上」）。
  if (hasCents && settledCents < 0) {
    throw new ReimburseError('到账金额不能是负数，这次没记上', 'BAD_INPUT');
  }
  if (!hasCents && (!missingCents || createTxn)) {
    throw new ReimburseError('到账金额不对，这次没记上', 'BAD_INPUT');
  }
  // 保留 null（不折成 0）。四种组合逐一代进上面那条判断，能走到这里且 !hasCents 的**只有一种**：
  //   createTxn:true  + 有值  → hasCents            → 用原值
  //   createTxn:true  + 缺失  → 上面那条 throw       → 到不了这里（要记账就必须有金额）
  //   createTxn:false + 有值  → hasCents            → 用原值
  //   createTxn:false + 缺失  → 唯一走到这里且 !hasCents 的组合 → 值就是「没给」
  // 所以这一行碰不到记账支：下面 createTxn:true 那条路的 amountCents 用的正是 cents，
  // 而它在那条路上恒为 hasCents 分支。
  //
  // 为什么必须保留 null 而不是兜底成 0：settledCents 的默认值当初从 0 改成 null（见参数列表），
  // 就是为了让「没给」（漏传、或界面上的金额输入框是空的）与「真的是 0 元」（公司拒报，
  // 界面上专门为它做了二次确认）可区分。兜底成 0 把两者又合并了回去，于是「只标记到账、
  // 金额留空」会静默落库 settledCents: 0，详情页显示「实际到账 ¥0.00 / 差额 −¥3,025.00」——
  // 把「没填」记成了「公司给了 0 元」。这里修的是本文件**内部的不一致**，不是新增语义。
  const cents = hasCents ? settledCents : null;

  // 已到账那条记录：两个分支共用这一份字面量，各支只 spread 一次。
  // 两处各写一遍六个字段的版本里，将来加一个字段、只改一处，就会得到「因复选框而字段不同」的
  // 两条记录，而且不报错——正是 createReimbursement 那里警告过的「同一实体两种形状」。
  const next = {
    ...reimb, status: STATUS.SETTLED, settledAt: now,
    accountId: accountId ?? null, settledCents: cents
  };

  if (!createTxn) {
    // 不记账这条路只有一处写入，不必绕 addTransaction——但仍走 writeAll 翻译异常。
    const settled = { ...next, txnId: null };
    await writeAll([{ store: REIMB_STORE, value: settled }]);
    return settled;
  }

  // 交易 id 先自己生成：报销单那一条要与交易**同批写入**，而它里面要写上 txnId——
  // 若等 addTransaction 返回后再写回，就变成两次写入了，那正是这一段要避免的事。
  // 为此任务 3 给 addTransaction 加了 `id: input.id ?? uid()`。
  const txnId = uid();
  const settled = { ...next, txnId };
  try {
    await addTransaction({
      id: txnId,
      kind: 'income',
      amountCents: cents,
      categoryId: categoryId ?? null,
      accountId: accountId ?? null,
      occurredAt: now,
      note: `报销到账 · ${reimb.title}`,
      source: 'reimbursement',
      reimbursementId: id
    }, {
      extraEntries: [{ store: REIMB_STORE, value: settled }]
    });
  } catch (err) {
    // 这一支不走 writeAll（报销单那一条必须与交易同批写下去，见上面），所以「英文异常翻成人话」
    // 要在这里自己接上。少了这一层，同一个「标记到账」按钮的文案会随「记不记收入」那个复选框变：
    // 不记账时是中文（走 writeAll），记账时是「QuotaExceededError: the quota has been exceeded.」
    // 直达界面（任务 9 的界面把 err.message 显示出来）。
    throw toUserError(err);
  }

  return settled;
}

/**
 * 删掉一张报销单。两条纪律：
 *  · 单里的发票**回到待报销**，不是被删掉——票是用户的东西，报销单只是它的分组；
 *  · 已经生成过收入账时由**调用方**决定要不要一起删（deleteTxn）。两边都留会变成
 *    对不上的账，所以界面必须问，而且不能默认——但「留还是删」是用户的决定，不是这里的。
 * 三处写入一个事务：回退发票、删单据、（可选）删交易。
 *
 * 这里**没走 requireReimbursement**：删一张不存在的单是幂等的成功（重复点删除不该报错），
 * 与其余几个写函数的「不存在就抛 NOT_FOUND」是**有意的不同**，不是漏改。
 *
 * 这条路也**不翻异常**（因此不经 writeAll）：它要在同一个事务里既删记录（删单、可选的删交易）
 * 又写记录（把票退回待报销），putAll 只会写不会删，只能走 db.replaceAllRecords。
 * 与 invoice-store.deleteInvoice 同一处置，理由也一样：删除失败是**原子的**、什么都没发生，
 * 用户的下一步就是**重试**；而配额那句「去备份、清旧数据」在删除场景反而是废话
 * （删东西本来就是在腾地方）。代价是这条路径上界面拿到的是英文原文，界面不该把
 * err.message 直接显示给用户（与另外两处中文文案不一致的那一段，是已知且被接受的）。
 *
 * 两处**已知且被接受**的后果：
 *  1. deleteTxn:false 时留下的那笔收入仍带 `reimbursementId: <已删单>`，是个悬空指针。
 *     今天无消费方——任务 8 的删除保护读的是**正向**的 `reimb.txnId`，不读这个反向指针。
 *  2. 另一个标签页在 listInvoicesOf 之后才挂到本单上的票，会带着指向已删单的 reimbursementId
 *     留在库里；而 invoiceStatus 只要票上有 reimbursementId 就判成「已报销」（它只看发票自身的
 *     archived / reimbursementId 两个字段，压根不看报销单对象），那张票从此回不到待报销列表，
 *     **没有自愈路径**。要关掉它就得把「读票列表 → 写删单」这一段锁起来，而这是无后端的
 *     IndexedDB，做不到。
 */
export async function deleteReimbursement(id, { deleteTxn = false } = {}) {
  const reimb = await getReimbursement(id);
  if (!reimb) return;

  const invoices = await listInvoicesOf(id);
  const now = Date.now();
  // puts 与 deletes 分成两个数组，而不是混成一个再按「这条 entry 有没有 key」filter 开：
  // 后者的判据是隐式的，而且 `!e.key` 会把 0 / '' 这种 falsy 主键误判成 put（今天唯一带 key 的
  // 那条来自被真值守卫过的 reimb.txnId，所以安全——但那是「形状靠约定」，加一个字段就可能悄悄失效）。
  const puts = invoices.map(inv => detachEntry(inv, now));
  const deletes = [
    ...(deleteTxn && reimb.txnId ? [{ store: 'txns', key: reimb.txnId }] : []),
    { store: REIMB_STORE, key: id }
  ];

  await db.replaceAllRecords({ clears: [], puts, deletes });
}
