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

export const STATUS_LABELS = Object.freeze({
  [STATUS.DRAFT]: '待提交',
  [STATUS.SUBMITTED]: '已提交',
  [STATUS.SETTLED]: '已到账'
});

export function isStatus(v) {
  return STATUS_IDS.includes(v);
}

export function statusLabel(v) {
  // 判据必须与 isStatus **同源**（都用 STATUS_IDS.includes），不能直接写 STATUS_LABELS[v]。
  // 后者是属性查找、会命中**原型链**：statusLabel('constructor') 会返回一个函数
  // 而不是兜底文案，statusLabel('toString') / '__proto__' 同理——备份文件里的脏 status、
  // 手改过的记录都可能带上这类字符串，界面上就会出现 function Object(){[native code]}。
  // 两个函数对「不认识的值」的口径也不能分叉：isStatus 说不认识、statusLabel 却给出别的东西，
  // 排查时会把人带到错的方向去。
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
  // 已生成收入账时的额外确认在界面层（见 reimburse-view.js），不在这里。
  return true;
}

export function isActive(reimb) {
  return reimb?.status === STATUS.DRAFT || reimb?.status === STATUS.SUBMITTED;
}

// ===== 计算与推导 =====

// 默认标题「9月报销 · 3 张」。用**本地时间**取月份：UTC 会比东八区早 8 小时，
// 9 月 30 日晚上 8 点之后导出的单会被写成「10月报销」，而用户手里的单明明是 9 月的。
export function autoTitle(monthTs, count) {
  const d = new Date(Number.isFinite(monthTs) ? monthTs : Date.now());
  const n = Number.isSafeInteger(count) && count > 0 ? count : 0;
  return `${d.getMonth() + 1}月报销 · ${n} 张`;
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
// reimb 允许为 null：发票列表页只查 invoices 表，那一刻手里没有报销单对象。
// 拿不到时按「有 reimbursementId 就是 reimbursed」判定——绝不能因为读不到报销单
// 就把一张已经报出去的票算成「待报销」，那会让用户重复报销同一张票。
export function invoiceStatus(inv, reimb) {
  if (inv?.archived) return 'stored';
  if (!inv?.reimbursementId) return 'pending';
  // reimb 传进来了就顺带校验它确实对应这张票；不匹配时按「已报销」处理，
  // 不因为一次读库的时序问题把票退回待报销。
  void reimb;
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
