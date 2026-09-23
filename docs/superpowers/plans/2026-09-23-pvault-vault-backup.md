# pvault 密码箱与备份 实现计划（计划 2）

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 给 pvault 加上统一加密箱（网站账号 / 银行卡证件 / 零散备注）与**备份导出/导入**，并保证「忘了主密码也没有第二条后门、但有恢复码」这一安全语义被正确实现。

**架构：** 信封加密——随机 32 字节 DEK 加密保险库，DEK 分别用「主密码派生的 KEK」和「恢复码派生的 KEK」各包裹一份。全程用浏览器内置 WebCrypto，**不引任何第三方密码学库**。记账数据不上锁（保持明文，掏出来就能记）；备份文件把记账数据与保险库一起打包后整体加密。

**技术栈：** 原生 ES Modules / WebCrypto / IndexedDB / Node 24 `node:test`（零依赖、无构建，与计划 1 一致）

**前置：** 计划 1（记账模块）已完成并合入 `main`。本计划在 `main` 上开新分支 `feat/vault`。

---

## 顺序说明（为什么先做备份）

用户的原话是「继续进行计划2」，而计划 2 含两块。**先做加密核心与备份（阶段 A/B），再做密码箱界面（阶段 C）**，理由：

> 现在账目只存在手机浏览器的 IndexedDB 里，用户清理一下浏览器数据就全没了。备份是当前**最高风险缺口**，而备份的加密依赖与密码箱完全相同的基础设施（同一套 DEK/KEK 机制），先做它等于先给数据上保险，再做密码箱几乎是顺手的。

所以本计划的任务顺序是：**加密底座 → 备份 → 密码箱**。

---

## 与设计规格的两处偏离（有意，已确认）

1. **恢复码长度**：规格 7 节写「32 字节随机值 → Base32 → 52 个字符」。实现改为 **20 字节（160 位熵）→ Crockford Base32 → 32 个字符**，显示为 8 组 4 字符。理由：160 位熵远超「离线暴力破解不可行」所需，而 32 字符比 52 字符更容易被用户正确抄写——**抄错一个字符就等于丢了恢复码**，这是真实风险；Crockford 字母表另外去掉了 `I/L/O/U` 四个易混字符，并允许解码时把 `I/L` 当 `1`、`O` 当 `0`。
2. **密钥超时**：规格 7 节写「切走超过 5 分钟即清除」。实现采用**空闲计时**（任何一次需要 DEK 的操作都会刷新计时），而不是「切走」——因为「切走」在 PWA 里没有一个可靠的捕获点（`visibilitychange` 在手机上表现不一致）。语义不变：5 分钟没碰过密码箱就重新上锁。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `app/crypto.js` | **纯**：base64 编解码、密钥派生（PBKDF2）、AES-GCM 加解密、DEK 生成与包裹/解包 |
| `app/recovery-code.js` | **纯**：恢复码生成、Crockford Base32 编解码、容错归一化 |
| `app/vault-model.js` | **纯**：条目类型与字段定义、校验、搜索过滤、显示格式化 |
| `app/backup.js` | **纯**：备份包的组装、版本校验、解析 |
| `app/vault-store.js` | 仓库层：保险库的读写、初始化、解锁、改主密码、空闲上锁 |
| `app/backup-store.js` | 仓库层：导出备份文件、导入恢复 |
| `app/ui/vault-view.js` | 密码箱主视图：未初始化 / 未解锁 / 已解锁 三态 |
| `app/ui/vault-editor.js` | 条目编辑（三类字段表单） |
| `app/ui/backup-view.js` | 备份与恢复界面 |
| `app/ui/clipboard.js` | 复制并 30 秒后清空剪贴板 |
| `app/main.js` | 把 `PLACEHOLDER.vault` 换成真实视图；首页备份提醒 |
| `app/ui/ledger-home.js` | 首页加「上次备份 N 天前」提示 |
| `app/ui/settings-sheet.js` | 加「备份与恢复」入口 |
| `app/schema.js` | 种子 settings 增加 `vault` 与 `backupReminderDays` 两项 |
| `tests/*.test.js` | 四个纯逻辑模块的单测 |

**分层规则（与计划 1 相同）**：`crypto.js` / `recovery-code.js` / `vault-model.js` / `backup.js` 四个纯模块**只能 import 彼此**，绝不能 import `db.js` / `store.js` / `ui/`。这条规则是它们能在 Node 里被单测的前提。

---

## 全局约定

- 金额仍是整数分；时间戳仍是毫秒。
- **加密相关的一切二进制都用 base64 字符串存取**（IndexedDB 里存字符串比 ArrayBuffer 稳）。
- **同一密钥下 AES-GCM 的 IV 绝不重复**：每次加密都新生成 12 字节随机 IV。
- commit message 用中文，前缀 `feat:` / `test:` / `fix:` / `chore:` / `docs:`。
- **每改一次代码，`sw.js` 的 `CACHE` 版本号必须 +1**，否则手机上永远看到旧版本。

---

## 阶段 A：加密底座

### 任务 1：加密模块 `app/crypto.js`

**文件：**
- 创建：`app/crypto.js`
- 测试：`tests/crypto.test.js`

- [x] **步骤 1：编写失败的测试**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ITERATIONS, toBase64, fromBase64, randomBytes,
  deriveKey, generateDek, wrapDek, unwrapDek,
  encryptJSON, decryptJSON
} from '../app/crypto.js';

test('base64 往返', () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 255]);
  assert.deepEqual(fromBase64(toBase64(bytes)), bytes);
});

