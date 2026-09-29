// 备份仓库层：把一个设备的全部数据打包成一个加密文件，以及从该文件恢复回来。
//
// 文件分两层：外层是「加密信封」，内层是 app/backup.js 定义的备份包（含记账数据与密码箱记录）。
// 外层长这样：
//
//   { format: 'pvault-backup-encrypted', version: 1, createdAt,
//     kdf: { name: 'PBKDF2-SHA256', iterations, salt }, iv, ct }
//
// 七条不能破的约定：
// 1. 每次导出都用**新生成的随机 salt**。复用 salt 会让同一个备份密码在任何时间导出的文件
//    用同一把密钥，那就等于把「一次泄露 = 全部历史文件可解」写死进格式里。
// 2. 导出的加密与导入的解密都以文件里 kdf.salt / kdf.iterations 为准：迭代次数会随版本涨，
//    老备份必须按它当初写下的轮数解开。
// 3. 导入必须先「解密 + 校验」全部通过，才允许碰现有数据；覆盖动作收在 db.replaceAllRecords 的
//    一个事务里——中途失败绝不能留下「旧数据已清、新数据没写进去」的空库。
// 4. 备份里没有密码箱时，**保留**目标设备现有的密码箱。删掉它等于顺手毁掉用户设备上
//    唯一一份密码箱密文，而备份文件里根本没有它的替补。
// 5. 备份里带密码箱时，覆盖完成后立刻上锁：新记录的 DEK 与内存里的会话多半不配套，
//    带着老会话继续写会把新密码箱的条目加密成一把再也解不开的钥匙（见 importBackup）。
// 6. invoiceFiles **只在备份真的带了图片时才清空本机**（见 importBackup 的 clears）。
//    备份里没有图片时（老备份根本没有这个键，或者是「不含图片」导出的），一律保留本机现有的原图。
//    理由与第 4 条同源：**没有替补的东西，一律不删**。清空是为了「覆盖恢复之后不留下上一份数据的
//    图片残留」，而备份里没有图片时压根没有可覆盖的东西，清空只会删掉本机唯一的一份原图——
//    而备份文件里没有它们的替补。别为了跟 ARRAY_STORES 那些表「统一」把它改成有键就清：
//    那等于把「恢复备份」这条唯一的救命通道变成一把毁数据的开关。
// 7. 背景照片是**一对**东西：`assets` 里 id 为 'bg' 的那条记录，与 `settings` 里那条
//    `backgroundImage`（它指向 'bg'）。导入侧必须成对处理：备份里带了背景就两处一起写回，
//    没带就两处一起清掉。这条与第 4、6 条方向相反，因为它面对的是另一件事：**settings 是整表
//    覆盖的**，备份里没有 `backgroundImage` 那一行时，本机那一行必然在这次导入里被清掉——
//    第 4 条的 vault 之所以保得住，是因为那里显式写了一行回去（本机背景没有这条待遇）。
//    也就是说，导入一份不含背景的备份之后，本机那张背景图**已经失去引用、画面上也没有它了**，
//    此时把字节留在库里不是「保住用户的东西」，只是让它在下一次导出里复活并跟着备份跑到第三台
//    设备上去（encodeBackground 只认 assets 那条记录，根本不看设置里有没有引用）。
//    要真保住本机背景，正确的做法是像 vault 那样把设置行也一并保留、两处都不动；**只留一半**
//    （留图丢设置、或留设置丢图）正是这一条要禁止的，见 importBackup 里的处理：
//      · 备份带图、而备份的 settings 里没有那一行（源机器上就是「图在库里、没人引用」——而这种
//        状态会被 encodeBackground 原样导出，于是它**自我复制**下去）→ 用背景包里的 overlay /
//        createdAt **现造一行补上**，让「图 + 引用」一起落地；
//      · 备份没带图 → 把本机那条记录**按主键删掉**（走 db.replaceAllRecords 的 deletes，不是 clears——
//        assets 是通用资源表，这里要动的只有 'bg' 一条），并跳过备份 settings 里那一行。
//    离开一半的状态在这一层是不允许存在的，两个方向都要堵。
//
// 本模块依赖 db.js（IndexedDB）与 crypto.js（WebCrypto 全局）：**模块体能 import**（那两处都只在
// 函数体里碰全局），但导出函数一调用就需要一个 IndexedDB 环境，所以它**不能**像 backup.js / theme.js
// 那样只靠纯函数单测。能盖住它的那条路是「造桩」——tests/backup-store.test.js 装了一个内存版
// 浏览器环境（tests/helpers/fake-browser.js）再调本模块的导出函数；**真机上的真实 IndexedDB 与文件下载
// 仍然只能人工验**，见 docs/手动验证清单.md 的「备份与恢复」小节。桩测不了什么、为什么不能用它
// 替代真机，写在 fake-browser.js 的头注释里，别把那里的绿读成「浏览器里也就这样」。

import * as db from './db.js';
import * as vaultStore from './vault-store.js';
import {
  DEFAULT_ITERATIONS, deriveKey, encryptJSON, decryptJSON, randomBytes, toBase64, fromBase64
} from './crypto.js';
import { BACKUP_FORMAT, buildBackup, validateBackup, summarizeBackup } from './backup.js';
// 体积估算在 image-scale.js 里（纯函数、可单测）。刻意直接 import 它而不是走 image-store.js：
// image-store 只是把它转发出来，而那条路径会连带牵进 Canvas 相关的一整串模块。
import { estimateBackupMB } from './image-scale.js';
// 遮罩强度的归一化（夹紧到 0..60 并取整）从 theme.js 拿，**不在这里另写一套**：同一个值会在
// 「设置 → 备份包 → 设置」这条路上走一圈，两套判据只要有一点不同，用户调过的 30 就会在往返之后
// 变成别的东西。theme.js 是纯模块（不碰 DOM / IndexedDB / Canvas），import 它不牵进任何浏览器 API。
import { normalizeOverlay } from './theme.js';

