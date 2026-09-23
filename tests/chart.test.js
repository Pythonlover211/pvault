import { test } from 'node:test';
import assert from 'node:assert/strict';
import { donutSegments, donutPath, polarPoint } from '../app/chart.js';

test('donutSegments 从 12 点方向顺时针切分并累计角度', () => {
  const segs = donutSegments([{ key: 'a', cents: 50 }, { key: 'b', cents: 50 }]);
  assert.equal(segs[0].startAngle, 0);
  assert.equal(segs[0].endAngle, 180);
  assert.equal(segs[1].startAngle, 180);
  assert.equal(segs[1].endAngle, 360);
  assert.equal(segs[0].ratio, 0.5);
});

test('donutSegments 占比合计为 1', () => {
  const segs = donutSegments([{ key: 'a', cents: 1 }, { key: 'b', cents: 2 }, { key: 'c', cents: 7 }]);
  const sum = segs.reduce((s, x) => s + x.ratio, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
  assert.equal(Math.round(segs[2].endAngle), 360);
});

test('donutSegments 总金额为零时返回空数组', () => {
  assert.deepEqual(donutSegments([{ key: 'a', cents: 0 }]), []);
  assert.deepEqual(donutSegments([]), []);
});

test('polarPoint 0 度指向 12 点方向', () => {
  const p = polarPoint(100, 100, 50, 0);
  assert.ok(Math.abs(p.x - 100) < 1e-9);
  assert.ok(Math.abs(p.y - 50) < 1e-9);
});

test('polarPoint 90 度为 3 点方向', () => {
  const p = polarPoint(100, 100, 50, 90);
  assert.ok(Math.abs(p.x - 150) < 1e-9);
  assert.ok(Math.abs(p.y - 100) < 1e-9);
});

test('donutPath 生成有效的 SVG path', () => {
  const d = donutPath(100, 100, 80, 50, 0, 90);
  assert.match(d, /^M [\d.-]+ [\d.-]+ A /);
  assert.ok(d.includes('L'));
  assert.ok(d.trim().endsWith('Z'));
});

test('donutPath 对整圆特殊处理，不产生零长度弧', () => {
  const d = donutPath(100, 100, 80, 50, 0, 360);
  assert.equal(d, null);
});