test('randomBytes 长度正确且每次不同', () => {
  const a = randomBytes(32);
  const b = randomBytes(32);
  assert.equal(a.length, 32);
  assert.notDeepEqual(a, b);
});

test('deriveKey 同一密码同一盐得到同一密钥（可解密彼此的密文）', async () => {
  const salt = randomBytes(16);
  const k1 = await deriveKey('correct horse', salt, 1000);
  const k2 = await deriveKey('correct horse', salt, 1000);
  const payload = await encryptJSON(k1, { hello: 'world' });
  assert.deepEqual(await decryptJSON(k2, payload), { hello: 'world' });
});

test('deriveKey 不同密码得到的密钥无法解密', async () => {
  const salt = randomBytes(16);
  const k1 = await deriveKey('password-a', salt, 1000);
  const k2 = await deriveKey('password-b', salt, 1000);
  const payload = await encryptJSON(k1, { secret: 1 });
  await assert.rejects(() => decryptJSON(k2, payload));
});

test('deriveKey 不同盐得到的密钥无法解密', async () => {
  const k1 = await deriveKey('same', randomBytes(16), 1000);
  const k2 = await deriveKey('same', randomBytes(16), 1000);
  const payload = await encryptJSON(k1, { secret: 1 });
  await assert.rejects(() => decryptJSON(k2, payload));
});

test('DEK 包裹与解包往返', async () => {
  const dek = generateDek();
  const kek = await deriveKey('master', randomBytes(16), 1000);
  const wrapped = await wrapDek(kek, dek);
  const unwrapped = await unwrapDek(kek, wrapped);
  const payload = await encryptJSON(dek, { a: 1 });
  assert.deepEqual(await decryptJSON(unwrapped, payload), { a: 1 });
});

test('错误的 KEK 解不开包裹的 DEK', async () => {
  const dek = generateDek();
  const good = await deriveKey('good', randomBytes(16), 1000);
  const bad = await deriveKey('bad', randomBytes(16), 1000);
  const wrapped = await wrapDek(good, dek);
  await assert.rejects(() => unwrapDek(bad, wrapped));
});

test('密文被篡改时解密失败（GCM 认证标签生效）', async () => {
  const key = await deriveKey('k', randomBytes(16), 1000);
  const payload = await encryptJSON(key, { amount: 100 });
  const bytes = fromBase64(payload.ct);
  bytes[0] ^= 0x01;
  const tampered = { ...payload, ct: toBase64(bytes) };
  await assert.rejects(() => decryptJSON(key, tampered));
});

test('每次加密使用不同的 IV', async () => {
  const key = await deriveKey('k', randomBytes(16), 1000);
  const p1 = await encryptJSON(key, { x: 1 });
  const p2 = await encryptJSON(key, { x: 1 });
  assert.notEqual(p1.iv, p2.iv);
};

test('能加密中文与嵌套结构', async () => {
  const key = await deriveKey('k', randomBytes(16), 1000);
  const data = { 标题: '招商银行', 字段: { 卡号: '6225 8888', tags: ['a', 'b'] }, n: null };
  assert.deepEqual(await decryptJSON(key, await encryptJSON(key, data)), data);
});

test('派生密钥的默认迭代次数是 600000', async () => {
  assert.equal(DEFAULT_ITERATIONS, 600000);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test --test-isolation=none tests/crypto.test.js`
预期：FAIL，报 `Cannot find module '../app/crypto.js'`。

- [x] **步骤 3：实现 `app/crypto.js`**

```js
export const DEFAULT_ITERATIONS = 600000;
const IV_BYTES = 12;

export function toBase64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}

export function fromBase64(text) {
  return Uint8Array.from(atob(text), c => c.charCodeAt(0));
}

export function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

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

export async function encryptJSON(key, value) {
  const iv = randomBytes(IV_BYTES);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(JSON.stringify(value))
  );
  return { iv: toBase64(iv), ct: toBase64(new Uint8Array(ct)) };
}

export async function decryptJSON(key, payload) {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(payload.iv) },
    key,
    fromBase64(payload.ct)
  );
  return JSON.parse(new TextDecoder().decode(plain));
}
```

> `btoa`/`atob` 在 Node 24 里是全局可用的（与浏览器一致），所以这个模块能直接在 Node 里测。**不要**用 `Buffer`，那会让它在浏览器里挂掉。

- [x] **步骤 4：运行测试验证通过** → 11 个用例全过

- [x] **步骤 5：Commit**

```bash
git add app/crypto.js tests/crypto.test.js
git commit -m "feat: 加密模块（PBKDF2 派生 + AES-GCM 信封加密）"
```

---

### 任务 2：恢复码 `app/recovery-code.js`

**文件：**
- 创建：`app/recovery-code.js`
- 测试：`tests/recovery-code.test.js`

- [x] **步骤 1：编写失败的测试**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateRecoveryCode, encodeRecoveryCode, decodeRecoveryCode,
  normalizeRecoveryCode, formatRecoveryCode
} from '../app/recovery-code.js';

test('生成的恢复码是 32 个字符', () => {
  const code = generateRecoveryCode();
  assert.equal(code.length, 32);
});

test('两次生成的恢复码不同', () => {
  assert.notEqual(generateRecoveryCode(), generateRecoveryCode());
});

test('恢复码只用 Crockford 字母表（不含 I L O U）', () => {
  for (let i = 0; i < 200; i++) {
    assert.match(generateRecoveryCode(), /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{32}$/);
  }
});

test('编解码往返', () => {
  const bytes = Uint8Array.from({ length: 20 }, (_, i) => i * 7 % 256);
  assert.deepEqual(decodeRecoveryCode(encodeRecoveryCode(bytes)), bytes);
});

test('字节数不对时编码抛错', () => {
  assert.throws(() => encodeRecoveryCode(new Uint8Array(19)), RangeError);
});

test('长度不对的恢复码解码抛错', () => {
  assert.throws(() => decodeRecoveryCode('ABC'), /恢复码/);
});

test('归一化：忽略大小写、空格、连字符', () => {
  assert.equal(normalizeRecoveryCode('abcd-efgh'), 'ABCDEFGH');
  assert.equal(normalizeRecoveryCode('abcd efgh'), 'ABCDEFGH');
  assert.equal(normalizeRecoveryCode('  ABCD-EFGH  '), 'ABCDEFGH');
});

test('归一化：易混字符映射（I/L→1，O→0）', () => {
  assert.equal(normalizeRecoveryCode('IILLOO'), '111100');
  assert.equal(normalizeRecoveryCode('oil'), '011');
});

test('归一化后能解出与原码相同的结果', () => {
  const code = generateRecoveryCode();
  const spaced = formatRecoveryCode(code);
  assert.deepEqual(decodeRecoveryCode(normalizeRecoveryCode(spaced)), decodeRecoveryCode(code));
  assert.deepEqual(decodeRecoveryCode(normalizeRecoveryCode(code.toLowerCase())), decodeRecoveryCode(code));
});

test('格式化：每 4 个字符一组、用连字符分隔', () => {
  assert.equal(formatRecoveryCode('ABCDEFGH23456789ABCDEFGH23456789'), 'ABCD-EFGH-2345-6789-ABCD-EFGH-2345-6789');
});

test('归一化遇到不合法字符抛错', () => {
  assert.throws(() => normalizeRecoveryCode('ABC$DEFG'), /恢复码/);
});
```

