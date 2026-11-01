import { resolve, sep } from 'node:path';
import { realpath } from 'node:fs/promises';
import { Core, EventFeed, type RPC } from './core';
import { Store, Failure, invalid, unauthorized } from './security';
import { Snapshot, terminal } from './state';

type SocketData = { token: string; deviceId: string; watch?: string; busy?: boolean; revision?: number };
const keys = new Set(['shift+tab','esc','up','down','enter','ctrl+c','backspace','tab','left','right','delete','home','end']);
export function validateKeys(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 4096 || value.some(k => typeof k !== 'string' || (!keys.has(k) && (Array.from(k).length !== 1 || /[\p{Cc}\p{Cs}]/u.test(k))))) throw invalid();
  return value;
}
export function inputKeys(text: unknown) {
  if (typeof text !== 'string') throw invalid();
  if (Buffer.byteLength(text) > 4096) throw new Failure(413, 'too_large', 'Input is too large.');
  const map: Record<string,string> = { '\r': 'enter', '\n': 'enter', '\t': 'tab', '\x1b': 'esc', '\b': 'backspace', '\x7f': 'backspace', '\x03': 'ctrl+c' };
  return validateKeys(Array.from(text.replace(/\r\n/g, '\n'), c => map[c] || c));
}
export function start(options: { port?: number; origin?: string; core?: RPC; store?: Store; staticDir?: string } = {}) {
  const port = options.port ?? Number(process.env.HERDR_PHONE_PORT || 8790);
  const origin = options.origin || process.env.HERDR_PHONE_ORIGIN || `http://127.0.0.1:${port}`;
  if (new URL(origin).origin !== origin) throw new Error('Configure an exact origin');
  const core = options.core || new Core(), store = options.store || new Store(), state = new Snapshot(core);
  const sockets = new Set<any>(), queues = new Map<string, Promise<any>>();
  const root = resolve(options.staticDir || process.env.HERDR_PHONE_STATIC_DIR || 'web/dist');
  const json = (body: any, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  const error = (e: any) => json({ error: { code: e instanceof Failure ? e.code : 'core_unavailable', message: e instanceof Failure ? e.message : 'Core unavailable.' } }, e instanceof Failure ? e.status : 503);
  const auth = (req: Request) => store.auth(req.headers.get('Authorization')?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1] || null);
  async function body(req: Request) {
    if (!req.headers.get('content-type')?.startsWith('application/json')) throw invalid();
    if (Number(req.headers.get('content-length')) > 32768) throw new Failure(413, 'too_large', 'Request is too large.');
    const reader = req.body?.getReader(); if (!reader) throw invalid();
    let size = 0; const parts = [];
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 32768) { await reader.cancel(); throw new Failure(413, 'too_large', 'Request is too large.'); } parts.push(value); }
    try { return JSON.parse(Buffer.concat(parts).toString()); } catch { throw invalid(); }
  }
  function serial(id: string, action: () => Promise<any>) {
    const previous = queues.get(id) || Promise.resolve();
    const next = previous.catch(() => {}).then(action); queues.set(id, next);
    void next.finally(() => { if (queues.get(id) === next) queues.delete(id); }).catch(() => {}); return next;
  }
  async function screen(id: string) {
    const [t, read] = await Promise.all([core.call('terminal.get', { terminal: id }), core.call('terminal.read', { terminal: id, lines: 0 })]);
    return { terminal: terminal(t), text: read.text, complete: read.complete };
  }
  const server = Bun.serve<SocketData>({
    hostname: '127.0.0.1', port, maxRequestBodySize: 32768,
    async fetch(req, srv) {
      try {
        const url = new URL(req.url), path = url.pathname;
        const requestOrigin = req.headers.get('origin');
        if (requestOrigin && requestOrigin !== origin) throw new Failure(401, 'origin_rejected', 'Origin rejected.');
        if (path.startsWith('/api/') && url.search) throw invalid();
        if (path === '/api/health' && req.method === 'GET') {
          try { await core.call('hello', { generation: 1 }); return json({ ok: true, version: '1', core: 'connected' }); }
          catch { return json({ ok: false, version: '1', core: 'disconnected' }, 503); }
        }
        if (path === '/api/pair' && req.method === 'POST') { const b = await body(req); return json(await store.exchange(b.code, b.label), 201); }
        if (path === '/api/ws') {
          if (requestOrigin !== origin) throw unauthorized();
          const protocols = (req.headers.get('sec-websocket-protocol') || '').split(',').map(s => s.trim());
          const credentials = protocols.filter(s => s.startsWith('auth.'));
          if (!protocols.includes('herdr-phone.v1') || credentials.length !== 1) throw unauthorized();
          const token = credentials[0].slice(5), device = await store.auth(token);
          if (srv.upgrade(req, { data: { token, deviceId: device.id }, headers: { 'Sec-WebSocket-Protocol': 'herdr-phone.v1' } })) return;
          throw invalid();
        }
        if (path.startsWith('/api/')) {
          const device = await auth(req);
          if (path === '/api/device' && req.method === 'GET') return json({ device });
          if (path === '/api/device' && req.method === 'DELETE') {
            await store.revoke(device.id); for (const ws of sockets) if (ws.data.deviceId === device.id) ws.close(4001, 'Device revoked'); return new Response(null, { status: 204 });
          }
          if (path === '/api/state' && req.method === 'GET') return json(await state.get());
          const match = path.match(/^\/api\/terminals\/([^/]+)\/(screen|input|keys|send)$/);
          if (match) {
            let id; try { id = decodeURIComponent(match[1]); } catch { throw invalid(); }
            if (!/^(?:[A-Za-z0-9_.-]+\/)?t[a-zA-Z0-9]+$/.test(id)) throw invalid();
            if (match[2] === 'screen' && req.method === 'GET') return json(await screen(id));
            if (req.method === 'POST' && match[2] !== 'screen') {
              const b = await body(req);
              if (match[2] === 'send') {
                if (typeof b.text !== 'string' || Buffer.byteLength(b.text) > 4096) throw invalid();
                await serial(id, () => core.call('terminal.send', { terminal: id, text: b.text }));
              } else { const input = match[2] === 'keys' ? validateKeys(b.keys) : inputKeys(b.text); await serial(id, () => core.call('terminal.keys', { terminal: id, keys: input })); }
              return json({ ok: true });
            }
          }
          throw new Failure(404, 'not_found', 'Resource not found.');
        }
        if (!['GET','HEAD'].includes(req.method)) throw new Failure(404, 'not_found', 'Resource not found.');
        let name; try { name = decodeURIComponent(path); } catch { throw invalid(); }
        if (name.includes('\0') || name.split('/').some(p => p.startsWith('.'))) throw invalid();
        const candidate = resolve(root, '.' + (name === '/' ? '/index.html' : name));
        const actual = await realpath(candidate).catch(() => '');
        if (!actual.startsWith(root + sep)) throw new Failure(404, 'not_found', 'Resource not found.');
        const file = Bun.file(actual);
        if (!await file.exists()) throw new Failure(404, 'not_found', 'Resource not found.');
        return new Response(req.method === 'HEAD' ? null : file, { headers: { 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; frame-ancestors 'none'", 'Referrer-Policy': 'no-referrer' } });
      } catch (e) { return error(e); }
    },
    websocket: {
      maxPayloadLength: 2048, backpressureLimit: 256 * 1024, closeOnBackpressureLimit: true,
      open(ws) { sockets.add(ws); void tick(ws); },
      async message(ws, raw) {
        try {
          await store.auth(ws.data.token);
          const msg = JSON.parse(String(raw));
          if (msg.type === 'unwatch') { ws.data.watch = undefined; return; }
          if (msg.type !== 'watch' || typeof msg.terminalId !== 'string' || !/^(?:[A-Za-z0-9_.-]+\/)?t[a-zA-Z0-9]+$/.test(msg.terminalId)) throw invalid();
          ws.data.watch = msg.terminalId; void tick(ws);
        } catch (e) { ws.send(JSON.stringify({ type: 'error', code: 'invalid_request', message: 'Request rejected.' })); }
      },
      close(ws) { sockets.delete(ws); }
    }
  });
  async function tick(ws: any) {
    if (ws.data.busy) return; ws.data.busy = true;
    try {
      await store.auth(ws.data.token);
      const snapshot = await state.get();
      ws.send(JSON.stringify({ type: 'connection', connected: true }));
      if (ws.data.revision !== snapshot.revision) { ws.send(JSON.stringify({ type: 'state', state: snapshot })); ws.data.revision = snapshot.revision; }
      const id = ws.data.watch;
      if (id) { const s = await screen(id); if (ws.data.watch === id) ws.send(JSON.stringify({ type: 'screen', terminalId: id, cols: s.terminal.cols, rows: s.terminal.rows, text: s.text })); }
    } catch (e) {
      if (e instanceof Failure && e.status === 401) ws.close(4001, 'Device revoked');
      else ws.send(JSON.stringify({ type: 'connection', connected: false }));
    } finally { ws.data.busy = false; }
  }
  const events = core instanceof Core ? new EventFeed(() => { state.at = 0; }, () => { state.at = 0; for (const ws of sockets) ws.send(JSON.stringify({ type: 'connection', connected: false })); }) : undefined;
  const interval = setInterval(() => { for (const ws of sockets) void tick(ws); }, 750);
  return { server, state, store, core, stop() { events?.close(); clearInterval(interval); for (const ws of sockets) ws.close(); server.stop(true); if (core instanceof Core) core.close(); } };
}
if (import.meta.main) { const app = start(); console.log(`Bridge listening on loopback port ${app.server.port}`); }
