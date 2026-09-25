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
  assert.deepEqual(Object.keys(b.data).sort(),
    ['accounts', 'categories', 'invoiceFiles', 'invoices', 'receivables', 'settings', 'txns', 'vault']);
});

// 加发票功能之后新增的两个键。它们**必须**始终出现在备份包里（哪怕是空数组）：
// 导入侧靠「这个键在不在」来决定要不要清空对应的表——老备份没有这个键，就保留本机现有发票。
test('buildBackup：payload 里没有发票时补空数组，键始终在', () => {
  const b = buildBackup(payload, 1);
  assert.deepEqual(b.data.invoices, []);
  assert.deepEqual(b.data.invoiceFiles, []);
});

test('buildBackup：发票条目与图片 base64 串原样带上', () => {
  const src = {
    ...payload,
    invoices: [{ id: 'i1', number: '123', amountCents: 100, fileId: 'f1' }],
    invoiceFiles: [{ id: 'f1', mime: 'image/jpeg', size: 3, createdAt: 5, blob: 'AAAA', thumbBlob: null }]
  };
  const b = buildBackup(src, 1);
  assert.deepEqual(b.data.invoices, src.invoices);
  assert.deepEqual(b.data.invoiceFiles, src.invoiceFiles);
  // 发票条目仍然是深拷贝：备份包不该被调用方随后的改动牵动。
  assert.notEqual(b.data.invoices, src.invoices);
});

// 图片那一项刻意与上面相反：直接拿引用，不深拷贝。
// 一份带几百张图的备份光 base64 就有几十上百 MB，structuredClone 会把它整份复制一遍，
// 手机上这一下就够触发内存告警——而导出失败等于用户没有任何备份。
// 数组由 exportBackup 里的 encodeFiles() 现造现交，没有第二个人持有它，共享引用是安全的。
test('buildBackup：图片的 base64 数组刻意不深拷贝（大数组复制第二遍会把内存打爆）', () => {
  const src = { ...payload, invoiceFiles: [{ id: 'f1', blob: 'AAAA' }] };
  const b = buildBackup(src, 1);
  assert.equal(b.data.invoiceFiles, src.invoiceFiles);
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

// 这条是整个发票改动的**兼容性底线**：加发票之前导出的备份文件里没有 invoices / invoiceFiles
// 这两个键，而它们是「恢复备份」这条唯一救命通道每天要面对的文件。
// 只要有人把这两个新字段写进 REQUIRED_ARRAYS，所有老备份就会在解密后的校验里被判「内容不完整」，
// 用户再也导不进来——这条测试就是拦这一手的。
test('validateBackup：老备份（data 里没有 invoices / invoiceFiles）仍然合法', () => {
  const b = buildBackup(payload, 1);
  delete b.data.invoices;
  delete b.data.invoiceFiles;
  const r = validateBackup(b);
  assert.equal(r.ok, true, '加发票之前导出的备份必须还能导入');
  assert.deepEqual(r.errors, []);
});

test('summarizeBackup 给出可读摘要', () => {
  const s = summarizeBackup(buildBackup(payload, 1700000000000));
  assert.equal(s.txns, 1);
  assert.equal(s.accounts, 1);
  assert.equal(s.categories, 1);
  assert.equal(s.hasVault, true);
  assert.equal(s.createdAt, 1700000000000);
  assert.equal(s.invoices, 0);
  assert.equal(s.invoiceFiles, 0);
});

test('summarizeBackup 报出发票张数与发票图片张数', () => {
  const b = buildBackup({
    ...payload,
    invoices: [{ id: 'i1' }, { id: 'i2' }],
    invoiceFiles: [{ id: 'f1', blob: 'AAAA' }]
  }, 1);
  const s = summarizeBackup(b);
  assert.equal(s.invoices, 2);
  assert.equal(s.invoiceFiles, 1);
  assert.equal(s.hasInvoices, true);
  assert.equal(s.hasInvoiceFiles, true);
});

// 条数都是 0，处置却完全相反：文件里没有这两项（加发票之前导出的老备份）时，
// 导入会**保留**本机现有发票与图片；文件里有、但是空的（从一台还没录过发票的设备导出的新备份）时，
// 导入会把本机发票清空。界面就是靠 hasInvoices / hasInvoiceFiles 把这两句话分开的，
// 只报条数会让用户在两件结果相反的事之间猜。
test('summarizeBackup：能分辨「文件里没有发票」与「文件里有 0 张发票」', () => {
  const oldFile = buildBackup(payload, 1);
  delete oldFile.data.invoices;
  delete oldFile.data.invoiceFiles;
  const old = summarizeBackup(oldFile);
  assert.equal(old.invoices, 0);
  assert.equal(old.hasInvoices, false);
  assert.equal(old.invoiceFiles, 0);
  assert.equal(old.hasInvoiceFiles, false);

  const newFile = summarizeBackup(buildBackup({ ...payload, invoices: [], invoiceFiles: [] }, 1));
  assert.equal(newFile.invoices, 0);
  assert.equal(newFile.hasInvoices, true, '新备份里这个键一定在，哪怕一张票都没有');
  assert.equal(newFile.invoiceFiles, 0);
  assert.equal(newFile.hasInvoiceFiles, true);
});

test('summarizeBackup：data 缺失或键类型不对时不抛错，按 0 / 不含处理', () => {
  const s = summarizeBackup({ data: { invoices: '不是数组' } });
  assert.equal(s.invoices, 0);
  assert.equal(s.hasInvoices, false);
  assert.equal(s.txns, 0);

  // 备份包整个不是对象（界面上已经拦掉，但这里也不该炸）：
  const empty = summarizeBackup(null);
  assert.equal(empty.txns, 0);
  assert.equal(empty.invoices, 0);
  assert.equal(empty.hasInvoices, false);
  assert.equal(empty.createdAt, null);
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
