import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKeypadState, pressKey, keypadText, keypadCents } from '../app/keypad-model.js';

const type = (keys, state = createKeypadState()) =>
  keys.split('').reduce((s, k) => pressKey(s, k), state);

test('初始状态为空', () => {
  assert.equal(keypadText(createKeypadState()), '');
  assert.equal(keypadCents(createKeypadState()), null);
});

test('输入数字拼接', () => {
  assert.equal(keypadText(type('123')), '123');
  assert.equal(keypadCents(type('123')), 12300);
});

test('最多一个小数点', () => {
  assert.equal(keypadText(type('1.2.3')), '1.23');
});

test('小数位最多两位', () => {
  assert.equal(keypadText(type('1.239')), '1.23');
  assert.equal(keypadCents(type('1.23')), 123);
});

test('前导零被替换而不是堆叠', () => {
  assert.equal(keypadText(type('005')), '5');
  assert.equal(keypadText(type('0.5')), '0.5');
});

test('整数位最多 9 位', () => {
  assert.equal(keypadText(type('12345678901')), '123456789');
});

test('退格删除末位', () => {
  assert.equal(keypadText(pressKey(type('123'), 'back')), '12');
  assert.equal(keypadText(pressKey(createKeypadState(), 'back')), '');
});

test('清空', () => {
  assert.equal(keypadText(pressKey(type('123.45'), 'clear')), '');
});

test('单字符 0 的金额为 0 而不是 null', () => {
  assert.equal(keypadCents(type('0')), 0);
});

test('pressKey 不修改原状态', () => {
  const s = createKeypadState();
  const s2 = pressKey(s, '5');
  assert.equal(keypadText(s), '');
  assert.equal(keypadText(s2), '5');
});
