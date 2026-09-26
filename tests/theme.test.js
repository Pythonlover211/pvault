// 外观系统的纯逻辑测试。theme.js 不碰 DOM 与 IndexedDB，所以这一套能直接在 Node 里跑。
import test from 'node:test';
import assert from 'node:assert/strict';
import { THEMES, THEME_TOKENS, THEME_IDS } from '../app/theme.js';

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
  for (const id of THEME_IDS) {
    assert.ok(THEME_TOKENS[id], `缺少皮肤 ${id} 的色板`);
    for (const mode of ['light', 'dark']) {
      const tokens = THEME_TOKENS[id][mode];
      assert.ok(tokens, `${id}.${mode} 缺失`);
      // 判据是「键集合与正典清单完全一致」，既不是「数量够」也不是「和 default.light 一样」：
      // 少一个变量，界面上那块会**静默**退回 base.css 里默认皮肤的颜色——它不会变成黑块或透明，
      // 只是「这块看着有点不对」，比报错难发现得多；多一个则说明这套皮肤偷偷开了新维度。
      assert.deepEqual(
        Object.keys(tokens).sort(), [...TOKEN_NAMES].sort(),
        `${id}.${mode} 的变量集合与正典清单不一致`
      );
    }
  }
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
  for (const id of THEME_IDS) {
    // 皮肤住进了 THEMES 却没有色板时，这里给一句能读的断言；否则下面会死在
    // TypeError: Cannot read properties of undefined 上——红是红了，噪音大。
    assert.ok(THEME_TOKENS[id], `缺少皮肤 ${id} 的色板`);
    for (const mode of ['light', 'dark']) {
      const t = THEME_TOKENS[id][mode];
      assert.ok(t, `${id}.${mode} 缺失`);
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
    }
  }
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

// sRGB 线性化：低亮度段走线性，其余走 2.4 次幂。0.03928 这个分段点是 WCAG 2.x 的写法
// （2.2 起改成 0.04045）。这两个数在 8bit 色值上不可能产生分歧——它们之间夹着的 s 区间
// 换算回 0..255 是 (10.02, 10.31]，里面没有任何整数——所以色板逐值算出来的结果与用新数一致，
// 不必为了对齐新标准去改。这也是为什么换成逐值测试之后，这个常量不再是「抄哪个版本」的问题。
function channel(v) {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

// 0.2126 / 0.7152 / 0.0722 是 sRGB 的三原色亮度权重（Rec.709）。绿色占七成，
// 所以「把红色调深一点」对对比度的贡献远小于「把绿色调深一点」——
// 这也是调色值时最容易判断失误的地方。
function luminance(hex) {
  const [r, g, b] = parseHex(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
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
// surface-2 必须算进去：输入框、次级按钮都垫在它上面，而 --text-2 落在它上面是每套皮肤里
// 最紧的一对——浅色皮肤里它是最暗的底、深色皮肤里它是最亮的底，两个方向都在往文字色挤。
const CONTRAST_PAIRS = [
  ['--text', '--bg'], ['--text', '--surface'], ['--text', '--surface-2'],
  ['--text-2', '--bg'], ['--text-2', '--surface'], ['--text-2', '--surface-2'],
  ['--on-accent', '--accent']
];

const MIN_CONTRAST = 4.5;

test('theme：对比度断言的键名都来自正典清单', () => {
  // 键名手滑（写成 --surface3 之类）时，tokens[fg] 是 undefined，下面那条断言会死在
  // parseHex 抛出的「不是 #rrggbb 形式的颜色：undefined」上——红是红了，但读起来像色值坏了，
  // 而不是「这一对的键名写错了」。先在这里把表本身钉住，报出来的才是该改哪一行。
  for (const [fg, bg] of CONTRAST_PAIRS) {
    assert.ok(TOKEN_NAMES.includes(fg), `对比度对的文字色不在正典清单里：${fg}`);
    assert.ok(TOKEN_NAMES.includes(bg), `对比度对的背景色不在正典清单里：${bg}`);
  }
});

test('theme：对比度公式与 WCAG 的已知值一致', () => {
  // 上面那几行公式没人会去复核，抄错了（漏掉 +0.05、把 0.7152 写成 0.7512）整套色板
  // 就会在错误的标准下全绿——写测试的人和写实现的人是同一个，两边一起错时没有东西会响。
  // 所以钉住两个不依赖色板的已知值：黑白 21:1 是 WCAG 定义的极值，同色必然是 1:1
  // （+0.05 有没有漏，看这一条就知道）。
  assert.ok(Math.abs(contrast('#ffffff', '#000000') - 21) < 1e-9, '黑白对比度应为 21:1');
  assert.ok(Math.abs(contrast('#ffffff', '#ffffff') - 1) < 1e-9, '同色的对比度应为 1:1');
  // 参数对调必须同值：如果亮度比较那一步被写成「拿第一个减第二个」，这里立刻红。
  assert.equal(contrast('#0a6ef0', '#ffffff'), contrast('#ffffff', '#0a6ef0'));
});

test('theme：五套皮肤的文字对比度都不低于 4.5:1', () => {
  // 一次跑完全部 70 对再断言，而不是每对 assert 一次：第一对不达标就中断的话，
  // 调色的人要「改一处—重跑—再看到下一处」，而这几套皮肤的色值是彼此独立的，
  // 攒齐一次报出来才能一轮改完。
  const bad = [];
  for (const id of THEME_IDS) {
    for (const mode of ['light', 'dark']) {
      const tokens = THEME_TOKENS[id][mode];
      for (const [fg, bg] of CONTRAST_PAIRS) {
        const ratio = contrast(tokens[fg], tokens[bg]);
        if (ratio < MIN_CONTRAST) {
          // 报出「皮肤.深浅 + 哪一对 + 实际比值 + 用到的两个色值」，四项缺一不可：
          // 这条断言的唯一修法是改色值，信息不全的报错等于把活原样退回给读日志的人。
          bad.push(`${id}.${mode}  ${fg} on ${bg} = ${ratio.toFixed(2)}:1  (${tokens[fg]} / ${tokens[bg]})`);
        }
      }
    }
  }
  assert.deepEqual(bad, [], '这些配色达不到 AA 的 4.5:1，必须调色值：\n' + bad.join('\n'));
});
