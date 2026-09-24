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

// 真机上抓到的 bug：安卓系统 WebView 的版本由设备决定，旧设备上是 Chrome 83，
// 而 structuredClone 要 Chrome 98+。没有它就等于「备份导出」这个功能整条不可用，
// 用户只会看到一句没头没脑的「导出失败」。这条测试把那个环境固定下来。
test('没有 structuredClone 的环境（旧版安卓 WebView）里 buildBackup 仍可用', () => {
  const saved = globalThis.structuredClone;
  try {
    delete globalThis.structuredClone;
    assert.equal(typeof structuredClone, 'undefined', '前置条件：structuredClone 已被移除');

    const b = buildBackup(payload, 1);
    assert.deepEqual(b.data.txns, payload.txns);
    assert.equal(validateBackup(b).ok, true);
  } finally {
    globalThis.structuredClone = saved;
  }
});

test('buildBackup 是深拷贝：改原对象不影响备份内容', () => {
  const src = {
    txns: [{ id: 'a', amountCents: 100, tags: ['x'] }],
    accounts: [{ id: 'ac', name: '现金' }],
    categories: [],
    receivables: [],
    settings: [],
    vault: { ciphertext: 'abc' }
  };
  const b = buildBackup(src, 1);

  src.txns[0].amountCents = 999;
  src.txns[0].tags.push('y');
  src.accounts[0].name = '改了';
  src.vault.ciphertext = '改了';

  assert.equal(b.data.txns[0].amountCents, 100);
  assert.deepEqual(b.data.txns[0].tags, ['x']);
  assert.equal(b.data.accounts[0].name, '现金');
  assert.equal(b.data.vault.ciphertext, 'abc');
});
