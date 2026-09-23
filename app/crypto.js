// 密码箱与备份的加密底座：PBKDF2 派生密钥 + AES-GCM 认证加密。
// 只用 WebCrypto / btoa / atob 这些浏览器与 Node 都有的全局对象，绝不用 node:crypto 或 Buffer。
//
// 两条必须守住的安全约定：
// 1. 同一密钥下 IV 绝不重复——每次加密都新生成 12 字节随机 IV（GCM 的 IV 复用会直接毁掉保密性），绝不复用。
// 2. 密钥只在内存——本模块只负责算与解，不做任何持久化，也不要把 KEK / DEK 写进任何存储。

export const DEFAULT_ITERATIONS = 600000;
const IV_BYTES = 12;

// 分块喂给 fromCharCode：展开运算符会把每个字节变成一个实参，约 13 万字节就爆栈（RangeError）。
// 备份包、保险库整包轻松超过这个量级，所以这里按 32KB 一块拼接，行为与一次性展开完全一致。
const CHUNK_BYTES = 0x8000;

export function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK_BYTES) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK_BYTES));
  }
  return btoa(binary);
}

export function fromBase64(text) {
  return Uint8Array.from(atob(text), c => c.charCodeAt(0));
}

export function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

// 主密码 / 恢复码 + 盐 → KEK。迭代次数按场景传：生产用 DEFAULT_ITERATIONS，测试传小值提速。
export async function deriveKey(password, salt, iterations = DEFAULT_ITERATIONS) {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export function generateDek() {
  return crypto.getRandomValues(new Uint8Array(32));
}

// 密钥有两种形态：deriveKey 交出来的 CryptoKey，和 generateDek / unwrapDek 交出来的 32 字节 raw DEK。
// WebCrypto 的 encrypt / decrypt 只认 CryptoKey，所以 raw 形态在这里就地升格——raw 是「可包裹、可导出」的形态，
// 而包裹与解包（wrapDek / unwrapDek）走 CryptoKey，两边就都能用同一条加密路径。
async function asKey(key) {
  if (key?.type === 'secret') return key;
  // raw 形态统一走 importDek，避免两处各自 importKey 导致参数慢慢漂移。
  return importDek(key);
}

// 信封加密：用 KEK 把 DEK 包一份存起来（主密码一份、恢复码一份），保险库本体一律用 DEK 加密。
export async function wrapDek(kek, dek) {
  const iv = randomBytes(IV_BYTES);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, dek);
  return { iv: toBase64(iv), ct: toBase64(new Uint8Array(ct)) };
}

export async function unwrapDek(kek, wrapped) {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(wrapped.iv) },
    kek,
    fromBase64(wrapped.ct)
  );
  return new Uint8Array(plain);
}

// 把原始 DEK 字节转成可用的 CryptoKey。extractable 保持 false：这个密钥只用于加解密，
// 没有任何理由允许把它导出成字节（原始字节只在包裹/解包的两个瞬间存在）。
export async function importDek(bytes) {
  return crypto.subtle.importKey(
    'raw',
    bytes,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptJSON(key, value) {
  const iv = randomBytes(IV_BYTES);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await asKey(key),
    new TextEncoder().encode(JSON.stringify(value))
  );
  return { iv: toBase64(iv), ct: toBase64(new Uint8Array(ct)) };
}

// 密钥不对、IV 不对、密文被改过，都在这句 decrypt 上抛 OperationError——本模块不区分原因，不额外加错误码。
export async function decryptJSON(key, payload) {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(payload.iv) },
    await asKey(key),
    fromBase64(payload.ct)
  );
  return JSON.parse(new TextDecoder().decode(plain));
}