- [ ] **步骤 2：运行测试验证失败** → `Cannot find module '../app/recovery-code.js'`

- [x] **步骤 3：实现 `app/recovery-code.js`**

```js
import { randomBytes } from './crypto.js';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_BYTES = 20;
export const CODE_LENGTH = 32;

export function encodeRecoveryCode(bytes) {
  if (bytes.length !== CODE_BYTES) {
    throw new RangeError(`恢复码必须是 ${CODE_BYTES} 字节`);
  }
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function normalizeRecoveryCode(input) {
  const cleaned = String(input).toUpperCase().replace(/[\s-]/g, '');
  const mapped = cleaned.replace(/[IL]/g, '1').replace(/O/g, '0');
  if (!/^[0-9A-Z]+$/.test(mapped)) {
    throw new Error('恢复码包含无法识别的字符');
  }
  for (const ch of mapped) {
    if (!ALPHABET.includes(ch)) {
      throw new Error(`恢复码包含无法识别的字符：${ch}`);
    }
  }
  return mapped;
}

export function decodeRecoveryCode(input) {
  const code = normalizeRecoveryCode(input);
  if (code.length !== CODE_LENGTH) {
    throw new Error(`恢复码长度应为 ${CODE_LENGTH} 个字符，实际 ${code.length}`);
  }
  const out = new Uint8Array(CODE_BYTES);
  let bits = 0;
  let value = 0;
  let index = 0;
  for (const ch of code) {
    value = (value << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out[index++] = (value >>> (bits - 8)) & 255;
      bits -= 8;
    }
  }
  return out;
}

export function generateRecoveryCode() {
  return encodeRecoveryCode(randomBytes(CODE_BYTES));
}

export function formatRecoveryCode(code) {
  return normalizeRecoveryCode(code).replace(/(.{4})(?=.)/g, '$1-');
}
```

- [x] **步骤 4：运行测试验证通过** → 11 个用例全过

- [x] **步骤 5：Commit**

```bash
git add app/recovery-code.js tests/recovery-code.test.js
git commit -m "feat: 恢复码（Crockford Base32 编码与容错归一化）"
```

---

### 任务 3：保险库条目模型 `app/vault-model.js`

**文件：**
- 创建：`app/vault-model.js`
- 测试：`tests/vault-model.test.js`

- [x] **步骤 1：编写失败的测试**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ITEM_TYPES, emptyItem, validateItem, searchItems,
  groupItems, maskSecret, itemSummary
} from '../app/vault-model.js';

const login = {
  id: 'a', type: 'login', title: 'GitHub',
  fields: { username: 'zhangsan', password: 'p@ss', url: 'github.com', note: '' },
  createdAt: 1, updatedAt: 1
};
const card = {
  id: 'b', type: 'card', title: '招行储蓄卡',
  fields: { number: '6225888812345678', holder: '张三', expiry: '12/28', cvv: '123', bank: '招商银行', note: '' },
  createdAt: 2, updatedAt: 2
};
const note = {
  id: 'c', type: 'note', title: '家里 WiFi',
  fields: { body: 'TP-LINK-5G / 密码 88888888' },
  createdAt: 3, updatedAt: 3
};

test('ITEM_TYPES 覆盖三种类型且带中文名', () => {
  assert.deepEqual(Object.keys(ITEM_TYPES).sort(), ['card', 'login', 'note']);
  assert.equal(ITEM_TYPES.login.label, '网站与 App');
  assert.equal(ITEM_TYPES.card.label, '银行卡与证件');
  assert.equal(ITEM_TYPES.note.label, '零散备注');
});

test('emptyItem 按类型给出空字段', () => {
  const item = emptyItem('login');
  assert.equal(item.type, 'login');
  assert.equal(item.title, '');
  assert.deepEqual(Object.keys(item.fields).sort(), ['note', 'password', 'url', 'username']);
  assert.equal(emptyItem('note').fields.body, '');
});

