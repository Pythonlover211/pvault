import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BACKUP_VERSION, buildBackup, validateBackup, summarizeBackup } from '../app/backup.js';

const payload = {
  txns: [{ id: 't1', kind: 'expense', amountCents: 100, occurredAt: 1 }],
  accounts: [{ id: 'a1', name: '现金' }],
  categories: [{ id: 'c1', name: '餐饮' }],
  receivables: [],
  settings: [{ key: 'hideAmounts', value: false }],
  vault: { version: 1, ciphertext: { iv: 'x', ct: 'y' } }
};

test('buildBackup 带上格式标识、版本与时间戳', () => {
  const b = buildBackup(payload, 1700000000000);
  assert.equal(b.format, 'pvault-backup');
  assert.equal(b.version, BACKUP_VERSION);
  assert.equal(b.createdAt, 1700000000000);
  assert.deepEqual(Object.keys(b.data).sort(), ['accounts', 'categories', 'receivables', 'settings', 'txns', 'vault']);
});

test('buildBackup 深拷贝，不引用原对象', () => {
  const b = buildBackup(payload, 1);
  b.data.accounts[0].name = '改了';
  assert.equal(payload.accounts[0].name, '现金');
});

test('validateBackup：合法包通过', () => {
  assert.equal(validateBackup(buildBackup(payload, 1)).ok, true);
});

test('validateBackup：非对象、缺格式、格式不对都被拒', () => {
  assert.equal(validateBackup(null).ok, false);
  assert.equal(validateBackup({}).ok, false);
  assert.equal(validateBackup({ format: 'other', version: 1, data: {} }).ok, false);
});

test('validateBackup：版本高于支持版本时给出明确提示', () => {
  const b = buildBackup(payload, 1);
  b.version = BACKUP_VERSION + 5;
  const r = validateBackup(b);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes('版本')));
});

test('validateBackup：data 缺关键数组时报错', () => {
  const b = buildBackup(payload, 1);
  delete b.data.txns;
  const r = validateBackup(b);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes('txns')));
});

test('validateBackup：vault 可以为 null（没设过密码箱）', () => {
  const b = buildBackup({ ...payload, vault: null }, 1);
  assert.equal(validateBackup(b).ok, true);
});

test('summarizeBackup 给出可读摘要', () => {
  const s = summarizeBackup(buildBackup(payload, 1700000000000));
  assert.equal(s.txns, 1);
  assert.equal(s.accounts, 1);
  assert.equal(s.categories, 1);
  assert.equal(s.hasVault, true);
  assert.equal(s.createdAt, 1700000000000);
});
