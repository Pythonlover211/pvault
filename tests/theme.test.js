// 外观系统的纯逻辑测试。theme.js 不碰 DOM 与 IndexedDB，所以这一套能直接在 Node 里跑。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  THEMES, THEME_TOKENS, THEME_IDS, MODES, DEFAULT_PRESET, DEFAULT_MODE,
  normalizePreset, normalizeMode, resolveMode, normalizeOverlay,
  normalizeBackground, scrimAlpha
} from '../app/theme.js';

// 「5 套皮肤 × 浅/深」共 10 组色板的遍历骨架，本文件里遍历色板的测试都要用它。抽成一个函数是为了让
// 那两道前置守卫只写一次——皮肤缺色板、某一档深浅缺色板时先给一句能读的断言，否则后面会死在
// TypeError: Cannot read properties of undefined 上；红是红了，但读起来像色值坏了。
//
// 深浅写死 ['light', 'dark']，不用 MODES 来遍历：MODES 里还含 'auto'，那是「跟随系统」这个选项值、
// 不是色板里的一档，混进来会去取不存在的 THEME_TOKENS[id].auto。（MODES 本身被归一化那一节 import
// 去断言 DEFAULT_MODE 合法，与这里的遍历无关。）
function forEachTokens(fn) {
  for (const id of THEME_IDS) {
    assert.ok(THEME_TOKENS[id], `缺少皮肤 ${id} 的色板`);
    for (const mode of ['light', 'dark']) {
      const tokens = THEME_TOKENS[id][mode];
      assert.ok(tokens, `${id}.${mode} 缺失`);
      fn(tokens, id, mode);
    }
  }
}

// 色板的正典清单：每套皮肤 × 每种深浅都必须**正好**是这 12 个键。
//
// 为什么写死在这里，而不是拿 THEME_TOKENS.default.light 当基准：那个基准是**自指**的，
// 在它下面「10 个 map 一起少一个变量」永远是绿的。而任务 1 只落数据，消费这些变量的 CSS
// 要到后面几个任务才写，中间这段时间 --border、--accent-weak 看起来就像没人用的死变量，
// 「顺手清理死变量」是个完全合理的动作——清理完不会有任何测试响。
//
// 为什么这份清单里**没有** --surface-rgb：它与 --surface 是同一个颜色的两种写法，
// 两份手写真相一旦不同步，卡片颜色就**只在开了背景照片时**变掉——不开照片的人永远看不见，
// 任何测试也覆盖不到。改为由 themeCssVars() 从 --surface 现算 rgba(...) 之后，
// 物理上不可能漂移，这个键也就不该再存在于色板里。
const TOKEN_NAMES = [
  '--bg', '--surface', '--surface-2', '--border',
  '--text', '--text-2', '--text-3',
  '--accent', '--accent-weak', '--on-accent',
  '--shadow', '--scrim-rgb'
];

// 每个变量的**形状**。这张表和正典清单一样是手工维护的，测试遍历它逐值断言。
//
// 为什么不写成「hex 的那些共用一条正则、其余手工单测」：那样新增一个变量时，作者只要忘了
// 给它加断言，它就没有任何测试覆盖——而「漏登记了一个」这件事在派生出来的集合里根本表达
// 不出来（派生集合永远等于它自己，拿它当守卫等于写一句恒真的话）。能真的红的那一层是
// 「这张表 ↔ 正典清单」的对照断言，任何计数式的守卫都不是。
//
// 顺带记下被换掉的那条守卫为什么有害：`assert.equal(hex 变量的个数, 10)` 既拦不住值写错
// （新变量的值会被这张表自动断言），又会把合法的扩展判红，而且报出来的是一个数字、
// 不是一条可执行的指令。
const HEX6 = /^#[0-9a-f]{6}$/;
const SHAPES = {
  '--bg': HEX6,
  '--surface': HEX6,
  '--surface-2': HEX6,
  '--border': HEX6,
  '--text': HEX6,
  '--text-2': HEX6,
  '--text-3': HEX6,
  '--accent': HEX6,
  '--accent-weak': HEX6,
  '--on-accent': HEX6,
  // 一整条 box-shadow，按当前数据的实际形状约束：三段长度 + rgba 四元组。
  // 曾经这里只查「含 rgba(」，于是 '--shadow': 'rgba(' 是绿的——而 box-shadow: var(--shadow)
  // 会因此整条失效、阴影静默消失（深色皮肤上本来就几乎看不见，更没人会发现）。
  '--shadow': /^0 \d+px \d+px rgba\(0, 0, 0, [\d.]+\)$/,
  // 三个裸通道数字，不是 hex。写成 '#ffffff' 会让 rgba(#ffffff, .3) 不是合法的 <color>，
  // CSS 在 computed-value time 判整条声明失效 → background-image: none，遮罩整层消失、
  // 卡片背景全透明。而且它比「漏写变量」更糟——漏写会退回 base.css 的 :root 兜底，
  // **写错的值会覆盖兜底**，兜底救不回来。
  '--scrim-rgb': /^\d{1,3},\d{1,3},\d{1,3}$/
};

