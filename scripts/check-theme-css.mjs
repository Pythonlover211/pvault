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
//   ⑥ body::before 在 styles/ 里只有一条规则
//   ⑦ 计划任务 9 的两个代码块 ⇄ styles/base.css 的对应段逐字符一致
//   ⑧ 计划顶部那条镜像纪律里的两个事实（工作区行尾混杂、git blob 是 LF）
//   ⑨ **空号**（历史上没有这一条；打印用的 order 数组里留着它，不影响计数）
//   ⑩ 规格 §13 的 7 条手动项 ⇄ 任务 15 清单的关键词（粗筛，不是语义对齐的证明）
//   ⑪ 被否掉的旧说法不许回流（注释里的因果只留更正后的版本）
//   ⑫ Markdown 围栏完整性：内容行不许粘反引号串、块内不许出现非法的结束围栏
//      （这条是补的：一个把代码块同步进计划的脚本丢过结尾换行，制造出两处粘连围栏，
//       而 ①②③…那些检查全都看不见它——围栏坏了，块内容却仍然"看起来"是对的）
//   ⑬ sw.js 的清单集合 ⇄ 它带引号路径的集合（**双向**）：清单外不该出现带引号的相对路径（笔误，
//      或引用了一个没进缓存的文件），清单里的条目也一律该有 './' 的同形写法（否则会躲过全文比对）。
//      **它抓不住「清单里少一条」**（少一条时两边同时少，照样绿）——那件事归
//      tests/boot-order.test.js 的首屏闭包断言与任务 14 步骤 2 的存在性脚本。
//   ⑭ app 里写的类名（三种**字面量**写法：`el(…, { class: '…' })`、`element.className = '…'`、
//      `classList.add/remove/toggle('…')`），`styles/*.css` 里必须真有对应规则。白名单条目也有两条
//      钉子：它现在还得有人用、它当初免检所依赖的规则必须还在（否则白名单会永久掩盖样式丢失）。
//      这条是任务 11 返工补的：面板当时用了 `field-label` / `btn-ghost` 两个**全仓零定义**的类名
//      （破坏性的「移除」与「换一张」因此长得一样），而那时 64 项核验全绿——`tests/` 里没有一条
//      碰 DOM 的断言。**它管不到**：模板串与变量里的类名（`class: \`zz-${x}\``、`class: clsVar`；
//      前者在仓库里实测 0 处）、拼接类名（只抽到前半截，因此会**误报**）、「少 3 处」这种局部丢失
//      （下限只挡整体塌掉）、以及「这个类视觉上合不合适」（后者归任务 15 真机验收）。
//
// 用法：
//   node scripts/check-theme-css.mjs                 核验（**只读仓库**）
//   node scripts/check-theme-css.mjs --self-test     变异自检（**只写系统临时目录**）
// 参数（都有默认值，默认按脚本自身位置推导，不写死任何绝对路径）：
//   --root <dir> --css <file> --store <file> --theme <file> --plan <file> --spec <file>
//   --sw <file> --styles <dir> --app <dir> --tmp <dir>
//   --app-file <file>   把 app/ 里的某一个模块换成变异副本（**只给 --self-test 用**：⑭ 扫的是整个
//                       app/ 目录，它的变异必须能覆盖到目录里的一个文件）
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
// `--app-file`：只给自检用——⑭ 遍历的是整个 app/ 目录，所以「某一个 app 模块被写坏」这种变异必须能
// 覆盖到目录里的某一个文件（与 --css / --store 走同一条 basename 覆盖逻辑）。
const APP_FILE_OVERRIDE = opt('app-file', null) ? path.resolve(opt('app-file', null)) : null;
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
  const m = /^([①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯])/.exec(msg);
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
if (APP_FILE_OVERRIDE) OVERRIDE.set(APP_FILE_OVERRIDE, readOrDie(APP_FILE_OVERRIDE, '--app-file 指定的文件'));
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

// ⑩ 的另一半：规格 §11「验收标准」（7 条）此前**没有任何机器守卫**——脚本里 `## 11` / `§11` /
// 「验收标准」这些串是 0 命中（实测），于是把任务 15 清单里「冷启动不闪色」那一整条删掉，⑩ 一声不响。
// 而 §11 是验收标准、§13 只是「跑不了自动化的部分」，缺的那一半恰恰更硬。
const s11At = specText.indexOf('## 11. 验收标准');
const spec11 = s11At < 0 ? '' : specText.slice(s11At, s13At > s11At ? s13At : undefined);
const spec11Items = (spec11.match(/^- \[ \]/gm) ?? []).length;
check(spec11Items === 7, `⑩ 规格 §11 的验收标准实测 ${spec11Items} 条，期望 7 条（条数变了，下面那张表也要跟着改）`);
// 作用域两种：box = 任务 15 的 markdown 清单块；t15 = 任务 15 整段。第 6 条是「tests 全绿」这条
// 自动化验收，它的落点是任务 15 步骤 2 的回归命令、不在手动清单里——别为了凑「都落在清单里」去改清单。
const keys11 = [
  { k: '切到别的 Tab 再切回来', where: 'box', item: '第 1 条（切 Tab / 重进后保持）' },
  { k: '改系统的深色开关', where: 'box', item: '第 2 条（跟随系统实时变）' },
  { k: '确认背景消失且卡片恢复不透明', where: 'box', item: '第 3 条（关掉照片后完全恢复原样）' },
  { k: '- [ ] **冷启动不闪色**', where: 'box', item: '第 4 条（内容出现之前主题已应用）' },
  { k: '导出含背景的备份', where: 'box', item: '第 5 条（导出携带背景、导入还在）' },
  { k: '--test-isolation=none', where: 't15', item: '第 6 条（tests 全绿）' },
  { k: '确认没有元素变成透明块或黑块', where: 'box', item: '第 7 条（真机上没有看不清的数字与控件）' }
];
const scopeOf = e => (e.where === 'box' ? planBox : t15);
const miss11 = keys11.filter(e => !scopeOf(e).includes(e.k));
check(miss11.length === 0,
  '⑩ 规格 §11 的验收标准在任务 15 里找不到对应关键词：' + miss11.map(e => `${e.k}（${e.item}）`).join('、'));
