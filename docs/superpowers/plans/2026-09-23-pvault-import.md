# pvault 账单导入 实现计划（计划 3）

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 把微信 / 支付宝导出的账单，以及任意来源的 CSV，批量导入成 pvault 的账目记录——带**预设解析器**、**手动列映射**、**去重**与**导入前预览**。

**架构：** 仍然是零依赖、无构建。CSV 解析、字段解析、预设与映射全部写成**纯函数**（可在 Node 里 TDD）；编码识别用浏览器与 Node 都有的 `TextDecoder`；导入写入走一个仓库层，复用 `db.putAll` 的单事务批量写入。

**技术栈：** 原生 ES Modules / `TextDecoder` / IndexedDB / Node 24 `node:test`

**用户需求原话**（2026-09-23 确认的落地方式）：

> 「账单导入，不限格式」→ 选定的方案是 **「A 预设解析器 + 手动列映射」**：内置微信/支付宝官方导出格式，碰到没见过的文件就在导入向导里手动指定哪列是金额/时间/商户/收付方向，配置存下来，下次同格式一键导入。

---

## 范围（与设计规格 9 节一致）

- **V1 只支持 CSV**。`.xlsx` 需要解压 + 解析 XML，与「零依赖」冲突——导入界面上要**明确写出**「请先在 Excel / WPS 里另存为 CSV」，不让用户自己猜。
- 不做「粘贴文本智能识别」（用户选方案时明确排除了 C 方案）。
- 不做银行 PDF 账单。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `app/csv.js` | **纯**：CSV 解析（引号、换行、转义、BOM、CRLF）、字节 →文本的编码识别（UTF-8 优先，失败回退 GBK） |
| `app/import-parse.js` | **纯**：金额解析（`¥`、千分位、正负号）、日期时间解析、收/支方向解析、去重指纹 |
| `app/import-schema.js` | **纯**：微信/支付宝预设定义、表头行识别、列映射与行 → 交易记录的转换 |
| `app/import-store.js` | 仓库层：把一批记录写成交易（单事务）+ 与现有账目去重 + 导入配置的读写 |
| `app/ui/import-view.js` | 导入向导界面（选文件 → 预览 → 指定列 → 确认导入） |
| `app/ui/settings-sheet.js` | 加第五行「账单导入」 |
| `tests/*.test.js` | 三个纯模块的单测 |

**分层规则**：`csv.js` / `import-parse.js` / `import-schema.js` 是纯模块，**只能 import 彼此**，绝不能 import `db.js` / `store.js` / `ui/`。

---

## 全局约定

- 金额一律整数分；时间戳一律毫秒。
- 导入的记录 `source: 'import'`（区别于手工录入的 `'manual'`），便于以后筛选/回滚。
- **导入必须能一键撤销**：向导完成后给一个 5 分钟的撤销浮层，调用一次批量删除（按本次导入生成的 id 列表）。

---

## 任务 1：CSV 解析与编码识别 `app/csv.js`

**文件**：创建 `app/csv.js`、`tests/csv.test.js`

- [ ] **步骤 1：编写失败的测试**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, decodeBytes, stripBom } from '../app/csv.js';

test('parseCsv 解析基本表格', () => {
  const rows = parseCsv('a,b,c\n1,2,3\n');
  assert.deepEqual(rows, [['a', 'b', 'c'], ['1', '2', '3']]);
});

test('parseCsv 处理 CRLF', () => {
  assert.deepEqual(parseCsv('a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']]);
});

test('parseCsv 处理引号包裹的字段（含逗号）', () => {
  assert.deepEqual(parseCsv('"a,1",b'), [['a,1', 'b']]);
});

test('parseCsv 处理引号内的换行', () => {
  assert.deepEqual(parseCsv('"第一行\n第二行",b'), [['第一行\n第二行', 'b']]);
});

test('parseCsv 处理双引号转义', () => {
  assert.deepEqual(parseCsv('"他说""你好""",b'), [['他说"你好"', 'b']]);
});

test('parseCsv 保留空字段与尾随空列', () => {
  assert.deepEqual(parseCsv('a,,c'), [['a', '', 'c']]);
  assert.deepEqual(parseCsv('a,b,'), [['a', 'b', '']]);
});

