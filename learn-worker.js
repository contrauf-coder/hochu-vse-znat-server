// Онлайн-версия «Объясни мне урок» (https://mindmaper.site/learn.html): страница лежит в dist/learn.html, а её API —
// здесь, под /api/learn/*. Общая логика (проверка темы, ограничения ввода, запросы к DeepSeek и к Gemma в Google API,
// оценка картинок) живёт в ../image-search/lesson-core.js и подключается тем же файлом, что и у локального сервера
// image-search/server.js.
//
// Модели онлайн: DeepSeek и Gemma через Google API. Локальной Gemma (LM Studio) и GigaChat (его сертификат подписан
// российским корневым центром, которого нет у Cloudflare) тут нет. Claude тоже нет (нет ключа): «Производство SVG»
// (/svg) онлайн работает только на Gemma.
//
// Картинки из интернета: адреса ищем в DuckDuckGo обычными запросами, а в остальных источниках (Wikimedia Commons, Википедия, NASA и т. д.) — через image-sources.js (локально обычный поиск делает браузер Playwright, у Worker браузера
// нет; Bing с адресов Cloudflare результатов не отдаёт), оценивает Gemma через Google API. Отличие от локального сервера: уменьшить картинку нечем (нет sharp), поэтому
// она уходит Google как есть, а форматы, которых Gemini не читает (GIF, SVG и т. п.), пропускаются.
//
// Доступ — по логину и паролю (1 октября 2026, по прямой просьбе; до этого с 26 сентября сайт был открыт без кода, а ещё раньше
// пускал по общему коду LEARN_ACCESS_CODE — этот секрет больше не используется, его можно удалить: wrangler secret delete).
// Аккаунты заводит только владелец, в локальной «Админке карты» (вкладка «Сайт уроков», grok-chat-cf/admin-local), прямой записью
// в тот же KV, что и аккаунты карты (привязка LEARN_KV смотрит на тот же namespace, что MINDMAP_KV у grok-chat-cf), но с
// другими префиксами ключей. Самостоятельной регистрации нет. Ключи:
//   learn-user:<логин>       -> {salt, hash, createdAt, gen}   пароль — PBKDF2-SHA256 (100000), как у карты; gen растёт при смене пароля
//   learn-session:<токен>    -> {u: логин, g: gen}, TTL 30 дней — выдаётся при входе; токен клиент шлёт заголовком x-access-code
// Сессия живёт, пока жив аккаунт и совпадает gen: удалили аккаунт или сменили пароль — старые входы перестают работать
// (с задержкой до минуты: проверенные сессии помнятся в памяти изолята, чтобы не читать KV на каждый запрос урока).
// Если привязки KV нет и не включено LEARN_OPEN=1, API закрыто (503): забытая настройка не должна отдавать платные ключи всем
// подряд. LEARN_OPEN=1 (переменная в wrangler.jsonc) открывает сайт без входа и сильнее всего остального.
// Секреты задаёт только сам пользователь руками: wrangler secret put DEEPSEEK_API_KEY / GOOGLE_API_KEY (и по желанию GLM_API_KEY и
// MINIMAX_API_KEY — ими рисует SVG модель GLM или MiniMax; без секрета соответствующий вариант в «Производстве SVG» на сайте недоступен).
import core from './lib/lesson-core.js';
import images from './lib/image-sources.js';

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_MODEL = 'deepseek-v4-flash';
const GLM_URL = 'https://api.z.ai/api/paas/v4/chat/completions';
const GLM_MODEL = 'glm-4.7-flash';
const MINIMAX_URL = 'https://api.minimax.io/v1/chat/completions';
const MINIMAX_MODEL = 'MiniMax-M3.1-Flash-Preview';
const GOOGLE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const GOOGLE_MODEL = 'gemma-4-26b-a4b-it';
const MAX_BODY_BYTES = 150000;

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const SEARCH_LIMIT = images.CANDIDATE_TOTAL; // столько адресов отдаёт и локальный поиск (страница оценивает столько же)
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
// Оценке картинки хватает маленькой копии. Рядом с адресом оригинала DuckDuckGo отдаёт адрес копии на сервере Bing, а её ширину задаёт
// параметр w: при 320 копия весит ~13 КБ вместо 0,3–1,3 МБ оригинала, и Worker (sharp у него нет) не скачивает мегабайты и не отправляет
// их Google. Чем меньше число, тем быстрее и грубее оценка; 0 — выключить сжатие и оценивать оригиналы, как раньше.
const SCORE_IMAGE_WIDTH = 320;
const BING_THUMB_HOST = /^tse\d*\.mm\.bing\.net$/i;
// У картинок Wikimedia Commons копию делает сам адрес: .../thumb/…/Имя.jpg/960px-Имя.jpg → .../330px-Имя.jpg. Вики отдаёт только свои стандартные ширины.
const WIKIMEDIA_THUMB = /^(https:\/\/(?:thumb|upload)\.wikimedia\.org\/wikipedia\/commons\/thumb\/.+\/)(\d+)px-([^/?]+)(\?.*)?$/;
const WIKIMEDIA_SIZES = [250, 330, 500, 960];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function deepseekConfig(env) {
  return {
    key: (env.DEEPSEEK_API_KEY || '').trim(),
    url: env.DEEPSEEK_URL || DEEPSEEK_URL,
    model: env.DEEPSEEK_MODEL || DEEPSEEK_MODEL,
  };
}

function googleConfig(env) {
  return {
    key: (env.GOOGLE_API_KEY || env.GEMINI_API_KEY || '').trim(),
    url: env.GOOGLE_API_URL || GOOGLE_URL,
    model: env.GOOGLE_MODEL || GOOGLE_MODEL,
  };
}

function glmConfig(env) {
  return {
    key: (env.GLM_API_KEY || env.ZAI_API_KEY || '').trim(),
    url: env.GLM_API_URL || GLM_URL,
    model: env.GLM_MODEL || GLM_MODEL,
  };
}

function openaiConfig(env) {
  return {
    key: (env.OPENAI_API_KEY || '').trim(),
    url: env.OPENAI_API_URL || core.OPENAI_URL,
    model: env.OPENAI_MODEL || core.OPENAI_MODEL,
    effort: core.openaiEffort(env.OPENAI_MODEL || core.OPENAI_MODEL, env.OPENAI_REASONING_EFFORT),
  };
}

function minimaxConfig(env) {
  return {
    key: (env.MINIMAX_API_KEY || '').trim(),
    url: env.MINIMAX_API_URL || MINIMAX_URL,
    model: env.MINIMAX_MODEL || MINIMAX_MODEL,
    effort: env.MINIMAX_REASONING_EFFORT || '',
  };
}

// ---- Доступ: логин и пароль ----

const USERNAME_RE = /^[a-zA-Z0-9_.-]{2,40}$/;
const MAX_PASSWORD = 200;
const PBKDF2_ITERATIONS = 100000;
const SESSION_TTL = 60 * 60 * 24 * 30;
const SESSION_CACHE_MS = 60 * 1000;
const LOGIN_MAX_FAILS = 10;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const USER_PREFIX = 'learn-user:';
const SESSION_PREFIX = 'learn-session:';
const TOKEN_RE = /^[0-9a-f]{64}$/;
// Для несуществующего логина считаем хэш по пустой соли: время ответа не должно выдавать, есть ли такой логин.
const DUMMY_SALT = '00'.repeat(16);

// Живут в памяти изолята: мягкий заслон от перебора и от лишних чтений KV, а не гарантия (изолятов несколько).
const sessionCache = new Map(); // токен → { username, until }
const loginFails = new Map(); // IP → { count, start }

const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

function fromHex(hex) {
  const bytes = new Uint8Array(Math.floor(hex.length / 2));
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

// Те же параметры и формат, что у аккаунтов карты (grok-chat-cf/main.js, hashPassword) и у админки (admin-local/server.js): менять вместе.
async function pbkdf2Hex(password, saltHex) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: fromHex(saltHex), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key,
    256
  );
  return toHex(new Uint8Array(bits));
}

// Запись аккаунта из KV или null, если её нет или она повреждена.
function parseUser(raw) {
  if (!raw) return null;
  try {
    const user = JSON.parse(raw);
    if (user && typeof user.salt === 'string' && typeof user.hash === 'string') return { ...user, gen: Number(user.gen) || 1 };
  } catch { /* повреждена — как будто аккаунта нет */ }
  return null;
}

function loginBlocked(ip) {
  const entry = loginFails.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.start > LOGIN_WINDOW_MS) {
    loginFails.delete(ip);
    return false;
  }
  return entry.count >= LOGIN_MAX_FAILS;
}

function noteLoginFail(ip) {
  const now = Date.now();
  const entry = loginFails.get(ip);
  if (entry && now - entry.start <= LOGIN_WINDOW_MS) {
    entry.count++;
    return;
  }
  if (loginFails.size > 1000) loginFails.clear();
  loginFails.set(ip, { count: 1, start: now });
}

