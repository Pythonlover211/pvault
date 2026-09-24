export function parseImportAmount(input) {
  let s = String(input ?? '').trim();
  if (!s) return null;
  s = s.replace(/[¥￥\s,，]/g, '');
  s = s.replace(/元$/, '');
  s = s.replace(/^－/, '-').replace(/^＋/, '+');
  if (!/^[+-]?\d+(\.\d{1,2})?$/.test(s)) return null;
  const negative = s.startsWith('-');
  const digits = s.replace(/^[+-]/, '');
  const [intPart, decPart = ''] = digits.split('.');
  const yuan = Number(intPart);
  if (!Number.isSafeInteger(yuan)) return null;
  const cents = yuan * 100 + Number((decPart + '00').slice(0, 2));
  return negative ? -cents : cents;
}

export function parseImportDateTime(input) {
  const s = String(input ?? '').trim();
  const m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return null;
  const [, y, mo, d, h = '0', mi = '0', sec = '0'] = m;
  const year = Number(y), month = Number(mo), day = Number(d);
  const hour = Number(h), minute = Number(mi), second = Number(sec);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const date = new Date(year, month - 1, day, hour, minute, second);
  // 回读校验：2026-02-31 这类会被 Date 自动进位，必须当成非法
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date.getTime();
}

export function parseDirection(input) {
  const s = String(input ?? '').trim();
  if (s.includes('支出') || s === '支') return 'expense';
  if (s.includes('收入') || s === '收') return 'income';
  if (s.includes('转账')) return 'transfer';
  return null;
}

export function makeFingerprint({ occurredAt, amountCents, merchant }) {
  return `${occurredAt}|${amountCents}|${String(merchant ?? '').trim()}`;
}
