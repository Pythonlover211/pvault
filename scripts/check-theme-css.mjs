// 外观 CSS 的静态核验脚本（任务 9 的产物，任务 14 负责复核/扩展）。
//
// 为什么需要它：这一块改的是 CSS，而本机（以及后来的开发机）不一定有可用的浏览器——
// 「渲染对不对」只能靠把每一条说法换成可执行的比对。它查的是**文本层的约定**，不是渲染：
//   ① JS 会写进 <html> 的变量 ←→ CSS/JS 里被 var() 消费的变量（两个方向都查）
//   ② 四个背景变量各自有写入者、也有消费者
//   ③ :root 兜底的四个值 === JS 运行值（逐字符）——**这条是必备断言**：
//      `--scrim-a: 0.3` 是 OVERLAY_DEFAULT 在 CSS 里的第二份真相，而仓库里没有任何测试解析
//      base.css 的内容；少了它，将来改了常量而 CSS 没跟着改，漂移是静默的。
//   ④ body::before 的声明集合与必需属性（含 z-index: -1、pointer-events: none，不含
//      background-attachment）
//   ⑤ 规格 §6.2 的 CSS 骨架 ⇄ 实现的逐声明一致
//   ⑦ 计划任务 9 的两个代码块 ⇄ styles/base.css 的对应段逐字符一致
//   ⑧ 计划顶部那条镜像纪律里的两个事实（工作区行尾混杂、git blob 是 LF）
//   ⑩ 规格 §13 的 7 条手动项 ⇄ 任务 15 清单的关键词（粗筛，不是语义对齐的证明）
//   ⑪ 被否掉的旧说法不许回流（注释里的因果只留更正后的版本）
//   ⑫ Markdown 围栏完整性：内容行不许粘反引号串、块内不许出现非法的结束围栏
//      （这条是补的：一个把代码块同步进计划的脚本丢过结尾换行，制造出两处粘连围栏，
//       而 ①②③…那些检查全都看不见它——围栏坏了，块内容却仍然"看起来"是对的）
//   ⑬ sw.js 的 ASSETS 清单集合 ⇄ 它全文里带引号相对路径的集合（两者必须相等）
//      （任务 10 返工补的：计划任务 14 那支「从 sw.js 里数路径」的校验脚本按**全文**匹配、不看上下文，
//       注释里举例写一句带引号的路径就会被算成一条清单条目——实测踩到过：条数 57 → 58，
//       而那支脚本的 Test-Path 全通过，只有数字悄悄变了）
//
// 用法：
//   node scripts/check-theme-css.mjs                 核验（**只读仓库**）
//   node scripts/check-theme-css.mjs --self-test     变异自检（**只写系统临时目录**）
// 参数（都有默认值，默认按脚本自身位置推导，不写死任何绝对路径）：
//   --root <dir> --css <file> --store <file> --theme <file> --plan <file> --spec <file>
//   --sw <file> --styles <dir> --app <dir> --tmp <dir>
//
// 落盘纪律（精确版——早先这里写的是「核验模式一个字节都不写」，那是错的：它一直都往 tmp 落探针）：
//   · **不写仓库**：核验模式不碰 root 下的任何文件；只会往 tmp 里落两个 git blob 探针
//     （`<tmp>/blob-probe/`，用来量提交形态的行尾）。
//   · 自检模式（造变异副本、跑核验子进程）也只在 tmp 里落盘，并且有三道护栏：
//     ① 启动时若 --tmp 落在 --root 里面，**直接拒绝运行**——实测过这条绕过：把 --tmp 指向副本内部，
//        产物就写进了被当作仓库的那份副本，而脚本还自述「仓库一个字节都没写」；
//     ② 所有写操作都走 safeMkdir / safeWrite / safeOpenWrite / safeRm / safeCpDir（不在 tmp 之下、
//        或在 root 之内就当场拒），不再只守着 writeFileSync 一处；
//     ③ 核验子进程**透传 --tmp**，它的探针不会落到父进程 tmp 之外。

import { readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync, existsSync, openSync, closeSync, cpSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const HERE = import.meta.dirname;
const argv = process.argv.slice(2);
function opt(name, fallback) {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? argv[i + 1] : fallback;
}
const SELF_TEST = argv.includes('--self-test');
// 默认 root = 脚本的上一级；也可以显式 --root 覆盖。绝不"默默指向"某一个 checkout。
const ROOT = path.resolve(opt('root', path.join(HERE, '..')));
const CSS_PATH = path.resolve(opt('css', path.join(ROOT, 'styles/base.css')));
const STORE_PATH = path.resolve(opt('store', path.join(ROOT, 'app/theme-store.js')));
const THEME_PATH = path.resolve(opt('theme', path.join(ROOT, 'app/theme.js')));
const PLAN_PATH = path.resolve(opt('plan', path.join(ROOT, 'docs/superpowers/plans/2026-09-26-pvault-custom-background.md')));
const SPEC_PATH = path.resolve(opt('spec', path.join(ROOT, 'docs/superpowers/specs/2026-09-26-pvault-custom-background-design.md')));
const SW_PATH = path.resolve(opt('sw', path.join(ROOT, 'sw.js')));
const STYLES_DIR = path.resolve(opt('styles', path.join(ROOT, 'styles')));
const APP_DIR = path.resolve(opt('app', path.join(ROOT, 'app')));
const MANUAL_PATH = path.resolve(opt('manual', path.join(ROOT, 'docs/手动验证清单.md')));
// TMP_ROOT 惰性求值：`opt('tmp', <fallback>)` 的 fallback **总会被求值**，写成一个 mkdtemp 调用
// 就等于「即使传了 --tmp，也先泄漏一个空目录」（实测踩到过）。所以先看有没有传。
const TMP_ARG = opt('tmp', null);
const TMP_ROOT = path.resolve(TMP_ARG ?? (SELF_TEST ? mkdtempSync(path.join(os.tmpdir(), 'pvault-check-')) : os.tmpdir()));

// 护栏：tmp 不能落在 root 里面。--root 常被指向一份副本（自检、演练），这时若 --tmp 也指进那份
// 副本（哪怕只是手滑写成 <副本>/tmp），产物就会写进"仓库"里，而脚本还会自述「仓库一个字节都没写」。
// 实测过这条绕过：`--self-test --root <副本> --tmp <副本>/tmp-selftest` → exit=0、16/16 全绿、
// 产物落在副本里。所以这里**启动即拒**，不是等到写的时候才拦。
const inRoot = p => {
  const a = path.resolve(p);
  return a === ROOT || a.startsWith(ROOT + path.sep);
};
if (inRoot(TMP_ROOT)) {
  console.error(`✗ 拒绝运行：--tmp（${TMP_ROOT}）在 --root（${ROOT}）里面。\n`
    + '  自检会往 tmp 里造变异副本与 git blob 探针，落在 root 里就等于把产物写进"仓库"。\n'
    + '  换一个 tmp 目录，或者干脆不传 --tmp（默认走系统临时目录，自检时会建一个 mkdtemp）。');
  process.exit(3);
}

// ── 写护栏：**所有**写操作都要落在 TMP_ROOT 之下、且不在 ROOT 之内 ──
// 早先只有 write() 包装里有检查，而 mkdirSync / openSync（blob 探针、变异副本、子进程输出）都绕过
// 它；而且 under() 只判「在 tmp 之下」，tmp 一旦被传成 root 内的路径就放行。两道判据都要有：
// 启动时那条「tmp 不在 root 内」是最强的一道，这里是兜底（写操作再多也不会漏）。
function assertWritable(p) {
  const a = path.resolve(p);
  if (!(a === TMP_ROOT || a.startsWith(TMP_ROOT + path.sep))) {
    console.error(`✗ 拒绝写入：${a} 不在 --tmp（${TMP_ROOT}）之下`);
    process.exit(3);
  }
  if (inRoot(a)) {
    console.error(`✗ 拒绝写入：${a} 在 --root（${ROOT}）之内`);
    process.exit(3);
  }
  return a;
}
const safeMkdir = dir => { assertWritable(dir); mkdirSync(dir, { recursive: true }); return dir; };
const safeWrite = (p, content) => writeFileSync(assertWritable(p), content);
const safeOpenWrite = p => openSync(assertWritable(p), 'w');
const safeRm = dir => { assertWritable(dir); rmSync(dir, { recursive: true, force: true }); };
const safeCpDir = (src, dest) => { assertWritable(dest); cpSync(src, dest, { recursive: true }); };

// ── 工具 ───────────────────────────────────────────────────
const readOrDie = (p, what) => {
  try { return readFileSync(p, 'utf8').replace(/\r\n/g, '\n'); }
  catch {
    console.error(`✗ 读不到 ${what}：${p}\n  --root 是否指对了？这个脚本需要 root 下有 styles/、app/、docs/ 以及那两份 markdown。`);
    process.exit(3);
  }
};
const read = p => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const stripCssComments = s => s.replace(/\/\*[\s\S]*?\*\//g, ' ');

// 逐字符扫描剥 JS 注释：字符串里的 "//" 不能当注释（否则会静默吃掉真代码）。
function stripJsComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const q = c; out += c; i++;
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] ?? ''); i += 2; continue; }
        out += src[i];
        const done = src[i] === q;
        i++;
        if (done) break;
      }
      continue;
    }
    out += c; i++;
  }
  return out;
}

// Markdown 围栏扫描（反引号与波浪号两种都认——CommonMark 里 `~~~` 同样是合法围栏；
// 早先只认反引号，而描述写的是「Markdown 围栏完整性」，实测追加一段未闭合的 `~~~` 是全绿的）。
// 规则：开/闭围栏都独占一行（≤3 空格缩进）；结束围栏必须与开围栏**同种字符**且不短于它。
// 边界（如实写明）：不认 4 空格缩进的伪围栏（那是缩进式代码块，不是围栏），也不做语言标记校验。
// 注意：**不 export**。早先 export 过它，但本文件是 CLI 脚本——`import` 它会把整条核验流程连同
// process.exit 一起跑起来，那个 export 是误导（「可以复用」的信号配上「一 import 就执行」的行为）。
// 将来真要复用围栏扫描，把它抽成一个独立小模块再 import，别从这里拿。
function scanFences(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const problems = [];
  let open = null;
  let pairs = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const n = i + 1;
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (m) {
      const ch = m[1][0];
      const len = m[1].length;
      if (open === null) {
        open = { ch, len, line: n };
      } else {
        const body = line.replace(/^ {0,3}/, '');
        const isClose = body.length >= open.len && [...body].every(c => c === open.ch);
        if (isClose) { open = null; pairs++; }
        else problems.push(`第 ${n} 行：块内出现了以 ${open.ch} 开头的行，但不是合法的结束围栏（结束围栏必须独占一行、同种字符、不短于开围栏）：${JSON.stringify(line.slice(0, 60))}`);
      }
      continue;
    }
    const indent = /^ */.exec(line)[0].length;
    if (line.includes('```') || line.includes('~~~')) {
      problems.push(indent >= 4
        ? `第 ${n} 行：缩进 ≥4 空格的行里有反引号/波浪线串——那是缩进式代码块（本检查不查它）；若本意是围栏，去掉缩进让它独占一行：${JSON.stringify(line.slice(0, 60))}`
        : `第 ${n} 行：内容行粘了反引号/波浪线串（围栏必须在独立一行上）：${JSON.stringify(line.slice(0, 60))}`);
    }
  }
  if (open !== null) problems.push(`文件结尾仍有未闭合的围栏（第 ${open.line} 行开的那一个，${open.ch}×${open.len}）`);
  return { pairs, problems };
}

