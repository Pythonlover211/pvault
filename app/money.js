export function formatCents(cents, { symbol = false } = {}) {
  const negative = cents < 0;
  const abs = Math.abs(Math.trunc(cents));
  const yuan = Math.floor(abs / 100);
  const fen = String(abs % 100).padStart(2, '0');
  return `${negative ? '-' : ''}${symbol ? '¥' : ''}${yuan}.${fen}`;
}

export function parseAmountToCents(input) {
  const s = String(input).trim();
  if (s === '' || s === '.') return null;
  if (!/^\d*(\.\d{0,2})?$/.test(s)) return null;
  const [intPart = '', decPart = ''] = s.split('.');
  const yuan = intPart === '' ? 0 : Number(intPart);
  const fen = Number((decPart + '00').slice(0, 2));
  if (!Number.isSafeInteger(yuan)) return null;
  return yuan * 100 + fen;
}

export function addCents(...list) {
  return list.reduce((sum, c) => sum + Math.trunc(c), 0);
}

export function subCents(a, b) {
  return Math.trunc(a) - Math.trunc(b);
}
