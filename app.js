// Сервер «Хочу всё знать» для Render (Node): тот же learn-worker.js, что работает на Cloudflare (mindmaper.site), с тонкой обвязкой.
// Страница лежит на Firebase Hosting (learn.mindmaper.site) и ходит сюда по адресу <этот сервис>/api/learn/… (см. ../make.js).
// Раньше этот же сервер жил на Deno Deploy (папка ../deno); Deno Deploy закрывается в апреле 2027, перенесено 13.11.2026.
//
// Переменные окружения (задаёт владелец в Render → сервис → Environment):
//   FIREBASE_SERVICE_ACCOUNT — JSON сервисного аккаунта Firebase целиком (аккаунты, сессии, счётчики — в Firestore, коллекция kv)
//   DEEPSEEK_API_KEY  — ключ DeepSeek (уроки, вопросы, проверка темы)
//   OPENAI_API_KEY    — ключ OpenAI (картинки и SVG от GPT)
//   ADMIN_SECRET      — секрет для локальной админки (адрес /admin/kv); без него адрес закрыт
//   LEARN_REGISTER_CODE — промо-код самостоятельной регистрации; без него регистрации нет
//   ALLOWED_ORIGINS   — адреса страницы через запятую (https://learn.mindmaper.site), кроме *.web.app, *.firebaseapp.com и localhost
import { handleLearn } from './learn-worker.js';
import { makeFirestoreKv } from './firestore-kv.js';

const env0 = process.env;
const serviceAccount = env0.FIREBASE_SERVICE_ACCOUNT || '';
let LEARN_KV;
let storageInfo = 'не задан FIREBASE_SERVICE_ACCOUNT';
try {
  if (serviceAccount) { LEARN_KV = makeFirestoreKv(serviceAccount); storageInfo = 'Firestore'; }
} catch (err) {
  storageInfo = 'FIREBASE_SERVICE_ACCOUNT не читается: ' + err.message;
  console.error('[storage]', err.message);
}

const extraOrigins = (env0.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
const ORIGIN_RE = /^https:\/\/[a-z0-9-]+\.(web\.app|firebaseapp\.com)$|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const originAllowed = (origin) => Boolean(origin) && (ORIGIN_RE.test(origin) || extraOrigins.includes(origin));

function withCors(response, origin) {
  const headers = new Headers(response.headers);
  if (originAllowed(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Vary', 'Origin');
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

const jsonResponse = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

// Служебный доступ к базе для локальной админки (grok-chat-cf/admin-local): только ключи сайта уроков, только с секретом.
const ADMIN_SECRET = env0.ADMIN_SECRET || '';
const ADMIN_PREFIXES = ['learn-user:', 'learn-limit:', 'learn-usage:'];
const adminKeyOk = (key) => typeof key === 'string' && key.length < 200 && ADMIN_PREFIXES.some((p) => key.startsWith(p));
function sameSecret(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function handleAdminKv(request) {
  if (request.method !== 'POST') return jsonResponse(405, { error: 'Только POST' });
  if (!sameSecret(ADMIN_SECRET, request.headers.get('x-admin-secret') || '')) return jsonResponse(401, { error: 'Нет доступа' });
  if (!LEARN_KV) return jsonResponse(503, { error: 'Хранилище не настроено: ' + storageInfo });
  let body;
  try { body = await request.json(); } catch { return jsonResponse(400, { error: 'Некорректный JSON' }); }
  if (body.op === 'list') {
    const prefix = String(body.prefix || '');
    if (!ADMIN_PREFIXES.some((p) => prefix.startsWith(p) || p.startsWith(prefix))) return jsonResponse(400, { error: 'Нельзя' });
    const { keys } = await LEARN_KV.list({ prefix, limit: 5000 });
    return jsonResponse(200, { names: keys.map((k) => k.name).filter(adminKeyOk) });
  }
  if (body.op === 'get') {
    if (!Array.isArray(body.keys) || body.keys.length > 500 || !body.keys.every(adminKeyOk)) return jsonResponse(400, { error: 'Нельзя' });
    const values = {};
    for (const key of body.keys) values[key] = await LEARN_KV.get(key);
    return jsonResponse(200, { values });
  }
  if (body.op === 'put') {
    if (!adminKeyOk(body.key) || typeof body.value !== 'string' || body.value.length > 5000) return jsonResponse(400, { error: 'Нельзя' });
    await LEARN_KV.put(body.key, body.value);
    return jsonResponse(200, { ok: true });
  }
  if (body.op === 'delete') {
    if (!adminKeyOk(body.key)) return jsonResponse(400, { error: 'Нельзя' });
    await LEARN_KV.delete(body.key);
    return jsonResponse(200, { ok: true });
  }
  return jsonResponse(400, { error: 'Неизвестная операция' });
}

export async function handle(request, remoteIp) {
  const url = new URL(request.url);
  const origin = request.headers.get('origin') || '';

  if (request.method === 'OPTIONS') {
    return withCors(new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, x-access-code',
        'Access-Control-Max-Age': '86400',
      },
    }), origin);
  }

  // /health — для пингера (будит сервер раз в 10 минут, иначе бесплатный Render засыпает): ничего не читает из базы.
  if (url.pathname === '/health') return new Response('ok');
  // / — диагностика для владельца: хранилище, длина ADMIN_SECRET, число аккаунтов (одно чтение Firestore).
  if (url.pathname === '/') {
    const count = LEARN_KV ? await LEARN_KV.list({ prefix: 'learn-user:' }).then((r) => r.keys.length).catch((e) => 'ошибка: ' + e.message) : '—';
    return withCors(new Response(`ok · Render · хранилище: ${storageInfo} · ADMIN_SECRET: ${ADMIN_SECRET ? 'задан, длина ' + ADMIN_SECRET.length : 'не задан'} · DeepSeek: ${env0.DEEPSEEK_API_KEY ? 'задан' : 'не задан'} · промо-код: ${env0.LEARN_REGISTER_CODE ? 'задан' : 'не задан'} · учётных записей: ${count}`), origin);
  }

  if (url.pathname === '/admin/kv') return handleAdminKv(request);

  if (url.pathname.startsWith('/api/learn/')) {
    // learn-worker.js считает неудачные входы по CF-Connecting-IP (заголовок Cloudflare); здесь его нет — берём адрес посетителя из x-forwarded-for.
    const headers = new Headers(request.headers);
    const forwarded = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim();
    headers.set('CF-Connecting-IP', forwarded || remoteIp || 'unknown');
    const patched = new Request(request, { headers });
    const env = { ...env0, LEARN_KV };
    // Исключение внутри обработчика дало бы ответ без CORS-заголовков, и браузер увидел бы лишь «Failed to fetch»: ловим и отдаём текст ошибки.
    try {
      return withCors(await handleLearn(patched, env, url), origin);
    } catch (err) {
      console.error('[learn]', url.pathname, err?.stack || err);
      return withCors(jsonResponse(500, { error: 'Ошибка сервера: ' + (err?.message || err) }), origin);
    }
  }

  return withCors(jsonResponse(404, { error: 'Не найдено' }), origin);
}
