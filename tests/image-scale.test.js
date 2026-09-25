import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_EDGE, THUMB_EDGE, SKIP_COMPRESS_BYTES,
  computeTargetSize, shouldCompress, useCompressed, estimateBackupMB
} from '../app/image-scale.js';

test('常态：长边超过上限时按比例缩小，宽高比不变', () => {
  const r = computeTargetSize(4000, 3000, 1600);
  assert.equal(r.width, 1600);
  assert.equal(r.height, 1200);
  assert.equal(r.scale, 0.4);
});

test('竖图：高的那边是长边', () => {
  const r = computeTargetSize(1200, 3600, 1600);
  assert.equal(r.height, 1600);
  assert.equal(r.width, 533);
});

test('不超过上限：原样返回，scale 为 1', () => {
  const r = computeTargetSize(800, 600, 1600);
  assert.deepEqual(r, { width: 800, height: 600, scale: 1 });
});

test('极端尺寸：缩完也不会变成 0 像素', () => {
  const r = computeTargetSize(100000, 10, 1600);
  assert.ok(r.width >= 1 && r.height >= 1);
  assert.equal(r.width, 1600);
});

test('非法尺寸：不抛错，返回 0 尺寸让对方放弃压缩', () => {
  for (const [w, h] of [[0, 0], [-1, 100], [NaN, 100], [undefined, undefined]]) {
    const r = computeTargetSize(w, h, 1600);
    assert.equal(r.width, 0);
    assert.equal(r.scale, 1);
  }
});

test('shouldCompress：小文件不压', () => {
  assert.equal(shouldCompress(100 * 1024, 4000, 3000), false, '小于阈值直接不压');
  assert.equal(shouldCompress(SKIP_COMPRESS_BYTES, 4000, 3000), true);
});

test('shouldCompress：本来就不大的图不压', () => {
  assert.equal(shouldCompress(5 * 1024 * 1024, 800, 600), false, '尺寸已在上限内，压了也白压');
});

test('useCompressed：压完反而更大就不用', () => {
  assert.equal(useCompressed(1000, 900), true);
  assert.equal(useCompressed(1000, 1000), false);
  assert.equal(useCompressed(1000, 1200), false, '压完更大必须回退原图');
  assert.equal(useCompressed(1000, 0), false);
  assert.equal(useCompressed(1000, NaN), false);
});

test('estimateBackupMB：空集合与脏数据都安全', () => {
  assert.equal(estimateBackupMB([]), 0);
  assert.equal(estimateBackupMB(null), 0);
  const oneMB = 1024 * 1024;
  const mb = estimateBackupMB([{ size: oneMB }, { size: oneMB }]);
  assert.ok(mb > 2 && mb < 4, 'base64 会比原始字节大约 1/3，再加缩略图系数');
});

test('常量取值与规格一致', () => {
  assert.equal(MAX_EDGE, 1600);
  assert.equal(THUMB_EDGE, 240);
  assert.equal(SKIP_COMPRESS_BYTES, 300 * 1024);
});
