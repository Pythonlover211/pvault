// 运行时语法 / API 的「设备相关」下限守卫。
//
// 为什么需要它（事后补的，来由是一次实测事故）：v1.3.0 装进 Android 11 模拟器（系统 WebView 是
// **Chrome 83**）之后整页白屏，CDP 里抓到的唯一异常是 `SyntaxError: Unexpected token '='`，出处在
// `app/main.js` 里的 `themeReady ??= initTheme()…`。`??=` 是 ES2021（Chrome 85+），在 83 上**解析阶段**
// 就失败：整个模块图加载不起来（`data-theme` 仍是 null、数据库一行都没动），**连 try/catch 兜底的机会
// 都没有**。那次事故里全量测试与 `scripts/check-theme-css.mjs` 全绿——没有一条守卫看得见「用了目标设备
// 解析不了的语法」这件事。
//
// 与 `app/backup.js` 开头那条注释是同一条纪律：安卓系统 WebView 的版本由设备决定，不能按「我这台开发机
// 够新」写代码。下面那张表按 Chrome 版本排列，最低的一条是 `WeakRef` / `FinalizationRegistry` 的 84。
//
// **版本号的来源与可信度**：表里的版本号来自 MDN 兼容表的知识记录，写这条守卫的机器**没能联网核对**
// （`Invoke-WebRequest` 与 Node 的 `fetch` 都被环境挡住）。改这张表时请顺手核一眼，尤其别把 Chrome 83
// 就支持的东西加进来——**误报比漏报更危险**：假红会让人把整条守卫删掉。
// 明确**不在**表里的（Chrome 83 已有，加进来就是假红）：`?.`、`??`、`flatMap`、`Object.fromEntries`、
// `String.prototype.matchAll`、`Promise.allSettled`、`globalThis`、`import.meta`、`padStart` / `padEnd`。
//
// **边界（别把这条守卫当全量，它只是一层）**：
//   · 它只认表里那几种**具体写法**，不解析语法树。表外的旧语法它看不见——那类问题仍然只能靠真机
//     验收发现，这一层只是把**已经踩过的那一类**钉死。
//   · 顶层 await 的判定口径是「行首（零缩进）就是 `await`」：函数体里的 `await` 一定带缩进，所以不误报；
//     代价是顶层 await 若写成带缩进的样子会漏检（本仓库没有那种写法，函数内的 await 都带缩进）。
//   · 它管「存不存在」，不管「行为差异」。
//   · 它只扫**会被设备执行**的文件（`app/**/*.js`、`sw.js`、`index.html`）；`tests/` 与 `scripts/`
//     跑在 Node 上（版本我们自己定），扫进来只会把「Node 的新特性」误判成设备问题。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const rel = abs => path.relative(ROOT, abs).split(path.sep).join('/');

