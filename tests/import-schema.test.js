import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRESETS, DETECT_SCAN_LIMIT, MIN_PRESET_COLUMN_HITS, detectPreset, detectPresetHeader,
  buildColumnIndex, autoMapping, mapRows, FIELDS,
  UNRESOLVED_DIRECTION_REASON, TRANSFER_UNSUPPORTED_REASON, NO_DIRECTION_REASON
} from '../app/import-schema.js';
import { makeFingerprint } from '../app/import-parse.js';

const wechatHeader = ['交易时间', '交易类型', '交易对方', '商品', '收/支', '金额(元)', '支付方式', '当前状态', '交易单号', '商户单号', '备注'];
const wechatRows = [
  ['微信支付账单明细'],
  ['起始时间：[2026-08-01] 终止时间：[2026-09-01]'],
  [],
  wechatHeader,
  ['2026-08-15 12:30:00', '商户消费', '某某便利店', '矿泉水', '支出', '¥3.00', '零钱', '支付成功', '10001', '20001', '/'],
  ['2026-08-16 09:00:00', '转账', '张三', '', '收入', '¥88.00', '零钱', '已存入零钱', '10002', '20002', '/']
];

const alipayHeader = ['交易时间', '交易分类', '交易对方', '对方账号', '商品说明', '收/支', '金额', '收/付款方式', '交易状态', '交易订单号', '商家订单号', '备注'];
const alipayRows = [
  ['支付宝交易记录明细查询'],
  ['账号：[zhangsan@example.com]'],
  [],
  alipayHeader,
  ['2026-08-20 18:05:00', '餐饮美食', '某某餐厅', 'shop@example.com', '晚餐', '支出', '68.00', '余额宝', '交易成功', '30001', '40001', '无']
];

test('PRESETS 含微信与支付宝两项', () => {
  assert.deepEqual(PRESETS.map(p => p.id).sort(), ['alipay', 'wechat']);
});

test('FIELDS 列出可映射的字段', () => {
  assert.ok(FIELDS.includes('time'));
  assert.ok(FIELDS.includes('amount'));
  assert.ok(FIELDS.includes('direction'));
  assert.ok(FIELDS.includes('merchant'));
  assert.ok(FIELDS.includes('note'));
});

test('detectPreset 认出微信账单（表头不在第一行也能找到）', () => {
  assert.equal(detectPreset(wechatRows)?.id, 'wechat');
});

test('detectPreset 认出支付宝账单', () => {
  assert.equal(detectPreset(alipayRows)?.id, 'alipay');
});

test('detectPreset 认不出时返回 null', () => {
  assert.equal(detectPreset([['日期', '说明', '金额']]), null);
  assert.equal(detectPreset([]), null);
});

test('buildColumnIndex 把表头行变成列名→索引', () => {
  const idx = buildColumnIndex(wechatHeader);
  assert.equal(idx.get('交易时间'), 0);
  assert.equal(idx.get('金额(元)'), 5);
});

test('autoMapping 按预设的列名生成映射', () => {
  const preset = PRESETS.find(p => p.id === 'wechat');
  const idx = buildColumnIndex(wechatHeader);
  const mapping = autoMapping(preset, idx);
  assert.equal(mapping.time, 0);
  assert.equal(mapping.amount, 5);
  assert.equal(mapping.direction, 4);
  assert.equal(mapping.merchant, 2);
});

test('autoMapping 缺列时对应字段为 null 而不是报错', () => {
  const preset = PRESETS.find(p => p.id === 'wechat');
  const idx = buildColumnIndex(['交易时间', '金额(元)']);
  const mapping = autoMapping(preset, idx);
  assert.equal(mapping.time, 0);
  assert.equal(mapping.amount, 1);
  assert.equal(mapping.merchant, null);
});

test('mapRows 把微信账单转成交易记录', () => {
  const preset = PRESETS.find(p => p.id === 'wechat');
  const idx = buildColumnIndex(wechatHeader);
  const mapping = autoMapping(preset, idx);
  const { records, errors } = mapRows(wechatRows, 3, mapping);
  assert.equal(errors.length, 0);
  assert.equal(records.length, 2);
  assert.equal(records[0].kind, 'expense');
  assert.equal(records[0].amountCents, 300);
  assert.equal(records[0].note, '某某便利店 · 矿泉水');
  assert.equal(records[1].kind, 'income');
  assert.equal(records[1].amountCents, 8800);
});

