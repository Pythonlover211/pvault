// 备份「带背景照片」的往返守卫（计划任务 13）。
//
// 为什么要有它：app/backup-store.js 的导出与导入是两段独立代码，而背景又跨了两张表
// （assets 里那条 'bg' 记录 + settings 里那条 backgroundImage）。只测一边，漏掉的恰好是
// 「导出带了、导入没写回」或「导入只清了一半」——`invoiceFiles` 那次就是这么栽的
// （设计里写着「备份是整表导出、不用改」，于是 name 字段漏到换机才暴露）。
// 所以下面每条都成对读：**assets 与 settings 两处的状态必须一致**，`backgroundPair()` 就是那个判据。
//
// 环境：真的 IndexedDB 在 Node 里不存在，这里用 tests/helpers/fake-browser.js 装的内存版
// （它盖得住什么、盖不住什么写在那份文件的开头，别把这里的绿读成真机验证）。
// app/db.js 与 app/backup-store.js 的模块体都不碰浏览器全局，所以可以直接 import——
// 只要在**调用**它们之前把桩装好（下面那行 installFakeBrowser()）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFakeBrowser, resetFakeDatabases } from './helpers/fake-browser.js';
import * as db from '../app/db.js';
import { exportBackup, importBackup } from '../app/backup-store.js';
import { STORES } from '../app/schema.js';
import { deriveKey, encryptJSON, decryptJSON, randomBytes, toBase64, fromBase64 } from '../app/crypto.js';

installFakeBrowser();

const read = rel => readFileSync(new URL('../' + rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const PASSWORD = 'backup-password-1';
const BG_ID = 'bg';
const BG_KEY = 'backgroundImage';

// 背景照片与它的设置行——「一对」的判据。返回两个布尔：库里有没有那张图、设置里有没有那一行。
// 成对处理的意思就是这两个值永远相等（要么都 true、要么都 false）。
async function backgroundPair() {
  const asset = await db.get('assets', BG_ID);
  const setting = await db.get('settings', BG_KEY);
  return { asset: Boolean(asset?.blob), setting: Boolean(setting) };
}

async function putBackground({ overlay = 45, createdAt = 1700000000000 } = {}) {
  const blob = new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])], { type: 'image/jpeg' });
  await db.put('assets', { id: BG_ID, blob, mime: 'image/jpeg', size: blob.size, createdAt });
  await db.put('settings', { key: BG_KEY, value: { assetId: BG_ID, overlay, createdAt } });
  return blob;
}

// 把库清成空的（保留表结构）。db.js 把连接缓存在模块级，换成「重建库」会让缓存指向旧 store。
async function clearAll() {
  await db.replaceAll({ clears: Object.keys(STORES), puts: [] });
}

test.beforeEach(async () => {
  resetFakeDatabases();
  await clearAll();
});

// 造一份**任意形状**的备份文件（包括 exportBackup 造不出来的老格式）。用的是同一个信封格式，
// 只有迭代次数取小值——测试不需要 60 万轮，真机那条路由下面的 exportBackup 覆盖。
async function seal(data, password = PASSWORD) {
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt, 1000);
  const { iv, ct } = await encryptJSON(key, { format: 'pvault-backup', version: 1, createdAt: 1, data });
  return JSON.stringify({
    format: 'pvault-backup-encrypted', version: 1, createdAt: 1,
    kdf: { name: 'PBKDF2-SHA256', iterations: 1000, salt: toBase64(salt) }, iv, ct
  });
}

async function unseal(text, password = PASSWORD) {
  const parsed = JSON.parse(text);
  const key = await deriveKey(password, fromBase64(parsed.kdf.salt), parsed.kdf.iterations);
  return decryptJSON(key, { iv: parsed.iv, ct: parsed.ct });
}

// 必填数组齐、其余留空的备份包内容。老备份就是在这个基础上没有 background 键。
function backupData(extra = {}) {
  return {
    txns: [], accounts: [], categories: [], receivables: [],
    settings: [{ key: 'hideAmounts', value: false }],
    ...extra
  };
}

