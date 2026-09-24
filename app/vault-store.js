// 保险库仓库层：密码箱的整条密钥链路都收在这一个模块里，UI 只通过这里读写条目。
//
//   主密码 / 恢复码 --PBKDF2--> KEK --AES-GCM--> 包裹住的 DEK --AES-GCM--> 条目密文
//
// 三条不能破的约定：
// 1. DEK 只在内存——落盘的只有「被 KEK 包裹过的 DEK」，任何时候都不能把裸 DEK 写进存储。
// 2. 同一密钥下 IV 绝不重复——条目密文每次保存都用新的随机 IV（交给 crypto.js 的 encryptJSON）。
// 3. 恢复码与主密码是两条独立的门——改主密码绝不碰 saltRecovery / wrappedDekByRecovery，
//    改恢复码（regenerateRecoveryCode）也绝不碰 saltPassword / wrappedDekByPassword。
//    两条路都不重新加密条目：换的只是「包裹 DEK 的那把钥匙」。
//
// 本模块依赖 db.js（IndexedDB）与 crypto.js（WebCrypto 全局），因此不能在 Node 里 import，
// 也不写单测；验证方式见 docs/手动验证清单.md 的「密码箱（数据层）」小节与临时探针。

import * as db from './db.js';
import {
  DEFAULT_ITERATIONS, toBase64, fromBase64, randomBytes,
  deriveKey, generateDek, importDek, wrapDek, unwrapDek,
  encryptJSON, decryptJSON
} from './crypto.js';
import { generateRecoveryCode, normalizeRecoveryCode } from './recovery-code.js';

const VAULT_KEY = 'vault';
const VAULT_VERSION = 1;
const KDF_NAME = 'PBKDF2-SHA256';
const SALT_BYTES = 16;

// 空闲多久自动上锁，以及多久检查一次。检查频率取 30 秒：比 5 分钟小一个量级，
// 最坏情况下用户多等半分钟才被踢回锁屏，代价可以忽略。
const IDLE_LIMIT_MS = 5 * 60 * 1000;
const IDLE_CHECK_MS = 30 * 1000;

// 会话只活在内存里：key 用来加解密，raw 只在「改主密码要重新包裹同一个 DEK」时用得上
// （importDek 出来的 CryptoKey 是 extractable=false，故意导不回字节）。
let session = null;
let lastTouched = 0;
let idleTimer = null;
const listeners = new Set();

function notify(unlocked) {
  for (const fn of [...listeners]) {
    // 某个监听者（比如某个面板的渲染）抛错不能连累其他监听者，更不能连累上锁流程本身。
    try {
      fn(unlocked);
    } catch (e) {
      console.error('[vault] 锁定状态监听者抛错', e);
    }
  }
}

// 清会话是唯一的「上锁」动作，顺手把空闲计时归零、停掉检查定时器。
// 没有会话可清时不再重复通知（避免同一次锁屏被广播两遍）。
function clearSession() {
  const hadSession = session !== null;
  // 密钥字节就地清零，而不是只把引用置 null 交给 GC：内存里的 DEK 只要还在，
  // 一次核心转储、一次堆快照就可能把它带走。真正「上锁」应当是字节不再存在。
  // （CryptoKey 本身在 JS 里无法擦除，这部分只能靠丢弃引用。）
  // changeMasterPassword 只在会话存活时用 raw，importDek 已把字节复制进 CryptoKey，
  // 所以填零不会影响任何还活着的用法。
  if (session?.raw) session.raw.fill(0);
  session = null;
  lastTouched = 0;
  stopIdleWatcher();
  if (hadSession) notify(false);
}

function startIdleWatcher() {
  if (idleTimer !== null) return;
  idleTimer = setInterval(() => {
    // 「切走」不作为触发点：PWA 里没有可靠的捕获点（标签页可能被系统直接杀掉），
    // 所以只认「最后一次操作过了多久」，由这个定时器兜底。
    if (session && Date.now() - lastTouched > IDLE_LIMIT_MS) clearSession();
  }, IDLE_CHECK_MS);
  // Node（临时探针）里 setInterval 会拖着进程不退出；浏览器里它返回的是 number，没有 unref。
  idleTimer?.unref?.();
}