test('mapRows 把支付宝账单转成交易记录', () => {
  const preset = PRESETS.find(p => p.id === 'alipay');
  const idx = buildColumnIndex(alipayHeader);
  const mapping = autoMapping(preset, idx);
  const { records } = mapRows(alipayRows, 3, mapping);
  assert.equal(records.length, 1);
  assert.equal(records[0].kind, 'expense');
  assert.equal(records[0].amountCents, 6800);
  assert.match(records[0].note, /某某餐厅/);
});

test('mapRows 跳过解析不出时间或金额的行，并把原因收进 errors', () => {
  const rows = [
    wechatHeader,
    ['', '', '', '', '支出', '¥3.00'],
    ['2026-08-15 12:30:00', '', '', '', '支出', '不是钱'],
    ['2026-08-15 12:30:00', '', '店', '', '支出', '¥1.00']
  ];
  const idx = buildColumnIndex(wechatHeader);
  const preset = PRESETS.find(p => p.id === 'wechat');
  const { records, errors } = mapRows(rows, 0, autoMapping(preset, idx));
  assert.equal(records.length, 1);
  assert.equal(errors.length, 2);
  assert.ok(errors[0].row >= 1);
  assert.ok(errors[0].reason.includes('时间') || errors[0].reason.includes('金额'));
});

test('mapRows 遇到「不计收支」的行跳过，并计进 skipped（不是错误，也不能无声消失）', () => {
  const rows = [
    wechatHeader,
    ['2026-08-15 12:30:00', '', '店', '', '/', '¥3.00'],
    ['2026-08-16 12:30:00', '', '店', '', '不计收支', '¥5.00'],
    ['2026-08-17 12:30:00', '', '店', '', '支出', '¥6.00']
  ];
  const idx = buildColumnIndex(wechatHeader);
  const preset = PRESETS.find(p => p.id === 'wechat');
  const { records, errors, skipped } = mapRows(rows, 0, autoMapping(preset, idx));
  assert.equal(records.length, 1);
  assert.equal(errors.length, 0);
  // 修复前这两行既不进 records 也不进 errors，摘要里一个字都不提：文件 4 行、
  // 摘要说「将导入 1 条；跳过 0；0 条无法解析」，剩下 2 条去哪了完全没人交代。
  assert.equal(skipped.length, 2);
  assert.equal(skipped[0].reason, NO_DIRECTION_REASON);
  assert.equal(skipped[0].row, 1);
  assert.equal(skipped[0].raw, '/');
  assert.equal(skipped[1].row, 2);
});

test('mapRows 遇到「转账」的行不进 records，原因写清楚要手工补录', () => {
  // 手工映射时很容易把「交易类型」列当成收支方向列，那一列里有「转账」。
  // V1 没有对方账户可选，硬写 toAccountId: null 会造出手工路径产生不了的非法状态。
  const rows = [
    wechatHeader,
    ['2026-08-15 12:30:00', '转账', '张三', '', '转账', '¥500.00'],
    ['2026-08-16 12:30:00', '商户消费', '店', '', '支出', '¥3.00']
  ];
  const idx = buildColumnIndex(wechatHeader);
  const preset = PRESETS.find(p => p.id === 'wechat');
  const { records, errors, skipped } = mapRows(rows, 0, autoMapping(preset, idx));
  assert.equal(records.length, 1);
  assert.equal(records[0].kind, 'expense');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].reason, TRANSFER_UNSUPPORTED_REASON);
  assert.equal(errors[0].raw, '转账');
  assert.equal(skipped.length, 0);
});

test('mapRows 在收支方向列越界时报错，而不是静默丢掉整批数据', () => {
  const idx = buildColumnIndex(wechatHeader);
  const preset = PRESETS.find(p => p.id === 'wechat');
  // 列映射配错：direction 指向一个不存在的列
  const mapping = { ...autoMapping(preset, idx), direction: 99 };
  const { records, errors } = mapRows(wechatRows, 3, mapping);
  assert.equal(records.length, 0);
  assert.equal(errors.length, 2); // 两行数据各记一条，而不是「0 条记录、0 个错误」
  assert.equal(errors[0].reason, '收支方向列不存在');
  assert.equal(errors[0].row, 4);
  assert.equal(errors[1].row, 5);
});

