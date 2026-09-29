// 发票筛选行的 id 清单必须与 reimburse-model 的 FILTER_IDS 逐项一致（任务 6 质检补的守卫）。
//
// 为什么用读文件 + 正则、而不是 import invoice-view.js：那个模块静态 import
// invoice-store → IndexedDB，在 Node 里根本 import 不了——这也正是「两份副本没有守卫」的根因。
// 守卫要能跑，就只能从源码文本里抽。
//
// 为什么值得有：若有人给界面加了第六个筛选而 matchFilter 不认，那个筛选会走 default
// 分支（return true），表现为**静默显示全部**、不报错。
//
// 抽取处的写法照 tests/boot-order.test.js 的既有模式：文件读不到字面量就当场报红，
// 免得出现「一条都没抽到、断言照样全绿」这种失明的守卫。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FILTER_IDS } from '../app/reimburse-model.js';

const src = readFileSync(new URL('../app/ui/invoice-view.js', import.meta.url), 'utf8');

test('发票筛选行的 id 与 FILTER_IDS 逐项一致（含顺序）', () => {
  const filtersBlock = src.match(/const FILTERS = \[([\s\S]*?)\];/);
  assert.ok(filtersBlock, 'invoice-view.js 里应当有 const FILTERS = [...]; 这个字面量');
  const ids = [...filtersBlock[1].matchAll(/id:\s*'([^']+)'/g)].map(m => m[1]);
  assert.deepEqual(ids, FILTER_IDS, '两处清单必须逐项一致，否则新筛选会静默显示全部');
  assert.equal(ids.length, 5);
  // 顺序也要对：规格 §7.2 写的是 全部 / 待报销 / 已报销 / 未挂账 / 仅存档。
  assert.deepEqual(ids, ['all', 'pending', 'reimbursed', 'unlinked', 'stored']);
});