function stopIdleWatcher() {
  if (idleTimer === null) return;
  clearInterval(idleTimer);
  idleTimer = null;
}

async function readRecord() {
  const row = await db.get('settings', VAULT_KEY);
  return row?.value ?? null;
}

async function requireRecord() {
  const record = await readRecord();
  if (!record) throw new Error('密码箱还没有设置过');
  return record;
}

// 迭代次数以存储里记的为准：老保险库该用当初写进去的轮数才解得开，
// 而不是被今天的默认值悄悄改掉。
const iterationsOf = record => record.kdf?.iterations ?? DEFAULT_ITERATIONS;

// 读写的统一闸门：所有需要密钥的操作都先过这里，顺带把「超时该锁了」这件事办掉。
function requireSession() {
  if (!isUnlocked()) throw new Error('密码箱已锁定，请先解锁');
  return session;
}

async function establishSession(raw) {
  const wasUnlocked = session !== null;
  session = { key: await importDek(raw), raw };
  touch();
  startIdleWatcher();
  if (!wasUnlocked) notify(true);
}

// 密码路径与恢复码路径的解包收在一处：解不开就是同一句「不对」，
// 且失败前一定先把会话清干净——绝不能留下「解锁失败却 isUnlocked() 为真」的半解锁状态。
async function unwrapOrFail(kek, wrapped, record, message) {
  let raw;
  try {
    raw = await unwrapDek(kek, wrapped);
  } catch {
    clearSession();
    throw new Error(message);
  }
  // 记录里压根没有条目密文（被外部写坏了）时，试解无从谈起：这属于格式异常，
  // 不能伪装成「主密码不正确」，否则用户会一直重输一个其实正确的密码。
  if (typeof record?.ciphertext?.ct !== 'string' || typeof record.ciphertext.iv !== 'string') {
    clearSession();
    throw new Error('保险库内容格式异常：记录里没有条目密文');
  }
  // 密钥承诺：解出来的 DEK 必须真的能打开这份库，才允许建立会话。
  // 记录内部没有 AAD，所以「把 wrappedDekByPassword 整条换成用同一把 KEK 包裹的另一把随机
  // DEK」这种错配，unwrapDek 是照样成功的——症状会推迟到 loadItems()，表现为
  // 「解锁成功却打不开库」。多花一次 AES-GCM（约 1ms）把它收敛回一次明确的解锁失败。
  // 这需要先知道主密码才能构造出这种记录，因此不可被利用；代价是错密码多算一次判定。
  try {
    await decryptJSON(await importDek(raw), record.ciphertext);
  } catch {
    clearSession();
    throw new Error(message);
  }
  await establishSession(raw);
}

// 未初始化 → false；已初始化 → true。注意「已初始化」不等于「已解锁」。
export async function isInitialized() {
  return Boolean(await readRecord());
}

// 首次设置主密码。返回的恢复码是用户唯一一次能看到它的机会，UI 必须当场让他抄下来。
export async function initVault(masterPassword) {
  if (await readRecord()) throw new Error('密码箱已经设置过了');

  const recoveryCode = generateRecoveryCode();
  const saltPassword = randomBytes(SALT_BYTES);
  const saltRecovery = randomBytes(SALT_BYTES);
  const raw = generateDek();

  // 两个盐各自独立：即便主密码恰好等于恢复码，两条路径派生的 KEK 也不会相同。
  const [kekPassword, kekRecovery] = await Promise.all([
    deriveKey(String(masterPassword), saltPassword, DEFAULT_ITERATIONS),
    deriveKey(normalizeRecoveryCode(recoveryCode), saltRecovery, DEFAULT_ITERATIONS)
  ]);
  // 同一个 DEK 包两份，各用各的 KEK；两份包裹的 IV 由 wrapDek 各自现取，互不相同。
  const [wrappedDekByPassword, wrappedDekByRecovery] = await Promise.all([
    wrapDek(kekPassword, raw),
    wrapDek(kekRecovery, raw)
  ]);

  // 初始内容就是「一个空数组」，同样走正常加密路径：这样「密码箱是空的」与
  // 「密码箱还没设置」在存储层面长得完全不一样，不会互相混淆。
  const ciphertext = await encryptJSON(await importDek(raw), []);

  const record = {
    version: VAULT_VERSION,
    kdf: { name: KDF_NAME, iterations: DEFAULT_ITERATIONS },
    saltPassword: toBase64(saltPassword),
    saltRecovery: toBase64(saltRecovery),
    wrappedDekByPassword,
    wrappedDekByRecovery,
    ciphertext,
    updatedAt: Date.now()
  };
  await db.put('settings', { key: VAULT_KEY, value: record });

  // 刚设完密码的人显然马上要往里放东西，直接建立会话，省掉一次重复输入。
  await establishSession(raw);
  return { recoveryCode };
}

