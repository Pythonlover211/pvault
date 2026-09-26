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

// 应当是 #rrggbb 的那些键。--shadow 是一整条 box-shadow、--scrim-rgb 是三个裸通道数字，
// 形状与 hex 不同，各自单测。
const HEX_NAMES = TOKEN_NAMES.filter(n => n !== '--shadow' && n !== '--scrim-rgb');

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

test('theme：色值的格式与 --scrim-rgb 的明暗极性', () => {
  // 只断言键名存在等于没测：值是空串、是 'red'、是别的颜色，测试一样全绿。
  // 所以这一条逐值断言形状——它是这套测试里唯一能拦住「值写错」的关卡。
  assert.equal(HEX_NAMES.length, 10, '正典清单里的 hex 变量应恰好 10 个（下面的断言依赖它）');
  for (const id of THEME_IDS) {
    for (const mode of ['light', 'dark']) {
      const t = THEME_TOKENS[id][mode];
      for (const key of HEX_NAMES) {
        assert.match(t[key], /^#[0-9a-f]{6}$/, `${id}.${mode}.${key} 不是 #rrggbb：${t[key]}`);
      }
      assert.match(t['--shadow'], /rgba\(/, `${id}.${mode}.--shadow 里没有 rgba(：${t['--shadow']}`);

      // --scrim-rgb 必须是 `r,g,b` 三个裸通道数字。
      // 写成 '#ffffff' 这类 hex 特别危险：rgba(#ffffff, .3) 不是合法的 <color>，CSS 会在
      // computed-value time 判定整条声明失效 → background-image: none，遮罩整层消失、
      // 卡片背景全透明。而且它比「漏写变量」更糟——漏写会退回 base.css 的 :root 兜底，
      // **写错的值会覆盖兜底**，兜底救不回来。
      assert.match(
        t['--scrim-rgb'], /^\d{1,3},\d{1,3},\d{1,3}$/,
        `${id}.${mode}.--scrim-rgb 不是 r,g,b 形状：${t['--scrim-rgb']}`
      );
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