const failures = [];
const report = [];
const groupCounts = new Map();
let total = 0;
const groupOf = msg => {
  if (msg.startsWith('自检：')) return '自检';
  const m = /^([①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬])/.exec(msg);
  return m ? m[1] : '其他';
};
function check(ok, msg) {
  total++;
  const g = groupOf(msg);
  groupCounts.set(g, (groupCounts.get(g) ?? 0) + 1);
  if (!ok) failures.push(msg);
  return ok;
}
function say(line) { report.push(line); }
// 「没跑到」和「跑到了且通过」必须能区分：早先 ⑧ 拿不到 git 时既不 check、也不失败，
// 总数从 59 悄悄变成 58，退出码还是 0（实测过）。现在登记下来，末尾单独报。
const unverified = [];
function unverifiedNote(what) { unverified.push(what); }

// ── 收集 ───────────────────────────────────────────────────
// --css / --store 指向的（可能被变异过的）那一份必须覆盖掉「扫目录」的结果：否则变异只改了
// 参数指的文件、而比对读的还是仓库里的原件——变异被静默忽略，打出来的绿是假的（实测踩到过）。
const OVERRIDE = new Map([
  [CSS_PATH, readOrDie(CSS_PATH, 'styles/base.css')],
  [STORE_PATH, readOrDie(STORE_PATH, 'app/theme-store.js')]
]);
// 按 basename 兜一层：自检时变异副本在临时目录里（路径对不上、文件名同名）。
const load = p => {
  const exact = OVERRIDE.get(path.resolve(p));
  if (exact !== undefined) return exact;
  const name = path.basename(p);
  for (const [kp, kv] of OVERRIDE) if (path.basename(kp) === name) return kv;
  return read(p);
};

function listDir(dir, what) {
  try { return readdirSync(dir, { withFileTypes: true }); }
  catch {
    console.error(`✗ 读不到目录${what}：${dir}\n  --root 是否指对了？这个脚本需要 root 下有 styles/ 与 app/。`);
    process.exit(3);
  }
}
const cssFiles = listDir(STYLES_DIR, '（styles/）').filter(e => e.isFile() && e.name.endsWith('.css')).map(e => e.name).sort();
const cssText = cssFiles.map(f => stripCssComments(load(path.join(STYLES_DIR, f)))).join('\n');
const appFiles = [];
(function walk(dir) {
  for (const e of listDir(dir, '（app/ 递归）')) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) appFiles.push(p);
  }
})(APP_DIR);
const appText = appFiles.map(f => stripJsComments(load(f))).join('\n');
const storeSrc = stripJsComments(load(STORE_PATH));