// Логин по токену сессии → имя аккаунта или null. Сессия действительна, пока жив аккаунт и совпадает gen.
async function sessionUser(env, token) {
  if (!env.LEARN_KV || typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  const cached = sessionCache.get(token);
  if (cached && cached.until > Date.now()) return cached.username;
  sessionCache.delete(token);

  let session = null;
  try { session = await env.LEARN_KV.get(SESSION_PREFIX + token, 'json'); } catch { /* повреждена */ }
  if (!session || typeof session.u !== 'string') return null;
  const user = parseUser(await env.LEARN_KV.get(USER_PREFIX + session.u));
  if (!user || user.gen !== (Number(session.g) || 1)) return null;

  if (sessionCache.size > 500) sessionCache.clear();
  sessionCache.set(token, { username: session.u, until: Date.now() + SESSION_CACHE_MS });
  return session.u;
}

// { open } — доступ без входа (LEARN_OPEN=1, сильнее всего остального), { login } — по логину и паролю, { closed } — ничего не настроено.
function accessState(env) {
  if (env.LEARN_OPEN === '1') return { open: true };
  return env.LEARN_KV ? { login: true } : { closed: true };
}

const NOT_CONFIGURED = 'Онлайн-версия ещё не настроена: на сервере не подключено хранилище аккаунтов.';

// null — пускаем, иначе готовый ответ с отказом.
async function authorize(request, env) {
  const state = accessState(env);
  if (state.open) return null;
  if (state.closed) return json({ error: NOT_CONFIGURED }, 503);
  return (await sessionUser(env, request.headers.get('x-access-code'))) ? null : json({ error: 'Нужно войти: логин и пароль' }, 401);
}

async function login(request, env) {
  if (!env.LEARN_KV) return json({ error: NOT_CONFIGURED }, 503);
  if (Number(request.headers.get('content-length') || 0) > 2000) return json({ error: 'Слишком большой запрос' }, 413);

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (loginBlocked(ip)) return json({ error: 'Слишком много неудачных попыток. Подожди немного и попробуй снова.' }, 429);

  let body = null;
  try { body = await request.json(); } catch { /* ниже */ }
  if (!body || typeof body !== 'object') return json({ error: 'Нужен JSON' }, 400);
  const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!username || !password) return json({ error: 'Введи логин и пароль' }, 400);

  const user = USERNAME_RE.test(username) && password.length <= MAX_PASSWORD ? parseUser(await env.LEARN_KV.get(USER_PREFIX + username)) : null;
  const hash = await pbkdf2Hex(password.slice(0, MAX_PASSWORD), user ? user.salt : DUMMY_SALT);
  if (!user || !core.timingSafeEqual(hash, user.hash)) {
    noteLoginFail(ip);
    return json({ error: 'Неверный логин или пароль' }, 401);
  }

  const token = toHex(crypto.getRandomValues(new Uint8Array(32)));
  await env.LEARN_KV.put(SESSION_PREFIX + token, JSON.stringify({ u: username, g: user.gen }), { expirationTtl: SESSION_TTL });
  const usage = isUnlimited(username) ? null : await readUsage(env, username, true);
  return json({ ok: true, token, username, usage: usageView(username, usage) });
}

// ---- Самостоятельная регистрация (8 ноября 2026, по просьбе; только копия на Firebase/Deno) ----
// Включается переменной окружения LEARN_REGISTER_CODE (промо-код): нет переменной — регистрации нет, адрес /register отвечает 404, а страница
// не показывает кнопку (providers → registerEnabled). На оригинале (Cloudflare) переменной нет, поэтому там регистрации нет.
// Обязательные поля: логин, пароль, промо-код. Новый аккаунт сразу получает REGISTER_LESSONS уроков (ключ learn-limit:<логин>).
// Неверный код и каждая регистрация идут в часовой счётчик адреса (от перебора кода и массового заведения аккаунтов).
const REGISTER_LESSONS = 5;
const REGISTER_MIN_PASSWORD = 6;
const REGISTER_PER_HOUR = 5;
const REGISTER_RESERVED = new Set(['promo', 'test', 'offline', 'admin', 'full', 'root', 'demo']);

async function register(request, env) {
  if (!env.LEARN_REGISTER_CODE) return json({ error: 'Не найдено' }, 404);
  if (!env.LEARN_KV) return json({ error: NOT_CONFIGURED }, 503);
  if (Number(request.headers.get('content-length') || 0) > 2000) return json({ error: 'Слишком большой запрос' }, 413);
  let body = null;
  try { body = await request.json(); } catch { /* ниже */ }
  if (!body || typeof body !== 'object') return json({ error: 'Нужен JSON' }, 400);
  const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const code = typeof body.code === 'string' ? body.code.trim().toLowerCase() : '';
  if (!username || !password || !code) return json({ error: 'Заполни все три поля: аккаунт, пароль и промо-код' }, 400);
  if (!USERNAME_RE.test(username)) return json({ error: 'Аккаунт: 2–40 знаков, латиница, цифры, точка, дефис или подчёркивание' }, 400);
  if (password.length < REGISTER_MIN_PASSWORD) return json({ error: 'Пароль слишком короткий — от ' + REGISTER_MIN_PASSWORD + ' знаков' }, 400);
  if (password.length > MAX_PASSWORD) return json({ error: 'Пароль слишком длинный' }, 400);

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rateKey = 'learn-reg-ip:' + ip;
  const used = parseInt((await env.LEARN_KV.get(rateKey)) || '0', 10) || 0;
  if (used >= REGISTER_PER_HOUR) return json({ error: 'Слишком много попыток с этого адреса. Попробуй через час.' }, 429);

  const want = String(env.LEARN_REGISTER_CODE).trim().toLowerCase();
  let diff = code.length ^ want.length;
  for (let i = 0; i < want.length; i++) diff |= (code.charCodeAt(i) || 0) ^ want.charCodeAt(i);
  if (diff !== 0) {
    await env.LEARN_KV.put(rateKey, String(used + 1), { expirationTtl: 3600 });
    return json({ error: 'Неверный промо-код' }, 403);
  }
  if (REGISTER_RESERVED.has(username) || await env.LEARN_KV.get(USER_PREFIX + username)) return json({ error: 'Этот аккаунт занят — выбери другое имя' }, 409);

  const salt = toHex(crypto.getRandomValues(new Uint8Array(16)));
  await env.LEARN_KV.put(USER_PREFIX + username, JSON.stringify({ salt, hash: await pbkdf2Hex(password, salt), createdAt: new Date().toISOString(), gen: 1 }));
  await env.LEARN_KV.put(LIMIT_PREFIX + username, JSON.stringify({ limit: REGISTER_LESSONS }));
  await env.LEARN_KV.put(rateKey, String(used + 1), { expirationTtl: 3600 });
  return json({ ok: true, username, lessons: REGISTER_LESSONS });
}

async function logout(request, env) {
  const token = request.headers.get('x-access-code') || '';
  if (env.LEARN_KV && TOKEN_RE.test(token)) {
    sessionCache.delete(token);
    await env.LEARN_KV.delete(SESSION_PREFIX + token);
  }
  return json({ ok: true });
}

// ---- Счётчик уроков и лимит (1 октября 2026, по прямой просьбе) ----
// У каждого аккаунта, кроме admin, считается число начатых уроков; на 100-м (или на своём лимите аккаунта, см. ниже) он перестаёт пользоваться сайтом.
// Ключ learn-usage:<логин> -> {n, last, topic}: n — сколько уроков начато, last — когда начат последний (мс), topic — его тема
// (без разницы в регистре и пробелах). Админка может сбросить счётчик (удалить ключ).
// Урок считается в момент нажатия «Объяснить»: новый разговор с моделью (в нём ещё не отвечал ассистент), у которого тема
// прошла проверку, — ещё ДО ответа модели. Отклонённая тема уроком не считается; сбой модели после этого — считается, но
// повторное нажатие на ту же тему бесплатно (см. ниже), так что сбой ничего не стоит. Подбор тем по предмету («не знаю, как
// называются темы») не урок — это разговор из одной ссылки на промпт 'subject' (core.expandLessonMessages, topics). Вопросы «Проверь себя», разбор, образцовый ответ и
// картинки — продолжение урока и отдельно не считаются.
// Повтор: «Объяснить» на ТОЙ ЖЕ теме, что и последний начатый урок (слово в слово, регистр и пробелы не в счёт), урока не
// добавляет — это перезагрузка (урок мог не загрузиться, и ребёнок нажимает снова). Тема вернулась после другого урока — это
// снова урок и считается. Сравнивается только текст темы: возраст и предмет не в счёт. Повтор ничего не пишет в KV, поэтому
// и «последний урок» (last) не продлевает.
// Когда n достигло лимита: новый разговор (урок или подбор тем) отклоняется сразу — кроме повтора последней темы: его, как и
// продолжения (вопросы, разбор, поиск и оценка картинок, рисунки SVG), пускают ещё LIMIT_GRACE_MS после последнего начатого
// урока — чтобы ребёнок дозанимался сотым уроком, если тот не загрузился; потом всё закрыто (403, limitReached).
// Слабое место, общее с проверкой темы: «продолжением» сервер считает любой разговор, где есть реплика ассистента, а её может
// выдумать самодельный запрос. Это счётчик расхода для своих, а не защита от сознательного обхода.
// Лимит можно поправить для одного аккаунта: ключ learn-limit:<логин> -> {limit} (целое 1–LIMIT_MAX), его пишет только админка;
// нет ключа или он повреждён — общий LESSON_LIMIT. Читается вместе со счётчиком (readUsage), поэтому живёт в тех же 60 с кеша.
const LESSON_LIMIT = 100;
const LIMIT_MAX = 10000;
const UNLIMITED_USERS = new Set(['admin']);
const USAGE_PREFIX = 'learn-usage:';
const LIMIT_PREFIX = 'learn-limit:';
const LIMIT_GRACE_MS = 60 * 60 * 1000;
const USAGE_CACHE_MS = 60 * 1000;

