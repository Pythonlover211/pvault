// 发票的纯逻辑：类型枚举、字段校验、查重键、金额合计、显示标题。
// 本模块是纯数据 + 纯函数，不引用 indexedDB / Canvas / DOM，
// 因此可以在 Node 里直接 import 并单测（见 tests/invoice-model.test.js）。

export const INVOICE_TYPES = [
  { id: 'vat_special', label: '增值税专用发票' },
  { id: 'vat_normal', label: '增值税普通发票' },
  { id: 'e_invoice', label: '电子发票' },
  { id: 'itinerary', label: '行程单' },
  { id: 'train', label: '火车票' },
  { id: 'taxi', label: '出租车票' },
  { id: 'other', label: '其他' }
];

// freeze 是必要的：这是模块级共享数组，任何 import 方 push 一下就会污染全校验，
// 而且这种污染在测试里跑不出错（同一个进程内先污染后校验），排查起来极其费劲。
export const TYPE_IDS = Object.freeze(INVOICE_TYPES.map(t => t.id));

export function typeLabel(id) {
  return INVOICE_TYPES.find(t => t.id === id)?.label ?? '未知类型';
}

// 查重键：只用发票号码，空号码不参与查重（返回 null）。
// 刻意不做「号码 + 销售方」的组合键——同号不同销售方只可能是输错，
// 那种情况也该提示，而不是放行。
// 这里的 trim 必须与仓库写入侧的 app/invoice-store.js 里 saveInvoice 那句
// String(input.number ?? '').trim() 保持一致：两边都 trim 才能让带空格的号码查得出来，
// 只改其中一处，存进去的键和查出来的键就对不上，查重会静默失效（不报错、只是永不命中）。
export function dedupeKey(invoice) {
  const n = String(invoice?.number ?? '').trim();
  return n === '' ? null : n;
}

// 文本字段的中文名。校验失败时用它们拼提示语——提示是直接显示给用户的，
// 说「number 字段类型不对」对用户没有任何意义。
const TEXT_FIELDS = {
  number: '发票号码',
  seller: '销售方',
  buyerTitle: '购买方抬头',
  buyerTaxId: '纳税人识别号',
  note: '备注'
};

// 校验只保证「能安全存进库、不会被下游用炸」，不保证业务上合理。
// 提示语一律写「用户该做什么」而不是「哪个字段不合法」：界面上没有「分」这个单位，
// 说「金额必须是整数分」用户无从下手（实测这是最容易撞上的一条——只拍照不填金额就点保存）。
// 发票号码的格式不做校验也是刻意的：增值税发票 8 位、全电发票 20 位，各地还有差异，
// 硬校验只会挡住正确的票。
export function validateInvoice(input) {
  const errors = [];
  // 传 null / undefined / 非对象是**调用方**写错了，不是用户填错了金额。分开报，
  // 免得排查时被一句「金额不对」带到错的方向去。
  if (input === null || typeof input !== 'object') {
    return { ok: false, errors: ['发票数据不完整'] };
  }

  const amountCents = input.amountCents;
  if (amountCents === null || amountCents === undefined) {
    errors.push('请先输入价税合计金额');
  } else if (!Number.isSafeInteger(amountCents) || amountCents < 0) {
    // isSafeInteger 而不是 isInteger：1e21 也是「整数」，但存进 IndexedDB 再读出来
    // 已经不是原来那个数了。口径与 app/money.js 的 addCents 保持一致。
    errors.push('金额格式不对，请重新输入');
  }

  // 时间戳必须是毫秒安全整数。这里曾经写成 Number.isFinite(Number(x))，它把 ''、'   '、
  // '2026'、true、[] 全部放行；而 new Date('2026') 只解析到 1970 年附近的年份——
  // 脏值入库后，按 issuedAt 倒序的发票列表会把它沉到最底，用户再也找不到这张票。
  if (input.issuedAt !== null && input.issuedAt !== undefined
      && !Number.isSafeInteger(input.issuedAt)) {
    errors.push('开票日期无效');
  }

  // 缺省放行是刻意的：仓库层 saveInvoice 会把它兜成 'other'，编辑器里 state.type 初值也是 'other'，
  // 所以「没选类型」这种情况到不了这里。这里只拦「给了但给错」。
  if (input.type !== null && input.type !== undefined && !TYPE_IDS.includes(input.type)) {
    errors.push('发票类型无效');
  }

  // 文本字段必须是字符串：它们会被 .trim()、会被拼进查重键、会被渲染进列表。
  // number 传 0（数字而不是 '0'）时，编辑器里 state.number.trim() 会直接抛 TypeError；
  // 传对象时 dedupeKey 会得到 '[object Object]'，两张脏票互判「这张票已经录过了」。
  for (const [key, label] of Object.entries(TEXT_FIELDS)) {
    const value = input[key];
    if (value !== null && value !== undefined && typeof value !== 'string') {
      errors.push(`${label}必须是文字`);
    }
  }

  if (input.taxCents !== null && input.taxCents !== undefined) {
    const tax = input.taxCents;
    if (!Number.isSafeInteger(tax) || tax < 0) {
      errors.push('税额格式不对，请重新输入');
    } else if (Number.isSafeInteger(amountCents) && tax > amountCents) {
      // 税额是价税合计的一部分，大于总额一定是输错了。提示语要带上「核对哪两项」，
      // 光说「不能大于」用户还得自己回去比对。
      errors.push('税额比价税合计还大，请核对这两项金额');
    }
  }

  return { ok: errors.length === 0, errors };
}

export function sumCents(invoices) {
  // 非安全整数 / 负数一律按 0 计，与 app/money.js 的 addCents 同一口径。
  // 这里刻意不抛错：备份恢复是把发票直接写进库的，读到脏数据不该让整页汇总炸掉。
  // 但也不能像以前那样用 Number(x) || 0 —— 那会把字符串 '5' 当成 5 分、把小数分照加，
  // 0.5 + 0.5 就凭空多出一分钱，显示成查不出来的错账。
  return (invoices ?? []).reduce(
    (sum, i) => sum + (Number.isSafeInteger(i?.amountCents) && i.amountCents > 0 ? i.amountCents : 0),
    0
  );
}

export function invoiceTitle(invoice) {
  const seller = String(invoice?.seller ?? '').trim();
  if (seller) return seller;
  const n = String(invoice?.number ?? '').trim();
  return n ? `发票 ${n}` : '未命名发票';
}
