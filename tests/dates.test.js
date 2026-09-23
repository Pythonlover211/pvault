import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  startOfDay, dayRange, monthRange, daysLeftInMonth, addMonths,
  formatDayLabel, formatMonthLabel, lastNMonths
} from '../app/dates.js';

const sep23 = new Date(2026, 8, 23, 14, 30).getTime();
const sep1 = new Date(2026, 8, 1, 0, 0).getTime();
const oct1 = new Date(2026, 9, 1, 0, 0).getTime();

test('startOfDay 归零到本地零点', () => {
  assert.equal(startOfDay(sep23), sep1 + 22 * 86400000 + 0);
  const d = new Date(startOfDay(sep23));
  assert.equal(d.getHours(), 0);
  assert.equal(d.getMinutes(), 0);
  assert.equal(d.getSeconds(), 0);
});

test('dayRange 覆盖当天整日', () => {
  const { start, end } = dayRange(sep23);
  assert.equal(end - start, 86400000);
  assert.equal(new Date(start).getDate(), 23);
  assert.equal(new Date(end).getDate(), 24);
});

test('monthRange 覆盖当月整月', () => {
  const { start, end } = monthRange(sep23);
  assert.equal(start, sep1);
  assert.equal(end, oct1);
});

test('monthRange 正确处理 12 月跨年', () => {
  const dec = new Date(2026, 11, 15).getTime();
  const { end } = monthRange(dec);
  const d = new Date(end);
  assert.equal(d.getFullYear(), 2027);
  assert.equal(d.getMonth(), 0);
  assert.equal(d.getDate(), 1);
});

test('daysLeftInMonth 含今天', () => {
  assert.equal(daysLeftInMonth(sep23), 8);
  assert.equal(daysLeftInMonth(new Date(2026, 8, 30).getTime()), 1);
  assert.equal(daysLeftInMonth(new Date(2026, 8, 1).getTime()), 30);
});

test('addMonths 处理跨年与月末', () => {
  const jan = addMonths(new Date(2026, 11, 15).getTime(), 1);
  assert.equal(new Date(jan).getMonth(), 0);
  assert.equal(new Date(jan).getFullYear(), 2027);
  const back = addMonths(new Date(2026, 0, 15).getTime(), -1);
  assert.equal(new Date(back).getFullYear(), 2025);
  assert.equal(new Date(back).getMonth(), 11);
});

test('addMonths 在月末锚点上钳制到目标月最后一天，不向前溢出', () => {
  const d31 = (y, m) => new Date(y, m - 1, 31).getTime();
  assert.equal(new Date(addMonths(d31(2026, 1), 1)).getMonth(), 1);      // 1/31 +1 → 2 月
  assert.equal(new Date(addMonths(d31(2026, 1), 1)).getDate(), 28);      // 2026-02-28
  assert.equal(new Date(addMonths(d31(2026, 3), -1)).getMonth(), 1);     // 3/31 -1 → 2 月
  assert.equal(new Date(addMonths(d31(2026, 3), -1)).getDate(), 28);
  assert.equal(new Date(addMonths(d31(2026, 5), -1)).getDate(), 30);     // 5/31 -1 → 4/30
  assert.equal(new Date(addMonths(d31(2026, 12), 1)).getFullYear(), 2027); // 跨年
  assert.equal(new Date(addMonths(d31(2026, 12), 1)).getMonth(), 0);
  assert.equal(new Date(addMonths(d31(2026, 12), 1)).getDate(), 31);     // 2027-01-31
  assert.equal(new Date(addMonths(d31(2024, 1), 1)).getDate(), 29);      // 闰年 2 月
  // 非月末锚点行为不变
  assert.equal(new Date(addMonths(new Date(2026, 0, 15).getTime(), 1)).getDate(), 15);
});

test('formatDayLabel 给出今天/昨天/日期', () => {
  const yesterday = new Date(2026, 8, 22, 9, 0).getTime();
  assert.equal(formatDayLabel(sep23, sep23), '今天');
  assert.equal(formatDayLabel(yesterday, sep23), '昨天');
  assert.equal(formatDayLabel(new Date(2026, 8, 20).getTime(), sep23), '9月20日');
  assert.equal(formatDayLabel(new Date(2026, 7, 3).getTime(), sep23), '8月3日');
});

test('formatMonthLabel 输出年月', () => {
  assert.equal(formatMonthLabel(sep23), '2026 年 9 月');
});

test('lastNMonths 返回从旧到新的连续月份', () => {
  const list = lastNMonths(sep23, 6);
  assert.equal(list.length, 6);
  assert.equal(list[5].label, '2026 年 9 月');
  assert.equal(list[0].label, '2026 年 4 月');
  assert.equal(list[0].start, new Date(2026, 3, 1).getTime());
  assert.equal(list[5].end, oct1);
});
