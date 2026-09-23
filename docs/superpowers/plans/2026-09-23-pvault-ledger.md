# pvault 记账模块 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 做出一个能在手机浏览器离线使用的记账 app —— 能在 3 个动作内记完一笔、看得到月度统计与预算进度，并作为后续密码箱模块的骨架。

**架构：** 纯静态网页应用，无构建、无依赖。浏览器原生 ES Modules 组织代码，IndexedDB 存数据，Service Worker 缓存资源实现离线。**所有领域逻辑写成纯函数，与 DOM 和存储完全解耦**，因此能直接在 Node 内置测试运行器里单测——项目里没有 `node_modules`。

**技术栈：** HTML / CSS / 原生 JS（ES Modules）/ IndexedDB / Service Worker / Node 24 `node:test`

**范围：** 本计划只覆盖记账模块。密码箱与备份是计划 2，账单导入是计划 3。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `package.json` | 只声明 `type: module` 与两个脚本，**零依赖** |
| `index.html` | 唯一 HTML 外壳：挂载点 + 样式 + 入口脚本 |
| `manifest.webmanifest` | PWA 清单（名称、图标、快捷方式） |
| `sw.js` | Service Worker：预缓存静态资源、缓存优先、版本更新提示 |
| `scripts/dev-server.js` | 本地静态服务器（Node 内置 http，零依赖，供手机/本机预览），导出 `createHandler` 供测试用 |
| `tests/dev-server.test.js` | 开发服务器的回归测试（零依赖，`node:test` + 内置 fetch/http） |
| `styles/base.css` | 设计变量、重置、排版、深浅色 |
| `styles/components.css` | 通用组件：卡片、列表、按钮、输入、面板、标签 |
| `styles/ledger.css` | 记账页面专用样式：首页、键盘、环形图、统计 |
| `app/main.js` | 启动装配：注册 Service Worker、挂载外壳 |
| `app/router.js` | 极简 hash 路由（`#/ledger` `#/stats`），含 Tab 高亮 |
| `app/money.js` | **纯**：整数分格式化/解析/加减 |
| `app/dates.js` | **纯**：本地时区的日/月边界、剩余天数、标签格式化、近 N 月 |
| `app/budget.js` | **纯**：预算进度、阈值配色、日均可用 |
| `app/summary.js` | **纯**：月度合计、分类聚合、环比、趋势序列 |
| `app/receivable.js` | **纯**：分摊后的实际支出、应收应付汇总 |
| `app/predict.js` | **纯**：按时段与历史预测默认分类 |
| `app/chart.js` | **纯**：环形图弧段角度与 SVG path |
| `app/keypad-model.js` | **纯**：数字键盘输入状态机 |
| `app/db.js` | IndexedDB 薄封装：open/get/put/putAll/getAll/delete/byIndex |
| `app/schema.js` | 对象仓库定义 + 默认分类与账户种子数据 |
| `app/store.js` | 仓库层：交易的增删改查、按月查询、预算与应收读写 |
| `app/ui/dom.js` | DOM helper：`el()` 创建元素、`clear()`、事件绑定 |
| `app/ui/sheet.js` | 半屏面板组件（底部滑出、遮罩、关闭） |
| `app/ui/ledger-home.js` | 记账首页：四块 + 应收小字 + 悬浮加号 |
| `app/ui/entry-panel.js` | 录入面板：三种交易类型、金额、分类九宫格、账户、时间、备注、分摊、撤销 |
| `app/ui/stats-view.js` | 统计：环形图 + 分类明细 + 近 6 月趋势 |
| `app/ui/accounts-view.js` | 账户管理（增删改、归档、信用卡账单日/还款日） |
| `app/ui/categories-view.js` | 分类管理（增删改、图标、排序） |
| `app/ui/settings-view.js` | 预算设置、固定支出、隐藏金额、锁定超时 |
| `app/ui/receivable-view.js` | 应收/应付明细与结算 |
| `tests/*.test.js` | 8 个纯逻辑模块的单元测试 |
| `docs/手动验证清单.md` | UI 与存储的人工验证条目 |

