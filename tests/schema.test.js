import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DB_NAME, DB_VERSION, STORES,
  applyMigrations, seedAccounts, seedCategories, seedSettings
} from '../app/schema.js';

// ── seedAccounts ─────────────────────────────────────────────

test('seedAccounts 返回 5 个账户且 id 唯一', () => {
  const accounts = seedAccounts();
  assert.equal(accounts.length, 5);
  assert.equal(new Set(accounts.map(a => a.id)).size, 5);
});

test('seedAccounts 含一个信用账户并带账单日与还款日', () => {
  const credits = seedAccounts().filter(a => a.kind === 'credit');
  assert.equal(credits.length, 1);
  assert.equal(credits[0].id, 'acc-credit');
  assert.equal(typeof credits[0].billDay, 'number');
  assert.equal(typeof credits[0].dueDay, 'number');
});

test('seedAccounts 只有信用账户默认追踪余额', () => {
  for (const a of seedAccounts()) {
    assert.equal(a.trackBalance, a.kind === 'credit');
  }
});

test('seedAccounts 的 sort 严格递增', () => {
  const accounts = seedAccounts();
  for (let i = 1; i < accounts.length; i++) {
    assert.ok(accounts[i].sort > accounts[i - 1].sort, `第 ${i} 项 sort 未递增`);
  }
});

// ── seedCategories ───────────────────────────────────────────

test('seedCategories 返回 12 个分类且 id 唯一', () => {
  const cats = seedCategories();
  assert.equal(cats.length, 12);
  assert.equal(new Set(cats.map(c => c.id)).size, 12);
});

test('seedCategories 支出 9 个、收入 3 个，kind 只有两种取值', () => {
  const cats = seedCategories();
  assert.equal(cats.filter(c => c.kind === 'expense').length, 9);
  assert.equal(cats.filter(c => c.kind === 'income').length, 3);
  for (const c of cats) {
    assert.ok(c.kind === 'expense' || c.kind === 'income', `非法 kind: ${c.kind}`);
  }
});

test('seedCategories 每个分类都有名称与 emoji 图标', () => {
  for (const c of seedCategories()) {
    assert.equal(typeof c.name, 'string');
    assert.ok(c.name.length > 0, `${c.id} 名称为空`);
    assert.equal(typeof c.icon, 'string');
    assert.ok(/\p{Extended_Pictographic}/u.test(c.icon), `${c.id} 图标不是 emoji: ${c.icon}`);
  }
});

test('seedCategories 同类内 sort 严格递增', () => {
  for (const kind of ['expense', 'income']) {
    const list = seedCategories().filter(c => c.kind === kind);
    for (let i = 1; i < list.length; i++) {
      assert.ok(list[i].sort > list[i - 1].sort, `${kind} 第 ${i} 项 sort 未递增`);
    }
  }
});

test('seedCategories 中 cat-food 是「餐饮」、cat-salary 是收入', () => {
  const cats = seedCategories();
  assert.equal(cats.find(c => c.id === 'cat-food').name, '餐饮');
  assert.equal(cats.find(c => c.id === 'cat-salary').kind, 'income');
});

// ── seedSettings ─────────────────────────────────────────────

test('seedSettings 每项形如 { key, value } 且 key 唯一', () => {
  const items = seedSettings();
  assert.ok(Array.isArray(items));
  assert.ok(items.length > 0);
  for (const s of items) {
    assert.deepEqual(Object.keys(s).sort(), ['key', 'value']);
  }
  assert.equal(new Set(items.map(s => s.key)).size, items.length);
});

test('seedSettings 包含全部默认设置项', () => {
  const map = new Map(seedSettings().map(s => [s.key, s.value]));
  assert.equal(map.get('hideAmounts'), false);
  assert.equal(map.get('budgetTotalCents'), 0);
  assert.deepEqual(map.get('budgetByCategory'), {});
  assert.deepEqual(map.get('recurring'), []);
  assert.equal(map.get('lastBackupAt'), null);
  assert.ok(map.has('budgetByCategory') && map.has('recurring') && map.has('lastBackupAt'));
});