test('validateItem：标题必填', () => {
  const bad = { ...login, title: '   ' };
  const r = validateItem(bad);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes('标题')));
});

test('validateItem：login 至少要有用户名或密码之一', () => {
  const empty = { id: 'x', type: 'login', title: 'T', fields: { username: '', password: '', url: '', note: '' } };
  assert.equal(validateItem(empty).ok, false);
  const onlyUser = { ...empty, fields: { ...empty.fields, username: 'u' } };
  assert.equal(validateItem(onlyUser).ok, true);
});

test('validateItem：card 必须有卡号', () => {
  const noNumber = { ...card, fields: { ...card.fields, number: '' } };
  assert.equal(validateItem(noNumber).ok, false);
  assert.equal(validateItem(card).ok, true);
});

test('validateItem：note 必须有正文', () => {
  const emptyBody = { ...note, fields: { body: '  ' } };
  assert.equal(validateItem(emptyBody).ok, false);
});

test('validateItem：未知类型被拒', () => {
  assert.equal(validateItem({ id: 'x', type: 'ghost', title: 'T', fields: {} }).ok, false);
});

test('searchItems：匹配标题、字段值，忽略大小写', () => {
  const items = [login, card, note];
  assert.deepEqual(searchItems(items, 'github').map(i => i.id), ['a']);
  assert.deepEqual(searchItems(items, 'GITHUB').map(i => i.id), ['a']);
  assert.deepEqual(searchItems(items, '6225').map(i => i.id), ['b']);
  assert.deepEqual(searchItems(items, 'wifi').map(i => i.id), ['c']);
  assert.deepEqual(searchItems(items, '张三').map(i => i.id), ['b']);
});

test('searchItems：空查询返回全部', () => {
  assert.equal(searchItems([login, card, note], '').length, 3);
  assert.equal(searchItems([login, card, note], '   ').length, 3);
});

test('groupItems：按类型分组并按标题排序', () => {
  const other = { ...login, id: 'd', title: 'AAA 站' };
  const groups = groupItems([login, card, note, other]);
  assert.deepEqual(groups.login.map(i => i.title), ['AAA 站', 'GitHub']);
  assert.equal(groups.card.length, 1);
  assert.equal(groups.note.length, 1);
});

test('maskSecret 保留首尾、中间打点', () => {
  assert.equal(maskSecret('6225888812345678'), '6225 •••• •••• 5678');
  assert.equal(maskSecret('1234'), '••••');
  assert.equal(maskSecret(''), '');
});

test('itemSummary：给列表用的副标题', () => {
  assert.equal(itemSummary(login), 'zhangsan');
  assert.equal(itemSummary(card), '6225 •••• •••• 5678');
  assert.equal(itemSummary({ ...note, fields: { body: 'TP-LINK-5G / 密码 88888888' } }), 'TP-LINK-5G / 密码 88888888');
});
```

- [ ] **步骤 2：运行测试验证失败**

- [x] **步骤 3：实现 `app/vault-model.js`**

```js
export const ITEM_TYPES = {
  login: { label: '网站与 App', icon: '🌐', fields: ['username', 'password', 'url', 'note'] },
  card: { label: '银行卡与证件', icon: '💳', fields: ['number', 'holder', 'expiry', 'cvv', 'bank', 'note'] },
  note: { label: '零散备注', icon: '📝', fields: ['body'] }
};

export const FIELD_LABELS = {
  username: '用户名', password: '密码', url: '网址', note: '备注',
  number: '卡号', holder: '持卡人', expiry: '有效期', cvv: '安全码', bank: '发卡行',
  body: '内容'
};

export const SECRET_FIELDS = new Set(['password', 'cvv']);

export function emptyItem(type) {
  const def = ITEM_TYPES[type];
  const fields = {};
  for (const f of def ? def.fields : []) fields[f] = '';
  return { id: null, type, title: '', fields, createdAt: null, updatedAt: null };
}

export function validateItem(item) {
  const errors = [];
  const def = ITEM_TYPES[item?.type];
  if (!def) return { ok: false, errors: ['未知的条目类型'] };
  if (!String(item.title ?? '').trim()) errors.push('标题不能为空');
  const f = item.fields ?? {};
  const has = k => String(f[k] ?? '').trim().length > 0;
  if (item.type === 'login' && !has('username') && !has('password')) {
    errors.push('用户名与密码至少要填一个');
  }
  if (item.type === 'card' && !has('number')) errors.push('卡号不能为空');
  if (item.type === 'note' && !has('body')) errors.push('内容不能为空');
  return { ok: errors.length === 0, errors };
}

function haystack(item) {
  const parts = [item.title];
  for (const v of Object.values(item.fields ?? {})) parts.push(String(v ?? ''));
  return parts.join('\n').toLowerCase();
}

export function searchItems(items, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return items.slice();
  return items.filter(item => haystack(item).includes(q));
}

export function groupItems(items) {
  const out = { login: [], card: [], note: [] };
  for (const item of items) {
    if (out[item.type]) out[item.type].push(item);
  }
  for (const key of Object.keys(out)) {
    out[key].sort((a, b) => String(a.title).localeCompare(String(b.title), 'zh-Hans-CN'));
  }
  return out;
}

export function maskSecret(value) {
  const s = String(value ?? '').replace(/\s/g, '');
  if (!s) return '';
  if (s.length <= 8) return '•'.repeat(s.length);
  const head = s.slice(0, 4);
  const tail = s.slice(-4);
  const middle = Math.max(0, s.length - 8);
  const masked = '•'.repeat(middle).replace(/(.{4})/g, '$1 ').trim();
  return `${head} ${masked} ${tail}`.replace(/\s+/g, ' ').trim();
}