export const ENCRYPTED_FORMAT = 'pvault-backup-encrypted';
export const ENCRYPTED_VERSION = 1;

// 文件名后缀固定 .pvault：用户一眼能认出「这是本 app 的备份文件」，也不会被系统当成可执行文件。
const FILE_EXT = '.pvault';
const SALT_BYTES = 16;

const VAULT_KEY = 'vault';
const LAST_BACKUP_KEY = 'lastBackupAt';

// 含图导出的内存峰值远大于备份体积本身：数据要在「编码数组 → JSON 字符串 → 字节数组 →
// 密文 → base64 串 → 下载 Blob」这条链上被完整复制好几份，几百 MB 的串在安卓 WebView 上
// 很可能直接把进程撑死。而失败发生在加密之后——用户等完 PBKDF2 的 60 万轮，换来的是
// 「导出失败、一份备份都没有」。所以在动手之前就拦住，让他改用「不含图片」导出。
const MAX_INLINE_FILES_BYTES = 45 * 1024 * 1024;   // 原图字节，约合 base64 后的 60MB

// 参与备份的数组仓库：**显式列出来，不要从 Object.keys(STORES) 派生**。
// 派生踩过一次：schema 里加了发票三张表之后，这个清单跟着变成 7 张，
// 而 buildBackup 仍然只打包 5 个键——导入老备份时 data.invoices 是 undefined，
// 下面那句 `for (const value of data[name])` 直接抛 TypeError，
// 于是「恢复备份」这条唯一的救命通道对所有既有备份文件全部失效。
// 哪张表要进备份，就在这里一个一个加，并同时改 app/backup.js 的 buildBackup；
// 但**不要**顺手加进 REQUIRED_ARRAYS——那张清单是「老备份必须也有」的意思，
// 新字段进去就会把既有备份全部判成坏文件（见那边的注释）。
//
// invoices 现在在这里（发票条目是纯 JSON，能进备份包）。
// **reimbursements 也在这里**：报销单本身是纯 JSON，但它与发票的**归属关系**靠
// invoices.reimbursementId 表达，而 invoices 也在同一个清单里 —— 两者必须同进同出，
// 少一个就会恢复出「报销单在、票不知道属不属于它」或者反过来的悬空状态。
// **invoiceFiles 不在这里**：它的 blob / thumbBlob 是 Blob，JSON.stringify(blob) 得到 `{}`，
// 直接进下面那个循环只会往备份里塞一堆空壳，恢复出来就是「有记录、没图片」。
// 它由 encodeFiles() 单独转成 base64 再打包，导入时由 base64ToBlob() 单独反解。
const ARRAY_STORES = ['txns', 'accounts', 'categories', 'receivables', 'invoices', 'reimbursements'];

// 背景照片那一对名字。图片本身存在 assets 表里（见 schema.js），设置里那一行只存引用与遮罩强度
// （`{ assetId, overlay, createdAt }`，见 theme-store.js 的 setPhoto）。
// `'bg'` 与 theme-store.js 导出的 BACKGROUND_ASSET_ID **是同一把钥匙**，这里刻意再定义一次而不从
// 那边 import：theme-store 会牵进 DOM 与 Canvas 一整串模块，这一层不需要它们（image-scale.js 那次
// 也是同一个理由）。两个常量同名同值，改一处就得改另一处。
// 导出与导入两侧都要用到它们，而且必须成对——只改一处就会留下「设置指向一张不存在的图」
// （theme-store 的 applyPhoto 会按「没有背景」兜住并顺手清掉设置）或「图在库里、没人引用」
// （界面看不出来，但下一次导出会把它带走）。文件头第 7 条讲的就是这件事。
const BACKGROUND_KEY = 'backgroundImage';
const BACKGROUND_ASSET_ID = 'bg';

// 错误带上 code，UI 才区分得开「密码错」与「文件坏了」——两者的处置方式完全不同：
// 前者让用户重输密码，后者只能换个文件。只用 message 做判断太脆。
export class BackupFileError extends Error {
  constructor(message, code = 'BAD_FILE') {
    super(message);
    this.name = 'BackupFileError';
    this.code = code;
  }
}

// 本地时区的 YYYY-MM-DD。刻意不用 toISOString()：那会转成 UTC，
// 东八区晚上 8 点之后导出的文件会带上「昨天」的日期，用户一看就以为文件旧了。
function todayStamp(now) {
  const d = new Date(now);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 纯同步的小工具：只读字段、不碰 IndexedDB 也不做派生。绝不要给它加 async——
// 一处 async 会让 parseBackupFile 的校验和 decryptBackupFile 的解构同时拿到 Promise，
// 解构出 undefined 之后 fromBase64(undefined) 才会抛出那个看不出所以然的 atob 错误。
function readKdfSalt(parsed) {
  const kdf = parsed.kdf ?? {};
  const salt = kdf.salt;
  if (typeof salt !== 'string' || !salt) {
    throw new BackupFileError('备份文件缺少解密所需的盐（kdf.salt）', 'BAD_FILE');
  }
  const iterations = kdf.iterations ?? DEFAULT_ITERATIONS;
  if (!Number.isInteger(iterations) || iterations <= 0) {
    throw new BackupFileError('备份文件的迭代次数不合法', 'BAD_FILE');
  }
  return { salt, iterations };
}

// 只认真正的数组。备份包里的这两个新字段不在 REQUIRED_ARRAYS 里，validateBackup 不会替我们把关，
// 所以取值时必须自己判：`data.invoices ?? []` 只挡 null / undefined，
// 传进来一个对象（损坏的文件、被手改过的 JSON）就会变成 `for (const x of {})` 的 TypeError，
// 用户看到的是「导入失败」而不是原因。
function arrayOrEmpty(value) {
  return Array.isArray(value) ? value : [];
}

// Blob → base64 字符串。
// 为什么必须转：JSON 里没有 Blob 这种东西，JSON.stringify(blob) 得到的是 `{}`——
// 图片会以「空壳记录」的形式进备份，恢复后那些发票一条图都看不到，而整个过程不报任何错。
// 代价是体积：base64 比二进制大约 1/3，一份几百张图的备份因此能到几十上百 MB（界面上要提前说清楚）。
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const s = String(fr.result);
      // data URL 形如 data:image/jpeg;base64,xxxx，逗号后面才是数据；没有逗号说明结果异常，
      // 返回空串交给调用方按「没有图」处理——宁可丢这一张，也不能往备份里写一段半截数据。
      const i = s.indexOf(',');
      resolve(i >= 0 ? s.slice(i + 1) : '');
    };
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

