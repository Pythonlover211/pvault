// 浏览器 API 桩：给「函数一调用就要浏览器环境」的那几个模块用（眼下只有 app/backup-store.js）。
//
// 为什么需要它：app/db.js 的读写要一个 IndexedDB 环境，而 Node 里没有；零依赖约束又排除了引
// fake-indexeddb（见 docs/手动验证清单.md 开头那段），所以这里手写一个**只实现 app/db.js 用到的那几条**
// 的内存版。装在 globalThis 上而不是靠 import 钩子换模块：db.js 引用 indexedDB 的方式是裸全局
// （`indexedDB.open(DB_NAME, DB_VERSION)`），只要在调用之前把它放上去就够了，不必改任何生产代码。
//
// **它不是 IndexedDB 的仿真器，这份绿也不能读成「浏览器里也就这样」。** 下面把差异一次列全
// （前四条是第一版就写着的，后五条是复审逐个实测出来的——**漏写差异本身就是一种假绿**：
// 后来者会以为「桩通过 = 这条路径验过了」）：
//
//  1. **事务的真实隔离与回滚**：abort() 只改一个标记，已经写进 Map 的数据不会退回去。
//     所以它**盖不住** db.replaceAllRecords 那条「中途失败不留半库」的保证——那一条只能靠真机与评审。
//  2. **请求的失败路径**：put / get 永远成功，onerror 一次都不会被调到（配额满、事务中止、
//     死锁这些真实失败在桩上不存在）。
//  3. **版本升级的真实语义**：onblocked、旧连接挡升级、versionchange 让路全都不存在。
//  4. **索引的空值语义**：真实 IndexedDB **不索引** keyPath 为 null / undefined 的记录
//     （schema.js 里那段注释讲的就是这个坑）。桩照做（见 index().getAll）；但 IDBKeyRange.only(null)
//     在真实环境里抛 DataError，桩连 only 都没有（见第 6 条）。
//  5. **索引查询**：getAll(query, count) 三种形态都实现了（省略 query / 传 key 等值 / 传 IDBKeyRange），
//     也会按 count 截断；**但 key 只支持 string / number**（真实 IDB 还接受 Date、ArrayBuffer、
//     多键路径的数组），传别的类型不会做真实那套结构化比较。
//     （第一版这里**一条都不过滤**，`getAllByIndex('txns','by_kind','food')` 会返回全部记录——
//     静默的错误结果比抛错危险得多。已修，并留了一条常驻断言钉住它。）
//  6. **IDBKeyRange**：只实现 bound()（app/db.js 的 getByRange 用它）。only / lowerBound / upperBound
//     没实现——用到就报错，不会给假结果。
//  7. **事务活跃期**：oncomplete 之后再入队会抛 TransactionInactiveError（与真实一致）；但没有真实的
//     自动提交时机差异——桩里所有操作都是同步立即生效的。
//  8. **主键类型**：只接受 string / number，取不到（或取到 null / undefined）时**同步**抛 DataError
//     （与真实一致，db.js 的 enqueue 就是为这个同步抛错写的）。Date / ArrayBuffer 这些真实合法的
//     主键类型没实现。
//  9. **FileReader**：只在「喂进去的不是 Blob」这一条上与真实不同——桩**同步抛** TypeError
//     （WebIDL 的类型检查也是同步抛，但真实 FileReader 是抛错还是派发 onerror，这里没有真机核实过）。
//     两条路对被测代码等价：backup-store.js 的 blobToBase64 把 readAsDataURL 整个包在 Promise 里，
//     同步抛错同样变成 rejection，被 encodeFiles / encodeBackground 的 try 收住。
//
// 它盖得住的是**数据形状**：谁写了什么、删了什么、清了什么、导入导出之后库里还剩什么——这正是
// backup-store 的导入导出需要被钉住的那一层。盖不住的那些仍然只能靠 docs/手动验证清单.md 的真机条目。

const databases = new Map();   // 库名 -> { version, stores: Map<表名, Store> }

class Store {
  constructor(keyPath) {
    this.keyPath = keyPath;
    this.indexes = new Map();
    this.data = new Map();
  }

  put(value) {
    // 真实 IDB 在取不出 keyPath（或缺 key、key 为 null）时**同步**抛 DataError，而且这个异常不会
    // 自动中止事务（db.js 的 enqueue 就是为它写的）。桩照抛，好让「少了 key」这类错误照样炸出来。
    const key = value == null ? undefined : value[this.keyPath];
    if (key === undefined || key === null || (typeof key !== 'string' && typeof key !== 'number')) {
      throw new Error(`DataError: 记录里取不出合法的主键（keyPath「${this.keyPath}」）`);
    }
    this.data.set(key, value);
    return settledRequest(value);
  }

  get(key) { return settledRequest(this.data.get(key)); }
  getAll() { return settledRequest([...this.data.values()]); }
  count() { return settledRequest(this.data.size); }
  clear() { this.data.clear(); return settledRequest(undefined); }
  delete(key) { this.data.delete(key); return settledRequest(undefined); }

  createIndex(name, keyPath) { this.indexes.set(name, keyPath); }

  index(name) {
    const keyPath = this.indexes.get(name);
    if (keyPath === undefined) throw new Error(`NotFoundError: 没有索引 ${name}`);
    return {
      // 三种调用形态都要对：省略 query（全部）、传 key（等值）、传 IDBKeyRange（范围）。
      // 第一版只做了「按范围过滤」，于是传 key 时**一条都不过滤**——那是静默的错误结果。
      getAll: (query, count) => {
        const rows = [...this.data.values()].filter(v => {
          const key = v[keyPath];
          // 真实 IndexedDB 不索引 null / undefined 的键（见文件头第 4 条）。
          if (key === undefined || key === null) return false;
          return matchIndexQuery(key, query);
        });
        return settledRequest(typeof count === 'number' ? rows.slice(0, count) : rows);
      }
    };
  }
}

