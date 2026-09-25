import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INVOICE_TYPES, TYPE_IDS, typeLabel,
  dedupeKey, validateInvoice, sumCents, invoiceTitle
} from '../app/invoice-model.js';

test('发票类型枚举有 7 项且 id 唯一', () => {
  assert.equal(INVOICE_TYPES.length, 7);
  assert.equal(new Set(TYPE_IDS).size, 7);
  assert.ok(TYPE_IDS.includes('vat_special'));
  assert.ok(TYPE_IDS.includes('itinerary'));
});

test('typeLabel：认识的类型给中文名，不认识的给兜底', () => {
  assert.equal(typeLabel('vat_special'), '增值税专用发票');
  assert.equal(typeLabel('nope'), '未知类型');
  assert.equal(typeLabel(undefined), '未知类型');
});

test('dedupeKey：只有非空号码才参与查重', () => {
  assert.equal(dedupeKey({ number: '12345678' }), '12345678');
  assert.equal(dedupeKey({ number: '  12345678  ' }), '12345678', '应去掉首尾空白');
  assert.equal(dedupeKey({ number: '' }), null);
  assert.equal(dedupeKey({ number: '   ' }), null);
  assert.equal(dedupeKey({}), null);
  assert.equal(dedupeKey(null), null);
});

test('validateInvoice：合法输入通过', () => {
  const r = validateInvoice({ number: '123', amountCents: 10000, issuedAt: 1700000000000, type: 'vat_normal', taxCents: 300 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
});

test('validateInvoice：金额必须是整数分且非负', () => {
  assert.equal(validateInvoice({ amountCents: 12.5 }).ok, false);
  assert.equal(validateInvoice({ amountCents: -1 }).ok, false);
  assert.equal(validateInvoice({ amountCents: null }).ok, false);
  assert.equal(validateInvoice({ amountCents: '100' }).ok, false, '字符串不该被当作合法整数');
  assert.equal(validateInvoice({ amountCents: 0 }).ok, true, '0 元是合法的');
});

test('validateInvoice：税额不能大于价税合计', () => {
  const r = validateInvoice({ amountCents: 100, taxCents: 101 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes('税额')));
});

test('validateInvoice：未知类型被拒，但号码格式不做校验', () => {
  assert.equal(validateInvoice({ amountCents: 1, type: 'weird' }).ok, false);
  // 发票号码格式各地不一（8 位 / 20 位都有），不校验格式是刻意的
  assert.equal(validateInvoice({ amountCents: 1, number: '随便什么' }).ok, true);
});

test('sumCents：空数组与脏数据都安全', () => {
  assert.equal(sumCents([]), 0);
  assert.equal(sumCents(null), 0);
  assert.equal(sumCents([{ amountCents: 100 }, { amountCents: 250 }]), 350);
  assert.equal(sumCents([{ amountCents: 100 }, {}]), 100);
});

test('invoiceTitle：优先用销售方，其次号码，最后兜底', () => {
  assert.equal(invoiceTitle({ seller: '某某公司', number: '1' }), '某某公司');
  assert.equal(invoiceTitle({ seller: '  ', number: '12345678' }), '发票 12345678');
  assert.equal(invoiceTitle({}), '未命名发票');
});
