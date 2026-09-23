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