const usageCache = new Map(); // логин → { usage, until }

// Без аккаунта (сайт открыт всем, LEARN_OPEN) и у admin лимита нет.
const isUnlimited = (username) => !username || UNLIMITED_USERS.has(username);
// Картинки и SVG от GPT (платные). С 21 октября 2026 урок любого аккаунта, кроме admin, рисует GPT (app.js, режим full), поэтому /gpt-image и /gpt-svg открыты всем
// вошедшим аккаунтам. Любые модель, качество и размер — только admin и full (карточки шестерёнки); остальным — только то, что нужно уроку (зеркало FULL_GPT_IMAGE и
// FULL_GPT_SVG в app.js), иначе чужой запрос мог бы заказать дорогую картинку. Продолжение урока: при исчерпанном лимите — только в час «доработки» (см. dispatch).
const GPT_ANY_PARAMS_USERS = new Set(['admin', 'full']);
const gptLessonOnly = (username) => !isUnlimited(username) && !GPT_ANY_PARAMS_USERS.has(username);
const GPT_LESSON_IMAGE = { model: 'gpt-image-2.5-flare', quality: 'low', size: '1024x1024' };
const GPT_LESSON_SVG = { model: 'gpt-6.1-sol', effort: 'medium' }; // 13.11.2026 по просьбе владельца: было gpt-6-luna

async function readUsage(env, username, fresh = false) {
  const cached = usageCache.get(username);
  if (!fresh && cached && cached.until > Date.now()) return cached.usage;
  let usage = { n: 0, last: 0, topic: '', limit: LESSON_LIMIT };
  try {
    // Каждый ключ читается сам по себе: повреждённый счёт не должен отнимать свой лимит, а повреждённый лимит — счёт.
    const [stored, custom] = await Promise.all([
      env.LEARN_KV.get(USAGE_PREFIX + username, 'json').catch(() => null), // повреждён — как будто уроков не было
      env.LEARN_KV.get(LIMIT_PREFIX + username, 'json').catch(() => null), // повреждён — общий лимит
    ]);
    if (stored && Number.isFinite(stored.n)) {
      usage = { ...usage, n: Math.max(0, Math.floor(stored.n)), last: Number(stored.last) || 0, topic: typeof stored.topic === 'string' ? stored.topic : '' };
    }
    const limit = custom && Math.floor(custom.limit);
    if (limit >= 1 && limit <= LIMIT_MAX) usage.limit = limit;
  } catch { /* повреждён — как будто уроков не было */ }
  if (usageCache.size > 500) usageCache.clear();
  usageCache.set(username, { usage, until: Date.now() + USAGE_CACHE_MS });
  return usage;
}

// Тема, как её сравнивает счётчик: parseTopicCheck уже убрал лишние пробелы, остаётся регистр. Страница считает так же (app.js, topicKey).
const topicKey = (topic) => topic.toLowerCase();

// Записывает ещё один начатый урок на эту тему; usage — то, что было прочитано перед этим уроком.
async function bumpUsage(env, username, usage, topic) {
  const next = { n: usage.n + 1, last: Date.now(), topic };
  usageCache.set(username, { usage: { ...next, limit: usage.limit }, until: Date.now() + USAGE_CACHE_MS });
  try {
    await env.LEARN_KV.put(USAGE_PREFIX + username, JSON.stringify(next));
  } catch (err) {
    // Урок уже идёт: лучше потерять одну единицу счёта, чем сломать его.
    console.error('[learn/usage] не удалось записать счётчик:', err.message);
  }
  return { ...next, limit: usage.limit };
}

// Что показывает страница: { unlimited: true } или { used, limit, exhausted, lastTopic }. lastTopic нужен, чтобы при исчерпанном
// лимите страница знала, что повтор последней темы разрешён, и не стирала урок на экране зря.
function usageView(username, usage) {
  if (isUnlimited(username)) return { unlimited: true };
  return { used: usage.n, limit: usage.limit, exhausted: usage.n >= usage.limit, lastTopic: usage.topic };
}

// Можно ли продолжать начатое (не начинать новое): пока лимит не исчерпан — да, потом ещё час после последнего начатого урока.
const canContinue = (usage) => usage.n < usage.limit || Date.now() - usage.last < LIMIT_GRACE_MS;

function limitResponse(usage) {
  return json({ error: 'Лимит уроков исчерпан', limitReached: true, used: usage.n, limit: usage.limit, lastTopic: usage.topic }, 403);
}

// Имя вошедшего ('' — сайт открыт всем, входа нет).
async function currentUsername(request, env) {
  return accessState(env).login ? (await sessionUser(env, request.headers.get('x-access-code'))) || '' : '';
}

function providersInfo(env) {
  const cfg = deepseekConfig(env);
  const google = googleConfig(env);
  const glm = glmConfig(env);
  const minimax = minimaxConfig(env);
  const state = accessState(env);
  return {
    hosted: true,
    // Картинки онлайн работают, когда на сервере есть ключ Google: им оцениваются найденные в DuckDuckGo картинки.
    images: Boolean(google.key),
    lmstudio: { available: false },
    gigachat: { configured: false, chat: false },
    deepseek: { configured: Boolean(cfg.key), model: cfg.model, chat: true },
    google: { configured: Boolean(google.key), model: google.model, chat: true, images: true },
    // glm: только «Производство SVG» (маршрут /svg); уроки и проверка темы идут через DeepSeek или Google.
    glm: { configured: Boolean(glm.key), model: glm.model, chat: true },
    // openai: GPT рисует SVG взамен рисунка MiniMax, оценённого ниже порога (provider: 'openai' у /svg). Секрет Worker OPENAI_API_KEY ставит владелец руками.
    openai: { configured: Boolean(openaiConfig(env).key), model: openaiConfig(env).model, lesson: true, svg: true, imageModels: core.OPENAI_IMAGE_MODELS, svgModels: core.OPENAI_SVG_MODELS },
    // minimax: «Производство SVG» (маршрут /svg), оценка картинок (/rank-one, поле images) и урок со списком тем (/chat, поле lesson).
    // picture / pictureModel: картинки по описанию (маршрут /picture, карточка шестерёнки) и их картиночная модель.
    // svgEffort / svgDefaultEffort: карточка «SVG по описанию» шлёт в /svg выбранный уровень (поле effort); старый Worker его молча проигнорировал бы.
    // svgPlain: Worker понимает флажок «без шаблона» (поле plain).
    // video / videoModels: видео по описанию (маршруты /video и /video-file, карточка шестерёнки); videoModels — модели и допустимые для них качество с длиной.
    // svgStream: /svg понимает stream: true — рисунок MiniMax уходит странице потоком как есть, текст собирает страница (без этого поля страница просит готовый текст, как раньше).
    minimax: { configured: Boolean(minimax.key), model: minimax.model, chat: true, images: true, lesson: true, picture: true, pictureModel: core.MINIMAX_IMAGE_MODEL, pictureOptions: true, drawImage: true, scoreImage: true, svgEffort: true, svgPlain: true, svgDefaultEffort: core.MINIMAX_SVG_LESSON_EFFORT, svgStream: true, video: true, videoModels: core.MINIMAX_VIDEO_MODELS },
    // ddg — источник хозяина (поиск по DuckDuckGo): в реестре image-sources его нет, а в списке выбора базы («Искать одну») он нужен.
    imageSources: images.describeSources(imageKeys(env), ['ddg']),
    topicGate: true,
    // sectionChat: Worker умеет «Объясни подробней» (/section-chat); без поля страница кнопок под разделами не рисует.
    sectionChat: true,
    registerEnabled: Boolean(env.LEARN_REGISTER_CODE), // самостоятельная регистрация по промо-коду (только там, где задан LEARN_REGISTER_CODE)
    accessRequired: !state.open,
    accessConfigured: !state.closed,
    accessMode: state.open ? 'open' : state.login ? 'login' : 'closed',
  };
}

