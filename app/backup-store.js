// 备份仓库层：把一个设备的全部数据打包成一个加密文件，以及从该文件恢复回来。
//
// 文件分两层：外层是「加密信封」，内层是 app/backup.js 定义的备份包（含记账数据与密码箱记录）。
// 外层长这样：
//
//   { format: 'pvault-backup-encrypted', version: 1, createdAt,
//     kdf: { name: 'PBKDF2-SHA256', iterations, salt }, iv, ct }
//
// 五条不能破的约定：
// 1. 每次导出都用**新生成的随机 salt**。复用 salt 会让同一个备份密码在任何时间导出的文件
//    用同一把密钥，那就等于把「一次泄露 = 全部历史文件可解」写死进格式里。
// 2. 导出的加密与导入的解密都以文件里 kdf.salt / kdf.iterations 为准：迭代次数会随版本涨，
//    老备份必须按它当初写下的轮数解开。
// 3. 导入必须先「解密 + 校验」全部通过，才允许碰现有数据；覆盖动作收在 db.replaceAll 的
//    一个事务里——中途失败绝不能留下「旧数据已清、新数据没写进去」的空库。
// 4. 备份里没有密码箱时，**保留**目标设备现有的密码箱。删掉它等于顺手毁掉用户设备上
//    唯一一份密码箱密文，而备份文件里根本没有它的替补。
// 5. 备份里带密码箱时，覆盖完成后立刻上锁：新记录的 DEK 与内存里的会话多半不配套，
//    带着老会话继续写会把新密码箱的条目加密成一把再也解不开的钥匙（见 importBackup）。
//
// 本模块依赖 db.js（IndexedDB）与 crypto.js（WebCrypto 全局），因此不能在 Node 里 import，
// 也不写单测；验证方式见 docs/手动验证清单.md 的「备份与恢复」小节与临时探针。

import * as db from './db.js';
import * as vaultStore from './vault-store.js';
import {
  DEFAULT_ITERATIONS, deriveKey, encryptJSON, decryptJSON, randomBytes, toBase64, fromBase64
} from './crypto.js';
import { BACKUP_FORMAT, buildBackup, validateBackup, summarizeBackup } from './backup.js';
// 体积估算在 image-scale.js 里（纯函数、可单测）。刻意直接 import 它而不是走 image-store.js：
// image-store 只是把它转发出来，而那条路径会连带牵进 Canvas 相关的一整串模块。
import { estimateBackupMB } from './image-scale.js';

export const ENCRYPTED_FORMAT = 'pvault-backup-encrypted';
export const ENCRYPTED_VERSION = 1;

// 文件名后缀固定 .pvault：用户一眼能认出「这是本 app 的备份文件」，也不会被系统当成可执行文件。
const FILE_EXT = '.pvault';
const SALT_BYTES = 16;

const VAULT_KEY = 'vault';
const LAST_BACKUP_KEY = 'lastBackupAt';

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
// **invoiceFiles 不在这里**：它的 blob / thumbBlob 是 Blob，JSON.stringify(blob) 得到 `{}`，
// 直接进下面那个循环只会往备份里塞一堆空壳，恢复出来就是「有记录、没图片」。
// 它由 encodeFiles() 单独转成 base64 再打包，导入时由 base64ToBlob() 单独反解。
const ARRAY_STORES = ['txns', 'accounts', 'categories', 'receivables', 'invoices'];

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
function base64ToBlob(b64, mime) {
  if (typeof b64 !== 'string' || b64 === '') return null;
  try {
    const bin = atob(b64);
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

// 导出前的体积预估：读 invoiceFiles 的元数据（size 字段）就够了，不必真的读图片字节。
// 界面用它告诉用户「这份备份大概多大」，并在体积大到下载会被拦掉时给出「不含图片」这条路。
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

  // 图片单独转 base64（Blob 进不了 JSON，见 encodeFiles）。不含图片时直接给空数组：
  // 连读都不读，省掉把几十 MB 的 Blob 取出来转一遍的时间。
  const { files: invoiceFiles, skipped } = includeFiles ? await encodeFiles() : { files: [], skipped: 0 };

  const pkg = buildBackup({ ...arrays, settings, vault, invoiceFiles }, now);

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
  // skipped 一并交给界面：有图没能进备份时必须说出来（见 encodeFiles 的注释）。
  return { filename: `pvault-backup-${todayStamp(now)}${FILE_EXT}`, text: JSON.stringify(file), skipped };
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
        size: Number(f.size) > 0 ? f.size : (blob?.size ?? 0),
        createdAt: f.createdAt ?? null
      }
    });
  }

  // settings 是 { key, value } 形状、以 keyPath 为主键，所以 key 不是字符串时 put() 会**同步**
  // 抛 DataError。这种异常不会自动中止事务（见 db.replaceAll），因此必须在入队之前就拦下来：
  // 文件里有一行坏设置，不该换来一个清了一半的库。
  for (const row of data.settings) {
    if (typeof row?.key !== 'string' || !row.key) {
      throw new BackupFileError('备份文件里的设置项格式异常（缺少 key）', 'BAD_CONTENT');
    }
  }
  for (const row of data.settings) {
    if (row.key === VAULT_KEY) continue; // 密码箱只认 data.vault，避免文件里两份互相打架
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
  const clears = ARRAY_STORES.filter(name => Array.isArray(data[name]));
  if (arrayOrEmpty(data.invoiceFiles).length > 0) clears.push('invoiceFiles');
  clears.push('settings');

  // 清空与写入必须在同一个事务里，否则中途失败会留下一个空库。
  await db.replaceAll({ clears, puts });

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