// base64 字符串 → Blob。解不开时返回 null 而不是抛错：
// 备份文件里某一张图的数据坏了（字符串被截断、字段是 null、base64 不合法），
// 该丢的是这一张图，不是用户整份备份——恢复是数据已经丢了之后唯一的补救手段。
//
// 为什么长度必须是 4 的倍数：base64 是「3 字节 → 4 字符」的定长编码，整串长度只可能是 4 的倍数。
// 而 atob 对**长度不是 4 倍数**的截断串**不抛错**——'AAA' 会安安静静地解出 2 个字节。
// 那比抛错更糟：库里会多出一条 size 不是 0、却只能显示半张图的记录，界面上是一张裂图，
// 而且它占着 quota、跟着进下一次备份（那个 3/4 反推出来的 size 还是错的）。
// 所以宁可在这里判成「解不开」返回 null，交给上面的「两个都解不出来就跳过」处理。
//
// 纯空白串也必须挡住：typeof 是 'string'、'   ' 又非空，能大摇大摆过掉类型检查，
// 而 atob('   ') 返回空串 → 得到一个 size 为 0 的空 Blob。更糟的是它非 null，
// 于是绕过调用方「原图和缩略图都解不出来才跳过」的判断，让一条空记录白白进库。
function base64ToBlob(b64, mime) {
  if (typeof b64 !== 'string') return null;
  const trimmed = b64.trim();
  if (trimmed === '' || trimmed.length % 4 !== 0) return null;
  try {
    const bin = atob(trimmed);
    // 长度合法但内容为空（理论上走不到，走到就是上游给了我们一段没用的东西）：
    // 同样返回 null，不能让一个 0 字节的 Blob 冒充「这张图恢复出来了」。
    if (bin.length === 0) return null;
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime || 'application/octet-stream' });
  } catch (err) {
    console.warn('备份里的图片数据解不开，跳过这一张', err);
    return null;
  }
}

// 把 invoiceFiles 整张表转成可进 JSON 的形态。
// 返回 { files, skipped }：skipped 是没能进备份的记录数，界面要把它说出来——
// 备份少了一张图却显示成功，等用户换手机那天才发现，那就太晚了。
// 任何一张图读失败都只跳过它自己：导出是保住账目唯一的手段，
// 绝不能因为一条脏记录（blob 为空、图片损坏）把整次导出打回去。
async function encodeFiles() {
  const files = await db.getAll('invoiceFiles');
  const out = [];
  let skipped = 0;
  for (const f of files) {
    // id 是 keyPath，没有 id 的记录本来也取不出来，写进备份再恢复只会是一条谁也认不出的空记录。
    if (typeof f?.id !== 'string' || !f.id) { skipped += 1; continue; }
    let blob = null;
    let thumbBlob = null;
    try {
      blob = f.blob ? await blobToBase64(f.blob) : null;
      thumbBlob = f.thumbBlob ? await blobToBase64(f.thumbBlob) : null;
    } catch (err) {
      console.warn('发票图片读取失败，这一张不进备份', f.id, err);
      skipped += 1;
      continue;
    }
    // 原图和缩略图都没有：这是一条脏记录，留在备份里只是个空壳，恢复回去还是看不到图。
    if (!blob && !thumbBlob) { skipped += 1; continue; }
    out.push({
      id: f.id,
      mime: f.mime ?? '',
      // 原始文件名也必须在这个清单里。invoiceFiles 从来不整表导出（blob 进不了 JSON，
      // 只能 base64 单走这条路），所以字段是**手写**的，新字段不会自动跟着走；漏掉的后果是
      // 换机恢复之后 name 变成 undefined——预览退回占位、导出退回兜底名，而且不报错、不留痕。
      name: String(f.name ?? '').trim(),
      // 正常的记录都有 size（saveFile 写的）。缺失时按 base64 长度反推原始字节数（3/4 是
      // base64 的膨胀系数）：留 0 会让恢复后的这份数据在下次导出时被严重低估——
      // 那时界面就不会提醒「文件很大、下载可能被拦掉」，用户以为备份好了。
      size: Number(f.size) > 0 ? f.size : (blob ? Math.floor(blob.length * 3 / 4) : 0),
      createdAt: f.createdAt ?? null,
      blob,
      thumbBlob
    });
  }
  return { files: out, skipped };
}

