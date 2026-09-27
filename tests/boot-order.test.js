// 首屏启动顺序与预缓存清单的守卫（任务 10 的产物）。
//
// 为什么需要它：这一步动的是首屏关键路径，而它在 Node 里**看不见**。返工那轮实测（三个变异逐个做在
// 仓库外的副本上）：把那次 `await` 挪到 `mount` 之后、删掉 `.catch`、把 `??=` 改成 `=`——**全量测试
// 266 条全绿、check-theme-css.mjs 59 项全过**，零告警。原因是 tests/ 里唯一碰 main.js 的是
// dev-server.test.js（只断言 200 与 MIME），而那个静态核验脚本全文不读 ASSETS / CACHE。
// 这里补的就是这一层：不依赖 DOM 的文本级断言——读文件、定位那几行、按结构断言。
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

// 行号按 \n 计（上面已经归一化过行尾），与计划里写的行号是同一个口径。
const mainLines = mainSrc.split('\n');
// 「代码行」＝去掉行尾注释。仓库里没有字符串内含 `//` 的行（实测 grep），所以行级剥离够用；
// 这一步是必要的：主题那段注释里就写着 `initTheme()` 与 `themeReady`，不剥掉会把注释算成一次调用。
const codeLines = mainLines.map(l => l.replace(/\/\/.*$/, ''));
const codeSrc = codeLines.join('\n');
function lineNo(re) {
  const i = codeLines.findIndex(l => re.test(l));
  assert.notEqual(i, -1, `锚点没找到（${re}）——这条断言的定位方式失效了，别当成通过`);
  return i + 1;
}

const ASSETS_BLOCK = (() => {
  const m = /const ASSETS = \[([\s\S]*?)\];/.exec(swSrc);
  assert.ok(m, 'sw.js 里没找到 ASSETS 数组（锚点失效）');
  return m[1];
})();
const assetsItems = () => [...ASSETS_BLOCK.matchAll(/'([^']+)'/g)].map(m => m[1]);
const normalize = p => path.posix.normalize(p.replace(/^\.\//, ''));

test('main.js 里主题初始化只有一处，且是 `await (themeReady ??= initTheme().catch(…))`', () => {
  const calls = codeSrc.match(/initTheme\s*\(/g) ?? [];
  assert.equal(calls.length, 1,
    `initTheme() 在 main.js 的代码里出现了 ${calls.length} 次（期望恰好 1 次）。`
    + '它挂在模块级的 themeReady 上，就是为了「一次冷启动只跑一遍、且先于挂载」。');
  // `??=` 是「读-判断-写」的同步整体：并发进来的第二次 render() 复用同一个 promise。
  // 改成 `=` 就没有这层保证（每次 render 都重新调一次 initTheme）；漏掉 `.catch` 则会让主题失败
  // 直接抛在 render() 的 try 之外——一个 mount 都不会发生，页面纯空白。
  assert.match(codeSrc, /await\s*\(\s*themeReady\s*\?\?=\s*initTheme\(\)\s*\.catch\(/,
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
  const decl = codeLines.filter(l => /let\s+themeReady\s*=\s*null\s*;/.test(l)).length;
  const used = codeLines.filter(l => /themeReady/.test(l)).length;
  assert.equal(decl, 1, `themeReady 的声明有 ${decl} 处（期望 1 处）`);
  assert.equal(used, 2,
    `themeReady 在代码里出现在 ${used} 行（期望 2 行：声明 + 唯一那次使用）。`
    + '多出来的那一行通常意味着有人在渲染路径上又调了一次 initTheme——那会让「只跑一遍」失效。');
});

test('sw.js 的 ASSETS 里有首屏依赖链上的 theme-store.js 与 theme.js，且 CACHE 是单处 const', () => {
  const items = assetsItems();
  for (const p of ['./app/theme-store.js', './app/theme.js']) {
    assert.ok(items.includes(p),
      `ASSETS 里缺少 ${p}。它在首屏静态依赖链上（main → theme-store → theme）：`
      + '漏掉的后果不是「少一份缓存」，而是离线时这个请求缓存未命中 → 回退 index.html → '
      + '模块脚本被 MIME 检查拒绝，app 起不来（机制见 sw.js 开头那段）。');
  }
  const decls = swSrc.match(/const CACHE = '[^']+'/g) ?? [];
  assert.equal(decls.length, 1, `CACHE 的 const 声明有 ${decls.length} 处（期望 1 处）`);
  assert.match(swSrc, /const CACHE = 'pvault-v\d+';/, 'CACHE 的写法不是 `const CACHE = \'pvault-vN\';`');
});

test('首屏会用到的资源全部在 ASSETS 里（index.html 的引用 + 入口的 import 闭包）', () => {
  const html = read('index.html');
  const refs = [...html.matchAll(/(?:src|href)="(\.\/[^"]+)"/g)].map(m => m[1]);
  assert.ok(refs.length >= 5, `index.html 里只找到 ${refs.length} 个 ./ 引用——提取方式可能失效了`);
  // 沿 import 走一遍。**边界**：只认静态 `from '…'`（仓库里全是这种写法）；将来若出现动态
  // import('…')，这条断言看不见它——那是漏检，不是误报。
  const seen = new Set();
  const stack = [...refs];
  while (stack.length) {
    const rel = stack.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (!rel.endsWith('.js')) continue;
    const src = read(rel.replace(/^\.\//, ''));
    for (const m of src.matchAll(/from\s+'([^']+)'/g)) {
      if (!m[1].startsWith('.')) continue;
      stack.push(path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1])));
    }
  }
  const items = new Set(assetsItems().map(normalize));
  const missing = [...seen].filter(r => !items.has(normalize(r))).sort();
  assert.deepEqual(missing, [],
    `这些首屏资源不在 ASSETS 里：${missing.join(' ')}\n`
    + '  两个选择：把它加进 ASSETS（白名单跟产生依赖的那次提交一起走，见 sw.js 里 v14 / v16 / v17 三段），'
    + '或者它本来就不该挂在首屏静态链上。');
});

test('sw.js 全文里带引号的相对路径，去重后与 ASSETS 清单一致', () => {
  // 这条守的是任务 14 那支「从 sw.js 里数路径」的校验脚本的盲区：那支脚本按**全文**匹配、不看上下文，
  // 注释里举例写一句带引号的路径就会被算成一条清单条目——返工那轮实测踩到过（条数 57 → 58，
  // Test-Path 全通过、只有数字变了）。这里把集合关系钉死：全文里的带引号路径不许有清单外的。
  const all = [...new Set([...swSrc.matchAll(/'(\.[^']*)'/g)].map(m => m[1]))];
  const items = new Set(assetsItems());
  const extra = all.filter(p => !items.has(p));
  assert.deepEqual(extra, [],
    `这些带引号的相对路径出现在 sw.js 里、却不在 ASSETS 里：${extra.join(' ')}\n`
    + '  若出在注释里，把它写成不带引号的形式，否则数路径的校验脚本会把条数数多。');
});
