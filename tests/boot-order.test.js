// 首屏启动顺序与预缓存清单的守卫（任务 10 的产物）。
//
// 为什么需要它：这一步动的是首屏关键路径，而它在 Node 里**看不见**。加它之前实测（三个变异逐个做在
// 仓库外的副本上）：把那次 `await` 挪到 `mount` 之后、删掉 `.catch`、把 `??=` 改成 `=`——**全量测试
// 266 条全绿、check-theme-css.mjs 59 项全过**，零告警。原因是 tests/ 里唯一碰 main.js 的是
// dev-server.test.js（只断言 200 与 MIME），而那个静态核验脚本当时不读 ASSETS / CACHE（它现在读了：
// ⑬ 是后来补的，见 scripts/check-theme-css.mjs）。
//
// **这一层自己也会瞎**（返工第二轮踩到的）：抽取正则只认一种引号、又不写「抽取失效」断言，就会出现
// 「一个模块都没抽到、断言照样全绿」。所以下面每一处抽取都配了失效断言——入口必须在、数量不能塌——
// 而不是只写一个宽松的下限。守住这一点比多写一条断言重要：守卫静默失明比没有守卫更危险。
//
// 它守的是**形状**（位置、唯一性、闭合），不是渲染。渲染层那一半（第一眼看到的是不是已选皮肤）只能靠
// 任务 15 的真机验收——本机没有浏览器（puppeteer-core 未装、Edge headless 被沙箱挡住）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = rel => readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const mainSrc = read('app/main.js');
const swSrc = read('sw.js');

// 剥掉 JS 注释（字符串感知），**保留换行**——行号必须对得上。
// 为什么不能按行切 `//`：`'http://…'` 这种字符串里的 `//` 不是注释起点，按行切会把那一行后面的代码
// 一起吃掉。仓库里真有这种行（`app/ui/stats-view.js` 的 `SVG_NS`），所以「仓库里没有字符串含 `//` 的行」
// 这种前提是假的，不能拿来当剥离实现的依据。
// **边界**：不解析正则字面量内部（app/ 与 sw.js 里没有以 `//` 或 `/*` 开头的正则），也不展开模板串的
// `${}`。真出现那两种写法时，由下面那条「剥注释不改变行数」的自检兜住形态。
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n'; // 块注释里的换行保留，否则后面的行号全错
        i++;
      }
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      out += c; i++;
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

const mainCode = stripComments(mainSrc);
const mainCodeLines = mainCode.split('\n');
function lineNo(re) {
  const i = mainCodeLines.findIndex(l => re.test(l));
  assert.notEqual(i, -1, `锚点没找到（${re}）——这条断言的定位方式失效了，别当成通过`);
  return i + 1;
}