// `/` 是正则起点还是除法？按它**前面最近的那个 token** 判。
// 这是 JS 里的经典歧义（`a = /re/` 对 `a = b / c`），判错的代价不是「少剥一点」：把正则当除法，正则体
// 里的引号会被当成字符串起点，**从那一行起、后面所有行的注释都不再被剥掉**——注释里的东西被当违规报
// （假红），注释**之后**的真违规被整段吃掉（假绿），而「行数不变」那条自检照样绿。
// `app/file-info.js` 里那个 Windows 非法字符集正则 `/[/\\:*?"<>|]/g` 就含一个 `"`，实测能让它后面
// 7 行注释全部失明。
// 判据：标识符 / 数字 / 字符串 / 正则 / `]` 之后是除法；`if (…)` 这类**控制语句头**的收尾括号之后是
// 语句位置（正则）；关键字（`return` `typeof` `throw` `case` …）与运算符、`(` `,` `=` `:` `[` `{` `;`
// 之后是正则。
//
// **判据的边界（逐条实测过；守卫就此冻结，不再往下修——它不解析语法树）**：它只看得见「前一个 token」。
// 下面这些是**真实存在的窗口**，后果都是「这一行后面的注释不再被剥」（假红或假绿）：
//   · **`}` 之后**：`const x = { a: 1 } / 2; // 注释` 里的 `}` 是**对象字面量**收尾（除法），而
//     `if (x) { … } /re/.test(s)` 里的 `}` 是**块**收尾（正则）。分清它需要「`{}` 是块还是对象」的
//     上下文栈。现在把 `}` 之后当正则起点，于是前一种写法把后面半行当正则吞掉、该行的注释不再被剥
//     （实测：`const x = { a: 1 } / 2; // __probe_cmt ??= 1` 剥完与原文一模一样）。
//   · **后缀 `++` / `--` 之后**：`const avg = total++ / count;` 同理（`prev` 只剩一个 `+`）。
//   · **`for await (…)` 之后**：那个 `(` 前的 token 是 `await`，不在那 6 个控制流关键字里，所以不打
//     `)stmt` → `)` 之后被判成除法（实测：`for await (const x of gen()) /[//]/.test(s); <真违规>` 里
//     的真违规被整段吃掉）。要修得再往前看一个 token（`await` 前是不是 `for`）。
//   · **与关键字同形的属性名**：`const r = o.catch(h) / 2; // …` —— `(` 前的 token 是 `catch`（与关键字
//     同形）→ 打成 `)stmt` → 那一行的 `/` 被当正则、行尾注释不再被剥（**偏严**：实测剥完与原文一样）。
//     `o.if(x) / 2`、`o.for(x) / 2` 之类同理。**只有紧接着 `/` 才受影响**，而且 `) /` 的兜底在下面那条
//     对账检测（偏严会当场报红，不会静默）。
//   这四条**有意不修**（裁定：复杂度换极罕见写法不值）：`{}` 上下文栈、以及属性名的特判都不要。
//   防线不在「判得对」，而在**对账检测**——这类判错的表现就是「这行有注释却没被剥」，它当场报红。
//
// **不构成窗口的（别再往上面那张单子里加）**：`break` / `continue` 之后——它们的文法后继只能是 `;`、
// label 或 `}`，`/` 不可能紧跟其后，`;` 会照常把后面判成语句位置（实测：
// `while (1) { break; } /[//]/.test(s); <真违规>` 的真违规**保留**；能造出逃逸的那个样本
// `break lbl /re/` 过不了 `node --check`，不是合法 JS）。`do { } while (x) /re/`、`switch` 的
// `case …:` 之后、以及 `label: /re/` 这三处**判得是对的**（`while (x)` 的 `)` 打了 `)stmt`，`:` 之后
// 本来就走「运算符之后是正则」那一支）。
function startsRegex(prev) {
  if (prev === '') return true; // 文件或语句的开头
  // `)stmt` 是给**控制语句头**的收尾括号打的标记（见 stripComments 里的括号栈）：`if (x) /re/.test(s)`
  // 里那个 `)` 之后是**语句位置**，`/` 只能是正则；而 `f(x) / 2` 的 `)` 之后是表达式位置（除法）。
  // 只看一个 token 分不出来，所以扫描时顺手记下「这个 `(` 前面是不是 if/while/for/with/switch/catch」。
  if (prev === ')stmt') return true;
  if (prev === ')') return false;
  if (/[\w$\]'"`]/.test(prev)) {
    return /^(?:return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await|throw|debugger)$/.test(prev);
  }
  return true;
}

// 剥掉 JS 注释（字符串感知 + 正则字面量感知），**保留换行**——行号必须对得上。
// 与 `tests/boot-order.test.js` 里的 stripComments 是同一份实现（**改这个实现时两边一起改**）：那边也剥
// 注释，理由一样——注释里举例写一句被禁的写法（比如本文件与 `app/main.js` 里解释 `??=` 的那几行）
// 不该让守卫红。
// 为什么不能按行切 `//`：`'http://…'` 这类字符串里的 `//` 不是注释起点（`app/ui/stats-view.js` 的
// SVG_NS 就是这种行），按行切会把那一行后面的代码一起吃掉。
// **边界**：不展开模板串的 `${}`（整串当字符串跳过）；正则没闭合时按「其实不是正则」处理，不吞掉后面
// 的代码。这两条边界由下面那条「失明检测」兜住。
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let prev = ''; // 上一个 token：标识符（整词）、字面量/正则结束（记作 ')'）、或单个符号
  const parens = []; // 每个 `(` 是不是控制语句头（if/while/for/with/switch/catch），供 `)` 收尾时打标
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
    if (c === '/' && startsRegex(prev)) {
      out += c; i++;
      let inClass = false;
      while (i < n) {
        const ch = src[i];
        if (ch === '\\') { out += ch + (src[i + 1] ?? ''); i += 2; continue; }
        if (ch === '\n') break; // 没闭合：当它其实是除法，别再吞
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) { out += ch; i++; break; }
        out += ch; i++;
      }
      while (i < n && /[a-z]/i.test(src[i])) { out += src[i]; i++; } // flags
      prev = ')';
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
      prev = ')';
      continue;
    }
    if (/[\w$]/.test(c)) {
      let w = '';
      while (i < n && /[\w$]/.test(src[i])) { w += src[i]; out += src[i]; i++; }
      prev = w;
      continue;
    }
    if (/[0-9]/.test(c)) {
      while (i < n && /[\w.]/.test(src[i])) { out += src[i]; i++; }
      prev = ')';
      continue;
    }
    if (c === '(') { parens.push(/^(?:if|while|for|with|switch|catch)$/.test(prev)); prev = '('; out += c; i++; continue; }
    if (c === ')') { prev = parens.pop() === true ? ')stmt' : ')'; out += c; i++; continue; }
    if (!/\s/.test(c)) prev = c;
    out += c; i++;
  }
  return out;
}

