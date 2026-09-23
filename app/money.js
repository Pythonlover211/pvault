export function formatCents(cents, { symbol = false } = {}) {
  const negative = cents < 0;
  const abs = Math.abs(Math.trunc(cents));
  const yuan = Math.floor(abs / 100);
  const fen = String(abs % 100).padStart(2, '0');
  return `${negative ? '-' : ''}${symbol ? '¥' : ''}${yuan}.${fen}`;
}

// 「给一眼看的金额」：整数元去掉 .00、千分位加逗号，仍然带 ¥。150000 → '¥1,500'，12345 → '¥123.45'。
// 只用于列表行、提示语这类一眼扫过的位置；需要精确到分的场合（流水、统计数字）继续用 formatCents。
// 千分位用正则按「后面正好 3 位一组」插入，避免 toLocaleString 在不同环境下输出不一致。
export function formatCentsShort(cents) {
  const text = formatCents(cents, { symbol: true });   // '-¥1234.56' / '¥1500.00'
  const negative = text.startsWith('-');
  const body = negative ? text.slice(1) : text;
  const [yuanPart, fenPart] = body.slice(1).split('.');
  const grouped = yuanPart.replace(/\B(?=(\d{3})+$)/g, ',');
  return `${negative ? '-' : ''}¥${grouped}${fenPart === '00' ? '' : '.' + fenPart}`;
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
