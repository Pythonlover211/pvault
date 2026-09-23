import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monthlyTotals, byCategory, compareWithPrev, trendSeries } from '../app/summary.js';

const txn = (kind, cents, categoryId = 'c1') => ({ kind, amountCents: cents, categoryId });
const cats = [
  { id: 'c1', name: '餐饮', icon: '🍜', kind: 'expense' },
  { id: 'c2', name: '交通', icon: '🚇', kind: 'expense' },
  { id: 'c3', name: '工资', icon: '💰', kind: 'income' }
];

test('monthlyTotals 合计支出与收入，净额取差', () => {
  const r = monthlyTotals([
    txn('expense', 1240), txn('expense', 3000), txn('income', 850000)
  ]);
  assert.deepEqual(r, { expense: 4240, income: 850000, net: 845760 });
});

test('monthlyTotals 排除转账', () => {
  const r = monthlyTotals([txn('expense', 1000), txn('transfer', 500000)]);
  assert.equal(r.expense, 1000);
  assert.equal(r.income, 0);
});

test('monthlyTotals 空输入返回零', () => {
  assert.deepEqual(monthlyTotals([]), { expense: 0, income: 0, net: 0 });
});

test('byCategory 按金额降序并给出占比', () => {
  const rows = byCategory([
    txn('expense', 1000, 'c1'), txn('expense', 3000, 'c2'), txn('expense', 1000, 'c1')
  ], cats, 'expense');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].categoryId, 'c2');
  assert.equal(rows[0].cents, 3000);
  assert.equal(rows[0].name, '交通');
  assert.equal(rows[1].cents, 2000);
  assert.ok(Math.abs((rows[0].ratio + rows[1].ratio) - 1) < 1e-12);
});

test('byCategory 忽略其他类型与未知分类', () => {
  const rows = byCategory([txn('income', 9999, 'c3'), txn('expense', 500, 'ghost')], cats, 'expense');
  assert.deepEqual(rows, []);
});

test('compareWithPrev 计算环比', () => {
  assert.deepEqual(compareWithPrev(880, 1000), { deltaCents: -120, ratio: -0.12 });
  assert.equal(compareWithPrev(1000, 0), null);
});

test('trendSeries 给出柱高比例', () => {
  const s = trendSeries([
    { label: '7月', cents: 500 }, { label: '8月', cents: 1000 }, { label: '9月', cents: 0 }
  ]);
  assert.equal(s.max, 1000);
  assert.deepEqual(s.bars.map(b => b.heightRatio), [0.5, 1, 0]);
});

test('trendSeries 全零时柱高为 0 且不除以零', () => {
  const s = trendSeries([{ label: '8月', cents: 0 }, { label: '9月', cents: 0 }]);
  assert.equal(s.max, 0);
  assert.deepEqual(s.bars.map(b => b.heightRatio), [0, 0]);
});
