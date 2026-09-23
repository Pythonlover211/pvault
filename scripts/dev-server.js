import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.PORT) || 8080;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

// 白名单：只服务应用真正需要的资源。服务器绑在 0.0.0.0（手机同 Wi-Fi 预览），
// 若不做限制，同网段的人能直接读走 docs/ 下的设计规格、tests/ 与 package.json。
const ALLOWED_ROOT_FILES = new Set(['index.html', 'manifest.webmanifest', 'sw.js']);
const ALLOWED_DIRS = new Set(['app', 'styles', 'icons']);

// 抽出可导出的 handler，便于测试用 listen(0) 起临时服务器验证真实行为
export function createHandler(root) {
  return async (req, res) => {
    let rel;
    let filePath;
    try {
      const url = new URL(req.url, 'http://localhost');
      // request-target 以 // 或 /\ 开头时会被解析成 authority（//package.json → host=package.json），
      // pathname 随之变成 '/'，于是白名单检查被跳过、返回首页。这里显式校验 authority，
      // 非 localhost 一律 403，保证"白名单外的东西"永远是 403 而不是 200。
      if (url.host !== 'localhost') {
        res.writeHead(403).end('Forbidden');
        return;
      }
      const urlPath = decodeURIComponent(url.pathname);
      rel = normalize(urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, ''));
      filePath = join(root, rel);
    } catch {
      // 畸形百分号转义（如 /%E4%、/a%b）会抛 URIError；回 400，不能拖垮整个进程
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Bad request');
      return;
    }
    // 按 / 与 \ 切段后比第一段，不做字符串前缀比较——否则 appfoo/ 会被当成 app/
    const segments = rel.split(/[\\/]+/).filter(Boolean);
    // 点开头的路径段（.git/、.gitignore…）一律拒绝，避免局域网预览时被拖走仓库元数据
    if (segments.some(seg => seg.startsWith('.'))) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    // 白名单之外一律 403：docs/、tests/、scripts/、package.json 等都不该被局域网取走。
    // 白名单内的 icons/、manifest.webmanifest、sw.js 尚未创建时走 404，符合预期。
    if (!ALLOWED_DIRS.has(segments[0]) && !(segments.length === 1 && ALLOWED_ROOT_FILES.has(segments[0]))) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    if (!filePath.startsWith(root.endsWith(sep) ? root : root + sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    try {
      const body = await readFile(filePath);
      res.writeHead(200, {
        'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
        'Service-Worker-Allowed': '/'
      });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
    }
  };
}

// 仅在直接运行（node scripts/dev-server.js）时监听；被测试 import 时不监听。
// Server 与监听一起放在这个分支里：被 import 时不该凭空构造一个永不 listen 的对象。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createServer(createHandler(ROOT));

  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      console.error(`端口 ${PORT} 已被占用。关闭占用进程，或换个端口：`);
      console.error(`  PowerShell:  $env:PORT=8081; node scripts/dev-server.js`);
    } else {
      console.error('开发服务器启动失败:', err.message);
    }
    process.exit(1);
  });

  server.listen(PORT, () => {
    console.log(`pvault dev server: http://localhost:${PORT}`);
    const lan = Object.values(networkInterfaces()).flat()
      .filter(i => i && i.family === 'IPv4' && !i.internal)
      .map(i => i.address);
    for (const ip of lan) console.log(`  手机访问:   http://${ip}:${PORT}`);
  });
}