**分层规则（必须遵守）**：`app/` 根目录下的 8 个模块（money/dates/budget/summary/receivable/predict/chart/keypad-model）**只能 import 彼此，绝不能 import db.js / store.js / ui/**。违反这条，测试就跑不起来。

---

## 全局约定

- **金额一律为整数分**。任何地方不得用浮点数存储或计算金额。
- 时间戳为毫秒数（`occurredAt`、`createdAt`）。
- ID 用 `crypto.randomUUID()`（Node 24 与浏览器都支持）。
- 测试命令 `npm test`（即 `node --test`），零依赖。
- commit message 用中文，前缀 `feat:` / `test:` / `chore:` / `fix:`。
- 每个任务结束都要 commit，**不要攒着一起提交**。

---

### 任务 1：项目骨架与测试运行器

**文件：**
- 创建：`package.json`
- 创建：`index.html`
- 创建：`styles/base.css`
- 创建：`app/main.js`
- 创建：`scripts/dev-server.js`
- 创建：`tests/dev-server.test.js`

- [ ] **步骤 1：创建 `package.json`**

```json
{
  "name": "pvault",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test",
    "dev": "node scripts/dev-server.js"
  },
  "engines": { "node": ">=20" }
}
```

`type: module` 让 Node 用 ESM 解析 `.js`，与浏览器一致。**不要**添加任何 dependencies。

- [ ] **步骤 2：创建 `scripts/dev-server.js`**

```js
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.PORT) || 8080;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

// 抽出可导出的 handler，便于测试用 listen(0) 起临时服务器验证真实行为
export function createHandler(root) {
  return async (req, res) => {
    let rel;
    let filePath;
    try {
      const { pathname } = new URL(req.url, 'http://localhost');
      const urlPath = decodeURIComponent(pathname);
      rel = normalize(urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, ''));
      filePath = join(root, rel);
    } catch {
      // 畸形百分号转义（如 /%E4%、/a%b）会抛 URIError；回 400，不能拖垮整个进程
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Bad request');
      return;
    }
    // 点开头的路径段（.git/、.gitignore…）一律拒绝，避免局域网预览时被拖走仓库元数据
    if (rel.split(/[\\/]/).some(seg => seg.startsWith('.'))) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    if (!filePath.startsWith(root.endsWith(sep) ? root : root + sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    try {
      const body = await readFile(filePath);
      res.writeHead(200, {
        'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
        'Service-Worker-Allowed': '/'
      });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
    }
  };
}

const server = createServer(createHandler(ROOT));

// 仅在直接运行（node scripts/dev-server.js）时监听；被测试 import 时不监听
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      console.error(`端口 ${PORT} 已被占用。关闭占用进程，或换个端口：`);
      console.error(`  PowerShell:  $env:PORT=8081; node scripts/dev-server.js`);
    } else {
      console.error('开发服务器启动失败:', err.message);
    }
    process.exit(1);
  });

  server.listen(PORT, () => {
    console.log(`pvault dev server: http://localhost:${PORT}`);
    const lan = Object.values(networkInterfaces()).flat()
      .filter(i => i && i.family === 'IPv4' && !i.internal)
      .map(i => i.address);
    for (const ip of lan) console.log(`  手机访问:   http://${ip}:${PORT}`);
  });
}
```

handler 必须包在 try/catch 里：畸形转义会抛 `URIError`，在 async handler 中无人捕获会直接让 node 进程退出，全部连接被拒。另外任何以点开头的路径段一律 403（`/.gitignore`、`/.git/HEAD` 都不能被同一 Wi-Fi 下的人取走）。

本地必须走 `http://localhost`，不能直接双击 `index.html` —— `file://` 下 IndexedDB 和 Service Worker 都不可用。

- [ ] **步骤 3：创建 `index.html`**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#f2f2f5" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#131315" media="(prefers-color-scheme: dark)">
<title>pvault</title>
<link rel="manifest" href="./manifest.webmanifest">
<link rel="icon" href="./icons/icon.svg">
<link rel="stylesheet" href="./styles/base.css">
<link rel="stylesheet" href="./styles/components.css">
<link rel="stylesheet" href="./styles/ledger.css">
</head>
<body>
  <div id="app" class="app"></div>
  <script type="module" src="./app/main.js"></script>
</body>
</html>
```

- [ ] **步骤 4：创建 `styles/base.css`**

```css
:root {
  --bg: #f2f2f5;
  --surface: #ffffff;
  --surface-2: #e9e9ec;
  --border: #d5d5da;
  --text: #1d1d1f;
  --text-2: #6e6e73;
  --text-3: #a1a1a6;
  --accent: #0a6ef0;
  --accent-weak: #e6f0fe;
  --success: #34c759;
  --warning: #ff9f0a;
  --error: #ff3b30;
  --radius: 12px;
  --radius-sm: 10px;
  --radius-pill: 3px;
  --radius-sheet: 16px;
  --font-xs: 11px;
  --font-sm: 12px;
  --font-md: 14px;
  --font-lg: 20px;
  --font-xl: 30px;
  --font-display: 34px;
  --on-accent: #fff;
  --overlay: rgba(0, 0, 0, .35);
  --shadow: 0 6px 18px rgba(0, 0, 0, .22);
  --tab-h: 56px;
  --safe-b: env(safe-area-inset-bottom, 0px);
  --bottom-inset: calc(var(--tab-h) + var(--safe-b));
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #131315;
    --surface: #1e1e21;
    --surface-2: #2b2b30;
    --border: #3a3a40;
    --text: #f2f2f5;
    --text-2: #9a9aa0;
    --text-3: #6e6e73;
    --accent: #3b8ef5;
    --accent-weak: #16273d;
  }
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; }
body {
  font-family: system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
  background: var(--bg);
  color: var(--text);
  -webkit-text-size-adjust: 100%;
  -webkit-tap-highlight-color: transparent;
}
.app {
  min-height: 100%;
  display: flex;
  flex-direction: column;
  padding-bottom: var(--bottom-inset);
}
.num { font-variant-numeric: tabular-nums; }
.hide-amount { filter: blur(6px); }
```

- [ ] **步骤 5：创建最小 `app/main.js`**

```js
const app = document.getElementById('app');
app.textContent = 'pvault';
```

- [ ] **步骤 6：创建 `tests/dev-server.test.js` 并运行测试**

用 `node:test` + 内置 `fetch`，**不引任何依赖**。骨架：

```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createHandler } from '../scripts/dev-server.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
let server, base;

before(async () => {
  server = createServer(createHandler(ROOT));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise(r => server.close(r)));
```

至少覆盖 5 条：`/` 返回 200 且含 `<div id="app"`、`/nope.js` 返回 404、`/..%2fpackage.json` 返回 403（路径穿越）、`/%E4%` 返回 400 **且随后 `/` 仍返回 200**（服务器没崩，这是崩溃回归的唯一证据）、`/.gitignore` 返回 403。

穿越与畸形路径用例用 `node:http` 的 `request` 发原始 `path` 作为权威断言（不依赖客户端 URL 预处理的细节）；实测 undici 也不会把 `%2f` 当分隔符，所以同一路径再用 `fetch` 断言一次作为浏览器语义的对照。

运行：`npm test`
预期：`# tests 5`、`# pass 5`、`# fail 0`，退出码 0。

- [ ] **步骤 7：启动本地服务器确认页面可访问**

运行：`npm run dev`（保持后台运行）
预期：控制台输出 `pvault dev server: http://localhost:8080`，以及一行 `手机访问: http://<局域网 IP>:8080`（手机预览必须用后者，`localhost` 在手机上指手机自己）；浏览器打开该地址看到 `pvault` 字样。
再起一次（不关掉上一个）应看到 `端口 8080 已被占用` 的提示而不是一堆堆栈。

- [ ] **步骤 8：Commit**

```bash
git add package.json index.html styles/base.css app/main.js scripts/dev-server.js tests/dev-server.test.js
git commit -m "chore: 项目骨架（无构建纯静态 + 零依赖测试运行器）"
```

---

### 任务 2：金额模块 `app/money.js`

**文件：**
- 创建：`app/money.js`
- 测试：`tests/money.test.js`

- [ ] **步骤 1：编写失败的测试**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCents, parseAmountToCents, addCents, subCents } from '../app/money.js';

test('formatCents 输出两位小数', () => {
  assert.equal(formatCents(1240), '12.40');
  assert.equal(formatCents(0), '0.00');
  assert.equal(formatCents(5), '0.05');
  assert.equal(formatCents(100000000), '1000000.00');
});

test('formatCents 负数与货币符号', () => {
  assert.equal(formatCents(-320), '-3.20');
  assert.equal(formatCents(1240, { symbol: true }), '¥12.40');
  assert.equal(formatCents(-320, { symbol: true }), '-¥3.20');
});

test('parseAmountToCents 解析用户输入', () => {
  assert.equal(parseAmountToCents('12.4'), 1240);
  assert.equal(parseAmountToCents('12.40'), 1240);
  assert.equal(parseAmountToCents('0.05'), 5);
  assert.equal(parseAmountToCents('100'), 10000);
  assert.equal(parseAmountToCents('12.'), 1200);
  assert.equal(parseAmountToCents('.5'), 50);
  assert.equal(parseAmountToCents('0'), 0);
});

test('parseAmountToCents 拒绝非法输入', () => {
  assert.equal(parseAmountToCents(''), null);
  assert.equal(parseAmountToCents('.'), null);
  assert.equal(parseAmountToCents('abc'), null);
  assert.equal(parseAmountToCents('1.2.3'), null);
  assert.equal(parseAmountToCents('-5'), null);
  assert.equal(parseAmountToCents('1.234'), null);
  assert.equal(parseAmountToCents(' 12.4 '), 1240);
});

test('整数分相加不会有浮点误差', () => {
  assert.equal(addCents(10, 20), 30);
  assert.equal(addCents(1240, 5, 1), 1246);
  assert.equal(subCents(1000, 1), 999);
  assert.equal(addCents(), 0);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test tests/money.test.js`
预期：FAIL，报 `Cannot find module '../app/money.js'`。

- [ ] **步骤 3：实现 `app/money.js`**

```js
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
```

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test tests/money.test.js`
预期：PASS，5 个测试全过。

- [ ] **步骤 5：Commit**

```bash
git add app/money.js tests/money.test.js
git commit -m "feat: 金额模块（整数分运算与格式化）"
```

---

### 任务 3：日期模块 `app/dates.js`

**文件：**
- 创建：`app/dates.js`
- 测试：`tests/dates.test.js`

- [ ] **步骤 1：编写失败的测试**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  startOfDay, dayRange, monthRange, daysLeftInMonth, addMonths,
  formatDayLabel, formatMonthLabel, lastNMonths
} from '../app/dates.js';

const sep23 = new Date(2026, 8, 23, 14, 30).getTime();
const sep1 = new Date(2026, 8, 1, 0, 0).getTime();
const oct1 = new Date(2026, 9, 1, 0, 0).getTime();

test('startOfDay 归零到本地零点', () => {
  assert.equal(startOfDay(sep23), sep1 + 22 * 86400000 + 0);
  const d = new Date(startOfDay(sep23));
  assert.equal(d.getHours(), 0);
  assert.equal(d.getMinutes(), 0);
  assert.equal(d.getSeconds(), 0);
});

test('dayRange 覆盖当天整日', () => {
  const { start, end } = dayRange(sep23);
  assert.equal(end - start, 86400000);
  assert.equal(new Date(start).getDate(), 23);
  assert.equal(new Date(end).getDate(), 24);
});

test('monthRange 覆盖当月整月', () => {
  const { start, end } = monthRange(sep23);
  assert.equal(start, sep1);
  assert.equal(end, oct1);
});

test('monthRange 正确处理 12 月跨年', () => {
  const dec = new Date(2026, 11, 15).getTime();
  const { end } = monthRange(dec);
  const d = new Date(end);
  assert.equal(d.getFullYear(), 2027);
  assert.equal(d.getMonth(), 0);
  assert.equal(d.getDate(), 1);
});

test('daysLeftInMonth 含今天', () => {
  assert.equal(daysLeftInMonth(sep23), 8);
  assert.equal(daysLeftInMonth(new Date(2026, 8, 30).getTime()), 1);
  assert.equal(daysLeftInMonth(new Date(2026, 8, 1).getTime()), 30);
});

test('addMonths 处理跨年与月末', () => {
  const jan = addMonths(new Date(2026, 11, 15).getTime(), 1);
  assert.equal(new Date(jan).getMonth(), 0);
  assert.equal(new Date(jan).getFullYear(), 2027);
  const back = addMonths(new Date(2026, 0, 15).getTime(), -1);
  assert.equal(new Date(back).getFullYear(), 2025);
  assert.equal(new Date(back).getMonth(), 11);
});

test('formatDayLabel 给出今天/昨天/日期', () => {
  const yesterday = new Date(2026, 8, 22, 9, 0).getTime();
  assert.equal(formatDayLabel(sep23, sep23), '今天');
  assert.equal(formatDayLabel(yesterday, sep23), '昨天');
  assert.equal(formatDayLabel(new Date(2026, 8, 20).getTime(), sep23), '9月20日');
  assert.equal(formatDayLabel(new Date(2026, 7, 3).getTime(), sep23), '8月3日');
});

test('formatMonthLabel 输出年月', () => {
  assert.equal(formatMonthLabel(sep23), '2026 年 9 月');
});

test('lastNMonths 返回从旧到新的连续月份', () => {
  const list = lastNMonths(sep23, 6);
  assert.equal(list.length, 6);
  assert.equal(list[5].label, '2026 年 9 月');
  assert.equal(list[0].label, '2026 年 4 月');
  assert.equal(list[0].start, new Date(2026, 3, 1).getTime());
  assert.equal(list[5].end, oct1);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test tests/dates.test.js`
预期：FAIL，报 `Cannot find module '../app/dates.js'`。

- [ ] **步骤 3：实现 `app/dates.js`**

```js
export function startOfDay(ts) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function dayRange(ts) {
  const start = startOfDay(ts);
  const d = new Date(start);
  const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  return { start, end };
}

export function monthRange(ts) {
  const d = new Date(ts);
  const start = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
  return { start, end };
}

export function daysLeftInMonth(ts) {
  const { end } = monthRange(ts);
  const lastDay = new Date(end - 1);
  return lastDay.getDate() - new Date(ts).getDate() + 1;
}

export function addMonths(ts, n) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth() + n, d.getDate()).getTime();
}

export function formatDayLabel(ts, now) {
  const { start } = dayRange(now);
  const day = startOfDay(ts);
  if (day === start) return '今天';
  if (day === start - 86400000) return '昨天';
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

export function formatMonthLabel(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`;
}

export function lastNMonths(ts, n) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const anchor = new Date(new Date(ts).getFullYear(), new Date(ts).getMonth() - i, 1).getTime();
    out.push({ label: formatMonthLabel(anchor), ...monthRange(anchor) });
  }
  return out;
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test tests/dates.test.js`
预期：PASS，9 个测试全过。

> 若 `startOfDay` 那条断言因夏令时失败，把它改成只断言 `getHours()/getMinutes()/getSeconds()` 三个分量——中国无夏令时，但测试不该依赖时区。

- [ ] **步骤 5：Commit**

```bash
git add app/dates.js tests/dates.test.js
git commit -m "feat: 日期模块（本地时区月/日边界与格式化）"
```

---

### 任务 4：预算模块 `app/budget.js`

**文件：**
- 创建：`app/budget.js`
- 测试：`tests/budget.test.js`

- [ ] **步骤 1：编写失败的测试**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { budgetProgress, budgetLevel, dailyAllowance } from '../app/budget.js';

test('budgetProgress 返回使用比率', () => {
  assert.equal(budgetProgress(3240, 5000), 0.648);
  assert.equal(budgetProgress(0, 5000), 0);
  assert.equal(budgetProgress(5000, 5000), 1);
  assert.equal(budgetProgress(6000, 5000), 1.2);
});

test('budgetProgress 未设预算时返回 null', () => {
  assert.equal(budgetProgress(100, 0), null);
  assert.equal(budgetProgress(100, null), null);
  assert.equal(budgetProgress(100, undefined), null);
});

test('budgetLevel 三档阈值：<80% 绿、80~100% 黄、>100% 红', () => {
  assert.equal(budgetLevel(0), 'ok');
  assert.equal(budgetLevel(0.79), 'ok');
  assert.equal(budgetLevel(0.8), 'warn');
  assert.equal(budgetLevel(1), 'warn');
  assert.equal(budgetLevel(1.01), 'over');
  assert.equal(budgetLevel(null), 'none');
});

test('dailyAllowance 用剩余预算除以本月剩余天数并向下取整', () => {
  assert.equal(dailyAllowance(176000, 8), 22000);
  assert.equal(dailyAllowance(1000, 3), 333);
  assert.equal(dailyAllowance(1000, 1), 1000);
});

test('dailyAllowance 对超支与非法天数返回 0', () => {
  assert.equal(dailyAllowance(-500, 5), 0);
  assert.equal(dailyAllowance(1000, 0), 0);
  assert.equal(dailyAllowance(1000, -1), 0);
});

test('dailyAllowance 在缺失预算时返回 null', () => {
  assert.equal(dailyAllowance(null, 5), null);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test tests/budget.test.js`
预期：FAIL，报 `Cannot find module '../app/budget.js'`。

- [ ] **步骤 3：实现 `app/budget.js`**

```js
export function budgetProgress(spentCents, totalCents) {
  if (!totalCents || totalCents <= 0) return null;
  return spentCents / totalCents;
}

export function budgetLevel(ratio) {
  if (ratio === null || ratio === undefined) return 'none';
  if (ratio > 1) return 'over';
  if (ratio >= 0.8) return 'warn';
  return 'ok';
}

export function dailyAllowance(remainingCents, daysLeft) {
  if (remainingCents === null || remainingCents === undefined) return null;
  if (!daysLeft || daysLeft <= 0) return 0;
  if (remainingCents <= 0) return 0;
  return Math.floor(remainingCents / daysLeft);
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test tests/budget.test.js`
预期：PASS，6 个测试全过。

- [ ] **步骤 5：Commit**

```bash
git add app/budget.js tests/budget.test.js
git commit -m "feat: 预算模块（进度、三档阈值、日均可用）"
```

---

### 任务 5：汇总模块 `app/summary.js`

**文件：**
- 创建：`app/summary.js`
- 测试：`tests/summary.test.js`

- [ ] **步骤 1：编写失败的测试**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monthlyTotals, byCategory, compareWithPrev, trendSeries } from '../app/summary.js';

const txn = (kind, cents, categoryId = 'c1') => ({ kind, amountCents: cents, categoryId });
const cats = [
  { id: 'c1', name: '餐饮', icon: '🍜', kind: 'expense' },
  { id: 'c2', name: '交通', icon: '🚇', kind: 'expense' },
  { id: 'c3', name: '工资', icon: '💰', kind: 'income' }
];

test('monthlyTotals 合计支出与收入，净额取差', () => {
  const r = monthlyTotals([
    txn('expense', 1240), txn('expense', 3000), txn('income', 850000)
  ]);
  assert.deepEqual(r, { expense: 4240, income: 850000, net: 845760 });
});

test('monthlyTotals 排除转账', () => {
  const r = monthlyTotals([txn('expense', 1000), txn('transfer', 500000)]);
  assert.equal(r.expense, 1000);
  assert.equal(r.income, 0);
});

test('monthlyTotals 空输入返回零', () => {
  assert.deepEqual(monthlyTotals([]), { expense: 0, income: 0, net: 0 });
});

test('byCategory 按金额降序并给出占比', () => {
  const rows = byCategory([
    txn('expense', 1000, 'c1'), txn('expense', 3000, 'c2'), txn('expense', 1000, 'c1')
  ], cats, 'expense');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].categoryId, 'c2');
  assert.equal(rows[0].cents, 3000);
  assert.equal(rows[0].name, '交通');
  assert.equal(rows[1].cents, 2000);
  assert.equal(rows[0].ratio + rows[1].ratio, 1);
});

test('byCategory 忽略其他类型与未知分类', () => {
  const rows = byCategory([txn('income', 9999, 'c3'), txn('expense', 500, 'ghost')], cats, 'expense');
  assert.deepEqual(rows, []);
});

test('compareWithPrev 计算环比', () => {
  assert.deepEqual(compareWithPrev(880, 1000), { deltaCents: -120, ratio: -0.12 });
  assert.equal(compareWithPrev(1000, 0), null);
});

test('trendSeries 给出柱高比例', () => {
  const s = trendSeries([
    { label: '7月', cents: 500 }, { label: '8月', cents: 1000 }, { label: '9月', cents: 0 }
  ]);
  assert.equal(s.max, 1000);
  assert.deepEqual(s.bars.map(b => b.heightRatio), [0.5, 1, 0]);
});

test('trendSeries 全零时柱高为 0 且不除以零', () => {
  const s = trendSeries([{ label: '8月', cents: 0 }, { label: '9月', cents: 0 }]);
  assert.equal(s.max, 0);
  assert.deepEqual(s.bars.map(b => b.heightRatio), [0, 0]);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test tests/summary.test.js`
预期：FAIL，报 `Cannot find module '../app/summary.js'`。

- [ ] **步骤 3：实现 `app/summary.js`**

```js
export function monthlyTotals(txns) {
  let expense = 0;
  let income = 0;
  for (const t of txns) {
    if (t.kind === 'expense') expense += t.amountCents;
    else if (t.kind === 'income') income += t.amountCents;
  }
  return { expense, income, net: income - expense };
}

export function byCategory(txns, categories, kind = 'expense') {
  const nameOf = new Map(categories.map(c => [c.id, c]));
  const sums = new Map();
  for (const t of txns) {
    if (t.kind !== kind) continue;
    if (!nameOf.has(t.categoryId)) continue;
    sums.set(t.categoryId, (sums.get(t.categoryId) || 0) + t.amountCents);
  }
  const total = [...sums.values()].reduce((a, b) => a + b, 0);
  if (total === 0) return [];
  return [...sums.entries()]
    .map(([categoryId, cents]) => {
      const c = nameOf.get(categoryId);
      return { categoryId, name: c.name, icon: c.icon, cents, ratio: cents / total };
    })
    .sort((a, b) => b.cents - a.cents);
}

export function compareWithPrev(currentCents, prevCents) {
  if (!prevCents) return null;
  return {
    deltaCents: currentCents - prevCents,
    ratio: (currentCents - prevCents) / prevCents
  };
}

export function trendSeries(months) {
  const max = months.reduce((m, x) => Math.max(m, x.cents), 0);
  return {
    max,
    bars: months.map(m => ({ ...m, heightRatio: max === 0 ? 0 : m.cents / max }))
  };
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test tests/summary.test.js`
预期：PASS，9 个测试全过。

- [ ] **步骤 5：Commit**

```bash
git add app/summary.js tests/summary.test.js
git commit -m "feat: 汇总模块（月度合计、分类聚合、环比、趋势）"
```

---

### 任务 6：应收与分摊模块 `app/receivable.js`

**文件：**
- 创建：`app/receivable.js`
- 测试：`tests/receivable.test.js`

- [ ] **步骤 1：编写失败的测试**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveExpense, receivableSummary, outstandingList } from '../app/receivable.js';

test('effectiveExpense 扣掉他人分摊份额', () => {
  const t = { kind: 'expense', amountCents: 10000, shares: [
    { personName: '小王', amountCents: 4000, settled: false },
    { personName: '张三', amountCents: 500 }
  ] };
  assert.equal(effectiveExpense(t), 5500);
});

test('effectiveExpense 无分摊时等于原金额', () => {
  assert.equal(effectiveExpense({ kind: 'expense', amountCents: 2800 }), 2800);
});

test('effectiveExpense 非支出返回原金额', () => {
  assert.equal(effectiveExpense({ kind: 'income', amountCents: 5000, shares: [] }), 5000);
});

test('effectiveExpense 分摊超过总额时抛错', () => {
  const t = { kind: 'expense', amountCents: 1000, shares: [{ amountCents: 1200 }] };
  assert.throws(() => effectiveExpense(t), RangeError);
});

test('receivableSummary 分别汇总应收与应付', () => {
  const list = [
    { direction: 'owedToMe', amountCents: 20000, settledAt: null },
    { direction: 'owedToMe', amountCents: 4500, settledAt: null },
    { direction: 'owedToMe', amountCents: 999, settledAt: 1790000000000 },
    { direction: 'iOwe', amountCents: 3000, settledAt: null }
  ];
  assert.deepEqual(receivableSummary(list), { owedToMe: 24500, iOwe: 3000 });
});

test('receivableSummary 空列表返回零', () => {
  assert.deepEqual(receivableSummary([]), { owedToMe: 0, iOwe: 0 });
});

test('outstandingList 只保留未结清项并按时间倒序', () => {
  const list = [
    { id: 'a', occurredAt: 100, settledAt: null },
    { id: 'b', occurredAt: 300, settledAt: null },
    { id: 'c', occurredAt: 200, settledAt: 123 }
  ];
  assert.deepEqual(outstandingList(list).map(x => x.id), ['b', 'a']);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test tests/receivable.test.js`
预期：FAIL，报 `Cannot find module '../app/receivable.js'`。

- [ ] **步骤 3：实现 `app/receivable.js`**

```js
export function effectiveExpense(txn) {
  if (txn.kind !== 'expense') return txn.amountCents;
  const shares = txn.shares || [];
  const shared = shares.reduce((sum, s) => sum + s.amountCents, 0);
  if (shared > txn.amountCents) {
    throw new RangeError('分摊合计不能超过交易金额');
  }
  return txn.amountCents - shared;
}

export function receivableSummary(list) {
  let owedToMe = 0;
  let iOwe = 0;
  for (const r of list) {
    if (r.settledAt) continue;
    if (r.direction === 'owedToMe') owedToMe += r.amountCents;
    else if (r.direction === 'iOwe') iOwe += r.amountCents;
  }
  return { owedToMe, iOwe };
}

export function outstandingList(list) {
  return list.filter(r => !r.settledAt).sort((a, b) => b.occurredAt - a.occurredAt);
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test tests/receivable.test.js`
预期：PASS，7 个测试全过。

- [ ] **步骤 5：Commit**

```bash
git add app/receivable.js tests/receivable.test.js
git commit -m "feat: 应收与分摊模块（有效支出、应收应付汇总）"
```

---

### 任务 7：默认分类预测 `app/predict.js`

**文件：**
- 创建：`app/predict.js`
- 测试：`tests/predict.test.js`

- [ ] **步骤 1：编写失败的测试**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { predictCategory, hourBucket } from '../app/predict.js';

const cats = [
  { id: 'food', name: '餐饮', kind: 'expense', archived: false },
  { id: 'traffic', name: '交通', kind: 'expense', archived: false },
  { id: 'shop', name: '购物', kind: 'expense', archived: false }
];

// 构造 n 笔某分类、落在指定小时的支出
const at = (hour, categoryId, day = 1) => ({
  kind: 'expense',
  categoryId,
  amountCents: 100,
  occurredAt: new Date(2026, 8, day, hour, 0).getTime()
});

test('hourBucket 把一天切成 8 个 3 小时区间', () => {
  assert.equal(hourBucket(0), 0);
  assert.equal(hourBucket(2), 0);
  assert.equal(hourBucket(3), 1);
  assert.equal(hourBucket(12), 4);
  assert.equal(hourBucket(23), 7);
});

test('同一时段历史最高频的分类胜出', () => {
  const txns = [
    at(12, 'food'), at(12, 'food', 2), at(12, 'food', 3), at(13, 'food', 4),
    at(12, 'shop', 5),
    at(19, 'traffic'), at(19, 'traffic', 2), at(19, 'traffic', 3), at(19, 'traffic', 4)
  ];
  assert.equal(predictCategory({ hour: 12, txns, categories: cats }), 'food');
  assert.equal(predictCategory({ hour: 19, txns, categories: cats }), 'traffic');
});

test('该时段样本不足 3 条时退化到全局最近 30 笔的高频', () => {
  const txns = [at(12, 'shop'), at(15, 'food', 2), at(15, 'food', 3), at(16, 'food', 4)];
  assert.equal(predictCategory({ hour: 12, txns, categories: cats }), 'food');
});

test('完全没有历史时返回第一个未归档分类', () => {
  assert.equal(predictCategory({ hour: 12, txns: [], categories: cats }), 'food');
});

test('预测结果落在已归档分类上时改选下一个可用分类', () => {
  const archived = cats.map(c => (c.id === 'food' ? { ...c, archived: true } : c));
  const txns = [at(12, 'food'), at(12, 'food', 2), at(12, 'food', 3)];
  assert.equal(predictCategory({ hour: 12, txns, categories: archived }), 'traffic');
});

test('没有任何可用分类时返回 null', () => {
  assert.equal(predictCategory({ hour: 12, txns: [], categories: [] }), null);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test tests/predict.test.js`
预期：FAIL，报 `Cannot find module '../app/predict.js'`。

- [ ] **步骤 3：实现 `app/predict.js`**

```js
export function hourBucket(hour) {
  return Math.floor(hour / 3);
}

function firstAvailable(categories) {
  const c = categories.find(x => !x.archived);
  return c ? c.id : null;
}

export function predictCategory({ hour, txns, categories }) {
  const usable = categories.filter(c => !c.archived && c.kind === 'expense');
  if (usable.length === 0) return firstAvailable(categories);

  const usableIds = new Set(usable.map(c => c.id));
  const bucket = hourBucket(hour);

  const inBucket = txns.filter(t =>
    t.kind === 'expense' &&
    usableIds.has(t.categoryId) &&
    hourBucket(new Date(t.occurredAt).getHours()) === bucket
  );

  if (inBucket.length >= 3) return mostFrequent(inBucket, usable);

  const recent = [...txns]
    .filter(t => t.kind === 'expense' && usableIds.has(t.categoryId))
    .sort((a, b) => b.occurredAt - a.occurredAt)
    .slice(0, 30);

  if (recent.length > 0) return mostFrequent(recent, usable);

  return usable[0].id;
}

function mostFrequent(list, usable) {
  const counts = new Map();
  for (const t of list) {
    counts.set(t.categoryId, (counts.get(t.categoryId) || 0) + 1);
  }
  let best = null;
  let bestCount = -1;
  for (const c of usable) {
    const n = counts.get(c.id) || 0;
    if (n > bestCount) { bestCount = n; best = c.id; }
  }
  return best;
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test tests/predict.test.js`
预期：PASS，6 个测试全过。

- [ ] **步骤 5：Commit**

```bash
git add app/predict.js tests/predict.test.js
git commit -m "feat: 默认分类预测（按 3 小时时段 + 历史频次）"
```

---

### 任务 8：环形图几何 `app/chart.js`

**文件：**
- 创建：`app/chart.js`
- 测试：`tests/chart.test.js`

- [ ] **步骤 1：编写失败的测试**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { donutSegments, donutPath, polarPoint } from '../app/chart.js';

test('donutSegments 从 12 点方向顺时针切分并累计角度', () => {
  const segs = donutSegments([{ key: 'a', cents: 50 }, { key: 'b', cents: 50 }]);
  assert.equal(segs[0].startAngle, 0);
  assert.equal(segs[0].endAngle, 180);
  assert.equal(segs[1].startAngle, 180);
  assert.equal(segs[1].endAngle, 360);
  assert.equal(segs[0].ratio, 0.5);
});

test('donutSegments 占比合计为 1', () => {
  const segs = donutSegments([{ key: 'a', cents: 1 }, { key: 'b', cents: 2 }, { key: 'c', cents: 7 }]);
  const sum = segs.reduce((s, x) => s + x.ratio, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
  assert.equal(Math.round(segs[2].endAngle), 360);
});

test('donutSegments 总金额为零时返回空数组', () => {
  assert.deepEqual(donutSegments([{ key: 'a', cents: 0 }]), []);
  assert.deepEqual(donutSegments([]), []);
});

test('polarPoint 0 度指向 12 点方向', () => {
  const p = polarPoint(100, 100, 50, 0);
  assert.ok(Math.abs(p.x - 100) < 1e-9);
  assert.ok(Math.abs(p.y - 50) < 1e-9);
});

test('polarPoint 90 度为 3 点方向', () => {
  const p = polarPoint(100, 100, 50, 90);
  assert.ok(Math.abs(p.x - 150) < 1e-9);
  assert.ok(Math.abs(p.y - 100) < 1e-9);
});

test('donutPath 生成有效的 SVG path', () => {
  const d = donutPath(100, 100, 80, 50, 0, 90);
  assert.match(d, /^M [\d.-]+ [\d.-]+ A /);
  assert.ok(d.includes('L'));
  assert.ok(d.trim().endsWith('Z'));
});

test('donutPath 对整圆特殊处理，不产生零长度弧', () => {
  const d = donutPath(100, 100, 80, 50, 0, 360);
  assert.equal(d, null);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test tests/chart.test.js`
预期：FAIL，报 `Cannot find module '../app/chart.js'`。

- [ ] **步骤 3：实现 `app/chart.js`**

```js
export function polarPoint(cx, cy, r, angleDeg) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

export function donutSegments(items) {
  const total = items.reduce((s, x) => s + x.cents, 0);
  if (total <= 0) return [];
  let cursor = 0;
  return items.map(item => {
    const ratio = item.cents / total;
    const startAngle = cursor;
    const endAngle = cursor + ratio * 360;
    cursor = endAngle;
    return { ...item, ratio, startAngle, endAngle };
  });
}

export function donutPath(cx, cy, rOuter, rInner, startAngle, endAngle) {
  if (endAngle - startAngle >= 360) return null; // 整圆交给 <circle> 画
  const largeArc = endAngle - startAngle > 180 ? 1 : 0;
  const o1 = polarPoint(cx, cy, rOuter, startAngle);
  const o2 = polarPoint(cx, cy, rOuter, endAngle);
  const i2 = polarPoint(cx, cy, rInner, endAngle);
  const i1 = polarPoint(cx, cy, rInner, startAngle);
  const n = v => Number(v.toFixed(3));
  return [
    `M ${n(o1.x)} ${n(o1.y)}`,
    `A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${n(o2.x)} ${n(o2.y)}`,
    `L ${n(i2.x)} ${n(i2.y)}`,
    `A ${rInner} ${rInner} 0 ${largeArc} 0 ${n(i1.x)} ${n(i1.y)}`,
    'Z'
  ].join(' ');
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test tests/chart.test.js`
预期：PASS，7 个测试全过。

- [ ] **步骤 5：Commit**

```bash
git add app/chart.js tests/chart.test.js
git commit -m "feat: 环形图几何（弧段角度与 SVG path）"
```

---

### 任务 9：数字键盘状态机 `app/keypad-model.js`

**文件：**
- 创建：`app/keypad-model.js`
- 测试：`tests/keypad-model.test.js`

- [ ] **步骤 1：编写失败的测试**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKeypadState, pressKey, keypadText, keypadCents } from '../app/keypad-model.js';

const type = (keys, state = createKeypadState()) =>
  keys.split('').reduce((s, k) => pressKey(s, k), state);

test('初始状态为空', () => {
  assert.equal(keypadText(createKeypadState()), '');
  assert.equal(keypadCents(createKeypadState()), null);
});

test('输入数字拼接', () => {
  assert.equal(keypadText(type('123')), '123');
  assert.equal(keypadCents(type('123')), 12300);
});

test('最多一个小数点', () => {
  assert.equal(keypadText(type('1.2.3')), '1.23');
});

test('小数位最多两位', () => {
  assert.equal(keypadText(type('1.239')), '1.23');
  assert.equal(keypadCents(type('1.23')), 123);
});

test('前导零被替换而不是堆叠', () => {
  assert.equal(keypadText(type('005')), '5');
  assert.equal(keypadText(type('0.5')), '0.5');
});

test('整数位最多 9 位', () => {
  assert.equal(keypadText(type('12345678901')), '123456789');
});

test('退格删除末位', () => {
  assert.equal(keypadText(pressKey(type('123'), 'back')), '12');
  assert.equal(keypadText(pressKey(createKeypadState(), 'back')), '');
});

test('清空', () => {
  assert.equal(keypadText(pressKey(type('123.45'), 'clear')), '');
});

test('单字符 0 的金额为 0 而不是 null', () => {
  assert.equal(keypadCents(type('0')), 0);
});

test('pressKey 不修改原状态', () => {
  const s = createKeypadState();
  const s2 = pressKey(s, '5');
  assert.equal(keypadText(s), '');
  assert.equal(keypadText(s2), '5');
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test tests/keypad-model.test.js`
预期：FAIL，报 `Cannot find module '../app/keypad-model.js'`。

- [ ] **步骤 3：实现 `app/keypad-model.js`**

```js
import { parseAmountToCents } from './money.js';

export function createKeypadState() {
  return { text: '' };
}

export function pressKey(state, key) {
  const text = state.text;
  if (key === 'clear') return { text: '' };
  if (key === 'back') return { text: text.slice(0, -1) };
  if (key === '.') {
    if (text.includes('.')) return { text };
    return { text: text === '' ? '0.' : text + '.' };
  }
  if (!/^\d$/.test(key)) return { text };

  const [intPart, decPart] = text.split('.');
  if (decPart !== undefined) {
    if (decPart.length >= 2) return { text };
    return { text: text + key };
  }
  if (intPart === '0') return { text: key };
  if (intPart.length >= 9) return { text };
  return { text: text + key };
}

export function keypadText(state) {
  return state.text;
}

export function keypadCents(state) {
  if (state.text === '' || state.text === '0.') return null;
  return parseAmountToCents(state.text);
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test tests/keypad-model.test.js`
预期：PASS，10 个测试全过。

- [ ] **步骤 5：Commit**

```bash
git add app/keypad-model.js tests/keypad-model.test.js
git commit -m "feat: 数字键盘状态机（小数位、前导零、长度限制）"
```

---

### 任务 10：IndexedDB 封装与种子数据

**文件：**
- 创建：`app/db.js`
- 创建：`app/schema.js`
- 创建：`docs/手动验证清单.md`（追加本节条目）

> Node 里没有 IndexedDB，这一层**不做单测**（规格第 11 节已明确），靠手动清单验证。逻辑一律不写在这里，只做读写。

- [ ] **步骤 1：创建 `app/schema.js`**

```js
export const DB_NAME = 'pvault';
export const DB_VERSION = 1;

export const STORES = {
  txns: { keyPath: 'id', indexes: [['by_occurredAt', 'occurredAt'], ['by_kind', 'kind']] },
  accounts: { keyPath: 'id', indexes: [] },
  categories: { keyPath: 'id', indexes: [['by_kind', 'kind']] },
  receivables: { keyPath: 'id', indexes: [['by_settledAt', 'settledAt']] },
  settings: { keyPath: 'key', indexes: [] }
};

export function applyMigrations(db, oldVersion) {
  for (const [name, def] of Object.entries(STORES)) {
    const store = db.objectStoreNames.contains(name)
      ? null
      : db.createObjectStore(name, { keyPath: def.keyPath });
    if (store) {
      for (const [idxName, keyPath] of def.indexes) {
        store.createIndex(idxName, keyPath);
      }
    }
  }
  return oldVersion;
}

export function seedAccounts() {
  return [
    { id: 'acc-cash', name: '现金', kind: 'cash', icon: '💵', trackBalance: false, archived: false, sort: 1 },
    { id: 'acc-wechat', name: '微信', kind: 'savings', icon: '💚', trackBalance: false, archived: false, sort: 2 },
    { id: 'acc-alipay', name: '支付宝', kind: 'savings', icon: '🅰️', trackBalance: false, archived: false, sort: 3 },
    { id: 'acc-bank', name: '银行卡', kind: 'savings', icon: '🏦', trackBalance: false, archived: false, sort: 4 },
    { id: 'acc-credit', name: '信用卡', kind: 'credit', icon: '💳', trackBalance: true,
      billDay: 5, dueDay: 28, archived: false, sort: 5 }
  ];
}

const EXPENSE = [
  ['cat-food', '餐饮', '🍜'], ['cat-traffic', '交通', '🚇'], ['cat-shop', '购物', '🛍️'],
  ['cat-daily', '日用', '🧴'], ['cat-fun', '娱乐', '🎮'], ['cat-med', '医教', '💊'],
  ['cat-social', '人情', '🎁'], ['cat-home', '居住', '🏠'], ['cat-other', '其他', '📦']
];
const INCOME = [
  ['cat-salary', '工资', '💰'], ['cat-bonus', '奖金', '🎉'], ['cat-refund', '退款', '↩️']
];

export function seedCategories() {
  const out = [];
  EXPENSE.forEach(([id, name, icon], i) => {
    out.push({ id, name, icon, kind: 'expense', archived: false, sort: i + 1 });
  });
  INCOME.forEach(([id, name, icon], i) => {
    out.push({ id, name, icon, kind: 'income', archived: false, sort: i + 1 });
  });
  return out;
}

export function seedSettings() {
  return [
    { key: 'hideAmounts', value: false },
    { key: 'budgetTotalCents', value: 0 },
    { key: 'budgetByCategory', value: {} },
    { key: 'recurring', value: [] },
    { key: 'lastBackupAt', value: null }
  ];
}
```

- [ ] **步骤 2：创建 `app/db.js`**

```js
import { DB_NAME, DB_VERSION, STORES, applyMigrations, seedAccounts, seedCategories, seedSettings } from './schema.js';

let dbPromise = null;

export function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = event => {
      applyMigrations(req.result, event.oldVersion);
    };
    req.onsuccess = async () => {
      const db = req.result;
      try { await ensureSeeded(db); } catch (e) { reject(e); return; }
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function ensureSeeded(db) {
  const count = await new Promise((resolve, reject) => {
    const tx = db.transaction('settings', 'readonly');
    const req = tx.objectStore('settings').count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  if (count > 0) return;
  const tx = db.transaction(['accounts', 'categories', 'settings'], 'readwrite');
  for (const a of seedAccounts()) tx.objectStore('accounts').put(a);
  for (const c of seedCategories()) tx.objectStore('categories').put(c);
  for (const s of seedSettings()) tx.objectStore('settings').put(s);
  await txDone(tx);
}

export async function put(store, value) {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value);
  await txDone(tx);
  return value;
}

export async function get(store, key) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getAll(store) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getByRange(store, indexName, lower, upper) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const range = IDBKeyRange.bound(lower, upper, false, true);
    const req = db.transaction(store, 'readonly').objectStore(store).index(indexName).getAll(range);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function remove(store, key) {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  await txDone(tx);
}
```

- [ ] **步骤 3：在浏览器里手动验证**

运行：`npm run dev`，浏览器打开 `http://localhost:8080`，开发者工具 Console 执行：

```js
const db = await import('./app/db.js');
await db.open();
(await db.getAll('categories')).length   // 期望 12
(await db.getAll('accounts')).length     // 期望 5
```

预期：12 与 5。Application → IndexedDB → pvault 下能看到 `txns / accounts / categories / receivables / settings` 五个仓库。

- [ ] **步骤 4：把验证步骤写入 `docs/手动验证清单.md`**

```markdown
# pvault 手动验证清单

## 数据层
- [ ] 首次打开：IndexedDB 中出现 pvault 库，含 5 个对象仓库
- [ ] 首次打开：分类 12 条、账户 5 条被自动写入
- [ ] 刷新页面后不会重复写入种子数据
- [ ] 删除浏览器站点数据后重新打开，种子数据重新生成且旧交易消失（这是预期行为）
```

- [ ] **步骤 5：Commit**

```bash
git add app/db.js app/schema.js docs/手动验证清单.md
git commit -m "feat: IndexedDB 封装与默认分类/账户种子数据"
```

---

### 任务 11：仓库层 `app/store.js`

**文件：**
- 创建：`app/store.js`
- 修改：`docs/手动验证清单.md`

- [ ] **步骤 1：实现 `app/store.js`**

```js
import * as db from './db.js';
import { monthRange } from './dates.js';

export const uid = () => crypto.randomUUID();

export async function listAccounts() {
  const all = await db.getAll('accounts');
  return all.filter(a => !a.archived).sort((a, b) => a.sort - b.sort);
}

export async function listCategories(kind) {
  const all = await db.getAll('categories');
  return all
    .filter(c => !c.archived && (kind ? c.kind === kind : true))
    .sort((a, b) => a.sort - b.sort);
}

export async function listAllCategories() {
  return (await db.getAll('categories')).sort((a, b) => a.sort - b.sort);
}

export async function addTransaction(input) {
  const now = Date.now();
  const txn = {
    id: uid(),
    kind: input.kind,
    amountCents: input.amountCents,
    categoryId: input.categoryId ?? null,
    accountId: input.accountId ?? null,
    toAccountId: input.toAccountId ?? null,
    occurredAt: input.occurredAt ?? now,
    note: input.note ?? '',
    shares: input.shares ?? [],
    source: input.source ?? 'manual',
    createdAt: now,
    updatedAt: now
  };
  await db.put('txns', txn);
  for (const share of txn.shares) {
    await db.put('receivables', {
      id: uid(),
      personName: share.personName,
      direction: 'owedToMe',
      amountCents: share.amountCents,
      occurredAt: txn.occurredAt,
      dueAt: null,
      settledAt: null,
      note: txn.note,
      sourceTxnId: txn.id
    });
  }
  return txn;
}

export async function updateTransaction(txn) {
  await db.put('txns', { ...txn, updatedAt: Date.now() });
}

export async function deleteTransaction(id) {
  await db.remove('txns', id);
}

export async function listTransactionsInRange(start, end) {
  return db.getByRange('txns', 'by_occurredAt', start, end);
}

export async function listTransactionsInMonths(count, anchorTs = Date.now()) {
  const now = new Date(anchorTs);
  const start = new Date(now.getFullYear(), now.getMonth() - (count - 1), 1).getTime();
  const { end } = monthRange(anchorTs);
  return db.getByRange('txns', 'by_occurredAt', start, end);
}

export async function listReceivables() {
  return db.getAll('receivables');
}

export async function settleReceivable(id) {
  const all = await db.getAll('receivables');
  const target = all.find(r => r.id === id);
  if (!target) return null;
  const next = { ...target, settledAt: Date.now() };
  await db.put('receivables', next);
  return next;
}

export async function getSetting(key, fallback = null) {
  const row = await db.get('settings', key);
  return row ? row.value : fallback;
}

export async function setSetting(key, value) {
  await db.put('settings', { key, value });
  return value;
}

export async function saveAccount(account) {
  const next = { ...account, updatedAt: Date.now() };
  await db.put('accounts', next);
  return next;
}

export async function saveCategory(category) {
  await db.put('categories', category);
  return category;
}
```

- [ ] **步骤 2：在浏览器控制台手动验证**

```js
const s = await import('./app/store.js');
const t = await s.addTransaction({ kind: 'expense', amountCents: 2800, categoryId: 'cat-food', accountId: 'acc-wechat' });
t.id                                    // 有 id
(await s.listTransactionsInMonths(1)).length   // 1
await s.deleteTransaction(t.id);
(await s.listTransactionsInMonths(1)).length   // 0
```

预期依次为：有 id、1、0。

- [ ] **步骤 3：追加手动清单条目**

```markdown
## 仓库层
- [ ] 新增一笔支出后，当月查询能查到，删除后查不到
- [ ] 带分摊的交易会同时生成一条「应收」
- [ ] 转账不计入月度支出统计（用 summary.monthlyTotals 在控制台验证）
- [ ] 设置项读写正常（budgetTotalCents 改完刷新仍在）
```

- [ ] **步骤 4：Commit**

```bash
git add app/store.js docs/手动验证清单.md
git commit -m "feat: 仓库层（交易增删改查、按月查询、设置与应收）"
```

---

### 任务 12：外壳、路由与底部 Tab

**文件：**
- 创建：`app/ui/dom.js`
- 创建：`app/router.js`
- 修改：`app/main.js`
- 创建：`styles/components.css`

- [ ] **步骤 1：实现 `app/ui/dom.js`**

```js
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === 'dataset') {
      Object.assign(node.dataset, v);
    } else {
      node.setAttribute(k, v);
    }
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function mount(parent, ...nodes) {
  clear(parent);
  parent.append(...nodes.flat().filter(Boolean));
  return parent;
}
```

- [ ] **步骤 2：实现 `app/router.js`**

```js
const TABS = [
  { id: 'ledger', label: '记账', icon: '📒' },
  { id: 'stats', label: '统计', icon: '📊' },
  { id: 'vault', label: '密码箱', icon: '🔒' }
];

export function tabs() {
  return TABS;
}

export function currentTab() {
  const raw = location.hash.replace(/^#\/?/, '');
  const id = raw.split('/')[0];
  return TABS.some(t => t.id === id) ? id : 'ledger';
}

export function go(id) {
  location.hash = `#/${id}`;
}

export function onChange(handler) {
  window.addEventListener('hashchange', () => handler(currentTab()));
  handler(currentTab());
}
```

> `vault` 这个 Tab 在计划 2 里实现。**本计划中它先渲染一个「即将推出」的占位页**，不要留空白。

- [ ] **步骤 3：实现 `styles/components.css`**

```css
.tabbar {
  position: fixed; left: 0; right: 0; bottom: 0;
  height: calc(var(--tab-h) + env(safe-area-inset-bottom, 0px));
  padding-bottom: env(safe-area-inset-bottom, 0px);
  display: flex; background: var(--surface);
  border-top: 1px solid var(--border); z-index: 20;
}
.tabbar button {
  flex: 1; border: 0; background: none; color: var(--text-3);
  font: inherit; font-size: 11px; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 2px;
}
.tabbar button[aria-selected="true"] { color: var(--accent); font-weight: 600; }
.tabbar .tab-icon { font-size: 18px; line-height: 1; }

.screen { padding: 16px 16px 24px; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px; }
.muted { color: var(--text-2); }
.tiny { font-size: 12px; }
.row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.stack { display: flex; flex-direction: column; gap: 10px; }
.empty { padding: 40px 16px; text-align: center; color: var(--text-3); }
.btn {
  border: 0; border-radius: 10px; padding: 10px 14px; font: inherit;
  background: var(--surface-2); color: var(--text);
}
.btn-primary { background: var(--accent); color: #fff; font-weight: 600; }
.btn-danger { background: transparent; color: var(--error); }
.bar { height: 6px; border-radius: 3px; background: var(--surface-2); overflow: hidden; }
.bar > i { display: block; height: 100%; border-radius: 3px; }
.bar[data-level="ok"] > i { background: var(--success); }
.bar[data-level="warn"] > i { background: var(--warning); }
.bar[data-level="over"] > i { background: var(--error); }
.fab {
  position: fixed; right: 18px; z-index: 15;
  bottom: calc(var(--tab-h) + env(safe-area-inset-bottom, 0px) + 18px);
  width: 54px; height: 54px; border-radius: 50%; border: 0;
  background: var(--accent); color: #fff; font-size: 26px; line-height: 1;
  box-shadow: 0 6px 18px rgba(0, 0, 0, .22);
}
```

- [ ] **步骤 4：改写 `app/main.js`**

```js
import { el, mount } from './ui/dom.js';
import { tabs, currentTab, go, onChange } from './router.js';
import { renderLedgerHome } from './ui/ledger-home.js';
import { renderStats } from './ui/stats-view.js';

const app = document.getElementById('app');
const view = el('main', { class: 'screen' });

function renderTabBar(active) {
  return el('nav', { class: 'tabbar' }, tabs().map(t =>
    el('button', {
      type: 'button',
      'aria-selected': String(t.id === active),
      onclick: () => go(t.id)
    }, [el('span', { class: 'tab-icon', text: t.icon }), el('span', { text: t.label })])
  ));
}

const PLACEHOLDER = {
  vault: () => el('div', { class: 'empty' }, ['密码箱将在下一步实现'])
};

async function render(id) {
  const renderers = { ledger: renderLedgerHome, stats: renderStats };
  const fn = renderers[id] || PLACEHOLDER[id] || renderers.ledger;
  await fn(view);
  mount(app, view, renderTabBar(id));
}

onChange(render);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
```

> `sw.js` 在任务 20 才创建，本步骤的注册调用会失败并被 `catch` 吞掉，不影响开发。`ledger-home.js` 与 `stats-view.js` 在本任务里先写成**最小实现**（各自只渲染一个标题文字），让三个 Tab 立刻可验证；它们的内容分别在任务 13 与任务 16 替换。

- [ ] **步骤 5：手动验证**

打开 `http://localhost:8080`：底部出现三个 Tab，点击能在三个视图间切换，URL hash 跟着变，刷新后停在同一个 Tab。

- [ ] **步骤 6：Commit**

```bash
git add app/ui/dom.js app/router.js app/main.js styles/components.css app/ui/ledger-home.js app/ui/stats-view.js
git commit -m "feat: 应用外壳（hash 路由 + 底部三个 Tab）"
```

---

### 任务 13：记账首页

**文件：**
- 修改：`app/ui/ledger-home.js`（替换占位实现）
- 创建：`styles/ledger.css`

- [ ] **步骤 1：实现 `app/ui/ledger-home.js`**

结构（自上而下，对应规格 5.1）：

```js
import { el, mount, clear } from './dom.js';
import { formatCents } from '../money.js';
import { monthRange, dayRange, daysLeftInMonth, formatMonthLabel, formatDayLabel } from '../dates.js';
import { monthlyTotals } from '../summary.js';
import { budgetProgress, budgetLevel, dailyAllowance } from '../budget.js';
import { receivableSummary } from '../receivable.js';
import * as store from '../store.js';
import { openEntryPanel } from './entry-panel.js';

export async function renderLedgerHome(root) {
  const now = Date.now();
  const { start, end } = monthRange(now);
  const day = dayRange(now);
  const [monthTxns, allTxnsOfDay, accounts, categories, receivables, budgetTotal, hideAmounts] =
    await Promise.all([
      store.listTransactionsInRange(start, end),
      store.listTransactionsInRange(day.start, day.end),
      store.listAccounts(),
      store.listAllCategories(),
      store.listReceivables(),
      store.getSetting('budgetTotalCents', 0),
      store.getSetting('hideAmounts', false)
    ]);

  const totals = monthlyTotals(monthTxns);
  const ratio = budgetProgress(totals.expense, budgetTotal);
  const level = budgetLevel(ratio);
  const remaining = budgetTotal ? budgetTotal - totals.expense : null;
  const allowance = dailyAllowance(remaining, daysLeftInMonth(now));
  const recv = receivableSummary(receivables);
  const catName = new Map(categories.map(c => [c.id, c]));
  const accName = new Map(accounts.map(a => [a.id, a]));

  const amountClass = hideAmounts ? 'num hide-amount' : 'num';

  mount(root,
    el('div', { class: 'stack' }, [
      // ① 月份 + 隐藏金额
      el('div', { class: 'row' }, [
        el('span', { class: 'muted', text: formatMonthLabel(now) }),
        el('button', {
          class: 'btn', type: 'button', text: hideAmounts ? '👁 显示' : '👁 隐藏',
          onclick: async () => { await store.setSetting('hideAmounts', !hideAmounts); renderLedgerHome(root); }
        })
      ]),
      // ② 本月支出 + 收入结余
      el('div', {}, [
        el('div', { class: 'muted tiny', text: '本月支出' }),
        el('div', { class: amountClass, style: 'font-size:34px;font-weight:600' }, [formatCents(totals.expense, { symbol: true })]),
        el('div', { class: 'muted tiny' }, [
          `收入 ${formatCents(totals.income, { symbol: true })}　结余 ${totals.net >= 0 ? '+' : ''}${formatCents(totals.net, { symbol: true })}`
        ])
      ]),
      // ③ 预算进度
      budgetTotal ? el('div', { class: 'card' }, [
        el('div', { class: 'row tiny' }, [
          el('span', { class: 'muted', text: `本月预算 ${formatCents(budgetTotal, { symbol: true })}` }),
          el('span', { text: `已用 ${Math.round((ratio || 0) * 100)}%` })
        ]),
        el('div', { class: 'bar', dataset: { level }, style: 'margin:6px 0' }, [
          el('i', { style: `width:${Math.min(100, (ratio || 0) * 100)}%` })
        ]),
        el('div', { class: 'muted tiny', text: `还剩 ${formatCents(Math.max(0, remaining), { symbol: true })} · 日均可用 ${formatCents(allowance || 0, { symbol: true })}` })
      ]) : null,
      // 应收小字
      recv.owedToMe > 0 ? el('div', { class: 'muted tiny', text: `应收 ${formatCents(recv.owedToMe, { symbol: true })}` }) : null,
      // ④ 今天的流水
      el('div', { class: 'muted tiny', text: `今天 · ${formatDayLabel(now, now)}` }),
      allTxnsOfDay.length === 0
        ? el('div', { class: 'empty', text: '今天还没有记账' })
        : el('div', { class: 'stack' }, allTxnsOfDay
            .sort((a, b) => b.occurredAt - a.occurredAt)
            .map(t => el('div', { class: 'row' }, [
              el('span', {}, [
                `${catName.get(t.categoryId)?.icon || '📦'} ${catName.get(t.categoryId)?.name || (t.kind === 'transfer' ? '转账' : '未分类')} `,
                el('span', { class: 'muted tiny', text: accName.get(t.accountId)?.name || '' })
              ]),
              el('span', { class: amountClass, text: `${t.kind === 'income' ? '+' : '-'}${formatCents(t.amountCents)}` })
            ])))
    ]),
    el('button', {
      class: 'fab', type: 'button', text: '+',
      'aria-label': '记一笔',
      onclick: () => openEntryPanel({ onSaved: () => renderLedgerHome(root) })
    })
  );
}
```

> 图标用 emoji 直接写在分类数据里（`schema.js` 的种子数据），不引图标库。

- [ ] **步骤 2：补 `styles/ledger.css`（首页部分）**

```css
.ledger-amount { font-size: 34px; font-weight: 600; letter-spacing: -.5px; }
.ledger-txn-row { padding: 10px 0; border-bottom: 1px solid var(--border); }
.ledger-txn-row:last-child { border-bottom: 0; }
```

- [ ] **步骤 3：临时打桩 `entry-panel.js`**

先创建一个只导出空函数的 `openEntryPanel`，让首页能跑起来：

```js
export function openEntryPanel({ onSaved }) {
  console.log('entry panel not implemented yet', onSaved);
}
```

- [ ] **步骤 4：手动验证**

打开页面：看到月份、本月支出大数字、今天的流水；点 👁 后金额变模糊，刷新后保持隐藏；没有预算时预算卡不显示；无交易时显示「今天还没有记账」；点右下 + 在控制台打印提示。

- [ ] **步骤 5：追加手动清单条目**

```markdown
## 记账首页
- [ ] 月份与日期标签正确（今天/昨天/9月20日）
- [ ] 隐藏金额开关生效且刷新后保持
- [ ] 未设预算时不显示预算卡；设了之后显示进度与日均可用
- [ ] 超支时进度条变红，80%~100% 变黄
- [ ] 今天没有交易时显示空状态
```

- [ ] **步骤 6：Commit**

```bash
git add app/ui/ledger-home.js styles/ledger.css app/ui/entry-panel.js docs/手动验证清单.md
git commit -m "feat: 记账首页（月度总额、预算进度、今日流水）"
```

---

### 任务 14：半屏面板与数字键盘组件

**文件：**
- 创建：`app/ui/sheet.js`
- 创建：`app/ui/keypad.js`
- 修改：`styles/components.css`

- [ ] **步骤 1：实现 `app/ui/sheet.js`**

要求：从底部滑出、带遮罩、点遮罩关闭、打开时锁滚动、可指定高度（默认 72vh）。

```js
import { el } from './dom.js';

export function openSheet({ title, body, onClose }) {
  const overlay = el('div', {
    class: 'sheet-overlay',
    onclick: e => { if (e.target === overlay) close(); }
  });
  const panel = el('section', { class: 'sheet' }, [
    el('header', { class: 'sheet-head' }, [
      el('span', { text: title || '' }),
      el('button', { class: 'btn', type: 'button', text: '关闭', onclick: () => close() })
    ]),
    el('div', { class: 'sheet-body' }, [body])
  ]);
  overlay.append(panel);
  document.body.append(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));
  document.body.style.overflow = 'hidden';

  function close() {
    overlay.classList.remove('open');
    document.body.style.overflow = '';
    setTimeout(() => overlay.remove(), 180);
    onClose?.();
  }

  return { close, panel, overlay };
}
```

- [ ] **步骤 2：补 `styles/components.css`（面板样式）**

```css
.sheet-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,.35);
  opacity: 0; transition: opacity .18s ease; z-index: 30;
  display: flex; align-items: flex-end;
}
.sheet-overlay.open { opacity: 1; }
.sheet {
  width: 100%; max-height: 78vh; background: var(--surface);
  border-radius: 16px 16px 0 0; transform: translateY(12px);
  transition: transform .18s ease; display: flex; flex-direction: column;
  padding-bottom: env(safe-area-inset-bottom, 0px);
}
.sheet-overlay.open .sheet { transform: translateY(0); }
.sheet-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid var(--border); }
.sheet-body { padding: 14px 16px 18px; overflow-y: auto; }
```

- [ ] **步骤 3：实现 `app/ui/keypad.js`**

键盘布局：`1 2 3 / 4 5 6 / 7 8 9 / . 0 ⌫`，右下角单独一个「完成」按钮。所有按键走 `keypad-model.js` 的 `pressKey`。

```js
import { el } from './dom.js';
import { createKeypadState, pressKey, keypadText, keypadCents } from '../keypad-model.js';

const KEYS = ['1','2','3','4','5','6','7','8','9','.','0','back'];

export function createKeypad({ onChange }) {
  let state = createKeypadState();
  const display = el('div', { class: 'keypad-display num' });
  const grid = el('div', { class: 'keypad-grid' });

  function emit() {
    display.textContent = keypadText(state) || '0';
    onChange?.({ text: keypadText(state), cents: keypadCents(state) });
  }

  for (const k of KEYS) {
    grid.append(el('button', {
      class: 'keypad-key', type: 'button',
      text: k === 'back' ? '⌫' : k,
      onclick: () => { state = pressKey(state, k); emit(); }
    }));
  }

  function clearAll() { state = pressKey(state, 'clear'); emit(); }
  function setFromCents(cents) {
    state = pressKey(createKeypadState(), 'clear');
    for (const ch of (cents / 100).toFixed(2)) state = pressKey(state, ch);
    emit();
  }

  emit();
  return { node: el('div', { class: 'keypad' }, [display, grid]), clearAll, setFromCents,
           get cents() { return keypadCents(state); } };
}
```

- [ ] **步骤 4：补键盘样式**

```css
.keypad-display { font-size: 30px; font-weight: 600; text-align: right; padding: 4px 6px 10px; }
.keypad-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.keypad-key {
  border: 0; border-radius: 10px; background: var(--surface-2); color: var(--text);
  font: inherit; font-size: 20px; padding: 12px 0;
}
.keypad-key:active { background: var(--accent-weak); }
```

- [ ] **步骤 5：手动验证**

在首页 console 里执行 `const { createKeypad } = await import('./app/ui/keypad.js'); document.body.append(createKeypad({ onChange: console.log }).node)`，依次点击：输入 `1.239` 显示 `1.23`；连点两个小数点只有一个；点 ⌫ 逐位删除；`005` 显示 `5`。

- [ ] **步骤 6：Commit**

```bash
git add app/ui/sheet.js app/ui/keypad.js styles/components.css
git commit -m "feat: 半屏面板与自建数字键盘组件"
```

---

### 任务 15：录入面板

**文件：**
- 修改：`app/ui/entry-panel.js`（替换打桩实现）
- 修改：`styles/ledger.css`

- [ ] **步骤 1：实现 `app/ui/entry-panel.js`**

要点（对应规格 5.2）：

- 顶部三态切换：支出 / 收入 / 转账
- 金额区接 `createKeypad`
- 分类九宫格：支出显示 expense 分类，收入显示 income 分类；转账不显示分类
- 转账时显示「从账户 → 到账户」两个选择器
- 账户默认上次使用的（存到 settings 的 `lastAccountId`）
- 时间默认现在，可点开 `datetime-local` 修改
- 备注输入框
- 「有人分摊」开关：打开后出现「对方姓名 + 金额」一行，可加多行；合计超过金额时禁用完成按钮并提示
- 分类默认值来自 `predictCategory({ hour, txns, categories })`
- 完成后：`store.addTransaction` → 关闭面板 → 回调 `onSaved` → 首页顶部弹出 3 秒可撤销提示

```js
import { el, mount, clear } from './dom.js';
import { openSheet } from './sheet.js';
import { createKeypad } from './keypad.js';
import { predictCategory } from '../predict.js';
import { effectiveExpense } from '../receivable.js';
import { formatCents, addCents } from '../money.js';
import * as store from '../store.js';

export async function openEntryPanel({ onSaved } = {}) {
  const [categories, accounts, txns, lastAccountId] = await Promise.all([
    store.listAllCategories(),
    store.listAccounts(),
    store.listTransactionsInMonths(6),
    store.getSetting('lastAccountId', null)
  ]);

  let kind = 'expense';
  let categoryId = predictCategory({ hour: new Date().getHours(), txns, categories });
  let accountId = accounts.some(a => a.id === lastAccountId) ? lastAccountId : accounts[0]?.id;
  let toAccountId = accounts.find(a => a.id !== accountId)?.id ?? null;
  let occurredAt = Date.now();
  let note = '';
  const shares = [];   // { personName, amountCents }

  const body = el('div', { class: 'stack' });
  const sheet = openSheet({ title: '记一笔', body });

  function refresh() { /* 重新渲染 body 的各区块，绑定最新状态 */ }
  refresh();
}
```

**渲染与提交的必须行为：**

1. `kind` 切换时保留已输入金额与账户，重算分类默认值
2. 九宫格里当前分类高亮；点一下即切换
3. 完成按钮在 `keypad.cents === null` 或（转账时 `toAccountId === accountId`）或（分摊合计 > 金额）时禁用
4. 提交成功后把 `accountId` 写入 `lastAccountId`
5. 撤销提示 3 秒后消失，期间点击「撤销」调用 `store.deleteTransaction(id)`

- [ ] **步骤 2：手动验证（逐条过）**

- [ ] 打开即见金额键盘，不需要点任何东西
- [ ] 中午打开时分类默认高亮「餐饮」（先手动记几笔餐饮再测）
- [ ] 输入金额 → 点完成 → 首页立即出现这一笔，且能核对到账户名
- [ ] 3 秒内点「撤销」→ 该笔消失
- [ ] 切到「转账」→ 出现两个账户选择器，分类消失；目标账户与来源相同时完成按钮禁用
- [ ] 切到「收入」→ 分类换成收入类
- [ ] 勾「有人分摊」→ 填金额超过总额时完成按钮禁用并显示提示
- [ ] 账户默认是上次用的那个（记一笔用信用卡，再打开默认还是信用卡）

- [ ] **步骤 3：追加手动清单条目**

```markdown
## 录入面板
- [ ] 打开录入面板后数字键盘已就位，无需额外点击
- [ ] 分类默认值与当前时段历史一致
- [ ] 分摊合计超过金额时禁止提交
- [ ] 记完 3 秒内可撤销
- [ ] 账户默认上次使用
```

- [ ] **步骤 4：Commit**

```bash
git add app/ui/entry-panel.js styles/ledger.css docs/手动验证清单.md
git commit -m "feat: 录入面板（三态交易、智能分类、分摊、撤销）"
```

---

### 任务 16：统计视图

**文件：**
- 修改：`app/ui/stats-view.js`（替换占位实现）

- [ ] **步骤 1：实现 `app/ui/stats-view.js`**

结构（对应规格 5.3）：

1. 月份切换（左右箭头）+ 环比
2. SVG 环形图：`donutSegments` + `donutPath`；圆心显示本月总额；单项占满 100% 时用 `<circle>` 兜底（`donutPath` 返回 `null`）
3. 图例列表：色块 + 分类名 + 金额 + 百分比；**点一行滚动/高亮到明细**
4. 分类明细列表：金额降序，带占比条
5. 近 6 个月趋势：`lastNMonths` + `trendSeries`，手写 SVG 柱状
6. 应收 / 应付汇总

```js
import { el, mount } from './dom.js';
import { donutSegments, donutPath } from '../chart.js';
import { byCategory, monthlyTotals, compareWithPrev, trendSeries } from '../summary.js';
import { lastNMonths, monthRange, formatMonthLabel } from '../dates.js';
import { formatCents } from '../money.js';
import { receivableSummary } from '../receivable.js';
import * as store from '../store.js';