// 选词必须**在该作用域里唯一**：命中 0 次由上一条报，命中 ≥2 次由这一条报——一个词在两处出现时，
// 删掉其中一处它照样命中，与「没命中」是同一种失明。⑩ 第一版就栽在这上面（用了「深色」，而
// 「皮肤与深浅」那一节里也有「深色」，删掉目标条目后照样绿，实测踩到过）。
const dup11 = keys11
  .map(e => ({ ...e, n: scopeOf(e).split(e.k).length - 1 }))
  .filter(e => e.n !== 1);
check(dup11.length === 0,
  '⑩ 规格 §11 的关键词在任务 15 里的出现次数不为 1（这类词由别处的同一句话顶住，断言照样绿）：'
  + dup11.map(e => `${e.k}×${e.n}（${e.item}）`).join('、'));
say('⑩ 规格 §11 的 7 条 → 任务 15 关键词命中 ' + (keys11.length - miss11.length) + '/7，'
  + '且每个词在该作用域内唯一（非唯一 ' + dup11.length + ' 个，应为 0）');

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

// ── ⑬ sw.js 的清单集合 ⇄ 它带引号路径的集合（**双向**）────────
// 定位（返工第二轮改准过一次，这一版是准的）：这条管的是「`sw.js` 里带引号的相对路径与 `ASSETS` 清单
// 两边对得上」——注释里举例写的路径、代码里的回退路径（`caches.match('./x')`）都算在内。
// 两个方向各有各的用处：
//   · 清单外的带引号路径：要么是笔误，要么是引用了一个没进缓存的文件（那它离线永远拿不到）；
//   · 清单里没有 `./` 同形写法的条目：清单约定是一律写 `'./…'`，写成别的形态会躲过全文比对。
// **它不管「清单里少了一条」**——⑬ 只比对集合关系，少一条时两边同时少，照样绿。那件事归
// tests/boot-order.test.js 的「首屏资源闭包 ⊆ ASSETS」，以及计划任务 14 步骤 2 那支存在性脚本
// （它管「清单里的路径在磁盘上都不存在吗」，⑬ 不管磁盘存在性）。别在这条上写超出它能力的话。
// 也**不再**声称它保护那支脚本的计数：任务 10 返工已把那支脚本收紧到 `ASSETS` 数组切片内，
// 数组外的注释不会再被它数进来（对照实测：注释里塞一条带引号路径时，旧版报 59、收紧版报 58）。
const swSrc = read(SW_PATH);
const assetsBlock = /const ASSETS = \[([\s\S]*?)\];/.exec(swSrc)?.[1];
check(!!assetsBlock, '⑬ 没在 sw.js 里找到 ASSETS 数组（锚点失效）');
const listed = new Set([...(assetsBlock ?? '').matchAll(/'([^']+)'|"([^"]+)"/g)].map(m => m[1] ?? m[2]));
const quotedPaths = new Set([...swSrc.matchAll(/'(\.\/[^']*)'|"(\.\/[^"]*)"/g)].map(m => m[1] ?? m[2]));
check(listed.size > 0, '⑬ ASSETS 里一条路径都没解析出来（锚点失效）');
check(quotedPaths.size > 0, '⑬ sw.js 全文里一条带引号的相对路径都没解析出来（锚点失效）');
const outsideAssets = [...quotedPaths].filter(p => !listed.has(p)).sort();
const notPrefixed = [...listed].filter(p => !quotedPaths.has(p)).sort();
check(outsideAssets.length === 0,
  '⑬ sw.js 里出现了不在 ASSETS 清单里的带引号相对路径（笔误，或是引用了一个没进缓存的文件）：' + outsideAssets.join(' '));
check(notPrefixed.length === 0,
  '⑬ ASSETS 里这些条目没有对应的 ./ 同形写法（清单约定一律写 \'./…\'，写成别的形态会躲过全文比对）：' + notPrefixed.join(' '));
say(`⑬ sw.js：ASSETS ${listed.size} 条、全文带引号路径 ${quotedPaths.size} 个；清单外 ${outsideAssets.length} 个、非 ./ 形态 ${notPrefixed.length} 个（都应为 0）`);

// ── ⑭ app 里的类名 ⇄ styles/ 里真有这条规则 ─────────────────
// 为什么加：视图/面板写的 class 名是**字符串**，写错了（或指向一个只活在计划里、从没被写进任何
// 样式表的类）在 Node 里一行都不会红——`tests/` 里没有任何东西碰 DOM。实测踩到过：任务 11 的面板
// 用了 `field-label` 与 `btn-ghost`，而 `styles/*.css` 里一条定义都没有（全仓 0 命中），于是
// 「移除」这个破坏性按钮与「换一张」长得一模一样，而当时 64 项核验全绿。
//
// 它查三种**字面量**写法：`el(…, { class: '…' })`（含 `cond ? 'a on' : 'a'` 这种三元）、
// `element.className = '…'`、`classList.add/remove/toggle('…')`。
// **边界（如实写，前两条是实测过的）**：
//   · **拼接是误报，不是漏检**：`class: 'pre-' + x` 只抽得到 `pre-`，随后报「没有规则」而红
//     （实测：`class: 'zz-concat-' + x` → 175 个类名、1 个缺失、exit=1）。漏掉的是后半截，但报出来的
//     假红更显眼——下一个看到红的人会去追一个不存在的类名，所以这里标成误报。
//   · **模板串与变量抽不到**：`class: \`zz-${x}\`` 与 `class: clsVar` 完全看不见。前者在仓库里实测
//     **0 处**（纯理论），后者也只在动态拼接里出现；要正确解析得引入一个 JS 解析器，收益不成比例。
//   · `dataset: { class: 'x' }` 里的那个 class **不参与**（抽取前先挖掉）：`dom.js` 把它写成
//     `data-class`、不产生 `.x`，不挖掉就是假红（构造出来实测过：报「zz-dataset 没有规则」而红；
//     仓库里这种写法现在 **0 处**，挖掉纯属防线）。
//   · `setAttribute('class', 'x')` **不抽**：仓库里实测 **0 处**。真用到时再补，别提前写一条没有实例
//     的正则——那种正则本身也不会被任何变异守住。
//   · **下限挡不住局部丢失**：把 3 处 `class:` 写成 `class :`（实测 174→171）仍然绿——下限只挡
//     「整类写法失效 / 整体塌掉」。要抓这种局部丢失得有基线文件，本脚本没有状态，如实记在这里。
//   · 它不判断「这个类该不该长这样」，只管「有没有人给它写过规则」——视觉是否合适仍归任务 15 真机验收。
//
// 白名单：没有对应规则、但**已经核实过不影响渲染**的类名。每条都要写清理由，而理由会被下面两条断言
// 钉住：它现在还得有人用（否则是免检牌），而且它当初免检所依赖的规则必须还在——实测过那两个缺口：
// 把白名单塞一条再删掉对应的 CSS 规则、以及删掉用法让条目变成孤儿，两种情况下 ⑭ 都会照旧全绿。
const CLASS_WHITELIST = [
  {
    name: 'keypad',
    why: '纯容器（app/ui/keypad.js），盒子由子元素撑开，样式全在 .keypad-display / .keypad-grid 上',
    needs: [/\.keypad-display(?![\w-])/, /\.keypad-grid(?![\w-])/]
  },
  {
    name: 'stats-nav',
    why: '按钮的样式来自祖先选择器（styles/ledger.css 的 .stats-month button），类名只是钩子',
    // 要求「button 后面直接跟 {」：ledger.css 里还有一条 `.stats-month button:disabled {`，松一点的正则
    // 会被它骗过去——实测过：把基规则改名之后，只靠 `.stats-month button` 这个串仍然命中 :disabled 那条，
    // 白名单照样绿（M22 第一版没抓住，就是这条正则太松）。
    needs: [/\.stats-month\s+button\s*\{/]
  }
];
const cssRuleRe = name => new RegExp('\\.' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w-])');
const classNames = new Map();
const formHits = { attr: 0, className: 0, classList: 0 };
for (const f of appFiles) {
  const rel = path.relative(ROOT, f).split(path.sep).join('/');
  // 先挖掉 `dataset: { … }`：里面的 `class:` 是 data-class，不是 CSS 类名（见上面的边界）。
  const src = stripJsComments(load(f)).replace(/dataset\s*:\s*\{[^}]*\}/g, 'dataset: {}');
  const add = text => {
    for (const name of text.split(/\s+/).filter(Boolean)) {
      if (!classNames.has(name)) classNames.set(name, new Set());
      classNames.get(name).add(rel);
    }
  };
  for (const m of src.matchAll(/\bclass:\s*([^,\n}]+)/g)) {
    formHits.attr++;
    for (const s of m[1].matchAll(/['"]([^'"]*)['"]/g)) add(s[1]);
  }
  for (const m of src.matchAll(/\.className\s*=\s*([^\n;]+)/g)) {
    formHits.className++;
    for (const s of m[1].matchAll(/['"]([^'"]*)['"]/g)) add(s[1]);
  }
  for (const m of src.matchAll(/classList\.(?:add|remove|toggle)\(\s*['"]([^'"]*)['"]/g)) {
    formHits.classList++;
    add(m[1]);
  }
}
// 抽取失效自检：类名一个都没抽到、或数量塌了，下面的断言就是空转（守卫静默失明比没有守卫更危险）。
// 两条下限都贴着实测基线留余量：类名总数 178（下限 170）、三种写法的命中数 558 / 11 / 11（下限 500 / 8 / 8）。
check(classNames.size >= 170,
  `⑭ 只从 app/ 里抽到 ${classNames.size} 个类名（实测基线 178，下限取 170）——抽取多半失效了，这条别当成通过`);
check(formHits.attr >= 500 && formHits.className >= 8 && formHits.classList >= 8,
  `⑭ 三种写法的命中数异常（class: ${formHits.attr} 处 / className=: ${formHits.className} 处 / classList: ${formHits.classList} 处）`
  + '——实测基线是 558 / 11 / 11 这个量级，某一类塌到个位数说明那条抽取失效了');
const whitelisted = new Set(CLASS_WHITELIST.map(w => w.name));
const missingClasses = [...classNames.keys()]
  .filter(n => !whitelisted.has(n) && !cssRuleRe(n).test(cssText))
  .sort();
check(missingClasses.length === 0,
  '⑭ app 里用到的这些类名在 styles/ 里没有任何规则（类名写错，或这个类只活在计划里）：'
  + missingClasses.map(n => `${n}（${[...classNames.get(n)].join('、')}）`).join('、'));
// ① 白名单条目必须是活的：它现在还得有人用。死条目不报错只会变成一张免检牌。
const staleWhitelist = [...whitelisted].filter(n => !classNames.has(n)).sort();
check(staleWhitelist.length === 0,
  '⑭ 白名单里的这些类名已经没人用了（白名单条目要删掉，别留着当免检牌）：' + staleWhitelist.join(' '));
// ② 而且它当初免检的**理由**必须还成立——理由通常挂在别的规则上（子元素的样式、祖先选择器），
// 那些规则一旦改名或删掉，白名单就会永久掩盖一个真实的样式丢失。
const brokenWhy = [];
for (const w of CLASS_WHITELIST) {
  const miss = w.needs.filter(re => !re.test(cssText));
  if (miss.length) brokenWhy.push(`${w.name}（理由：${w.why}）—— 在 styles/ 里找不到 ${miss.map(String).join('、')}`);
}
check(brokenWhy.length === 0,
  '⑭ 白名单条目的理由不成立了（它依赖的规则没了——要么把规则补回来，要么这个类该有自己的规则）：\n     '
  + brokenWhy.join('\n     '));
say(`⑭ app 里的类名 ${classNames.size} 个（class: ${formHits.attr} 处 / className=: ${formHits.className} 处 / classList: ${formHits.classList} 处）；`
  + `styles/ 里没有规则的 ${missingClasses.length} 个（应为 0）；白名单 ${CLASS_WHITELIST.length} 条`
  + `（孤儿 ${staleWhitelist.length}、理由失效 ${brokenWhy.length}，都应为 0）`);

// ── ⑮ 计划各任务的代码块 ⇄ 仓库现状（镜像守卫，按任务分段）────
// 计划 = 代码的逐字符镜像，粒度是**各任务自己的 HEAD**。在此之前只有三处入口：⑦ 守任务 9 的两块、
// 任务 13 末尾那条测试守它自己的八块，而任务 11 那个 298 行的大块、任务 2–7 与任务 10 / 12 的几十个
// 片段谁都不守——改一行注释就能让镜像静默漂移，下一次评审只能靠肉眼重读全文（任务 13 的注释就是这么
// 说的）。本表把「哪一段该镜哪个文件」显式写下来，逐块断。
//
// 为什么不写成「把计划里所有 js 块拿去自动匹配仓库文件」：自动匹配看着省事，但它判的是「这个块在
// **某个**文件里出现过」——抄错文件、抄成另一个模块的片段都照样绿。显式写出目标文件才挡得住。
// 代价是加段要在这里加一行，这就是本表存在的形态。
//
// 表项的两种形态：
//   · 只有 files：块必须是其中**某个文件**的连续子串（片段型：一段 import、配置数组里的一项）。
//   · 带 patches：块经补丁替换后必须与目标文件**逐字符相等**（整文件型）。任务 11 的 js 块是后者：
//     它镜的是任务 11 的 HEAD，而任务 13 改过其中一处文案与注释——计划里紧跟那个代码块的那段
//     「任务 13 之后这个文件的现状」已经把这处偏差声明出来了，所以「块 ≠ 现状」是**应该的**。
//     补丁把这处已知偏差显式写下来，其余任何一处漂移都会红（改这处文案时两边一起改，否则这里红）。
//
// **没进表的段与原因**（本轮逐块实测过，复现方式与下面的比对完全一样：把该段的块抽出来，与候选文件
// 做连续子串比对）：任务 1 的 2 个 js 块里有 1 个（`tests/theme.test.js` 的那段）与现状不一致；
// 任务 8 的 3 个 js 块里有 1 个（`app/theme-store.js` 的背景照片段）与现状不一致——这两处偏差**没有**
// 像任务 11 那样被声明成补丁，想让它们进表就得先补一份；任务 9 的 2 个 css 块由 ⑦ 逐段精确守着
// （比本表的「包含于某个文件」更严），不重复纳入。要把它们补进来时，加一行 + 把 count 数准即可。
//
// 维护：加块 / 删块要同步改 count —— 用**精确相等**，不写下限：任务 13 那条守卫的注释里记着
// 「`>= 6` 在删掉两块之后照样绿」（实测过），少一块时下面的逐块断言会跟着少，守卫静默变窄。
// 任务 13 那八块另有一条测试守着（`tests/backup-store.test.js`），两边是同一条纪律的两个入口，
// 块数常量 8 要一起改。
const T11_PHOTO_HINT_PATCH = {
  find: [
    "        // 只说这一版真做得到的事：照片缩到最长边**最大** 1600 后存在这台手机上（`image-scale.js` 对",
    "        // 最长边已经 ≤1600 的图**不放大**，所以写「压到 1600」是错的——一张 800px 的图进去还是 800px）。",
    "        // **不写「跟着备份一起走」**：导出包现在还不带背景（`buildBackup` 的 data 里没有它，那是任务 13",
    "        // 的事），面板不该向用户承诺一件这个版本做不到的事。",
    "        el('div', { class: 'hint-text', text: '选一张照片铺在卡片下面。照片的最长边最多留 1600 像素，然后存在这台手机上。' })"
  ].join('\n'),
  repl: [
    "        // 只说真做得到的事：照片缩到最长边**最大** 1600 后存在这台手机上（`image-scale.js` 对",
    "        // 最长边已经 ≤1600 的图**不放大**，所以写「压到 1600」是错的——一张 800px 的图进去还是 800px）。",
    "        // **「导出备份时会一起带走」这句是任务 13 之后才加回来的**：它此前被删掉，理由是「导出包现在还不带",
    "        // 背景，面板不该承诺一件这个版本做不到的事」——那个理由随任务 13 消失了（`buildBackup` 的 data",
    "        // 里有 `background`，导出时由 `encodeBackground` 填、导入时写回 `assets`，两侧都有测试钉住）。",
    "        // 边界（别把这句读成全称）：`encodeBackground` 失败时**那一次**导出不带背景。失败时用户会",
    "        // 当场看到——`exportBackup` 返回的 `backgroundSkipped` 由备份面板落成一行警示",
    "        // （app/ui/backup-view.js 里的 export-background-skipped），所以不必等到换机才发现。",
    "        // 但这句承诺本身仍然是「会」，不是「永远会」。",
    "        el('div', { class: 'hint-text', text: '选一张照片铺在卡片下面。照片的最长边最多留 1600 像素，然后存在这台手机上，导出备份时会一起带走。' })"
  ].join('\n')
};
const MIRROR_SEGMENTS = [
  { id: '任务 2', from: '## 任务 2：', to: '## 任务 3：',
    parts: [{ lang: 'js', count: 1, files: ['tests/theme.test.js'] }] },
  { id: '任务 3', from: '## 任务 3：', to: '## 任务 4：',
    parts: [{ lang: 'js', count: 2, files: ['app/theme.js', 'tests/theme.test.js'] }] },
  { id: '任务 4', from: '## 任务 4：', to: '## 任务 5：',
    parts: [{ lang: 'js', count: 2, files: ['app/theme.js', 'tests/theme.test.js'] }] },
  { id: '任务 5', from: '## 任务 5：', to: '## 任务 6：',
    parts: [{ lang: 'js', count: 2, files: ['app/canvas-image.js', 'app/image-store.js', 'app/theme-store.js'] }] },
  { id: '任务 6', from: '## 任务 6：', to: '## 任务 7：',
    parts: [{ lang: 'js', count: 6, files: ['app/schema.js', 'tests/schema.test.js'] }] },
  { id: '任务 7', from: '## 任务 7：', to: '## 任务 8：',
    parts: [
      { lang: 'js', count: 2, files: ['app/theme-store.js'] },
      { lang: 'html', count: 1, files: ['index.html'] }
    ] },
  { id: '任务 10', from: '## 任务 10：', to: '## 任务 11：',
    parts: [{ lang: 'js', count: 4, files: ['app/main.js', 'sw.js'] }] },
  { id: '任务 11', from: '## 任务 11：', to: '## 任务 12：',
    parts: [
      { lang: 'js', count: 1, files: ['app/ui/appearance-sheet.js'], patches: [T11_PHOTO_HINT_PATCH] },
      { lang: 'css', count: 1, files: ['styles/appearance.css'] },
      { lang: 'html', count: 1, files: ['index.html'] }
    ] },
  { id: '任务 12', from: '## 任务 12：', to: '## 任务 13：',
    parts: [{ lang: 'js', count: 2, files: ['app/ui/settings-sheet.js'] }] },
  { id: '任务 13', from: '## 任务 13：', to: '## 任务 14：',
    parts: [{ lang: 'js', count: 8, files: ['app/backup.js', 'app/backup-store.js'] }] }
];
for (const seg of MIRROR_SEGMENTS) {
  const at = planText.indexOf(seg.from);
  const end = at < 0 ? -1 : planText.indexOf(seg.to, at + seg.from.length);
  const cut = check(at >= 0 && end > at, `⑮ 计划里切不出「${seg.id}」这一段（锚点失效：${seg.from} / ${seg.to}）`);
  if (!cut) continue;
  const section = planText.slice(at, end);
  for (const part of seg.parts) {
    const blocks = [...section.matchAll(new RegExp('```' + part.lang + '\\n([\\s\\S]*?)```', 'g'))]
      .map(m => m[1].replace(/\n$/, ''));
    check(blocks.length === part.count,
      `⑮ 计划「${seg.id}」段落里的 ${part.lang} 代码块实测 ${blocks.length} 个，期望 ${part.count} 个`
      + '（块数不一样就别当成通过：少一块时下面的逐块断言会跟着少）');
    for (const [i, b] of blocks.entries()) {
      const label = `⑮ 计划「${seg.id}」的第 ${i + 1} 个 ${part.lang} 块`;
      const first = (b.split('\n').find(l => l.trim()) ?? '').slice(0, 34);
      const nonEmpty = check(b.trim() !== '', `${label}是空块（空串是任何文件的子串，这条断言对它恒真）：${first}`);
      if (!nonEmpty) continue;
      let want = b;
      if (part.patches) {
        for (const p of part.patches) {
          const hits = want.split(p.find).length - 1;
          check(hits === 1, `${label}的已知偏差补丁命中 ${hits} 次（要求恰好 1 次）——补丁要跟着改，`
            + '否则它护着的那 298 行会从「已知偏差 1 处」变成「无人核对」');
          want = want.replace(p.find, p.repl);
        }
      }
      const hit = part.files.find(f => {
        // 目标文件读不到时**判「对不上」**，不要抛：⑮ 的比对目标是仓库文件，而变异副本（--root 或
        // --app-file）里少一个文件是常有的事——那时抛出去会把「这条断言没跑到」伪装成一次崩溃，
        // 而且崩在报告打印之前，整份输出都变成不可辨认（实测踩到过：fakeroot 少复制了 index.html）。
        let src;
        try { src = load(path.join(ROOT, f)); } catch { return false; }
        src = src.replace(/\n$/, '');
        return part.patches ? src === want : src.includes(b);
      });
      check(!!hit, `${label}（${b.split('\n').length} 行，首行：${first}）与 ${part.files.join(' / ')} 都对不上：`
        + (part.patches
          ? '补丁之后仍不是逐字符相等——有一处**没写进补丁**的漂移（或目标文件被改过）'
          : '两边有一处漂移了'));
    }
  }
}

// ── ⑯ 照片模式只动 --surface ⇄ 三处写死的 0.9 ────────────────
// 「0.9」在这个仓库里出现三次：theme.js 的 PHOTO_SURFACE_ALPHA（唯一真相）、base.css 注释里的
// `rgba(r,g,b, 0.9)`、规格 §6.3 的 `rgba(r,g,b, .9)`。三处都写死，谁改谁漏就是一份静默漂移的副本
// （与 ③ 的 --scrim-a 同一个形状，只是这里的副本在注释与规格里）。形状那一半钉的是「只动 --surface」
// ——照片模式偷偷改了别的变量（比如把 --surface-2 也变透、把输入框上的字送进照片纹理）在 Node 里
// 一行都不会红，只有真机上「字看不清了」这种主观现象。
const alphaStr = String(theme.PHOTO_SURFACE_ALPHA);
const cssAlpha = [...cssSrc.matchAll(/rgba\(r,g,b, ([0-9.]+)\)/g)].map(m => m[1]);
check(cssAlpha.length === 1 && cssAlpha[0] === alphaStr,
  `⑯ base.css 注释里写死的透明度实测 ${JSON.stringify(cssAlpha)}，期望恰好一处、值 = PHOTO_SURFACE_ALPHA(${alphaStr})`
  + '——注释与常量不一致时，读者照着注释改代码就会把常量改错');
const s63At = specText.indexOf('### 6.3 可读性');
check(s63At >= 0, '⑯ 规格里没找到「### 6.3 可读性」（锚点失效）');
const specAlpha = /rgba\(r,g,b, (\.?[0-9.]+)\)/.exec(specText.slice(s63At))?.[1];
check(specAlpha !== undefined && Number(specAlpha) === theme.PHOTO_SURFACE_ALPHA,
  `⑯ 规格 §6.3 里写死的透明度实测 ${JSON.stringify(specAlpha)}，与 PHOTO_SURFACE_ALPHA(${alphaStr}) 不符`);
// 形状那条的期望 alpha 取 **base.css 注释里那一份**，不是常量本身：拿常量当期望是**自指**的——
// 把 PHOTO_SURFACE_ALPHA 改成 0.8，期望值跟着变成 0.8，十组断言照样全绿（实测踩到过：M27 第一版
// 就是这么漏过去的）。这正是 tests/theme.test.js 那份「正典清单不拿 default.light 当基准」的道理。
const wantAlpha = cssAlpha.length === 1 ? cssAlpha[0] : alphaStr;
const photoChanged = [];
const surfaceShapeBad = [];
for (const id of theme.THEME_IDS) for (const mode of ['light', 'dark']) {
  const off = theme.themeCssVars(id, mode, { photo: false });
  const on = theme.themeCssVars(id, mode, { photo: true });
  const changed = [...new Set([...Object.keys(off), ...Object.keys(on)])].filter(k => off[k] !== on[k]);
  if (changed.length !== 1 || changed[0] !== '--surface') {
    photoChanged.push(`${id}.${mode}：动了 ${changed.length ? changed.join(' ') : '（一个都没动）'}`);
  }
  const hex = /^#([0-9a-f]{6})$/i.exec(off['--surface'] ?? '');
  const got = /^rgba\((\d+),(\d+),(\d+), ([0-9.]+)\)$/.exec(on['--surface'] ?? '');
  if (!hex || !got) {
    surfaceShapeBad.push(`${id}.${mode}：--surface=${JSON.stringify(off['--surface'])} / `
      + `照片模式=${JSON.stringify(on['--surface'])}，不是「6 位 hex → rgba(r,g,b, a)」这一对`);
    continue;
  }
  const n = parseInt(hex[1], 16);
  const wantRgb = `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
  // 通道必须由该档 --surface 现算（色板里没有 --surface-rgb 这份副本可对不上），alpha 必须与注释一致。
  if (`${got[1]},${got[2]},${got[3]}` !== wantRgb || got[4] !== wantAlpha) {
    surfaceShapeBad.push(`${id}.${mode}：照片模式 --surface=${JSON.stringify(on['--surface'])}，`
      + `期望 rgba(${wantRgb}, ${wantAlpha})`);
  }
}
check(photoChanged.length === 0,
  '⑯ 照片模式动的变量不止 --surface（theme.js 的注释与规格 §6.3 都写着「只动 --surface」）：\n     '
  + photoChanged.join('\n     '));
check(surfaceShapeBad.length === 0,
  '⑯ 照片模式的 --surface 与「该档 --surface 的三个通道 + 注释里那份透明度」不符：\n     '
  + surfaceShapeBad.join('\n     '));
// appearance.css 的变量纪律：它的头注释写着「变量全部来自主题（--surface / --accent / …），所以这几十行
// 在五套皮肤 × 深浅下都自动成立」——自造一个变量就只在定义它的那一档有值，换肤即失效，而 CSS 不会报错。
// 匹配「任意位置」的 `--x:`（不锚行首）：一行里塞两个声明同样是自造（`el(…)` 与内联 style 里都这么写）。
const appearanceCss = stripCssComments(load(path.join(STYLES_DIR, 'appearance.css')));
const ownVars = [...new Set([...appearanceCss.matchAll(/--[a-zA-Z0-9_-]+\s*:/g)].map(m => m[0].trim()))];
check(ownVars.length === 0,
  '⑯ styles/appearance.css 里自己定义了 CSS 变量（它的头注释说「变量全部来自主题」，自造的那一个'
  + '只有这套皮肤这一档有值、换肤即失效）：' + ownVars.join(' '));
say(`⑯ 照片模式：10 组里动了别的变量的 0 组；0.9 三处一致（JS=base.css 注释=规格 §6.3=${alphaStr}）；`
  + `appearance.css 自造变量 ${ownVars.length} 个（应为 0）`);

// ── 输出 ────────────────────────────────────────────────────
if (!SELF_TEST) {
  console.log('任务 9 静态核验（文本层；渲染层结论不在这里，见计划任务 15）');
  console.log(report.join('\n'));
  const order = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫', '⑬', '⑭', '⑮', '⑯', '自检', '其他'];
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
    // ⑬ 的变异：往 sw.js 的注释里塞一条清单外的带引号路径。⑬ 抓的是「清单外不该有带引号的相对路径」
    // 本身（笔误、或引用了一个没进缓存的文件）——**不再**声称是为了保护那支数路径的脚本：
    // 任务 10 返工已把它收紧到数组切片内，注释里的路径不影响它了。
    { name: 'M18 sw.js 注释里出现一条清单外的带引号路径（⑬ 的覆盖）', file: SW_PATH, flag: '--sw', find: '// 只列应用真正运行需要的资源。', repl: "// 只列应用真正运行需要的资源（例如 './app/nowhere.js' 这种写错路径的）。", expect: ['⑬ sw.js 里出现了不在 ASSETS 清单里的带引号相对路径'] },
    // ⑬ 双向的另一半：清单条目少了 './' 前缀时，全文比对会漏掉它。第一版 ⑬ 只查单向，这条变异
    // 当时是绿的（实测过）——现在必须红。
    { name: 'M19 ASSETS 里一条条目少了 ./ 前缀（⑬ 双向的那一半）', file: SW_PATH, flag: '--sw', find: "  './app/db.js',", repl: "  'app/db.js',", expect: ['⑬ ASSETS 里这些条目没有对应的 ./ 同形写法'] },
    // ⑭ 的变异：往一个被扫描的 app 模块里塞一个 styles/ 里没有定义的类名。任务 11 的面板真实踩过
    // 这个坑（`field-label` / `btn-ghost` 全仓零定义），当时没有任何断言看得见。
    { name: 'M20 app 里用了 styles/ 没有定义的类名（⑭ 的覆盖）', file: STORE_PATH, flag: '--store', find: 'export function currentTheme() {', repl: "const _probeEl = el('div', { class: 'zz-no-such-class' });\nexport function currentTheme() {", expect: ['⑭ app 里用到的这些类名在 styles/ 里没有任何规则', 'zz-no-such-class'] },
    // ⑭ 的第二条边界：白名单条目必须是活的（没人用了就删掉）。实测过这个缺口——删掉用法之后，
    // 白名单条目变成一张免检牌，而 ⑭ 照旧全绿。
    { name: 'M21 删掉 stats-nav 的用法（⑭ 白名单条目变孤儿）', file: path.join(APP_DIR, 'ui/stats-view.js'), flag: '--app-file', find: "class: 'stats-nav',", repl: "class: 'stats-month-label',", all: true, expect: ['⑭ 白名单里的这些类名已经没人用了'] },
    // ⑭ 的第三条边界：白名单条目「为什么可以免检」所依赖的规则必须还在。这条走 fakeRoot——ledger.css
    // 走不了 --css 的覆盖（那会把 ③④⑤⑦ 依赖的 base.css 换掉，整批断言崩成噪声）。
    { name: 'M22 删掉 .stats-month button 规则（⑭ 白名单的理由失效）', fakeRoot: true, change: { file: 'styles/ledger.css', find: '.stats-month button {', repl: '.stats-month-btn {' }, expect: ['⑭ 白名单条目的理由不成立了'] },
    // ⑭ 的抽取扩展：`classList.add('…')` 这种写法以前看不见（实测仓库里 22 处、11 个类名全在检查之外）。
    { name: 'M23 classList.add 一个 styles/ 里没有的类名（⑭ 抽取扩展的覆盖）', file: STORE_PATH, flag: '--store', find: 'export function currentTheme() {', repl: "const _probe = document.createElement('div');\n_probe.classList.add('zz-classlist-missing');\nexport function currentTheme() {", expect: ['⑭ app 里用到的这些类名在 styles/ 里没有任何规则', 'zz-classlist-missing'] },
    // 任务 14 新增的 ⑩（§11）/ ⑮ / ⑯ 各配变异：新断言没有变异就是恒真的绿，这与 ⑭ / ⑬ / ⑫ 的规矩一样。
    // ⑮ 的第一条：整文件型镜像（任务 11 的 298 行块 + 补丁）——文件那一侧改一个字就该红。
    { name: 'M24 改 appearance-sheet.js 的提示文案（⑮ 任务 11 的整文件镜像）', file: path.join(APP_DIR, 'ui/appearance-sheet.js'), flag: '--app-file', find: '导出备份时会一起带走。', repl: '导出备份时会一起带走！', expect: ['⑮ 计划「任务 11」的第 1 个 js 块', '补丁之后仍不是逐字符相等'] },
    // ⑮ 的第二条：补丁本身失配（改的是计划侧那 5 行之一）——这条守的是「补丁还在不在原位」，
    // 缺了它，补丁会悄悄退化成「替换 0 次」，而那 298 行就又没人核对了。
    { name: 'M25 改计划里补丁覆盖的那一行（⑮ 的补丁失配）', file: PLAN_PATH, flag: '--plan', find: '        // **不写「跟着备份一起走」**：导出包现在还不带背景（`buildBackup` 的 data 里没有它，那是任务 13', repl: '        // **不写「跟着备份一起走」**：导出包现在还不带背景（`buildBackup` 的 data 里没有它，那是任务 13 那一步', expect: ['已知偏差补丁命中 0 次'] },
    // ⑮ 的第三条：片段型镜像（任务 12 的两个小块）。
    { name: 'M26 改 settings-sheet.js 的 import（⑮ 任务 12 的片段镜像）', file: path.join(APP_DIR, 'ui/settings-sheet.js'), flag: '--app-file', find: "import { openAppearanceSheet } from './appearance-sheet.js';", repl: "import { openAppearanceSheet } from './appearance-sheet-x.js';", expect: ['⑮ 计划「任务 12」的第 1 个 js 块'] },
    // ⑯ 的三条：常量改值（三处写死的 0.9 一起对不上）、照片分支多动一个变量、外观面板自造变量。
    { name: 'M27 把 PHOTO_SURFACE_ALPHA 改成 0.8（⑯ 的 0.9 三处一致）', fakeRoot: true, change: { file: 'app/theme.js', find: 'export const PHOTO_SURFACE_ALPHA = 0.9;', repl: 'export const PHOTO_SURFACE_ALPHA = 0.8;' }, expect: ['⑯ 照片模式的 --surface 与「该档 --surface 的三个通道', '⑯ base.css 注释里写死的透明度', '⑯ 规格 §6.3 里写死的透明度'] },
    { name: 'M28 让照片分支连 --surface-2 一起改（⑯ 只动 --surface）', fakeRoot: true, change: { file: 'app/theme.js', find: "    vars['--surface'] = `rgba(${hexToRgb(base['--surface'])}, ${PHOTO_SURFACE_ALPHA})`;", repl: "    vars['--surface'] = `rgba(${hexToRgb(base['--surface'])}, ${PHOTO_SURFACE_ALPHA})`;\n    vars['--surface-2'] = 'rgba(0, 0, 0, 0.9)';" }, expect: ['⑯ 照片模式动的变量不止 --surface'] },
    { name: 'M29 appearance.css 自造一个 CSS 变量（⑯ 的变量纪律）', file: path.join(STYLES_DIR, 'appearance.css'), flag: '--app-file', find: [
      '.hint-text {',
      '  font-size: var(--font-xs);',
      '  color: var(--text-2);',
      '  line-height: 1.6;',
      '}'
    ].join('\n'), repl: [
      '.hint-text {',
      '  font-size: var(--font-xs);',
      '  color: var(--text-2);',
      '  line-height: 1.6;',
      '}',
      '',
      ':root { --zz-probe: 1; }'
    ].join('\n'), expect: ['⑯ styles/appearance.css 里自己定义了 CSS 变量', '--zz-probe'] },
    { name: 'M30 base.css 注释里的 0.9 改成 0.85（⑯ 的注释 ⇄ 常量）', file: CSS_PATH, flag: '--css', find: '读数**垫在 `rgba(r,g,b, 0.9)`', repl: '读数**垫在 `rgba(r,g,b, 0.85)`', expect: ['⑯ base.css 注释里写死的透明度'] },
    // ⑩ 扩到 §11 之后的两个变异：条目整个没了（旧 ⑩ 一声不响），以及「词还在、但已经不是那一条的了」。
    { name: 'M31 任务 15 清单里去掉「冷启动不闪色」那条的粗体（⑩ §11 的命中）', file: PLAN_PATH, flag: '--plan', find: '- [ ] **冷启动不闪色**：先换成一套底色反差大的皮肤', repl: '- [ ] 冷启动不闪色：先换成一套底色反差大的皮肤', expect: ['⑩ 规格 §11 的验收标准在任务 15 里找不到对应关键词'] },
    { name: 'M32 清单里再插一条含同一关键词的条目（⑩ §11 的选词唯一性）', file: PLAN_PATH, flag: '--plan', find: '### 背景照片\n- [ ] **没有照片时', repl: '### 背景照片\n- [ ] **冷启动不闪色**（复验）\n- [ ] **没有照片时', expect: ['⑩ 规格 §11 的关键词在任务 15 里的出现次数不为 1'] },
    // ⑮ 的两条自检：块数必须精确相等、空块必须被抓（空串是任何文件的子串，那两条断言对它是恒真的）。
    { name: 'M33 把任务 12 的一个 js 块改成别的语言标记（⑮ 的块数精确相等）', file: PLAN_PATH, flag: '--plan', find: '```js\n  // 外观排在记账配置之后', repl: '```text\n  // 外观排在记账配置之后', expect: ['⑮ 计划「任务 12」段落里的 js 代码块实测 1 个，期望 2 个'] },
    { name: 'M34 清空任务 12 的一个 js 块（⑮ 的空块断言）', file: PLAN_PATH, flag: '--plan', find: [
      '  // 外观排在记账配置之后、数据进出之前：它既不是每天要改的记账配置，',
      '  // 也不是「把数据搬进搬出」那种一次性动作，但它是用户会想反复调的那一类。',
      '  // 它是这里**唯一**不收 { onChanged } 的入口（openAppearanceSheet 声明的是无参）——不影响 swapTo：',
      '  // 多传一个对象 JS 本来就允许，函数忽略它即可；而它也确实不需要父面板刷新（改的是 CSS 变量，',
      '  // 不是设置面板的内容）。',
      "  { id: 'appearance', label: '外观与背景', open: openAppearanceSheet },"
    ].join('\n'), repl: '', expect: ['是空块'] }
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
      // tests/ 也要复制：⑮ 的镜像表里有指向 `tests/theme.test.js` 与 `tests/schema.test.js` 的块，
      // 缺了它们那条断言会在「目标文件读不到」上红——那是副本不全，不是镜像漂移（红的原因会指错地方）。
      for (const d of ['styles', 'docs', 'app', 'tests']) safeCpDir(path.join(ROOT, d), path.join(FR, d));
      safeCpDir(path.join(ROOT, 'sw.js'), path.join(FR, 'sw.js'));
      // 根目录那几个文件也要复制：⑮ 的镜像表里有指向 index.html 的块，缺了它这条断言会在
      // 「目标文件读不到」上红——那是副本不全，不是镜像漂移（红的原因会指错地方）。
      for (const f of ['index.html', 'manifest.webmanifest']) safeWrite(path.join(FR, f), read(path.join(ROOT, f)));
      // 两种用法：`change` 指定改副本里的哪个文件（给「styles/ 里某条规则被删掉」这类变异用——那些
      // 文件走不了 --css / --store 的覆盖）；不写 change 就是老用法，把 base.css 的行尾统一成 LF。
      if (c.change) {
        const cp = path.join(FR, c.change.file);
        const before = readFileSync(cp, 'utf8');
        const after = before.replace(c.change.find, c.change.repl);
        if (after === before) { console.error(`✗ ${c.name}：副本里 ${c.change.file} 的锚点没匹配上，变异没落地`); process.exit(2); }
        write(cp, after);
      } else {
        const bp = path.join(FR, 'styles/base.css');
        const before = readFileSync(bp, 'utf8');
        const after = before.replace(/\r\n/g, '\n');
        if (after === before) { console.error(`✗ ${c.name}：base.css 本来就没有 CRLF，变异没落地`); process.exit(2); }
        write(bp, after);
      }
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
