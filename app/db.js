// IndexedDB 薄封装：只做读写，不写业务逻辑。
// 依赖 indexedDB / IDBKeyRange 浏览器全局，因此不能在 Node 里被 import
// （app/ 根目录下的纯逻辑模块也绝不能 import 本文件）。验证方式见 docs/手动验证清单.md。

import { DB_NAME, DB_VERSION, applyMigrations, seedAccounts, seedCategories, seedSettings } from './schema.js';

let dbPromise = null;

export function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = event => {
      applyMigrations(req.result, event.oldVersion);
    };
    req.onsuccess = async () => {
      const db = req.result;
      try {
        await ensureSeeded(db);
      } catch (e) {
        db.close();
        reject(e);
        return;
      }
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  }).catch(err => {
    // 失败的连接不能永久缓存：否则本次页面生命周期内数据层彻底不可用，只能刷新。
    // 置回 null 让下一次调用重新尝试打开。
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

// 请求级错误会自然冒泡并中止事务，所以只认 oncomplete / onabort。
// 注意不能在 onerror 里 reject(tx.error)：规范里 tx.error 要等到「中止事务」步骤才赋值，
// 此刻它还是 null，抛出 null 会让调用方读 err.message 时反过来抛 TypeError。
function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('IndexedDB 事务被中止'));
  });
}

// 只在 settings 为空时写入种子：首次打开写一次，之后每次打开都直接返回。
async function ensureSeeded(db) {
  const count = await new Promise((resolve, reject) => {
    const tx = db.transaction('settings', 'readonly');
    const req = tx.objectStore('settings').count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  if (count > 0) return;
  const tx = db.transaction(['accounts', 'categories', 'settings'], 'readwrite');
  for (const a of seedAccounts()) tx.objectStore('accounts').put(a);
  for (const c of seedCategories()) tx.objectStore('categories').put(c);
  for (const s of seedSettings()) tx.objectStore('settings').put(s);
  await txDone(tx);
}

export async function put(store, value) {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value);
  await txDone(tx);
  return value;
}

// 在事务里入队操作，并保证「同步抛出的错误」不会留下半截提交。
// 为什么必须这么写：事务只对**异步**失败有效。objectStore.put() / .delete() / .clear()
// **同步**抛出的 DataError（value 不是对象、取不出 keyPath、key 类型不合法）不会自动中止
// 事务，先前入队的操作会照常提交——调用方以为「整批要么全成、要么全不成」，实际拿到的是
// 半截数据（putAll 写交易、replaceAll 清库重写、removeAll 撤销导入都吃这一口）。
// 所以同步抛错时显式 abort() 整批回滚，再把原始错误原样抛给调用方。
// abort 自己也可能抛（事务已经不在活动态时抛 InvalidStateError）：那种情况下原始错误
// 信息比回滚失败重要得多，吞掉它，别让调用方看到一个假的失败原因。
function enqueue(tx, fill) {
  try {
    fill();
  } catch (err) {
    try {
      tx.abort();
    } catch { /* 事务已经结束：没什么可回滚的 */ }
    throw err;
  }
}

// 批量写入：一个事务里可以访问多个仓库，让「交易 + 派生应收」这类跨仓库的写入
// 要么全成、要么全不成。entries 形如 [{ store, value }]。
// 注意：db.transaction([]) 抛的是 InvalidAccessError，**不是** no-op。所以「空数组不要
// 调 putAll / removeAll」是隐式调用方契约——commitImport 与 undoImport 都各自挡住了空数组。
export async function putAll(entries) {
  const db = await open();
  const names = [...new Set(entries.map(e => e.store))];
  const tx = db.transaction(names, 'readwrite');
  enqueue(tx, () => {
    for (const e of entries) tx.objectStore(e.store).put(e.value);
  });
  await txDone(tx);
}

// 在单个事务里清空若干仓库并写入若干记录。导入备份时用：
// 「清空」与「写入」必须在同一个事务内，否则中途失败会留下一个空库。
export async function replaceAll({ clears = [], puts = [] }) {
  const db = await open();
  const names = [...new Set([...clears, ...puts.map(e => e.store)])];
  const tx = db.transaction(names, 'readwrite');
  enqueue(tx, () => {
    for (const name of clears) tx.objectStore(name).clear();
    for (const e of puts) tx.objectStore(e.store).put(e.value);
  });
  await txDone(tx);
}

export async function get(store, key) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getAll(store) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// 按索引取 [lower, upper) 区间：上界开区间，因为调用方传的 end 是「下月 1 日 0 点」，
// 那一瞬间不该被算进本月。
export async function getByRange(store, indexName, lower, upper) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const range = IDBKeyRange.bound(lower, upper, false, true);
    const req = db.transaction(store, 'readonly').objectStore(store).index(indexName).getAll(range);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function remove(store, key) {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  await txDone(tx);
}

// 批量删除：与 putAll 对称，同样在一个事务里跨仓库删除。entries 形如 [{ store, key }]。
// 这里的 try/abort 不是照抄：store.delete() 同步抛 DataError（key 类型不合法）时事务不会
// 自动中止，前面已入队的 delete 照常提交，于是「撤销一次导入」变成半截删除——用户看到的
// 是记录还在，而浮层已经说了撤销成功。走 enqueue 与 putAll / replaceAll 保持同一处置。
export async function removeAll(entries) {
  const db = await open();
  const names = [...new Set(entries.map(e => e.store))];
  const tx = db.transaction(names, 'readwrite');
  enqueue(tx, () => {
    for (const e of entries) tx.objectStore(e.store).delete(e.key);
  });
  await txDone(tx);
}
