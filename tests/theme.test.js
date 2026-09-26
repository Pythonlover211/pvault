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
