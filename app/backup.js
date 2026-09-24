export const BACKUP_FORMAT = 'pvault-backup';
export const BACKUP_VERSION = 1;

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

export function summarizeBackup(obj) {
  return {
    createdAt: obj?.createdAt ?? null,
    txns: obj?.data?.txns?.length ?? 0,
    accounts: obj?.data?.accounts?.length ?? 0,
    categories: obj?.data?.categories?.length ?? 0,
    receivables: obj?.data?.receivables?.length ?? 0,
    hasVault: Boolean(obj?.data?.vault)
  };
}
