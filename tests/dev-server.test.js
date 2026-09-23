import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createHandler } from '../scripts/dev-server.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
let server, base;

before(async () => {
  server = createServer(createHandler(ROOT));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise(r => server.close(r)));

// 实测结论：undici 与 Node 的 URL 都不把 %2f 当路径分隔符，`..%2f` 会原样到达服务器，
// 所以 fetch 和原始 path 都能打到同一个路径。即便如此，穿越类用例仍以 rawRequest 发原始
// path 作为权威断言——它不依赖客户端 URL 预处理的实现细节，测的就是服务器的真实行为。
function rawRequest(path) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: server.address().port, path, method: 'GET' },
      res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

test('根路径返回 index.html', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<div id="app"/);
});

test('不存在的文件返回 404', async () => {
  const res = await fetch(base + '/nope.js');
  assert.equal(res.status, 404);
});

test('路径穿越请求返回 403', async () => {
  // 确认客户端不会替我们提前规范化掉这一次的穿越形态
  const normalized = new URL(base + '/..%2fpackage.json');
  assert.equal(normalized.pathname, '/..%2fpackage.json');

  const raw = await rawRequest('/..%2fpackage.json');
  assert.equal(raw.status, 403);

  // 同样的路径走 fetch 一次，确认浏览器语义下结论一致
  const viaFetch = await fetch(base + '/..%2fpackage.json');
  assert.equal(viaFetch.status, 403);
});

test('畸形百分号转义返回 400 且服务器仍然存活', async () => {
  const bad = await rawRequest('/%E4%');
  assert.equal(bad.status, 400);

  const badViaFetch = await fetch(base + '/a%b');
  assert.equal(badViaFetch.status, 400);

  // K1 回归：崩掉的服务器在这里会连接被拒，而不是 200
  const alive = await fetch(base + '/');
  assert.equal(alive.status, 200);
  assert.match(await alive.text(), /<div id="app"/);
});

test('点开头的路径段返回 403', async () => {
  const res = await fetch(base + '/.gitignore');
  assert.equal(res.status, 403);
});
