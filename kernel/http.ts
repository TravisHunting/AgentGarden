// Local HTTP server: static client (TypeScript stripped on the fly), JSON API
// and a Server-Sent Events stream. Binds to loopback only and rejects
// cross-origin requests so web pages can't drive the garden (or the agent).

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';

export type Handler = (req: IncomingMessage, body: unknown, params: string[]) => unknown | Promise<unknown>;

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export class App {
  private routes: Route[] = [];
  private sse = new Set<ServerResponse>();
  private webRoot: string;
  private port = 0;
  private tsCache = new Map<string, { mtime: number; code: string }>();
  private mounts: { pattern: RegExp; dir: () => string; allow: RegExp }[] = [];

  constructor(webRoot: string) {
    this.webRoot = webRoot;
  }

  /**
   * Serves files from a directory chosen at request time. `pattern` must capture the path
   * inside that directory; `allow` restricts which inner paths may be served.
   */
  mount(pattern: RegExp, dir: () => string, allow: RegExp): void {
    this.mounts.push({ pattern, dir, allow });
  }

  on(method: string, path: string, handler: Handler): void {
    const pattern = new RegExp(`^${path.replace(/:[a-z]+/g, '([^/]+)')}$`);
    this.routes.push({ method, pattern, handler });
  }

  broadcast(event: string, data: unknown): void {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.sse) res.write(msg);
  }

  get clients(): number {
    return this.sse.size;
  }

  listen(port: number, host = '127.0.0.1'): Promise<void> {
    this.port = port;
    const server = createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        const status = e instanceof HttpError ? e.status : 500;
        if (status === 500) console.error(e);
        if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: (e as Error).message }));
      });
    });
    return new Promise((resolve) => server.listen(port, host, resolve));
  }

  private checkOrigin(req: IncomingMessage): void {
    const host = req.headers.host ?? '';
    const allowedHosts = [`127.0.0.1:${this.port}`, `localhost:${this.port}`, `[::1]:${this.port}`];
    if (!allowedHosts.includes(host)) throw new HttpError(403, 'unexpected Host header');
    const origin = req.headers.origin;
    if (origin && !allowedHosts.some((h) => origin === `http://${h}`)) throw new HttpError(403, 'cross-origin request refused');
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.checkOrigin(req);
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/api/stream') return this.openStream(res);
    if (url.pathname.startsWith('/api/')) {
      for (const r of this.routes) {
        if (r.method !== req.method) continue;
        const m = r.pattern.exec(url.pathname);
        if (!m) continue;
        const body = req.method === 'GET' ? undefined : await readBody(req);
        const result = await r.handler(req, body, m.slice(1).map(decodeURIComponent));
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(result ?? { ok: true }));
        return;
      }
      throw new HttpError(404, 'no such endpoint');
    }
    for (const m of this.mounts) {
      const match = m.pattern.exec(url.pathname);
      if (!match) continue;
      const inner = decodeURIComponent(match[1]);
      if (!m.allow.test(inner)) throw new HttpError(404, 'not found');
      return this.serveFile(m.dir(), inner, res);
    }
    return this.serveFile(this.webRoot, url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, ''), res);
  }

  private openStream(res: ServerResponse): void {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    this.sse.add(res);
    res.on('close', () => this.sse.delete(res));
    this.onConnect?.(res);
  }

  onConnect?: (res: ServerResponse) => void;

  send(res: ServerResponse, event: string, data: unknown): void {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private async serveFile(root: string, rel: string, res: ServerResponse): Promise<void> {
    const file = normalize(join(root, rel));
    if (!file.startsWith(root + sep)) throw new HttpError(403, 'forbidden');
    const ext = extname(file);
    let body: string | Buffer;
    try {
      body = await readFile(file);
    } catch {
      throw new HttpError(404, 'not found');
    }
    if (ext === '.ts') {
      try {
        body = this.stripTs(file, body.toString('utf8'));
      } catch (e) {
        throw new HttpError(500, `could not strip types from ${rel}: ${(e as Error).message.split('\n')[0]}`);
      }
    }
    res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(body);
  }

  private stripTs(file: string, source: string): string {
    const cached = this.tsCache.get(file);
    const key = source.length ^ hash(source);
    if (cached?.mtime === key) return cached.code;
    const code = stripTypeScriptTypes(source, { mode: 'strip' });
    this.tsCache.set(file, { mtime: key, code });
    return code;
  }
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 256_000) throw new HttpError(413, 'request too large');
    chunks.push(chunk as Buffer);
  }
  if (!size) return undefined;
  if (!(req.headers['content-type'] ?? '').includes('application/json')) throw new HttpError(415, 'expected application/json');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}
