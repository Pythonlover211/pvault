import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, decodeBytes, stripBom } from '../app/csv.js';

test('parseCsv 解析基本表格', () => {
  const rows = parseCsv('a,b,c\n1,2,3\n');
  assert.deepEqual(rows, [['a', 'b', 'c'], ['1', '2', '3']]);
});

test('parseCsv 处理 CRLF', () => {
  assert.deepEqual(parseCsv('a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']]);
});

test('parseCsv 处理引号包裹的字段（含逗号）', () => {
  assert.deepEqual(parseCsv('"a,1",b'), [['a,1', 'b']]);
});

test('parseCsv 处理引号内的换行', () => {
  assert.deepEqual(parseCsv('"第一行\n第二行",b'), [['第一行\n第二行', 'b']]);
});

test('parseCsv 处理双引号转义', () => {
  assert.deepEqual(parseCsv('"他说""你好""",b'), [['他说"你好"', 'b']]);
});

test('parseCsv 保留空字段与尾随空列', () => {
  assert.deepEqual(parseCsv('a,,c'), [['a', '', 'c']]);
  assert.deepEqual(parseCsv('a,b,'), [['a', 'b', '']]);
});

test('parseCsv 跳过完全空白的行', () => {
  assert.deepEqual(parseCsv('a,b\n\n1,2\n'), [['a', 'b'], ['1', '2']]);
});

test('parseCsv 去掉开头的 BOM', () => {
  assert.deepEqual(parseCsv('\uFEFFa,b'), [['a', 'b']]);
});

test('stripBom 只去开头那一个', () => {
  assert.equal(stripBom('\uFEFFa\uFEFFb'), 'a\uFEFFb');
});

test('decodeBytes：UTF-8 字节正常解出中文', () => {
  const bytes = new TextEncoder().encode('交易时间,金额\n2026-09-23,12.34\n');
  assert.match(decodeBytes(bytes), /交易时间/);
});

test('decodeBytes：GBK 字节回退解出中文', () => {
  // "中文" 的 GBK 编码是 D6 D0 CE C4（GB2312 兼容区）
  const bytes = new Uint8Array([0xD6, 0xD0, 0xCE, 0xC4]);
  assert.equal(decodeBytes(bytes), '中文');
});

test('decodeBytes：UTF-8 BOM 也认', () => {
  const bytes = new Uint8Array([0xEF, 0xBB, 0xBF, 0x61]);
  assert.equal(decodeBytes(bytes), 'a');
});
