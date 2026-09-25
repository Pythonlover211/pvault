import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INVOICE_TYPES, TYPE_IDS, typeLabel,
  dedupeKey, validateInvoice, sumCents, invoiceTitle
} from '../app/invoice-model.js';

test('发票类型枚举有 7 项且 id 唯一', () => {
  assert.equal(INVOICE_TYPES.length, 7);
  // 断言整份 id 清单：只抽查两个 id 的话，另外五个拼错（比如 e_invoice 写成 einvoice）
  // 测试照样是绿的，而库里已经存进去的旧数据会突然变成「发票类型无效」。
  assert.deepEqual(TYPE_IDS, [
    'vat_special', 'vat_normal', 'e_invoice', 'itinerary', 'train', 'taxi', 'other'
  ]);
  assert.equal(new Set(TYPE_IDS).size, 7);
  // TYPE_IDS 是模块级共享数组，必须冻结：否则任何 import 方 push 一下就会污染全校验。
  assert.ok(Object.isFrozen(TYPE_IDS), 'TYPE_IDS 应当是冻结的，避免被 import 方改动');
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

test('validateInvoice：金额缺失和金额不合法给两种不同的提示', () => {
  // 只拍照没填金额就点保存，是最常见的失败路径：keypad 返回 null，走「请先输入」这条。
  // 界面上没有「分」这个单位，旧文案「金额必须是不小于 0 的整数分」用户不知道要改什么。
  const missing = validateInvoice({ amountCents: null });
  assert.deepEqual(missing.errors, ['请先输入价税合计金额']);
  assert.deepEqual(validateInvoice({}).errors, ['请先输入价税合计金额'],
    '字段整个缺失（undefined）也按「还没输入」处理');
  assert.deepEqual(validateInvoice({ amountCents: undefined }).errors, ['请先输入价税合计金额']);

  assert.deepEqual(validateInvoice({ amountCents: 12.5 }).errors, ['金额格式不对，请重新输入']);
  assert.deepEqual(validateInvoice({ amountCents: -1 }).errors, ['金额格式不对，请重新输入']);
  assert.deepEqual(validateInvoice({ amountCents: '100' }).errors, ['金额格式不对，请重新输入'],
    '字符串不该被当作合法整数');
  assert.deepEqual(validateInvoice({ amountCents: 1e21 }).errors, ['金额格式不对，请重新输入'],
    '1e21 是整数但超出安全整数范围，存进 IndexedDB 再读出来就不是原来那个数了');
  assert.equal(validateInvoice({ amountCents: 0 }).ok, true, '0 元是合法的');
});

test('validateInvoice：issuedAt 必须是毫秒安全整数', () => {
  // 这里曾经写成 Number.isFinite(Number(x))，下面这些脏值会被全部放行，
  // 而 new Date('2026') 只解析到 1970 年附近——按 issuedAt 倒序的列表会把它沉到最底。
  for (const bad of ['', '   ', '2026', true, 1.5, NaN, [], '1700000000000']) {
    const r = validateInvoice({ amountCents: 1, issuedAt: bad });
    assert.equal(r.ok, false, `issuedAt=${JSON.stringify(bad)} 应当被拒`);
    assert.deepEqual(r.errors, ['开票日期无效']);
  }
  assert.equal(validateInvoice({ amountCents: 1, issuedAt: 1700000000000 }).ok, true);
  assert.equal(validateInvoice({ amountCents: 1, issuedAt: null }).ok, true, '没填日期由上层兜，这里不拦');
  assert.equal(validateInvoice({ amountCents: 1, issuedAt: undefined }).ok, true);
});

test('validateInvoice：文本字段必须是字符串', () => {
  // number 传数字 0 时编辑器里 state.number.trim() 会直接抛 TypeError；
  // 传对象时 dedupeKey 得到 '[object Object]'，两张脏票互判「这张票已经录过了」。
  assert.deepEqual(validateInvoice({ amountCents: 1, number: 0 }).errors, ['发票号码必须是文字']);
  assert.deepEqual(validateInvoice({ amountCents: 1, number: {} }).errors, ['发票号码必须是文字']);
  assert.deepEqual(validateInvoice({ amountCents: 1, seller: 5 }).errors, ['销售方必须是文字']);
  assert.deepEqual(validateInvoice({ amountCents: 1, buyerTitle: 5 }).errors, ['购买方抬头必须是文字']);
  assert.deepEqual(validateInvoice({ amountCents: 1, buyerTaxId: 5 }).errors, ['纳税人识别号必须是文字']);
  assert.deepEqual(validateInvoice({ amountCents: 1, note: [] }).errors, ['备注必须是文字']);

  assert.equal(validateInvoice({ amountCents: 1, number: '0' }).ok, true, '字符串 "0" 是合法的');
  assert.equal(validateInvoice({ amountCents: 1, seller: '' }).ok, true);
  // 缺省与 null 都放行：字段没填是常态，由订单据的界面自己决定必填与否。
  assert.equal(validateInvoice({ amountCents: 1 }).ok, true);
  assert.equal(validateInvoice({ amountCents: 1, note: null }).ok, true);
});

test('validateInvoice：输入不是对象时提示数据不完整，而不是怪金额', () => {
  for (const bad of [null, undefined, 'x', 42]) {
    const r = validateInvoice(bad);
    assert.equal(r.ok, false);
    assert.deepEqual(r.errors, ['发票数据不完整'], `${JSON.stringify(bad)} 应当报数据不完整`);
  }
});

test('validateInvoice：税额不合法与税额大于总额给不同提示', () => {
  const bigger = validateInvoice({ amountCents: 100, taxCents: 101 });
  assert.equal(bigger.ok, false);
  assert.deepEqual(bigger.errors, ['税额比价税合计还大，请核对这两项金额']);

  assert.deepEqual(validateInvoice({ amountCents: 100, taxCents: -1 }).errors, ['税额格式不对，请重新输入']);
  assert.deepEqual(validateInvoice({ amountCents: 100, taxCents: 1.5 }).errors, ['税额格式不对，请重新输入']);
  assert.deepEqual(validateInvoice({ amountCents: 100, taxCents: '30' }).errors, ['税额格式不对，请重新输入']);
  assert.equal(validateInvoice({ amountCents: 100, taxCents: 100 }).ok, true, '税额等于总额是允许的');
  assert.equal(validateInvoice({ amountCents: 100, taxCents: null }).ok, true, '没填税额不参与判断');
});

test('validateInvoice：未知类型被拒，type 缺省放行，号码格式不做校验', () => {
  assert.equal(validateInvoice({ amountCents: 1, type: 'weird' }).ok, false);
  // 缺省放行是刻意的：仓库层 saveInvoice 会兜成 'other'，编辑器 state.type 初值也是 'other'。
  assert.equal(validateInvoice({ amountCents: 1 }).ok, true, '没给 type 应当放行');
  assert.equal(validateInvoice({ amountCents: 1, type: null }).ok, true);
  // 发票号码格式各地不一（8 位 / 20 位都有），不校验格式是刻意的
  assert.equal(validateInvoice({ amountCents: 1, number: '随便什么' }).ok, true);
});

test('sumCents：空数组与脏数据都安全', () => {
  assert.equal(sumCents([]), 0);
  assert.equal(sumCents(null), 0);
  assert.equal(sumCents([{ amountCents: 100 }, { amountCents: 250 }]), 350);
  assert.equal(sumCents([{ amountCents: 100 }, {}]), 100);
  // 备份恢复会绕过 validateInvoice 把脏数据直接写进库，这里不能抛错，也不能把脏值算进来：
  // 旧实现用 Number(x) || 0，会把 '5' 当成 5 分、把小数分照加，0.5 + 0.5 凭空多出一分钱。
  assert.equal(sumCents([{ amountCents: '5' }, { amountCents: -3 }, { amountCents: 0.5 }, { amountCents: 0.5 }]), 0,
    '字符串、负数、小数一律不计');
  assert.equal(sumCents([{ amountCents: 100 }, { amountCents: '5' }]), 100);
  assert.equal(sumCents([{ amountCents: 0 }]), 0);
});

test('invoiceTitle：优先用销售方，其次号码，最后兜底', () => {
  assert.equal(invoiceTitle({ seller: '某某公司', number: '1' }), '某某公司');
  assert.equal(invoiceTitle({ seller: '  ', number: '12345678' }), '发票 12345678');
  assert.equal(invoiceTitle({}), '未命名发票');
});
