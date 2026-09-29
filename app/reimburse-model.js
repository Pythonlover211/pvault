// 报销单的纯逻辑：状态机、标题生成、差额、发票侧的状态推导。
// 本模块是纯数据 + 纯函数，不引用 indexedDB / DOM / Canvas，
// 因此可以在 Node 里直接 import 并单测（见 tests/reimburse-model.test.js）。
//
// 为什么这些逻辑不写在 reimburse-store.js 里：状态流转的合法性与差额的取整
// 恰恰是最容易写错、也最值得用纯单测钉死的部分；一旦它们和数据层混在一起，
// 就只能靠 fake-indexeddb 探针去验，而那层桩盖不住事务回滚（见 tests/helpers/fake-browser.js
// 文件头第 1 条），验出来的绿是虚的。项目里 invoice-model / budget / receivable / theme
// 走的都是「纯逻辑独立成模块」这条路。

// 合计**复用** invoice-model 的 sumCents，不在这里另写一份：
// 同一个数会出现在「发票列表的待报销汇总」和「报销单详情的合计」两处，
// 两套口径只要有一点不同（比如对脏记录的处置），用户就会看到两个对不上的数，
// 而且没有任何地方会报错。
import { sumCents } from './invoice-model.js';

export const STATUS = Object.freeze({
  DRAFT: 'draft',
  SUBMITTED: 'submitted',
  SETTLED: 'settled'
});

// freeze 是必要的：模块级共享数组，任何 import 方 push 一下就会污染全网校验。
export const STATUS_IDS = Object.freeze([STATUS.DRAFT, STATUS.SUBMITTED, STATUS.SETTLED]);

// 用无原型对象：这张表是**导出的**，将来有人直接 STATUS_LABELS[x] 是迟早的事，
// 而 x 命中 'constructor' / 'toString' 会返回函数而不是 undefined——
// statusLabel 里那个 includes 守卫只保护 statusLabel 自己，保护不了裸查的人。
// （这正是 baa3bf7 修掉的那个 bug 的原形。）
export const STATUS_LABELS = Object.freeze(Object.assign(Object.create(null), {
  [STATUS.DRAFT]: '待提交',
  [STATUS.SUBMITTED]: '已提交',
  [STATUS.SETTLED]: '已到账'
}));

export function isStatus(v) {
  return STATUS_IDS.includes(v);
}

export function statusLabel(v) {
  // 判据必须与 isStatus **同源**（都用 STATUS_IDS.includes），不能直接写 STATUS_LABELS[v]。
  // 后者是属性查找、给不出「未知状态」这句兜底。这张表早期还是普通字面量时更糟：
  // 它会命中**原型链**——statusLabel('constructor') 返回的是一个函数
  // （function Object(){[native code]}），'toString' / '__proto__' 同理，而备份文件里的脏 status、
  // 手改过的记录都可能带上这类字符串。表现在已经改成 Object.create(null) 的无原型对象，
  // 但这条守卫要留着：两个函数对「不认识的值」的口径不能分叉——isStatus 说不认识、
  // statusLabel 却给出别的东西，排查时会把人带到错的方向去。
  return STATUS_IDS.includes(v) ? STATUS_LABELS[v] : '未知状态';
}

// ===== 状态机 =====
// 判据一律「白名单」：只放行明确认识的那个状态。读库可能读到脏值
// （手改过的备份、被别的版本写过的记录），白名单让它们在写入前就被挡住，
// 而不是带着一个谁也没定义过的状态继续往下走。

export function canEdit(reimb) {
  return reimb?.status === STATUS.DRAFT;
}

export function canSubmit(reimb) {
  return reimb?.status === STATUS.DRAFT;
}

export function canSettle(reimb) {
  // 草稿不能直接到账：没提交给公司就谈不到「到账」。
  // 真要允许，用户就能做出一张「从没提交过、但已经到账」的单子，
  // 而时间线上那两个节点会变成无意义的装饰。
  return reimb?.status === STATUS.SUBMITTED;
}

export function canDelete() {
  // 任何状态都能删。删不掉才是真的把用户卡住——一张填错的单子如果
  // 因为「已到账」而永远留在列表里，他就只剩下忍着这一条路。
  // 已生成收入账时的额外确认在界面层（reimburse-view.js 的 confirmDelete），不在这里。
  //
  // 它是**零参**的、恒为 true：别用它做可删性判断（`if (!canDelete(...))` 是装饰）。
  // 它在这里的意义是给 canEdit / canSubmit / canSettle / canDelete 这一套判据留个齐整的
  // 落点——「删除不受状态限制」这个决策得有个地方写着。
  return true;
}

