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

export const TYPE_IDS = INVOICE_TYPES.map(t => t.id);

export function typeLabel(id) {
  return INVOICE_TYPES.find(t => t.id === id)?.label ?? '未知类型';
}

// 查重键：只用发票号码，空号码不参与查重（返回 null）。
// 刻意不做「号码 + 销售方」的组合键——同号不同销售方只可能是输错，
// 那种情况也该提示，而不是放行。
export function dedupeKey(invoice) {
  const n = String(invoice?.number ?? '').trim();
  return n === '' ? null : n;
}

// 发票号码的格式不做校验是刻意的：增值税发票 8 位、全电发票 20 位，各地还有差异，
// 硬校验只会挡住正确的票。这里只保证字段类型正确、数值自洽。
export function validateInvoice(input) {
  const errors = [];
  const amountCents = input?.amountCents;

  if (!Number.isInteger(amountCents) || amountCents < 0) {
    errors.push('金额必须是不小于 0 的整数分');
  }
  if (input?.issuedAt != null && !Number.isFinite(Number(input.issuedAt))) {
    errors.push('开票日期无效');
  }
  if (input?.type != null && !TYPE_IDS.includes(input.type)) {
    errors.push('发票类型无效');
  }
  if (input?.taxCents != null) {
    const tax = input.taxCents;
    if (!Number.isInteger(tax) || tax < 0) {
      errors.push('税额必须是不小于 0 的整数分');
    } else if (Number.isInteger(amountCents) && tax > amountCents) {
      // 税额是价税合计的一部分，大于总额一定是输错了
      errors.push('税额不能大于价税合计');
    }
  }
  return { ok: errors.length === 0, errors };
}

export function sumCents(invoices) {
  return (invoices ?? []).reduce((s, i) => s + (Number(i?.amountCents) || 0), 0);
}

export function invoiceTitle(invoice) {
  const seller = String(invoice?.seller ?? '').trim();
  if (seller) return seller;
  const n = String(invoice?.number ?? '').trim();
  return n ? `发票 ${n}` : '未命名发票';
}