test('parseCsv 跳过完全空白的行', () => {
  assert.deepEqual(parseCsv('a,b\n\n1,2\n'), [['a', 'b'], ['1', '2']]);
});

test('parseCsv 去掉开头的 BOM', () => {
  assert.deepEqual(parseCsv('\uFEFFa,b'), [['a', 'b']]);
});

test('stripBom 只去开头那一个', () => {
  assert.equal(stripBom('\uFEFFa\uFEFFb'), 'a\uFEFFb');
});

test('decodeBytes：UTF-8 字节正常解出中文', () => {
  const bytes = new TextEncoder().encode('交易时间,金额\n2026-09-23,12.34\n');
  assert.match(decodeBytes(bytes), /交易时间/);
});

test('decodeBytes：GBK 字节回退解出中文', () => {
  // "中文" 的 GBK 编码是 D6 D0 CE C4（GB2312 兼容区）
  const bytes = new Uint8Array([0xD6, 0xD0, 0xCE, 0xC4]);
  assert.equal(decodeBytes(bytes), '中文');
});

test('decodeBytes：UTF-8 BOM 也认', () => {
  const bytes = new Uint8Array([0xEF, 0xBB, 0xBF, 0x61]);
  assert.equal(decodeBytes(bytes), 'a');
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test --test-isolation=none tests/csv.test.js` → `Cannot find module '../app/csv.js'`

- [ ] **步骤 3：实现 `app/csv.js`**

```js
export function stripBom(text) {
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

export function parseCsv(text, { delimiter = ',' } = {}) {
  const src = stripBom(String(text ?? ''));
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => {
    pushField();
    // 完全空白的行直接丢弃（导出文件里常见）
    if (!(row.length === 1 && row[0].trim() === '')) rows.push(row);
    row = [];
  };

  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      field += ch; i += 1; continue;
    }
    if (ch === '"') { inQuotes = true; i += 1; continue; }
    if (ch === delimiter) { pushField(); i += 1; continue; }
    if (ch === '\r') { if (src[i + 1] === '\n') i += 1; pushRow(); i += 1; continue; }
    if (ch === '\n') { pushRow(); i += 1; continue; }
    field += ch; i += 1;
  }
  if (field !== '' || row.length > 0) pushRow();
  return rows;
}

export function decodeBytes(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    return new TextDecoder('utf-8').decode(buf.subarray(3));
  }
  try {
    // fatal 让非法字节直接抛错，而不是塞进 U+FFFD——这是我们判断「不是 UTF-8」的依据
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder('gbk').decode(buf);
    } catch {
      // 极少数环境没有 gbk 解码器：退回宽松 UTF-8，至少不让导入完全打不开
      return new TextDecoder('utf-8').decode(buf);
    }
  }
}
```

> **验证环境是否支持 GBK**：Node 24 用完整 ICU，`new TextDecoder('gbk')` 应当可用。**实现前先跑一句确认**：
> `node -e "console.log(new TextDecoder('gbk').decode(new Uint8Array([0xD6,0xD0,0xCE,0xC4])))"`
> 输出 `中文` 就说明可用；若不可用，**停下来报告**（这会让微信/支付宝账单的导入在 Node 测不了，但浏览器里仍可用——需要重新商量测试策略）。

- [ ] **步骤 4：运行测试验证通过** → 12 个用例全过

- [ ] **步骤 5：Commit**

```bash
git add app/csv.js tests/csv.test.js
git commit -m "feat: CSV 解析与编码识别（UTF-8 优先、GBK 回退）"
```

---

## 任务 2：字段解析 `app/import-parse.js`

**文件**：创建 `app/import-parse.js`、`tests/import-parse.test.js`

- [ ] **步骤 1：编写失败的测试**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseImportAmount, parseImportDateTime, parseDirection, makeFingerprint
} from '../app/import-parse.js';

test('parseImportAmount 处理带货币符号与千分位', () => {
  assert.equal(parseImportAmount('¥12.34'), 1234);
  assert.equal(parseImportAmount('12.34'), 1234);
  assert.equal(parseImportAmount('1,234.56'), 123456);
  assert.equal(parseImportAmount('¥1,234.56'), 123456);
  assert.equal(parseImportAmount(' 12.34 '), 1234);
  assert.equal(parseImportAmount('12'), 1200);
  assert.equal(parseImportAmount('0.05'), 5);
});

test('parseImportAmount 处理正负号', () => {
  assert.equal(parseImportAmount('-12.34'), -1234);
  assert.equal(parseImportAmount('+12.34'), 1234);
  assert.equal(parseImportAmount('－12.34'), -1234); // 全角负号
});

test('parseImportAmount 拒绝无法识别的输入', () => {
  assert.equal(parseImportAmount(''), null);
  assert.equal(parseImportAmount('abc'), null);
  assert.equal(parseImportAmount('12.34元'), 1234); // 单位后缀可容忍
  assert.equal(parseImportAmount('--5'), null);
  assert.equal(parseImportAmount(null), null);
});

test('parseImportDateTime 处理常见格式', () => {
  const t1 = parseImportDateTime('2026-09-23 12:34:56');
  assert.equal(new Date(t1).getFullYear(), 2026);
  assert.equal(new Date(t1).getMonth(), 8);
  assert.equal(new Date(t1).getDate(), 23);
  assert.equal(new Date(t1).getHours(), 12);
  assert.equal(new Date(t1).getMinutes(), 34);
});

test('parseImportDateTime 兼容 / 分隔、缺秒、只有日期', () => {
  assert.equal(new Date(parseImportDateTime('2026/09/23 12:34')).getHours(), 12);
  assert.equal(new Date(parseImportDateTime('2026-9-3')).getDate(), 3);
  assert.equal(new Date(parseImportDateTime('2026-9-3')).getMonth(), 8);
});

test('parseImportDateTime 拒绝非法输入', () => {
  assert.equal(parseImportDateTime(''), null);
  assert.equal(parseImportDateTime('昨天'), null);
  assert.equal(parseImportDateTime('2026-13-45'), null);
});

test('parseDirection 认微信/支付宝的写法', () => {
  assert.equal(parseDirection('支出'), 'expense');
  assert.equal(parseDirection('收入'), 'income');
  assert.equal(parseDirection('不计收支'), null);
  assert.equal(parseDirection('/'), null);
  assert.equal(parseDirection(''), null);
  assert.equal(parseDirection('转账'), 'transfer');
});

test('makeFingerprint 同一笔数据的指纹稳定，不同数据不同', () => {
  const a = makeFingerprint({ occurredAt: 1000, amountCents: 1234, merchant: '便利店' });
  const b = makeFingerprint({ occurredAt: 1000, amountCents: 1234, merchant: '便利店' });
  const c = makeFingerprint({ occurredAt: 1000, amountCents: 1234, merchant: '别的店' });
  const d = makeFingerprint({ occurredAt: 2000, amountCents: 1234, merchant: '便利店' });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.notEqual(a, d);
});

test('makeFingerprint 把收支方向纳入指纹', () => {
  // 同一秒、同金额、同商户的一收一支（转账双向往来、消费 + 即时退款）必须是两条
  const expense = makeFingerprint({ occurredAt: 1000, amountCents: 1234, merchant: '便利店', kind: 'expense' });
  const income = makeFingerprint({ occurredAt: 1000, amountCents: 1234, merchant: '便利店', kind: 'income' });
  const transfer = makeFingerprint({ occurredAt: 1000, amountCents: 1234, merchant: '便利店', kind: 'transfer' });
  assert.notEqual(expense, income);
  assert.notEqual(expense, transfer);
  assert.notEqual(income, transfer);
  // 同一方向的同一笔仍必须稳定
  assert.equal(
    expense,
    makeFingerprint({ occurredAt: 1000, amountCents: 1234, merchant: '便利店', kind: 'expense' })
  );
});
```