test('mapRows 方向列存在但值为空时跳过，并计进 skipped（与越界区分开）', () => {
  const rows = [
    wechatHeader,
    ['2026-08-15 12:30:00', '', '店', '', '', '¥3.00']
  ];
  const idx = buildColumnIndex(wechatHeader);
  const preset = PRESETS.find(p => p.id === 'wechat');
  const { records, errors, skipped } = mapRows(rows, 0, autoMapping(preset, idx));
  assert.equal(records.length, 0);
  assert.equal(errors.length, 0);
  assert.equal(skipped.length, 1);
});

// ── D1 回归（评审必修）────────────────────────────────────────────────────────
// 修复前：direction 未映射时按金额正负猜方向（正数 → income）。微信/支付宝的金额列
// **永远是正数**（方向由「收/支」列表达），手动映射漏配方向列 → 整批 100% 变收入，
// 本月支出归零、收入虚增、预算恒为 0%，而这条路径没有事后编辑入口可以补救。

test('mapRows：方向列未映射、金额全为正数时，不得静默产出 income', () => {
  // 真实形态：微信账单的「金额(元)」列，正数，方向在别处
  const rows = [
    ['交易时间', '交易对方', '商品', '金额(元)'],
    ['2026-09-01 12:30:00', '肯德基', '午餐', '35.00'],
    ['2026-09-02 12:30:00', '超市', '日用', '12.34']
  ];
  const mapping = { time: 0, amount: 3, direction: null, merchant: 1, note: 2 };
  const { records, errors, skipped } = mapRows(rows, 0, mapping);
  assert.equal(records.length, 0, '未指定 defaultKind 时一条记录都不该产出');
  assert.equal(errors.length, 2);
  assert.equal(errors[0].reason, UNRESOLVED_DIRECTION_REASON);
  assert.equal(skipped.length, 0);
  assert.equal(records.some(r => r.kind === 'income'), false);
});

test('mapRows：带负号的金额也不能替用户猜方向', () => {
  // 符号推断看起来「很合理」，但它只对一个方向成立：正数那一半必然被猜成收入。
  // 与其猜一半，不如让预览页必须问清楚。
  const rows = [['d'], ['2026-08-15 12:30:00', '-12.34'], ['2026-08-15 12:30:00', '12.34']];
  const { records, errors } = mapRows(rows, 0, { time: 0, amount: 1, direction: null, merchant: null, note: null });
  assert.equal(records.length, 0);
  assert.equal(errors.length, 2);
  assert.equal(errors[0].reason, UNRESOLVED_DIRECTION_REASON);
});

test('mapRows：给了 defaultKind 就按它定方向，金额的符号不再参与判断', () => {
  const rows = [
    ['交易时间', '交易对方', '商品', '金额(元)'],
    ['2026-09-01 12:30:00', '肯德基', '午餐', '35.00'],
    ['2026-09-02 12:30:00', '退款', '退货', '8.00']
  ];
  const mapping = { time: 0, amount: 3, direction: null, merchant: 1, note: 2 };
  const asExpense = mapRows(rows, 0, mapping, { defaultKind: 'expense' });
  assert.equal(asExpense.records.length, 2);
  assert.deepEqual(asExpense.records.map(r => r.kind), ['expense', 'expense']);
  assert.equal(asExpense.records[0].amountCents, 3500); // 金额一律存正数，方向由 kind 表达
  const asIncome = mapRows(rows, 0, mapping, { defaultKind: 'income' });
  assert.deepEqual(asIncome.records.map(r => r.kind), ['income', 'income']);
  // 方向参与去重指纹，所以两种回答给出的是两组不同指纹（改选方向必须重跑 mapRows）
  assert.notEqual(asExpense.records[0].fingerprint, asIncome.records[0].fingerprint);
});

test('mapRows：方向列被映射时 defaultKind 不起作用', () => {
  const idx = buildColumnIndex(wechatHeader);
  const preset = PRESETS.find(p => p.id === 'wechat');
  const { records } = mapRows(wechatRows, 3, autoMapping(preset, idx), { defaultKind: 'income' });
  assert.deepEqual(records.map(r => r.kind), ['expense', 'income']);
});

test('detectPreset 只扫前 DETECT_SCAN_LIMIT 行（几十万行的文件不该在认表头这一步卡住）', () => {
  const filler = Array.from({ length: DETECT_SCAN_LIMIT }, (_, i) => [`第 ${i} 行`, '没用', '的内容']);
  // 表头落在第 51 行：超出扫描窗口，就该认不出，而不是把整份文件扫一遍
  const late = [...filler, wechatHeader, ['2026-08-15 12:30:00', '商户消费', '店', '', '支出', '¥3.00']];
  assert.equal(detectPreset(late), null);
  // 在窗口内（第 50 行）仍然认得出来
  const inside = [...filler.slice(0, DETECT_SCAN_LIMIT - 1), wechatHeader];
  assert.equal(detectPreset(inside)?.id, 'wechat');
});