test('theme：五套皮肤 × 深浅的变量集合与正典清单完全一致', () => {
  forEachTokens((tokens, id, mode) => {
    // 判据是「键集合与正典清单完全一致」，既不是「数量够」也不是「和 default.light 一样」：
    // 少一个变量，界面上那块会**静默**退回 base.css 里默认皮肤的颜色——它不会变成黑块或透明，
    // 只是「这块看着有点不对」，比报错难发现得多；多一个则说明这套皮肤偷偷开了新维度。
    assert.deepEqual(
      Object.keys(tokens).sort(), [...TOKEN_NAMES].sort(),
      `${id}.${mode} 的变量集合与正典清单不一致`
    );
  });
});

test('theme：正典清单里的每个变量都登记了形状', () => {
  // 两张手工维护的表必须一一对应。漏登记 → 那个变量不会被任何断言覆盖（静默漏测）；
  // 多登记 → 断言了一个色板里不存在的键。报出来的是「该去哪儿补一行」，不是一个数字。
  assert.deepEqual(
    Object.keys(SHAPES).sort(), [...TOKEN_NAMES].sort(),
    '新增/删除色板变量时，SHAPES 与 TOKEN_NAMES 必须同步登记（新变量的形状要写进 SHAPES）'
  );
});

test('theme：色值的形状与 --scrim-rgb 的明暗极性', () => {
  // 只断言键名存在等于没测：值是空串、是 'red'、是别的颜色，测试一样全绿。
  // 所以这一条逐值断言形状——它是这套测试里唯一能拦住「值写错」的关卡。
  forEachTokens((t, id, mode) => {
    for (const key of Object.keys(SHAPES)) {
      // 值缺失或被写成非字符串时 assert.match 抛的是 TypeError（信息量为零），
      // 先过一道 typeof，报出来的才是「哪个皮肤的哪个变量不对」。
      assert.equal(typeof t[key], 'string', `${id}.${mode}.${key} 不存在或不是字符串：${t[key]}`);
      assert.match(t[key], SHAPES[key], `${id}.${mode}.${key} 的形状不对：${t[key]}`);
    }

    for (const ch of t['--scrim-rgb'].split(',')) {
      const n = Number(ch);
      assert.ok(n >= 0 && n <= 255, `${id}.${mode}.--scrim-rgb 的通道越界：${ch}`);
    }
    // 极性写死：浅色皮肤用白遮罩压亮、深色皮肤用黑遮罩压暗。写反了遮罩会朝反方向走，
    // 而且越调滑块越看不清字——这是「值级」断言，不是「键级」。
    assert.equal(
      t['--scrim-rgb'], mode === 'light' ? '255,255,255' : '0,0,0',
      `${id}.${mode}.--scrim-rgb 的明暗极性写反了`
    );
  });
});