- [ ] **步骤 2：运行测试验证失败**

- [ ] **步骤 3：实现 `app/import-parse.js`**

```js
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

// 指纹 = 时间 + 金额 + 收支方向 + 商户。方向必须参与：真实账单里「转账」双向往来、
// 或「消费 + 即时退款」会在同一秒出现同金额同商户的一收一支，少了 kind 两条会被
// 认成同一笔，去重时静默丢掉其中一条。
export function makeFingerprint({ occurredAt, amountCents, merchant, kind }) {
  return `${occurredAt}|${amountCents}|${String(kind ?? '')}|${String(merchant ?? '').trim()}`;
}
```

- [ ] **步骤 4：运行测试验证通过** → 8 个用例全过

- [ ] **步骤 5：Commit**

```bash
git add app/import-parse.js tests/import-parse.test.js
git commit -m "feat: 导入字段解析（金额、日期时间、收支方向、去重指纹）"
```

---

## 任务 3：预设与列映射 `app/import-schema.js`

**文件**：创建 `app/import-schema.js`、`tests/import-schema.test.js`

- [ ] **步骤 1：编写失败的测试**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRESETS, detectPreset, buildColumnIndex, autoMapping, mapRows, FIELDS
} from '../app/import-schema.js';

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
  assert.equal(records[0].note, '某某便利店 · 矿泉水');   // merchant 与商品拼进 note，顺序是「商户 · 商品」
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
    ['', '', '', '', '支出', '¥3.00'],       // 缺时间
    ['2026-08-15 12:30:00', '', '', '', '支出', '不是钱'],  // 金额非法
    ['2026-08-15 12:30:00', '', '店', '', '支出', '¥1.00']  // 正常
  ];
  const idx = buildColumnIndex(wechatHeader);
  const preset = PRESETS.find(p => p.id === 'wechat');
  const { records, errors } = mapRows(rows, 0, autoMapping(preset, idx));
  assert.equal(records.length, 1);
  assert.equal(errors.length, 2);
  assert.ok(errors[0].row >= 1);
  assert.ok(errors[0].reason.includes('时间') || errors[0].reason.includes('金额'));
});

