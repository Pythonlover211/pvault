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
  assert.equal(mimeForKind('image', ''), 'image/jpeg');
});

test('extForKind：导出用的扩展名', () => {
  assert.equal(extForKind('ofd'), 'ofd');
  assert.equal(extForKind('pdf'), 'pdf');
  assert.equal(extForKind('image'), 'jpg');
});

test('MAX_FILE_BYTES 是 20 MB', () => {
  assert.equal(MAX_FILE_BYTES, 20 * 1024 * 1024);
});