// Выбранная модель: { name, ask(messages, opts) → текст, openStream? } или { error }. Всё, кроме 'google', 'glm' и 'minimax', — DeepSeek.
// 'glm' доходит сюда только из svg(); 'minimax' — из svg() (рисунок, как есть) и из chat() (forChat: урок, список тем, проверка темы — низкий
// уровень размышлений и поток). Остальным провайдерам, кроме google и deepseek, chat() не верит.
function pickModel(provider, env, forChat = false) {
  if (provider === 'google') {
    const cfg = googleConfig(env);
    if (!cfg.key) return { error: 'Онлайн-версия ещё не настроена: на сервере нет ключа Google.' };
    return { name: `Gemma (Google API, ${cfg.model})`, ask: (messages, opts) => core.googleChat(messages, opts, cfg) };
  }
  if (provider === 'gptsol') {
    // Урок и список тем на GPT 6.1 Sol, средний уровень (core.gptLessonChat); ответ идёт потоком, как у DeepSeek (запрос Cloudflare обрывает на сотой секунде).
    const cfg = openaiConfig(env);
    if (!cfg.key) return { error: 'Онлайн-версия ещё не настроена: на сервере нет ключа OpenAI.' };
    return {
      name: `GPT (${core.GPT_LESSON_MODEL}, ${core.GPT_LESSON_EFFORT})`,
      ask: (messages, opts) => core.gptLessonChat(messages, opts, cfg),
      openStream: (messages) => core.gptLessonOpenStream(messages, cfg),
    };
  }
  if (provider === 'openai') {
    const cfg = openaiConfig(env);
    if (!cfg.key) return { error: 'Онлайн-версия ещё не настроена: на сервере нет ключа OpenAI.' };
    return { name: `GPT (${cfg.model})`, ask: (messages, opts) => core.openaiChat(messages, opts, cfg) };
  }
  if (provider === 'glm') {
    const cfg = glmConfig(env);
    if (!cfg.key) return { error: 'Онлайн-версия ещё не настроена: на сервере нет ключа GLM.' };
    return { name: `GLM (${cfg.model})`, ask: (messages, opts) => core.glmChat(messages, opts, cfg) };
  }
  if (provider === 'minimax') {
    const cfg = minimaxConfig(env);
    if (!cfg.key) return { error: 'Онлайн-версия ещё не настроена: на сервере нет ключа MiniMax.' };
    if (!forChat) return { name: `MiniMax (${cfg.model})`, ask: (messages, opts) => core.minimaxChat(messages, opts, cfg) };
    // Урок и список тем идут на xhigh с большим потолком токенов (размышления входят в него); проверка темы сама задаёт низкий уровень и свой потолок
    // (opts идут после умолчаний и перекрывают их).
    const effort = core.MINIMAX_CHAT_EFFORT;
    const maxTokens = core.MINIMAX_CHAT_MAX_TOKENS;
    return {
      name: `MiniMax (${cfg.model})`,
      ask: (messages, opts) => core.minimaxChat(messages, { effort, maxTokens, ...opts }, cfg),
      // Урок MiniMax пишет минуту и дольше: поток не даёт соединению оборваться по простою (как у DeepSeek).
      openStream: (messages) => core.minimaxOpenStream(messages, { effort, maxTokens }, cfg),
    };
  }
  const cfg = deepseekConfig(env);
  if (!cfg.key) return { error: 'Онлайн-версия ещё не настроена: на сервере нет ключа DeepSeek.' };
  return {
    name: `DeepSeek (${cfg.model})`,
    ask: (messages, opts) => core.deepseekChat(messages, opts, cfg),
    openStream: (messages) => core.deepseekOpenStream(messages, {}, cfg),
  };
}

async function chat(request, env) {
  if (Number(request.headers.get('content-length') || 0) > MAX_BODY_BYTES) return json({ error: 'Слишком большой запрос' }, 413);
  let body = null;
  try { body = await request.json(); } catch { /* ниже */ }
  if (!body || typeof body !== 'object') return json({ error: 'Нужен JSON' }, 400);

  const provider = ['google', 'minimax', 'gptsol'].includes(body.provider) ? body.provider : 'deepseek';
  const model = pickModel(provider, env, true);
  if (model.error) return json({ error: model.error }, 503);

  // Страница присылает ссылки на промпты, тексты подставляются здесь (core.expandLessonMessages); тема для проверки — из той же ссылки.
  const { stream } = body;
  const lesson = core.expandLessonMessages(body.messages);
  if (lesson.error) return json({ error: lesson.error }, 400);
  const { messages } = lesson;

  const isNew = !messages.some((m) => m.role === 'assistant');

  // Новый разговор (моделью в нём ещё никто не отвечал) обязан пройти проверку темы; тему нужно знать уже для счётчика.
  const check = isNew && !lesson.ideas ? core.parseTopicCheck(lesson.topicCheck) : null; // идеи вопросов: тема из фиксированного списка, проверка и счёт не нужны
  if (check?.error) return json({ error: check.error }, 400);

  // Лимит уроков (см. «Счётчик уроков и лимит»). Нажатие «Объяснить» — новый урок, если тема не та же, что у последнего урока
  // (тогда это перезагрузка). Исчерпан — новый урок не начинаем; повтор последней темы и продолжения пускаем час после последнего урока.
  const username = await currentUsername(request, env);
  const metered = !isUnlimited(username);
  let usage = null;
  let lessonTopic = ''; // тема урока, который этот запрос запишет в счётчик ('' — запись не нужна)
  if (metered) {
    usage = await readUsage(env, username, isNew);
    let repeat = false;
    if (isNew && !lesson.topics) {
      const key = topicKey(check.topic);
      repeat = Boolean(usage.topic) && usage.topic === key;
      if (!repeat) lessonTopic = key;
    }
    if (!lesson.ideas && (isNew && !repeat ? usage.n >= usage.limit : !canContinue(usage))) return limitResponse(usage);
  }

  if (isNew && !lesson.ideas) {
    try {
      const ask = (gateMessages, opts) => model.ask(gateMessages, { ...opts, effort: core.MINIMAX_GATE_EFFORT, timeoutMs: 60000 });
      const verdict = await core.runTopicGate(ask, check);
      if (!verdict.ok) {
        // Журнал отклонённых тем: смотреть в дашборде Cloudflare (Workers → mind-map → Logs), строки «[тема отклонена]».
        console.log('[тема отклонена]', core.rejectionLogLine({
          time: new Date().toISOString(),
          from: request.headers.get('CF-Connecting-IP') || '?',
          provider,
          check,
          verdict,
        }));
        return json({ rejected: true, message: core.rejectionMessage() });
      }
    } catch (err) {
      console.error('[learn/gate] failed:', err.message);
      return json({ error: `Не удалось проверить тему (${err.message}). Попробуй ещё раз.` }, 502);
    }
  }

  // Тема принята — урок начат и записывается в счётчик сразу, до ответа модели: нажатие «Объяснить» и есть урок. Если модель
  // сорвётся, ребёнок нажмёт снова, и это будет повтор той же темы — бесплатный.
  if (lessonTopic) usage = await bumpUsage(env, username, usage, lessonTopic);

  try {
    // Поток нужен DeepSeek и MiniMax: длинный урок пишется минуту и дольше, а пока по соединению идут байты, оно не рвётся по простою.
    // Урок Gemma занимает ~30 секунд, поэтому она отвечает обычным JSON.
    if (stream === true && model.openStream) {
      const upstream = await model.openStream(messages);
      const headers = { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Model': model.name };
      if (metered) {
        headers['X-Lessons-Used'] = String(usage.n);
        headers['X-Lessons-Limit'] = String(usage.limit);
        // Тема — в заголовке (адресная кодировка: заголовки не носят кириллицу), чтобы страница знала, какую тему можно перезагрузить.
        headers['X-Lessons-Topic'] = encodeURIComponent(usage.topic);
      }
      return new Response(upstream.body, { status: 200, headers });
    }
    const answer = await model.ask(messages, {});
    return json({ answer, model: model.name, usage: usageView(username, usage) });
  } catch (err) {
    console.error('[learn/chat] failed:', err.message);
    // Счёт — и в ответе об ошибке: урок уже записан, страница должна показать актуальное число.
    return json({ error: err.message, usage: usageView(username, usage) }, 502);
  }
}

// ---- «Объясни подробней»: подсказки к одному разделу урока ----
// Правила помощника — в lesson-core.js (answerSection): страница присылает название и текст раздела, номер подсказки (hint) и прежние нажатия; формулировку
// «вопроса» знает только сервер, роль system от страницы не принимается, привратника нет — вводить нечего. Поставщик — тот же набор, что у урока (DeepSeek, Gemma, MiniMax), этап «Объясни подробней».
// Это не новый урок: счётчик не растёт; но при исчерпанном лимите пускаем только в час «доработки» (см. canContinue в dispatch).
async function sectionChat(request, env) {
  if (Number(request.headers.get('content-length') || 0) > MAX_BODY_BYTES) return json({ error: 'Слишком большой запрос' }, 413);
  let body = null;
  try { body = await request.json(); } catch { /* ниже */ }
  if (!body || typeof body !== 'object') return json({ error: 'Нужен JSON' }, 400);

  const provider = ['google', 'minimax'].includes(body.provider) ? body.provider : 'deepseek';
  const model = pickModel(provider, env, true);
  if (model.error) return json({ error: model.error }, 503);

  const ctx = core.parseSectionChat(body);
  if (ctx.error) return json({ error: ctx.error }, 400);

  // Уровень размышлений поменьше урочного и потолок токенов под размышления MiniMax (остальные поставщики эти поля не читают).
  const askAnswer = (messages, opts) => model.ask(messages, { ...opts, effort: core.MINIMAX_SECTION_EFFORT, maxTokens: provider === 'minimax' ? core.MINIMAX_SECTION_MAX_TOKENS : opts.maxTokens, timeoutMs: 90000 });

  try {
    const result = await core.answerSection({ askAnswer }, ctx);
    return json({ ...result, model: model.name });
  } catch (err) {
    console.error('[learn/section-chat] failed:', err.message);
    return json({ error: err.message }, 502);
  }
}

// ---- Картинки: поиск в DuckDuckGo и оценка через Google ----

// Bing Картинки с адресов Cloudflare отдают облегчённую страницу без результатов (проверено 26 сентября 2026: 140 КБ вместо
// 850 КБ и ни одной плитки), поэтому ищем в DuckDuckGo: картинки у него берутся из того же Bing, а с Cloudflare он отвечает.
// Два запроса: страница выдачи (из неё берём одноразовый токен vqd), затем i.js с результатами в JSON.
// 403 от DuckDuckGo — отказ «похоже на робота»: у него нет официального интерфейса для картинок, мы ходим на служебные адреса его же страницы, и он то пускает, то нет
// (одни и те же два запроса с моего компьютера проходили, а под wrangler dev получали 403). Отказ плавающий, поэтому один раз повторяем через секунду с небольшим.
// Другие сбои (нет токена, не тот формат, 5xx) повторов не получают: их повтор не лечит. Срок общего поиска (deadlineMs) остаётся главным: сигнал прерывает и паузу.
async function duckduckgoImageUrls(q, signal) {
  try {
    return await duckduckgoImageUrlsOnce(q, signal);
  } catch (err) {
    if (err.status !== 403 || signal?.aborted) throw err;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1200);
      signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    if (signal?.aborted) throw err; // срок поиска вышел во время паузы: второй запрос не начинаем
    return duckduckgoImageUrlsOnce(q, signal);
  }
}