test('mapRows 遇到「不计收支」的行跳过（不是错误）', () => {
  const rows = [
    wechatHeader,
    ['2026-08-15 12:30:00', '', '店', '', '/', '¥3.00']
  ];
  const idx = buildColumnIndex(wechatHeader);
  const preset = PRESETS.find(p => p.id === 'wechat');
  const { records, errors } = mapRows(rows, 0, autoMapping(preset, idx));
  assert.equal(records.length, 0);
  assert.equal(errors.length, 0);
});

test('mapRows 在收支方向列越界时报错，而不是静默丢掉整批数据', () => {
  const idx = buildColumnIndex(wechatHeader);
  const preset = PRESETS.find(p => p.id === 'wechat');
  // 列映射配错：direction 指向一个不存在的列
  const mapping = { ...autoMapping(preset, idx), direction: 99 };
  const { records, errors } = mapRows(wechatRows, 3, mapping);
  assert.equal(records.length, 0);
  assert.equal(errors.length, 2);            // 两行数据各记一条，而不是「0 条记录、0 个错误」
  assert.equal(errors[0].reason, '收支方向列不存在');
  assert.equal(errors[0].row, 4);
  assert.equal(errors[1].row, 5);
});

test('mapRows 方向列存在但值为空时静默跳过（与越界区分开）', () => {
  const rows = [
    wechatHeader,
    ['2026-08-15 12:30:00', '', '店', '', '', '¥3.00']
  ];
  const idx = buildColumnIndex(wechatHeader);
  const preset = PRESETS.find(p => p.id === 'wechat');
  const { records, errors } = mapRows(rows, 0, autoMapping(preset, idx));
  assert.equal(records.length, 0);
  assert.equal(errors.length, 0);
});

