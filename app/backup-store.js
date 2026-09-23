// 备份仓库层：把一个设备的全部数据打包成一个加密文件，以及从该文件恢复回来。
//
// 文件分两层：外层是「加密信封」，内层是 app/backup.js 定义的备份包（含记账数据与密码箱记录）。
// 外层长这样：
//
//   { format: 'pvault-backup-encrypted', version: 1, createdAt,
//     kdf: { name: 'PBKDF2-SHA256', iterations, salt }, iv, ct }
//
// 四条不能破的约定：
// 1. 每次导出都用**新生成的随机 salt**。复用 salt 会让同一个备份密码在任何时间导出的文件
//    用同一把密钥，那就等于把「一次泄露 = 全部历史文件可解」写死进格式里。
// 2. 导出的加密与导入的解密都以文件里 kdf.salt / kdf.iterations 为准：迭代次数会随版本涨，
//    老备份必须按它当初写下的轮数解开。
// 3. 导入必须先「解密 + 校验」全部通过，才允许碰现有数据；覆盖动作收在 db.replaceAll 的
//    一个事务里——中途失败绝不能留下「旧数据已清、新数据没写进去」的空库。
// 4. 备份里没有密码箱时，**保留**目标设备现有的密码箱。删掉它等于顺手毁掉用户设备上
//    唯一一份密码箱密文，而备份文件里根本没有它的替补。
//
// 本模块依赖 db.js（IndexedDB）与 crypto.js（WebCrypto 全局），因此不能在 Node 里 import，
// 也不写单测；验证方式见 docs/手动验证清单.md 的「备份与恢复」小节与临时探针。

import * as db from './db.js';
import {
  DEFAULT_ITERATIONS, deriveKey, encryptJSON, decryptJSON, randomBytes, toBase64, fromBase64
} from './crypto.js';
import { STORES } from './schema.js';
import { BACKUP_FORMAT, buildBackup, validateBackup, summarizeBackup } from './backup.js';

export const ENCRYPTED_FORMAT = 'pvault-backup-encrypted';
export const ENCRYPTED_VERSION = 1;

// 文件名后缀固定 .pvault：用户一眼能认出「这是本 app 的备份文件」，也不会被系统当成可执行文件。
const FILE_EXT = '.pvault';
const SALT_BYTES = 16;

const VAULT_KEY = 'vault';
const LAST_BACKUP_KEY = 'lastBackupAt';

// 除 settings 外的四个数组仓库；settings 是 { key, value } 形状，单独处理。
const ARRAY_STORES = Object.keys(STORES).filter(name => name !== 'settings');

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

// 导出：读出全部数据 → 组装备份包 → 整包加密 → 交给调用方下载。
export async function exportBackup(password, now = Date.now()) {
  const rows = await Promise.all(ARRAY_STORES.map(name => db.getAll(name)));
  const arrays = Object.fromEntries(ARRAY_STORES.map((name, i) => [name, rows[i]]));

  // vault 从 settings 里取出来单独放进备份包的 data.vault：
  // 混在 settings 数组里会让同一个密码箱在文件里出现两份，导入时两处内容还可能不一致。
  // 只读这一个键，其余设置原样带走。
  const vault = (await db.get('settings', VAULT_KEY))?.value ?? null;
  const settings = (await db.getAll('settings')).filter(row => row?.key !== VAULT_KEY);

  const pkg = buildBackup({ ...arrays, settings, vault }, now);

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
  return { filename: `pvault-backup-${todayStamp(now)}${FILE_EXT}`, text: JSON.stringify(file) };
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

// 导入：解密校验全部通过后，用一个事务覆盖四个仓库 + 整个 settings 表。
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
    for (const value of data[name]) puts.push({ store: name, value });
  }
  for (const row of data.settings) {
    if (row?.key === VAULT_KEY) continue; // 密码箱只认 data.vault，避免文件里两份互相打架
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

  // 清空与写入必须在同一个事务里，否则中途失败会留下一个空库。
  await db.replaceAll({ clears: [...ARRAY_STORES, 'settings'], puts });

  return summary;
}

export async function getLastBackupAt() {
  return (await db.get('settings', LAST_BACKUP_KEY))?.value ?? null;
}

export async function markBackedUp(ts = Date.now()) {
  await db.put('settings', { key: LAST_BACKUP_KEY, value: ts });
  return ts;
}