export function itemSummary(item) {
  if (item.type === 'login') return item.fields.username || item.fields.url || '';
  if (item.type === 'card') return maskSecret(item.fields.number);
  return String(item.fields.body ?? '').split('\n')[0].slice(0, 40);
}
```

> `maskSecret` 的契约：中间段用 `•`、每 4 个一组以空格分隔；长度不超过 8 位时整串打点；空串返回空串。这个形状同时被列表副标题（`itemSummary`）与详情页复用。

- [x] **步骤 4：运行测试验证通过** → 12 个用例全过

- [x] **步骤 5：Commit**

```bash
git add app/vault-model.js tests/vault-model.test.js
git commit -m "feat: 保险库条目模型（类型定义、校验、搜索、掩码）"
```

---

### 任务 4：备份包格式 `app/backup.js`

**文件：**
- 创建：`app/backup.js`
- 测试：`tests/backup.test.js`

- [x] **步骤 1：编写失败的测试**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BACKUP_VERSION, buildBackup, validateBackup, summarizeBackup } from '../app/backup.js';

const payload = {
  txns: [{ id: 't1', kind: 'expense', amountCents: 100, occurredAt: 1 }],
  accounts: [{ id: 'a1', name: '现金' }],
  categories: [{ id: 'c1', name: '餐饮' }],
  receivables: [],
  settings: [{ key: 'hideAmounts', value: false }],
  vault: { version: 1, ciphertext: { iv: 'x', ct: 'y' } }
};

test('buildBackup 带上格式标识、版本与时间戳', () => {
  const b = buildBackup(payload, 1700000000000);
  assert.equal(b.format, 'pvault-backup');
  assert.equal(b.version, BACKUP_VERSION);
  assert.equal(b.createdAt, 1700000000000);
  assert.deepEqual(Object.keys(b.data).sort(), ['accounts', 'categories', 'receivables', 'settings', 'txns', 'vault']);
});

test('buildBackup 深拷贝，不引用原对象', () => {
  const b = buildBackup(payload, 1);
  b.data.accounts[0].name = '改了';
  assert.equal(payload.accounts[0].name, '现金');
});

test('validateBackup：合法包通过', () => {
  assert.equal(validateBackup(buildBackup(payload, 1)).ok, true);
});

test('validateBackup：非对象、缺格式、格式不对都被拒', () => {
  assert.equal(validateBackup(null).ok, false);
  assert.equal(validateBackup({}).ok, false);
  assert.equal(validateBackup({ format: 'other', version: 1, data: {} }).ok, false);
});

test('validateBackup：版本高于支持版本时给出明确提示', () => {
  const b = buildBackup(payload, 1);
  b.version = BACKUP_VERSION + 5;
  const r = validateBackup(b);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes('版本')));
});

test('validateBackup：data 缺关键数组时报错', () => {
  const b = buildBackup(payload, 1);
  delete b.data.txns;
  const r = validateBackup(b);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes('txns')));
});

test('validateBackup：vault 可以为 null（没设过密码箱）', () => {
  const b = buildBackup({ ...payload, vault: null }, 1);
  assert.equal(validateBackup(b).ok, true);
});

test('summarizeBackup 给出可读摘要', () => {
  const s = summarizeBackup(buildBackup(payload, 1700000000000));
  assert.equal(s.txns, 1);
  assert.equal(s.accounts, 1);
  assert.equal(s.categories, 1);
  assert.equal(s.hasVault, true);
  assert.equal(s.createdAt, 1700000000000);
});
```

- [ ] **步骤 2：运行测试验证失败**

- [x] **步骤 3：实现 `app/backup.js`**

```js
export const BACKUP_FORMAT = 'pvault-backup';
export const BACKUP_VERSION = 1;

const REQUIRED_ARRAYS = ['txns', 'accounts', 'categories', 'receivables', 'settings'];

export function buildBackup(payload, now = Date.now()) {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: now,
    data: {
      txns: structuredClone(payload.txns ?? []),
      accounts: structuredClone(payload.accounts ?? []),
      categories: structuredClone(payload.categories ?? []),
      receivables: structuredClone(payload.receivables ?? []),
      settings: structuredClone(payload.settings ?? []),
      vault: payload.vault ? structuredClone(payload.vault) : null
    }
  };
}

export function validateBackup(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object') {
    return { ok: false, errors: ['备份文件内容不是有效的对象'] };
  }
  if (obj.format !== BACKUP_FORMAT) {
    errors.push('这不是 pvault 的备份文件');
  }
  if (!Number.isInteger(obj.version)) {
    errors.push('备份文件缺少版本号');
  } else if (obj.version > BACKUP_VERSION) {
    errors.push(`备份文件版本（${obj.version}）高于当前 app 支持的版本（${BACKUP_VERSION}），请先更新 app`);
  }
  for (const key of REQUIRED_ARRAYS) {
    if (!Array.isArray(obj.data?.[key])) errors.push(`备份文件缺少 ${key} 数据或格式不对`);
  }
  return { ok: errors.length === 0, errors };
}

export function summarizeBackup(obj) {
  return {
    createdAt: obj?.createdAt ?? null,
    txns: obj?.data?.txns?.length ?? 0,
    accounts: obj?.data?.accounts?.length ?? 0,
    categories: obj?.data?.categories?.length ?? 0,
    receivables: obj?.data?.receivables?.length ?? 0,
    hasVault: Boolean(obj?.data?.vault)
  };
}
```

> `structuredClone` 在 Node 24 与浏览器里都是全局可用的。

- [x] **步骤 4：运行测试验证通过** → 8 个用例全过

- [x] **步骤 5：Commit**

