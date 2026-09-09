import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, relative, resolve } from 'node:path';

import { isLiveEvent } from './live-events';
import { LiveRunStore } from './live-run-store';

const contentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.zip': 'application/zip'
};

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  response.end(JSON.stringify(value));
}

function safeFile(root: string, requestPath: string): string | undefined {
  const normalizedRoot = resolve(root);
  const candidate = resolve(normalizedRoot, requestPath.replace(/^[/\\]+/, ''));
  const relation = relative(normalizedRoot, candidate);
  if (relation.startsWith('..') || relation.includes(':')) return undefined;
  return candidate;
}

function serveFile(response: ServerResponse, filePath: string): void {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }
  response.writeHead(200, {
    'content-type': contentTypes[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': 'no-store'
  });
  response.end(readFileSync(filePath));
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 1_048_576) throw new Error('Live event payload exceeds 1 MB.');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

export type LiveServerHandle = {
  url: string;
  close(): Promise<void>;
};

export async function startLiveServer(input: {
  store: LiveRunStore;
  host?: string;
  port?: number;
}): Promise<LiveServerHandle> {
  const host = input.host ?? '127.0.0.1';
  const dashboardRoot = resolve('live-dashboard');
  const businessReportRoot = resolve('reports/business');
  const playwrightReportRoot = resolve('playwright-report');
  const liveReportRoot = resolve('reports/live');
  const journeyReportRoot = resolve('reports/journey');
  const clients = new Set<ServerResponse>();
  let persistenceWarningShown = false;

  const persistSnapshot = (): void => {
    try {
      mkdirSync(liveReportRoot, { recursive: true });
      writeFileSync(
        resolve(liveReportRoot, 'latest.json'),
        JSON.stringify(input.store.snapshot(), null, 2),
        'utf8'
      );
    } catch {
      if (!persistenceWarningShown) {
        persistenceWarningShown = true;
        console.warn('Live Monitor快照无法写入磁盘；Playwright将继续执行。');
      }
    }
  };

  const unsubscribe = input.store.subscribe(snapshot => {
    persistSnapshot();
    const message = `event: state\ndata: ${JSON.stringify(snapshot)}\n\n`;
    for (const client of clients) {
      try {
        client.write(message);
      } catch {
        clients.delete(client);
      }
    }
  });

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', `http://${host}`);
      if (request.method === 'GET' && url.pathname === '/health') {
        sendJson(response, 200, { ok: true });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/state') {
        sendJson(response, 200, input.store.snapshot());
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/events') {
        const body = await readJsonBody(request);
        if (!isLiveEvent(body)) {
          sendJson(response, 400, { error: 'Invalid live event.' });
          return;
        }
        input.store.apply(body);
        response.writeHead(204);
        response.end();
        return;
      }
      if (request.method === 'GET' && url.pathname === '/events') {
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive'
        });
        response.write(`event: state\ndata: ${JSON.stringify(input.store.snapshot())}\n\n`);
        clients.add(response);
        request.once('close', () => clients.delete(response));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/reports/business/latest') {
        serveFile(response, resolve(businessReportRoot, 'latest.html'));
        return;
      }
      if (request.method === 'GET' && url.pathname.startsWith('/reports/business/history/')) {
        const tail = url.pathname.slice('/reports/business/history/'.length) || 'index.html';
        const file = safeFile(resolve(businessReportRoot, 'history'), tail);
        if (!file) return void sendJson(response, 400, { error: 'Invalid report path.' });
        serveFile(response, file);
        return;
      }
      if (request.method === 'GET' && url.pathname.startsWith('/reports/playwright/')) {
        const tail = url.pathname.slice('/reports/playwright/'.length) || 'index.html';
        const file = safeFile(playwrightReportRoot, tail);
        if (!file) return void sendJson(response, 400, { error: 'Invalid report path.' });
        serveFile(response, file);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/reports/journey/latest') {
        serveFile(response, resolve(journeyReportRoot, 'latest.html'));
        return;
      }
      if (request.method === 'GET' && url.pathname.startsWith('/reports/journey/history/')) {
        const tail = url.pathname.slice('/reports/journey/history/'.length) || 'index.html';
        const file = safeFile(resolve(journeyReportRoot, 'history'), tail);
        if (!file) return void sendJson(response, 400, { error: 'Invalid report path.' });
        serveFile(response, file);
        return;
      }
      if (request.method === 'GET') {
        const dashboardPath = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const file = safeFile(dashboardRoot, dashboardPath);
        if (!file) return void sendJson(response, 400, { error: 'Invalid dashboard path.' });
        serveFile(response, file);
        return;
      }
      response.writeHead(405, { allow: 'GET, POST' });
      response.end();
    } catch (error) {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : 'Live Monitor request failed.'
      });
    }
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(input.port ?? 0, host, () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Live Monitor did not bind a TCP port.');
  persistSnapshot();

  return {
    url: `http://${host}:${address.port}`,
    close: () => new Promise<void>((resolveClose, reject) => {
      unsubscribe();
      for (const client of clients) client.end();
      server.close(error => error ? reject(error) : resolveClose());
    })
  };
}