test('theme：THEME_IDS 与 THEMES、THEME_TOKENS 三者一一对应且含 default', () => {
  assert.deepEqual(THEME_IDS, THEMES.map(t => t.id));
  assert.ok(THEME_IDS.includes('default'));
  assert.equal(new Set(THEME_IDS).size, THEME_IDS.length, '皮肤 id 有重复');
  // 反向也要校验：只往 THEME_TOKENS 里加一套半成品皮肤（还没住进 THEMES）时，
  // 上面那条单向断言是绿的，而 THEME_TOKENS 里会多出一个没有名字、界面上也选不到的幽灵皮肤。
  assert.deepEqual(
    Object.keys(THEME_TOKENS).sort(), [...THEME_IDS].sort(),
    'THEME_TOKENS 的键与 THEME_IDS 不一致'
  );
});

test('theme：每套皮肤都有非空的中文名', () => {
  for (const t of THEMES) {
    assert.equal(typeof t.name, 'string', `${t.id} 没有名字`);
    assert.ok(t.name.trim(), `${t.id} 的名字是空的`);
  }
});

// ── WCAG 对比度 ───────────────────────────────────────────────────────────────
// 自己实现而不是引依赖：整套换算只用到相对亮度一个公式，而零依赖是这个项目的底线。

function parseHex(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) throw new Error(`不是 #rrggbb 形式的颜色：${hex}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// sRGB 的传递函数：把 8bit 通道值换算成线性光。低亮度段走线性，其余走 2.4 次幂。
// 名字不叫 channel——那在调用点上只说明「跟通道有关」，看不出它在做哪一步换算。
//
// 0.03928 这个分段点是 WCAG 2.x 的写法（2.2 起改成 0.04045）。这两个数在 8bit 色值上不可能
// 产生分歧——它们之间夹着的 s 区间换算回 0..255 是 (10.02, 10.31]，里面没有任何整数——
// 所以逐值算出来的结果与用新数一致，不必为了对齐新标准去改。
function srgbToLinear(v) {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

// 0.2126 / 0.7152 / 0.0722 是 sRGB 的三原色亮度权重（Rec.709）。绿色占七成，
// 所以「把红色调深一点」对对比度的贡献远小于「把绿色调深一点」——
// 这也是调色值时最容易判断失误的地方。
function luminance(hex) {
  const [r, g, b] = parseHex(hex);
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

// WCAG 的对比度是 (较亮者 + 0.05) / (较暗者 + 0.05)，谁亮谁暗由公式自己排，
// 不靠调用方保证顺序。
function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

// 「文字色 vs 它可能落在的每一种底」——方向固定是「左是文字、右是底」。
// contrast() 对调两侧得到的是同一个数，所以写反了不会有任何测试响；但意图会变成
// 「拿底色当文字色去比」，后来的人照着这一对去调色，就会朝着错误的方向使劲。
//
// surface-2 必须算进去：输入框、次级按钮都垫在它上面。--text-2 落在它上面是每一组配色里最紧的
// text 类配对（浅色皮肤里它是最暗的底、深色皮肤里它是最亮的底，两个方向都在往文字色挤；
// 默认皮肤的老值 #6e6e73 落在这里只有 4.19:1）。这话只限 text 类——这 70 对里最紧的一对是
// default.light 的 --on-accent on --accent（当前 4.665:1），它不在 text 类里。
//
// 有意排除的两类，不是漏测：--text-3 作文字色的那三对、--accent 作文字色的那一对
// （components.css 里 --accent 就是文字色，父容器是 background: var(--accent-weak)）。
// 按规格 §5.3 它们不在本断言的范围内，其中**有一部分**低于 4.5——10 组逐对算过：
// --text-3 那 30 个组合里 27 个低于（浅色三对全在 2.12~3.06；dark 下只有落在 --bg 上的三对够高，
// 4.51~4.85），--accent on --accent-weak 只有 2 对低于（default.light 4.06、paper.light 4.27），
// 另外 8 对在 4.55~6.80。所以把它们补进 CONTRAST_PAIRS 只会红一部分、不是全红，别据此以为
// 守卫坏了。要处理它们只有两条路：改色值，或者改规格；
// **不要为了让它们变绿去放松 MIN_CONTRAST**——那会连 --text、--text-2 的守卫一起废掉。
const CONTRAST_PAIRS = [
  ['--text', '--bg'], ['--text', '--surface'], ['--text', '--surface-2'],
  ['--text-2', '--bg'], ['--text-2', '--surface'], ['--text-2', '--surface-2'],
  ['--on-accent', '--accent']
];

const MIN_CONTRAST = 4.5;

test('theme：对比度对用到的变量都是 #rrggbb 形式的色值', () => {
  // 判据是**形状**，不是「在正典清单里」。区别很实在：--scrim-rgb 也在正典清单里、也是同一份
  // 色板里的变量，往 CONTRAST_PAIRS 里补一对时最容易手滑抓到它，可它不是 hex（是三个裸通道
  // 数字），按清单判定会放过它，然后主断言死在「不是 #rrggbb 形式的颜色：255,255,255」上，
  // 连是哪一对、哪套皮肤都不说。按形状判定就能当场指名。
  // 这里没有新增任何数据：SHAPES 早就被「正典清单 ↔ 形状表」那条断言钉住了。
  for (const [fg, bg] of CONTRAST_PAIRS) {
    assert.equal(SHAPES[fg], HEX6, `对比度对的文字色不是 #rrggbb 的色值变量：${fg}`);
    assert.equal(SHAPES[bg], HEX6, `对比度对的背景色不是 #rrggbb 的色值变量：${bg}`);
  }
});