// 遮罩强度：先回答「有没有这个值」，有才把它交给 theme.js 的 normalizeOverlay 去夹紧取整。
//
// **两件事必须分开做，判据必须与 normalizeOverlay 同源**：
// · 「有没有」不能靠 normalizeOverlay——它对坏值一律回默认 30，表达不了「没有」；
// · 「归一化成什么」也不能在这里另写一遍——normalizeOverlay 会 Math.round 并夹到
//   OVERLAY_MIN..OVERLAY_MAX（0..60），而 0 是**合法**值（「完全不加遮罩」，滑块能拖到那一格）。
//   自己写一个只判范围的版本，会让 -5 / 9999 / 30.7 这种值原样进备份包，再被导入侧写回设置：
//   同一个数字在「设置 → 备份包 → 设置」这条路上走一圈就变了样。
// **为什么不能图省事写 `Number(x) >= 0 ? Number(x) : null`**：Number(null) / Number('') /
// Number(false) 都是 0，那句写法会把「设置里根本没有这一项」写成「用户选了 0% 遮罩」——
// 一个从没发生过的值。备份包是换机时唯一的数据面，写进去的假值会一直被当真
// （theme.js 的 normalizeOverlay 早已为同一件事写过一段注释，这里是同一个坑的第二次出现）。
function overlayOrNull(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? normalizeOverlay(value) : null;
  if (typeof value === 'string' && value.trim() !== '') {
    return Number.isFinite(Number(value)) ? normalizeOverlay(value) : null;
  }
  return null;
}

/**
 * 把背景照片编码进备份包（data.background）。
 * 返回值是 `{ background, skipped }`——**两个都为 null / true 时含义完全不同**，调用方要分开说：
 *   · `{ background: null, skipped: false }`：库里压根没有背景（没设过，或用户已经「移除」过）。
 *     这是正常结果，不是降级，什么都不用提示。
 *   · `{ background: null, skipped: true }`：库里有那张图，但这次没能读出来／编进包。
 *     **这是降级**，必须让用户知道（见 exportBackup 的 backgroundSkipped）。
 *
 * 任何失败都返回 null 而不是抛错：一张背景图不该把整次导出打回去——导出是用户保住账目的唯一手段，
 * 而账目比背景重要得多（与 encodeFiles 里「跳过脏记录」同一条纪律）。
 * **catch 里分不清「读失败时库里到底有没有那张图」**（读库那一步本身就失败了），那边一律按
 * `skipped: true` 报——宁可多提示一次，也不要让一次真的丢图混在「正常导出」里过去。
 *
 * settings 传进来是为了在背景包里一并记下遮罩强度（data.background.overlay）。导入侧会用它补写
 * settings 那一行（备份的 settings 里没有 backgroundImage 时，见 importBackup），这是它**目前唯一
 * 的消费方**；备份 settings 里正常有那一行时，遮罩随 settings 表整体覆盖走，与这个字段同源、
 * 不会打架。
 */
async function encodeBackground(settings) {
  try {
    const row = await db.get('assets', BACKGROUND_ASSET_ID);
    const blob = row?.blob ?? null;
    // 没有图 = 没有背景，不是降级。
    if (!blob) return { background: null, skipped: false };
    const image = await blobToBase64(blob);
    // 这个不一样：图在库里、只是这一次没能读出来——**是**降级。
    if (!image) return { background: null, skipped: true };
    const meta = settings.find(r => r?.key === BACKGROUND_KEY)?.value ?? null;
    return {
      background: {
        overlay: overlayOrNull(meta?.overlay),
        // 只认有值的数字：0 是 1970-01-01，一个像真实时间的哨兵值，宁可写成 null 也不让它混进去
        // （theme.js 的 normalizeBackground 给 createdAt 判过同一件事，那边连字符串都不认）。
        createdAt: Number(row.createdAt) || null,
        mime: row.mime || 'image/jpeg',
        image
      },
      skipped: false
    };
  } catch (err) {
    console.warn('背景照片读不出来，这次备份不带它', err);
    return { background: null, skipped: true };
  }
}

// 含图导出之前的体量闸门：只看 invoiceFiles 的 size 元数据，不做任何编码。
// 必须在任何编码动作之前调用（见 exportBackup 里的位置）。
//
// 两个为什么：
// · 为什么必须在这之前：一旦开始 encodeFiles，Blob 已经被读成 base64 串、整包也进了 JSON，
//   那时再发现太大就已经晚了——峰值内存已经吃到嘴里，恰恰是我们要躲开的那一下。
// · 为什么算 size 而不是真的去量一遍：与 estimateExportSize 用同一把尺子（那里也是把所有
//   record.size 加总后交给 estimateBackupMB）。两处口径必须一致——同一个 40MB 的库，
//   面板说能导、导出时又说导不了，用户只会以为 app 坏了。
//   size 缺失（老记录或脏数据）时按 0 计，与那边的实现一模一样。
function inlineFilesBytes(files) {
  let bytes = 0;
  for (const f of files) {
    const size = Number(f?.size) > 0 ? Number(f.size) : 0;
    bytes += size;
  }
  return bytes;
}

// 超限时抛的中文错误。文案要说清两件事：多大、接下来怎么办——用户此刻只想要一份备份，
// 只甩一句「图片太多」等于让他自己猜。
// 数字用 estimateBackupMB：与面板上那行体积提示是同一个函数换算的，用户拿它去和界面上那个
// 数字对得上；否则面板说「约 60 MB」、错误里说「约 45 MB」（原图字节），他只会以为这是两回事。
function tooManyFilesError(bytes) {
  const mb = estimateBackupMB([{ size: bytes }]);
  return new Error(`图片太多，一次导不完（约 ${mb} MB）。可以勾选「不含图片」导出，或者先删掉一些旧图再试。`);
}

