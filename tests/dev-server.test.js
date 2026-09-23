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
// 注意 req.setTimeout：K1 回归（handler 抛异常落不到 catch）会让服务器永远不回响应，
// 没有这道超时，Promise 永不 settle，而 node:test 默认没有 per-test 超时 → 整个测试运行挂死。
// 回归保护必须"给红"，不能"挂死"，所以这里对请求本身加硬超时。
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
    req.setTimeout(2000, () => req.destroy(new Error(`rawRequest 超时（服务器 2s 内无响应）: ${path}`)));
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
  // 白名单外的路径一律 403，所以 404 只能在白名单内验证（见下面白名单目录那条用例）
  const res = await fetch(base + '/app/nope.js');
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

// 5s 用例级超时：这条用例是 K1（handler 抛异常拖垮请求）的回归保护，
// 回归发生时必须在几秒内失败，而不是让整个运行挂住。
test('畸形百分号转义返回 400 且服务器仍然存活', { timeout: 5000 }, async () => {
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

  // I2 的原始诉求里点名的是 .git/：仓库元数据不能被局域网取走，两者同等对待
  assert.equal((await rawRequest('/.git/HEAD')).status, 403);
  assert.equal((await fetch(base + '/.git/HEAD')).status, 403);
});

// 服务器绑 0.0.0.0 是为了手机同 Wi-Fi 预览，所以白名单不是可选项：
// 同网段的人不得读走设计规格、测试与仓库元数据。
test('白名单外的仓库文件返回 403', async () => {
  const doc = await fetch(base + '/docs/superpowers/plans/2026-09-23-pvault-ledger.md');
  assert.equal(doc.status, 403);
  assert.match(await doc.text(), /Forbidden/);

  assert.equal((await fetch(base + '/package.json')).status, 403);
  assert.equal((await fetch(base + '/scripts/dev-server.js')).status, 403);
  assert.equal((await fetch(base + '/tests/dev-server.test.js')).status, 403);

  // 白名单外 + 根目录里根本不存在这个文件：结论仍是 403。
  // 白名单判断先于"文件在不在"，不能靠 404/403 的差别探测仓库里有什么。
  assert.equal((await fetch(base + '/nope.js')).status, 403);
});

test('以 // 或 /\\ 开头、被解析成 authority 的 target 返回 403', async () => {
  // new URL('//package.json', 'http://localhost') 的 host 是 package.json、pathname 是 '/'：
  // 只看 pathname 就会跳过白名单，把首页当 //package.json 返回 200。这里断言 403。
  assert.equal((await rawRequest('//package.json')).status, 403);
  assert.equal((await rawRequest('///package.json')).status, 403);
  // special URL 里反斜杠等价于斜杠，/\package.json 同样会变成 authority
  assert.equal((await rawRequest('/\\package.json')).status, 403);

  // 浏览器语义下结论一致
  assert.equal((await fetch(base + '//package.json')).status, 403);

  // 注：/?/package.json 的 ? 之后是 query，pathname 本来就是 '/'，
  // 返回首页属于正常 HTTP 语义而非绕过白名单，因此这里不要求 403。
});

test('白名单内应用资源仍可访问', async () => {
  const main = await fetch(base + '/app/main.js');
  assert.equal(main.status, 200);
  assert.match(main.headers.get('content-type'), /text\/javascript/);

  const css = await fetch(base + '/styles/base.css');
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);
});

test('白名单目录做整段比较，不走前缀匹配', async () => {
  // appfoo/ 不能因为以 "app" 开头就绕过白名单
  assert.equal((await fetch(base + '/appfoo/secret.txt')).status, 403);
  // app/ 下多级路径仍然允许（读不到就是 404，而不是 403）
  assert.equal((await fetch(base + '/app/xyz/nope.js')).status, 404);
});

test('白名单内尚未创建的文件返回 404 而不是 403', async () => {
  // icons/、manifest.webmanifest、sw.js 属于任务 20，此刻不存在但仍应可达路径
  assert.equal((await fetch(base + '/manifest.webmanifest')).status, 404);
  assert.equal((await fetch(base + '/icons/icon-192.png')).status, 404);
});