test('theme：对比度公式与 WCAG 的已知值一致', () => {
  // 上面那几行公式没人会去复核，抄错了整套色板就会在错误的标准下全绿——写测试的人和写实现
  // 的人是同一个，两边一起错时没有东西会响。这条用与色板无关的已知向量把公式钉住。
  //
  // 为什么偏偏是这几个颜色：把典型抄错逐个试过之后挑的，每一类都得真有向量拦得住——
  //   0.7152 → 0.7512（绿权重抄错）      → 黑白向量红（21 变成 21.7）
  //   +0.05 偏移量漏掉或写错              → 黑白向量红（21 变成 Infinity / 201 / 3）
  //                                          （同色向量对它不敏感：两侧一起改时 (x+on)/(x+od) 恒等于 1）
  //   0.2126 ↔ 0.0722（红蓝权重对调）      → 纯红对黑红（5.252 变成 2.444）
  //   parseHex 把 rrggbb 读成 bbggrr       → 纯红对黑红（同上，红蓝一换就露）
  //   2.4 → 2.41（幂次抄错）               → 中灰对白红（偏差约 0.02，够把 4.49 判成 4.51）
  //   12.92 → 12.9（线性段除数抄错）        → 深灰对白红（只有 ≤10 的通道走线性段，黑和中灰
  //                                          都不经过它，所以必须单独放一个 #0a0a0a）
  //   0.03928 → 0.04045（换 WCAG 版本）    → 全绿，且**应该**全绿：8bit 上没有值落在这两个数
  //                                          之间（见 srgbToLinear 的注释），结果本来就不会变。
  //
  // 最后一行是这张表存在的另一半意义：分清「抄错但无感」和「抄错又有感」，免得后来的人为了让
  // 测试红，去改一个其实正确的常量。几条消息里都带上实际算出来的值——只报「应为 21:1」而看不到
  // 21.72，修的人不知道自己偏了多少。
  //
  // 容差 1e-4：浮点误差在这套运算里是 1e-15 量级，而被拦住的每一类偏差都在 1.7e-3 以上
  // （逐类算过，最小的是 12.92 → 12.9 偏 1.757e-3；0.03928 → 0.04045 那一类偏差是 0，本来就该全绿）。
  assert.ok(
    Math.abs(contrast('#ffffff', '#000000') - 21) < 1e-4,
    `黑白对比度应为 21:1，实际算出 ${contrast('#ffffff', '#000000').toFixed(4)}:1`
  );
  assert.ok(
    Math.abs(contrast('#ffffff', '#ffffff') - 1) < 1e-4,
    `同色的对比度应为 1:1，实际算出 ${contrast('#ffffff', '#ffffff').toFixed(4)}:1（+0.05 偏移量写错了？）`
  );
  assert.ok(
    Math.abs(contrast('#ff0000', '#000000') - 5.252) < 1e-4,
    `纯红对黑的对比度应为 5.252:1，实际算出 ${contrast('#ff0000', '#000000').toFixed(4)}:1（亮度权重或通道顺序错了？）`
  );
  assert.ok(
    Math.abs(contrast('#808080', '#ffffff') - 3.94944) < 1e-4,
    `中灰对白的对比度应为 3.94944:1，实际算出 ${contrast('#808080', '#ffffff').toFixed(5)}:1（2.4 次幂错了？）`
  );
  assert.ok(
    Math.abs(contrast('#0a0a0a', '#ffffff') - 19.79815) < 1e-4,
    `深灰对白的对比度应为 19.79815:1，实际算出 ${contrast('#0a0a0a', '#ffffff').toFixed(5)}:1（线性段的 12.92 错了？）`
  );
  // 参数对调必须同值：如果亮度比较那一步被写成「拿第一个减第二个」，这里立刻红。
  assert.equal(contrast('#0a6ef0', '#ffffff'), contrast('#ffffff', '#0a6ef0'));
});