// 导出前的体积预估：读 invoiceFiles 的元数据（size 字段）就够了，不必真的读图片字节。
// 界面用它告诉用户「这份备份大概多大」，并在体积大到下载会被拦掉时给出「不含图片」这条路。
//
// 已知代价：db.getAll 会把每条记录的 blob / thumbBlob 一并读进内存，而面板一打开就调它一次。
// 本可以换成 openCursor 只取 size、把这几百 MB 的字节留在库里，但做不到，也不值得：
// · db.js 没有游标封装，而 backup-store 只认 db.js 这一层（直接摸 indexedDB 全局就等于
//   绕开它自己那句「薄封装、只做读写」的分层）；
// · 为它加一张只存元数据的索引表，代价是 schema 迁移 + 每次 saveFile/deleteFile 都要同步维护，
//   一旦漏同步，面板报的体积就是错的——用一个数据一致性的风险换一次面板打开的耗时。
// 真到这一步再改，届时应该连同 db.js 一起加 cursor 接口。
export async function estimateExportSize() {
  const files = await db.getAll('invoiceFiles');
  return { count: files.length, mb: estimateBackupMB(files) };
}

// 导出：读出全部数据 → 组装备份包 → 整包加密 → 交给调用方下载。
// includeFiles 默认为 true：图片是**这台设备上唯一的一份**，换手机、清数据都只剩备份里这一条路，
// 所以默认必须带上；「不含图片」是用户明确选了才走的退路（体积小很多，代价是恢复后只看得到条目）。
export async function exportBackup(password, now = Date.now(), { includeFiles = true } = {}) {
  const rows = await Promise.all(ARRAY_STORES.map(name => db.getAll(name)));
  const arrays = Object.fromEntries(ARRAY_STORES.map((name, i) => [name, rows[i]]));

  // vault 从 settings 里取出来单独放进备份包的 data.vault：
  // 混在 settings 数组里会让同一个密码箱在文件里出现两份，导入时两处内容还可能不一致。
  // 只读这一个键，其余设置原样带走。
  const vault = (await db.get('settings', VAULT_KEY))?.value ?? null;
  const settings = (await db.getAll('settings')).filter(row => row?.key !== VAULT_KEY);

  // 体量闸门：必须在 encodeFiles（真正开始读图、转 base64）之前。
  // includeFiles 为 false 时一次都不查：「不含图片」这条路的体积与图片数量无关，没道理把它挡住，
  // 更不该因为库里图片太多就让用户连一份保住账目的备份都导不出来（那正是最需要它的时候）。
  // 这里读的是记录上的 size 字段（db.getAll 会把 blob 一起读进来，代价见 estimateExportSize 的注释），
  // 但它不产生 base64 —— 真正的内存峰值在编码那一步，闸门要拦的就是那一步。
  if (includeFiles) {
    const usedBytes = inlineFilesBytes(await db.getAll('invoiceFiles'));
    if (usedBytes > MAX_INLINE_FILES_BYTES) throw tooManyFilesError(usedBytes);
  }

  // 图片单独转 base64（Blob 进不了 JSON，见 encodeFiles）。不含图片时直接给空数组：
  // 连读都不读，省掉把几十 MB 的 Blob 取出来转一遍的时间。
  const { files: invoiceFiles, skipped } = includeFiles ? await encodeFiles() : { files: [], skipped: 0 };

  // 背景照片单独打包成 data.background。它与「不含图片」开关**无关**：
  // 它是外观设置的一部分，压缩后的照片只有一两百 KB，而「换机后背景丢了、找不回来」是没法补救的
  // （用户自己选的那张照片可能早就删了、设备上只剩这一份，与图片那条路同源）。
  // 上面那道几十 MB 的体量闸门（MAX_INLINE_FILES_BYTES）只盯着 invoiceFiles，不会把这一张挡在外面：
  // 它是 KB 量级，而拦下它的代价是用户换机后背景再也找不回来，收益接近零。
  // skipped 与 backgroundSkipped 是两件事，界面必须分开说（前者是张数、后者只有一张）。
  const { background, skipped: backgroundSkipped } = await encodeBackground(settings);

  const pkg = buildBackup({ ...arrays, settings, vault, invoiceFiles, background }, now);

  // 每次导出都现取盐：同一个密码两次导出得到的密钥不同，一个文件被解开不会连累其他文件。
  const salt = randomBytes(SALT_BYTES);
  const key = await deriveKey(String(password), salt, DEFAULT_ITERATIONS);
  const { iv, ct } = await encryptJSON(key, pkg);

  const file = {
    format: ENCRYPTED_FORMAT,
    version: ENCRYPTED_VERSION,
    createdAt: now,
    kdf: { name: 'PBKDF2-SHA256', iterations: DEFAULT_ITERATIONS, salt: toBase64(salt) },
    iv,
    ct
  };
  // skipped 与 backgroundSkipped 一并交给界面：有东西没能进备份时必须说出来（见 encodeFiles 的注释
  // 与下面这条）。**背景必须有自己的通道**，不能并进 skipped——那个数是「张数」，界面按张数写文案；
  // 而背景只有一张，且它的后果是「用户以为照片安全了，换机时才发现没带过去」，与发票图片同一个坑。
  return {
    filename: `pvault-backup-${todayStamp(now)}${FILE_EXT}`,
    text: JSON.stringify(file),
    skipped,
    backgroundSkipped
  };
}

