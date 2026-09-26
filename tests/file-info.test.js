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
  assert.equal(mimeForKind('image', 'IMAGE/PNG'), 'image/png');
  assert.equal(mimeForKind('image', ''), 'image/jpeg');
});

test('mimeForKind：非空却不是 image/* 的，回落中性值而不是伪造 image/jpeg', () => {
  // 伪造 image/jpeg 会骗过 invoice-editor 那道 startsWith('image/') 守卫，
  // 把一个塞不进 <img> 的文件当成图片、显示成裂图。
  assert.equal(mimeForKind('image', 'application/octet-stream'), 'application/octet-stream');
  assert.equal(mimeForKind('', 'application/octet-stream'), 'application/octet-stream');
  assert.equal(
    mimeForKind('image', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    'application/octet-stream'
  );
});

test('extForKind：ofd / pdf 只看 kind，mime 再离谱也不影响', () => {
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
  assert.equal(extForKind('image', 'image/jpg'), 'jpg');
  assert.equal(extForKind('image', 'image/gif'), 'gif');
  assert.equal(extForKind('image', 'image/png; charset=binary'), 'png');
  assert.equal(extForKind('image', 'IMAGE/PNG'), 'png');
  assert.equal(extForKind('image', ''), 'jpg');
  assert.equal(extForKind('image', null), 'jpg');
  // 带 `+` 的 subtype，以及被塞进来的路径片段，都不该变成扩展名
  assert.equal(extForKind('image', 'image/svg+xml'), 'jpg');
  assert.equal(extForKind('image', 'image/../../etc'), 'jpg');
});

test('三个 kind 各自都有确定的 mime 与扩展名', () => {
  assert.equal(mimeForKind('image', ''), 'image/jpeg');
  assert.equal(mimeForKind('pdf', ''), 'application/pdf');
  assert.equal(mimeForKind('ofd', ''), 'application/ofd');
  assert.equal(extForKind('image', ''), 'jpg');
  assert.equal(extForKind('pdf', ''), 'pdf');
  assert.equal(extForKind('ofd', ''), 'ofd');
});

test('同一条记录走完三个函数，口径一致', () => {
  // 三个函数各自被测得很好，但审查发现的问题全长在「函数之间的缝」上：
  // 把真实输入串成一条，能挡住 kind / mime / 扩展名三者互相矛盾。
  for (const [mime, name, kind, stored, ext] of [
    ['image/png; charset=binary', 'a.png', 'image', 'image/png', 'png'],
    ['application/pdf', 'b.pdf', 'pdf', 'application/pdf', 'pdf'],
    ['application/octet-stream', 'c.ofd', 'ofd', 'application/ofd', 'ofd']
  ]) {
    assert.equal(fileKind(mime, name), kind, `${name} 应判成 ${kind}`);
    assert.equal(mimeForKind(kind, mime), stored, `${name} 存库 mime 应为 ${stored}`);
    assert.equal(extForKind(kind, mime), ext, `${name} 导出扩展名应为 ${ext}`);
  }
});

test('MAX_FILE_BYTES 是 20 MB', () => {
  assert.equal(MAX_FILE_BYTES, 20 * 1024 * 1024);
});