test(`theme：${THEME_IDS.length} 套皮肤的文字对比度都不低于 ${MIN_CONTRAST}:1`, () => {
  // 一次跑完全部 70 对再断言，而不是每对 assert 一次：第一对不达标就中断的话，
  // 调色的人要「改一处—重跑—再看到下一处」，而这几套皮肤的色值是彼此独立的，
  // 攒齐一次报出来才能一轮改完。
  const bad = [];
  forEachTokens((tokens, id, mode) => {
    for (const [fg, bg] of CONTRAST_PAIRS) {
      // 变量被删掉或被写成非字符串时先给一句能读的断言：否则 contrast() 会死在 parseHex 抛出的
      // 「不是 #rrggbb 形式的颜色：undefined」上——红是红了，但读起来像色值写坏了，实际是这一对
      // 引用的变量没了。（与「色值的形状」那条同一个纪律：先过 typeof，再谈值对不对。）
      assert.equal(typeof tokens[fg], 'string', `${id}.${mode}.${fg} 不存在或不是字符串：${tokens[fg]}`);
      assert.equal(typeof tokens[bg], 'string', `${id}.${mode}.${bg} 不存在或不是字符串：${tokens[bg]}`);
      const ratio = contrast(tokens[fg], tokens[bg]);
      if (ratio < MIN_CONTRAST) {
        // 比值给三位小数而不是两位：色值就是在小数点后第四位做取舍的（4.6651 那对就卡在线上），
        // 两位会把 4.498 印成「4.50」——报出「4.50 却说不达标」，读的人第一反应是阈值或断言坏了，
        // 而正确的动作恰恰不是去动阈值。
        bad.push(`${id}.${mode}  ${fg} on ${bg} = ${ratio.toFixed(3)}:1  (${tokens[fg]} / ${tokens[bg]})`);
      }
    }
  });
  // 阈值从常量插值，不在这里写死第二个「4.5」：写死的话，把 MIN_CONTRAST 改成别的值，
  // 报错还在说 4.5，读的人会去核对一个早就不是阈值的数字。
  // 报出「皮肤.深浅 + 哪一对 + 实际比值 + 用到的两个色值」，四项缺一不可：这条断言的唯一修法是
  // 改色值（或查出上面那条公式自证也红了——那是公式抄错，不是色板的问题），信息不全的报错
  // 等于把活原样退回给读日志的人。判失败用 `<`：AA 正文标准要求的是 ≥ 4.5。
  assert.equal(
    bad.length, 0,
    `这些配色达不到 ${MIN_CONTRAST}:1（AA 正文标准），必须调色值：\n${bad.join('\n')}`
  );
});

// ── 归一化与解析 ─────────────────────────────────────────────────────────────
// 这一节处理的都是外来的脏值：设置从库里读出来（可能被用户用 devtools 手改过、可能是老版本写下的
// 另一种形状、也可能某一版压根没写过），滑块的 el.value 送进来的是字符串。判据统一是「不认识就
// 退回一个安全的默认值」，而不是抛错——外观读不出来不该让整个 app 打不开，一个坏值也不该一路走到
// 界面上变成透明的黑块。
// 这一节用到的函数与常量都在文件顶部那一条 import 里，不再单独 import 一次同一个模块。

