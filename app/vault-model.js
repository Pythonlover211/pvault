export const ITEM_TYPES = {
  login: { label: '网站与 App', icon: '🌐', fields: ['username', 'password', 'url', 'note'] },
  card: { label: '银行卡与证件', icon: '💳', fields: ['number', 'holder', 'expiry', 'cvv', 'bank', 'note'] },
  note: { label: '零散备注', icon: '📝', fields: ['body'] }
};

export const FIELD_LABELS = {
  username: '用户名', password: '密码', url: '网址', note: '备注',
  number: '卡号', holder: '持卡人', expiry: '有效期', cvv: '安全码', bank: '发卡行',
  body: '内容'
};

export const SECRET_FIELDS = new Set(['password', 'cvv']);

export function emptyItem(type) {
  const def = ITEM_TYPES[type];
  const fields = {};
  for (const f of def ? def.fields : []) fields[f] = '';
  return { id: null, type, title: '', fields, createdAt: null, updatedAt: null };
}

export function validateItem(item) {
  const errors = [];
  const def = ITEM_TYPES[item?.type];
  if (!def) return { ok: false, errors: ['未知的条目类型'] };
  if (!String(item.title ?? '').trim()) errors.push('标题不能为空');
  const f = item.fields ?? {};
  const has = k => String(f[k] ?? '').trim().length > 0;
  if (item.type === 'login' && !has('username') && !has('password')) {
    errors.push('用户名与密码至少要填一个');
  }
  if (item.type === 'card' && !has('number')) errors.push('卡号不能为空');
  if (item.type === 'note' && !has('body')) errors.push('内容不能为空');
  return { ok: errors.length === 0, errors };
}

function haystack(item) {
  const parts = [item.title];
  for (const v of Object.values(item.fields ?? {})) parts.push(String(v ?? ''));
  return parts.join('\n').toLowerCase();
}

export function searchItems(items, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return items.slice();
  return items.filter(item => haystack(item).includes(q));
}

export function groupItems(items) {
  const out = { login: [], card: [], note: [] };
  for (const item of items) {
    if (out[item.type]) out[item.type].push(item);
  }
  for (const key of Object.keys(out)) {
    out[key].sort((a, b) => String(a.title).localeCompare(String(b.title), 'zh-Hans-CN'));
  }
  return out;
}

export function maskSecret(value) {
  const s = String(value ?? '').replace(/\s/g, '');
  if (!s) return '';
  if (s.length <= 8) return '•'.repeat(s.length);
  const head = s.slice(0, 4);
  const tail = s.slice(-4);
  const middle = '•'.repeat(s.length - 8).replace(/(.{4})/g, '$1 ').trim();
  return `${head} ${middle} ${tail}`.replace(/\s+/g, ' ').trim();
}

export function itemSummary(item) {
  if (item.type === 'login') return item.fields.username || item.fields.url || '';
  if (item.type === 'card') return maskSecret(item.fields.number);
  return String(item.fields.body ?? '').split('\n')[0].slice(0, 40);
}