// 这一行「代码区里有没有行注释起点」——判据是「`//` 出现在行首（允许缩进），**或**它的前后至少一边是
// 空白 / 行边界」。
// **为什么不用 `startsRegex` 去挖正则**：对账判据若与剥离器共用同一套正则/除法推断，就会**与它一起判错**
// ——实测踩到过：`const x = { a: 1 } / 2; // 说明`（`}` 被判成正则、后半行被吞掉的那种漏剥）用带正则识别的
// 扫描去看，`//` 已经被拆散（第一个 `/` 被当成正则的开头吞了），对账什么都看不见，构造样本断言直接红。
// 所以这里只挖**引号里的内容**（字符串 / 模板串），对 `/` 不做任何推断；而「前后至少一边是空白」这个形态
// 判据本身就把正则里的字符类 `/[//]/`（前 `[` 后 `]`）与 URL 里的 `://`（前 `:` 后 `x`）排除掉了。
// **边界**：引号未闭合时（跨行模板串）会把行尾一起挖掉 → 只让对账偏严（多报），不会漏。
function hasLineComment(line) {
  let masked = '';
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === "'" || c === '"' || c === '`') {
      i++;
      while (i < line.length) {
        if (line[i] === '\\') { i += 2; continue; }
        const done = line[i] === c;
        i++;
        if (done) break;
      }
      continue;
    }
    masked += c;
    i++;
  }
  return /(^|[ \t])\/\//.test(masked) || /\/\/($|[ \t])/.test(masked);
}

// **对账**：返回这一份文本里「有注释却没被剥掉」的行（① 行首注释 ② 代码区里带 `//` 的行尾注释）。
// 抽成函数是为了让**仓库扫描**与**构造样本**用同一套判据——构造样本是这条判据的变异证明：把判据退回
// 「只查行首 `//`」时，样本断言必须红（否则这条防线就是自说自话）。
function reconcileLines(label, raw) {
  const code = stripComments(raw);
  assert.equal(code.split('\n').length, raw.split('\n').length,
    `${label} 剥注释改变了行数——下面的行号会整体错位，先修 stripComments`);
  const codeLines = code.split('\n');
  const bad = [];
  raw.split('\n').forEach((l, i) => {
    const cl = codeLines[i] ?? '';
    if (/^[ \t]*\/\//.test(l) && cl.trim() !== '') {
      bad.push(`${label}:${i + 1}: 行首注释没被剥 → ${l.trim()}`);
    } else if (hasLineComment(l) && cl.length >= l.length) {
      bad.push(`${label}:${i + 1}: 代码区里有 \`//\` 但这一行剥完没变短（行尾注释漏剥）→ ${l.trim()}`);
    }
  });
  return bad;
}