export async function unlock(masterPassword) {
  const record = await requireRecord();
  const kek = await deriveKey(
    String(masterPassword),
    fromBase64(record.saltPassword),
    iterationsOf(record)
  );
  await unwrapOrFail(kek, record.wrappedDekByPassword, record, '主密码不正确');
}

export async function unlockWithRecoveryCode(code) {
  const record = await requireRecord();

  // 归一化必须发生在派生 KEK 之前：用户会带连字符、写成小写，甚至把 O 抄成 0（或反过来），
  // 这些都是同一条恢复码。先收敛成同一个字符串，正确的码才一定解得开。
  let normalized;
  try {
    normalized = normalizeRecoveryCode(code);
  } catch {
    clearSession();
    throw new Error('恢复码不正确');
  }

  const kek = await deriveKey(normalized, fromBase64(record.saltRecovery), iterationsOf(record));
  await unwrapOrFail(kek, record.wrappedDekByRecovery, record, '恢复码不正确');
}

export function lock() {
  clearSession();
}

export function isUnlocked() {
  if (!session) return false;
  // 超时判定不留给「下一次操作」：谁先问到谁负责把会话清掉，并把锁屏通知发出去。
  if (Date.now() - lastTouched > IDLE_LIMIT_MS) {
    clearSession();
    return false;
  }
  return true;
}

// 任何一次真实的读写都会调用它，把空闲计时推到当下。锁定时调用没有意义（不复活会话）。
export function touch() {
  if (session) lastTouched = Date.now();
}

export async function loadItems() {
  const record = await requireRecord();
  const current = requireSession();
  const items = await decryptJSON(current.key, record.ciphertext);
  touch();
  // 解出来不是数组，说明这份记录不是本 app 写出来的（密文有认证标签，写入方正常时不可能
  // 出现这种内容）。静默当空数组更危险：用户会看到「密码箱是空的」，而真正的数据可能
  // 就躺在旁边那份解不开的记录里。宁可抛错，让界面把「读取失败」说出来。
  if (!Array.isArray(items)) throw new Error('保险库内容格式异常：解出的内容不是条目数组');
  return items;
}

export async function saveItems(items) {
  if (!Array.isArray(items)) throw new Error('saveItems 需要条目数组');
  const record = await requireRecord();
  const current = requireSession();

  // 整包重新加密（AES-GCM 不给局部更新留余地）；encryptJSON 每次现取一个新的 12 字节 IV，
  // 所以同一个 DEK 下绝不会出现 IV 复用。
  const ciphertext = await encryptJSON(current.key, items);
  const next = { ...record, ciphertext, updatedAt: Date.now() };
  await db.put('settings', { key: VAULT_KEY, value: next });
  touch();
  return items;
}

// 只换「包裹 DEK 的那把钥匙」：DEK 本身不变，条目密文一个字都不用动。
// 代价是一次 PBKDF2，而不是重新加密整个密码箱。
export async function changeMasterPassword(newPassword) {
  const record = await requireRecord();
  const current = requireSession();

  const saltPassword = randomBytes(SALT_BYTES);
  const kek = await deriveKey(String(newPassword), saltPassword, iterationsOf(record));
  const wrappedDekByPassword = await wrapDek(kek, current.raw);

  // saltRecovery / wrappedDekByRecovery 原样带过：旧恢复码必须继续有效——
  // 改个密码顺手把救生圈扔了，恰恰毁掉恢复码存在的意义。
  const next = {
    ...record,
    saltPassword: toBase64(saltPassword),
    wrappedDekByPassword,
    updatedAt: Date.now()
  };
  await db.put('settings', { key: VAULT_KEY, value: next });
  touch();
}