```bash
git add app/backup.js tests/backup.test.js
git commit -m "feat: 备份包格式（组装、版本校验、摘要）"
```

---

## 阶段 B：存储与解锁

### 任务 5：保险库仓库层 `app/vault-store.js`

**文件：**
- 创建：`app/vault-store.js`
- 修改：`app/schema.js`（种子 settings 增加 `vault` 与 `backupReminderDays`）

> 这一层依赖真实 IndexedDB 与 WebCrypto，**Node 里跑不起来**，所以不写单测，靠探针 + 手动清单（与计划 1 的 `store.js` 同样处理）。

- [ ] **步骤 1：`app/schema.js` 的 `seedSettings()` 增加两项**

```js
    { key: 'vault', value: null },
    { key: 'backupReminderDays', value: 14 }
```

- [x] **步骤 2：实现 `app/vault-store.js`**

要求（完整实现）：

```js
import * as db from './db.js';
import {
  DEFAULT_ITERATIONS, deriveKey, generateDek, wrapDek, unwrapDek,
  encryptJSON, decryptJSON, randomBytes
} from './crypto.js';
import { generateRecoveryCode, decodeRecoveryCode, normalizeRecoveryCode } from './recovery-code.js';

const VAULT_KEY = 'vault';
const IDLE_LIMIT_MS = 5 * 60 * 1000;

let dek = null;              // 只在内存里；空闲超时或锁定时清空
let lastTouched = 0;
let listeners = new Set();
```

**要实现的导出**（签名固定）：

| 函数 | 行为 |
|---|---|
| `isInitialized()` | 读 settings 的 `vault`，非空即已初始化 |
| `initVault(masterPassword)` | 生成 DEK、两个 salt、用主密码 KEK 与**恢复码** KEK 各包裹一份 DEK，保险库初始为空数组；返回 `{ recoveryCode }`（**这是唯一一次能看到恢复码**） |
| `unlock(masterPassword)` | 解出 DEK 存进内存，刷新空闲计时；密码错时抛错 |
| `unlockWithRecoveryCode(code)` | 同上，但用恢复码；成功后**必须提示用户去改主密码**（由 UI 负责提示） |
| `lock()` | 清空内存里的 DEK，通知监听者 |
| `isUnlocked()` | 内存里有 DEK 且未超时 |
| `touch()` | 刷新空闲计时（任何一次读写都会调用） |
| `loadItems()` | 用 DEK 解密 `ciphertext`，返回条目数组；未解锁则抛错 |
| `saveItems(items)` | 用 DEK 加密后写回，**每次新 IV**；刷新 `updatedAt` |
| `changeMasterPassword(newPassword)` | 重新派生 salt 与 KEK、重新包裹同一个 DEK（**不重新加密数据**），旧恢复码**保持不变** |
| `onLockChange(fn)` | 订阅锁定状态变化（UI 用来切回解锁屏） |

**空闲上锁**：一个 30 秒的 `setInterval` 检查 `Date.now() - lastTouched > IDLE_LIMIT_MS`，超时就 `lock()`。

**存储形状**（写进 settings 的 `vault`）：

```js
{
  version: 1,
  kdf: { name: 'PBKDF2-SHA256', iterations: DEFAULT_ITERATIONS },
  saltPassword: '<base64>',
  saltRecovery: '<base64>',
  wrappedDekByPassword: { iv, ct },
  wrappedDekByRecovery: { iv, ct },
  ciphertext: { iv, ct },
  updatedAt: 0
}
```

- [x] **步骤 3：写临时探针验证**（fake IndexedDB 或真实内存实现，跑完删除）

至少断言：
- 初始化后 `isInitialized()` 为 true，且返回的恢复码能被 `unlockWithRecoveryCode` 用上
- 错误主密码 `unlock` 抛错，且**不会**留下半解锁状态
- `unlock` → `saveItems([...])` → `lock()` → `unlock` → `loadItems()` 拿到同样内容
- 改主密码后：旧密码失效、新密码可用、**恢复码仍然可用**
- 空闲超时：把 `lastTouched` 人为拨回 6 分钟前，下一次 `isUnlocked()` 为 false
- 每次 `saveItems` 的 `ciphertext.iv` 都不同

- [x] **步骤 4：Commit**

```bash
git add app/vault-store.js app/schema.js
git commit -m "feat: 保险库仓库层（初始化、解锁、空闲上锁、改主密码）"
```

---

### 任务 6：备份仓库层 `app/backup-store.js`

**文件：**
- 创建：`app/backup-store.js`

> 同样依赖 IndexedDB，不写单测。

- [x] **步骤 1：实现 `app/backup-store.js`**

| 函数 | 行为 |
|---|---|
| `exportBackup(password)` | 从五个仓库读出全部数据 + settings 里的 `vault`；`buildBackup` 组装；用备份密码派生的密钥 `encryptJSON` 整个包；返回 `{ filename, text }`，`text` 是可直接下载的 JSON 字符串 |
| `parseBackupFile(text)` | 解析外层 JSON（`{ format: 'pvault-backup-encrypted', version, kdf, iv, ct }`），返回对象；格式不对时抛明确错误 |
| `importBackup(text, password)` | 解密 → `validateBackup` → **清空并覆盖**五个仓库（`vault` 设置一并恢复）→ 返回 `summarizeBackup` 的结果 |
| `getLastBackupAt()` / `markBackedUp()` | 读写 settings 的 `lastBackupAt` |

**外层加密文件格式**：

```js
{
  format: 'pvault-backup-encrypted',
  version: 1,
  kdf: { name: 'PBKDF2-SHA256', iterations, salt },
  iv, ct
}
```