// 断言消息里的输入标签：用 String() 而不是 JSON.stringify()——后者把 NaN 与 Infinity 都印成
// "null"，跟真正的 null 撞成同一句话，失败时分不清是哪一个输入漏了。typeof 一并带上：
// '' 与 [] 的 String() 都是空串，只有靠类型才分得开。
const junkLabel = v => `${String(v)}(${typeof v})`;

test('normalizePreset：认识的留下，其余一律回默认', () => {
  // 常量本身合法是这一节的前置条件，不是兜底逻辑的功劳：DEFAULT_PRESET 一旦被改成拼错的 'defualt'，
  // 先红的会是下面的 junk 循环（报「输入 undefined 没被兜住」），读的人会去查兜底实现，而真正被改坏
  // 的是常量。（normalizePreset('default') 那条查不出这件事——'default' 只要还在 THEME_IDS 里就直接
  // 返回自己。）
  assert.ok(
    THEME_IDS.includes(DEFAULT_PRESET),
    `DEFAULT_PRESET 应当是可选皮肤之一，实际 ${DEFAULT_PRESET}`
  );
  assert.equal(normalizePreset('paper'), 'paper');
  assert.equal(normalizePreset('seaglass'), 'seaglass');
  // 默认值自己也得是合法返回值：读出来是 default、写回去仍是 default，这条路径不能把设置洗掉。
  assert.equal(normalizePreset('default'), 'default');
  // 两类最真实的误写各占一项：'Paper' 拼对了但大小写不对（写成大小写归一的实现会把它返回成
  // 'paper'），'PA' 是大写的前缀（写成前缀匹配的实现会返回 'paper'）。只放 'PA' 拦不住前一类——
  // 大小写归一那条实现下 'PA' 也会被判成不认识。
  for (const junk of [undefined, null, '', 'PA', 'Paper', 42, {}, [], 'light']) {
    assert.equal(normalizePreset(junk), 'default', `输入 ${junkLabel(junk)} 没被兜住`);
  }
  // 不 trim、不忽略大小写是判据而不是疏忽：带空格或大小写不符的 id 不属于这五套里的任何一套，
  // 猜成某一套看起来正常的皮肤，等于把一个坏值悄悄洗掉。
  assert.equal(normalizePreset(' paper '), 'default', '带空格的 id 不该被认成 paper');
});

test('normalizeMode：认识的留下，其余一律回 auto', () => {
  // 与 DEFAULT_PRESET 同一个前置条件：DEFAULT_MODE 被改成 'light' 时先红的是 junk 循环，
  // 而原因在常量本身。
  assert.ok(
    MODES.includes(DEFAULT_MODE),
    `DEFAULT_MODE 应当是可选模式之一，实际 ${DEFAULT_MODE}`
  );
  assert.equal(normalizeMode('light'), 'light');
  assert.equal(normalizeMode('dark'), 'dark');
  assert.equal(normalizeMode('auto'), 'auto');
  // 'DARK' 回 auto 同一个道理：它不是深浅三个值里的任何一个，归成 auto 顶多是「跟系统走」，
  // 比自作主张按深色处理安全。
  for (const junk of [undefined, null, '', 'DARK', 0, {}, true]) {
    assert.equal(normalizeMode(junk), 'auto', `输入 ${junkLabel(junk)} 没被兜住`);
  }
});

test('resolveMode：auto 看系统，手动指定压过系统', () => {
  assert.equal(resolveMode('auto', true), 'dark');
  assert.equal(resolveMode('auto', false), 'light');
  // 用户明确选了深色，系统是浅色也必须是深色——反过来同理。
  assert.equal(resolveMode('dark', false), 'dark');
  assert.equal(resolveMode('light', true), 'light');
  // 垃圾值归一化成 auto 之后再看系统，别抛错也别瞎猜。
  assert.equal(resolveMode('nonsense', true), 'dark');
  // 系统深浅是探出来的（matchMedia(...).matches），取不到时可能是 undefined 这类 falsy 值。
  // 这时按浅色走：与「浏览器给不出深色偏好、页面本来就是浅色」一致，也不会抛错。
  assert.equal(resolveMode('auto', undefined), 'light');
});

