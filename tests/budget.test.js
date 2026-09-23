import { test } from 'node:test';
import assert from 'node:assert/strict';
import { budgetProgress, budgetLevel, dailyAllowance } from '../app/budget.js';

test('budgetProgress 返回使用比率', () => {
  assert.equal(budgetProgress(3240, 5000), 0.648);
  assert.equal(budgetProgress(0, 5000), 0);
  assert.equal(budgetProgress(5000, 5000), 1);
  assert.equal(budgetProgress(6000, 5000), 1.2);
});

test('budgetProgress 未设预算时返回 null', () => {
  assert.equal(budgetProgress(100, 0), null);
  assert.equal(budgetProgress(100, null), null);
  assert.equal(budgetProgress(100, undefined), null);
});

test('budgetLevel 三档阈值：<80% 绿、80~100% 黄、>100% 红', () => {
  assert.equal(budgetLevel(0), 'ok');
  assert.equal(budgetLevel(0.79), 'ok');
  assert.equal(budgetLevel(0.8), 'warn');
  assert.equal(budgetLevel(1), 'warn');
  assert.equal(budgetLevel(1.01), 'over');
  assert.equal(budgetLevel(null), 'none');
});

test('dailyAllowance 用剩余预算除以本月剩余天数并向下取整', () => {
  assert.equal(dailyAllowance(176000, 8), 22000);
  assert.equal(dailyAllowance(1000, 3), 333);
  assert.equal(dailyAllowance(1000, 1), 1000);
});

test('dailyAllowance 对超支与非法天数返回 0', () => {
  assert.equal(dailyAllowance(-500, 5), 0);
  assert.equal(dailyAllowance(1000, 0), 0);
  assert.equal(dailyAllowance(1000, -1), 0);
});

test('dailyAllowance 在缺失预算时返回 null', () => {
  assert.equal(dailyAllowance(null, 5), null);
});