**导入必须是原子的**：先在内存里把全部数据准备好，然后**在同一个事务里**完成「清空五个仓库 + 写入新数据」。绝不能出现「旧数据已清、新数据没写进去」。

为此给 `app/db.js` **新增**：

```js
// 在单个事务里清空若干仓库并写入若干记录。导入备份时用：
// 「清空」与「写入」必须在同一个事务内，否则中途失败会留下一个空库。
export async function replaceAll({ clears = [], puts = [] }) {
  const db = await open();
  const names = [...new Set([...clears, ...puts.map(e => e.store)])];
  const tx = db.transaction(names, 'readwrite');
  for (const name of clears) tx.objectStore(name).clear();
  for (const e of puts) tx.objectStore(e.store).put(e.value);
  await txDone(tx);
}
```

把原子性封在存储层，调用方就不可能写错。

**导入前先校验**：`validateBackup` 失败就中止，**不要动现有数据**。

- [ ] **步骤 2：探针验证**

- 导出 → 改点数据 → 导入 → 数据回到导出时的状态
- 用错密码导入 → 抛错，且**现有数据一条没变**
- 导入一个格式不对的文件 → 抛错，现有数据不变
- 导出包里包含 `vault`（如果设过密码箱）

- [x] **步骤 3：Commit**

```bash
git add app/backup-store.js app/db.js
git commit -m "feat: 备份导出与导入（整体加密、导入原子覆盖）"
```

---

## 阶段 C：界面

### 任务 7：密码箱主视图（三态）`app/ui/vault-view.js`

**文件：**
- 创建：`app/ui/vault-view.js`
- 修改：`app/main.js`（把 `PLACEHOLDER.vault` 换成它）

**三种状态**：

1. **未初始化** —— 引导页：说明「忘记主密码没有任何找回方式，但有恢复码」→ 设置主密码（输入两次，至少 8 位，不一致或过短时禁用按钮）→ 初始化 → **全屏显示恢复码**，要求用户抄写后勾选「我已抄写并妥善保存」才能继续。这一屏**不允许跳过**。
2. **未解锁** —— 锁屏：一个主密码输入框 + 「解锁」按钮；下面一个折叠的「用恢复码解锁」入口。连续输错 3 次后每次延迟 1 秒（防手滑与轻量防爆破）。用恢复码解锁成功后，**顶部显示一条提示**：「你正在用恢复码访问，建议尽快修改主密码」。
3. **已解锁** —— 列表页（任务 8）。

- [x] 实现后写探针/手动清单，Commit：`feat: 密码箱视图（初始化引导、恢复码、锁屏）`

---

### 任务 8：密码箱列表、详情与搜索

**文件：**
- 修改：`app/ui/vault-view.js`
- 创建：`app/ui/clipboard.js`

- **列表**：顶部搜索框 + 三个分组（网站与 App / 银行卡与证件 / 零散备注），每组标题带数量；空分组不显示。右上角「＋ 新建」。
- **详情**（点条目进入）：逐个字段列出（字段名用 `FIELD_LABELS`），`password` 与 `cvv` 默认用 `maskSecret` 显示，旁边一个「显示/隐藏」按钮；每个字段旁有「复制」。
- **`app/ui/clipboard.js`**：

```js
export async function copyWithAutoClear(text, seconds = 30) {
  await navigator.clipboard.writeText(text);
  setTimeout(async () => {
    try {
      const now = await navigator.clipboard.readText();
      if (now === text) await navigator.clipboard.writeText('');
    } catch {
      // 读不到剪贴板（权限/不支持）时不动它，免得清掉用户后来复制的东西
    }
  }, seconds * 1000);
}
```

> 注意：`navigator.clipboard.readText()` 在部分浏览器需要用户授权，失败时不清理**是刻意的**——宁可不清理，也不要误清用户后来复制的别的东西。

- Commit：`feat: 密码箱列表、详情与复制（30 秒后自动清空剪贴板）`

---

### 任务 9：条目编辑 `app/ui/vault-editor.js`

- 新建/编辑三类条目，字段按 `ITEM_TYPES[type].fields` 动态生成（配合 `FIELD_LABELS`）
- `SECRET_FIELDS` 里的字段用 `type="password"` 且有「显示」切换
- 卡号输入时自动每 4 位插空格（纯显示层，存库时去掉空格）
- 保存前用 `validateItem`，不通过时在表单里逐条列出错误、不关闭面板
- 「删除」按钮（二次确认）

- Commit：`feat: 密码箱条目编辑与删除`

---

### 任务 10：备份界面 `app/ui/backup-view.js`

- **导出**：输入备份密码（两次，可与主密码不同）→ 生成文件 → 用 `URL.createObjectURL` + `<a download>` 触发下载，文件名如 `pvault-backup-2026-09-23.pvault`；成功后 `markBackedUp()`
- **导入**：选文件 → 输入密码 → 解密后**先展示摘要**（多少笔交易、多少个账户、是否含密码箱、备份时间）→ 用户点「确认覆盖」才写入
- **危险提示**：导入按钮旁常驻一句「导入会替换手机上现有的全部数据」
- 顶部显示「上次备份：N 天前」（没备份过显示「从未备份」并标黄）

- Commit：`feat: 备份与恢复界面`

---

### 任务 11：入口与提醒接线

- `app/ui/settings-sheet.js` 加第四行「备份与恢复」→ `openBackupSheet()`
- `app/ui/ledger-home.js`：在首页底部加一行小字「上次备份 N 天前」（超过 `backupReminderDays`（默认 14）变黄并可点击，点击打开备份面板；从未备份时也显示）
- `app/main.js`：`PLACEHOLDER.vault` 换成 `renderVault`；切到 vault Tab 时若未解锁则显示锁屏