// Два запроса: страница выдачи (из неё токен vqd) и i.js с результатами. В тексте ошибки названо, на каком шаге отказ.
async function duckduckgoImageUrlsOnce(q, signal) {
  const headers = { 'User-Agent': BROWSER_UA, 'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8' };
  const page = await fetch(`https://duckduckgo.com/?q=${encodeURIComponent(q)}&iax=images&ia=images`, { headers, signal });
  if (!page.ok) throw Object.assign(new Error(`DuckDuckGo ответил ${page.status} (страница выдачи)`), { status: page.status });
  const vqd = (await page.text()).match(/vqd=["']?([\d-]+)/)?.[1];
  if (!vqd) throw new Error('DuckDuckGo не выдал токен поиска');

  const res = await fetch(`https://duckduckgo.com/i.js?l=us-en&o=json&q=${encodeURIComponent(q)}&vqd=${vqd}&f=,,,,,&p=1`, {
    headers: { ...headers, Referer: 'https://duckduckgo.com/' },
    signal,
  });
  if (!res.ok) throw Object.assign(new Error(`DuckDuckGo ответил ${res.status} (список картинок)`), { status: res.status });
  let data = null;
  try { data = await res.json(); } catch { /* ниже */ }
  if (!data || !Array.isArray(data.results)) throw new Error('DuckDuckGo ответил не по формату');
  return data.results.map((r) => r && { url: r.image, thumb: bingThumbUrl(r.thumbnail) });
}

// Адрес маленькой копии на сервере Bing или null: адрес приходит и из выдачи, и от страницы, а Worker сам его скачивает — чужие сайты не пускаем.
function bingThumbUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 500) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && BING_THUMB_HOST.test(u.hostname) ? u.href : null;
  } catch {
    return null;
  }
}

// Ключи платных/регистрационных источников картинок (секреты Worker; без ключа источник просто не спрашивается).
function imageKeys(env) {
  const v = (name) => (env[name] || '').trim();
  return {
    pexels: v('PEXELS_API_KEY'),
    pixabay: v('PIXABAY_API_KEY'),
    unsplash: v('UNSPLASH_ACCESS_KEY'),
    europeana: v('EUROPEANA_API_KEY'),
    smithsonian: v('SMITHSONIAN_API_KEY'),
    openverseId: v('OPENVERSE_CLIENT_ID'),
    openverseSecret: v('OPENVERSE_CLIENT_SECRET'),
  };
}

// Поиск картинок: image-sources.js по типу запроса выбирает из четырнадцати источников (Википедия, NASA, iNaturalist, Pexels и т. д.),
// а DuckDuckGo этот файл подставляет сам. Первые кандидаты (их оценивает модель) — лучшие из разных источников.
async function search(url, env) {
  // Длиннее core.SEARCH_QUERY_MAX (200 знаков) запрос не отвергается, а режется по границе слова: модель урока пишет ключевую фразу без указания длины,
  // и отказ молча лишал урок картинки. Так же ведёт себя и локальный сервер.
  const q = core.fitQuery(url.searchParams.get('q'));
  if (!q) return json({ error: 'Нужен параметр q' }, 400);

  const extra = {
    ddg: async (signal) => (await duckduckgoImageUrls(q, signal)).filter((r) => r && r.url),
  };
  // «Искать одну» / «Искать 6» (карточка шестерёнки): параметр source — id базы из /providers → imageSources, count — сколько картинок (1…6, по умолчанию 1);
  // спрашивается только эта база. onlySource и onlyCount в ответе — отметка, что Worker понял параметры (старый их проигнорировал бы и вернул шесть картинок
  // из разных баз, а при count без поддержки — одну вместо шести).
  const only = (url.searchParams.get('source') || '').trim();
  if (only) {
    const one = await images.searchOne(only, q, { keys: imageKeys(env), deadlineMs: 6000, extra, count: url.searchParams.get('count') });
    console.log(`[learn/search] «${q}» только ${only}: ${one.error ? `ошибка — ${one.error}` : one.items.length ? `найдено ${one.items.length} из ${one.count}` : 'пусто'}`);
    if (one.error) return json({ error: one.error }, one.status);
    return json({ ...searchPayload(one.items), onlySource: only, onlyCount: one.count, ...(one.note ? { note: one.note } : {}) });
  }
  const { items, plan, report } = await images.searchSources(q, {
    keys: imageKeys(env),
    limit: 6,
    total: SEARCH_LIMIT,
    deadlineMs: 6000,
    extra,
  });
  report.filter((r) => r.error).forEach((r) => console.error(`[learn/search] ${r.id}: ${r.error}`));
  console.log(`[learn/search] «${q}»: найдено ${items.length}; ${report.map((r) => `${r.id} ${r.count}${r.error ? '!' : ''} (${r.ms} мс)`).join(', ')}`);

  if (items.length === 0 && report.every((r) => r.error)) {
    return json({ error: `Не удалось найти картинки: ${report[0]?.error || 'источники не ответили'}` }, 502);
  }
  // thumbs[i] — адрес маленькой копии для urls[i] (или null): страница передаёт его в /rank-one, оценивается копия, а показывается оригинал.
  // credits[i] — подпись (автор, источник, лицензия) для показа под картинкой; у DuckDuckGo её нет.
  return json(searchPayload(items));
}

// Тело ответа поиска: параллельные массивы (адрес, маленькая копия, подпись, код базы, название базы).
function searchPayload(items) {
  return { urls: items.map((i) => i.url), thumbs: items.map((i) => i.thumb || null), credits: items.map((i) => i.credit || null), sources: items.map((i) => i.source), sourceNames: items.map((i) => images.sourceLabel(i.source)) };
}

// Unsplash требует отмечать, что выбранное фото использовано (запрос GET на download_location с ключом): страница шлёт сюда адрес из подписи.
// Принимаем только адреса вида https://api.unsplash.com/photos/<id>/download — ключ уходит только туда.
async function picked(request, env) {
  if (Number(request.headers.get('content-length') || 0) > 2000) return json({ error: 'Слишком большой запрос' }, 413);
  let body = null;
  try { body = await request.json(); } catch { /* ниже */ }
  const ping = body && typeof body.ping === 'string' ? body.ping : '';
  if (!/^https:\/\/api\.unsplash\.com\/photos\/[\w-]+\/download(\?[\w=&%.-]*)?$/.test(ping)) return json({ error: 'Адрес не подходит' }, 400);
  const key = (env.UNSPLASH_ACCESS_KEY || '').trim();
  if (!key) return json({ ok: false });
  try {
    await fetch(ping, { headers: { Authorization: `Client-ID ${key}`, 'Accept-Version': 'v1' } });
    return json({ ok: true });
  } catch {
    return json({ ok: false });
  }
}

// Адрес приходит от страницы, а Worker сам его скачивает: пускаем только обычные сайты, без адресов-чисел и внутренних имён.
function checkImageUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 2000) throw new Error('Некорректный адрес картинки');
  let u;
  try { u = new URL(raw); } catch { throw new Error('Некорректный адрес картинки'); }
  const host = u.hostname;
  if (!/^https?:$/.test(u.protocol) || !host.includes('.') || host.includes(':') || /^[\d.]+$/.test(host) || /(^|\.)(localhost|local|internal)$/i.test(host)) {
    throw new Error('Адрес картинки не подходит');
  }
  return u;
}

