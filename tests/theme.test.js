// 外观系统的纯逻辑测试。theme.js 不碰 DOM 与 IndexedDB，所以这一套能直接在 Node 里跑。
import test from 'node:test';
import assert from 'node:assert/strict';
import { THEMES, THEME_TOKENS, THEME_IDS } from '../app/theme.js';

test('theme：五套皮肤 × 深浅的变量集合完全一致', () => {
  const base = Object.keys(THEME_TOKENS.default.light).sort();
  assert.ok(base.length > 0, 'default.light 一个变量都没有');
  for (const id of THEME_IDS) {
    assert.ok(THEME_TOKENS[id], `缺少皮肤 ${id} 的色板`);
    for (const mode of ['light', 'dark']) {
      const tokens = THEME_TOKENS[id][mode];
      assert.ok(tokens, `${id}.${mode} 缺失`);
      // 判据是「键集合与 default.light 完全一致」而不是「数量够」：
      // 少一个变量就是界面上某处变成透明/黑块，而多一个说明这套皮肤偷偷开了新维度。
      assert.deepEqual(
        Object.keys(tokens).sort(), base,
        `${id}.${mode} 的变量集合与 default.light 不一致`
      );
    }
  }
});

test('theme：THEME_IDS 与 THEMES 一一对应且含 default', () => {
  assert.deepEqual(THEME_IDS, THEMES.map(t => t.id));
  assert.ok(THEME_IDS.includes('default'));
  assert.equal(new Set(THEME_IDS).size, THEME_IDS.length, '皮肤 id 有重复');
});

test('theme：每套皮肤都有非空的中文名', () => {
  for (const t of THEMES) {
    assert.equal(typeof t.name, 'string', `${t.id} 没有名字`);
    assert.ok(t.name.trim(), `${t.id} 的名字是空的`);
  }
});
