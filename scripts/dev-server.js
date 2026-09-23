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

// 抽出可导出的 handler，便于测试用 listen(0) 起临时服务器验证真实行为
export function createHandler(root) {
  return async (req, res) => {
    let rel;
    let filePath;
    try {
      const { pathname } = new URL(req.url, 'http://localhost');
      const urlPath = decodeURIComponent(pathname);
      rel = normalize(urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, ''));
      filePath = join(root, rel);
    } catch {
      // 畸形百分号转义（如 /%E4%、/a%b）会抛 URIError；回 400，不能拖垮整个进程
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Bad request');
      return;
    }
    // 点开头的路径段（.git/、.gitignore…）一律拒绝，避免局域网预览时被拖走仓库元数据
    if (rel.split(/[\\/]/).some(seg => seg.startsWith('.'))) {
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

const server = createServer(createHandler(ROOT));

// 仅在直接运行（node scripts/dev-server.js）时监听；被测试 import 时不监听
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
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
