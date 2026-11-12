// Запуск на Node: обычный http-сервер переводит запрос в стандартный Request, отдаёт его app.js и пересылает Response обратно,
// поток (уроки идут потоком минуту и дольше) — кусками, по мере прихода.
import http from 'node:http';
import { handle } from './app.js';

const PORT = Number(process.env.PORT) || 10000;
const MAX_BODY = 2 * 1024 * 1024;

const server = http.createServer(async (req, res) => {
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableFinished) controller.abort(); });
  try {
    const chunks = [];
    let size = 0;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY) { res.writeHead(413).end(); return; }
        chunks.push(chunk);
      }
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) value.forEach((v) => headers.append(name, v));
      else if (value !== undefined) headers.set(name, value);
    }
    const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
    const url = `${proto}://${req.headers.host || 'localhost'}${req.url}`;
    const request = new Request(url, {
      method: req.method,
      headers,
      body: chunks.length ? Buffer.concat(chunks) : undefined,
      signal: controller.signal,
    });

    const response = await handle(request, req.socket.remoteAddress);
    const outHeaders = {};
    response.headers.forEach((value, name) => { outHeaders[name] = value; });
    res.writeHead(response.status, outHeaders);
    if (!response.body || req.method === 'HEAD') { res.end(); return; }
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(value)) await new Promise((resolve) => res.once('drain', resolve));
        if (controller.signal.aborted) break;
      }
    } finally {
      reader.cancel().catch(() => {});
    }
    res.end();
  } catch (err) {
    console.error('[server]', err?.stack || err);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Ошибка сервера' }));
  }
});

// Ответ урока потоком длится минуту и дольше: снимаем стандартные таймауты Node, чтобы они не рвали его.
server.requestTimeout = 0;
server.headersTimeout = 65000;
server.keepAliveTimeout = 65000;
server.listen(PORT, () => console.log(`Хочу всё знать: сервер слушает порт ${PORT}`));