// —— 被禁的语法 / API 表（按 Chrome 版本升序）——
// `allow({ raw, match, code, lines, lineIndex })` 是**逐命中**的放行判定，返回 true 表示放行。
// 两种用法都在用：`structuredClone` 是**例外式**（带保护性检测的调用是正确写法），正则 `d` flag 那条是
// **条件式**（flags 里没有 d 就没事）。两种都要求「至少被执行到一次」——放行逻辑从来没跑过时，
// 「违规 0 处」这句话对它没有意义（见最后那条断言）。
const RULES = [
  {
    name: 'WeakRef()',
    re: /WeakRef\s*\(/g,
    why: 'Chrome 84+'
  },
  {
    name: 'FinalizationRegistry()',
    re: /FinalizationRegistry\s*\(/g,
    why: 'Chrome 84+（清理回调依赖 GC，旧设备上连构造函数都没有）'
  },
  {
    name: '逻辑赋值运算符（??= / ||= / &&=）',
    re: /\?\?=|\|\|=|&&=/g,
    why: 'ES2021，Chrome 85+。低版本 WebView 上解析阶段就失败 → 整页白屏（连 catch 都进不去）'
  },
  {
    name: 'String.prototype.replaceAll()',
    re: /\.replaceAll\s*\(/g,
    why: 'Chrome 85+（本项目自己的 DB 层方法已改名 replaceAllRecords，所以这里不再放行任何成员调用）'
  },
  {
    name: 'Promise.any()',
    re: /Promise\.any\s*\(/g,
    why: 'Chrome 85+'
  },
  {
    name: '顶层 await',
    re: /(?:^|\n)await\b/g,
    why: 'ES2022 模块顶层 await，Chrome 89+。与 `??=` 同级：低版本上**解析阶段**就失败 → 整页白屏'
  },
  {
    name: '正则 d flag（hasIndices）',
    // flags 只认合法字符集 `[dgimsuvy]`，并要求它后面**不是标识符字符**：两条一起才能把
    // `const x = a / b/duration;` 这种**除法链 + 贴着一个 d 开头的除数**排除掉（复审实测的假红）——
    // 贪婪匹配先把 `du` 当 flags，后面紧跟 `r` 让断言失败、回溯到 `d`（后跟 `u`）仍失败，整条不命中。
    // **边界（有意保留，不再往下补）**：字符串 / 模板串里的路径消不掉——那需要「这段在不在字符串里」的
    // 语境信息，属于「不解析语法树」的固有代价。命不命中**取决于路径 / 除数的结尾字符**：实测
    // `'a{background:url(/img/d)}'`、`` `${base}/img/d` ``、`a / b/d;` 这三种都会**命中**（起点字符类
    // 含空格与 `}`，内容段又能凑出一对 `/`），而我放进自检的那三个样本恰好不命中——
    // **别把「我挑的样本不命中」读成「这类写法都不命中」**。
    re: /(?:^|[=(,:[!&|?;{}\s])\/(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n])+\/([dgimsuvy]*)(?![a-z0-9_$])/g,
    why: 'Chrome 90+（`/…/d` 的 hasIndices）。旧 WebView 上正则会以 Flags 不合法抛 SyntaxError',
    allow: ({ match }) => !(match[1] ?? '').includes('d')
  },
  {
    name: '.at()',
    re: /\.at\s*\(/g,
    why: 'Chrome 92+（Array / String 的 .at）。旧 WebView 上这个方法不存在，调用处 TypeError'
  },
  {
    name: 'crypto.randomUUID()',
    re: /crypto\.randomUUID\s*\(/g,
    why: 'Chrome 92+（旧设备上只有 getRandomValues，调用处 TypeError）'
  },
  {
    name: 'Object.hasOwn()',
    re: /Object\.hasOwn\s*\(/g,
    why: 'Chrome 93+（要判自有属性就用 Object.prototype.hasOwnProperty.call）'
  },
  {
    name: '类静态初始化块（static { }）',
    re: /\bstatic\s*\{/g,
    why: 'Chrome 94+（类里的文法，低版本上解析阶段就失败）'
  },
  {
    name: '.findLast() / .findLastIndex()',
    re: /\.findLast(?:Index)?\s*\(/g,
    why: 'Chrome 97+'
  },
  {
    name: 'structuredClone()',
    re: /structuredClone\s*\(/g,
    why: 'Chrome 98+（没有它时备份导出整条路会抛 "structuredClone is not defined"）',
    // 只有「裸调用」算违规。放行条件是**同一行**出现保护性检测 `typeof structuredClone === 'function'`
    // ——`app/backup.js` 的 clone 就是「同行检测 + 同行 return」的写法。
    // 口径卡在同行的理由（复审实测的两个反例）：`const __t = typeof structuredClone;` 那种**只探测、
    // 没有任何回退分支**的写法不该被放行；写成 `if (typeof structuredClone !== 'function') return
    // structuredClone(v)`（条件写反）同样不该被放行。
    // 代价：「检测在一个 if 里、调用在下一行」的块写法会被判违规——那时把它改成同行的 return 形式即可
    // （本仓库已经是这种形态）。
    allow: ({ raw }) => /typeof\s+structuredClone\s*===\s*['"]function['"]/.test(raw)
  },
  {
    name: '.toSorted() / .toReversed()',
    re: /\.to(?:Sorted|Reversed)\s*\(/g,
    why: 'Chrome 110+（Array 的「复制版」排序方法）'
  },
  {
    name: 'Object.groupBy()',
    re: /Object\.groupBy\s*\(/g,
    why: 'Chrome 117+（要分组就自己 reduce，旧设备上这个方法不存在）'
  }
];

// —— 扫描范围：真正会被设备执行的文本 ——
// `index.html` **不剥注释**：HTML 注释 `<!-- -->` 里的写法同样报出来（有意偏严——注释里留着一段
// `??=`，说明有人以为这么写是可以的，宁可让他删掉）。JS 文件剥注释，理由见 stripComments。
function runtimeTargets() {
  const js = [];
  const walk = dir => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) js.push(p);
    }
  };
  walk(path.join(ROOT, 'app'));
  js.push(path.join(ROOT, 'sw.js'));
  js.sort();
  return [
    ...js.map(abs => ({ abs, strip: true })),
    { abs: path.join(ROOT, 'index.html'), strip: false }
  ];
}

// 扫描一段文本：**整个文件一起匹配，再按匹配位置反算行号**。
// 为什么不是逐行扫：跨行的写法（`Object.hasOwn(\n  a, 'b')`、`Promise.any([\n  p])` …）在逐行扫里一条都
// 看不见——复审实测 7 种拆行写法漏了 5 种。整文件匹配顺带把缩进差异一并解决。
function scanText(file, code) {
  const lines = code.split('\n');
  const starts = [0]; // 每行起始偏移，供二分查找把「匹配位置」换成行号
  for (let i = 0; i < code.length; i++) if (code[i] === '\n') starts.push(i + 1);
  const lineIndexAt = idx => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= idx) lo = mid; else hi = mid - 1;
    }
    return lo;
  };
  const violations = [];
  const allowed = [];
  for (const rule of RULES) {
    // **每次新建正则**：规则表里那份带 `g` 的正则若被直接复用，它的 lastIndex 会被别处推高，
    // matchAll 会带着那个游标开始找 → 命中整段消失（实测踩到过：去掉 typeof 保护的 structuredClone
    // 逃过了主断言，只有「放行路径没跑过」那条把事故翻出来）。规则表只当 source/flags 容器。
    for (const m of code.matchAll(new RegExp(rule.re.source, rule.re.flags))) {
      // 命中位置要跳过匹配开头的前导空白（「顶层 await」那条的匹配含行首的换行符）
      const at = m.index + /^\s*/.exec(m[0])[0].length;
      const lineIndex = lineIndexAt(at);
      const raw = lines[lineIndex];
      // 跨行数要**去掉匹配开头的前导空白**再数：「顶层 await」那条的匹配以行首的 `\n` 开头，直接数会把
      // 单行命中报成「跨 2 行」（复审实测的显示 bug——行号反算已经跳过了前导空白，这里漏了）。
      const spanLines = (m[0].slice(/^\s*/.exec(m[0])[0].length).match(/\n/g) ?? []).length + 1;
      const hit = {
        file,
        line: lineIndex + 1,
        raw, // 保留缩进的原文（报错信息里用它定位，别再只输出 trim 之后的）
        text: spanLines > 1 ? `${raw.trim()} …（命中跨 ${spanLines} 行）` : raw.trim(),
        rule: rule.name,
        why: rule.why
      };
      const ok = rule.allow && rule.allow({ raw, match: m, code, lines, lineIndex });
      (ok ? allowed : violations).push(hit);
    }
  }
  return { violations, allowed };
}

// 惰性求值：锚点/文件出问题时只在用到它的那条断言里红，不在 import 期把整份文件炸掉
// （boot-order.test.js 踩过这个坑：模块顶层的 IIFE 一抛，其余断言一条都不跑，报出来却像「只挂了一条」）。
function scanAll() {
  const violations = [];
  const allowed = [];
  const files = [];
  for (const { abs, strip } of runtimeTargets()) {
    const raw = readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
    const code = strip ? stripComments(raw) : raw;
    assert.equal(code.split('\n').length, raw.split('\n').length,
      `${rel(abs)} 剥注释改变了行数——下面的行号会整体错位，先修 stripComments`);
    files.push({ file: rel(abs), lines: code.split('\n') });
    const scanned = scanText(rel(abs), code);
    violations.push(...scanned.violations);
    allowed.push(...scanned.allowed);
  }
  return { violations, allowed, files };
}

const show = h => `${h.file}:${h.line}: ${h.raw}   ← ${h.rule}：${h.why}`;

test('扫描范围的前提：运行时代码都抽到了（别让守卫静默失明）', () => {
  const { files } = scanAll();
  // 实测基线（数出来的是 `runtimeTargets` 的长度）：app 下 55 个 .js + sw.js + index.html = **57**；
  // 其中 **56** 个走 `stripComments`（55 + sw.js），`index.html` 走「不剥注释」那一支。
  // （复审报的 52 是「走剥注释的那一支」的**早期**口径，不是 `files.length`——当时 app 下 51 个 .js。
  //   报销单那几个模块进来之后两个数各涨了 4（57 / 56），下限 `>= 50` 照样有量级的余量。）
  assert.ok(files.length >= 50,
    `只抽到 ${files.length} 个运行时文件（实测基线 57）——遍历多半失效了，下面的断言不能当通过`);
  for (const want of ['app/main.js', 'sw.js', 'index.html']) {
    assert.ok(files.some(f => f.file === want), `${want} 不在扫描范围里（抽到：${files.map(f => f.file).join(', ')}）`);
  }
  for (const f of files) assert.ok(f.lines.length > 5, `${f.file} 只有 ${f.lines.length} 行，像是读空了`);
});

test('剥注释的底线：行数不变 + 注释对账（漏剥当场报红，不靠形状枚举）', () => {
  // 这条是**失明检测**：剥注释一旦在某一行跑偏，从那行起后面的注释就不再被剥——注释里的东西被当违规报
  // （假红），注释**之后**的真违规被整段吃掉（假绿），而「行数不变」那半照样绿。
  // 判据取**对账**（复审建议的口径）。对每一行：
  //   ① 行首 `//` 的纯注释行，剥完必须只剩空白（旧口径，保留）；
  //   ② 该行**代码区**（把字符串内容挖掉之后）若含 `//`，那么这一行剥完必须**变短**——「这行有注释却没被
  //      剥」当场红。② 补上的正是 ① 漏掉的那一半：**行尾注释**。旧口径只查行首，所以
  //      `const x = { a: 1 } / 2; // …`（`}` 被判成正则 → 后面半行被吞）这种漏剥它一声不响。
  // **前提（已实测）**：仓库里没有「多行模板串里含行首 `//` 文本」的写法（有的话 ① 会误报，那时要先放宽）；
  // ② 在 `app/file-info.js` 那种「正则字符类里含斜杠」的行上不会误报（那种行剥完确实变短）。
  const bad = [];
  for (const { abs, strip } of runtimeTargets()) {
    if (!strip) continue; // index.html 不剥注释（HTML 里 `//` 不是注释语法）
    bad.push(...reconcileLines(rel(abs), readFileSync(abs, 'utf8').replace(/\r\n/g, '\n')));
  }
  assert.equal(bad.length, 0,
    `有 ${bad.length} 行注释没被剥掉——剥注释已经跑偏，从这些行起它看到的东西都不可信：\n  `
    + bad.join('\n  '));
  // ③ 反方向的误删：含 `://` 的字符串行必须**原样保留**（URL 不是注释）
  const urlLine = "const u = 'http://x'; const bad = list.at(-1);";
  assert.equal(stripComments(urlLine), urlLine,
    '含 `://` 的字符串行被改动了——剥注释把 URL 里的 `//` 当成注释起点切掉了后半行');
  // ④ 构造样本（判据自身的变异证明）：`}` 之后那种漏剥——已知边界、行为**有意不修**（见 startsRegex
  //    上方的边界说明）——必须被对账认出来。把对账退回「只查行首 `//`」时这条会红，这正是它存在的理由。
  const missed = reconcileLines('probe.js', 'const x = { a: 1 } / 2; // 只是一句说明');
  assert.equal(missed.length, 1,
    `对账没认出「行尾注释漏剥」的构造样本（量到 ${missed.length} 处）——判据退回了「只查行首」？`);
});

test('规则表自检：flags 恒为 `g`、每条规则的样本能命中、放行样例不被误判（守卫自己的守卫）', () => {
  // 少了这条，「规则写坏」（正则里少一个反斜杠、或者顺手加了 `i`）会让守卫对着右代码全绿，而它到底在
  // 看什么没人知道。实测反例：把 `.at()` 那条改成 `/\.at\s*\(/gi` 之后，注入 `__list.AT(-1)` 是
  // 「自检过、主断言也过」——写法完全没被看到（扫描侧现在用 `rule.re.flags`，下面这条 flags 断言再把
  // 「别偷偷加标志」钉死）。
  for (const rule of RULES) {
    assert.equal(rule.re.flags, 'g',
      `规则「${rule.name}」的 flags 是 "${rule.re.flags}"（要求恰好 "g"）：带上 i 之类的标志会悄悄改变`
      + '这条规则命中的东西，而扫描侧是照 flags 跑的');
  }
  const hits = [
    ['WeakRef()', 'const r = new WeakRef(o);'],
    ['FinalizationRegistry()', 'const f = new FinalizationRegistry(() => {});'],
    ['逻辑赋值运算符（??= / ||= / &&=）', 'let a = null; a ??= 1;'],
    ['逻辑赋值运算符（??= / ||= / &&=）', 'x ||= 1;'],
    ['逻辑赋值运算符（??= / ||= / &&=）', 'x &&= 1;'],
    ['String.prototype.replaceAll()', "s.replaceAll('a', 'b');"],
    ['Promise.any()', 'await Promise.any([p]);'],
    ['顶层 await', 'await load();'],
    ['正则 d flag（hasIndices）', 'const re = /a(b)/d;'],
    ['.at()', 'const last = arr.at(-1);'],
    ['crypto.randomUUID()', 'const id = crypto.randomUUID();'],
    ['Object.hasOwn()', "Object.hasOwn(o, 'k');"],
    ['类静态初始化块（static { }）', 'class A { static { this.x = 1; } }'],
    ['.findLast() / .findLastIndex()', 'arr.findLast(x => x);'],
    ['.findLast() / .findLastIndex()', 'arr.findLastIndex(x => x);'],
    ['structuredClone()', 'const c = structuredClone(v);'],
    ['.toSorted() / .toReversed()', 'const a = list.toSorted();'],
    ['.toSorted() / .toReversed()', 'const b = list.toReversed();'],
    ['Object.groupBy()', 'Object.groupBy(a, x => x);']
  ];
  for (const [name, sample] of hits) {
    const rule = RULES.find(r => r.name === name);
    assert.ok(rule, `规则表里没有「${name}」`);
    // 同样新建正则再用：不碰规则表那份，免得把 lastIndex 推进去（下面还有一条测试专门守这件事）
    assert.ok(new RegExp(rule.re.source, rule.re.flags).test(sample),
      `「${name}」的正则对样本 \`${sample}\` 不命中——规则写坏了，这条守卫在这类写法上是失明的`);
  }
  // 放行样例：对**正确写法**必须放行、对**危险写法**必须不放行，两个方向都要钉
  const scRule = RULES.find(r => r.name === 'structuredClone()');
  const scOk = "if (typeof structuredClone === 'function') return structuredClone(value);";
  assert.equal(scRule.allow({ raw: scOk }), true,
    '带 `typeof` 特性检测的 structuredClone 调用被误判成违规了（正确写法必须放行）');
  for (const [label, line] of [
    ['只探测、没有回退分支', 'const t = typeof structuredClone; const c = structuredClone(v);'],
    ['条件写反（!==）', "if (typeof structuredClone !== 'function') return structuredClone(v);"]
  ]) {
    assert.equal(scRule.allow({ raw: line }), false,
      `structuredClone 的放行判定太宽：「${label}」的写法被放行了（它并没有真正的保护）`);
  }
  const dRule = RULES.find(r => r.name === '正则 d flag（hasIndices）');
  assert.equal(dRule.allow({ match: ['/a/g', 'g'] }), true, 'flags 里没有 d 的正则被误判成违规了');
  assert.equal(dRule.allow({ match: ['/a/d', 'd'] }), false, 'flags 里带 d 的正则被放行了');
  // `d` flag 那条规则的**假红样本**（复审实测的三种普通写法，都**不该报**）：
  // 第一个靠 flags 前后的标识符边界排除（`duration` 不是 flags），后两个靠「后面没有能闭合的 `/`」自然落空。
  for (const clean of [
    'const x = a / b/duration;',
    "const css = 'a{background:url(/img/dark.png)}';",
    'const p = `${base}/img/dark/x.png`;'
  ]) {
    const r = scanText('probe.js', clean);
    assert.equal(r.violations.length, 0,
      `「${clean}」被误报成 d flag 了：${r.violations.map(show).join('、')}`);
  }
});

test('同一段文本反复扫描结果一致，且不受规则表正则 lastIndex 影响（共享正则的静默漏检）', () => {
  // 这条守的是扫描实现本身：上一版直接复用规则表里的正则，`lastIndex` 一被推高，短行里的命中就会整行
  // 消失——那时「违规 0 处」是**假绿**（实测：去掉了 typeof 保护的 structuredClone 就是这么逃过主断言的，
  // 只有「放行路径没跑过」那条把事故翻了出来）。
  const sample = 'const a = structuredClone(x);';
  const first = scanText('probe.js', sample);
  assert.equal(first.violations.length, 1,
    `合成样本上量到 ${first.violations.length} 处违规（期望 1 处）——扫描本身失效了，先修它`);
  for (const r of RULES) r.re.lastIndex = 99; // 人为把共享正则的游标推到命中位置之后
  const second = scanText('probe.js', sample);
  for (const r of RULES) r.re.lastIndex = 0;
  assert.equal(second.violations.length, 1,
    '规则表里的正则被共享使用：lastIndex 被推高后同一行就漏检了（这一坑会让「违规 0 处」变成假绿）');
});

test('正则字面量里的引号不该让后面的注释失明（两个方向都要钉）', () => {
  // 合成样本照着 `app/file-info.js` 那一行写：正则字符类里含 `"`。
  const line1 = "const s = a.replace(/[/\\\\:*?\"<>|]/g, '_');";
  // 方向一（假红）：正则之后的注释必须被剥掉 → 注释里的写法不许报出来
  const sample1 = [line1, '// 别写成 x ??= 1', 'const y = 1;'].join('\n');
  const code1 = stripComments(sample1);
  assert.equal(code1.split('\n').length, sample1.split('\n').length, '样本剥注释后行数变了');
  assert.equal(code1.split('\n')[1].trim(), '',
    '正则字面量之后的注释没被剥掉——剥注释在那一行跑偏了（这条注释里的写法会被假红报出来）');
  const r1 = scanText('probe.js', code1);
  assert.equal(r1.violations.length, 0,
    `注释里的写法被当成违规报了（假红）：${r1.violations.map(show).join('、')}`);
  // 方向二（假绿）：正则之后放一个真违规，必须报出来——旧实现在这里整段失明
  const sample2 = [line1, '// 这是一行注释', 'const z = list.at(-1);'].join('\n');
  const r2 = scanText('probe.js', stripComments(sample2));
  assert.equal(r2.violations.length, 1,
    `正则字面量之后的真违规没被报出来（假绿，实测过的那种失明）：量到 ${r2.violations.length} 处`);
  assert.match(r2.violations[0].text, /\.at\(-1\)/, `报出来的不是那一处：${r2.violations[0].text}`);
});

test('方向断言：除法与正则的判据两边都要对（复审实测出来的零覆盖方向）', () => {
  // 复审实测：把 startsRegex 第一行换成 `return true`（**所有** `/` 都当正则起点）时，整套守卫
  // exit=0、一条失败都没有——「把除法误判成正则」这个方向一条断言都看不见，而它恰恰是产生**假绿**的那
  // 一半。下面五条把两个方向都钉死（任何一条在实现退化成「一律当正则」或「`(` 之后一律语句位置」时
  // 都会红）。
  // ① 除法 + 行尾注释：注释必须被剥掉。若把所有 `/` 当正则，这里会原样返回，断言当场红。
  assert.equal(stripComments('const r = a / b; // ??= 1'), 'const r = a / b; ',
    '`a / b` 后面的行尾注释没被剥掉——剥离器把除法当成正则了（「一律当正则」会把注释留成代码）');
  // ①b **表达式位置的 `)`**：`f(a) / 2` 的 `)` 之后是**除法**（不是语句位置）。这一条钉的是 `)stmt` 那条
  //     分支的**反方向**：复审实测——把括号栈改成「`(` 之后一律语句位置」（`parens.push(true)`）或者删掉
  //     `if (prev === ')') return false;`，整套守卫都还是 9/9 全绿，因为 ① 里的 `prev` 是标识符、
  //     根本不经过 `)stmt`。仓库里 `) /` 形式的除法有 18 处（`app/main.js` 的
  //     `Math.round((due - today) / 86400000)`、`app/ui/stats-view.js` 等），它们哪天带上行尾注释，
  //     假红就会从这一条冒出来。
  assert.equal(stripComments('const r = f(a) / 2; // ??= 1'), 'const r = f(a) / 2; ',
    '`f(a) / 2` 的 `)` 之后是**表达式位置**（除法）：它的行尾注释没被剥——把 `(` 之后一律当语句位置、'
    + '`)` 之后一律当正则，就会在这里红');
  // ② 字符串里的 `//` 不是注释：字符串之后的真违规必须仍然被扫到
  assert.equal(
    scanText('probe.js', stripComments("const u = 'http://x'; const bad = list.at(-1);")).violations.length, 1,
    '含 `://` 的字符串之后那处真违规没被扫到——剥离器在字符串里切掉了后半行');
  // ③④ `if (x) /re/` 与 `throw /re/` 之后是**语句位置**：正则体里的 `//` 不能被当注释起点，否则本行
  //     剩余（含真违规）会被整段删掉。实测过的旧行为：这两个输入剥完只剩 `if (x) /[` / `throw /[`。
  for (const src of [
    'if (x) /[//]/.test(s); const q = list.at(-1);',
    'throw /[//]/.test(s); const q = list.at(-1);'
  ]) {
    const stripped = stripComments(src);
    const r = scanText('probe.js', stripped);
    assert.equal(r.violations.length, 1,
      `「${src}」剥完只剩 ${JSON.stringify(stripped)}——真违规被吃掉了（假绿）`);
    assert.match(r.violations[0].text, /\.at\(-1\)/, `报出来的不是那一处：${r.violations[0].text}`);
  }
  // ⑤ `debugger` 之后也是**语句位置**（这个词是复审实测后补进关键字白名单的：`debugger /re/` 是合法 JS，
  //     不补的话正则体里的 `//` 会被当注释起点、本行剩余连同真违规一起被删掉，实测就是这样逃逸的）。
  assert.equal(
    scanText('probe.js', stripComments('debugger /[//]/.test(s); const q = list.at(-1);')).violations.length, 1,
    '`debugger /re/` 之后的正则体里那个 `//` 被当成注释起点了——本行剩余（含真违规）被整段删掉');
});

test('跨行写法同样被抓（逐行扫会漏掉一半）', () => {
  // 复审实测：把调用拆成两行之后，逐行扫的版本有 5/7 种写法完全看不见。
  const cases = [
    ['Object.hasOwn(', "Object.hasOwn(\n  a, 'b');"],
    ['.replaceAll(', "s\n  .replaceAll('a', 'b');"],
    ['structuredClone(', 'const c =\n  structuredClone(v);'],
    ['Promise.any(', 'const p2 = Promise.any(\n  [p]);'],
    ['WeakRef(', 'const r = new\n  WeakRef(o);']
  ];
  for (const [label, sample] of cases) {
    const r = scanText('probe.js', sample);
    assert.ok(r.violations.length >= 1,
      `跨行写法没被抓住（${label}）——扫描又退回逐行了？样本：\n${sample}`);
  }
});

test('运行时代码里没有目标设备解析不了的语法 / 缺的 API', () => {
  const { violations } = scanAll();
  assert.equal(violations.length, 0,
    `运行时代码里有 ${violations.length} 处设备不支持的语法 / API（安卓系统 WebView 版本由设备决定，`
    + '底线是能跑 Chrome 83；语法类在低版本上是**解析期失败 → 整页白屏**，连 catch 都进不去）：\n  '
    + violations.map(show).join('\n  '));
});

test('每条带 allow 的规则都至少有一次 allowed 命中（放行路径确实被执行到）', () => {
  // 放行逻辑最危险的不是放太宽，而是**它一次都没跑过**：那时「违规 0 处」既可能是「代码干净」，也可能
  // 是「仓库里根本没有这类调用」。这条把两者分开。
  const withAllow = RULES.filter(r => r.allow);
  assert.ok(withAllow.length >= 2, `带 allow 的规则只有 ${withAllow.length} 条（期望至少 2 条）——规则表被动过了？`);
  const { allowed } = scanAll();
  for (const rule of withAllow) {
    const hits = allowed.filter(a => a.rule === rule.name);
    assert.ok(hits.length >= 1,
      `规则「${rule.name}」的放行逻辑一次都没被执行到——「违规 0 处」这句话对它没有意义。`
      + `（本次放行命中：${allowed.map(a => a.rule).join('、') || '（一条都没有）'}）`);
  }
  // 例外式规则的样本点还得对得上：structuredClone 那唯一一处受保护的调用必须来自 app/backup.js
  const sc = allowed.filter(a => a.rule === 'structuredClone()');
  assert.ok(sc.some(a => a.file === 'app/backup.js'),
    `放行的 structuredClone 不在 app/backup.js（实际：${sc.map(a => `${a.file}:${a.line}`).join('、')}）`);
});