// ASSETS 清单：**惰性**取，取不到就在调用它的那条断言里红。
// 早先写成模块顶层的 IIFE，锚点失效会让整个文件在加载期抛错——其余 5 条一条都不跑，
// 结果报出来是「tests 267 / fail 1」，看起来像「只挂了一条」，其实整份守卫都没跑。
function assetsItems() {
  const m = /const ASSETS = \[([\s\S]*?)\];/.exec(swSrc);
  assert.ok(m, 'sw.js 里没找到 `const ASSETS = [ … ];`（锚点失效——这条断言没跑，别当成通过）');
  return [...m[1].matchAll(/'([^']+)'|"([^"]+)"/g)].map(x => x[1] ?? x[2]);
}
const normalize = p => path.posix.normalize(p.replace(/^\.\//, ''));

// 从 HTML 里抽 `src=` / `href=`：**单双引号都认**。
// 只认双引号的话，把 `src` 改成单引号就能让抽取静默归零——那时闭包只剩 index.html 自己，
// 而「没有任何模块不在 ASSETS 里」照样成立，绿得毫无意义。
function htmlRefs(html) {
  return [...html.matchAll(/(?:src|href)=["'](\.\/[^"']+)["']/g)].map(m => m[1]);
}
// 静态 import 的说明符：单双引号都认，且**先剥注释**（注释里举例写一句 `from './x.js'` 不该被当成依赖）。
function staticSpecifiers(src) {
  return [...stripComments(src).matchAll(/from\s+["']([^"']+)["']/g)].map(m => m[1]);
}
// 首屏资源集合＝index.html 的引用 + 入口的 import 闭包。**抽成一个函数**，是为了让「自检」那条与
// 「闭包 ⊆ ASSETS」那条用同一份逻辑：早先自检自己写了一遍一层遍历，量的东西根本不是一个量。
// **边界**：只认静态 `from '…'` / `from "…"`；动态 `import('…')` 看不见——那是漏检，不是误报。
function firstPaintRefs() {
  const refs = htmlRefs(read('index.html'));
  assert.ok(refs.includes('./app/main.js'),
    `index.html 的引用里没抽到入口脚本 ./app/main.js（只抽到 ${refs.length} 条）——抽取失效了，别当成通过`);
  const seen = new Set();
  const stack = [...refs];
  while (stack.length) {
    const rel = stack.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (!rel.endsWith('.js')) continue;
    for (const s of staticSpecifiers(read(rel.replace(/^\.\//, '')))) {
      if (!s.startsWith('.')) continue;
      stack.push(path.posix.normalize(path.posix.join(path.posix.dirname(rel), s)));
    }
  }
  return seen;
}

test('守卫自身的前提：剥注释不改变行数，抽取能抽到入口与足量模块', () => {
  // 这一条是「守卫的守卫」。它红了说明下面几条的行号/闭包都不可信，先修它。
  assert.equal(mainCode.split('\n').length, mainSrc.split('\n').length,
    '剥注释改变了 main.js 的行数——下面的行号断言会整体错位');
  const refs = htmlRefs(read('index.html'));
  assert.ok(refs.includes('./app/main.js'),
    `index.html 的引用里没抽到入口脚本 ./app/main.js（抽到 ${refs.length} 条）——抽取失效了，别当成通过`);
  const jsCount = [...firstPaintRefs()].filter(p => p.endsWith('.js')).length;
  assert.ok(jsCount >= 45,
    `首屏闭包里只走到 ${jsCount} 个 .js 模块（实测基线 50，下限取 45）——抽取多半失效了`);
});

test('main.js 里主题初始化只有一处，且是 `await (themeReady ??= initTheme().catch(…))`', () => {
  const calls = mainCode.match(/initTheme\s*\(/g) ?? [];
  assert.equal(calls.length, 1,
    `initTheme() 在 main.js 的代码里出现了 ${calls.length} 次（期望恰好 1 次）。`
    + '它挂在模块级的 themeReady 上，就是为了「一次冷启动只跑一遍、且先于挂载」。');
  // `??=` 是「读-判断-写」的同步整体：并发进来的第二次 render() 复用同一个 promise。
  // 改成 `=` 就没有这层保证（每次 render 都重新调一次 initTheme）；漏掉 `.catch` 则会让主题失败
  // 直接抛在 render() 的 try 之外——一个 mount 都不会发生，页面纯空白。
  assert.match(mainCode, /await\s*\(\s*themeReady\s*\?\?=\s*initTheme\(\)\s*\.catch\(/,
    '首屏那次主题初始化必须写成 `await (themeReady ??= initTheme().catch(...))`：'
    + '`??=` 保证只跑一次、`.catch` 保证主题失败不拖垮整页（少了它连 mount 都不会发生）。');
});

test('主题那次 await 在 render() 的两次 mount() 之前', () => {
  const awaitLine = lineNo(/await \(themeReady \?\?= initTheme\(\)\.catch\(/);
  const firstMountLine = lineNo(/mount\(/);
  const appMountLine = lineNo(/mount\(app,/);
  assert.ok(awaitLine < firstMountLine,
    `主题 await 在第 ${awaitLine} 行、第一处 mount() 在第 ${firstMountLine} 行。`
    + '挪到挂载之后就是「先把内容画出来、再上色」——冷启动会闪一下默认色。');
  assert.ok(awaitLine < appMountLine,
    `主题 await 在第 ${awaitLine} 行、mount(app, …) 在第 ${appMountLine} 行——顺序反了。`);
});

test('themeReady 只有「一次声明 + 一次使用」', () => {
  const decl = mainCodeLines.filter(l => /let\s+themeReady\s*=\s*null\s*;/.test(l)).length;
  const used = mainCodeLines.filter(l => /themeReady/.test(l)).length;
  assert.equal(decl, 1, `themeReady 的声明有 ${decl} 处（期望 1 处）`);
  assert.equal(used, 2,
    `themeReady 在代码里出现在 ${used} 行（期望 2 行：声明 + 唯一那次使用）。`
    + '多出来的那一行通常意味着有人在渲染路径上又调了一次 initTheme——那会让「只跑一遍」失效。');
});

test('sw.js 的 ASSETS 里有首屏依赖链上的 theme-store.js 与 theme.js，且 CACHE 是单处 const', () => {
  const items = assetsItems();
  for (const p of ['./app/theme-store.js', './app/theme.js']) {
    assert.ok(items.includes(p),
      `ASSETS 里缺少 ${p}（清单共 ${items.length} 条）。它在首屏静态依赖链上（main → theme-store → theme）：`
      + '漏掉的后果不是「少一份缓存」，而是离线时这个请求缓存未命中 → 回退 index.html → '
      + '模块脚本被 MIME 检查拒绝，app 起不来（机制见 sw.js 开头那段）。');
  }
  const decls = swSrc.match(/const CACHE = '[^']+'/g) ?? [];
  assert.equal(decls.length, 1, `CACHE 的 const 声明有 ${decls.length} 处（期望 1 处）`);
  assert.match(swSrc, /const CACHE = 'pvault-v\d+';/, 'CACHE 的写法不是 `const CACHE = \'pvault-vN\';`');
});

test('首屏会用到的资源全部在 ASSETS 里（index.html 的引用 + 入口的 import 闭包）', () => {
  const seen = firstPaintRefs();
  const jsCount = [...seen].filter(p => p.endsWith('.js')).length;
  assert.ok(jsCount >= 45,
    `闭包里只有 ${jsCount} 个 .js（实测基线 50，下限取 45）——抽取多半失效了，这一条不能当成通过`);
  const items = new Set(assetsItems().map(normalize));
  const missing = [...seen].filter(r => !items.has(normalize(r))).sort();
  assert.deepEqual(missing, [],
    `这些首屏资源不在 ASSETS 里：${missing.join(' ')}\n`
    + '  两个选择：把它加进 ASSETS（白名单跟产生依赖的那次提交一起走，见 sw.js 里 v14 / v16 / v17 三段），'
    + '或者它本来就不该挂在首屏静态链上。');
});

test('sw.js 里带引号的相对路径，去重后与 ASSETS 清单相等', () => {
  // 这一条**故意不剥注释**：注释里举例写的带引号路径正是要抓的东西。
  // 定位是「清单外不该出现带引号的相对路径」——代码里的回退路径（`caches.match('./x')`）、注释里的举例
  // 都算；出现一个清单外的，要么是笔误，要么是引用了一个没进缓存的文件（那它离线永远拿不到）。
  // 单双引号都认；set(清单) 与 set(全文) **双向**比，不只查「有没有多出来的」。
  const listed = new Set(assetsItems());
  const quoted = new Set([...swSrc.matchAll(/'(\.\/[^']*)'|"(\.\/[^"]*)"/g)].map(m => m[1] ?? m[2]));
  assert.ok(listed.size > 0 && quoted.size > 0,
    `抽取失效：清单 ${listed.size} 条、全文带引号路径 ${quoted.size} 条`);
  const outside = [...quoted].filter(p => !listed.has(p)).sort();
  const notPrefixed = [...listed].filter(p => !quoted.has(p)).sort();
  assert.deepEqual(outside, [],
    `这些带引号的相对路径出现在 sw.js 里、却不在 ASSETS 里：${outside.join(' ')}\n`
    + '  在注释里就把它写成不带引号的形式；真的要用就加进 ASSETS（否则它永远不在缓存里）。');
  assert.deepEqual(notPrefixed, [],
    `ASSETS 里这些条目没有以 ./ 开头的同形写法：${notPrefixed.join(' ')}\n`
    + '  清单条目一律写成 \'./…\'（sw.js 的既有约定），写错形态会让它躲过全文比对。');
});
