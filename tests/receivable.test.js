import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveExpense, receivableSummary, outstandingList } from '../app/receivable.js';

test('effectiveExpense 扣掉他人分摊份额', () => {
  const t = { kind: 'expense', amountCents: 10000, shares: [
    { personName: '小王', amountCents: 4000, settled: false },
    { personName: '张三', amountCents: 500 }
  ] };
  assert.equal(effectiveExpense(t), 5500);
});

test('effectiveExpense 无分摊时等于原金额', () => {
  assert.equal(effectiveExpense({ kind: 'expense', amountCents: 2800 }), 2800);
});

test('effectiveExpense 非支出返回原金额', () => {
  assert.equal(effectiveExpense({ kind: 'income', amountCents: 5000, shares: [] }), 5000);
});

test('effectiveExpense 分摊超过总额时抛错', () => {
  const t = { kind: 'expense', amountCents: 1000, shares: [{ amountCents: 1200 }] };
  assert.throws(() => effectiveExpense(t), RangeError);
});

test('receivableSummary 分别汇总应收与应付', () => {
  const list = [
    { direction: 'owedToMe', amountCents: 20000, settledAt: null },
    { direction: 'owedToMe', amountCents: 4500, settledAt: null },
    { direction: 'owedToMe', amountCents: 999, settledAt: 1790000000000 },
    { direction: 'iOwe', amountCents: 3000, settledAt: null }
  ];
  assert.deepEqual(receivableSummary(list), { owedToMe: 24500, iOwe: 3000 });
});

test('receivableSummary 空列表返回零', () => {
  assert.deepEqual(receivableSummary([]), { owedToMe: 0, iOwe: 0 });
});

test('outstandingList 只保留未结清项并按时间倒序', () => {
  const list = [
    { id: 'a', occurredAt: 100, settledAt: null },
    { id: 'b', occurredAt: 300, settledAt: null },
    { id: 'c', occurredAt: 200, settledAt: 123 }
  ];
  assert.deepEqual(outstandingList(list).map(x => x.id), ['b', 'a']);
});
