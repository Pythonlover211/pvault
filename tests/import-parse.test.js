import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseImportAmount, parseImportDateTime, parseDirection, makeFingerprint
} from '../app/import-parse.js';

test('parseImportAmount 处理带货币符号与千分位', () => {
  assert.equal(parseImportAmount('¥12.34'), 1234);
  assert.equal(parseImportAmount('12.34'), 1234);
  assert.equal(parseImportAmount('1,234.56'), 123456);
  assert.equal(parseImportAmount('¥1,234.56'), 123456);
  assert.equal(parseImportAmount(' 12.34 '), 1234);
  assert.equal(parseImportAmount('12'), 1200);
  assert.equal(parseImportAmount('0.05'), 5);
});

test('parseImportAmount 处理正负号', () => {
  assert.equal(parseImportAmount('-12.34'), -1234);
  assert.equal(parseImportAmount('+12.34'), 1234);
  assert.equal(parseImportAmount('－12.34'), -1234); // 全角负号
});

test('parseImportAmount 拒绝无法识别的输入', () => {
  assert.equal(parseImportAmount(''), null);
  assert.equal(parseImportAmount('abc'), null);
  assert.equal(parseImportAmount('12.34元'), 1234); // 单位后缀可容忍
  assert.equal(parseImportAmount('--5'), null);
  assert.equal(parseImportAmount(null), null);
});

test('parseImportDateTime 处理常见格式', () => {
  const t1 = parseImportDateTime('2026-09-23 12:34:56');
  assert.equal(new Date(t1).getFullYear(), 2026);
  assert.equal(new Date(t1).getMonth(), 8);
  assert.equal(new Date(t1).getDate(), 23);
  assert.equal(new Date(t1).getHours(), 12);
  assert.equal(new Date(t1).getMinutes(), 34);
});

test('parseImportDateTime 兼容 / 分隔、缺秒、只有日期', () => {
  assert.equal(new Date(parseImportDateTime('2026/09/23 12:34')).getHours(), 12);
  assert.equal(new Date(parseImportDateTime('2026-9-3')).getDate(), 3);
  assert.equal(new Date(parseImportDateTime('2026-9-3')).getMonth(), 8);
});

test('parseImportDateTime 拒绝非法输入', () => {
  assert.equal(parseImportDateTime(''), null);
  assert.equal(parseImportDateTime('昨天'), null);
  assert.equal(parseImportDateTime('2026-13-45'), null);
});

test('parseDirection 认微信/支付宝的写法', () => {
  assert.equal(parseDirection('支出'), 'expense');
  assert.equal(parseDirection('收入'), 'income');
  assert.equal(parseDirection('不计收支'), null);
  assert.equal(parseDirection('/'), null);
  assert.equal(parseDirection(''), null);
  assert.equal(parseDirection('转账'), 'transfer');
});

test('makeFingerprint 同一笔数据的指纹稳定，不同数据不同', () => {
  const a = makeFingerprint({ occurredAt: 1000, amountCents: 1234, merchant: '便利店' });
  const b = makeFingerprint({ occurredAt: 1000, amountCents: 1234, merchant: '便利店' });
  const c = makeFingerprint({ occurredAt: 1000, amountCents: 1234, merchant: '别的店' });
  const d = makeFingerprint({ occurredAt: 2000, amountCents: 1234, merchant: '便利店' });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.notEqual(a, d);
});
