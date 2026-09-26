import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_FILE_BYTES, fileKind, mimeForKind, extForKind,
  sanitizeFilename, replaceExt, fallbackFileName
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

test('sanitizeFilename：去掉路径分隔符与非法字符', () => {
  assert.equal(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j', 'fb'), 'a_b_c_d_e_f_g_h_i_j');
});

test('sanitizeFilename：控制字符单独处理', () => {
  assert.equal(sanitizeFilename('a\u0000b\u001fc', 'fb'), 'a_b_c');
  assert.equal(sanitizeFilename('a\nb\tc', 'fb'), 'a_b_c');
});

test('sanitizeFilename：去掉首尾的点与空格', () => {
  assert.equal(sanitizeFilename('  ..name..  ', 'fb'), 'name');
  assert.equal(sanitizeFilename('...', 'fb'), 'fb');
});

test('sanitizeFilename：空、全空白、非字符串都用 fallback', () => {
  assert.equal(sanitizeFilename('   ', 'fb'), 'fb');
  assert.equal(sanitizeFilename('', 'fb'), 'fb');
  assert.equal(sanitizeFilename(null, 'fb'), 'fb');
  assert.equal(sanitizeFilename(undefined, 'fb'), 'fb');
});

test('sanitizeFilename：fallback 自己也要过净化', () => {
  // 返回值唯一的用途是喂给 <a download> 的 filename，那里不能出现路径分隔符，也不能超长。
  // fallback 由调用方随手传进来，不净化就等于开了个后门。
  assert.equal(sanitizeFilename('', 'a/b:c*?'), 'a_b_c__');
  assert.equal(sanitizeFilename('', 'x'.repeat(300)).length, 100);
  assert.equal(sanitizeFilename('', '...'), 'file');
});

test('sanitizeFilename：超长时截断，但保住扩展名', () => {
  const out = sanitizeFilename('a'.repeat(120) + '.pdf', 'fb');
  assert.equal(out.length, 100);
  assert.ok(out.endsWith('.pdf'), `扩展名被切掉了：${out}`);
  // 没有扩展名时就是普通截断
  assert.equal(sanitizeFilename('x'.repeat(300), 'fb').length, 100);
});

test('sanitizeFilename：先截断再清首尾，结果是幂等的', () => {
  // 反过来的话，截断处会重新长出一个点或空格
  const once = sanitizeFilename('a'.repeat(99) + '.tail', 'fb');
  assert.equal(once, 'a'.repeat(95) + '.tail');
  assert.ok(!/[.\s]$/.test(once), `结尾不该留点或空格：${once}`);
  assert.equal(sanitizeFilename(once, 'fb'), once);
});

test('sanitizeFilename：正常的文件名原样保留', () => {
  assert.equal(sanitizeFilename('25517000000012345678.ofd', 'fb'), '25517000000012345678.ofd');
});

test('replaceExt：换掉扩展名，主干保留', () => {
  assert.equal(replaceExt('IMG_1234.HEIC', 'jpg'), 'IMG_1234.jpg');
  assert.equal(replaceExt('a.png', 'jpg'), 'a.jpg');
  assert.equal(replaceExt('没有扩展名', 'jpg'), '没有扩展名.jpg');
  // 开头的点是「隐藏文件」不是扩展名，不能把整个名字当扩展名切掉
  assert.equal(replaceExt('.hidden', 'jpg'), '.hidden.jpg');
  // 空名字保持空——兜底名是导出时的事，这里不替它做主
  assert.equal(replaceExt('', 'jpg'), '');
  assert.equal(replaceExt(null, 'jpg'), '');
});

test('fallbackFileName：带号码与时间戳', () => {
  assert.equal(
    fallbackFileName({ number: '123', issuedAt: 1700000000000, kind: 'ofd' }),
    '发票-123-1700000000000.ofd'
  );
});

test('fallbackFileName：没号码时用「无号」，issuedAt 无效时用 0', () => {
  assert.equal(
    fallbackFileName({ number: '  ', issuedAt: null, kind: 'pdf' }),
    '发票-无号-0.pdf'
  );
});

test('fallbackFileName：号码里的非法字符会被净化', () => {
  assert.equal(
    fallbackFileName({ number: 'A/B', issuedAt: 1, kind: 'image' }),
    '发票-A_B-1.jpg'
  );
});

test('fallbackFileName：图片带 PNG 的 mime 时扩展名跟着变', () => {
  assert.equal(
    fallbackFileName({ number: '9', issuedAt: 5, kind: 'image', mime: 'image/png' }),
    '发票-9-5.png'
  );
});

test('真实链路：兜底名与净化串起来', () => {
  // 各个函数单独都测过，但审查发现的问题全长在「函数之间的缝」上。
  const fallback = fallbackFileName({
    number: '25517000000012345678', issuedAt: 1700000000000, kind: 'image', mime: 'image/png'
  });
  assert.equal(fallback, '发票-25517000000012345678-1700000000000.png');
  // 外部 App 给的长名字：净化后要保住扩展名，且再净化一次不再变化
  const external = '微信图片_' + 'x'.repeat(120) + '.ofd';
  const once = sanitizeFilename(external, fallback);
  assert.ok(once.endsWith('.ofd'), `扩展名被切掉了：${once}`);
  assert.equal(sanitizeFilename(once, fallback), once);
});
