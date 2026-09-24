import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRESETS, detectPreset, buildColumnIndex, autoMapping, mapRows, FIELDS
} from '../app/import-schema.js';

const wechatHeader = ['交易时间', '交易类型', '交易对方', '商品', '收/支', '金额(元)', '支付方式', '当前状态', '交易单号', '商户单号', '备注'];
const wechatRows = [
  ['微信支付账单明细'],
  ['起始时间：[2026-08-01] 终止时间：[2026-09-01]'],
  [],
  wechatHeader,
  ['2026-08-15 12:30:00', '商户消费', '某某便利店', '矿泉水', '支出', '¥3.00', '零钱', '支付成功', '10001', '20001', '/'],
  ['2026-08-16 09:00:00', '转账', '张三', '', '收入', '¥88.00', '零钱', '已存入零钱', '10002', '20002', '/']
];

const alipayHeader = ['交易时间', '交易分类', '交易对方', '对方账号', '商品说明', '收/支', '金额', '收/付款方式', '交易状态', '交易订单号', '商家订单号', '备注'];
const alipayRows = [
  ['支付宝交易记录明细查询'],
  ['账号：[zhangsan@example.com]'],
  [],
  alipayHeader,
  ['2026-08-20 18:05:00', '餐饮美食', '某某餐厅', 'shop@example.com', '晚餐', '支出', '68.00', '余额宝', '交易成功', '30001', '40001', '无']
];

test('PRESETS 含微信与支付宝两项', () => {
  assert.deepEqual(PRESETS.map(p => p.id).sort(), ['alipay', 'wechat']);
});

test('FIELDS 列出可映射的字段', () => {
  assert.ok(FIELDS.includes('time'));
  assert.ok(FIELDS.includes('amount'));
  assert.ok(FIELDS.includes('direction'));
  assert.ok(FIELDS.includes('merchant'));
  assert.ok(FIELDS.includes('note'));
});

test('detectPreset 认出微信账单（表头不在第一行也能找到）', () => {
  assert.equal(detectPreset(wechatRows)?.id, 'wechat');
});

test('detectPreset 认出支付宝账单', () => {
  assert.equal(detectPreset(alipayRows)?.id, 'alipay');
});

test('detectPreset 认不出时返回 null', () => {
  assert.equal(detectPreset([['日期', '说明', '金额']]), null);
  assert.equal(detectPreset([]), null);
});

test('buildColumnIndex 把表头行变成列名→索引', () => {
  const idx = buildColumnIndex(wechatHeader);
  assert.equal(idx.get('交易时间'), 0);
  assert.equal(idx.get('金额(元)'), 5);
});

test('autoMapping 按预设的列名生成映射', () => {
  const preset = PRESETS.find(p => p.id === 'wechat');
  const idx = buildColumnIndex(wechatHeader);
  const mapping = autoMapping(preset, idx);
  assert.equal(mapping.time, 0);
  assert.equal(mapping.amount, 5);
  assert.equal(mapping.direction, 4);
  assert.equal(mapping.merchant, 2);
});

test('autoMapping 缺列时对应字段为 null 而不是报错', () => {
  const preset = PRESETS.find(p => p.id === 'wechat');
  const idx = buildColumnIndex(['交易时间', '金额(元)']);
  const mapping = autoMapping(preset, idx);
  assert.equal(mapping.time, 0);
  assert.equal(mapping.amount, 1);
  assert.equal(mapping.merchant, null);
});

test('mapRows 把微信账单转成交易记录', () => {
  const preset = PRESETS.find(p => p.id === 'wechat');
  const idx = buildColumnIndex(wechatHeader);
  const mapping = autoMapping(preset, idx);
  const { records, errors } = mapRows(wechatRows, 3, mapping);
  assert.equal(errors.length, 0);
  assert.equal(records.length, 2);
  assert.equal(records[0].kind, 'expense');
  assert.equal(records[0].amountCents, 300);
  assert.equal(records[0].note, '某某便利店 · 矿泉水');
  assert.equal(records[1].kind, 'income');
  assert.equal(records[1].amountCents, 8800);
});

test('mapRows 把支付宝账单转成交易记录', () => {
  const preset = PRESETS.find(p => p.id === 'alipay');
  const idx = buildColumnIndex(alipayHeader);
  const mapping = autoMapping(preset, idx);
  const { records } = mapRows(alipayRows, 3, mapping);
  assert.equal(records.length, 1);
  assert.equal(records[0].kind, 'expense');
  assert.equal(records[0].amountCents, 6800);
  assert.match(records[0].note, /某某餐厅/);
});

test('mapRows 跳过解析不出时间或金额的行，并把原因收进 errors', () => {
  const rows = [
    wechatHeader,
    ['', '', '', '', '支出', '¥3.00'],
    ['2026-08-15 12:30:00', '', '', '', '支出', '不是钱'],
    ['2026-08-15 12:30:00', '', '店', '', '支出', '¥1.00']
  ];
  const idx = buildColumnIndex(wechatHeader);
  const preset = PRESETS.find(p => p.id === 'wechat');
  const { records, errors } = mapRows(rows, 0, autoMapping(preset, idx));
  assert.equal(records.length, 1);
  assert.equal(errors.length, 2);
  assert.ok(errors[0].row >= 1);
  assert.ok(errors[0].reason.includes('时间') || errors[0].reason.includes('金额'));
});

test('mapRows 遇到「不计收支」的行跳过（不是错误）', () => {
  const rows = [
    wechatHeader,
    ['2026-08-15 12:30:00', '', '店', '', '/', '¥3.00']
  ];
  const idx = buildColumnIndex(wechatHeader);
  const preset = PRESETS.find(p => p.id === 'wechat');
  const { records, errors } = mapRows(rows, 0, autoMapping(preset, idx));
  assert.equal(records.length, 0);
  assert.equal(errors.length, 0);
});

test('mapRows 不传 direction 列时按金额正负判断', () => {
  const rows = [['d'], ['2026-08-15 12:30:00', '-12.34'], ['2026-08-15 12:30:00', '12.34']];
  const { records } = mapRows(rows, 0, { time: 0, amount: 1, direction: null, merchant: null, note: null });
  assert.equal(records.length, 2);
  assert.equal(records[0].kind, 'expense');
  assert.equal(records[0].amountCents, 1234);
  assert.equal(records[1].kind, 'income');
});
