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
import { OVERLAY_DEFAULT } from '../app/theme.js';
import { summarizeBackup } from '../app/backup.js';
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

// assets 表里现在有哪些 id。**「只删 'bg' 这一条」与「整表清空」在只放了一条记录时结果一样**，
// 所以凡是要区分这两者的测试，都必须先在这张表里放第二条记录（见「按主键删」那两条）。
async function assetIds() {
  return (await db.getAll('assets')).map(r => r.id).sort();
}

// 第二条资源记录的夹具：assets 是通用资源表（schema.js 写着「目前只有一张背景照片」，
// 但那句话描述的是今天，不是这张表的契约）。
async function putOtherAsset() {
  const blob = new Blob([new Uint8Array([42])], { type: 'image/jpeg' });
  await db.put('assets', { id: 'other', blob, mime: 'image/jpeg', size: blob.size, createdAt: 1 });
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

// ── 下面这批是复审（第一轮）指出的缺口：每一条都对着一个具体的变异 ──────────────

test('成对①（源状态：图在库里、设置那条丢了）→ 导入后两处都在，且遮罩按默认补上', async () => {
  // 这个源状态**不是**手改出来的：`setPhoto` 写 assets 成功、写设置失败就会留下它，
  // 而 `encodeBackground` 只认 assets 那条记录——于是它会原样进备份、**自我复制**到下一台设备。
  // 第一轮实现只把图写回去、不补设置行，于是导入端复制出来的还是「图在库里、没人引用」：背景不显示。
  const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/jpeg' });
  await db.put('assets', { id: BG_ID, blob, mime: 'image/jpeg', size: blob.size, createdAt: 1700000000000 });
  assert.equal(await db.get('settings', BG_KEY), undefined, '前置条件：设置里没有那一行');

  const { text } = await exportBackup(PASSWORD);
  const pkg = await unseal(text);
  assert.notEqual(pkg.data.background, null, '导出侧只认 assets，所以这种源状态会带上背景');
  assert.equal(pkg.data.background.overlay, null, '设置里没有那一行 → 遮罩是「没有」，不是 0');
  assert.equal(pkg.data.settings.some(r => r.key === BG_KEY), false, '备份的 settings 里确实没有那一行');

  await clearAll();
  await importBackup(text, PASSWORD);

  assert.deepEqual(await backgroundPair(), { asset: true, setting: true },
    '备份带图时导入侧必须保证设置里有一行指向它，否则复制出来的还是「没人引用」');
  assert.equal((await db.get('settings', BG_KEY))?.value?.overlay, OVERLAY_DEFAULT,
    '背景包里的 overlay 是 null → 补出来的这一行按 theme.js 的默认遮罩');
  assert.equal((await db.get('settings', BG_KEY))?.value?.assetId, BG_ID);
});

test('导入带背景的备份：assets 里**别的**资源记录不受影响（带背景时不清表）', async () => {
  // 这一条抓的是「整表清空」那种写法：把 `if (!bgBlob) deletes.push({ store:'assets', key:'bg' })`
  // 换成 `clears.push('assets')` → 实测红（7 条，含本文件里两条 assets 断言）。
  // **如实说明一个抓不住的**：去掉 `if (!bgBlob)` 条件、改成无条件 `deletes.push(...)` 同一条 key
  // → 实测**一条都不红**，因为它是**等价变异**：deletes 只删主键 'bg' 那一条，而备份带背景时
  // 紧接着的 put 会把它写回来（db.replaceAll 的执行顺序是 clear → delete → put），最终结果一样。
  // 也就是说，「条件」在新实现下不是行为契约，真正被守的是**「只删那一条、不整表清」**这件事；
  // 想让「条件」本身可观察，得让被删的键与写回的键不是同一个——那不是一个真实场景，不做。
  await putBackground({ overlay: 45 });
  await putOtherAsset();
  const { text } = await exportBackup(PASSWORD);

  await clearAll();
  await putBackground({ overlay: 10 });
  await putOtherAsset();

  await importBackup(text, PASSWORD);

  assert.deepEqual(await assetIds(), ['bg', 'other'], '备份带了背景时不该动 assets 里的其他记录');
  assert.equal((await db.get('settings', BG_KEY))?.value?.overlay, 45, '遮罩换成备份里的那个');
});

test('导入不带背景的备份：只按主键删掉 bg，assets 里别的资源记录留着', async () => {
  // 第一轮用的是 clears.push('assets')＝**整表清空**，会把 'other' 一起删掉。
  // 注释里写着「清单不该靠『现在只有一条』活着」，实现却靠的正是「现在只有一条」——
  // 这一条就是钉住那句话的。
  const noBg = await seal(backupData());

  await putBackground({ overlay: 45 });
  await putOtherAsset();
  assert.deepEqual(await assetIds(), ['bg', 'other'], '前置条件');

  await importBackup(noBg, PASSWORD);

  assert.deepEqual(await assetIds(), ['other'], '只该删掉 bg 那一条，整表清空会连 other 一起删');
  assert.deepEqual(await backgroundPair(), { asset: false, setting: false });
});

test('导入：备份里没有 createdAt 时用导入时刻，不是 0', async () => {
  // 变异背景：把 `Number(bg.createdAt) || Date.now()` 改成 `|| 0`。0 是 1970-01-01，
  // 一个像真实时间的哨兵值——theme.js 的 normalizeBackground 判过同一件事。
  const pkg = backupData({
    background: { overlay: 45, createdAt: null, mime: 'image/jpeg', image: 'AAAA' }
  });
  await importBackup(await seal(pkg), PASSWORD);

  const asset = await db.get('assets', BG_ID);
  assert.ok(asset.createdAt > 0, `createdAt 实测 ${asset.createdAt}，应当是导入时刻（>0）`);
  assert.equal((await db.get('settings', BG_KEY))?.value?.createdAt, asset.createdAt,
    '补出来的设置行与 assets 记录用同一个时间');
});

test('导出：遮罩脏值被夹紧取整（-5 / 9999 / 30.7 → 0 / 60 / 31）', async () => {
  // 值域必须与 theme.js 的 normalizeOverlay 同源：它 Math.round 并夹到 0..60。
  // 第一轮的 overlayOrNull 只判类型、不夹紧，-5 / 9999 / 30.7 会原样进备份包，
  // 再被导入侧写回 settings——同一个数字走一圈就变了样。
  const cases = [[-5, 0], [9999, 60], [30.7, 31]];
  for (const [raw, want] of cases) {
    await clearAll();
    await putBackground({ overlay: raw });
    const pkg = await unseal((await exportBackup(PASSWORD)).text);
    assert.equal(pkg.data.background.overlay, want, `overlay=${raw} 应当被夹紧取整成 ${want}`);
  }
});

test('导出：assets 记录缺 mime 时写 image/jpeg（不是 undefined）', async () => {
  const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' });
  await db.put('assets', { id: BG_ID, blob, mime: '', size: blob.size, createdAt: 1 });
  const pkg = await unseal((await exportBackup(PASSWORD)).text);
  assert.equal(pkg.data.background.mime, 'image/jpeg');
});

test('导入：备份里缺 mime 时 assets.mime 是 image/jpeg', async () => {
  // 这一条与上面那条是一对：两侧的兜底必须一样，否则同一张照片在两个方向上的 mime 不同。
  const pkg = backupData({
    background: { overlay: 45, createdAt: 1, image: 'AAAA' }   // 没有 mime
  });
  await importBackup(await seal(pkg), PASSWORD);
  assert.equal((await db.get('assets', BG_ID))?.mime, 'image/jpeg');
});

test('导入：background 是字符串（形状不对）→ 当没有背景，本机那条被删掉', async () => {
  // 如实说一句：这条**抓不住** `(bg && typeof bg === 'object')` → `bg` 这个变异。
  // 对任何非对象的真值（字符串 / 数字 / true），`bg.image` 都是 undefined，
  // 两种写法都走到「没有背景」——它是**等价变异**，不是测试缺口（实测过：改了也全绿）。
  // 判据留着是为了让「这里只接受一个对象」这个意图在读代码时是显式的。
  await putBackground({ overlay: 45 });
  await importBackup(await seal(backupData({ background: 'AAAA' })), PASSWORD);
  assert.deepEqual(await backgroundPair(), { asset: false, setting: false });
});

test('桩的索引筛选：getAllByIndex 只返回键命中的记录', async () => {
  // 这条钉的是 tests/helpers/fake-browser.js 自己：第一版 index().getAll 只按范围过滤，
  // 传 key 时**一条都不过滤**（`getAllByIndex('txns','by_kind','food')` 返回全部记录）——
  // 静默的错误结果，将来谁在桩上写索引测试都会拿到假绿。
  await db.put('txns', { id: 't1', kind: 'food', amountCents: 100, occurredAt: 1 });
  await db.put('txns', { id: 't2', kind: 'traffic', amountCents: 200, occurredAt: 2 });

  const food = await db.getAllByIndex('txns', 'by_kind', 'food');
  assert.deepEqual(food.map(t => t.id), ['t1']);
  const all = await db.getAll('txns');
  assert.equal(all.length, 2, '前置条件：库里确实有两条不同 kind 的记录');
});

test('摘要的 hasBackground 与导入的实删行为同向（那一行不能写反）', async () => {
  // 摘要是用户点「确认覆盖并恢复」之前唯一一次知情机会，而背景的处置方向与发票图片**相反**：
  // 摘要说「不包含」时，导入会把本机那张删掉。判据必须与 importBackup 的实际行为对齐，
  // 否则用户按「不包含就保留」去推，推错一次就是本机唯一一份照片。
  const withBg = backupData({
    background: { overlay: 45, createdAt: 1, mime: 'image/jpeg', image: 'AAAA' }
  });
  const withoutBgKey = backupData();                       // 加背景之前导出的老备份
  const withoutBgValue = backupData({ background: null }); // 新格式但那次没带上

  for (const data of [withBg, withoutBgKey, withoutBgValue]) {
    await clearAll();
    await putBackground({ overlay: 45 });
    const text = await seal(data);
    const summary = summarizeBackup(await unseal(text));

    await importBackup(text, PASSWORD);
    const kept = (await assetIds()).includes(BG_ID);
    assert.equal(summary.hasBackground, kept,
      `摘要说 hasBackground=${summary.hasBackground}，而导入后 bg 记录${kept ? '还在' : '没了'}——两边反了`);
  }
});

test('导出通道：背景读失败时 backgroundSkipped 为 true、库里没有背景时为 false', async () => {
  // 静默降级是复审点名的必修项：用户看到「已导出」却没被告知照片没进去，
  // 而那张图可能已经是设备上唯一的一份。通道就是这一条断言守的东西
  // （界面那一行在 app/ui/backup-view.js 的 export-background-skipped）。
  const blob = new Blob([new Uint8Array([1])], { type: 'image/jpeg' });
  await db.put('assets', { id: BG_ID, blob: 'not-a-blob', mime: 'image/jpeg', size: blob.size, createdAt: 1 });
  const broken = await exportBackup(PASSWORD);
  assert.equal(broken.backgroundSkipped, true, '图在库里却没读出来 → 必须报出来');
  assert.equal((await unseal(broken.text)).data.background, null);

  await clearAll();
  const none = await exportBackup(PASSWORD);
  assert.equal(none.backgroundSkipped, false, '库里压根没有背景不是降级，不该报警');
});

// 计划里的任务 13 是这次改动的**权威说明**，仓库纪律是「计划里的代码块必须与仓库实际内容逐字符一致」。
// 这条守卫把那次人工核对固定下来：任务 13 段落里的每个 js 代码块都必须是目标文件的连续子串。
// 为什么值得单独一条：本次改动引入了 100 多行新代码与 8 个镜像代码块，而 `check-theme-css.mjs` 的 ⑦
// 只守任务 9 的那几块——改一行注释就能让镜像静默漂移，下一次评审要靠肉眼重读一遍全文。
// 任务 14 复核过了：这条纪律已经**推广**成 `scripts/check-theme-css.mjs` 的 ⑮（一张按任务分段的表，
// 覆盖任务 2–7 与 10–13；任务 11 那个 298 行的大块用「整文件逐字符相等 + 一处已声明偏差的补丁」，
// 其余是「块必须是目标文件的连续子串」）。**这里保留同一条**，不删：`node --test` 与那个静态核验脚本
// 是两个入口，只跑其中一个时它还是一道守卫（任务 13 写下的「届时应把这条挪到脚本里去」按此执行——
// 搬的是纪律的覆盖面，不是把这一条从测试里搬走）。
// 代价如实写在这里：块数常量 8 现在有两份（这里与 ⑮ 的表），加块 / 删块时两边一起改。
test('计划任务 13 的 js 代码块与仓库代码逐字符一致', () => {
  const plan = read('docs/superpowers/plans/2026-09-26-pvault-custom-background.md');
  const at = plan.indexOf('## 任务 13：');
  const end = plan.indexOf('## 任务 14：', at);
  assert.ok(at >= 0 && end > at, '锚点失效：没切出任务 13 段落——这条断言没跑，别当成通过');
  const section = plan.slice(at, end);

  const blocks = [...section.matchAll(/```js\n([\s\S]*?)```/g)].map(m => m[1].replace(/\n$/, ''));
  // 块数用**精确相等**，不是下限：`>= 6` 在删掉两块之后照样绿（实测过）。
  // 仓库里同一个位置上，scripts/check-theme-css.mjs 的 ⑦ 用的就是精确相等（`=== 2`），
  // tests/backup.test.js 的 data 键集断言也是「完全相等」——这条与它们同构。
  // 加块/删块都要在这里改一次，顺手想清楚计划那边是不是也该动。
  assert.equal(blocks.length, 8,
    `计划任务 13 段落里实测 ${blocks.length} 个 js 代码块，期望 8 个——块数变了，别当成通过`);
  // 空块是恒真的（'' 是任何字符串的子串）：少了这一条，「把块清空」这种变异会让下面那句
  // 「每个块都能在源码里找到」永远成立——守卫静默失明比没有守卫更危险。
  assert.ok(blocks.every(b => b.trim() !== ''), '抽到了空代码块：这条守卫对它是恒真的');

  const sources = { 'app/backup.js': read('app/backup.js'), 'app/backup-store.js': read('app/backup-store.js') };
  blocks.forEach((block, i) => {
    const hit = Object.entries(sources).find(([, src]) => src.includes(block));
    assert.ok(hit,
      `计划任务 13 的第 ${i + 1} 个代码块（${block.split('\n').length} 行，首行：`
      + `${(block.split('\n').find(l => l.trim() !== '') ?? '').slice(0, 40)}）`
      + '在 app/backup.js 与 app/backup-store.js 里都找不到逐字符匹配——两边有一处漂移了');
  });
});