const PALETTE = ['#0a6ef0', '#ff9f0a', '#34c759', '#ff3b30', '#af52de', '#5ac8fa', '#ffd60a', '#8e8e93'];

export async function renderStats(root) { /* 见下方行为要求 */ }
```

**行为要求：**

- 月份用组件内状态 `anchorTs`，左右箭头 `addMonths(anchorTs, ±1)`，不能切到未来月份之后
- 分类明细为空时显示「本月还没有支出」
- 环比在上一月为 0 时显示「—」而不是无穷大
- 环形图色块循环使用 `PALETTE`
- 所有 SVG 元素用 `document.createElementNS('http://www.w3.org/2000/svg', tag)` 创建（`el()` 只支持 HTML）

- [ ] **步骤 2：手动验证**

- [ ] 环形图各段角度与占比一致，色块与图例颜色对应
- [ ] 只有一个分类时环形图是一个完整圆环（不出现缺口或空白）
- [ ] 点图例某一行能定位到明细中的对应项
- [ ] 环比：上个月有数据时显示 ±%，上月为 0 时显示「—」
- [ ] 趋势柱状图高度比例正确，6 个月标签连续
- [ ] 应收/应付与应收页一致

- [ ] **步骤 3：追加手动清单条目并 Commit**

```bash
git add app/ui/stats-view.js docs/手动验证清单.md
git commit -m "feat: 统计视图（环形占比、分类明细、6 个月趋势）"
```

---

### 任务 17：账户与分类管理

**文件：**
- 创建：`app/ui/accounts-view.js`
- 创建：`app/ui/categories-view.js`
- 修改：`app/ui/stats-view.js`（在统计页底部加两个入口按钮）

- [ ] **步骤 1：实现 `app/ui/accounts-view.js`**

功能：列出账户（含归档项）、新增/编辑（名称、图标 emoji、类型、是否追踪余额、信用卡的账单日与还款日）、归档代替删除（**已有交易的账户不允许真删**，只能归档）。

- [ ] **步骤 2：实现 `app/ui/categories-view.js`**

功能：按支出/收入分组列出分类、新增/编辑（名称、emoji 图标、排序）、归档。同样**不允许删除已有交易引用的分类**。

- [ ] **步骤 3：手动验证**

- [ ] 新增一个账户后，录入面板的账户列表里立刻出现
- [ ] 有交易的账户点删除 → 提示改为归档，归档后不再出现在录入面板
- [ ] 分类改名后，历史交易的分类名同步变化（因为展示时按 id 查名）
- [ ] 信用卡账户能设置账单日与还款日

- [ ] **步骤 4：Commit**

```bash
git add app/ui/accounts-view.js app/ui/categories-view.js app/ui/stats-view.js docs/手动验证清单.md
git commit -m "feat: 账户与分类管理（归档代替删除）"
```

---

### 任务 18：预算设置与固定支出提示

**文件：**
- 创建：`app/ui/settings-view.js`
- 修改：`app/ui/entry-panel.js`（打开时提示当天固定支出）
- 修改：`app/ui/ledger-home.js`（入口按钮）

- [ ] **步骤 1：实现预算设置**

- 月度总预算（数字输入，元为单位，存储为整数分）
- 分类预算：逐分类可设可不设
- 固定支出列表：名称、金额、分类、账户、每月几号、启用开关（存进 settings 的 `recurring`）
- 隐藏金额、锁定超时（后者计划 2 使用，先存着）

- [ ] **步骤 2：固定支出提示**

打开录入面板时，若「今天 = 某条启用的固定支出的 dayOfMonth」且本月尚未记录过同名的固定支出（按 `recurringId` 匹配交易），在面板顶部显示一行「今天该记房租 ¥2,500」，点一下自动填入金额、分类、账户。

- [ ] **步骤 3：手动验证**

- [ ] 设置总预算 5000 后首页进度条出现，颜色随支出变化（<80 绿、80~100 黄、>100 红）
- [ ] 分类预算超支时，统计页该分类置顶并标红
- [ ] 到日子打开录入面板看到固定支出提示，点一下自动填好
- [ ] 已记过本月房租后，提示不再出现

- [ ] **步骤 4：Commit**

```bash
git add app/ui/settings-view.js app/ui/entry-panel.js app/ui/ledger-home.js docs/手动验证清单.md
git commit -m "feat: 预算设置与固定支出提示"
```

---

### 任务 19：应收/应付视图

**文件：**
- 创建：`app/ui/receivable-view.js`
- 修改：`app/ui/ledger-home.js`（应收小字可点击进入）

- [ ] **步骤 1：实现应收明细**

- 分两组：别人欠我 / 我欠别人
- 每条：姓名、金额、日期、来源（借出 / 分摊自某笔）
- 支持「标记已收回 / 已还」，写入 `settledAt`
- 支持手动新增一笔借出/借入

- [ ] **步骤 2：手动验证**

- [ ] 带分摊记账后，应收里出现对应条目且金额正确
- [ ] 标记已收回后，首页应收小字金额减少
- [ ] 删掉来源交易后，应收条目的处理符合预期（**保留**，因为它代表真实债权）

- [ ] **步骤 3：Commit**

```bash
git add app/ui/receivable-view.js app/ui/ledger-home.js docs/手动验证清单.md
git commit -m "feat: 应收与应付明细视图"
```

---

### 任务 20：PWA（清单、Service Worker、角标、快捷方式）

**文件：**
- 创建：`manifest.webmanifest`
- 创建：`sw.js`
- 创建：`icons/icon.svg`
- 修改：`app/main.js`

- [ ] **步骤 1：创建 `manifest.webmanifest`**

```json
{
  "name": "pvault 记账",
  "short_name": "pvault",
  "start_url": "./index.html",
  "scope": "./",
  "display": "standalone",
  "background_color": "#f2f2f5",
  "theme_color": "#0a6ef0",
  "lang": "zh-CN",
  "icons": [
    { "src": "./icons/icon.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "any maskable" }
  ],
  "shortcuts": [
    { "name": "记一笔", "short_name": "记一笔", "url": "./index.html#/ledger?new=1" }
  ]
}
```

- [ ] **步骤 2：创建 `sw.js`**

策略：安装时预缓存静态资源；fetch 时**缓存优先、网络回退**；新版本进入 waiting 时通过 `postMessage` 通知页面，由页面提示用户点「更新」。

```js
const CACHE = 'pvault-v1';
const ASSETS = [
  './', './index.html', './manifest.webmanifest', './icons/icon.svg',
  './styles/base.css', './styles/components.css', './styles/ledger.css',
  './app/main.js', './app/router.js', './app/db.js', './app/schema.js', './app/store.js',
  './app/money.js', './app/dates.js', './app/budget.js', './app/summary.js',
  './app/receivable.js', './app/predict.js', './app/chart.js', './app/keypad-model.js',
  './app/ui/dom.js', './app/ui/sheet.js', './app/ui/keypad.js', './app/ui/ledger-home.js',
  './app/ui/entry-panel.js', './app/ui/stats-view.js', './app/ui/accounts-view.js',
  './app/ui/categories-view.js', './app/ui/settings-view.js', './app/ui/receivable-view.js'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match('./index.html')))
  );
});
```

> **每次改代码都要把 `CACHE` 的版本号 +1（`pvault-v2`…）**，否则手机上永远看到旧版本。

- [ ] **步骤 3：在 `app/main.js` 里加更新提示与角标**

```js
// 更新提示
navigator.serviceWorker?.addEventListener('controllerchange', () => location.reload());

