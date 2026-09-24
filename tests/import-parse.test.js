import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseImportAmount, parseImportDateTime, parseDirection, makeFingerprint, merchantFromNote
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

// 指纹的第四个分量由 note 派生（makeFingerprint 内部调 merchantFromNote），
// 所以这三个用例的期望值必须按 note 写，而不是按「商户原文」写。
test('makeFingerprint 同一笔数据的指纹稳定，不同数据不同', () => {
  const a = makeFingerprint({ occurredAt: 1000, amountCents: 1234, note: '便利店' });
  const b = makeFingerprint({ occurredAt: 1000, amountCents: 1234, note: '便利店' });
  const c = makeFingerprint({ occurredAt: 1000, amountCents: 1234, note: '别的店' });
  const d = makeFingerprint({ occurredAt: 2000, amountCents: 1234, note: '便利店' });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.notEqual(a, d);
});

test('makeFingerprint 把收支方向纳入指纹', () => {
  // 同一秒、同金额、同商户的一收一支（转账双向往来、消费 + 即时退款）必须是两条
  const expense = makeFingerprint({ occurredAt: 1000, amountCents: 1234, note: '便利店', kind: 'expense' });
  const income = makeFingerprint({ occurredAt: 1000, amountCents: 1234, note: '便利店', kind: 'income' });
  const transfer = makeFingerprint({ occurredAt: 1000, amountCents: 1234, note: '便利店', kind: 'transfer' });
  assert.notEqual(expense, income);
  assert.notEqual(expense, transfer);
  assert.notEqual(income, transfer);
  // 同一方向的同一笔仍必须稳定
  assert.equal(
    expense,
    makeFingerprint({ occurredAt: 1000, amountCents: 1234, note: '便利店', kind: 'expense' })
  );
});

test('merchantFromNote 取 note 的第一段，没有分隔符时整条当商户', () => {
  assert.equal(merchantFromNote('某某便利店 · 矿泉水'), '某某便利店');
  assert.equal(merchantFromNote('矿泉水'), '矿泉水');
  assert.equal(merchantFromNote(''), '');
  assert.equal(merchantFromNote(null), '');
  assert.equal(merchantFromNote(undefined), '');
});

test('makeFingerprint 的商户分量 = merchantFromNote(note)：写入侧与读库侧同口径', () => {
  // A1 的三个真实输入。左边是 mapRows 写出的 note（[商户, 备注] 用 ' · ' 拼），
  // 右边是库里只有 note 时能反解出来的东西。旧实现用「商户原文」当第四分量，
  // 这三条都会两侧不等价 → 同一份账单第二次导入静默翻倍。
  const written = [
    { merchant: '', note: '矿泉水' },            // 交易对方为空、商品有值
    { merchant: '', note: '备注' },              // 商户选「（不使用）」，只留备注
    { merchant: '喜茶 · 深圳店', note: '奶茶' }   // 商户名自带 ' · '
  ];
  const expected = ['矿泉水', '备注', '喜茶'];
  const fingerprints = written.map(({ merchant, note }, i) => {
    const combined = [merchant, note].filter(Boolean).join(' · ');
    const fp = makeFingerprint({ occurredAt: 1000, amountCents: 300, kind: 'expense', note: combined });
    // 指纹的第四段就是反解出来的商户
    assert.equal(fp.split('|')[3], merchantFromNote(combined));
    assert.equal(fp.split('|')[3], expected[i]);
    return fp;
  });
  // 三条 note 互不相同 → 指纹互不相同（口径统一不会把它们挤成同一条）
  assert.equal(new Set(fingerprints).size, 3);
});
