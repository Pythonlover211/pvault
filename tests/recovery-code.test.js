import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateRecoveryCode, encodeRecoveryCode, decodeRecoveryCode,
  normalizeRecoveryCode, formatRecoveryCode
} from '../app/recovery-code.js';

test('生成的恢复码是 32 个字符', () => {
  const code = generateRecoveryCode();
  assert.equal(code.length, 32);
});

test('两次生成的恢复码不同', () => {
  assert.notEqual(generateRecoveryCode(), generateRecoveryCode());
});

test('恢复码只用 Crockford 字母表（不含 I L O U）', () => {
  for (let i = 0; i < 200; i++) {
    assert.match(generateRecoveryCode(), /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{32}$/);
  }
});

test('编解码往返', () => {
  const bytes = Uint8Array.from({ length: 20 }, (_, i) => i * 7 % 256);
  assert.deepEqual(decodeRecoveryCode(encodeRecoveryCode(bytes)), bytes);
});

test('字节数不对时编码抛错', () => {
  assert.throws(() => encodeRecoveryCode(new Uint8Array(19)), RangeError);
});

test('长度不对的恢复码解码抛错', () => {
  assert.throws(() => decodeRecoveryCode('ABC'), /恢复码/);
});

test('归一化：忽略大小写、空格、连字符', () => {
  assert.equal(normalizeRecoveryCode('abcd-efgh'), 'ABCDEFGH');
  assert.equal(normalizeRecoveryCode('abcd efgh'), 'ABCDEFGH');
  assert.equal(normalizeRecoveryCode('  ABCD-EFGH  '), 'ABCDEFGH');
});

test('归一化：易混字符映射（I/L→1，O→0）', () => {
  assert.equal(normalizeRecoveryCode('IILLOO'), '111100');
  assert.equal(normalizeRecoveryCode('oil'), '011');
});

test('归一化后能解出与原码相同的结果', () => {
  const code = generateRecoveryCode();
  const spaced = formatRecoveryCode(code);
  assert.deepEqual(decodeRecoveryCode(normalizeRecoveryCode(spaced)), decodeRecoveryCode(code));
  assert.deepEqual(decodeRecoveryCode(normalizeRecoveryCode(code.toLowerCase())), decodeRecoveryCode(code));
});

test('格式化：每 4 个字符一组、用连字符分隔', () => {
  assert.equal(formatRecoveryCode('ABCDEFGH23456789ABCDEFGH23456789'), 'ABCD-EFGH-2345-6789-ABCD-EFGH-2345-6789');
});

test('归一化遇到不合法字符抛错', () => {
  assert.throws(() => normalizeRecoveryCode('ABC$DEFG'), /恢复码/);
});