test('mapRows 不传 direction 列时按金额正负判断', () => {
  const rows = [['d'], ['2026-08-15 12:30:00', '-12.34'], ['2026-08-15 12:30:00', '12.34']];
  const { records } = mapRows(rows, 0, { time: 0, amount: 1, direction: null, merchant: null, note: null });
  assert.equal(records.length, 2);
  assert.equal(records[0].kind, 'expense');
  assert.equal(records[0].amountCents, 1234);   // 存正数，方向由 kind 表达
  assert.equal(records[1].kind, 'income');
});
```

- [ ] **步骤 2：运行测试验证失败**

- [ ] **步骤 3：实现 `app/import-schema.js`**

```js
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
```

- [ ] **步骤 4：运行测试验证通过** → 12 个用例全过

- [ ] **步骤 5：Commit**

```bash
git add app/import-schema.js tests/import-schema.test.js
git commit -m "feat: 账单预设（微信/支付宝）与通用列映射"
```

---

## 任务 4：导入仓库层 `app/import-store.js`

**文件**：创建 `app/import-store.js`；修改 `app/db.js`（若需）；修改 `app/schema.js`

> 依赖 IndexedDB，不写单测，靠探针 + 手动清单。

- [ ] **步骤 1：`app/schema.js` 的 `seedSettings()` 增加一项**

```js
    { key: 'importProfiles', value: [] },
