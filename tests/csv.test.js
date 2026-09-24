import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, decodeBytes, stripBom, UNCLOSED_QUOTE_CODE, UTF16_CODE } from '../app/csv.js';

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

test('parseCsv：未闭合的引号抛错，而不是吞掉文件余下所有行', () => {
  // 真实形态：5000 行的账单里第 2 行金额多打了一个引号（`1.00 "`）。修复前这里只返回
  // 2 行、第 2 行第 2 格有 12 万字符，预览页却说「将导入 1 条」，其余 4999 行无声消失。
  const rows = ['时间,金额', '2026-09-01 12:30:00,1.00 "', '2026-09-02 12:30:00,2.00', '2026-09-03 12:30:00,3.00'];
  assert.throws(() => parseCsv(rows.join('\n')), err => {
    assert.equal(err.code, UNCLOSED_QUOTE_CODE);
    // 错误信息要人能看懂：指出大概的行号，而不是抛一个英文异常
    assert.match(err.message, /第 2 行/);
    return true;
  });
});

test('decodeBytes：UTF-16LE 的文件给出「另存为 CSV UTF-8」的指引', () => {
  // Excel 的「Unicode 文本」导出就是 FF FE + UTF-16LE。不认它就会回落 GBK 解出一串
  // 乱码，用户看到的是几千条「时间无法识别」，根本猜不到问题在编码上。
  const bytes = new Uint8Array([0xFF, 0xFE, 0x31, 0x00, 0x2C, 0x00]);
  assert.throws(() => decodeBytes(bytes), err => {
    assert.equal(err.code, UTF16_CODE);
    assert.match(err.message, /UTF-16/);
    assert.match(err.message, /CSV UTF-8/);
    return true;
  });
});

test('decodeBytes：UTF-16BE 的 BOM 同样拦下', () => {
  assert.throws(() => decodeBytes(new Uint8Array([0xFE, 0xFF, 0x00, 0x31])), err => {
    assert.equal(err.code, UTF16_CODE);
    return true;
  });
});
