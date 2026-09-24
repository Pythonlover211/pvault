import { parseImportAmount, parseImportDateTime, parseDirection, makeFingerprint } from './import-parse.js';

export const FIELDS = ['time', 'amount', 'direction', 'merchant', 'note'];

export const PRESETS = [
  {
    id: 'wechat',
    label: '微信支付账单',
    columns: { time: '交易时间', amount: '金额(元)', direction: '收/支', merchant: '交易对方', note: '商品' }
  },
  {
    id: 'alipay',
    label: '支付宝账单',
    columns: { time: '交易时间', amount: '金额', direction: '收/支', merchant: '交易对方', note: '商品说明' }
  }
];

export function buildColumnIndex(headerRow) {
  const map = new Map();
  (headerRow ?? []).forEach((name, i) => {
    const key = String(name ?? '').trim();
    if (key && !map.has(key)) map.set(key, i);
  });
  return map;
}

function headerMatches(row, preset) {
  const idx = buildColumnIndex(row);
  const { time, amount } = preset.columns;
  return idx.has(time) && idx.has(amount);
}

export function detectPreset(rows) {
  for (const row of rows ?? []) {
    for (const preset of PRESETS) {
      if (headerMatches(row, preset)) return preset;
    }
  }
  return null;
}

export function autoMapping(preset, columnIndex) {
  const out = {};
  for (const field of FIELDS) {
    const name = preset?.columns?.[field];
    out[field] = name != null && columnIndex.has(name) ? columnIndex.get(name) : null;
  }
  return out;
}

export function mapRows(rows, headerIndex, mapping) {
  const records = [];
  const errors = [];
  for (let i = headerIndex + 1; i < (rows ?? []).length; i++) {
    const row = rows[i];
    if (!row || row.every(c => String(c ?? '').trim() === '')) continue;
    const cell = field => (mapping[field] == null ? '' : String(row[mapping[field]] ?? '').trim());

    const occurredAt = parseImportDateTime(cell('time'));
    if (occurredAt === null) {
      errors.push({ row: i, reason: '时间无法识别', raw: cell('time') });
      continue;
    }
    const rawAmount = parseImportAmount(cell('amount'));
    if (rawAmount === null) {
      errors.push({ row: i, reason: '金额无法识别', raw: cell('amount') });
      continue;
    }

    let kind;
    if (mapping.direction == null) {
      kind = rawAmount < 0 ? 'expense' : 'income';
    } else if (mapping.direction >= row.length) {
      // 列索引越界：多半是列映射配错了。这种情况必须报错而不是静默跳过——
      // 否则整批数据被丢光，用户看到的是「0 条记录、0 个错误」，完全无从排查。
      errors.push({ row: i, reason: '收支方向列不存在', raw: '' });
      continue;
    } else {
      kind = parseDirection(cell('direction'));
      if (kind === null) continue; // 「不计收支」这类行：不是错误，直接跳过
    }

    const merchant = cell('merchant');
    const noteParts = [merchant, cell('note')].filter(Boolean);
    const amountCents = Math.abs(rawAmount);
    records.push({
      occurredAt,
      amountCents,
      kind,
      note: noteParts.join(' · '),
      fingerprint: makeFingerprint({ occurredAt, amountCents, kind, merchant })
    });
  }
  return { records, errors };
}