test('normalizeOverlay：取整、夹到 0..60，非法值回默认 30', () => {
  assert.equal(normalizeOverlay(0), 0);
  assert.equal(normalizeOverlay(60), 60);
  assert.equal(normalizeOverlay(30.4), 30);
  assert.equal(normalizeOverlay(30.6), 31);
  assert.equal(normalizeOverlay(-5), 0);
  assert.equal(normalizeOverlay(999), 60);
  assert.equal(normalizeOverlay('45'), 45, '字符串数字要认（滑块的 el.value 是字符串）');
  // '0' 与 '' 是判据的分界线：'0' 是用户明确要求「不要遮罩」、'' 是「这个设置没有」。
  // 滑块那条路径看不出 `if (!value) return 30` 这个错法：滑块送的是字符串，'0' 是 truthy，照样返回
  // 0（实测）。真正钉住它的是上面那条数字 0 的断言——滑块拉到 0 会以数字形式存库，下次启动读到的就是
  // 数字 0，`!0` 为真，遮罩跳回 30，而用户并没有再动过它（实测这个错法当场红两条：normalizeOverlay(0)
  // 与 scrimAlpha(0)）。
  // 比它更早出错的写法是 `if (!Number(value))`：连字符串路径都过不去，下面那条当场红。
  assert.equal(normalizeOverlay('0'), 0);
  // 下面这批「非数字」里有五个是 Number() 的陷阱：null / '' / [] / false 给的是 0（不是 NaN）、
  // true 给的是 1。也就是说「先 Number() 再判 isFinite」这条路会把它们静默变成 0% 或 1% 的遮罩，
  // 而不是回默认值。逐个算过：这 5 个里 4 个变 0、1 个变 1；剩下的 5 项里，undefined / {} /
  // '45px' / NaN 本身给的是 NaN，Infinity 给的是 Infinity（靠 isFinite 拦下）。
  for (const junk of [undefined, null, '', NaN, Infinity, {}, [], true, false, '45px']) {
    assert.equal(normalizeOverlay(junk), 30, `输入 ${junkLabel(junk)} 没被兜住`);
  }
});