test('导出：带背景的库里 data.background 带上图片、遮罩与格式', async () => {
  await putBackground({ overlay: 45 });
  await db.put('txns', { id: 't1', kind: 'expense', amountCents: 100, occurredAt: 1 });

  const { text } = await exportBackup(PASSWORD);
  const pkg = await unseal(text);

  assert.equal(pkg.data.background.overlay, 45, '遮罩强度必须跟着照片一起走');
  assert.equal(pkg.data.background.mime, 'image/jpeg');
  assert.equal(pkg.data.background.createdAt, 1700000000000);
  assert.equal(typeof pkg.data.background.image, 'string');
  assert.ok(pkg.data.background.image.length > 0, 'base64 串不能是空的——空串会被导入侧当成「没有背景」');
});

test('成对①：带背景导出 → 导入空库 → assets 与 settings 两处都回来', async () => {
  await putBackground({ overlay: 45 });
  await db.put('txns', { id: 't1', kind: 'expense', amountCents: 100, occurredAt: 1 });
  const { text } = await exportBackup(PASSWORD);

  // 「换一台空手机」：库清干净
  await clearAll();
  assert.deepEqual(await backgroundPair(), { asset: false, setting: false }, '前置条件：清库后两处都该是空的');

  await importBackup(text, PASSWORD);

  assert.deepEqual(await backgroundPair(), { asset: true, setting: true }, '背景图与它的设置行必须一起回来');
  const asset = await db.get('assets', BG_ID);
  assert.ok(asset.blob instanceof Blob, '写回 assets 的必须是 Blob，不是 base64 串');
  assert.equal(asset.mime, 'image/jpeg');
  assert.equal(asset.size, 8);
  // 只验「背景回来了」会漏掉「遮罩强度没跟着走」这种一半成功的恢复（45 是刻意选的、不是默认的 30）
  assert.equal((await db.get('settings', BG_KEY))?.value?.overlay, 45);
});

test('成对②：不含背景的备份 → 导入有背景的库 → 两处一起被清掉，不留悬空设置', async () => {
  // A 机：没设过背景（导出包里 background 是 null）
  await db.put('txns', { id: 't1', kind: 'expense', amountCents: 100, occurredAt: 1 });
  const { text } = await exportBackup(PASSWORD);
  assert.equal((await unseal(text)).data.background, null);

  // B 机：有背景
  await clearAll();
  await putBackground({ overlay: 45 });
  assert.deepEqual(await backgroundPair(), { asset: true, setting: true });

  await importBackup(text, PASSWORD);

  // 两处必须同时为空：只清设置会留下「图在库里、没人引用」（下次导出又把它带给别人）；
  // 只清图会留下一条指向不存在记录的悬空设置（theme-store 的 applyPhoto 要等下次启动才自愈）。
  assert.deepEqual(await backgroundPair(), { asset: false, setting: false });
  assert.equal((await db.getAll('assets')).length, 0);
});

test('成对②补充：加发票之前导出的老备份（data 里连 background 键都没有）同样两处一起清', async () => {
  await putBackground({ overlay: 45 });

  // backupData() 里本来就没有 background 键——那就是「加背景之前导出的备份」的形态
  const old = backupData();
  await importBackup(await seal(old), PASSWORD);

  assert.deepEqual(await backgroundPair(), { asset: false, setting: false });
});

test('成对②补充：备份带了图但这段 base64 解不开 → 两处一起清，不写回那条设置行', async () => {
  await putBackground({ overlay: 45 });

  // 4 个字符、长度是 4 的倍数，但 atob 会抛——base64ToBlob 判成「解不开」返回 null
  const broken = backupData({
    background: { overlay: 45, createdAt: 1, mime: 'image/jpeg', image: '!!!!' },
    // 关键：备份的 settings 里**有**那一行。不跳过它就会留下一条指向不存在记录的悬空设置。
    settings: [{ key: 'hideAmounts', value: false }, { key: BG_KEY, value: { assetId: BG_ID, overlay: 45, createdAt: 1 } }]
  });
  await importBackup(await seal(broken), PASSWORD);

  assert.deepEqual(await backgroundPair(), { asset: false, setting: false },
    '解不出图的备份不能留下 backgroundImage 这一行');
});

test('导出：勾了「不含图片」时背景照片仍然进备份（规格 §4.3）', async () => {
  await putBackground();
  await db.put('invoiceFiles', {
    id: 'f1', name: 'a.jpg', mime: 'image/jpeg', size: 3, createdAt: 1,
    blob: new Blob([new Uint8Array([9, 9, 9])], { type: 'image/jpeg' }), thumbBlob: null
  });

  const { text, skipped } = await exportBackup(PASSWORD, Date.now(), { includeFiles: false });
  const pkg = await unseal(text);

  assert.deepEqual(pkg.data.invoiceFiles, [], '这个是「不含图片」开关管的那一项');
  assert.ok(pkg.data.background?.image, '背景图不受这个开关影响：用户选的那张照片可能早就删了');
  assert.equal(skipped, 0);
});