// 桌面图标角标：待办 = 临近还款的信用卡 + 今天该记的固定支出
async function syncBadge() {
  if (!('setAppBadge' in navigator)) return;
  const due = await countDueToday();
  if (due > 0) navigator.setAppBadge(due).catch(() => {});
  else navigator.clearAppBadge?.().catch(() => {});
}
```

`countDueToday()` 实现：读 `recurring`，统计 `dayOfMonth === 今天` 且本月未记录的条数；再统计还款日在 3 天内的信用卡账户数。

- [ ] **步骤 4：入口处理长按快捷方式**

`main.js` 启动时若 `location.hash` 含 `new=1`，直接打开录入面板。

- [ ] **步骤 5：手动验证**

- [ ] Chrome 打开后「添加到主屏幕」，桌面出现图标，点开是全屏无地址栏
- [ ] 长按图标出现「记一笔」快捷方式，点它直接进录入面板
- [ ] 开飞行模式后重新打开，页面仍可使用、能记账
- [ ] 改一次代码并 +1 缓存版本，重开页面看到新版内容
- [ ] 有信用卡临近还款时桌面图标出现数字角标

- [ ] **步骤 6：Commit**

```bash
git add manifest.webmanifest sw.js icons/icon.svg app/main.js docs/手动验证清单.md
git commit -m "feat: PWA（离线缓存、图标角标、记一笔快捷方式）"
```

---

### 任务 21：部署到 GitHub Pages

**文件：**
- 创建：`docs/部署说明.md`
- 创建：`.nojekyll`

- [ ] **步骤 1：创建 `.nojekyll`**

空文件即可。GitHub Pages 默认走 Jekyll，会忽略以下划线开头的文件；放这个文件跳过处理，静态资源更稳。

- [ ] **步骤 2：创建 `docs/部署说明.md`**

写明：

1. 在 GitHub 新建仓库 `pvault`（公开）
2. `git remote add origin https://github.com/Pythonlover211/pvault.git`
3. `git push -u origin main`
4. 仓库 Settings → Pages → Source 选 `Deploy from a branch`，分支 `main`，目录 `/ (root)`
5. 等 1~2 分钟，访问 `https://pythonlover211.github.io/pvault/`
6. **手机上用安卓版 Chrome 或 Edge** 打开该地址 → 菜单 → 添加到主屏幕
7. 之后更新：本地改完 → `git push` → 手机上刷新

