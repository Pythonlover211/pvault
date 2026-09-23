export const BACKUP_FORMAT = 'pvault-backup';
export const BACKUP_VERSION = 1;

const REQUIRED_ARRAYS = ['txns', 'accounts', 'categories', 'receivables', 'settings'];

export function buildBackup(payload, now = Date.now()) {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: now,
    data: {
      txns: structuredClone(payload.txns ?? []),
      accounts: structuredClone(payload.accounts ?? []),
      categories: structuredClone(payload.categories ?? []),
      receivables: structuredClone(payload.receivables ?? []),
      settings: structuredClone(payload.settings ?? []),
      vault: payload.vault ? structuredClone(payload.vault) : null
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
