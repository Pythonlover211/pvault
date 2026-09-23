// pvault 的 Service Worker：预缓存全部静态资源，离线也能记账。
//
// ⚠️ 每次改代码（哪怕只改一行 CSS）都必须把下面的 CACHE 版本号 +1（pvault-v2、pvault-v3…）。
// 浏览器判断「有没有新版本」靠的是 sw.js 这个文件本身有没有变化：sw.js 不变就永远不会
// 触发 install，新代码也就永远进不了缓存，手机上会一直看到旧版本。
//
// 策略：安装时把 ASSETS 全部预缓存 → fetch 时缓存优先、网络回退 → 网络挂了回退到 index.html。
//   - 缓存优先适合这个 app：它是纯本地记账工具，没有服务端数据要「取最新」，
//     所有持久化都在 IndexedDB 里，页面资源几乎不会变。
//   - 代价是「改了代码却忘记 +1 版本号」时会一直吃旧缓存，所以版本号纪律是这里的第一条规矩。
//
// 另一个致命点：cache.addAll() 是**原子**的——数组里只要有一条路径 404（拼错、文件改名、
// 忘了同步），整个 addAll 就 reject，install 失败，SW 根本不激活，离线能力直接是 0，
// 而且控制台只看得到一条 addAll 的报错。所以 ASSETS 必须与磁盘上的真实文件逐条对齐
// （这份清单是扫描 styles/、icons/、app/、app/ui/ 生成的，不是凭记忆手写的）。
const CACHE = 'pvault-v4';

// 只列应用真正运行需要的资源。docs/（设计规格）、tests/、scripts/、package.json
// 都不该被缓存，也不该被发布出去。
//
// v3 一并补齐了此前几个任务新增却忘了进清单的文件（crypto / recovery-code / vault-model /
// vault-store / backup / backup-store）：漏掉的后果不是「少一份缓存」，而是离线时这些
// ES module 请求 404、import 链断掉，密码箱与备份功能在离线状态下整个打不开。
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './styles/base.css',
  './styles/components.css',
  './styles/ledger.css',
  './styles/vault.css',
  './icons/icon.svg',
  './app/backup-store.js',
  './app/backup.js',
  './app/budget.js',
  './app/chart.js',
  './app/crypto.js',
  './app/dates.js',
  './app/db.js',
  './app/keypad-model.js',
  './app/main.js',
  './app/money.js',
  './app/predict.js',
  './app/receivable.js',
  './app/recovery-code.js',
  './app/router.js',
  './app/schema.js',
  './app/store.js',
  './app/summary.js',
  './app/vault-model.js',
  './app/vault-store.js',
  './app/ui/accounts-view.js',
  './app/ui/budget-view.js',
  './app/ui/categories-view.js',
  './app/ui/clipboard.js',
  './app/ui/dom.js',
  './app/ui/entry-panel.js',
  './app/ui/keypad.js',
  './app/ui/ledger-home.js',
  './app/ui/receivable-view.js',
  './app/ui/settings-sheet.js',
  './app/ui/sheet.js',
  './app/ui/stats-view.js',
  './app/ui/vault-editor.js',
  './app/ui/vault-view.js'
];

self.addEventListener('install', e => {
  // skipWaiting：新版 SW 装好就立刻激活，不等所有标签页关闭
  // （手机上「退到后台」不算关闭，等下去可以等到用户卸载）。
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    // 删掉所有旧版本缓存：否则每改一次版本号就多留一份完整的资源副本，
    // 占着配额还不释放（IndexedDB 与 Cache Storage 共享同一份来源配额）。
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      // clients.claim：让当前已打开的页面立刻受新 SW 控制，不必刷新两次才生效。
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // 只接管 GET：POST/PUT 之类交给网络（本 app 目前没有写请求，但这是通用兜底）。
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      // 顺手把网络拿到的资源补进缓存（预缓存清单之外的东西，例如以后新增的图标）。
      // 必须 clone()：res 的 body 只能被读一次，直接 put 会让下面 return 给页面的那份变空。
      const copy = res.clone();
      // 不 await：缓存写入失败（配额满、opaque 响应）绝不能拖慢或阻断这次请求。
      // 也不能写成 then(c => c.put(...)) 而不 catch——那样会在控制台冒未处理的拒绝。
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      return res;
    })
    // 网络也挂了（离线、断网）：回退到首页这份预缓存副本，至少让页面能起来。
    // 非导航请求走到这里会拿到 HTML 文本（解析必然失败），但清单里的资源都已预缓存，
    // 只有清单外的新资源才会落到这一步，属于可接受的取舍。
    .catch(() => caches.match('./index.html')))
  );
});