```

- [ ] **步骤 2：实现 `app/import-store.js`**

| 函数 | 行为 |
|---|---|
| `existingFingerprints()` | 读全部交易（`db.getAll('txns')`），返回 `Set<fingerprint>`。交易的 fingerprint 用 `makeFingerprint({ occurredAt, amountCents, kind, merchant })` 现算——**注意现有交易没有单独的 merchant 字段**，所以要用 `note` 里**第一个 ` · ` 之前**那一段当作 merchant（与导入时 `[merchant, note].filter(Boolean).join(' · ')` 的写法对称），保证与导入时的算法一致 |
| `prepareImport(records, { defaultCategoryId, defaultAccountId })` | 用 `existingFingerprints()` 过滤掉重复的；给每条补上 `id` / `categoryId` / `accountId` / `source: 'import'` / `createdAt` / `updatedAt`；返回 `{ fresh, duplicates }` |
| `commitImport(records)` | **单事务批量写入**（复用 `db.putAll`）；返回写入的 id 列表 |
| `undoImport(ids)` | 按 id 批量删除（`db.removeAll`） |
| `listProfiles()` / `saveProfile(profile)` | 读写 `settings.importProfiles`（形如 `[{ id, name, mapping }]`） |
| `deleteProfile(id)` | — |

**去重口径要写清楚**（并在手动清单里列为待确认项）：指纹 = **时间 + 金额 + 收支方向 + 商户**（`occurredAt|amountCents|kind|merchant`）。同一笔在微信和支付宝里各导出一次、或同一文件导入两次，都会被认成重复。方向参与指纹，所以同一秒同金额同商户的一收一支（转账双向往来、消费 + 即时退款）不会被误判；**但同一秒同一个商户同样金额同一个方向的两笔真实消费仍会被误判成重复**——这是取舍，宁可少导也不要重复导。向导里要**显示**「N 条疑似重复已跳过」，让用户能看到。

- [ ] **步骤 3：探针验证**

- 导入 5 条 → 库里 5 条、`source === 'import'`
- **再导入同一文件** → `fresh` 为空、5 条全被认成重复、库里仍是 5 条
- 撤销 → 库里回到 0
- profile 存取往返
- 中途失败（人为让某条 key 非法）→ 一条都不落库（`putAll` 的单事务保证）

- [ ] **步骤 4：Commit**

```bash
git add app/import-store.js app/schema.js app/db.js
git commit -m "feat: 账单导入仓库层（去重、单事务写入、可撤销、格式配置）"
```

---

## 任务 5：导入向导界面 `app/ui/import-view.js`

**文件**：创建 `app/ui/import-view.js`；修改 `styles/vault.css` 或新建 `styles/import.css`、`index.html`、`sw.js`

**导出 `openImportSheet({ onChanged })`**，一个 sheet 内分步（**同一层内切步骤，不嵌套 sheet**）：

**第 1 步 · 选文件**
- 一个「选择账单文件」按钮（隐藏的 `<input type="file" accept=".csv,text/csv">`）
- 醒目的范围说明：**「只支持 CSV。Excel 文件请先在 Excel / WPS 里「另存为 CSV」。」**
- 文件读成 `ArrayBuffer` → `decodeBytes` → `parseCsv`

**第 2 步 · 认表头**
- 先试 `detectPreset(rows)`：认出来就显示「已识别为：微信支付账单」，直接进第 3 步
- 认不出来就显示**前 5 行预览**（表格），让用户**点选哪一行是表头**

**第 3 步 · 指定列**
- 五个下拉（时间 / 金额 / 收支方向（可空）/ 商户（可空）/ 备注（可空）），每项列出该表头行的各列名
- 预设命中时已自动填好（`autoMapping`）
- 「保存为格式配置」：一个名字输入框 + 保存按钮（预设命中时也可保存，方便用户改过之后复用）
- 已保存的配置显示为一个下拉，选中即套用

**第 4 步 · 预览与确认**
- 调 `prepareImport`，显示：**「将导入 N 条；跳过 M 条疑似重复；K 条无法解析」**
- 无法解析的那些列出**前 5 条**（行号 + 原始值 + 原因）
- 一个「默认分类」（下拉，支出分类）与「默认账户」（下拉）选择器——导入的记录统一用它们，**用户之后可以在统计页按分类改**（V1 不做逐条改分类）
- 一个「标题下显示前 20 条待导入记录」的预览表
- 底部「确认导入 N 条」——**只有 N > 0 时可用**
- 点确认 → `commitImport` → 显示「已导入 N 条，跳过 M 条重复」→ **5 分钟内可撤销**的浮层（复用 `entry-panel` 里那套 toast 的做法，或抽一个共用的小组件）→ 调 `onChanged()`

**第 5 步 · 撤销**
- 浮层「已导入 N 条 / 撤销」，点撤销 → `undoImport(ids)` → `onChanged()`

---

## 任务 6：入口接线与收尾

- [ ] `app/ui/settings-sheet.js` 加第五行「账单导入」→ `openImportSheet(...)`
- [ ] `sw.js`：`ASSETS` 加 `csv.js` / `import-parse.js` / `import-schema.js` / `import-store.js` / `ui/import-view.js`（**逐个核对路径真实存在**），`CACHE` 版本号 +1
- [ ] `docs/手动验证清单.md` 追加「账单导入」小节（含：只支持 CSV 的说明、去重口径的取舍、撤销窗口）
- [ ] `docs/superpowers/specs/2026-09-23-pvault-design.md` 第 9 节标记为已实现，并把「去重指纹 = 时间+金额+商户」与「导入记录 source='import'」写进去
- [ ] 全量测试全绿 + dev-server 逐条核对 ASSETS 返回 200
- [ ] Commit：`feat: 账单导入入口接线与交付收尾`

---

## 自检记录

**规格覆盖度（对照设计规格第 9 节）**

| 规格要求 | 任务 |
|---|---|
| 预设解析器（微信支付账单、支付宝账单，含 GBK 识别） | 1、3 |
| 通用列映射（任意 CSV，首次手动指定列，保存为具名格式配置，下次一键导入） | 3、4、5 |
| 去重（时间 + 金额 + 商户 指纹，提示「N 条重复已跳过」） | 2、4、5 |
| 先预览再落库（可勾选、可改分类、确认后才写入） | 5（V1 简化为「统一默认分类」，逐条改分类列入 V2） |
| V1 只支持 CSV，界面上写明 xlsx 请另存 | 5 |

**与规格的一处有意简化**：规格 9 节写「解析后展示待导入列表，可勾选、可改分类」。V1 实现为**统一指定默认分类 + 默认账户**，不做逐条勾选与逐条改分类——理由是手机屏幕上逐条改几十上百条并不现实，而数据反正可以用统计页的分类功能事后调整。这一条在实现时要写进界面文案与手动清单，让用户知道当前行为。

**占位符扫描**：任务 4、5、6 以行为要求描述而非逐行代码（它们依赖 IndexedDB 与已有组件的既成模式），但每条都给出可判定的验收点。

**类型一致性**：`records` 元素形状统一为 `{ occurredAt, amountCents, kind, note, fingerprint }`，在任务 3 产出、任务 4 消费、任务 5 展示；`mapping` 形状统一为 `{ time, amount, direction, merchant, note }`（值为列索引或 `null`）。
