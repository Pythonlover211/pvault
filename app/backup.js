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
      // 发票图片已经是 base64 字符串（Blob 进不了 JSON，见 backup-store 的 encodeFiles），
      // 所以这里**刻意不深拷贝**：一份带几百张图的备份光 base64 就有几十上百 MB，
      // structuredClone 会把它整份复制一遍，手机上这一下就够触发内存告警。
      // 数组由调用方现造现交（exportBackup 里的 encodeFiles），没有第二个人持有它的引用。
      invoiceFiles: payload.invoiceFiles ?? [],
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
    invoiceFiles: countOf(data.invoiceFiles),
    // 光有张数不够：0 有两种完全不同的含义。文件里**压根没有**这一项（加发票之前导出的老备份）时，
    // 恢复会保留本机现有的发票与图片；文件里**有这一项但是空的**时，恢复会把本机发票清空。
    // 界面据此显示「不包含（保留本机现有发票）」，不能让用户在这两件处置相反的事之间猜。
    hasInvoices: Array.isArray(data.invoices),
    hasInvoiceFiles: Array.isArray(data.invoiceFiles),
    hasVault: Boolean(data.vault)
  };
}
