// pvault 的 Service Worker：预缓存全部静态资源，离线也能记账。
//
// ⚠️ 每次改代码（哪怕只改一行 CSS）都必须把下面的 CACHE 版本号 +1（pvault-v2、pvault-v3…）。
// 浏览器判断「有没有新版本」靠的是 sw.js 这个文件本身有没有变化：sw.js 不变就永远不会
// 触发 install，新代码也就永远进不了缓存，手机上会一直看到旧版本。
// **例外：改的就是 sw.js 自己（往 ASSETS 加一条、改注释）时不必再 +1**——文件字节已经变了，浏览器照样会
// 发现新版本、装一次、activate 时删掉旧缓存。任务 10 那次加 theme-store.js 与 theme.js 就是这么做的
// （版本号留在 v17：它只存在于还没发布的分支上，不存在装着它的设备）。
// 这条例外**有边界，别当通则用**：不 +1 时 `addAll` 写的是**正在服役的同名缓存**，而 `Cache.addAll`
// 不保证原子回滚——中途失败（配额满、断网）会留下一个只更新了一半的缓存，用户拿到的就是半新半旧的资源；
// +1 时同样的中途失败只会让新缓存作废、旧缓存完好。所以：**已经在设备上服役过的版本，改 ASSETS 就得 +1。**
//
// 策略：安装时把 ASSETS 全部预缓存 → fetch 时缓存优先、网络回退 → 网络挂了回退到 index.html。
//   - 缓存优先适合这个 app：它是纯本地记账工具，没有服务端数据要「取最新」，
//     所有持久化都在 IndexedDB 里，页面资源几乎不会变。
//   - 代价是「改了代码却忘记 +1 版本号」时会一直吃旧缓存，所以版本号纪律是这里的第一条规矩。
//
// 另一个致命点：cache.addAll() 是**原子**的——数组里只要有一条路径 404（拼错、文件改名、
// 路径拼错），整个 addAll 就 reject，install 失败，SW 根本不激活，离线能力直接是 0，
// 而且控制台只看得到一条 addAll 的报错。所以 ASSETS 必须与磁盘上的真实文件逐条对齐
// （这份清单是扫描 styles/、icons/、app/、app/ui/ 生成的，不是凭记忆手写的）。
//
// 与「某条路径写错」相对的是**漏掉一个文件**（清单里少一行），机制完全不同，别写成 404：它不影响
// install（addAll 里没有它，自然没有 404），离线能力看起来也正常，直到真的去请求那个模块——那时
// 缓存未命中 → 走网络（在线就自愈：拿到的响应会被顺手补进缓存，见文件末尾的 fetch 处理器）→ 离线
// 则回退到 index.html。回给模块脚本的是一个 200 的 text/html，浏览器按严格 MIME 检查拒绝执行，
// import 链一断，app 起不来（页面只剩 body 的底色）。**这条路不产生 404**：404 是「在线、且服务器上
// 真的没有这个文件」的结果，它既可能出现在 install 那次 addAll 里，也可能出现在运行时的网络回退里
// ——两条都属于「清单里写了个不存在的东西」那一类，不属于「清单里漏了一条」。下面各版注释里提到
// 漏加时，说的都是漏这一条路。
//
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
// v3 那次一样：离线时这几个 ES module 加载不了（机制见开头那一段），import 链一断，发票 Tab 直接打不开。
// v14：发票支持导入 OFD。新增的 app/file-info.js 进了预缓存清单 —— 它从任务 3 起就是
// 首屏静态依赖（main → invoice-view → invoice-editor/invoice-store → image-store → file-info），
// 而 SW 是 cache-first：白名单里没有它，已装旧缓存的设备离线启动会回退到 index.html、
// import 链一断是整个 app 白屏。所以它必须在消费方 import 之前就位，不能等到收尾再补。
// v15：下载触发从 backup-view 抽到 app/ui/download.js 共用，它要进预缓存清单。
// （file-info.js 在任务 3 就随 v14 进过清单了 —— 它从那时起是首屏静态依赖，
//  必须在消费方 import 它之前就位；晚一步的后果是整个 app 白屏，不只是发票面板。）
// 漏掉 download.js 的后果与上面各次相同：离线时这个 module 加载不了，import 链断。
// v16：canvas-image.js 提前进预缓存清单 —— 任务 5 把图片编解码工具（loadViaImg / decode /
// releaseSource / drawTo）从 image-store.js 搬到了新模块 app/canvas-image.js，image-store
// 从此静态依赖它。白名单不跟着那一次提交一起加的话，已装旧缓存的设备离线启动会断在
// main → invoice-view → invoice-editor → image-store → canvas-image 这一环：那一个模块加载不了、
// import 链一断是整个 app 白屏（不只是发票面板）——与上面 v14 那次同一个坑，所以不等任务 14。
// v17：theme-store.js 与 theme.js 一起进预缓存清单 —— 任务 10 让 app/main.js 静态依赖 theme-store
// （main → theme-store），而 theme-store 又静态依赖 theme（theme-store → theme），两个都在首屏依赖链上，
// 于是两个一起进，不等任务 14 —— 与 v14（file-info.js，同样是间接依赖）同一个形状、同一份理由：
// 白名单不跟产生依赖的那次提交一起走，已装旧缓存的设备离线启动就会断在这一环（机制见开头那一段）。
// 任务 11（外观面板）往清单里加了 appearance.css，**没有**再 +1 版本号：index.html 新挂了它的
// <link>，它从此是首屏静态依赖（漏了它离线白屏，机制见开头那一段），所以不等任务 14；而 v17 只在
// 还没发布的分支上、没有任何设备装着它，按上面那条例外的边界（「已经在设备上服役过的版本，改 ASSETS
// 就得 +1」）还不必升版——`addAll` 写的还不是一份服役中的缓存。
// ui/appearance-sheet.js 是同一个面板的另外半个文件，由任务 12 补上，**同样没有 +1**（边界与它相同：
// v17 仍未发布）。它与 appearance.css 进清单的路径不同：不是被 index.html 直接引用，而是任务 12 让
// settings-sheet.js 静态 import 它（main → 设置面板 → 外观面板），它由此成为首屏静态依赖，所以白名单
// 跟产生依赖的那一次提交一起走，不等任务 14 —— 与上面 v14 / v16 / v17 同一条纪律。
// v18：任务 14 的收尾。这一步**没有新条目**（外观面板的两个文件已经分别在任务 11 / 任务 12 就位，理由
// 就是上面两段），只把交付号定下来 —— 别让下一轮读到这份清单的人对着一行写着 v17 的代码去猜「到底
// 发布了没有」（`main` 上仍是 v15，v16 / v17 只存在于这条还没发布的分支上）。
// **如实说清这一版升号带来的是什么**：按本文件开头那条例外，改的正是 `sw.js` 自己时也可以不升，设备侧
// 起作用的照旧是「字节变了就重装一次」；升号与不升号的**实际差别**只在 `addAll` 写进哪一份缓存 ——
// 写新名字（v18）时中途失败（配额满、断网）只让新缓存作废、旧缓存完好，写同名（v17）则可能留下一份
// 半新半旧的缓存。所以这一步不是「换掉一个出过问题的版本」（v15 的设备本来就会重装），是定版。
// v19：reimburse-model.js 进预缓存清单 —— 任务 6 让 ui/invoice-view.js 静态 import 它
// （main → invoice-view → reimburse-model），它由此成了首屏静态依赖，白名单就跟产生依赖的这一次提交
// 一起走，与 v14 / v16 / v17 同一条纪律——不等任务 14 的收尾。漏加它的后果也和那几次相同：已装旧缓存的
// 设备离线启动时这个 module 拿不到（cache-first 未命中 → 网络断 → 回退 index.html，模块脚本被 MIME
// 检查拒绝），import 链一断是整个 app 白屏，不只是发票面板。
// 版本号这次直接 +1：改的是 invoice-view.js、**不是 sw.js 自己**，开头那条例外不适用，按通则
// 「每次改代码都必须把 CACHE +1」办即可。
// v20：报销单的界面与数据层进预缓存清单 —— 三个文件：ui/reimburse-view.js（任务 8）、
// ui/settle-sheet.js（任务 9）、reimburse-store.js。**这三个与前几次的形状不一样**：
// 它们不在首屏静态 import 闭包里 —— ui/reimburse-view.js 是被 ui/invoice-view.js **动态** import 的，
// 而 boot-order.test.js 的守卫算的是静态 from 的闭包，所以它**不会**提醒你漏了谁（这正是这次差点漏掉的原因）。
// 漏掉的后果与 v13 / v14 / v16 / v19 逐字相同，只是触发条件更窄：已经装着旧缓存的设备在**离线**时
// 切到「报销单」那一段，动态 import 去取那个模块 → 缓存未命中 → 网络断 → 回退 index.html →
// 模块脚本被 MIME 检查拒绝执行 → 整段打不开。在线能用、离线白屏，而用户只在没网的时候才碰上。
// 三个一起补，与产生依赖的那次提交一起走（v14 / v16 / v17 / v19 同一条纪律），不等任务 11 的收尾。
// CACHE 这次**必须** +1：改的是 ui/ 下的文件、不是 sw.js 自己，开头那条例外不适用；
// 而且 v19 是任务 6 加进去的、已经在设备上服役过一轮，往那个名字里 addAll 中途失败会留下
// 一份半新半旧的缓存（见开头那一段）。
// v21：任务 8 的返工。这次改的**不是清单**，而是两个**已经在清单里**的文件的内容——
// ui/reimburse-view.js（列表卡的创建日期 / 实际到账那一行 / 空单文案、详情页标题可点改名）
// 与 styles/invoice.css（`.rd-title` 当按钮用时的那条 reset）。所以 +1 的依据是开头那条**通则**：
// 改的不是 sw.js 自己（那条例外不适用），而浏览器只认 sw.js 这个文件的字节变没变——不 +1 就永远
// 不触发 install，已经装过 v20 的那台设备（任务 8 的真机验收就会装上它）在线也照样一直吃旧缓存，
// 新的列表与可点改名的标题一个都看不到。这一版还不涉及「换掉一个正在服役的缓存名」那层理由。
const CACHE = 'pvault-v21';

