import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCents, formatCentsShort, parseAmountToCents, addCents, subCents } from '../app/money.js';

test('formatCents 输出两位小数', () => {
  assert.equal(formatCents(1240), '12.40');
  assert.equal(formatCents(0), '0.00');
  assert.equal(formatCents(5), '0.05');
  assert.equal(formatCents(100000000), '1000000.00');
});

test('formatCents 负数与货币符号', () => {
  assert.equal(formatCents(-320), '-3.20');
  assert.equal(formatCents(1240, { symbol: true }), '¥12.40');
  assert.equal(formatCents(-320, { symbol: true }), '-¥3.20');
});

// 供列表行、提示语这类「一眼扫过」的位置使用：整数元去掉小数、加千分位，仍然带 ¥。
test('formatCentsShort 折叠 .00 并加千分位', () => {
  assert.equal(formatCentsShort(250000), '¥2,500');
  assert.equal(formatCentsShort(0), '¥0');
  assert.equal(formatCentsShort(100), '¥1');
  assert.equal(formatCentsShort(12345), '¥123.45');
  assert.equal(formatCentsShort(5), '¥0.05');
  assert.equal(formatCentsShort(100000000), '¥1,000,000');
  assert.equal(formatCentsShort(-250000), '-¥2,500');
  // 千分位只按整数部分分组，不碰小数：1234.56 → ¥1,234.56
  assert.equal(formatCentsShort(123456), '¥1,234.56');
});

test('parseAmountToCents 解析用户输入', () => {
  assert.equal(parseAmountToCents('12.4'), 1240);
  assert.equal(parseAmountToCents('12.40'), 1240);
  assert.equal(parseAmountToCents('0.05'), 5);
  assert.equal(parseAmountToCents('100'), 10000);
  assert.equal(parseAmountToCents('12.'), 1200);
  assert.equal(parseAmountToCents('.5'), 50);
  assert.equal(parseAmountToCents('0'), 0);
});

test('parseAmountToCents 拒绝非法输入', () => {
  assert.equal(parseAmountToCents(''), null);
  assert.equal(parseAmountToCents('.'), null);
  assert.equal(parseAmountToCents('abc'), null);
  assert.equal(parseAmountToCents('1.2.3'), null);
  assert.equal(parseAmountToCents('-5'), null);
  assert.equal(parseAmountToCents('1.234'), null);
  assert.equal(parseAmountToCents(' 12.4 '), 1240);
});

test('整数分相加不会有浮点误差', () => {
  assert.equal(addCents(10, 20), 30);
  assert.equal(addCents(1240, 5, 1), 1246);
  assert.equal(subCents(1000, 1), 999);
  assert.equal(addCents(), 0);
});