const varNames = text => [...new Set([...text.matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)/g)].map(m => m[1]))];
const C_css = varNames(cssText);
const C_js = varNames(appText);
const D_css = [...new Set([...cssText.matchAll(/^\s*(--[a-zA-Z0-9_-]+)\s*:/gm)].map(m => m[1]))];
const W_literal = [...new Set([...appText.matchAll(/\.setProperty\(\s*['"](--[a-zA-Z0-9_-]+)['"]/g)].map(m => m[1]))];

let theme;
try {
  theme = await import(pathToFileURL(THEME_PATH).href);
} catch {
  console.error(`✗ 读不到 app/theme.js：${THEME_PATH}\n  --root 是否指对了？`);
  process.exit(3);
}
const W_palette = new Set();
for (const id of theme.THEME_IDS) for (const mode of ['light', 'dark']) {
  for (const k of Object.keys(theme.themeCssVars(id, mode, { photo: false }))) W_palette.add(k);
  for (const k of Object.keys(theme.themeCssVars(id, mode, { photo: true }))) W_palette.add(k);
}
const W_js = new Set([...W_palette, ...W_literal]);
const written = new Set([...W_js, ...D_css]);

const cssSrc = load(CSS_PATH);
const specText = read(SPEC_PATH);
const planText = read(PLAN_PATH);

say(`root: ${ROOT}`);
say('W_js（JS 会写进 <html> 的变量）: ' + [...W_js].sort().join(' '));
say('  · 其中来自 setProperty 字面量的: ' + [...W_literal].sort().join(' '));
say('C_css（CSS 里 var() 消费的）: ' + C_css.sort().join(' '));
say('C_js（JS 值里 var() 引用的）: ' + C_js.sort().join(' '));
say(`D_css（CSS 里定义过的）共 ${D_css.length} 个`);

// 自检：参数指的那份真的在扫描集合里，否则上下游比对读的是别的文件（变异被静默忽略）。
check(cssFiles.some(f => path.basename(f) === path.basename(CSS_PATH)),
  '自检：--css 的文件名在 styles/ 里找不到同名的，覆盖不会发生（① 的比对读的是别的文件）');
check(appFiles.some(f => path.basename(f) === path.basename(STORE_PATH)),
  '自检：--store 的文件名在 app/ 里找不到同名的，覆盖不会发生（① 的比对读的是别的文件）');

// ── ① 两个方向 ──────────────────────────────────────────────
const ghostCss = C_css.filter(v => !written.has(v));
check(ghostCss.length === 0, '① CSS 里消费了但没有任何人写的变量：' + ghostCss.join(' '));
const ghostJs = C_js.filter(v => !written.has(v));
check(ghostJs.length === 0, '① JS 表达式里引用了但没有任何人写的变量：' + ghostJs.join(' '));
say('① 方向「用了没人写」：CSS ' + ghostCss.length + ' 个、JS ' + ghostJs.length + ' 个（应为 0）');
const unused = [...W_js].filter(v => !C_css.includes(v) && !C_js.includes(v)).sort();
say('① 方向「写了没人用」（只报告，不判失败）: ' + (unused.length ? unused.join(' ') : '（无）'));

// ── ② 背景四兄弟闭合 ────────────────────────────────────────
const BG4 = ['--bg-image', '--bg-scrim', '--scrim-a', '--scrim-rgb'];
for (const v of BG4) {
  check(W_js.has(v), '② ' + v + ' 没有任何 JS 写入者');
  check(C_css.includes(v) || C_js.includes(v), '② ' + v + ' 没有任何消费者');
}
const consumers = v => [C_css.includes(v) ? 'CSS' : null, C_js.includes(v) ? 'JS 值' : null].filter(Boolean).join(' + ') || '（无）';
say('② 背景四兄弟的消费者：' + BG4.map(v => v + '=' + consumers(v)).join('、'));
check(C_js.includes('--scrim-rgb') && C_js.includes('--scrim-a'),
  '② --scrim-rgb / --scrim-a 的消费点应当只在 JS 写的那条表达式里（base.css 的注释就是这么说的）');

// ── ③ 兜底值 ⇄ JS 运行值（必备断言） ────────────────────────
const plain = stripCssComments(cssSrc);
const rootBlock = /:root\s*\{([^}]*)\}/.exec(plain)?.[1];
check(!!rootBlock, '③ 没在 base.css 里找到 :root 声明块（锚点失效，下面的比对全是空转）');
const declOf = (block, name) => {
  const m = new RegExp('(?:^|;)\\s*' + name.replace(/-/g, '\\-') + '\\s*:\\s*([^;]+)').exec(block ?? '');
  return m ? m[1].trim() : null;
};
const lightVars = theme.themeCssVars('default', 'light');
const expectFallback = {
  '--bg-image': 'none',
  '--bg-scrim': 'none',
  '--scrim-rgb': lightVars['--scrim-rgb'],
  '--scrim-a': String(theme.scrimAlpha(theme.OVERLAY_DEFAULT))
};
for (const [name, want] of Object.entries(expectFallback)) {
  const got = declOf(rootBlock, name);
  check(got === want, `③ ${name} 的 :root 兜底值是 ${JSON.stringify(got)}，JS 侧那份是 ${JSON.stringify(want)}`);
}
say('③ 兜底值 ⇄ JS：' + Object.entries(expectFallback).map(([k, v]) => k + '=' + v).join('、'));
check(/'--bg-image',\s*'none'/.test(storeSrc), '③ theme-store.js 里没有把 --bg-image 显式写成 none 的那一行（兜底值就失去对照物）');
check(/'--bg-scrim',\s*'none'/.test(storeSrc), '③ theme-store.js 里没有把 --bg-scrim 显式写成 none 的那一行');

const darkBlock = /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(plain)?.[1];
check(!!darkBlock, '③ 没找到 @media 深色块（锚点失效）');
check(!!darkBlock && declOf(darkBlock, '--scrim-rgb') === null,
  '③ @media 深色块里补了 --scrim-rgb——base.css 的注释说「不补」，注释要跟着改');

// ── ④ body::before 的声明 ───────────────────────────────────
const beforeBlock = /body::before\s*\{([^}]*)\}/.exec(plain)?.[1];
check(!!beforeBlock, '④ 没找到 body::before 规则（锚点失效）');
const want4 = {
  content: "''",
  position: 'fixed',
  inset: '0',
  'z-index': '-1',
  'background-image': 'var(--bg-scrim), var(--bg-image)',
  'background-size': 'cover',
  'background-position': 'center',
  'background-repeat': 'no-repeat',
  'pointer-events': 'none'
};
const parseDecls = block => {
  const out = {};
  for (const d of (block ?? '').split(';')) {
    const t = d.trim();
    if (!t) continue;
    const i = t.indexOf(':');
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/\s+/g, ' ');
  }
  return out;
};
const got4 = parseDecls(beforeBlock);
for (const [k, v] of Object.entries(want4)) {
  check(got4[k] === v, `④ body::before 的 ${k} 是 ${JSON.stringify(got4[k] ?? null)}，期望 ${JSON.stringify(v)}`);
}
const extraDecls = Object.keys(got4).filter(k => !(k in want4));
check(extraDecls.length === 0, '④ body::before 里有计划外的声明：' + extraDecls.join(' '));
check(!('background-attachment' in got4), '④ body::before 里出现了 background-attachment（规格 §6.2 明确不用它）');
say('④ body::before 声明：' + Object.entries(got4).map(([k, v]) => k + ':' + v).join('; '));

const occurrences = (cssText.match(/body::before/g) ?? []).length;
check(occurrences === 1, `⑥ styles/ 里 body::before 出现 ${occurrences} 次（期望 1 次）`);

// ── ⑤ 规格 §6.2 ⇄ 实现 ─────────────────────────────────────
const s62At = specText.indexOf('### 6.2 渲染');
check(s62At >= 0, '⑤ 规格里没找到「### 6.2 渲染」（锚点失效）');
const specBlock = /```css\n([\s\S]*?)```/.exec(specText.slice(s62At))?.[1];
check(!!specBlock, '⑤ 规格 §6.2 里没找到 css 代码块（锚点失效）');
const specBefore = /body::before\s*\{([^}]*)\}/.exec(stripCssComments(specBlock ?? ''))?.[1];
check(!!specBefore, '⑤ 规格 §6.2 的代码块里没有 body::before 规则（锚点失效）');
const specDecls = parseDecls(specBefore);
check(JSON.stringify(specDecls) === JSON.stringify(got4),
  '⑤ 规格 §6.2 的 body::before 与实现逐声明不同：\n     规格 ' + JSON.stringify(specDecls) + '\n     实现 ' + JSON.stringify(got4));
say('⑤ 规格 §6.2 ⇄ 实现：' + Object.keys(specDecls).length + ' 条声明逐条一致');

// ── ⑦ 计划任务 9 的两个代码块 ⇄ base.css ────────────────────
const t9At = planText.indexOf('## 任务 9：');
const t10At = planText.indexOf('## 任务 10：');
check(t9At >= 0 && t10At > t9At, '⑦ 计划里没找到任务 9 与任务 10 的标题（锚点失效）');
const t9 = planText.slice(t9At, t10At);
const blocks = [...t9.matchAll(/```css\n([\s\S]*?)```/g)].map(m => m[1]);
check(blocks.length === 2, `⑦ 计划任务 9 里的 css 代码块有 ${blocks.length} 个（期望 2 个）`);
// 值不锚死：--scrim-a 的数值改掉之后，这里要报「与 base.css 不一致」（诊断正确），
// 而不是报「锚点失效」（会把人引到错的地方；真因由 ③ 报出）。
// 缩进是 2 空格（那四行声明在 :root 块里），注释才是 5 空格——写错过一次，锚点直接失效。
const seg1 = /(  \/\* 背景照片相关[\s\S]*?\n  --scrim-a:[^;]*;)/.exec(cssSrc)?.[1];
const seg2 = /(\/\* 背景照片层。[\s\S]*?pointer-events: none;\n\})/.exec(cssSrc)?.[1];
check(!!seg1, '⑦ 没在 base.css 里定位到 :root 兜底那一段（锚点失效）');
check(!!seg2, '⑦ 没在 base.css 里定位到 body::before 那一段（锚点失效）');
for (const [i, seg] of [[0, seg1], [1, seg2]]) {
  if (!seg || !blocks[i]) continue;
  const same = seg.replace(/\s+$/, '') === blocks[i].replace(/\s+$/, '');
  check(same, `⑦ 计划任务 9 步骤 ${i + 1} 的代码块与 base.css 的对应段不是逐字符一致（按 \n 归一化后比）`);
  say(`⑦ 计划步骤 ${i + 1} 代码块 ⇄ base.css：` + (same ? '逐字符一致' : '不一致'));
}

// ── ⑧ 镜像纪律里的事实（行尾混合 / 提交形态是 LF） ──────────
const eolKind = p => {
  const s = readFileSync(p, 'utf8');
  const crlf = (s.match(/\r\n/g) ?? []).length;
  const lf = (s.match(/(?<!\r)\n/g) ?? []).length;
  return crlf && lf ? 'mixed' : crlf ? 'CRLF' : 'LF';
};
const baseKind = eolKind(path.join(ROOT, 'styles/base.css'));
const invKind = eolKind(path.join(ROOT, 'styles/invoice.css'));
check(baseKind !== invKind,
  `⑧ 计划里的行尾纪律写着「同一个目录里行尾都可能不同」，实测 base.css=${baseKind}、invoice.css=${invKind}——两边一样了，那句话要跟着改`);
const BLOBDIR = path.join(TMP_ROOT, 'blob-probe');
safeMkdir(BLOBDIR);
function blobEol(rel) {
  const f = path.join(BLOBDIR, rel.replace(/[^\w.]/g, '_'));
  const fd = safeOpenWrite(f);
  const r = spawnSync('git', ['cat-file', 'blob', 'HEAD:' + rel], { cwd: ROOT, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  if (typeof r.status !== 'number' || r.status !== 0) return '拿不到 git（未验证）';
  return eolKind(f);
}
const blobBase = blobEol('styles/base.css');
const blobPlan = blobEol('docs/superpowers/plans/2026-09-26-pvault-custom-background.md');
if (blobBase === '拿不到 git（未验证）' || blobPlan === '拿不到 git（未验证）') {
  unverifiedNote('⑧ git blob 的行尾形态（这里拿不到 git；非 git 环境里这条会退化成不检查）');
  say('⑧ git blob 形态：拿不到 git —— **未验证**（已记入末尾的「未验证项」，总数会跟着少）');
} else {
  check(blobBase === 'LF' && blobPlan === 'LF',
    `⑧ 计划里写着「版本库里一律是 LF」，实测 blob 形态 base.css=${blobBase}、计划=${blobPlan}——不成立就改那句话`);
}
say('⑧ 行尾实测：工作区 base.css=' + baseKind + '、invoice.css=' + invKind
  + '；git blob（HEAD）base.css=' + blobBase + '、计划=' + blobPlan);

// ── ⑩ 任务 15 的清单与规格 §13 的 7 条对齐 ──────────────────
const s13At = specText.indexOf('## 13. 手动验证清单新增项');
const spec13 = s13At >= 0 ? specText.slice(s13At) : '';
const spec13Items = (spec13.match(/^- \[ \]/gm) ?? []).length;
check(spec13Items === 7, `⑩ 规格 §13 的手动项实测 ${spec13Items} 条，期望 7 条（对不齐时下面的关键词比对也要跟着改）`);
const t15 = planText.slice(planText.indexOf('## 任务 15：'));
const planBox = /```markdown\n([\s\S]*?)```/.exec(t15)?.[1] ?? '';
check(planBox !== '', '⑩ 没在任务 15 里找到 markdown 清单块（锚点失效）');
// 关键词只是「这一条还在不在」的粗筛：它证明不了语义对齐，强度如实写在报告里。
// 选词必须**在该清单里唯一**——第一版用了「深色」，而「皮肤与深浅」那一节里也有「深色下各看一眼」，
// 于是删掉「深色 + 照片 + 遮罩 0%」那一条时它照样命中（实测踩到过，是假绿）。
const keys13 = ['竖拍', '0%', '深色 + 照片 + 遮罩 0%', '密码正文', 'v1.2.0', '体积增幅', '备份里那张图'];
const miss13 = keys13.filter(k => !planBox.includes(k));
check(miss13.length === 0, '⑩ 规格 §13 的 7 条在任务 15 的清单里找不到对应关键词：' + miss13.join(' '));
say('⑩ 规格 §13 的 7 条 → 任务 15 清单关键词命中 ' + (keys13.length - miss13.length) + '/7（粗筛，非语义对齐证明）');

// ── ⑪ 被否掉的旧说法不许回流 ────────────────────────────────
// 锚点失效时这里必须跳过而不是崩：否则脚本自己会抛异常，把「断言没跑到」伪装成一次失败。
if (seg1) {
  check(!seg1.includes('与 --bg 的兜底同一个道理'),
    '⑪ base.css 的 :root 注释里又出现了被否掉的类比「与 --bg 的兜底同一个道理」（--bg 在 @media 里是补了深色档的）');
  check(seg1.includes('与 --bg **不同**'), '⑪ base.css 的 :root 注释里应当保留「与 --bg **不同**」这条更正');
  check(seg1.includes('照片裸奔'),
    '⑪ base.css 的 :root 注释里那条权衡不见了（兜底把「只写 --bg-image、漏写 --bg-scrim」从显眼的失败'
    + '换成隐蔽的失败）——它是保留这两行兜底的前提之一，不能删成一句「以防万一」');
  check(seg1.includes('第二份真相'),
    '⑪ base.css 的 :root 注释里应当保留「--scrim-a 的 0.3 是 OVERLAY_DEFAULT 的第二份真相」这句');
} else {
  say('⑪ base.css 的 :root 兜底段锚点没匹配到：四条注释断言没执行（⑦ 已经报过锚点失效）');
}
if (seg2) {
  check(!seg2.includes('把所有的点击都吃掉'),
    '⑪ body::before 的注释里又出现了被否掉的因果「不关掉命中测试就会把所有的点击都吃掉」');
  check(seg2.includes('命中测试'), '⑪ body::before 的注释里应当保留命中测试的解释（结论：写 pointer-events: none）');
} else {
  say('⑪ body::before 段锚点没匹配到：两条注释断言没执行（⑦ 已经报过锚点失效）');
}

// ── ⑫ Markdown 围栏完整性 ───────────────────────────────────
// 用 PLAN_PATH / SPEC_PATH / MANUAL_PATH 这三个（可被参数覆盖）的路径，不要拿 ROOT 拼——
// 否则自检时变异副本不会被读到，这条断言在变异下永远是绿的（实测踩到过）。
for (const p of [PLAN_PATH, SPEC_PATH, MANUAL_PATH]) {
  if (!existsSync(p)) { check(false, `⑫ ${p} 不存在（锚点失效）`); continue; }
  const r = scanFences(readFileSync(p, 'utf8'));
  check(r.problems.length === 0,
    `⑫ ${path.basename(p)} 的 Markdown 围栏有 ${r.problems.length} 处畸形：\n     ` + r.problems.join('\n     '));
  say(`⑫ ${path.basename(p)}：合法围栏对 ${r.pairs}、畸形 ${r.problems.length}`);
}

// ── ⑬ sw.js 的清单与「全文带引号路径」的集合一致 ──────────────
// 为什么需要：计划任务 14 步骤 2 那支「把 sw.js 里的 './…' 逐条 Test-Path」的校验脚本按**全文**匹配、
// 不看上下文——注释里（或别处代码里）多一句带引号的路径就被算成一条清单条目。实测踩到过：注释里举例
// 写了一条路径，那支脚本报出来的条数直接 +1（57 → 58），而 Test-Path 全通过、只有数字变了。
// 那支脚本守的是「清单里的路径都存在」，这条守的是反方向：**全文里的带引号路径不许有清单外的**。
// 两边合起来，那个条数才是可信的（它同时是测试 tests/boot-order.test.js 里的一条断言的两个入口）。
const swSrc = read(SW_PATH);
const assetsBlock = /const ASSETS = \[([\s\S]*?)\];/.exec(swSrc)?.[1];
check(!!assetsBlock, '⑬ 没在 sw.js 里找到 ASSETS 数组（锚点失效）');
const listed = new Set([...(assetsBlock ?? '').matchAll(/'([^']+)'/g)].map(m => m[1]));
const quotedPaths = new Set([...swSrc.matchAll(/'(\.[^']*)'/g)].map(m => m[1]));
check(listed.size > 0, '⑬ ASSETS 里一条路径都没解析出来（锚点失效）');
const outsideAssets = [...quotedPaths].filter(p => !listed.has(p)).sort();
check(outsideAssets.length === 0,
  '⑬ sw.js 里出现了不在 ASSETS 清单里的带引号相对路径（数路径的校验脚本会把它当成清单条目）：' + outsideAssets.join(' '));
say(`⑬ sw.js：ASSETS ${listed.size} 条、全文带引号路径 ${quotedPaths.size} 个，清单外的 ${outsideAssets.length} 个（应为 0）`);

// ── 输出 ────────────────────────────────────────────────────
if (!SELF_TEST) {
  console.log('任务 9 静态核验（文本层；渲染层结论不在这里，见计划任务 15）');
  console.log(report.join('\n'));
  const order = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫', '⑬', '自检', '其他'];
  console.log('\n分组计数（可复现的口径：脚本每次运行都会打印这张表）：');
  console.log('  ' + order.filter(g => groupCounts.has(g)).map(g => `${g} ${groupCounts.get(g)} 条`).join('、')
    + `　合计 ${total} 条`);
  if (failures.length) {
    console.log(`\n失败 ${failures.length} 项：`);
    for (const f of failures) console.log('  ✗ ' + f);
    process.exit(1);
  }
  if (unverified.length) {
    // 「没跑到」必须与「跑到了且通过」区分开：这里打印出来，总数也跟着说明。
    console.log(`\n⚠ 有 ${unverified.length} 项**未验证**（不是失败，但也不是通过，总数会因此比平常少）：`);
    for (const u of unverified) console.log('  ? ' + u);
    console.log(`\n通过（共 ${total} 项检查；另有 ${unverified.length} 项未验证）`);
  } else {
    console.log(`\n全部通过（共 ${total} 项检查）`);
  }
}

// ── 自检模式：造变异，确认每条断言真的会红 ──────────────────
if (SELF_TEST) {
  // 自检的所有落盘都走 safeXxx（见文件开头的写护栏），不再自己写一个只管 writeFileSync 的包装。
  const write = (p, content) => safeWrite(p, content);
  const cases = [
    { name: 'M1 把 var(--bg-image) 写成 var(--bg-imag)', file: CSS_PATH, flag: '--css', find: 'background-image: var(--bg-scrim), var(--bg-image);', repl: 'background-image: var(--bg-scrim), var(--bg-imag);', expect: ['① CSS 里消费了但没有任何人写的变量：--bg-imag', '② --bg-image 没有任何消费者'] },
    { name: 'M2 兜底 --scrim-rgb 加回空格', file: CSS_PATH, flag: '--css', find: '  --scrim-rgb: 255,255,255;', repl: '  --scrim-rgb: 255, 255, 255;', expect: ['③ --scrim-rgb 的 :root 兜底值是 "255, 255, 255"', '⑦ 计划任务 9 步骤 1 的代码块'] },
    { name: 'M3 删掉 body::before 的 pointer-events', file: CSS_PATH, flag: '--css', find: '  pointer-events: none;\n}', repl: '}', expect: ['④ body::before 的 pointer-events 是 null'] },
    { name: 'M4 把 z-index 从 -1 改成 0', file: CSS_PATH, flag: '--css', find: '  z-index: -1;', repl: '  z-index: 0;', expect: ['④ body::before 的 z-index 是 "0"', '⑤ 规格 §6.2 的 body::before 与实现逐声明不同'] },
    { name: 'M5 规格 §6.2 的 background-repeat 改成 repeat', file: SPEC_PATH, flag: '--spec', find: '  background-repeat: no-repeat;', repl: '  background-repeat: repeat;', expect: ['⑤ 规格 §6.2 的 body::before 与实现逐声明不同'] },
    { name: 'M6 theme-store 把所有 --bg-scrim 的键名写错', file: STORE_PATH, flag: '--store', find: "'--bg-scrim'", repl: "'--bg-scrimx'", all: true, expect: ['② --bg-scrim 没有任何 JS 写入者'] },
    { name: 'M7 base.css 的锚点被改（模拟锚点失效）', file: CSS_PATH, flag: '--css', find: '  /* 背景照片相关（最终都落在下面 body::before 那一层）', repl: '  /* 照片相关（最终都落在下面 body::before 那一层）', expect: ['⑦ 没在 base.css 里定位到 :root 兜底那一段'] },
    { name: 'M8 @media 深色块里补上 --scrim-rgb', file: CSS_PATH, flag: '--css', find: '    --accent-weak: #16273d;\n  }', repl: '    --accent-weak: #16273d;\n    --scrim-rgb: 0,0,0;\n  }', expect: ['③ @media 深色块里补了 --scrim-rgb'] },
    { name: 'M9 删掉 :root 里的 --bg-scrim 兜底', file: CSS_PATH, flag: '--css', find: '  --bg-scrim: none;\n', repl: '', expect: ['③ --bg-scrim 的 :root 兜底值是 null'] },
    { name: 'M10 theme-store 的表达式里把 var(--scrim-a) 写错', file: STORE_PATH, flag: '--store', find: "'linear-gradient(rgba(var(--scrim-rgb), var(--scrim-a)), rgba(var(--scrim-rgb), var(--scrim-a)))');", repl: "'linear-gradient(rgba(var(--scrim-rgb), var(--scrim-a)), rgba(var(--scrim-rgb), var(--scrim-alpha)))');", expect: ['① JS 表达式里引用了但没有任何人写的变量：--scrim-alpha'] },
    { name: 'M11 base.css 里把「与 --bg 不同」改回被否掉的类比', file: CSS_PATH, flag: '--css', find: '与 --bg **不同**', repl: '与 --bg 的兜底同一个道理', expect: ['⑪ base.css 的 :root 注释里又出现了被否掉的类比'] },
    { name: 'M12 任务 15 清单里删掉「深色 + 照片 + 遮罩 0%」那条', file: PLAN_PATH, flag: '--plan', find: '- [ ] **深色 + 照片 + 遮罩 0%**：卡片上的次要文字（日期、账户名）仍然能读\n', repl: '', expect: ['⑩ 规格 §13 的 7 条在任务 15 的清单里找不到对应关键词：深色 + 照片 + 遮罩 0%'] },
    { name: 'M13 把工作区行尾统一成 LF（⑧ 的行尾断言）', fakeRoot: true, expect: ['⑧ 计划里的行尾纪律写着'] },
    { name: 'M14 base.css 里那条「隐蔽的失败」权衡被删掉', file: CSS_PATH, flag: '--css', find: '**照片裸奔、没有遮罩**', repl: '照片没有遮罩', expect: ['⑪ base.css 的 :root 注释里那条权衡不见了'] },
    { name: 'M15 base.css 里「第二份真相」那句被删掉', file: CSS_PATH, flag: '--css', find: '第二份真相', repl: '第二处写法', expect: ['⑪ base.css 的 :root 注释里应当保留「--scrim-a 的 0.3 是 OVERLAY_DEFAULT 的第二份真相'] },
    // 这一条对应 548c06e 那两处真实事故：把围栏粘到内容行尾。⑫ 必须抓到它。
    { name: 'M16 计划里制造一处粘连围栏（548c06e 那类畸形）', file: PLAN_PATH, flag: '--plan', find: '  --scrim-a: 0.3;\n```', repl: '  --scrim-a: 0.3;```', expect: ['⑫', '内容行粘了反引号/波浪线串'] },
    // 波浪号围栏：早先 ⑫ 只认反引号，而描述写的是「Markdown 围栏完整性」——实测追加未闭合的
    // `~~~` 是全绿的。这条变异守住那个覆盖。
    { name: 'M17 计划开头追加一段未闭合的 ~~~ 围栏（⑫ 的波浪号覆盖）', file: PLAN_PATH, flag: '--plan', find: '# pvault · 自定义背景 实现计划', repl: '# pvault · 自定义背景 实现计划\n\n~~~js\nconst x = 1;\n', expect: ['⑫', '未闭合的围栏'] },
    // ⑬ 的变异：往 sw.js 的注释里塞一条清单外的带引号路径——任务 14 那支数路径的脚本会把它的
    // 条数数多，而 Test-Path 全都通过（这正是实测踩到的那个盲区）。
    { name: 'M18 sw.js 注释里出现一条清单外的带引号路径（⑬ 的覆盖）', file: SW_PATH, flag: '--sw', find: '// 只列应用真正运行需要的资源。', repl: "// 只列应用真正运行需要的资源（例如 './app/nowhere.js' 这种写错路径的）。", expect: ['⑬ sw.js 里出现了不在 ASSETS 清单里的带引号相对路径'] }
  ];

  const variantDir = path.join(TMP_ROOT, 'variants');
  const outDir = path.join(TMP_ROOT, 'out');
  safeMkdir(variantDir);
  safeMkdir(outDir);

  function mutate(caseName, srcPath, find, repl, all) {
    const dir = path.join(variantDir, caseName.replace(/[^\w\u4e00-\u9fa5-]+/g, '_'));
    safeMkdir(dir);
    const out = path.join(dir, path.basename(srcPath));
    const text = readFileSync(srcPath, 'utf8');
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const F = find.replace(/\n/g, eol), R = repl.replace(/\n/g, eol);
    const hits = text.split(F).length - 1;
    if (all ? hits < 1 : hits !== 1) {
      console.error(`✗ ${caseName}：锚点匹配 ${hits} 次（${all ? '要求 ≥1' : '要求恰好 1'} 次），变异没落地 → ${JSON.stringify(find.slice(0, 60))}`);
      process.exit(2);
    }
    const next = all ? text.split(F).join(R) : text.replace(F, R);
    if (next === text) { console.error(`✗ ${caseName}：替换后内容没变，变异没落地`); process.exit(2); }
    write(out, next);
    return out;
  }

  let seq = 0;
  function runCheck(extraArgs, tag) {
    const outFile = path.join(outDir, 'run' + (seq++) + '.txt');
    const fd = safeOpenWrite(outFile);
    // **透传 --tmp**：子进程也要把它的 blob 探针写在同一个 tmp 下，否则会落到父进程 TMP_ROOT 之外
    // （os.tmpdir()/blob-probe），护栏就管不到它了。
    const selfArgs = [
      ...(extraArgs.includes('--root') ? [] : ['--root', ROOT]),
      ...extraArgs,
      '--tmp', path.join(TMP_ROOT, 'child-' + seq)
    ];
    const r = spawnSync(process.execPath, [import.meta.filename, ...selfArgs], { stdio: ['ignore', fd, fd] });
    closeSync(fd);
    if (typeof r.status !== 'number') {
      console.error(`✗ 核验没有正常结束（用例 ${tag}；status=${r.status}，error=${r.error && r.error.code}）——结果不可信`);
      process.exit(3);
    }
    const out = readFileSync(outFile, 'utf8');
    if (!out.includes('分组计数') && !out.includes('✗')) {
      console.error(`✗ 核验没有产出可辨认的输出（用例 ${tag}），结果不可信：\n` + out.slice(0, 600));
      process.exit(3);
    }
    return { code: r.status, out };
  }

  const base = runCheck([], 'N0');
  const rows = [{ name: 'N0 基线（不改任何东西）', code: base.code, ok: base.code === 0 && /通过（共 \d+ 项检查/.test(base.out), note: '期望 exit=0 且「…通过（共 N 项检查…）」（非 git 环境里会有未验证项，故此判定不锚死「全部」二字）' }];
  if (!rows[0].ok) console.log(base.out);

  let bad = 0;
  for (const c of cases) {
    let args;
    if (c.fakeRoot) {
      const FR = path.join(variantDir, 'fakeroot');
      safeMkdir(FR);
      for (const d of ['styles', 'docs', 'app']) safeCpDir(path.join(ROOT, d), path.join(FR, d));
      safeCpDir(path.join(ROOT, 'sw.js'), path.join(FR, 'sw.js'));
      const bp = path.join(FR, 'styles/base.css');
      const before = readFileSync(bp, 'utf8');
      const after = before.replace(/\r\n/g, '\n');
      if (after === before) { console.error(`✗ ${c.name}：base.css 本来就没有 CRLF，变异没落地`); process.exit(2); }
      write(bp, after);
      args = ['--root', FR];
    } else {
      const out = mutate(c.name, c.file, c.find, c.repl, c.all === true);
      args = [c.flag, out];
    }
    const r = runCheck(args, c.name);
    const missing = c.expect.filter(e => !r.out.includes(e));
    const ok = r.code !== 0 && missing.length === 0;
    if (!ok) bad++;
    rows.push({ name: c.name, code: r.code, ok, note: r.code === 0 ? '期望非 0，却是绿的（断言抓不到）' : (missing.length ? '没报出：' + missing.join(' / ') : '报出了预期项') });
    if (!ok) console.log('\n--- ' + c.name + ' 的实际输出 ---\n' + r.out);
  }

  console.log('变异自检结果：');
  for (const r of rows) console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}  → exit=${r.code}  ${r.note}`);
  console.log(bad === 0 ? `\n全部变异都被抓住（${cases.length}/${cases.length}）` : `\n有 ${bad} 个变异没被抓住`);
  console.log(`（自检的所有临时文件都在 ${TMP_ROOT} 下，仓库一个字节都没写）`);
  process.exit(bad === 0 ? 0 : 1);
}
