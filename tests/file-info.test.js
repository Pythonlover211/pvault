import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_FILE_BYTES, fileKind, mimeForKind, extForKind
} from '../app/file-info.js';

test('fileKind：mime 说是 OFD 就判 OFD', () => {
  assert.equal(fileKind('application/ofd', ''), 'ofd');
  assert.equal(fileKind('application/OFD', 'x.bin'), 'ofd');
});

test('fileKind：mime 说是 PDF 就判 PDF', () => {
  assert.equal(fileKind('application/pdf', ''), 'pdf');
  assert.equal(fileKind('application/pdf; charset=binary', 'x'), 'pdf');
});

test('fileKind：mime 空或没说什么时由扩展名接管', () => {
  assert.equal(fileKind('', 'a.ofd'), 'ofd');
  assert.equal(fileKind('', 'a.PDF'), 'pdf');
  assert.equal(fileKind('application/octet-stream', 'b.OFD'), 'ofd');
});

test('fileKind：mime 与扩展名打架时以 mime 为准', () => {
  assert.equal(fileKind('application/pdf', 'c.ofd'), 'pdf');
  assert.equal(fileKind('application/ofd', 'c.pdf'), 'ofd');
});

test('fileKind：其余一律当图片', () => {
  assert.equal(fileKind('image/jpeg', 'd.jpg'), 'image');
  assert.equal(fileKind('', ''), 'image');
  assert.equal(fileKind(null, null), 'image');
  assert.equal(fileKind(undefined, undefined), 'image');
});

test('mimeForKind：存库前归一化', () => {
  assert.equal(mimeForKind('ofd', 'application/octet-stream'), 'application/ofd');
  assert.equal(mimeForKind('pdf', ''), 'application/pdf');
  assert.equal(mimeForKind('image', 'image/png'), 'image/png');
  assert.equal(mimeForKind('image', 'image/png; charset=binary'), 'image/png');
  assert.equal(mimeForKind('image', ''), 'image/jpeg');
});

test('mimeForKind：不是 image/* 的 mime 一律回落，不放它进图片记录', () => {
  // kind 传错、或选择器给了个非图片的 type 时，别把一个非图片 mime 跟着图片记录存进库——
  // 下游是按 mime 前缀决定要不要塞进 <img> 的。
  assert.equal(mimeForKind('', 'application/octet-stream'), 'image/jpeg');
  assert.equal(mimeForKind('image', 'application/octet-stream'), 'image/jpeg');
  assert.equal(mimeForKind('image', null), 'image/jpeg');
});

test('extForKind：ofd / pdf 只看 kind', () => {
  assert.equal(extForKind('ofd', 'application/pdf'), 'ofd');
  assert.equal(extForKind('pdf', 'application/octet-stream'), 'pdf');
});

test('extForKind：图片按真实子类型给扩展名', () => {
  // 库里的 PNG 记录不算罕见：prepareFile 有两条路径会把原始 mime 原样存下来
  // （图片够小、不需要压缩；或压缩失败回退了原图），而兜底名恰恰只在「没有原始文件名」
  // 时才用。一律叫 .jpg 会让手机按 .jpg 去派发一个 PNG 文件。
  assert.equal(extForKind('image', 'image/png'), 'png');
  assert.equal(extForKind('image', 'image/webp'), 'webp');
  assert.equal(extForKind('image', 'image/jpeg'), 'jpg');
  assert.equal(extForKind('image', 'image/png; charset=binary'), 'png');
  assert.equal(extForKind('image', ''), 'jpg');
  assert.equal(extForKind('image', null), 'jpg');
});

test('每个 kind 都能得到非空的 mime 与扩展名', () => {
  // 防止将来往枚举里加第四个值时静默漏配
  for (const kind of ['image', 'pdf', 'ofd']) {
    assert.ok(mimeForKind(kind, '').length > 0);
    assert.ok(extForKind(kind, '').length > 0);
  }
});

test('MAX_FILE_BYTES 是 20 MB', () => {
  assert.equal(MAX_FILE_BYTES, 20 * 1024 * 1024);
});