test('导出：遮罩强度 0 是合法值，写成 0 而不是 null', async () => {
  // OVERLAY_MIN 就是 0（完全不加遮罩），滑块能拖到那一格
  await putBackground({ overlay: 0 });
  const pkg = await unseal((await exportBackup(PASSWORD)).text);
  assert.equal(pkg.data.background.overlay, 0);
});

test('导出：设置里没有 backgroundImage 那一行时，遮罩写成 null 而不是 0', async () => {
  // 真实来源：setPhoto 写 assets 成功、写设置失败，或用户在库里手改过。
  // `Number(meta?.overlay) >= 0` 这种写法会把这里的 Number(undefined)=NaN 之外的
  // null / '' / false 一并洗成 0——那是「用户选了 0% 遮罩」，一件从没发生过的事。
  const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' });
  await db.put('assets', { id: BG_ID, blob, mime: 'image/jpeg', size: blob.size, createdAt: 1 });

  const pkg = await unseal((await exportBackup(PASSWORD)).text);
  assert.equal(pkg.data.background.overlay, null, '「没有这个值」只能用 null 表达');
  assert.equal((await db.get('settings', BG_KEY)), undefined);

  // 显式的 null / 空串 / false 同样是「没有」，不能变成 0
  for (const raw of [null, '', false]) {
    await db.put('settings', { key: BG_KEY, value: { assetId: BG_ID, overlay: raw, createdAt: 1 } });
    const p = await unseal((await exportBackup(PASSWORD)).text);
    assert.equal(p.data.background.overlay, null, `overlay=${JSON.stringify(raw)} 该是 null`);
  }
});

test('导出：库里没有背景时 data.background 是 null（键在、值为 null）', async () => {
  const pkg = await unseal((await exportBackup(PASSWORD)).text);
  assert.equal(pkg.data.background, null);
  assert.ok('background' in pkg.data, '键必须在：导入侧据它的值判断要不要清本机的背景');
});

// 计划里的任务 13 是这次改动的**权威说明**，仓库纪律是「计划里的代码块必须与仓库实际内容逐字符一致」。
// 这条守卫把那次人工核对固定下来：任务 13 段落里的每个 js 代码块都必须是目标文件的连续子串。
// 为什么值得单独一条：本次改动引入了 100 多行新代码与 8 个镜像代码块，而 `check-theme-css.mjs` 的 ⑦
// 只守任务 9 的那几块——改一行注释就能让镜像静默漂移，下一次评审要靠肉眼重读一遍全文。
// （计划任务 14 要复核/扩展那个脚本，届时应把这条挪到脚本里去，与 ⑦ 放在一起。）
test('计划任务 13 的 js 代码块与仓库代码逐字符一致', () => {
  const plan = read('docs/superpowers/plans/2026-09-26-pvault-custom-background.md');
  const at = plan.indexOf('## 任务 13：');
  const end = plan.indexOf('## 任务 14：', at);
  assert.ok(at >= 0 && end > at, '锚点失效：没切出任务 13 段落——这条断言没跑，别当成通过');
  const section = plan.slice(at, end);

  const blocks = [...section.matchAll(/```js\n([\s\S]*?)```/g)].map(m => m[1].replace(/\n$/, ''));
  assert.ok(blocks.length >= 6,
    `只抽到 ${blocks.length} 个 js 代码块（实测基线 8）——抽取失效了，别当成通过`);

  const sources = { 'app/backup.js': read('app/backup.js'), 'app/backup-store.js': read('app/backup-store.js') };
  blocks.forEach((block, i) => {
    const hit = Object.entries(sources).find(([, src]) => src.includes(block));
    assert.ok(hit,
      `计划任务 13 的第 ${i + 1} 个代码块（${block.split('\n').length} 行，首行：`
      + `${(block.split('\n').find(l => l.trim() !== '') ?? '').slice(0, 40)}）`
      + '在 app/backup.js 与 app/backup-store.js 里都找不到逐字符匹配——两边有一处漂移了');
  });
});