// 只做外层信封的校验，不解密——导入界面要先用它拦掉「选错文件」，
// 那时用户还没输密码，也就无从解密。
export function parseBackupFile(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BackupFileError('这个文件不是 pvault 的备份文件（内容不是合法的 JSON）', 'BAD_FILE');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BackupFileError('这个文件不是 pvault 的备份文件（内容不是一个对象）', 'BAD_FILE');
  }
  if (parsed.format !== ENCRYPTED_FORMAT) {
    // 未加密的备份包（format 为 pvault-backup）也给一句更贴切的提示：
    // 用户最可能犯的错就是直接把内部备份包当文件存了下来。
    if (parsed.format === BACKUP_FORMAT) {
      throw new BackupFileError('这是未加密的 pvault 备份包，不是可导入的备份文件', 'BAD_FILE');
    }
    throw new BackupFileError('这个文件不是 pvault 的备份文件（缺少格式标识）', 'BAD_FILE');
  }
  if (!Number.isInteger(parsed.version)) {
    throw new BackupFileError('备份文件缺少版本号', 'BAD_FILE');
  }
  if (parsed.version > ENCRYPTED_VERSION) {
    throw new BackupFileError(
      `备份文件版本（${parsed.version}）高于当前 app 支持的版本（${ENCRYPTED_VERSION}），请先更新 app`,
      'BAD_FILE'
    );
  }
  if (!parsed.kdf || typeof parsed.kdf !== 'object') {
    throw new BackupFileError('备份文件缺少解密参数（kdf）', 'BAD_FILE');
  }
  readKdfSalt(parsed);
  if (typeof parsed.iv !== 'string' || !parsed.iv) {
    throw new BackupFileError('备份文件缺少解密所需的数据（iv）', 'BAD_FILE');
  }
  if (typeof parsed.ct !== 'string' || !parsed.ct) {
    throw new BackupFileError('备份文件缺少加密内容（ct）', 'BAD_FILE');
  }
  return parsed;
}

// 解密 + 校验，任何写操作都在它之后才发生。返回 { summary, data }，
// 让界面先展示摘要给用户确认，再决定要不要真的覆盖。
export async function decryptBackupFile(parsed, password) {
  const { salt, iterations } = readKdfSalt(parsed);
  const key = await deriveKey(String(password), fromBase64(salt), iterations);

  let pkg;
  try {
    pkg = await decryptJSON(key, { iv: parsed.iv, ct: parsed.ct });
  } catch {
    // AES-GCM 把「密码不对」与「密文被改过」归成同一个解密失败，这里也只能给出合并的提示。
    // 想区分就得在信封里加一个明文的校验字段，那等于白送一个离线爆破的验证器——不做。
    throw new BackupFileError('备份密码不正确，或备份文件已损坏', 'BAD_PASSWORD_OR_CORRUPT');
  }

  const check = validateBackup(pkg);
  if (!check.ok) {
    throw new BackupFileError(`备份文件内容不完整：${check.errors.join('；')}`, 'BAD_CONTENT');
  }
  return { summary: summarizeBackup(pkg), data: pkg.data };
}

