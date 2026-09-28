export const BACKUP_FORMAT = 'pvault-backup';
export const BACKUP_VERSION = 1;

// 备份包里**必须**出现的数组。刻意不含 invoices / invoiceFiles：这两项是加发票功能时才有的字段，
// 加发票之前导出的备份文件里根本没有这两个键。把它们写进必填清单，所有既有备份都会在
// validateBackup 处被判「内容不完整」——用户唯一的救命通道会被一条新功能的兼容性检查挡死。
// 与 app/backup-store.js 里 ARRAY_STORES 那次「清单从 4 张变 7 张」的事故是同一个道理：
// 新字段只能当可选扩展，有就恢复，没有就按没有处理（保留本机现状）。
const REQUIRED_ARRAYS = ['txns', 'accounts', 'categories', 'receivables', 'settings'];

// structuredClone 是 Chrome 98+ 才有的 API，而安卓系统 WebView 的版本由设备决定
// ——旧设备上它根本不存在，备份导出会直接抛 "structuredClone is not defined"，
// 用户看到的是「导出失败」而不知道原因（模拟器上的 WebView 就是 Chrome 83，实测踩中）。
// 备份数据全部是纯 JSON（字符串/数字/布尔/数组/对象），序列化往返的深拷贝语义等价，
// 且不依赖任何新 API。
function deepClone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

export function buildBackup(payload, now = Date.now()) {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: now,
    data: {
      txns: deepClone(payload.txns ?? []),
      accounts: deepClone(payload.accounts ?? []),
      categories: deepClone(payload.categories ?? []),
      receivables: deepClone(payload.receivables ?? []),
      settings: deepClone(payload.settings ?? []),
      // 发票条目本身是纯 JSON（号码/金额/时间戳），与上面几张表一样深拷贝。
      invoices: deepClone(payload.invoices ?? []),
      // 报销单与发票条目同源（纯 JSON、与库存数据解耦），一起深拷贝。
      // 它必须**始终**是个数组（哪怕是空的）：导入侧 clears 的判据是 `Array.isArray(data[name])`，
      // 给 undefined 就等于告诉导入「这份备份没带报销单」，本机那些上一份数据的报销单不会被清掉，
      // 恢复出来的库里会混着两份数据。
      // **这句只限定在「新导出的包」上，别读成「任何备份都带这个键」**：加报销单之前导出的老包
      // 根本没有这个键，导入侧遇到缺键时**保留**本机数据而不是清空（判据见 backup-store.js 的
      // clears——它由 `ARRAY_STORES.filter(name => Array.isArray(data[name]))` 派生）。
      // 「有键就清空」与「缺键就保留」处置相反，混起来读会把界面上那一行文案写反。
      reimbursements: deepClone(payload.reimbursements ?? []),
      // 发票图片已经是 base64 字符串（Blob 进不了 JSON，见 backup-store 的 encodeFiles），
      // 所以这里**刻意不深拷贝**：一份带几百张图的备份光 base64 就有几十上百 MB，
      // structuredClone 会把它整份复制一遍，手机上这一下就够触发内存告警。
      // 数组由调用方现造现交（exportBackup 里的 encodeFiles），没有第二个人持有它的引用。
      invoiceFiles: payload.invoiceFiles ?? [],
      // 背景照片（base64）与它的遮罩强度。与 invoiceFiles 同理**刻意不深拷贝**：
      // 它是一个几百 KB 的 base64 串，structuredClone 会白复制一份，而对象由调用方现造现交。
      background: payload.background ?? null,
      vault: payload.vault ? deepClone(payload.vault) : null
    }
  };
}

export function validateBackup(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object') {
    return { ok: false, errors: ['备份文件内容不是有效的对象'] };
  }
  if (obj.format !== BACKUP_FORMAT) {
    errors.push('这不是 pvault 的备份文件');
  }
  if (!Number.isInteger(obj.version)) {
    errors.push('备份文件缺少版本号');
  } else if (obj.version > BACKUP_VERSION) {
    errors.push(`备份文件版本（${obj.version}）高于当前 app 支持的版本（${BACKUP_VERSION}），请先更新 app`);
  }
  for (const key of REQUIRED_ARRAYS) {
    if (!Array.isArray(obj.data?.[key])) errors.push(`备份文件缺少 ${key} 数据或格式不对`);
  }
  return { ok: errors.length === 0, errors };
}

