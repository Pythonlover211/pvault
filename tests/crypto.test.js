import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ITERATIONS, toBase64, fromBase64, randomBytes,
  deriveKey, generateDek, wrapDek, unwrapDek, importDek,
  encryptJSON, decryptJSON
} from '../app/crypto.js';

test('base64 往返', () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 255]);
  assert.deepEqual(fromBase64(toBase64(bytes)), bytes);
});

test('randomBytes 长度正确且每次不同', () => {
  const a = randomBytes(32);
  const b = randomBytes(32);
  assert.equal(a.length, 32);
  assert.notDeepEqual(a, b);
});

test('deriveKey 同一密码同一盐得到同一密钥（可解密彼此的密文）', async () => {
  const salt = randomBytes(16);
  const k1 = await deriveKey('correct horse', salt, 1000);
  const k2 = await deriveKey('correct horse', salt, 1000);
  const payload = await encryptJSON(k1, { hello: 'world' });
  assert.deepEqual(await decryptJSON(k2, payload), { hello: 'world' });
});

test('deriveKey 不同密码得到的密钥无法解密', async () => {
  const salt = randomBytes(16);
  const k1 = await deriveKey('password-a', salt, 1000);
  const k2 = await deriveKey('password-b', salt, 1000);
  const payload = await encryptJSON(k1, { secret: 1 });
  await assert.rejects(() => decryptJSON(k2, payload));
});

test('deriveKey 不同盐得到的密钥无法解密', async () => {
  const k1 = await deriveKey('same', randomBytes(16), 1000);
  const k2 = await deriveKey('same', randomBytes(16), 1000);
  const payload = await encryptJSON(k1, { secret: 1 });
  await assert.rejects(() => decryptJSON(k2, payload));
});

test('DEK 包裹与解包往返', async () => {
  const dek = generateDek();
  const kek = await deriveKey('master', randomBytes(16), 1000);
  const wrapped = await wrapDek(kek, dek);
  const unwrapped = await unwrapDek(kek, wrapped);
  const payload = await encryptJSON(dek, { a: 1 });
  assert.deepEqual(await decryptJSON(unwrapped, payload), { a: 1 });
});

test('importDek 把原始字节转成可用的密钥', async () => {
  const dek = generateDek();
  const key = await importDek(dek);
  const payload = await encryptJSON(key, { ok: true });
  assert.deepEqual(await decryptJSON(await importDek(dek), payload), { ok: true });
});

test('错误的 KEK 解不开包裹的 DEK', async () => {
  const dek = generateDek();
  const good = await deriveKey('good', randomBytes(16), 1000);
  const bad = await deriveKey('bad', randomBytes(16), 1000);
  const wrapped = await wrapDek(good, dek);
  await assert.rejects(() => unwrapDek(bad, wrapped));
});

test('密文被篡改时解密失败（GCM 认证标签生效）', async () => {
  const key = await deriveKey('k', randomBytes(16), 1000);
  const payload = await encryptJSON(key, { amount: 100 });
  const bytes = fromBase64(payload.ct);
  bytes[0] ^= 0x01;
  const tampered = { ...payload, ct: toBase64(bytes) };
  await assert.rejects(() => decryptJSON(key, tampered));
});

test('每次加密使用不同的 IV', async () => {
  const key = await deriveKey('k', randomBytes(16), 1000);
  const p1 = await encryptJSON(key, { x: 1 });
  const p2 = await encryptJSON(key, { x: 1 });
  assert.notEqual(p1.iv, p2.iv);
});

test('能加密中文与嵌套结构', async () => {
  const key = await deriveKey('k', randomBytes(16), 1000);
  const data = { 标题: '招商银行', 字段: { 卡号: '6225 8888', tags: ['a', 'b'] }, n: null };
  assert.deepEqual(await decryptJSON(key, await encryptJSON(key, data)), data);
});

test('派生密钥的默认迭代次数是 600000', () => {
  assert.equal(DEFAULT_ITERATIONS, 600000);
});