// 导入：解密校验全部通过后，用一个事务覆盖备份里**确实带了**的仓库 + 整个 settings 表。
export async function importBackup(text, password) {
  const parsed = parseBackupFile(text);
  const { summary, data } = await decryptBackupFile(parsed, password);

  // 这次导入只取一次时间，写在库里的东西共用它：下面给 assets 那条背景记录、以及按需补出来的
  // backgroundImage 设置行兜底时都读这个 now。两处各自再调一次 Date.now() 会留下一个 1ms 的竞态
  // ——两次调用之间跨过毫秒边界（机器一忙就会发生）就差 1，而这两条记录在语义上是**同一次导入
  // 操作**的产物，时间戳本就该一致。正常写入那条路也是这个取法：theme-store 的 setPhoto 一次
  // 取好 createdAt，assets 记录与设置行共用它，只有导入这一处此前各取了一次。
  // 取在这里（写库之前）而不是紧跟某一处，是为了让它代表「这次导入」本身，与落到哪一行无关。
  const now = Date.now();

  // 这台设备自己的两行本地状态，都在同一个事务里写回去：
  //   lastBackupAt —— 「上一次把这台设备的数据安全导出是什么时候」。
  //     沿用备份文件里的旧日期，会让刚导入完的人看到「30 天前备份过」甚至「从未备份」这种假信息，
  //     所以取「本设备当前值 ?? 导入时刻」。
  //   vault —— 下面单独处理：文件里没有密码箱时，这一行必须原样留在原地。
  const [lastBackupRow, vaultRow] = await Promise.all([
    db.get('settings', LAST_BACKUP_KEY),
    db.get('settings', VAULT_KEY)
  ]);

  const puts = [];
  for (const name of ARRAY_STORES) {
    // arrayOrEmpty 是防老备份的兜底：老备份里没有 invoices 键（加发票之前导出的），
    // 取出来是 undefined，理由见上面 ARRAY_STORES 的注释。
    for (const value of arrayOrEmpty(data[name])) puts.push({ store: name, value });
  }

  // 发票图片：它在 ARRAY_STORES 之外（Blob 进不了 JSON，见那里的注释），只能单独反解。
  // 这条独立路径**必须自己判空/判类型**：老备份里根本没有 invoiceFiles 键，
  // `for (const f of data.invoiceFiles)` 会直接抛 TypeError——ARRAY_STORES 那个循环有兜底，
  // 这一条没有，漏了它「恢复老备份」就会在写库前一刻炸掉。
  for (const f of arrayOrEmpty(data.invoiceFiles)) {
    // id 是 keyPath，不是字符串时 put() 会**同步**抛 DataError；那种异常不会自动中止事务
    // （见 db.js 的 enqueue），留着就是「清了一半的库」。所以入队之前先筛掉，
    // 与下面 settings 那句是同一个理由——区别是这里跳过而不是抛错：一条连 id 都没有的图片记录
    // 救不回来，不该拿它换掉用户整份备份的恢复。
    if (typeof f?.id !== 'string' || !f.id) continue;
    const blob = base64ToBlob(f.blob, f.mime);
    const thumbBlob = base64ToBlob(f.thumbBlob, f.mime);
    // 原图与缩略图都解不出来：写进去也只是一条空记录（界面照样显示占位方块），不占地方也不添乱。
    if (!blob && !thumbBlob) continue;
    puts.push({
      store: 'invoiceFiles',
      value: {
        id: f.id,
        blob,
        thumbBlob,
        mime: f.mime ?? '',
        // 老备份里没有这个键，读出来是 undefined——`String(undefined ?? '')` 就是空串，
        // 而消费方对空串本来就有兜底（导出时用发票号码现算兜底名），所以这里不判必填。
        name: String(f.name ?? '').trim(),
        size: Number(f.size) > 0 ? f.size : (blob?.size ?? 0),
        createdAt: f.createdAt ?? null
      }
    });
  }

  // 背景照片：与 invoiceFiles 同一条路（Blob 进不了 JSON，只能单独反解），但处置**正好相反**，
  // 而且两处必须成对，见文件头第 7 条。这里只做前半段（写），后半段（清）在下面 clears/deletes
  // 那一段——那里才拿得到那个数组。两段合起来是一条规则：
  //   备份里**带**了可恢复的背景 → assets 里那条 'bg' 写回去（id 固定，put 即覆盖），
  //      **并且保证 settings 里有一行指向它**（备份自己的 settings 里没有就现造一行，见下）；
  //   备份里**没有**（老备份根本没有这个键、那次导出时读图失败、或这段 base64 解不开）
  //     → 本机那条一并**按主键删掉**，并且不让设置里留下指向它的 backgroundImage 行。
  // 为什么「没有」时要清、而 invoiceFiles 却保留：settings 是整表覆盖的，本机那条 backgroundImage
  // 必然被这次导入清掉——本机那张图**已经失去引用**，画面上也不再显示它。此时把字节留在库里不等于
  // 「保住用户的东西」，只会让它在下一次导出里复活（encodeBackground 只认 assets 那条记录、
  // 不看设置里有没有引用）并跟着备份跑到第三台设备上去。真要在这种情况下保住本机背景，得把设置行
  // 也一起保留（像 vault 那样两处都不动），那是另一个决定：规格 §13 里那条「恢复的是一台机器上的图
  // （不是当前这台残留的）」的验收项与它冲突——「留图 + 备份的设置行」恰恰会做出「图上来了、
  // 但不是备份里那张」的混合状态，比干脆没有更难解释。
  const bg = data.background;
  // 判据只看「能不能解出一张图」：形状不对（字符串、数组、null、老备份的 undefined）与 base64 坏了
  // 走同一条路——都没有可恢复的背景。base64ToBlob 自己会挡住空串/非 4 倍数/解不开的串。
  const bgBlob = (bg && typeof bg === 'object') ? base64ToBlob(bg.image, bg.mime) : null;
  // 备份的 settings 里有没有那一行——下面补行与跳过行两处都要用，所以在这里先问一次。
  const bgSettingInBackup = data.settings.some(row => row?.key === BACKGROUND_KEY);
  if (bgBlob) {
    puts.push({
      store: 'assets',
      value: {
        id: BACKGROUND_ASSET_ID,
        blob: bgBlob,
        mime: bg.mime || 'image/jpeg',
        size: Number(bgBlob.size) || 0,
        // 与 theme-store 的 setPhoto 同一个字段含义（这条记录是什么时候写下的）。
        // 备份里没有这个时间（老格式、或那段导出失败）就用导入时刻——用上面那个共用的 now，
        // 这样它与下面补出来的设置行不会差出 1ms（各取一次时的原样，见函数开头）。
        createdAt: Number(bg.createdAt) || now
      }
    });
    // 备份带了图，但它的 settings 里**没有** backgroundImage 那一行——源机器上就是「图在库里、
    // 没人引用」的状态（`setPhoto` 写 assets 成功、写设置那一步失败就会留下它；而 `encodeBackground`
    // 只认 assets 那条记录，会把这种状态原样导出来，于是它会**自我复制**下去）。
    // 不补这一行的话，导入端复制出来的还是「图写进去了、没有引用」：背景不显示，而且下一次导出
    // 又把它带给第三台设备。所以这里用背景包里的 overlay / createdAt 现造一行补上——
    // **这正是 data.background.overlay 存在的意义**：在此之前它没有任何消费方，
    // 那份「照片自己的记录」是空转的，而补这一行正好需要它（也正因如此，那个值必须先夹紧取整，
    // 见 overlayOrNull：它现在会直接进 settings）。
    if (!bgSettingInBackup) {
      puts.push({
        store: 'settings',
        value: {
          key: BACKGROUND_KEY,
          value: {
            assetId: BACKGROUND_ASSET_ID,
            // normalizeOverlay 兜住 null / 脏值（回 OVERLAY_DEFAULT）并夹紧取整——与 theme-store
            // 的应用侧用的是同一个函数，所以补出来的这一行和用户自己在面板上设过的行长得一样。
            overlay: normalizeOverlay(bg.overlay),
            // 与 assets 那条记录共用同一个 now：这两条是这个函数一次写下去的（同一次导入），
            // 时间戳本该一样；各取一次 Date.now() 会跨毫秒边界差 1，读这对记录的人就会以为
            // 「图是更早那一刻的、引用是后一刻的」。
            createdAt: Number(bg.createdAt) || now
          }
        }
      });
    }
  }

  // settings 是 { key, value } 形状、以 keyPath 为主键，所以 key 不是字符串时 put() 会**同步**
  // 抛 DataError。这种异常不会自动中止事务（见 db.replaceAllRecords），因此必须在入队之前就拦下来：
  // 文件里有一行坏设置，不该换来一个清了一半的库。
  for (const row of data.settings) {
    if (typeof row?.key !== 'string' || !row.key) {
      throw new BackupFileError('备份文件里的设置项格式异常（缺少 key）', 'BAD_CONTENT');
    }
  }
  for (const row of data.settings) {
    if (row.key === VAULT_KEY) continue; // 密码箱只认 data.vault，避免文件里两份互相打架
    // 备份里没有可恢复的背景时不写回这一行：写了就是一条指向不存在记录的**悬空设置**
    // （theme-store 的 applyPhoto 会按「没有背景」兜住它并顺手把设置清掉，但那要等到下一次启动，
    // 中间这段时间里库里的状态是自相矛盾的）。它与上面「按主键删掉 assets 那条记录」是同一件事的两半。
    if (!bgBlob && row.key === BACKGROUND_KEY) continue;
    puts.push({ store: 'settings', value: row });
  }
  puts.push({ store: 'settings', value: { key: LAST_BACKUP_KEY, value: lastBackupRow?.value ?? Date.now() } });

  // 密码箱：settings 表整体覆盖时 vault 这一行也会被清掉，所以必须显式写回去。
  // 备份里带密码箱就用备份里的（data.vault）；
  // 备份里没有密码箱（data.vault 为 null）时，把设备**原有的那一行原样写回**。
  // 保留它比「忠实还原一个没有密码箱的备份」重要得多——清掉之后，用户密码箱里的东西
  // 再也拿不回来了，而备份文件里并没有它的替补。
  const vaultToWrite = data.vault ?? vaultRow?.value ?? null;
  if (vaultToWrite) puts.push({ store: 'settings', value: { key: VAULT_KEY, value: vaultToWrite } });

  // 清空哪些仓库，与「这份备份到底带没带这张表」严格对齐，一个都不能多：
  //   · ARRAY_STORES 里的表：备份里真有这个数组才清；
  //   · invoiceFiles：它不在 ARRAY_STORES 里，所以必须**显式**写在这个清单里（不能靠派生），
  //     但它同样只在备份里真的带了图片时才清——清空的目的就是「覆盖恢复之后不留下上一份数据的
  //     图片残留」，备份里没有图片时就没有可覆盖的东西，此时清空只会删掉本机唯一一份原图，
  //     而备份文件里并没有它们的替补。这与文件头第 4 条「备份里没有密码箱就保留现有密码箱」
  //     是同一条纪律：**没有替补的东西，一律不删**。
  // 无条件清 clears 的代价（也就是「问 a」的答案）：老备份根本没有 invoices 键，
  // 而它很可能被导入到一台**已经有发票和图片**的设备上（用户在用的就是这个新版本）。
  // 那时无条件清会把本机发票和图片一起抹掉，而备份文件里没有它们的替补——
  // 「恢复备份」这条唯一的救命通道就变成了毁数据的开关。
  // 反过来，备份里带了图（正常含图导出）时**必须**清：不清就会留下上一份数据的图片残留。
  // 背景那一条走的是 deletes，**不是 clears**（成对处理的另一半，写在那一段在发票图片循环的后面）：
  //   · 只有备份里**没有**可恢复的背景时才删，与上面那条对图片的处置正好相反——因为「没有背景」时
  //     本机那条记录的引用已经被 settings 的整体覆盖拿走了（settings 整表覆盖，备份里没有
  //     backgroundImage 行），留着它只是不合规的残留；而图片那边本机的原图仍然挂在发票上、
  //     仍然看得到，删了才是真丢。
  //   · **为什么必须是 deletes 而不是 clears**：assets 是通用资源表，这一层要删的只有 'bg' 一条。
  //     clear('assets') 会把整张表端掉——那正是这条注释上一段说的「多余的删除」，也正是在
  //     「清单不该靠『现在只有一条』活着」那句里承诺过不做的事（说一套做一套是最容易被下一轮
  //     评审抓住的形态）。备份真的带了背景时更不需要清：那个 id 固定是 'bg'，上面那条 put 已经
  //     把同一条记录覆盖掉了。
  const clears = ARRAY_STORES.filter(name => Array.isArray(data[name]));
  if (arrayOrEmpty(data.invoiceFiles).length > 0) clears.push('invoiceFiles');
  clears.push('settings');

  const deletes = [];
  if (!bgBlob) deletes.push({ store: 'assets', key: BACKGROUND_ASSET_ID });

  // 清空、删除与写入必须在同一个事务里，否则中途失败会留下一个空库（或半截状态）。
  await db.replaceAllRecords({ clears, puts, deletes });

  // 覆盖进来的密码箱多半属于**另一个**密码箱（另一把 DEK），而内存里的会话还是老的。
  // 不在这里上锁的话，此后任何一次 saveItems 都会用老 DEK 加密后写进新记录——
  // 新密码箱的条目就永久打不开了（老 DEK 再也拿不回来，因为包裹它的 KEK 也已作废）。
  // 当前 UI 在导入后会立刻 location.reload()，所以这条路径暂时走不到；但它是一颗结构里的雷：
  // 只要哪天有人在 reload 之前动一下密码箱就会踩响。备份里没有密码箱时不必锁——
  // 那种情况下磁盘上留下的还是原来那份记录，与会话里的 DEK 仍然配套。
  if (data.vault) vaultStore.lock();

  return summary;
}

export async function getLastBackupAt() {
  return (await db.get('settings', LAST_BACKUP_KEY))?.value ?? null;
}

export async function markBackedUp(ts = Date.now()) {
  await db.put('settings', { key: LAST_BACKUP_KEY, value: ts });
  return ts;
}