// ── 常量与仓库定义 ───────────────────────────────────────────

test('DB_NAME 与 DB_VERSION 符合约定', () => {
  assert.equal(DB_NAME, 'pvault');
  assert.ok(Number.isInteger(DB_VERSION) && DB_VERSION > 0);
});

test('STORES 覆盖全部 8 个仓库且每个都有 keyPath', () => {
  assert.deepEqual(
    Object.keys(STORES).sort(),
    ['accounts', 'categories', 'invoiceFiles', 'invoices', 'receivables', 'reimbursements', 'settings', 'txns']
  );
  for (const [name, def] of Object.entries(STORES)) {
    assert.equal(typeof def.keyPath, 'string', `${name} 缺少 keyPath`);
    assert.ok(Array.isArray(def.indexes), `${name} 缺少 indexes 数组`);
  }
});

test('STORES 的索引名与字段符合查询需求', () => {
  assert.deepEqual(STORES.txns.indexes, [['by_occurredAt', 'occurredAt'], ['by_kind', 'kind']]);
  assert.deepEqual(STORES.categories.indexes, [['by_kind', 'kind']]);
  assert.deepEqual(STORES.receivables.indexes, [['by_settledAt', 'settledAt']]);
});

// ── applyMigrations（用极简假 db 验证建库动作） ──────────────

function fakeDb(existing = []) {
  const created = new Map();
  return {
    created,
    objectStoreNames: { contains: name => existing.includes(name) },
    createObjectStore(name, opts) {
      const rec = { keyPath: opts.keyPath, indexes: [] };
      created.set(name, rec);
      return {
        createIndex(indexName, keyPath) { rec.indexes.push([indexName, keyPath]); }
      };
    }
  };
}

test('applyMigrations 按 STORES 建仓并建索引', () => {
  const db = fakeDb();
  applyMigrations(db, 0);
  assert.deepEqual([...db.created.keys()], Object.keys(STORES));
  for (const [name, def] of Object.entries(STORES)) {
    assert.equal(db.created.get(name).keyPath, def.keyPath);
    assert.deepEqual(db.created.get(name).indexes, def.indexes);
  }
});

test('applyMigrations 不重复创建已存在的仓库', () => {
  const db = fakeDb(['txns', 'settings']);
  applyMigrations(db, 1);
  assert.ok(!db.created.has('txns'));
  assert.ok(!db.created.has('settings'));
  assert.deepEqual(
    [...db.created.keys()],
    ['accounts', 'categories', 'receivables', 'invoices', 'invoiceFiles', 'reimbursements']
  );
});

test('applyMigrations 返回传入的 oldVersion', () => {
  assert.equal(applyMigrations(fakeDb(), 3), 3);
});

test('STORES 里有发票相关的三张表', () => {
  assert.ok(STORES.invoices, '缺少 invoices 表');
  assert.ok(STORES.invoiceFiles, '缺少 invoiceFiles 表');
  assert.ok(STORES.reimbursements, '缺少 reimbursements 表');
  assert.equal(STORES.invoices.keyPath, 'id');
  assert.equal(STORES.invoiceFiles.keyPath, 'id');
  assert.equal(STORES.reimbursements.keyPath, 'id');
});

test('invoices 的索引齐全（查重与挂靠都要用）', () => {
  const names = STORES.invoices.indexes.map(([n]) => n).sort();
  assert.deepEqual(names, ['by_issuedAt', 'by_number', 'by_reimbursement', 'by_txn']);
});

test('DB_VERSION 已提到 2', () => {
  assert.equal(DB_VERSION, 2);
});

test('迁移只建缺失的表，已有的表不重复创建', () => {
  const created = [];
  const fakeDb = {
    objectStoreNames: { contains: (n) => n === 'accounts' },
    createObjectStore: (name) => {
      created.push(name);
      return { createIndex: () => {} };
    }
  };
  applyMigrations(fakeDb, 1);
  assert.ok(!created.includes('accounts'), '已存在的表不该重建');
  assert.ok(created.includes('invoices'));
  assert.ok(created.includes('invoiceFiles'));
  assert.ok(created.includes('reimbursements'));
});