function matchIndexQuery(key, query) {
  if (query === undefined) return true;
  if (query instanceof FakeKeyRange) return inRange(key, query);
  return key === query;
}

function inRange(key, range) {
  const lowerOk = range.lower === undefined
    || (range.lowerOpen ? key > range.lower : key >= range.lower);
  const upperOk = range.upper === undefined
    || (range.upperOpen ? key < range.upper : key <= range.upper);
  return lowerOk && upperOk;
}

// 只实现 bound（app/db.js 的 getByRange 用得到）。only / lowerBound / upperBound 没实现：
// 用了会报错，不会给出假结果——这也是一种诚实（见文件头第 6 条）。
class FakeKeyRange {
  constructor(lower, upper, lowerOpen, upperOpen) {
    this.lower = lower;
    this.upper = upper;
    this.lowerOpen = lowerOpen;
    this.upperOpen = upperOpen;
  }

  static bound(lower, upper, lowerOpen = false, upperOpen = false) {
    return new FakeKeyRange(lower, upper, lowerOpen, upperOpen);
  }
}

// 请求的回调必须在**赋值之后**才触发：db.js 的写法是
// `const req = store.get(k); req.onsuccess = …`——同步触发的话 onsuccess 还是 null。
function settledRequest(value) {
  const req = { result: undefined, error: null, onsuccess: null, onerror: null };
  setTimeout(() => { req.result = value; req.onsuccess?.(); }, 0);
  return req;
}

class Database {
  constructor(name, meta) {
    this.name = name;
    this._meta = meta;
    this.onversionchange = null;
  }

  get objectStoreNames() { return { contains: n => this._meta.stores.has(n) }; }

  createObjectStore(name, { keyPath }) {
    const store = new Store(keyPath);
    this._meta.stores.set(name, store);
    return store;
  }

  transaction(names) {
    const list = Array.isArray(names) ? names : [names];
    // db.js 的注释记着「db.transaction([]) 抛 InvalidAccessError，不是 no-op」——桩照抛，
    // 否则「空清单」这种调用在测试里会静默通过，而它在浏览器里必炸。
    if (list.length === 0) throw new Error('InvalidAccessError: 空的仓库清单');
    for (const n of list) this._store(n);   // 真实 IDB 也在建事务时就校验表名
    return new Transaction(this, list);
  }

  close() { /* 不实现连接的关闭语义：桩里没有阻塞与版本让路这件事 */ }

  _store(name) {
    const s = this._meta.stores.get(name);
    if (!s) throw new Error(`NotFoundError: ${this.name} 里没有 ${name} 这张表`);
    return s;
  }
}

class Transaction {
  constructor(db, names) {
    this.db = db;
    this.names = names;
    this.oncomplete = null;
    this.onabort = null;
    this.error = null;
    this._active = true;
    // 所有操作都是**同步立即生效**的，这里只是把完成回调推到本轮同步代码之后——
    // db.js 的 `await txDone(tx)` 在同一轮里才挂上 oncomplete。
    setTimeout(() => {
      this._active = false;
      this.oncomplete?.();
    }, 0);
  }

  objectStore(name) {
    // 真实 IDB 在事务结束后再取 objectStore 会抛 TransactionInactiveError；桩照抛，
    // 免得「oncomplete 之后还在入队」这种写法在测试里静默通过。
    if (!this._active) throw new Error('TransactionInactiveError: 事务已经结束');
    if (!this.names.includes(name)) throw new Error(`NotFoundError: 这次事务没有覆盖 ${name}`);
    return this.db._store(name);
  }

  abort() { this._active = false; }
}

export function installFakeBrowser() {
  globalThis.IDBKeyRange = FakeKeyRange;

  globalThis.indexedDB = {
    open(name, version) {
      const known = databases.get(name);
      const fresh = known === undefined || version > known.version;
      const meta = fresh ? { version, stores: known?.stores ?? new Map() } : known;
      if (fresh) databases.set(name, meta);

      const db = new Database(name, meta);
      const req = { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      setTimeout(() => {
        req.result = db;   // applyMigrations 读的是 req.result，必须先放上去
        if (fresh) req.onupgradeneeded?.({ oldVersion: known?.version ?? 0 });
        req.onsuccess?.();
      }, 0);
      return req;
    }
  };

  globalThis.FileReader = class {
    constructor() {
      this.result = null;
      this.error = null;
      this.onload = null;
      this.onerror = null;
    }

    readAsDataURL(blob) {
      if (!(blob instanceof Blob)) {
        // 见文件头第 9 条：桩在这里同步抛（真实是抛错还是派发 onerror，这里没有核实过）。
        throw new TypeError('FileReader: 喂进来的不是 Blob');
      }
      blob.arrayBuffer().then(
        buf => {
          this.result = `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(buf).toString('base64')}`;
          this.onload?.();
        },
        err => { this.error = err; this.onerror?.(); }
      );
    }
  };
}

// 清掉所有表里的数据（**保留表结构**）。db.js 会把连接缓存在模块级的 dbPromise 里，
// 换成「重建一个空库」会让那份缓存指向旧的 store 对象——所以隔离只清内容，不动结构。
export function resetFakeDatabases() {
  for (const meta of databases.values()) {
    for (const store of meta.stores.values()) store.data.clear();
  }
}