// 只列应用真正运行需要的资源。docs/（设计规格）、tests/、scripts/、package.json
// 都不该被缓存，也不该被发布出去。
//
// v3 一并补齐了此前几个任务新增却忘了进清单的文件（crypto / recovery-code / vault-model /
// vault-store / backup / backup-store）：漏掉的后果不是「少一份缓存」，而是离线时这些
// ES module 请求加载不了、import 链断掉，密码箱与备份功能在离线状态下整个打不开。
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './styles/appearance.css',
  './styles/base.css',
  './styles/components.css',
  './styles/invoice.css',
  './styles/ledger.css',
  './styles/vault.css',
  './icons/icon.svg',
  './app/backup-store.js',
  './app/backup.js',
  './app/budget.js',
  './app/canvas-image.js',
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
  './app/reimburse-model.js',
  './app/reimburse-store.js',
  './app/router.js',
  './app/schema.js',
  './app/store.js',
  './app/summary.js',
  './app/theme-store.js',
  './app/theme.js',
  './app/vault-model.js',
  './app/vault-store.js',
  './app/ui/accounts-view.js',
  './app/ui/appearance-sheet.js',
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
  './app/ui/reimburse-view.js',
  './app/ui/settings-sheet.js',
  './app/ui/settle-sheet.js',
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
