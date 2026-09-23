import { randomBytes } from './crypto.js';

// Crockford Base32：去掉视觉易混的 I L O U
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
// 20 字节 = 160 位熵，恰好编成 32 个字符（160 ÷ 5 = 32，无残留位）
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