- [ ] **步骤 3：本地核对全部测试**

运行：`npm test`
预期：全部 PASS。

- [ ] **步骤 4：Commit**

```bash
git add .nojekyll docs/部署说明.md
git commit -m "chore: GitHub Pages 部署说明与 .nojekyll"
```

---

## 自检记录

**规格覆盖度**（对照 `2026-09-23-pvault-design.md`）

| 规格条目 | 对应任务 |
|---|---|
| 5.1 首页四块 + 应收 + 悬浮加号 + 角标 | 13、20 |
| 5.2 录入面板（自建键盘、智能分类、分摊、撤销） | 14、15 |
| 5.3 统计（环形 + 明细 + 趋势 + 环比 + 超支置顶） | 16 |
| 5.4 密码箱 | **计划 2** |
| 6 数据模型 + 三条关键规则 | 10、11、15、18、19 |
| 7 加密方案 | **计划 2** |
| 8 备份与恢复 | **计划 2** |
| 9 账单导入 | **计划 3** |
| 10 错误处理（IndexedDB 被清、配额、金额非法、转账未选目标） | 10、15；Service Worker 更新提示在 20 |
| 11 测试策略 | 任务 2~9 单测；手动清单贯穿全部 UI 任务 |
| 12 分期 V1 | 计划 1+2+3 合计等于 V1 |
| 13 风险（浏览器兼容） | 20、21 的手动验证条目 |

**类型一致性**：`amountCents` / `occurredAt` / `categoryId` / `accountId` / `toAccountId` / `settledAt` / `direction` 在任务 6、10、11、15、19 中用法一致；`budgetLevel` 的返回值 `'ok' | 'warn' | 'over' | 'none'` 与任务 13、18 中 `data-level` 的取值一致。

**占位符扫描**：全文无「待定 / TODO / 后续实现 / 类似任务 N」，每个代码步骤都带可执行的代码块。

**自检中修掉的两处缺陷**：任务 7 的时段预测测试原本把 19 点的样本误写成 8 点，导致断言与实现不符（实现者会误改实现去迁就测试）；任务 10 的 `ensureSeeded` 里有一行重复写入账户种子。两处均已改为正确版本。
