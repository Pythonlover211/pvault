import { parseImportAmount, parseImportDateTime, parseDirection, makeFingerprint } from './import-parse.js';

export const FIELDS = ['time', 'amount', 'direction', 'merchant', 'note'];

// 认表头只扫前 50 行：表头不可能在更后面，而账单文件动辄几十万行，全表扫一遍纯属白花
// （实测 30 万行 ≈ 540ms，全在「选完文件」那一瞬间卡住界面）。
export const DETECT_SCAN_LIMIT = 50;

// 以下三个原因文案导出给界面用：预览页要按它们把「文件读不懂」与「这一步还没做完的选择」
// 分开，否则用户会在没选方向时看到满屏红字，以为文件坏了。
//
// 方向列没有映射、调用方又没说这批金额算什么：这不是文件的问题，是必须由人回答的问题。
export const UNRESOLVED_DIRECTION_REASON = '未指定收支方向';
// 转账在 V1 导不进来：交易表的 toAccountId 要指向对方账户，导入向导没有这个信息。
// 硬写 null 会让库里出现手工路径根本产生不了的非法状态——首页按 categoryId 显示成默认分类、
// 统计页又归到内置「转账」伪分类，同一笔两处矛盾，且事后没有编辑入口能补上 toAccountId。
// V2 待补：把转账行导成待补录的转账交易。
export const TRANSFER_UNSUPPORTED_REASON = '转账记录需要指定对方账户，本版本请手工补录';
// 「不计收支」行（零钱提现、信用卡还款、理财申购）在微信/支付宝账单里正常存在。
// 不是错误，但必须**计数**：不计数的话，200 行的文件摘要只交代 150 条，剩下 50 条无声消失。
export const NO_DIRECTION_REASON = '不计收支';

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
  for (const row of (rows ?? []).slice(0, DETECT_SCAN_LIMIT)) {
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

// mapping 形如 { time, amount, direction, merchant, note }（列索引或 null）。
// options.defaultKind 只在 mapping.direction 为 null 时有意义：它回答「这批金额全部算作
// 支出还是收入」。**不预选、也不猜**——微信/支付宝的金额列永远是正数，靠「正数→收入」
// 猜会把整批账单 100% 变成收入（本月支出归零、收入虚增、预算恒为 0%），而这条路径没有
// 事后编辑入口可以补救。没给 defaultKind 就没有记录，每一行都记成 UNRESOLVED_DIRECTION_REASON。
export function mapRows(rows, headerIndex, mapping, { defaultKind = null } = {}) {
  const records = [];
  const errors = [];
  // 不计收支的行（不是错误，但要计数，见 NO_DIRECTION_REASON）
  const skipped = [];
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
      if (defaultKind !== 'expense' && defaultKind !== 'income') {
        errors.push({ row: i, reason: UNRESOLVED_DIRECTION_REASON, raw: '' });
        continue;
      }
      kind = defaultKind;
    } else if (mapping.direction >= row.length) {
      // 列索引越界：多半是列映射配错了。这种情况必须报错而不是静默跳过——
      // 否则整批数据被丢光，用户看到的是「0 条记录、0 个错误」，完全无从排查。
      errors.push({ row: i, reason: '收支方向列不存在', raw: '' });
      continue;
    } else {
      kind = parseDirection(cell('direction'));
      if (kind === 'transfer') {
        errors.push({ row: i, reason: TRANSFER_UNSUPPORTED_REASON, raw: cell('direction') });
        continue;
      }
      if (kind === null) {
        skipped.push({ row: i, reason: NO_DIRECTION_REASON, raw: cell('direction') });
        continue;
      }
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
  return { records, errors, skipped };
}