export function isActive(reimb) {
  return reimb?.status === STATUS.DRAFT || reimb?.status === STATUS.SUBMITTED;
}

// ===== 计算与推导 =====

// 默认标题「9月报销 · 3 张」。用**本地时间**取月份：UTC 读数落后东八区 8 小时，
// 北京时间 10 月 1 日凌晨（00:00–07:59）那一刻 UTC 还停在 9 月 30 日，
// 用 UTC 会把「10月报销」写成「9月报销」——而用户明明是在 10 月建的单。
//
// 用 isSafeInteger 而不是 isFinite：8.7e15 也是有限数，但 new Date(8.7e15) 是 Invalid Date，
// getMonth() 得到 NaN，标题就写成「NaN月报销 · 3 张」——而标题是要存库、要显示的。
// isSafeInteger 仍挡不住 8.64e15 ~ 9.007e15 那一段，所以再验一次取回的毫秒数。
// 口径与 invoice-model.js 对 issuedAt 的校验一致（那里也是被脏时间戳坑过才改的）。
export function autoTitle(monthTs, count) {
  const ts = Number.isSafeInteger(monthTs) ? monthTs : Date.now();
  const d = new Date(ts);
  const when = Number.isNaN(d.getTime()) ? new Date() : d;
  const n = Number.isSafeInteger(count) && count > 0 ? count : 0;
  return `${when.getMonth() + 1}月报销 · ${n} 张`;
}

// 差额 = 实际到账 − 发票合计。
// settledCents 为 null 表示还没到账，此时**没有差额可谈**，返回 null，
// 界面据此不显示那一行（没有差额就没有信息，显示「差额 ¥0.00」只是噪音）。
// 差额可以为负（公司少报、扣税、抹零），也可以为正（多打了），两者都要如实显示。
export function diffCents(settledCents, invoices) {
  if (settledCents === null || settledCents === undefined) return null;
  if (!Number.isSafeInteger(settledCents)) return null;
  return settledCents - sumCents(invoices);
}

// 发票在**报销追踪**里的状态，供筛选使用（发票规格 §7.2 的五个筛选里有三个用它）。
//
// 它**只看发票自身的两个字段**（archived / reimbursementId），不看报销单——因为筛选发生在
// 发票列表页，那一刻手里没有报销单对象。有 reimbursementId 就判 'reimbursed'：绝不能因为
// 读不到报销单就把一张已经报出去的票算成「待报销」，那会让用户重复报销同一张票。
// （要看报销单状态的是 invoiceBadge，它管的是呈现，两者的分工见那个函数的注释。）
export function invoiceStatus(inv) {
  if (inv?.archived) return 'stored';
  if (!inv?.reimbursementId) return 'pending';
  return 'reimbursed';
}

// 列表上那一行标签的文案（比 invoiceStatus 细：它要回答「报出去了吗、到哪一步了」）。
// 与 invoiceStatus 分开是因为两者的消费方不同——前者是筛选判据，后者是呈现；
// 合成一个函数会让筛选依赖报销单状态，而筛选那一刻未必读得到它。
export function invoiceBadge(inv, reimb) {
  if (inv?.archived) return '仅存档';
  if (!inv?.reimbursementId) return '待报销';
  const s = reimb?.status;
  if (s === STATUS.DRAFT) return '报销中';
  if (s === STATUS.SUBMITTED) return '已提交';
  if (s === STATUS.SETTLED) return '已到账';
  // 读不到报销单、或状态是脏值：退回中性说法，不猜它到哪一步了。
  return '已报销';
}

// 发票筛选行的 id 清单，与 app/ui/invoice-view.js 里那份 `FILTERS` 字面量**逐项对应（含顺序）**。
// 两份副本没法用 import 对账——invoice-view.js 静态 import invoice-store → IndexedDB，Node 里根本
// import 不了——所以一致性由 tests/invoice-view-filters.test.js 读文件 + 正则来守。
export const FILTER_IDS = Object.freeze(['all', 'pending', 'reimbursed', 'unlinked', 'stored']);