// Тип картинки по первым байтам (заголовок Content-Type у сайтов часто врёт). Gemini читает только JPEG, PNG и WebP.
function sniffImageType(b) {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

async function downloadImage(rawUrl) {
  const u = checkImageUrl(rawUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(u, { headers: { 'User-Agent': BROWSER_UA, Accept: 'image/*', ...images.fetchHeadersFor(u.href) }, signal: controller.signal });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    if (Number(res.headers.get('content-length') || 0) > MAX_IMAGE_BYTES) throw new Error('Картинка слишком большая');

    // Тело читаем кусками с потолком: заголовок длины бывает пустым, а скачивать десятки мегабайт незачем.
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_IMAGE_BYTES) { reader.cancel().catch(() => {}); throw new Error('Картинка слишком большая'); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
  } catch (err) {
    throw err.name === 'AbortError' ? new Error('Картинка не скачалась вовремя') : err;
  } finally {
    clearTimeout(timeout);
  }
}

// Оценивается копия, а показывать урок будет оригинал: смотрим, что он отдаётся (первые байты) и не гигантский, чтобы не выбрать картинку
// с мёртвой ссылкой. Идёт параллельно с оценкой, времени не добавляет. Ошибка здесь — картинка пропускается, как при неудачном скачивании.
async function probeImage(rawUrl) {
  const u = checkImageUrl(rawUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(u, { headers: { 'User-Agent': BROWSER_UA, Accept: 'image/*', Range: 'bytes=0-1023', ...images.fetchHeadersFor(u.href) }, signal: controller.signal });
    res.body?.cancel().catch(() => {}); // сервер мог не понять Range и отдавать файл целиком — он нам не нужен
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (/^text\//i.test(res.headers.get('content-type') || '')) throw new Error('По адресу не картинка');
    const total = Number((res.headers.get('content-range') || '').split('/')[1]) || Number(res.headers.get('content-length') || 0);
    if (total > MAX_IMAGE_BYTES) throw new Error('Картинка слишком большая');
  } catch (err) {
    throw err.name === 'AbortError' ? new Error('Картинка не отвечает') : err;
  } finally {
    clearTimeout(timeout);
  }
}

// Адрес ужатой копии для оценки (или null: оценивать оригинал): копия Bing нужной ширины, а у картинки Commons — тот же файл поуже.
function scoreCopyUrl(rawThumb, rawUrl) {
  if (!(SCORE_IMAGE_WIDTH > 0)) return null;
  const bing = bingThumbUrl(rawThumb);
  if (bing) {
    const u = new URL(bing);
    u.searchParams.set('w', String(SCORE_IMAGE_WIDTH));
    u.searchParams.delete('h');
    return u.href;
  }
  const wiki = typeof rawUrl === 'string' && rawUrl.length <= 2000 ? rawUrl.match(WIKIMEDIA_THUMB) : null;
  const size = WIKIMEDIA_SIZES.find((w) => w >= SCORE_IMAGE_WIDTH);
  if (wiki && size && Number(wiki[2]) > size) return `${wiki[1]}${size}px-${wiki[3]}${wiki[4] || ''}`;
  // Источники с готовой маленькой копией (Pexels, Unsplash, iNaturalist, Openverse…) сами присылают её адрес в thumb.
  if (typeof rawThumb === 'string' && rawThumb.length <= 1500 && /^https:\/\/\S+$/i.test(rawThumb) && rawThumb !== rawUrl) return rawThumb;
  return null;
}

// Встроенный метод быстрее; запасной путь нужен, если в среде его ещё нет (на Workers с малым лимитом процессора это важно).
function toBase64(bytes) {
  if (typeof bytes.toBase64 === 'function') return bytes.toBase64();
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return btoa(binary);
}

async function rankOne(request, env) {
  if (Number(request.headers.get('content-length') || 0) > 10000) return json({ error: 'Слишком большой запрос' }, 413);
  let body = null;
  try { body = await request.json(); } catch { /* ниже */ }
  if (!body || typeof body !== 'object' || !body.query || !body.url) return json({ error: 'Нужны query и url' }, 400);

  // Оценивает Gemma (Google API) или, по выбору на странице, MiniMax; любое другое значение provider — Gemma.
  const useMinimax = body.provider === 'minimax';
  const cfg = useMinimax ? minimaxConfig(env) : googleConfig(env);
  const model = useMinimax ? `MiniMax (${cfg.model})` : `Gemma (Google API, ${cfg.model})`;
  if (!cfg.key) return json({ score: null, error: useMinimax ? 'На сервере нет ключа MiniMax' : 'На сервере нет ключа Google', fatal: true, model });

  try {
    const copyUrl = scoreCopyUrl(body.thumb, body.url);
    let bytes = null;
    if (copyUrl) {
      // Копию качаем вместе с проверкой оригинала; не скачалась копия — оцениваем оригинал, как раньше.
      [bytes] = await Promise.all([downloadImage(copyUrl).catch(() => null), probeImage(body.url)]);
    }
    const compressed = Boolean(bytes);
    if (!bytes) bytes = await downloadImage(body.url);
    console.log(`[learn/rank-one] ${compressed ? 'копия' : 'оригинал'} ${bytes.length} Б`);
    const mime = sniffImageType(bytes);
    if (!mime) throw new Error('Формат картинки не поддерживается (нужен JPEG, PNG или WebP)');
    const score = useMinimax
      ? await core.minimaxScoreImage(body.query, body.topic, toBase64(bytes), mime, cfg)
      : await core.googleScoreImage(body.query, body.topic, toBase64(bytes), mime, cfg);
    return json({ score, model });
  } catch (err) {
    console.error('[learn/rank-one] failed:', err.message);
    return json({ score: null, error: err.message, fatal: Boolean(err.fatal), model });
  }
}

// ---- Производство SVG: Gemma рисует картинку по названию из метки [SVG: …] ----

// То же, что POST /api/svg у локального сервера: промпт фиксированный и лежит в lesson-core.js (core.svgPrompt). Онлайн рисуют Gemma
// через Google API, GLM (если задан секрет GLM_API_KEY) и MiniMax (MINIMAX_API_KEY): ключа Claude у Worker нет. Проверки темы нет: название пришло из урока,
// который её уже прошёл.
async function svg(request, env) {
  if (Number(request.headers.get('content-length') || 0) > 2000) return json({ error: 'Слишком большой запрос' }, 413);
  let body = null;
  try { body = await request.json(); } catch { /* ниже */ }
  if (!body || typeof body !== 'object') return json({ error: 'Нужен JSON' }, 400);

  if (!['google', 'glm', 'minimax', 'openai'].includes(body.provider)) return json({ error: 'Онлайн рисовать SVG могут только Gemma (Google API), GLM, MiniMax и GPT' }, 400);
  const parsed = core.parseSvgName(body.name);
  if (parsed.error) return json({ error: parsed.error }, 400);
  // Уровень размышлений задаёт карточка «SVG по описанию»; рисунки урока его не присылают и идут на основном уровне. Читает его только MiniMax.
  const level = core.parseMinimaxEffort(body.provider === 'minimax' ? body.effort : '');
  if (level.error) return json({ error: level.error }, 400);

  const model = pickModel(body.provider, env);
  if (model.error) return json({ error: model.error, fatal: true }, 503);

  // stream: true (только MiniMax): ответ MiniMax уходит странице потоком «как есть», а текст из него собирает сама страница (core.minimaxSvgStream). Worker бесплатного плана
  // не выдерживает разбор потока: на каждую секунду уходило ~20 мс процессора (лимит 10), и Cloudflare обрывал запрос голым 503 «Worker exceeded CPU time limit».
  // Тело ответа здесь не читается, поэтому процессор не тратится; если страница ушла, оно закрывается само и MiniMax больше не читается. Повторы и срок ожидания — на странице.
  if (body.stream === true && body.provider === 'minimax') {
    try {
      // Промпт в ответ не кладётся (тексты промптов сайт не отдаёт, см. «Редактируемые промпты»).
      const { response, effort } = await core.minimaxSvgStream(parsed.name, { plain: body.plain === true, effort: level.effort }, minimaxConfig(env), request.signal);
      const headers = { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' };
      if (effort) headers['X-Svg-Effort'] = effort;
      return new Response(response.body, { status: 200, headers });
    } catch (err) {
      console.error(`[learn/svg] «${parsed.name}» не начат:`, err.message);
      // noRetry — повторять бессмысленно (фильтр, неверный запрос): страница не станет делать вторую попытку, хотя остальные рисунки урока рисовать можно.
      return json({ error: err.message, fatal: Boolean(err.fatal || err.final), noRetry: Boolean(err.noRetry) }, 502);
    }
  }

  try {
    // Срок с запасом: Gemma иногда думает над рисунком 2 минуты и дольше (30 сентября 2026 у Google были сбои и долгие ответы: от 17 до 140 секунд на один и тот же рисунок).
    // Срок 300 с и потолок токенов SVG_MAX_TOKENS: сложная схема — тысячи токенов кода, а рассуждающие модели (MiniMax, GLM) считают и размышления.
    // У MiniMax рисунок урока (без effort) — всегда xhigh, потоком, без срока, до трёх попыток (на перегрузку 529 / 2064 и прочие сбои), без перехода на уровень ниже (core.minimaxSvgLessonOpts); в ответе — уровень.
    const report = {};
    // Карточка «SVG по описанию» присылает effort: тогда ровно этот уровень, один запрос без повторов, потоком, срок 10 минут (core.minimaxSvgCardOpts) — повторяет его человек.
    const extra = body.provider === 'minimax' ? (level.effort ? core.minimaxSvgCardOpts(report, level.effort) : core.minimaxSvgLessonOpts(report)) : {};
    // plain: true — карточка «SVG по описанию» с флажком «без шаблона»: вместо шаблона уходит приставка «в SVG: » и описание. Рисунки урока флаг не присылают.
    // Промпт в ответ не кладётся (тексты промптов сайт не отдаёт); локальный сервер его возвращает, и страница показывает его под рисунком.
    const prompt = body.plain === true ? core.svgPlainPrompt(parsed.name) : core.svgPrompt(parsed.name);
    // request.signal срабатывает, когда страница оборвала запрос (кнопка «Стоп», закрытая вкладка), и тогда обращение к MiniMax тоже прерывается. Но только с флагом
    // enable_request_signal в wrangler.jsonc (compatibility_flags); сейчас он не включён, и в `wrangler dev` сигнал не приходил даже с ним: без флага запрос к MiniMax
    // после «Стоп» досчитывается на сервере сам (не дольше срока timeoutMs), страница при этом уже свободна.
    const answer = await model.ask([{ role: 'user', content: prompt }], { timeoutMs: 300000, maxTokens: core.SVG_MAX_TOKENS, signal: request.signal, ...extra });
    return json({ answer, model: model.name, ...(report.effort ? { effort: report.effort } : {}) });
  } catch (err) {
    if (request.signal?.aborted) {
      console.log(`[learn/svg] «${parsed.name}» остановлен страницей`);
      return json({ error: 'Запрос остановлен' }, 499);
    }
    console.error(`[learn/svg] «${parsed.name}» failed:`, err.message);
    // fatal — остальные рисунки урока рисовать бессмысленно (ключ, доступ, лимит): страница не станет перебирать их зря.
    return json({ error: err.message, fatal: Boolean(err.fatal || err.final) }, 502);
  }
}

// ---- Картинки по описанию: карточка шестерёнки на странице ----

// Обычная картинка (не SVG): MiniMax, модель image-01. Описание — свободный текст до core.MINIMAX_IMAGE_PROMPT_MAX знаков, уходит как есть (если не включено
// «улучшать описание»); в запросе нет ни провайдера, ни модели. Настройки (необязательные): aspect, width + height, n, optimize — core.parsePictureOptions.
// Ответ { base64, mime, model } для одной картинки, { images, model } для нескольких (core.pictureReply): картинки приходят самими файлами
// (а не ссылками, которые у MiniMax живут сутки).
async function picture(request, env) {
  // 1500 знаков кириллицы — до 3000 байт в UTF-8
  if (Number(request.headers.get('content-length') || 0) > 8000) return json({ error: 'Слишком большой запрос' }, 413);
  let body = null;
  try { body = await request.json(); } catch { /* ниже */ }
  if (!body || typeof body !== 'object') return json({ error: 'Нужен JSON' }, 400);

  const parsed = core.parsePicturePrompt(body.prompt);
  if (parsed.error) return json({ error: parsed.error }, 400);
  const chosen = core.parsePictureOptions(body);
  if (chosen.error) return json({ error: chosen.error }, 400);

  const cfg = minimaxConfig(env);
  if (!cfg.key) return json({ error: 'Онлайн-версия ещё не настроена: на сервере нет ключа MiniMax.', fatal: true }, 503);

  try {
    const image = await core.minimaxImage(parsed.prompt, cfg, { options: chosen.options });
    return json(core.pictureReply(image, `MiniMax (${core.MINIMAX_IMAGE_MODEL})`));
  } catch (err) {
    console.error(`[learn/picture] «${parsed.prompt.slice(0, 80)}» failed:`, err.message);
    return json({ error: err.message, fatal: Boolean(err.fatal || err.final) }, 502);
  }
}

// POST /gpt-image { prompt, model, quality?, size? } — растровая картинка от GPT (карточка шестерёнки «Картинка от GPT», lesson-core.js, openaiImage). Модель — из
// core.OPENAI_IMAGE_MODELS. Ответ { base64, mime, model }. Платная и нужна только владельцу: как видео, только аккаунту без лимита (admin).
async function gptImage(request, env) {
  const username = await currentUsername(request, env);
  if (Number(request.headers.get('content-length') || 0) > 8000) return json({ error: 'Слишком большой запрос' }, 413);
  let body = null;
  try { body = await request.json(); } catch { /* ниже */ }
  const parsed = core.parseGptImageBody(body);
  if (parsed.error) return json({ error: parsed.error }, 400);
  if (gptLessonOnly(username) && (parsed.model !== GPT_LESSON_IMAGE.model || parsed.quality !== GPT_LESSON_IMAGE.quality || parsed.size !== GPT_LESSON_IMAGE.size)) {
    return json({ error: 'Здесь картинки рисуются только с настройками урока.' }, 403);
  }

  const cfg = openaiConfig(env);
  if (!cfg.key) return json({ error: 'На сервере не задан ключ OpenAI (wrangler secret put OPENAI_API_KEY).', fatal: true }, 503);
  try {
    const image = await core.openaiImage(parsed.prompt, parsed.model, { key: cfg.key }, { quality: parsed.quality, size: parsed.size });
    return json({ ...image, model: parsed.model });
  } catch (err) {
    console.error(`[learn/gpt-image] ${parsed.model} failed:`, err.message);
    return json({ error: err.message, fatal: Boolean(err.fatal) }, 502);
  }
}

// POST /gpt-svg { name, model?, effort? } — рисунок SVG от GPT с выбранными моделью и сложностью (карточка шестерёнки «SVG от GPT», lesson-core.js,
// openaiSvg). Платно и нужно только владельцу: как видео, только аккаунту без лимита (admin). Обычный запрос Cloudflare обрывает на сотой секунде
// (524), поэтому срок 95 с: на high/xhigh у крупных моделей рисунок может не успеть — тогда карточка покажет ошибку (локально срок 10 минут).
async function gptSvg(request, env) {
  const username = await currentUsername(request, env);
  if (Number(request.headers.get('content-length') || 0) > 2000) return json({ error: 'Слишком большой запрос' }, 413);
  let body = null;
  try { body = await request.json(); } catch { /* ниже */ }
  const parsed = core.parseGptSvgBody(body);
  if (parsed.error) return json({ error: parsed.error }, 400);
  if (gptLessonOnly(username) && (parsed.model !== GPT_LESSON_SVG.model || parsed.effort !== GPT_LESSON_SVG.effort)) {
    return json({ error: 'Здесь SVG рисуется только с настройками урока.' }, 403);
  }

  const cfg = openaiConfig(env);
  if (!cfg.key) return json({ error: 'На сервере не задан ключ OpenAI (wrangler secret put OPENAI_API_KEY).', fatal: true }, 503);
  try {
    const { prompt, ...drawn } = await core.openaiSvg(parsed, { key: cfg.key, url: cfg.url }, 95000); // промпт сайт не отдаёт
    return json(drawn);
  } catch (err) {
    console.error(`[learn/gpt-svg] ${parsed.model} ${parsed.effort || '-'}: «${parsed.name.slice(0, 80)}» failed:`, err.message);
    return json({ error: err.message, fatal: Boolean(err.fatal) }, 502);
  }
}

// POST /score-image { query, topic, base64, mime } — оценка готовой картинки, присланной страницей, моделью MiniMax по шкале 0…10 (так страница
// оценивает нарисованные MiniMax SVG: снимает их с экрана в JPEG). Ответ { score, model }. Доступно любому вошедшему аккаунту.
async function scoreImage(request, env) {
  if (Number(request.headers.get('content-length') || 0) > 2500000) return json({ error: 'Слишком большой запрос' }, 413);
  let body = null;
  try { body = await request.json(); } catch { /* ниже */ }
  const parsed = core.parseScoreImageBody(body);
  if (parsed.error) return json({ error: parsed.error }, 400);

  const cfg = minimaxConfig(env);
  if (!cfg.key) return json({ error: 'Онлайн-версия ещё не настроена: на сервере нет ключа MiniMax.', fatal: true }, 503);

  try {
    const score = await core.minimaxScoreImage(parsed.query, parsed.topic, parsed.base64, parsed.mime, cfg);
    return json({ score, model: `MiniMax (${cfg.model})` });
  } catch (err) {
    console.error(`[learn/score-image] «${parsed.query.slice(0, 80)}» failed:`, err.message);
    return json({ error: err.message, fatal: Boolean(err.fatal) }, 502);
  }
}

// POST /draw-image { keyword, topic } — картинка взамен найденной, не прошедшей порог оценки: MiniMax рисует три варианта (512×512,
// «улучшить описание») и сам оценивает их (lesson-core.js, drawReplacementImage). Ответ { best: { base64, mime, score } | null, scores, model };
// порог проверяет страница. Доступно любому вошедшему аккаунту, как /picture.
async function drawImage(request, env) {
  if (Number(request.headers.get('content-length') || 0) > 8000) return json({ error: 'Слишком большой запрос' }, 413);
  let body = null;
  try { body = await request.json(); } catch { /* ниже */ }
  if (!body || typeof body !== 'object') return json({ error: 'Нужен JSON' }, 400);

  const parsed = core.parsePicturePrompt(body.keyword);
  if (parsed.error) return json({ error: parsed.error }, 400);
  const topic = typeof body.topic === 'string' ? body.topic.slice(0, 200) : '';

  const cfg = minimaxConfig(env);
  if (!cfg.key) return json({ error: 'Онлайн-версия ещё не настроена: на сервере нет ключа MiniMax.', fatal: true }, 503);

  try {
    return json(await core.drawReplacementImage(parsed.prompt, topic, cfg));
  } catch (err) {
    console.error(`[learn/draw-image] «${parsed.prompt.slice(0, 80)}» failed:`, err.message);
    return json({ error: err.message, fatal: Boolean(err.fatal || err.final) }, 502);
  }
}

// ---- Шортс с YouTube: карточка шестерёнки на странице ----

// GET /shorts?q=… — первый шортс с YouTube по тексту (lesson-core.js, youtubeShortSearch) → { videoId, title, channel } | { found: false }.
// Секрет Worker YOUTUBE_API_KEY (ключ YouTube Data API v3) — только руками владельца. Как и видео, только для аккаунта без лимита (admin):
// у API своя дневная квота, и тратить её ученикам незачем.
async function shorts(request, url, env) {
  const username = await currentUsername(request, env);
  if (!isUnlimited(username)) return json({ error: 'Поиск шортсов доступен только владельцу сайта.' }, 403);
  const parsed = core.parseYoutubeQuery(url.searchParams.get('q'));
  if (parsed.error) return json({ error: parsed.error }, 400);
  const key = (env.YOUTUBE_API_KEY || '').trim();
  if (!key) return json({ error: 'На сервере не задан ключ YouTube (wrangler secret put YOUTUBE_API_KEY).' }, 503);
  try {
    const found = await core.youtubeShortSearch(parsed.query, key);
    return json(found || { found: false });
  } catch (err) {
    console.error(`[learn/shorts] «${parsed.query.slice(0, 80)}»:`, err.message);
    return json({ error: err.message }, 502);
  }
}

// ---- Видео по описанию: карточка шестерёнки на странице ----

// MiniMax Hailuo, текст → видео (как устроено — в lesson-core.js, «видео по описанию»). Три маршрута: POST /video — создать задачу, GET /video?task=… — готовность,
// GET /video-file?task=… — готовый ролик самим файлом (тело пускается дальше потоком: процессор Worker на это не тратится).
// Только для аккаунта без лимита (admin; сайт, открытый всем через LEARN_OPEN, — тоже): ролик стоит заметно дороже картинки и в счётчик уроков не входит,
// так что без этой проверки любой ученик мог бы тратить деньги владельца. Чтобы разрешить и другим — убрать вызов videoDenied().
async function videoDenied(request, env) {
  const username = await currentUsername(request, env);
  return isUnlimited(username) ? null : json({ error: 'Видео делает только владелец сайта: оно платное.' }, 403);
}

async function videoStart(request, env) {
  if (Number(request.headers.get('content-length') || 0) > 12000) return json({ error: 'Слишком большой запрос' }, 413); // 2000 знаков кириллицы — 4000 байт
  let body = null;
  try { body = await request.json(); } catch { /* ниже */ }
  if (!body || typeof body !== 'object') return json({ error: 'Нужен JSON' }, 400);

  const parsed = core.parseVideoPrompt(body.prompt);
  if (parsed.error) return json({ error: parsed.error }, 400);
  const chosen = core.parseVideoOptions(body);
  if (chosen.error) return json({ error: chosen.error }, 400);

  const cfg = minimaxConfig(env);
  if (!cfg.key) return json({ error: 'Онлайн-версия ещё не настроена: на сервере нет ключа MiniMax.', fatal: true }, 503);

  try {
    const { task } = await core.minimaxVideoStart(parsed.prompt, chosen.options, cfg);
    console.log(`[learn/video] задача ${task} создана: ${chosen.options.model}, ${chosen.options.resolution}, ${chosen.options.duration} с`);
    return json({ task, ...chosen.options });
  } catch (err) {
    console.error(`[learn/video] «${parsed.prompt.slice(0, 80)}» не создано:`, err.message);
    return json({ error: err.message, fatal: Boolean(err.fatal || err.final) }, 502);
  }
}

async function videoStatus(url, env) {
  const task = core.parseVideoTask(url.searchParams.get('task'));
  if (!task) return json({ error: 'Нужен номер задачи' }, 400);
  const cfg = minimaxConfig(env);
  if (!cfg.key) return json({ error: 'Онлайн-версия ещё не настроена: на сервере нет ключа MiniMax.', fatal: true }, 503);
  try {
    return json(await core.minimaxVideoStatus(task, cfg));
  } catch (err) {
    console.error(`[learn/video] задача ${task}: не удалось узнать готовность:`, err.message);
    // noRetry тоже fatal: «задачи нет» или неверный номер повтором не лечатся, страница не станет спрашивать ещё раз.
    return json({ error: err.message, fatal: Boolean(err.fatal || err.final || err.noRetry) }, 502);
  }
}

async function videoFile(url, env) {
  const task = core.parseVideoTask(url.searchParams.get('task'));
  if (!task) return json({ error: 'Нужен номер задачи' }, 400);
  const cfg = minimaxConfig(env);
  if (!cfg.key) return json({ error: 'Онлайн-версия ещё не настроена: на сервере нет ключа MiniMax.', fatal: true }, 503);
  try {
    const upstream = await core.minimaxVideoDownload(task, cfg);
    const headers = { 'Content-Type': upstream.headers.get('content-type') || 'video/mp4', 'Cache-Control': 'no-store' };
    const length = upstream.headers.get('content-length');
    if (length) headers['Content-Length'] = length;
    return new Response(upstream.body, { status: 200, headers });
  } catch (err) {
    console.error(`[learn/video] задача ${task}: не удалось получить файл:`, err.message);
    return json({ error: err.message, fatal: Boolean(err.fatal || err.final) }, err.notReady ? 409 : 502);
  }
}

// ---- Редактируемые промпты ----
// Правки лежат в KV одним ключом learn-prompts ({ id: текст }); реестр, проверка и подстановка — lesson-core.js (PROMPT_DEFS, setPromptOverrides). Пишет их только
// локальная админка (grok-chat-cf/admin-local, «Промпты уроков») прямо в KV. Воркер держит правки в памяти 30 с: другие точки Cloudflare подхватят свежую правку
// не позже чем через минуту-две (KV обновляется не мгновенно). Тексты промптов Worker не отдаёт никому, даже admin (защита от копирования, 22 октября 2026):
// маршрутов /prompts и /gate-prompt нет, в ответах рисунков SVG промпта нет.
const PROMPTS_KEY = 'learn-prompts';
const PROMPTS_CACHE_MS = 30000;
let promptsLoadedAt = 0;

async function ensurePrompts(env) {
  if (!env.LEARN_KV || Date.now() - promptsLoadedAt < PROMPTS_CACHE_MS) return;
  promptsLoadedAt = Date.now();
  try {
    core.setPromptOverrides(await env.LEARN_KV.get(PROMPTS_KEY, 'json'));
  } catch (err) {
    console.error('[learn/prompts] не удалось прочитать правки из KV:', err.message);
  }
}

export async function handleLearn(request, env, url) {
  try {
    return await dispatch(request, env, url);
  } catch (err) {
    console.error('[learn] unexpected:', err && err.message);
    return json({ error: 'Внутренняя ошибка сервера' }, 500);
  }
}

async function dispatch(request, env, url) {
  const route = url.pathname.slice('/api/learn'.length);
  const method = request.method;
  await ensurePrompts(env);

  if (route === '/providers' && method === 'GET') return json(providersInfo(env));
  if (route === '/login' && method === 'POST') return login(request, env);
  if (route === '/register' && method === 'POST') return register(request, env);
  if (route === '/logout' && method === 'POST') return logout(request, env);

  const denied = await authorize(request, env);
  if (denied) return denied;

  if (route === '/check-code' && method === 'GET') {
    const username = await currentUsername(request, env);
    return json({ ok: true, username, usage: usageView(username, isUnlimited(username) ? null : await readUsage(env, username, true)) });
  }
  if (route === '/chat' && method === 'POST') return chat(request, env);

  // Поиск и оценка картинок, рисунки SVG, разговор «Объясни подробней» — продолжение урока: при исчерпанном лимите пускаем только в час «доработки» (см. canContinue).
  if (['/search', '/rank-one', '/svg', '/picture', '/section-chat', '/gpt-image', '/gpt-svg'].includes(route)) {
    const username = await currentUsername(request, env);
    if (!isUnlimited(username)) {
      const usage = await readUsage(env, username);
      if (!canContinue(usage)) return limitResponse(usage);
    }
  }
  if (route === '/search' && method === 'GET') return search(url, env);
  if (route === '/picked' && method === 'POST') return picked(request, env);
  if (route === '/rank-one' && method === 'POST') return rankOne(request, env);
  if (route === '/svg' && method === 'POST') return svg(request, env);
  if (route === '/picture' && method === 'POST') return picture(request, env);
  if (route === '/draw-image' && method === 'POST') return drawImage(request, env);
  if (route === '/score-image' && method === 'POST') return scoreImage(request, env);
  if (route === '/gpt-image' && method === 'POST') return gptImage(request, env);
  if (route === '/gpt-svg' && method === 'POST') return gptSvg(request, env);
  if (route === '/section-chat' && method === 'POST') return sectionChat(request, env);
  if (route === '/shorts' && method === 'GET') return shorts(request, url, env);
  if ((route === '/video' && (method === 'POST' || method === 'GET')) || (route === '/video-file' && method === 'GET')) {
    const denied = await videoDenied(request, env);
    if (denied) return denied;
    if (route === '/video') return method === 'POST' ? videoStart(request, env) : videoStatus(url, env);
    return videoFile(url, env);
  }

  return json({ error: 'Не найдено' }, 404);
}