test('normalizeBackground：形状不对就是「没有背景」', () => {
  assert.equal(normalizeBackground(null), null);
  assert.equal(normalizeBackground(undefined), null);
  assert.equal(normalizeBackground('bg'), null);
  assert.equal(normalizeBackground(0), null);
  assert.equal(normalizeBackground({}), null, '没有 assetId 不算有背景');
  assert.equal(normalizeBackground({ assetId: '' }), null);
  assert.equal(normalizeBackground({ assetId: '   ' }), null);
  assert.equal(normalizeBackground({ assetId: 42 }), null);
  // 规格 §9.1 举过 { overlay: 999 } 这个例子：有 overlay、缺 assetId，仍然是「没有背景」——
  // 一个坏 overlay 不能凭空造出一个指向不存在的图的背景。（实测把 assetId 判据放宽成「有 overlay
  // 也算」，这条会红：返回值变成 { assetId: '', overlay: 60, createdAt: null }。）
  assert.equal(normalizeBackground({ overlay: 999 }), null);
  // 数组的 typeof 也是 'object'，所以它不是被类型判据拦下的，而是走到「没有 assetId」那一关才被判
  // null。单列这一条只是为了钉住结果：[] 与 0 都必须回 null。
  // 它钉不住 typeof 判据——实测把判据削成只看 truthy（`if (!value) return null`）时这两条仍然全绿，
  // 因为 0 走 `!value` 短路、[] 走到 assetId 关，两条路都不经过 typeof 判据。真能区分 typeof 的是
  // 「带 assetId 的函数对象」这种合成输入（削掉判据后它会返回 { assetId: 'bg', … }），它没有真实
  // 来源，不值得为它加断言。
  assert.equal(normalizeBackground([]), null);

  assert.deepEqual(
    normalizeBackground({ assetId: 'bg', overlay: 45, createdAt: 1700000000000 }),
    { assetId: 'bg', overlay: 45, createdAt: 1700000000000 }
  );
  // assetId 首尾空白要去掉：它被拿去 assets 表查那张图，' bg ' 查不到任何记录，表现出来是
  // 「设置说有背景、界面上却是空的」，而库里那张图其实好端端躺着。
  assert.deepEqual(
    normalizeBackground({ assetId: ' bg ' }),
    { assetId: 'bg', overlay: 30, createdAt: null }
  );
  // overlay 缺失或非法时补默认值，不能让一个坏 overlay 把整条背景作废——坏掉的只是滑块那一个数，
  // 作废等于把用户选的那张照片也一起丢了。
  assert.deepEqual(
    normalizeBackground({ assetId: 'bg' }),
    { assetId: 'bg', overlay: 30, createdAt: null }
  );
  assert.deepEqual(
    normalizeBackground({ assetId: 'bg', overlay: 'nonsense' }),
    { assetId: 'bg', overlay: 30, createdAt: null }
  );
  // 只留这三个字段：返回值会被任务 8 用 `{ ...bg, overlay }` 原样写回库，透传出去的脏字段会被持久化
  // 下来，之后每读一次都在。（实测把 return 改成 `{ ...value, assetId, overlay, createdAt }`，其余
  // 断言全绿，只有这一条拦得住。）
  assert.deepEqual(
    normalizeBackground({ assetId: 'bg', junk: 1 }),
    { assetId: 'bg', overlay: 30, createdAt: null }
  );
  // 不就地改写传入的对象：现在的调用点都是从 getSetting 拿到的新对象，看不出问题，但「把入参改掉再返回
  // 它」属于换一个调用点才炸的写法，一条断言就能钉住。
  const raw = { assetId: 'bg', overlay: 45 };
  normalizeBackground(raw);
  assert.deepEqual(raw, { assetId: 'bg', overlay: 45 }, 'normalizeBackground 不该改写传入的对象');
  // createdAt 的判据比 overlay 紧，只认真正的数字：Number() 会把 null / '' / false 都变成 0，而 0 是
  // 1970-01-01——一个像真实时间的哨兵值，会污染将来任何要展示或比较它的地方（这个字段目前没有消费点，
  // 正因为还没有，才不该让 0 混进去）。overlay 必须认字符串是因为滑块的 el.value 天生是字符串；
  // createdAt 没有这样的来源（它是 Date.now() 写进去的），所以收紧不会误伤真实数据。
  assert.deepEqual(
    normalizeBackground({ assetId: 'bg', createdAt: null }),
    { assetId: 'bg', overlay: 30, createdAt: null }
  );
  assert.deepEqual(
    normalizeBackground({ assetId: 'bg', createdAt: '1700000000000' }),
    { assetId: 'bg', overlay: 30, createdAt: null }
  );
});

test('scrimAlpha：百分比换算成 0..0.6 的小数', () => {
  assert.equal(scrimAlpha(0), 0);
  assert.equal(scrimAlpha(60), 0.6);
  assert.equal(scrimAlpha(30), 0.3);
  // 越界值走的是同一条归一化，不是另一套判据：--scrim-a 会被原样送进 rgba(..., var(--scrim-a))，
  // 而滑块能表达的只有 0..60——「送出去的一定落在 0..0.6」这件事只能由这里保证。
  assert.equal(scrimAlpha(999), 0.6);
  assert.equal(scrimAlpha(-5), 0);
  // 非法输入走 normalizeOverlay 的默认值 30，而不是 NaN——NaN 不是合法的 alpha，替换进 rgba() 之后
  // background-image 属性会在 computed-value time 失效并回退到初始值 none，遮罩与照片两层一起没了。
  assert.equal(scrimAlpha('nonsense'), 0.3);
  // 规格 §9.1 点名的 NaN 单列一条：它落在「类型是数字但非有限」那条分支上，跟字符串解析失败不是同一条
  // 路，别用一个 'nonsense' 代表全部非法值。
  assert.equal(scrimAlpha(NaN), 0.3);
  // 这里用 === 而不是容差是逐值比对过才敢写的：0/100、30/100、60/100 与字面量 0、0.3、0.6 在
  // 双精度下是同一个数，除法结果恰好落回同一个双精度值上。
});
