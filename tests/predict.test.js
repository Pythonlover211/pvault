import { test } from 'node:test';
import assert from 'node:assert/strict';
import { predictCategory, hourBucket } from '../app/predict.js';

const cats = [
  { id: 'food', name: '餐饮', kind: 'expense', archived: false },
  { id: 'traffic', name: '交通', kind: 'expense', archived: false },
  { id: 'shop', name: '购物', kind: 'expense', archived: false }
];

// 构造 n 笔某分类、落在指定小时的支出
const at = (hour, categoryId, day = 1) => ({
  kind: 'expense',
  categoryId,
  amountCents: 100,
  occurredAt: new Date(2026, 8, day, hour, 0).getTime()
});

test('hourBucket 把一天切成 8 个 3 小时区间', () => {
  assert.equal(hourBucket(0), 0);
  assert.equal(hourBucket(2), 0);
  assert.equal(hourBucket(3), 1);
  assert.equal(hourBucket(12), 4);
  assert.equal(hourBucket(23), 7);
});

test('同一时段历史最高频的分类胜出', () => {
  const txns = [
    at(12, 'food'), at(12, 'food', 2), at(12, 'food', 3), at(13, 'food', 4),
    at(12, 'shop', 5),
    at(19, 'traffic'), at(19, 'traffic', 2), at(19, 'traffic', 3), at(19, 'traffic', 4)
  ];
  assert.equal(predictCategory({ hour: 12, txns, categories: cats }), 'food');
  assert.equal(predictCategory({ hour: 19, txns, categories: cats }), 'traffic');
});

test('该时段样本不足 3 条时退化到全局最近 30 笔的高频', () => {
  const txns = [at(12, 'shop'), at(15, 'food', 2), at(15, 'food', 3), at(16, 'food', 4)];
  assert.equal(predictCategory({ hour: 12, txns, categories: cats }), 'food');
});

test('完全没有历史时返回第一个未归档分类', () => {
  assert.equal(predictCategory({ hour: 12, txns: [], categories: cats }), 'food');
});

test('预测结果落在已归档分类上时改选下一个可用分类', () => {
  const archived = cats.map(c => (c.id === 'food' ? { ...c, archived: true } : c));
  const txns = [at(12, 'food'), at(12, 'food', 2), at(12, 'food', 3)];
  assert.equal(predictCategory({ hour: 12, txns, categories: archived }), 'traffic');
});

test('没有任何可用分类时返回 null', () => {
  assert.equal(predictCategory({ hour: 12, txns: [], categories: [] }), null);
});
