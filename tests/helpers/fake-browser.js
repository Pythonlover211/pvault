// 浏览器 API 桩：给「函数一调用就要浏览器环境」的那几个模块用——眼下是 app/backup-store.js、
// app/store.js、app/invoice-store.js 与 app/reimburse-store.js。这份清单过期时别含糊成「还有别的」：
// 它决定了后来者该不该相信这里的绿——每多一个直接走 IndexedDB 的模块，就可能要多认一条差异
// （下面清单的第 9、10 条就是这么长出来的）。
//
// 为什么需要它：app/db.js 的读写要一个 IndexedDB 环境，而 Node 里没有；零依赖约束又排除了引
// fake-indexeddb（见 docs/手动验证清单.md 开头那段），所以这里手写一个**只实现 app/db.js 用到的那几条**
// 的内存版。装在 globalThis 上而不是靠 import 钩子换模块：db.js 引用 indexedDB 的方式是裸全局
// （`indexedDB.open(DB_NAME, DB_VERSION)`），只要在调用之前把它放上去就够了，不必改任何生产代码。
//
// **它不是 IndexedDB 的仿真器，这份绿也不能读成「浏览器里也就这样」。** 下面把差异一次列全
// （前四条是第一版就写着的，后六条是复审逐个实测出来的——**漏写差异本身就是一种假绿**：
// 后来者会以为「桩通过 = 这条路径验过了」）：
//
//  1. **事务的真实隔离与回滚**：abort() 只改一个标记，已经写进 Map 的数据不会退回去。
//     所以它**盖不住** db.replaceAllRecords 那条「中途失败不留半库」的保证——那一条只能靠真机与评审。
//  2. **请求的失败路径**：put / get 默认永远成功，onerror 一次都不会被调到（配额满、事务中止、
//     死锁这些真实失败在桩上不存在）。想验「写失败被翻成人话」，唯一的口子是导出的
//     failNextWrite(storeName, err)——它把某张表的下一次 put 换成同步抛 err 的版本。
//     注意它注入的是**异常本身**，不是事务语义：回滚仍然没有（见第 1 条），
//     所以别拿它验「写失败之后库里没有半截」。
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
// 10. **事务的 mode**：真实 IDB 会**校验** mode（只认 readonly / readwrite / versionchange 那几个
//     字面量，写错抛 TypeError）；桩不校验，mode 判定的唯一用处是决定要不要计数。
//     所以「把 readwrite 拼错」在桩上只会安静地少计一次，不会报错——真机上同一处直接抛。
//     （事务计数本身也是复审才加进这份桩的，见下面 transactionCount 的注释。）
//
// 它盖得住的是**数据形状**：谁写了什么、删了什么、清了什么、导入导出之后库里还剩什么——这正是
// backup-store 的导入导出需要被钉住的那一层。盖不住的那些仍然只能靠 docs/手动验证清单.md 的真机条目。

const databases = new Map();   // 库名 -> { version, stores: Map<表名, Store> }

// 事务计数：给「这几处写入必须落在同一个事务里」这类判据用。
//
// 桩的回滚是假的（见文件头第 1 条：abort() 只改标记，写进 Map 的数据不会退回去），
// 所以「中途失败不留半截」这条**验不了**。但「只发起了几个**写**事务」是能验的，
// 而它恰好是那条保证的**结构前提**：一次 db.putAll / replaceAllRecords 就是一个写事务，
// 把它拆成两次调用，计数就多 1。这是桩能给出的最诚实的那个信号。
//
// **只数 readwrite，不数 readonly**——这一条是 2026-09-28 复审实测纠正的：自增最初写在
// `transaction()` 的第一行，于是 db.get() 那种只读事务也被数进去，判据的基数从 1 变成 2
// （读一次 + 写一次），而下面那些 `assert.equal(transactionCount() - before, 1)` 在**正确
// 实现下也会红**——一条永远红的断言不区分「拆没拆」，等于什么都没验。加上 mode 判定之后
// 「一次批量写 = 1」才成立，把一次写入拆成两次也才会让它变成 2。
//
// **txCount 单调递增、永不重置**：resetFakeDatabases 也不清它（那个函数只清表里的数据）。
// 断言一律用**差值**口径——`const before = transactionCount(); …; assert.equal(transactionCount() - before, 1)`。
// 绝对计数（`assert.equal(transactionCount(), 1)`）是真实的诱惑，但它必然红，而红线指向的是被测代码、
// 真凶却在桩里（同进程里别的测试文件先跑过，计数早就不是 0 了，加 --test-isolation=none 之后更是如此）。
// 这类假红最贵：找的是一个不存在的 bug。
let txCount = 0;

export function transactionCount() {
  return txCount;
}

/**
 * 让某张表的下一次写入同步抛出 err，返回一个还原函数（幂等，写完没写完都可以调）。
 *
 * 为什么要有这个口子：桩的 put 永远成功（见文件头第 2 条），于是「写入失败被翻成人话」
 * 这条路径在桩上一次也走不到——而它恰恰是唯一需要 catch 的地方，也是最容易被顺手删掉的地方。
 * 注入的是**异常本身**，不是事务语义：回滚仍然没有（见文件头第 1 条），
 * 所以别拿它验「写失败之后库里没有半截」。
 *
 * 只换一次：put 被调用就自动还原。调用方仍应显式再还原一次（fn 里写入没走到 put 时，
 * 比如前面的守卫先抛了），否则那张表在余下的测试里会一直是坏的。
 */
export function failNextWrite(storeName, err) {
  const store = findStore(storeName);
  if (!store) throw new Error(`NotFoundError: 桩里还没有 ${storeName} 这张表（先让它被打开一次）`);
  const original = store.put;
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    store.put = original;
  };
  store.put = () => { restore(); throw err; };
  return restore;
}

// 按表名找到桩里的 Store 实例。桩里只有一个库（'pvault'），但这里仍遍历而不是写死库名：
// 库名属于 app/schema.js 的知识，桩不该跟着它一起过期。
function findStore(name) {
  for (const meta of databases.values()) {
    const store = meta.stores.get(name);
    if (store) return store;
  }
  return null;
}

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

  transaction(names, mode = 'readonly') {
    // 只把**写**事务计进去：db.get / getAll / getAllByIndex 这些读操作不该进这个计数，
    // 否则「一次批量写 = 1」这个判据会被读操作污染成 2 / 3 / 4（见上面 transactionCount 的注释）。
    if (mode === 'readwrite') txCount += 1;
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
