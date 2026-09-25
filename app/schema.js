// 对象仓库定义与种子数据。
// 本模块是纯数据 + 纯函数：不引用 indexedDB / IDBKeyRange 等浏览器全局，
// 因此在 Node 里可以直接 import 并单测（见 tests/schema.test.js）。

export const DB_NAME = 'pvault';
export const DB_VERSION = 2;

export const STORES = {
  txns: { keyPath: 'id', indexes: [['by_occurredAt', 'occurredAt'], ['by_kind', 'kind']] },
  accounts: { keyPath: 'id', indexes: [] },
  categories: { keyPath: 'id', indexes: [['by_kind', 'kind']] },
  receivables: { keyPath: 'id', indexes: [['by_settledAt', 'settledAt']] },
  settings: { keyPath: 'key', indexes: [] },
  // 发票本体。报销状态不单独存，由 reimbursementId + 报销单状态推导，
  // 否则报销单改了状态、发票里的冗余字段就成了一份会过期的副本。
  invoices: {
    keyPath: 'id',
    indexes: [
      ['by_issuedAt', 'issuedAt'],
      ['by_number', 'number'],
      ['by_txn', 'txnId'],
      ['by_reimbursement', 'reimbursementId']
    ]
  },
  // 发票的图片/PDF 单独一张表：列表页只加载缩略图，
  // 不为显示一行把几 MB 的原图读进内存。
  invoiceFiles: { keyPath: 'id', indexes: [] },
  // 报销单。计划 4 只建表不用，计划 5 才填。
  reimbursements: { keyPath: 'id', indexes: [['by_status', 'status']] }
};

export function applyMigrations(db, oldVersion) {
  for (const [name, def] of Object.entries(STORES)) {
    const store = db.objectStoreNames.contains(name)
      ? null
      : db.createObjectStore(name, { keyPath: def.keyPath });
    if (store) {
      for (const [idxName, keyPath] of def.indexes) {
        store.createIndex(idxName, keyPath);
      }
    }
  }
  return oldVersion;
}

export function seedAccounts() {
  return [
    { id: 'acc-cash', name: '现金', kind: 'cash', icon: '💵', trackBalance: false, archived: false, sort: 1 },
    { id: 'acc-wechat', name: '微信', kind: 'savings', icon: '💚', trackBalance: false, archived: false, sort: 2 },
    { id: 'acc-alipay', name: '支付宝', kind: 'savings', icon: '🅰️', trackBalance: false, archived: false, sort: 3 },
    { id: 'acc-bank', name: '银行卡', kind: 'savings', icon: '🏦', trackBalance: false, archived: false, sort: 4 },
    { id: 'acc-credit', name: '信用卡', kind: 'credit', icon: '💳', trackBalance: true,
      billDay: 5, dueDay: 28, archived: false, sort: 5 }
  ];
}

const EXPENSE = [
  ['cat-food', '餐饮', '🍜'], ['cat-traffic', '交通', '🚇'], ['cat-shop', '购物', '🛍️'],
  ['cat-daily', '日用', '🧴'], ['cat-fun', '娱乐', '🎮'], ['cat-med', '医教', '💊'],
  ['cat-social', '人情', '🎁'], ['cat-home', '居住', '🏠'], ['cat-other', '其他', '📦']
];
const INCOME = [
  ['cat-salary', '工资', '💰'], ['cat-bonus', '奖金', '🎉'], ['cat-refund', '退款', '↩️']
];

export function seedCategories() {
  const out = [];
  EXPENSE.forEach(([id, name, icon], i) => {
    out.push({ id, name, icon, kind: 'expense', archived: false, sort: i + 1 });
  });
  INCOME.forEach(([id, name, icon], i) => {
    out.push({ id, name, icon, kind: 'income', archived: false, sort: i + 1 });
  });
  return out;
}

export function seedSettings() {
  return [
    { key: 'hideAmounts', value: false },
    { key: 'budgetTotalCents', value: 0 },
    { key: 'budgetByCategory', value: {} },
    { key: 'recurring', value: [] },
    { key: 'importProfiles', value: [] },
    { key: 'lastBackupAt', value: null }
  ];
}