// 只统计真正的数组。备份文件是外部输入，这些键可能是字符串或对象（损坏、被手改过），
// 直接读 .length 会给出一个凭空捏造的张数——'abc'.length 是 3，界面就会告诉用户
// 「这份备份里有 3 张发票」，而恢复时一张也写不进去。
function countOf(value) {
  return Array.isArray(value) ? value.length : 0;
}

export function summarizeBackup(obj) {
  const data = obj?.data ?? {};
  return {
    createdAt: obj?.createdAt ?? null,
    txns: countOf(data.txns),
    accounts: countOf(data.accounts),
    categories: countOf(data.categories),
    receivables: countOf(data.receivables),
    // 发票张数与发票图片张数。恢复前那一屏是用户唯一一次机会判断「选中的这份文件对不对」，
    // 至少要能看出里面有没有发票。
    invoices: countOf(data.invoices),
    reimbursements: countOf(data.reimbursements),
    invoiceFiles: countOf(data.invoiceFiles),
    // 光有张数不够：0 有两种完全不同的含义。文件里**压根没有**这一项（加发票之前导出的老备份）时，
    // 恢复会保留本机现有的发票与图片；文件里**有这一项但是空的**时，恢复会把本机发票清空。
    // 界面据此显示「不包含（保留本机现有发票）」，不能让用户在这两件处置相反的事之间猜。
    hasInvoices: Array.isArray(data.invoices),
    hasInvoiceFiles: Array.isArray(data.invoiceFiles),
    // 与 hasInvoices / hasInvoiceFiles 同一条判据、同一个理由：光看张数，0 有两种完全相反的含义。
    // 文件里**压根没有**这个键（加报销单之前导出的老备份）→ 导入保留本机现有报销单；
    // 文件里**有**这个键但是空的 → 导入把本机报销单清空（两条由 backup-store.js 的 clears 派生，
    // 见那里的注释）。少了这个字段，两种包在摘要层长得一模一样（计数都是 0），
    // 用户在点「确认覆盖并恢复」之前无法知道自己的报销单会不会没——那是他唯一一次知情机会。
    // 位置跟在 hasInvoiceFiles 后面、和上面那两个 has 排在一起：计数一簇、has 一簇，
    // 插在计数中间会把「这一簇都是同一个判据派生的」这个分组读断（纯排列，字段本身没变）。
    hasReimbursements: Array.isArray(data.reimbursements),
    hasVault: Boolean(data.vault),
    // 背景照片。**它的方向与上面那几行相反**：备份不带背景时，导入会把**本机那张删掉**
    // （见 backup-store.js 文件头第 7 条），所以界面那一行不能写成「不包含（保留本机现有的…）」。
    hasBackground: hasBackgroundImage(data.background)
  };
}

// 「这份备份带没带一张可恢复的背景」。
// 为什么不直接复用导入侧的 base64ToBlob：那个函数在 backup-store.js 里，而本模块是**纯模块**、
// 而且被 backup-store import（反向 import 就是循环依赖，理由见本文件顶部那条分层规则）。
// 所以这里取它的两条必要条件：image 是非空字符串、且长度是 4 的倍数（后一条正是 base64ToBlob
// 用来挡住「被截断的串」的判据——atob 对长度不是 4 倍数的串**不抛错**，会安静地解出半截数据）。
// **已知边界**：一段长度合法、字符却非法的 base64（只有手改文件才造得出来）在这里算「包含」、
// 在导入侧算「没有」。那时摘要说「包含」而导入后背景没了——这是这一处的不一致，如实记在这里，
// 别把它读成「两边的判据一定一致」。
function hasBackgroundImage(bg) {
  if (!bg || typeof bg !== 'object') return false;
  const image = bg.image;
  return typeof image === 'string' && image !== '' && image.length % 4 === 0;
}
