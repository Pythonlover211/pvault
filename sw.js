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
// v7：密码箱列表页多了「重新生成恢复码」入口（vault-store / vault-view / vault.css），
// 备份面板里「忘了密码就打不开」那句从说明段上移到密码输入框下方（backup-view）。
// v8：账单导入（csv / import-parse / import-schema / import-store / ui/import-view）
// 进了预缓存清单，设置面板多了第五行入口。
// v9：账单导入评审后的 9 处修复——方向列未映射时必须由人选（不再按金额正负猜）、
// 未闭合引号与 UTF-16 文件给出明确指引、20MB 上限、两个默认分类（支出/收入）、
// 不计收支与转账行的计数与提示、db.removeAll 事务中止。
// v10：第二轮评审（规格一致性）的修复——去重指纹两侧口径统一（写入与读库都从 note 反解商户，
// 修掉「同一份账单二次导入静默翻倍」）、预设命中判据加强（银行式表头不再被判成支付宝）、
// 第 3 步加「不对，我自己选表头」逃生口、套用格式配置时校验列序号越界、预览页「仍然导入」出口、
// 去重口径无条件渲染、撤销浮层累积批次、格式配置可删除、预览表金额带方向符号。
// v11：安卓真机验证抓到的两个问题——① backup.js 不再依赖 structuredClone（旧版安卓
// WebView 是 Chrome 83，没有这个 API，会导致「导出备份」整条不可用）② 安卓壳里跳过
// Service Worker 注册（壳内资源本就在 APK 内，且注册必然失败、只会在控制台刷错误）。
// v12：剪贴板写入加三层兜底 —— 安卓 WebView 里 navigator.clipboard.writeText 会直接
// reject（没有浏览器那套权限模型），真机上表现为恢复码「复制失败」；现在优先走壳的
// Java 桥调系统 ClipboardManager，其次 navigator.clipboard，最后退回 execCommand。
// v13：发票功能的 7 个新文件（invoice-model / image-scale / image-store / invoice-store /
// ui/invoice-view / ui/invoice-editor / invoice.css）进了预缓存清单。漏掉它们的后果和上面
// v3 那次一样：离线时这几个 ES module 404，import 链一断，发票 Tab 直接打不开。
// v14：发票支持导入 OFD。新增的 app/file-info.js 进了预缓存清单 —— 它从任务 3 起就是
// 首屏静态依赖（main → invoice-view → invoice-editor/invoice-store → image-store → file-info），
// 而 SW 是 cache-first：白名单里没有它，已装旧缓存的设备离线启动会回退到 index.html、
// import 链一断是整个 app 白屏。所以它必须在消费方 import 之前就位，不能等到收尾再补。
// v15：下载触发从 backup-view 抽到 app/ui/download.js 共用，它要进预缓存清单。
// （file-info.js 在任务 3 就随 v14 进过清单了 —— 它从那时起是首屏静态依赖，
//  必须在消费方 import 它之前就位；晚一步的后果是整个 app 白屏，不只是发票面板。）
// 漏掉 download.js 的后果与上面各次相同：离线时这个 module 404，import 链断。
const CACHE = 'pvault-v15';

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
  './styles/invoice.css',
  './styles/ledger.css',
  './styles/vault.css',
  './icons/icon.svg',
  './app/backup-store.js',
  './app/backup.js',
  './app/budget.js',
  './app/chart.js',
  './app/crypto.js',
  './app/csv.js',
  './app/dates.js',
  './app/db.js',
  './app/file-info.js',
  './app/image-scale.js',
  './app/image-store.js',
  './app/import-parse.js',
  './app/import-schema.js',
  './app/import-store.js',
  './app/invoice-model.js',
  './app/invoice-store.js',
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
  './app/ui/backup-view.js',
  './app/ui/budget-view.js',
  './app/ui/categories-view.js',
  './app/ui/clipboard.js',
  './app/ui/dom.js',
  './app/ui/download.js',
  './app/ui/entry-panel.js',
  './app/ui/import-view.js',
  './app/ui/invoice-editor.js',
  './app/ui/invoice-view.js',
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
