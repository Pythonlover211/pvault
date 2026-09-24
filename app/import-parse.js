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

// note 的拼接分隔符，与 import-schema.js 的 mapRows（写入侧）必须是同一个字面量。
export const NOTE_SEPARATOR = ' · ';

// 从 note 反解商户：导入时 note 由 [merchant, note].filter(Boolean).join(' · ') 拼成
// （见 import-schema.js 的 mapRows），而交易表里**没有**单独的 merchant 字段，
// 所以读库比对时只能按同一个分隔符取回第一段。
export function merchantFromNote(note) {
  const s = String(note ?? '');
  const at = s.indexOf(NOTE_SEPARATOR);
  return (at === -1 ? s : s.slice(0, at)).trim();
}

// 指纹 = 时间 + 金额 + 收支方向 + 商户。方向必须参与：真实账单里「转账」双向往来、
// 或「消费 + 即时退款」会在同一秒出现同金额同商户的一收一支，少了 kind 两条会被
// 认成同一笔，去重时静默丢掉其中一条。
//
// 第四个分量**必须**从 note 派生，而不是接收调用方给的「商户原文」：库里的交易只有 note，
// 写入侧若用商户原文、读库侧用 note 反解，两侧口径就不等价——商户列为空而商品列有值
// （note 里没有分隔符）、商户名自带 ' · '（如「喜茶 · 深圳店」）这两种真实数据都会让
// 同一笔账算出两个指纹，同一份账单二次导入会静默翻倍。两边都走 merchantFromNote 才不会分叉。
export function makeFingerprint({ occurredAt, amountCents, kind, note }) {
  return `${occurredAt}|${amountCents}|${String(kind ?? '')}|${merchantFromNote(note)}`;
}