// 重新生成恢复码：**只换恢复码这一条路**，主密码与条目密文一个字都不动。
//
// 为什么需要它：恢复码只在初始化的那一屏出现过一次，用户手滑切了 Tab、在那屏刷新了页面、
// 或者干脆把抄写的纸条弄丢了，就再也没有地方能拿到它——而这三件事都不该是终局：
// 用户手里还有主密码，本来就完全有权补发一串新的。**没有这个入口，「恢复码只展示一次」
// 就是一条不可逆的风险**：一次误操作 = 永久失去唯一退路。
//
// 与 changeMasterPassword 同构：DEK 不变，只重新包裹它，所以不需要重新加密任何条目
// （代价是一次 PBKDF2 而不是整库重加密）。区别是这次换的是恢复码那一份包裹：
//   - saltRecovery / wrappedDekByRecovery → 全新（旧恢复码从这一刻起立即失效，这是预期：
//     换恢复码的意义就在于「旧的那串从此没用」，否则等于凭空多留了一把没人数得清的钥匙）
//   - saltPassword / wrappedDekByPassword → 原样保留（主密码不受影响，仍然能解锁）
//   - ciphertext → **一个字节都不能动**（它的加密密钥是 DEK，而 DEK 没换；碰它等于把用户的
//     条目全部废掉）
export async function regenerateRecoveryCode(masterPassword) {
  const record = await requireRecord();

  // 第一步先证明「你是本人」：重新派生 KEK、解开包裹拿回 32 字节原始 DEK。
  // 这一步是纯读的——派生失败或解不开都直接抛错，记录一个字节都不会被碰。
  // 这里刻意不动会话：这不是一次解锁尝试，输错密码不该把已经解锁的密码箱踢回锁屏
  // （用户只是打错了一个字符，他并没有要求上锁）。
  let raw;
  try {
    const kek = await deriveKey(
      String(masterPassword),
      fromBase64(record.saltPassword),
      iterationsOf(record)
    );
    raw = await unwrapDek(kek, record.wrappedDekByPassword);
  } catch {
    throw new Error('主密码不正确');
  }

  try {
    // 与 unwrapOrFail 里同一条「密钥承诺」：记录被外部改坏（密码那份包裹与条目密文错配）时，
    // 单看 unwrapDek 是成功的，但把恢复码绑到一把打不开库的 DEK 上只会让用户以为补发成功、
    // 事后才发现新恢复码也是废的。多花一次 AES-GCM（约 1ms）把它收敛成一次当场失败。
    try {
      await decryptJSON(await importDek(raw), record.ciphertext);
    } catch {
      throw new Error('主密码不正确');
    }

    const recoveryCode = generateRecoveryCode();
    const saltRecovery = randomBytes(SALT_BYTES);
    // 用新恢复码归一化后派生的 KEK 重新包裹**同一个 DEK**；包裹用的 IV 由 wrapDek 现取，绝不复用。
    const kekRecovery = await deriveKey(
      normalizeRecoveryCode(recoveryCode),
      saltRecovery,
      iterationsOf(record)
    );
    const wrappedDekByRecovery = await wrapDek(kekRecovery, raw);

    const next = {
      ...record,
      saltRecovery: toBase64(saltRecovery),
      wrappedDekByRecovery,
      updatedAt: Date.now()
    };
    await db.put('settings', { key: VAULT_KEY, value: next });
    touch();
    // 这串码和 initVault 返回的那串一样：只在内存里存在这一次，UI 必须当场展示并让用户抄下来。
    return { recoveryCode };
  } finally {
    // 用完就把局部字节清零：这 32 字节只在「重新包裹」的瞬间需要存在（wrapDek / importDek
    // 都已把内容复制进去），留着一个多余的 DEK 副本没有任何理由。失败路径同样会走到这里。
    raw.fill(0);
  }
}

// 订阅锁定状态变化：回调收到 true（已解锁）或 false（已锁定），返回取消订阅函数。
export function onLockChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