// 发票列表的筛选判据。**放在这里而不是 invoice-view.js 里**，是为了能脱离 DOM 单测——
// 「已报销」这一个筛选正是本次要补的缺口（发票规格 §7.2 写了五个，实现只有四个），
// 而它最容易写错的地方是「仅存档的票算不算已报销」（不算：它压根不参与报销追踪）。
//
// 已知边界：`matchFilter(null, 'pending')` / `matchFilter(undefined, 'pending')` 都返回 true——
// `invoiceStatus(null)` 判 'pending'，于是「不存在的票」算待报销。这是继承自 invoiceStatus 的既有
// 边界，当前调用点（listInvoices() 的产物）不可达，所以**不改行为，只记在这里**。
export function matchFilter(inv, filterId) {
  switch (filterId) {
    // 改动前，发票列表的手写判据在 app/ui/invoice-view.js 的 `inFilter` 里，与本文件的
    // invoiceStatus 在重叠的三个态上**等价、互为副本**——而两份等价判据迟早漂移
    // （有人给「仅存档」加一条例外、只改了一处），漂移不报错、只是筛选结果对不上。
    // 现在这三个态**复用 invoiceStatus**：一处定义、一处复用。
    //
    // 这三个筛选 id 与 invoiceStatus 的三态值**同名**，是有意的契约：
    // 合并写一次，就从结构上消灭「case 名与比较值写不一致」这种错。
    case 'pending':
    case 'reimbursed':
    case 'stored':
      return invoiceStatus(inv) === filterId;
    // 仅存档 ∩ 未挂账：**照旧算「未挂账」**。archived 说的是「不参与报销追踪」，
    // txnId 为空说的是「没挂到账目上」——两件事互不包含；把归档的票从「未挂账」里藏起来，
    // 只会让用户找不到那些还没挂账的存档票。
    case 'unlinked': return !inv?.txnId;
    default: return true;   // 'all' 与任何不认识的 id
  }
}

// 到账面板预选的分类。id 与 app/schema.js 的 INCOME 种子是同一份（'cat-refund' = 退款，
// kind: 'income'）——这条对应关系由 tests/reimburse-model.test.js 对着 seedCategories() 钉住，
// 免得哪天有人改了种子的 id，面板安静地预选到一个不存在的分类上（记出来的账是「无分类」）。
export const DEFAULT_SETTLE_CATEGORY = 'cat-refund';

// 到账面板的三个默认值。
//
// **为什么放在这个纯模块里**：这几个默认值里唯一会出错的是「上次那个账户已经不见了」那条分支
// ——它只在用户删过账户之后才出现，靠手点是撞不上的（要先记一笔、再删账户、再回来标到账）。
// 放进 UI 文件就只能靠真机点，而本仓的浏览器实测环境起不来（见计划里任务 9 的说明）。
//
// **为什么这里可以调 sumCents**：reimburse-model 早就从 invoice-model 里 import 了 sumCents
// （diffCents 用它算合计），而 invoice-model 是**零 import** 的叶子模块——依赖方向是
// reimburse-model → invoice-model 单向，不存在环。这个模块声称的「纯逻辑、无 IO」指的是
// 「不碰 DOM / IndexedDB / 全局状态」，import 一个纯函数不违反它。
export function settleDefaults({ invoices = [], lastAccountId = null, accounts = [] } = {}) {
  // 账户列表在调用点可能来自 listAccounts()（已滤掉 archived）——所以「上次用的账户归档了」
  // 与「被删了」在这里是同一条分支，都退到第一个。
  const ids = (accounts ?? []).map(a => a?.id).filter(Boolean);
  // 上次用的账户可能已经不在列表里了（记账面板写 lastAccountId 时不校验）。
  // 退到**第一个账户**，而不是把那个不存在的 id 传下去——传下去会让到账记出的收入指向一个
  // 没有的账户，界面显示空白，用户找不到哪一笔没记上，而且全程不报错。
  //
  // 一个账户都没有时给 **null**，不编 id：settleReimbursement 允许 accountId 为 null
  // （交易落成「无账户」），那比落成一个幽灵账户好得多——后者在列表里看得见、点不开。
  const accountId = ids.includes(lastAccountId) ? lastAccountId : (ids[0] ?? null);
  return {
    // 空列表 → 0；脏 amountCents 由 sumCents 按 0 计（与列表页的合计同一口径，两处不会对不上）。
    settledCents: sumCents(invoices),
    accountId,
    categoryId: DEFAULT_SETTLE_CATEGORY
  };
}