- Commit：`feat: 首页备份提醒与设置入口接线`

---

### 任务 12：收尾

- [x] `sw.js` 的 `ASSETS` 补齐所有新文件，并把 `CACHE` 版本号 +1
- [x] `docs/手动验证清单.md` 追加「密码箱」「备份与恢复」两节
- [x] `docs/superpowers/specs/2026-09-23-pvault-design.md`：把 5.4 / 7 / 8 节标记为「已实现」，并按本计划的两处偏离（恢复码长度、空闲上锁）更新
- [ ] 全量测试全绿 + 本地服务器手动过一遍
- [x] Commit：`docs: 密码箱与备份交付收尾`

---

## 自检记录

**规格覆盖度**

| 规格节 | 任务 |
|---|---|
| 5.4 密码箱（解锁、三类条目、搜索、复制、30 秒清剪贴板） | 7、8、9 |
| 7 加密方案（信封加密、PBKDF2、恢复码、密钥只在内存、空闲上锁） | 1、2、5 |
| 8 备份与恢复（单文件整体加密、14 天提醒、恢复流程） | 4、6、10、11 |
| 6 `Settings` 里的 `lockTimeoutMin` / `backupReminderDays` | 5（`backupReminderDays`）；`lockTimeoutMin` 本版用固定 5 分钟，不做成可配置项 |
| 10 节「主密码与恢复码都丢失 → UI 明确警告」 | 7（初始化引导页 + 恢复码确认页） |

**占位符扫描**：任务 7～11 以行为要求描述而非逐行代码，是因为它们的实现方式取决于已建成的 `sheet.js` / `dom.js` 既成模式，逐行写死会与实际不符；但每条要求都给出了**可判定的验收点**（列表分组顺序、空态文案、按钮禁用条件、剪贴板清理的边界），不属于「TODO / 待定」类占位。

**类型一致性**：`dek` 全程是 `Uint8Array(32)`；`{ iv, ct }` 是唯一的密文形状；`wrappedDekByPassword` / `wrappedDekByRecovery` / `ciphertext` 三处都用它；`ITEM_TYPES` 的 key 与 `VaultItem.type` 取值一致（`login` / `card` / `note`）。

**与计划 1 的接口一致性**：复用 `db.putAll` / `db.getAll` / `db.put`（计划 1 已建）；`store.setSetting` / `getSetting` 读写 `vault` 与 `lastBackupAt`；`uid()` 用于条目与备份内新记录。

**收尾时的勾选依据（交付收尾时补记）**

本次收尾只勾「有可核对证据」的步骤：文件在、commit 在、`node --test` 现在通过。下面 7 个复选框**刻意保持未勾**——不代表任务没做，而是**事后无法独立复现**或**实际做法与计划不同**：

| 位置 | 步骤 | 为什么没勾 |
|---|---|---|
| 任务 1～4 各自的「步骤 2：运行测试验证失败」（4 条） | TDD 的失败先行 | 每个 commit 同时引入测试与实现，事后无法从仓库里复现「先失败」的那一刻。四个模块的测试现在全过（crypto 12、recovery-code 11、vault-model 12、backup 8），同一任务的步骤 1 / 3 / 4 / 5 已勾。 |
| 任务 5 步骤 1（`seedSettings()` 增加 `vault` 与 `backupReminderDays`） | 计划要求改种子数据 | **实现换成了别的做法**：`seedSettings()` 仍是 5 条（`tests/schema.test.js` 覆盖了这个数字）；`vault` 行由 `initVault()` 按需写入，`backupReminderDays` 由 `ledger-home.js` 以默认值 14 兜底读取。这个改法反而保住了「没初始化」与「已初始化但为空」在存储层面的区别（种子写 `vault: null` 会让两者长得一样）。 |
| 任务 6 步骤 2（备份仓库层探针验证） | 探针断言：导出→改数据→导入能回滚、错密码不改数据、坏文件不改数据、备份含 vault | 文档里只有备份**界面**层的探针证据（「确认覆盖之前一次写入都没有」），没有这一层这四条断言的记录。本轮不凭空补勾，交给 `docs/手动验证清单.md`「备份与恢复」小节在真机上确认。 |
| 任务 12「全量测试全绿 + 本地服务器手动过一遍」 | 两件事 | 前半句已做到并留证：`node --test --test-isolation=none` → 134/134 全绿；`node scripts/dev-server.js` 起服后逐条请求 `sw.js` 的 42 条 ASSETS → 全部 200。后半句「本地服务器手动过一遍」**没有做**——开发环境里没有浏览器，所有界面交互仍待真机人工验证（见 `docs/手动验证清单.md` 开头的「本次交付的验证状态」）。 |

**与计划文字的一处出入**：`tests/crypto.test.js` 实际有 **12** 个用例（计划任务 1 步骤 4 写的是 11）——多出的一条 `importDek 把原始字节转成可用的密钥` 来自实现中途的补充提交（`1bdfcb4 feat: crypto 补充 importDek`）：仓库层需要把解包得到的原始 DEK 字节升格成 CryptoKey 才能交给 WebCrypto 加解密。其余三个模块的用例数与计划一致（recovery-code 11、vault-model 12、backup 8）。

**交付时的环境事实（收尾核对）**：`sw.js` 的 `CACHE` 为 `pvault-v5`；ASSETS 共 42 条，逐条请求全部 200，且与磁盘上的 41 个运行时文件双向对齐（无漏缓存、无 404 项）；`app/` 下 34 个模块的 85 条静态 import 全部指向已缓存路径，离线时不存在断链。