// ── A4 回归（评审必修）────────────────────────────────────────────────────────
// 修复前：命中判据只要求「交易时间」+「金额」两个列名。银行导出 `交易时间,交易摘要,金额,余额`
// 恰好满足，于是被判成 alipay、界面顶着「已识别为：支付宝账单」，而且走预设路径时第 2 步
// 被跳过——用户连自己指认表头的机会都没有。

test('detectPreset 不再把银行式表头认成支付宝（要求 ≥3 个专有列命中）', () => {
  const bankRows = [
    ['交易时间', '交易摘要', '金额', '余额'],
    ['2026-08-01 10:00:00', '消费', '30.00', '1000.00']
  ];
  assert.equal(detectPreset(bankRows), null);
  // 命中数的边界：只有 2 个专有列名对上就不算命中
  assert.equal(MIN_PRESET_COLUMN_HITS, 3);
  const twoHits = [['交易时间', '金额', '余额']];
  assert.equal(detectPreset(twoHits), null);
  // 3 个对上就算命中（真实账单偶尔缺一两列）
  const threeHits = [['交易时间', '收/支', '金额', '余额']];
  assert.equal(detectPreset(threeHits)?.id, 'alipay');
});

test('detectPreset：支付宝表头不会被抢判成微信（金额列名是区分依据）', () => {
  // 两个预设共用「交易时间」「交易对方」「收/支」三列，只有金额列名不同
  // （「金额(元)」vs「金额」）。若判据只看命中数，支付宝会以 5 个命中命中微信的 3 个，
  // 而 PRESETS 里微信在前 → 整批支付宝账单被判成微信支付账单。
  const alipayWithoutNote = [['交易时间', '交易对方', '收/支', '金额', '余额']];
  assert.equal(detectPreset(alipayWithoutNote)?.id, 'alipay');
  assert.equal(detectPreset(alipayRows)?.id, 'alipay');
  assert.equal(detectPreset(wechatRows)?.id, 'wechat');
});

test('detectPresetHeader 把命中行号一起给出来（界面靠它进第 3 步）', () => {
  const hit = detectPresetHeader(wechatRows);
  assert.equal(hit.preset.id, 'wechat');
  assert.equal(hit.headerIndex, 3);
});

// ── A1 回归（评审必修）：去重指纹两侧口径必须相同 ──────────────────────────────
// 修复前：写入侧用「商户」列原文当指纹分量，读库侧用 note 第一个 ' · ' 之前那段反解。
// 三个真实输入下两者不等价 → 同一份账单第二次导入 fresh 不为空、库里金额翻倍。

test('mapRows 的指纹 = 从 note 反解出来的指纹（二次导入才认得出重复）', () => {
  const header = ['交易时间', '交易对方', '商品', '收/支', '金额(元)'];
  const dataRows = [
    ['2026-03-15 12:30:45', '', '矿泉水', '支出', '¥3.00'],          // 交易对方为空、商品有值
    ['2026-03-16 09:00:00', '', '备注', '支出', '¥8.00'],             // 商户不映射、只留备注
    ['2026-03-17 10:00:00', '喜茶 · 深圳店', '奶茶', '支出', '¥18.00'] // 商户名自带 ' · '
  ];
  const mapping = { time: 0, merchant: 1, note: 2, direction: 3, amount: 4 };
  const { records, errors } = mapRows([header, ...dataRows], 0, mapping);
  assert.equal(errors.length, 0);
  assert.equal(records.length, 3);
  assert.deepEqual(records.map(r => r.note), ['矿泉水', '备注', '喜茶 · 深圳店 · 奶茶']);

  for (const r of records) {
    // 库里的那条交易**只有 note**：这是读库侧唯一能拿到的信息，两侧必须算出同一个指纹
    assert.equal(
      r.fingerprint,
      makeFingerprint({ occurredAt: r.occurredAt, amountCents: r.amountCents, kind: r.kind, note: r.note })
    );
  }
  // 三条互不相同：口径统一不会把不同记录挤成同一条
  assert.equal(new Set(records.map(r => r.fingerprint)).size, 3);
});
