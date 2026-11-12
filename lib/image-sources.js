'use strict';

// Источники картинок для уроков (4 октября 2026). Общий модуль: им пользуются и локальный сервер (server.js), и Worker сайта
// (mind-map/learn-worker.js). Здесь — четырнадцать источников с открытым API (Википедия, Wikimedia Commons, NASA, iNaturalist, GBIF,
// Openverse, Smithsonian Open Access, Metropolitan Museum, Art Institute of Chicago, Europeana, Library of Congress, Pexels, Pixabay,
// Unsplash), определение «типа» запроса (космос, природа, история и искусство, наука, математика и геометрия, обычная жизнь) и выбор
// подходящих источников под него. Поиск по всему интернету (DuckDuckGo, Bing) остаётся у хозяев модуля: они передают его как «extra»,
// а здесь он лишь встаёт в общий план и общую выдачу.
//
// Никаких Node-специфичных вещей: нужен только fetch, AbortController и URL (работает и в Cloudflare Workers).
// Каждый источник отдаёт карточки { url, thumb?, title, credit }:
//   url   — картинка для показа в уроке (желательно до ~1200 px и до 4 МБ);
//   thumb — маленькая копия для оценки моделью (если нет — Worker сам сделает её из url или оценит url);
//   credit — подпись: { source, author?, license?, page?, authorPage?, ping? } (ping — адрес «отметки скачивания» Unsplash).

const UA = 'learn-mindmaper/1.0 (+https://mindmaper.site)';
const TTL_MS = 10 * 60 * 1000;
const PIXABAY_TTL_MS = 24 * 60 * 60 * 1000; // правила Pixabay: ответы кэшируются на сутки
const BLOCK_MS = 10 * 60 * 1000; // источник, отказавший по лимиту или за проверкой «вы не робот», на это время пропускается
const UNSUPPORTED_EXT = /\.(gif|svg|bmp|ico|tiff?|avif|heic|heif)(\?|#|$)/i;

const cache = new Map(); // ключ → { t, v }
const blockedUntil = new Map(); // источник → время

async function cached(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttl) return hit.v;
  const v = await fn();
  cache.set(key, { t: Date.now(), v });
  if (cache.size > 400) cache.delete(cache.keys().next().value);
  return v;
}

// ---- разбор запроса ----

const STOP_WORDS = new Set(['a', 'an', 'the', 'of', 'in', 'on', 'at', 'with', 'and', 'or', 'for', 'from', 'to', 'by', 'is', 'are', 'its', 'their', 'his', 'her', 'into', 'over', 'under', 'near', 'photo', 'picture', 'image', 'photograph', 'close-up', 'closeup', 'view', 'showing', 'shows', 'that', 'this', 'there']);

const hasCyrillic = (q) => /[а-яё]/i.test(String(q || ''));

function words(q) {
  return String(q || '').toLowerCase().replace(/[^\p{L}\p{N}\s'-]+/gu, ' ').split(/\s+/).filter(Boolean);
}

// Значимые слова запроса без служебных (для API, которые плохо переносят длинные фразы).
function keywords(q, max = 4) {
  const seen = new Set();
  const out = [];
  for (const w of words(q)) {
    if (STOP_WORDS.has(w) || w.length < 2 || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= max) break;
  }
  return out;
}

// ---- тип запроса ----

// Словари типов запроса: слова через пробел. Английское слово совпадает точно или во множественном числе; русская основа — если слово
// начинается с неё (короткие основы — только с короткими окончаниями). Устойчивые сочетания — в PHRASES.
const LEXICON = {
  space: 'planet moon sun star galaxy nebula comet asteroid meteor meteorite orbit eclipse astronaut space rocket satellite telescope mars jupiter saturn venus mercury neptune uranus pluto universe cosmos constellation планет луна луны солнц звезд галакт комет астероид метеор орбит затмен космонавт космос космическ ракет спутник телескоп марс юпитер сатурн венер меркури нептун уран плутон вселенн созвезд',
  nature: 'animal bird fish insect mammal reptile amphibian plant tree flower leaf leaves forest mushroom butterfly bee ant spider frog snake lizard turtle whale dolphin shark lion tiger bear wolf fox deer rabbit cat dog horse cow pig sheep goat chicken duck owl eagle elephant giraffe zebra monkey panda penguin seal camel crocodile cactus fern moss seed root fruit vegetable wildlife species habitat ecosystem pollination beetle caterpillar squirrel hedgehog parrot swan kangaroo koala животн птиц рыб насеком млекопитающ пресмыкающ земноводн растен дерев цветок цветы листья гриб бабочк пчел пчёл муравь паук лягуш змея змеи ящериц черепах дельфин акул тигр медвед волк лиса лисы олен заяц зайц кролик кошк собак лошад коров овц куриц утка утки слон жираф зебр обезьян панд пингвин тюлен верблюд крокодил кактус папоротник овощ экосистем опылени белк попугай лебед кенгуру коал',
  history: 'painting sculpture statue museum artwork portrait ancient medieval renaissance vase pottery armor armour knight castle king queen emperor pharaoh pyramid mummy roman greek viking samurai byzantine icon fresco mosaic manuscript coin tapestry historical history war revolution treaty constitution flag map president century empire dynasty temple cathedral monument artifact antique helmet sword shield crown throne tomb palace картин скульптур статуя музей портрет древн средневек ренессанс ваза керамик доспех рыцар замок король королев император фараон пирамид мумия римск греческ викинг самурай византи икона фреск мозаик рукопис монет истори война революц договор конституц флаг карта президент империя династи храм собор памятник артефакт шлем меч щит корона трон гробниц дворец',
  science: 'diagram scheme structure cycle cell atom molecule anatomy organ skeleton circuit graph chart energy photosynthesis layers volcano tectonic rock mineral microscope experiment magnet electricity wave gravity force lever gear схем диаграмм строени цикл клетк атом молекул анатом орган скелет цепь график менделеев энерги фотосинтез слои вулкан тектон минерал микроскоп опыт эксперимент магнит электричеств волна гравитац рычаг шестерн',
  math: 'math maths mathematics mathematical geometry geometric triangle angle circle square rectangle polygon parallelogram trapezoid trapezium rhombus pentagon hexagon octagon cube sphere cone cylinder prism parabola hyperbola ellipse equation inequality quadratic linear polynomial logarithm exponent formula theorem proof pythagorean pythagoras euclid euclidean fraction algebra calculus trigonometry sine cosine tangent vector matrix integral derivative perimeter diameter radius circumference hypotenuse symmetry fractal tessellation fibonacci abacus protractor arithmetic multiplication subtraction decimal percentage proportion numeral математик геометр треугольник угол круг окружност квадрат прямоугольник многоугольник параллелограмм трапеци ромб пятиугольник шестиугольник восьмиугольник куб шар конус цилиндр призм парабол гипербол эллипс уравнен формул теорем доказательств пифагор евклид эвклид дроб алгебр тригонометр синус косинус тангенс функци вектор матриц интеграл производн периметр диаметр радиус гипотенуз симметри фрактал фибоначчи счёты счеты линейк транспортир циркул арифметик умножени вычитани процент пропорци',
};

const PHRASES = {
  space: ['solar system', 'milky way', 'black hole', 'space station', 'earth from space'],
  history: ['civil war', 'world war'],
  science: ['periodic table', 'water cycle', 'food chain', 'горная порода', 'круговорот воды'],
  nature: [],
  math: ['golden ratio', 'number line', 'prime number', 'right angle', 'square root', 'золотое сечение', 'числовая прямая', 'простые числа', 'прямой угол', 'квадратный корень'],
};

const LEX = {};
for (const [cat, text] of Object.entries(LEXICON)) {
  const all = text.split(/\s+/).filter(Boolean);
  LEX[cat] = { en: all.filter((w) => /^[a-z'-]+$/.test(w)), ru: all.filter((w) => /[а-яё]/.test(w)) };
}

function wordMatches(word, cat) {
  const lex = LEX[cat];
  if (/[а-яё]/.test(word)) {
    return lex.ru.some((stem) => word === stem || (stem.length >= 4 && word.startsWith(stem) && word.length - stem.length <= 4));
  }
  return lex.en.some((w) => word === w || word === `${w}s` || word === `${w}es`);
}

// Счёт по типам: space, nature, history, science, math (сколько слов запроса из каждого словаря) + photo (обычная жизнь, фон).
function classifyQuery(query) {
  const ws = words(query);
  const text = ws.join(' ');
  const score = { space: 0, nature: 0, history: 0, science: 0, math: 0, photo: 0 };
  for (const cat of Object.keys(PHRASES)) {
    for (const phrase of PHRASES[cat]) if (text.includes(phrase)) score[cat] += 2;
  }
  for (const w of ws) {
    if (STOP_WORDS.has(w)) continue;
    for (const cat of Object.keys(LEX)) if (wordMatches(w, cat)) score[cat] += 1;
  }
  const matched = score.space + score.nature + score.history + score.science + score.math;
  // Математика и геометрия — чертежи и схемы, а не фотографии: стоковые источники (у них вес photo) для таких запросов идут в хвосте плана.
  score.photo = score.math ? 0.5 : matched ? 1 : 3;
  // Короткие запросы похожи на название животного или растения: iNaturalist и GBIF сами проверяют, есть ли такой вид, и отвечают пусто, если нет.
  // Математике это не нужно: «triangle» — не вид.
  if (!score.math && keywords(query, 6).length <= 3) score.nature += 0.6;
  return score;
}

// Насколько источник подходит к каждому типу запроса (0 — не нужен).
const AFFINITY = {
  wikipedia: { space: 2, nature: 2, history: 2, science: 3, math: 4, photo: 1 },
  commons: { space: 2, nature: 2, history: 2, science: 3, math: 6, photo: 1 },
  ddg: { space: 2, nature: 2, history: 2, science: 2, math: 2, photo: 2 },
  bing: { space: 2, nature: 2, history: 2, science: 2, math: 2, photo: 2 },
  web: { space: 2, nature: 2, history: 2, science: 2, math: 2, photo: 2 }, // локальный сервер: Bing и DuckDuckGo одним источником
  nasa: { space: 5, science: 1, history: 1 },
  inaturalist: { nature: 4 },
  gbif: { nature: 3 },
  pexels: { photo: 3, nature: 2 },
  unsplash: { photo: 3, nature: 2, space: 1 },
  pixabay: { photo: 3, nature: 2, science: 2 },
  openverse: { photo: 2, nature: 1, history: 1, science: 1, space: 1, math: 3 },
  smithsonian: { history: 3, nature: 1, science: 1, space: 1, math: 5 }, // у музея Америки больше сотни геометрических моделей (CC0)
  met: { history: 3 },
  aic: { history: 3 },
  europeana: { history: 3, science: 0.5, math: 1 },
  loc: { history: 3 },
};

// Источники, не понимающие русский запрос: для русских запросов их не спрашиваем.
const ENGLISH_ONLY = new Set(['nasa', 'gbif', 'openverse', 'smithsonian', 'met', 'aic', 'loc', 'pexels', 'unsplash']);

// ---- общие помощники адаптеров ----

async function getJson(url, ctx, headers = {}) {
  const f = ctx.fetch || fetch;
  const res = await f(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers }, signal: ctx.signal });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    err.html = /html/i.test(res.headers.get('content-type') || '');
    throw err;
  }
  return res.json();
}

const httpsUrl = (u) => (typeof u === 'string' && /^https:\/\/[^\s]+$/i.test(u) && u.length < 1500 ? u : '');
const cleanText = (s, max = 120) => String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

function ccLabel(code, version) {
  const c = String(code || '').toLowerCase();
  if (!c) return '';
  if (c === 'cc0' || c === 'cc0_1_0') return 'CC0';
  if (c === 'pdm' || c === 'publicdomain') return 'общественное достояние';
  return `CC ${c.replace(/^cc[-_]?/, '').toUpperCase().replace(/[-_]/g, ' ')}${version ? ` ${version}` : ''}`.trim();
}

// Европейская лицензия по адресу прав («creativecommons.org/licenses/by/4.0/» → «CC BY 4.0»).
function rightsLabel(url) {
  const u = String(url || '');
  let m = u.match(/creativecommons\.org\/licenses\/([a-z-]+)\/([\d.]+)/i);
  if (m) return `CC ${m[1].toUpperCase().replace(/-/g, ' ')} ${m[2]}`;
  if (/creativecommons\.org\/publicdomain\/zero/i.test(u)) return 'CC0';
  if (/publicdomain\/mark/i.test(u)) return 'общественное достояние';
  return '';
}

// Лицензия допускает показ в уроке без «некоммерческого» ограничения? (Пока сайт бесплатный, NC можно было бы терпеть, но чище без них.)
const openLicense = (code) => !/(^|[-_ /])(nc|nd)([-_ /]|$)/i.test(String(code || ''));

function withMax(url, max) {
  return `${url}${url.includes('?') ? '&' : '?'}max=${max}`;
}

// ---- адаптеры ----

async function wikipedia(q, ctx) {
  const lang = hasCyrillic(q) ? 'ru' : 'en';
  return cached(`wiki|${lang}|${q}`, TTL_MS, async () => {
    const params = new URLSearchParams({
      action: 'query', generator: 'search', gsrsearch: q, gsrnamespace: '0', gsrlimit: String(Math.min(20, ctx.limit * 3)),
      prop: 'pageimages|info', piprop: 'thumbnail|name', pithumbsize: '800', pilimit: 'max', inprop: 'url', format: 'json', origin: '*',
    });
    const data = await getJson(`https://${lang}.wikipedia.org/w/api.php?${params}`, ctx);
    return Object.values(data.query?.pages || {})
      .sort((a, b) => a.index - b.index)
      // Только картинки с Wikimedia Commons (свободные): у локальных файлов en.wikipedia бывает добросовестное использование.
      .filter((p) => p.thumbnail?.source && /\/wikipedia\/commons\//.test(p.thumbnail.source))
      .slice(0, ctx.limit)
      .map((p) => ({
        url: p.thumbnail.source,
        title: p.title,
        credit: {
          source: lang === 'ru' ? 'Википедия' : 'Wikipedia',
          license: 'Wikimedia Commons',
          page: p.pageimage ? `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(p.pageimage)}` : p.fullurl,
        },
      }));
  });
}

// Wikimedia Commons: поиск по файлам, без ключа. Много школьных схем и чертежей (в том числе по математике и геометрии) со свободными лицензиями; SVG
// отдаются готовыми PNG-миниатюрами шириной 800 (thumburl), их читают модели. Commons ищет файлы, где есть ВСЕ слова запроса, а ИИ пишет ключевые фразы
// подлиннее («elephant drinking water with trunk in african savanna» не находит ничего), поэтому сначала точный поиск, а если результатов мало —
// дополняем поиском «любое из слов» по трём самым значимым словам (самые длинные, без служебных: «любое из слов» Commons считает тем дольше, чем
// больше слов — 3 слова ~2 с, 8 слов ~9 с). Поиск по категориям (incategory, deepcat) на проверенных запросах результат не улучшил, поэтому его нет.
const COMMONS_STOP = new Set(['with', 'and', 'the', 'for', 'from', 'that', 'this', 'into', 'over', 'under', 'near', 'their', 'its']);
const COMMONS_LIMIT = 24;

async function commonsSearch(search, ctx) {
  const params = new URLSearchParams({
    action: 'query', generator: 'search', gsrnamespace: '6', gsrlimit: String(COMMONS_LIMIT), gsrsearch: search,
    prop: 'imageinfo', iiprop: 'url|mime|extmetadata', iiextmetadatafilter: 'Artist|LicenseShortName', iiurlwidth: '800', format: 'json', origin: '*',
  });
  const data = await getJson(`https://commons.wikimedia.org/w/api.php?${params}`, ctx);
  return Object.values(data.query?.pages || {})
    .sort((a, b) => a.index - b.index)
    .map((p) => ({ info: p.imageinfo && p.imageinfo[0], title: p.title }))
    .filter(({ info }) => info && /^image\/(jpeg|png|webp|svg\+xml)$/.test(info.mime) && httpsUrl(info.thumburl))
    .map(({ info, title }) => ({
      url: info.thumburl,
      title: cleanText(String(title || '').replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, '')),
      credit: {
        source: 'Wikimedia Commons',
        author: cleanText(info.extmetadata?.Artist?.value, 80),
        license: cleanText(info.extmetadata?.LicenseShortName?.value, 40),
        page: httpsUrl(info.descriptionurl),
      },
    }));
}

async function commons(q, ctx) {
  const query = String(q || '').trim();
  if (!query) return [];
  return cached(`commons|${query}`, TTL_MS, async () => {
    let found = await commonsSearch(query, ctx);
    const ws = [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u))].filter((w) => w.length > 2 && !COMMONS_STOP.has(w));
    if (found.length < 6 && ws.length > 1) {
      const key = ws.sort((a, b) => b.length - a.length).slice(0, 3);
      found = found.concat(await commonsSearch(key.join(' OR '), ctx));
    }
    return found.slice(0, COMMONS_LIMIT);
  });
}

async function nasa(q, ctx) {
  const kw = keywords(q, 4).join(' ');
  if (!kw) return [];
  return cached(`nasa|${kw}`, TTL_MS, async () => {
    const params = new URLSearchParams({ q: kw, media_type: 'image', page_size: String(Math.min(30, ctx.limit * 3)) });
    const data = await getJson(`https://images-api.nasa.gov/search?${params}`, ctx);
    return (data.collection?.items || [])
      .map((it) => {
        const d = it.data?.[0] || {};
        // Первая ссылка — самый крупный из готовых вариантов (~medium 1280 px, где есть, иначе ~small 640 px); ~small есть всегда.
        const href = httpsUrl(it.links?.[0]?.href);
        if (!href || !d.nasa_id) return null;
        return {
          url: href,
          thumb: href.replace(/~(?:medium|large|orig)\./, '~small.'),
          title: cleanText(d.title),
          credit: { source: 'NASA', author: cleanText(d.photographer || d.secondary_creator || d.center, 60), license: 'общественное достояние', page: `https://images.nasa.gov/details/${encodeURIComponent(d.nasa_id)}` },
        };
      })
      .filter(Boolean)
      .slice(0, ctx.limit);
  });
}

// iNaturalist: сначала узнаём, есть ли вид с таким названием (autocomplete), потом берём его лучшие фото со свободной лицензией.
// Названием может оказаться любое из слов запроса, а не только первое и последнее: «giraffe camouflaged in dappled shade of tree» — это жираф (первое слово),
// а прежние варианты («giraffe camouflaged» и последнее слово «tree») давали «Vascular Plants», и три картинки из шести были случайными растениями.
// Варианты спрашиваем одновременно (до шести запросов), а берём по порядку предпочтения: вся короткая фраза, первые два слова, затем слова по одному
// слева направо — предмет описания обычно назван раньше обстановки.
const INAT_MAX_RANK_LEVEL = 50; // выше класса (тип, царство: «Vascular Plants» по слову «tree») — слишком общая группа, её фото ни о чём не говорят

async function inaturalist(q, ctx) {
  const kw = keywords(q, 5);
  if (!kw.length) return [];
  const locale = hasCyrillic(q) ? 'ru' : 'en';
  const variants = [...new Set([
    kw.length <= 3 ? kw.join(' ') : '',
    kw.length >= 2 ? kw.slice(0, 2).join(' ') : '',
    ...kw,
  ].filter(Boolean))];
  const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ').replace(/\s+/g, ' ').trim();
  const singular = (s) => s.replace(/(?:e?s)$/i, '');

  const taxon = await cached(`inat-taxon|${locale}|${variants.join('/')}`, TTL_MS, async () => {
    const found = await Promise.all(variants.map(async (v) => {
      const d = await getJson(`https://api.inaturalist.org/v1/taxa/autocomplete?${new URLSearchParams({ q: v, per_page: '5', locale })}`, ctx);
      const hit = (d.results || []).find((t) => (t.rank_level === undefined || t.rank_level <= INAT_MAX_RANK_LEVEL)
        && [t.matched_term, t.preferred_common_name, t.name].some((n) => norm(n) === norm(v) || singular(norm(n)) === singular(norm(v))));
      return hit ? { id: hit.id, name: hit.preferred_common_name || hit.name } : null;
    }));
    return found.find(Boolean) || null; // порядок вариантов = порядок предпочтения
  });
  if (!taxon) return [];

  return cached(`inat-obs|${locale}|${taxon.id}`, TTL_MS, async () => {
    // API v2 с перечнем нужных полей: ответ v1 на 12 наблюдений весит 2,3 МБ (разбор 13 мс — для Worker на бесплатном тарифе это много), а так — 4 КБ.
    const params = new URLSearchParams({
      taxon_id: String(taxon.id), photos: 'true', quality_grade: 'research', photo_license: 'cc0,cc-by,cc-by-sa', order_by: 'votes',
      per_page: String(Math.min(20, ctx.limit * 2)), locale, fields: 'uri,photos.url,photos.license_code,user.login,user.name',
    });
    const data = await getJson(`https://api.inaturalist.org/v2/observations?${params}`, ctx);
    return (data.results || [])
      .map((o) => {
        const photo = o.photos?.[0];
        const base = httpsUrl(photo?.url);
        if (!base || !/square\./.test(base)) return null;
        return {
          url: base.replace('square.', 'large.'),
          thumb: base.replace('square.', 'medium.'),
          title: cleanText(taxon.name),
          credit: { source: 'iNaturalist', author: cleanText(o.user?.name || o.user?.login, 60), license: ccLabel(photo.license_code), page: httpsUrl(o.uri) },
        };
      })
      .filter(Boolean)
      .slice(0, ctx.limit);
  });
}

// GBIF: народное название → вид → снимки из наблюдений. Почти все они — те же фото iNaturalist, поэтому берём только другие наборы данных
// (музейные образцы и т. п.); если их нет, ответ пустой.
async function gbif(q, ctx) {
  const kw = keywords(q, 3).join(' ');
  if (!kw || hasCyrillic(q)) return [];
  const key = await cached(`gbif-key|${kw}`, TTL_MS, async () => {
    const d = await getJson(`https://api.gbif.org/v1/species/search?${new URLSearchParams({ q: kw, qField: 'VERNACULAR', rank: 'SPECIES', status: 'ACCEPTED', limit: '20', datasetKey: 'd7dddbf4-2cf0-4f39-9b2a-bb099caae36c' })}`, ctx);
    const hit = (d.results || []).find((s) => (s.vernacularNames || []).some((v) => String(v.vernacularName || '').toLowerCase() === kw));
    return hit ? hit.key : null;
  });
  if (!key) return [];
  return cached(`gbif-occ|${key}`, TTL_MS, async () => {
    const params = new URLSearchParams({ taxonKey: String(key), mediaType: 'StillImage', limit: '40' });
    params.append('license', 'CC0_1_0');
    params.append('license', 'CC_BY_4_0');
    const data = await getJson(`https://api.gbif.org/v1/occurrence/search?${params}`, ctx);
    return (data.results || [])
      .filter((o) => !/inaturalist/i.test(o.datasetName || ''))
      .map((o) => {
        // Лицензия снимка в GBIF — свободный текст (бывает «Copyright by the creator»): берём только настоящие ссылки на свободные лицензии Creative Commons.
        const m = (o.media || []).find((x) => httpsUrl(x.identifier) && rightsLabel(x.license) && openLicense(x.license));
        if (!m) return null;
        return {
          url: m.identifier,
          title: cleanText(o.species || o.scientificName),
          credit: { source: 'GBIF', author: cleanText(m.creator || m.rightsHolder, 60), license: rightsLabel(m.license), page: httpsUrl(m.references) || `https://www.gbif.org/occurrence/${o.key}` },
        };
      })
      .filter(Boolean)
      .slice(0, ctx.limit);
  });
}

async function openverseToken(ctx) {
  const { openverseId, openverseSecret } = ctx.keys || {};
  if (!openverseId || !openverseSecret) return '';
  return cached('openverse-token', 50 * 60 * 1000, async () => {
    const f = ctx.fetch || fetch;
    const res = await f('https://api.openverse.org/v1/auth_tokens/token/', {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: openverseId, client_secret: openverseSecret }).toString(),
      signal: ctx.signal,
    });
    if (!res.ok) { const err = new Error(`HTTP ${res.status}`); err.status = res.status; throw err; }
    const d = await res.json();
    return d.access_token || '';
  });
}

async function openverse(q, ctx) {
  const kw = keywords(q, 5).join(' ');
  if (!kw) return [];
  return cached(`ov|${kw}`, TTL_MS, async () => {
    const token = await openverseToken(ctx);
    const params = new URLSearchParams({ q: kw, page_size: String(Math.min(20, ctx.limit * 2)), mature: 'false', license_type: 'commercial' });
    const data = await getJson(`https://api.openverse.org/v1/images/?${params}`, ctx, token ? { Authorization: `Bearer ${token}` } : {});
    return (data.results || [])
      .map((i) => {
        const url = httpsUrl(i.url);
        if (!url || UNSUPPORTED_EXT.test(url)) return null;
        return {
          url,
          thumb: httpsUrl(i.thumbnail) || undefined,
          title: cleanText(i.title),
          credit: { source: 'Openverse', author: cleanText(i.creator, 60), license: ccLabel(i.license, i.license_version), page: httpsUrl(i.foreign_landing_url) },
        };
      })
      .filter(Boolean)
      .slice(0, ctx.limit);
  });
}

async function smithsonian(q, ctx) {
  const kw = keywords(q, 4).join(' ');
  if (!kw) return [];
  return cached(`si|${kw}`, TTL_MS, async () => {
    const params = new URLSearchParams({ q: `${kw} AND online_media_type:"Images" AND media_usage:CC0`, rows: String(Math.min(20, ctx.limit * 2)), start: '0', api_key: ctx.keys.smithsonian });
    const data = await getJson(`https://api.si.edu/openaccess/api/v1.0/search?${params}`, ctx);
    return (data.response?.rows || [])
      .map((r) => {
        const d = r.content?.descriptiveNonRepeating || {};
        const media = (d.online_media?.media || []).find((m) => m.type === 'Images' && httpsUrl(m.content) && m.usage?.access === 'CC0');
        if (!media) return null;
        return {
          // IDS (сервер изображений Смитсоновского института) сам уменьшает: max — длинная сторона в пикселях.
          url: withMax(media.content, 1000),
          thumb: withMax(media.content, 400),
          title: cleanText(r.title),
          credit: { source: 'Smithsonian', author: cleanText(d.data_source, 80), license: 'CC0', page: httpsUrl(d.record_link) },
        };
      })
      .filter(Boolean)
      .slice(0, ctx.limit);
  });
}

async function met(q, ctx) {
  const kw = keywords(q, 3).join(' ');
  if (!kw) return [];
  return cached(`met|${kw}`, TTL_MS, async () => {
    // Старый /v1/search закрыт 1 октября 2026; новый /v1.1/search постраничный.
    const ids = (await getJson(`https://collectionapi.metmuseum.org/public/collection/v1.1/search?${new URLSearchParams({ q: kw, hasImages: 'true', isPublicDomain: 'true', limit: String(ctx.limit + 2), offset: '0' })}`, ctx)).objectIDs || [];
    const objects = await Promise.all(ids.slice(0, ctx.limit + 2).map((id) => getJson(`https://collectionapi.metmuseum.org/public/collection/v1/objects/${id}`, ctx).catch(() => null)));
    return objects
      .filter((o) => o && o.isPublicDomain && httpsUrl(o.primaryImageSmall))
      .slice(0, ctx.limit)
      .map((o) => ({
        // primaryImage (оригинал) бывает в десятки мегабайт; Small — около 470 px.
        url: o.primaryImageSmall,
        thumb: o.primaryImageSmall,
        title: cleanText(o.title),
        credit: { source: 'The Met', author: cleanText(o.artistDisplayName || o.culture || o.department, 60), license: 'CC0', page: httpsUrl(o.objectURL) },
      }));
  });
}

const AIC_HEADERS = { 'AIC-User-Agent': 'learn-mindmaper (+https://mindmaper.site)' };

async function aic(q, ctx) {
  const kw = keywords(q, 3).join(' ');
  if (!kw) return [];
  return cached(`aic|${kw}`, TTL_MS, async () => {
    const params = new URLSearchParams({ q: kw, limit: String(Math.min(20, ctx.limit * 2)), fields: 'id,title,image_id,artist_title' });
    params.append('query[term][is_public_domain]', 'true');
    const data = await getJson(`https://api.artic.edu/api/v1/artworks/search?${params}`, ctx, AIC_HEADERS);
    const iiif = httpsUrl(data.config?.iiif_url) || 'https://www.artic.edu/iiif/2';
    return (data.data || [])
      .filter((a) => a.image_id)
      .slice(0, ctx.limit)
      .map((a) => ({
        url: `${iiif}/${a.image_id}/full/843,/0/default.jpg`,
        thumb: `${iiif}/${a.image_id}/full/400,/0/default.jpg`,
        title: cleanText(a.title),
        credit: { source: 'Art Institute of Chicago', author: cleanText(a.artist_title, 60), license: 'общественное достояние', page: `https://www.artic.edu/artworks/${a.id}` },
      }));
  });
}

async function europeana(q, ctx) {
  const kw = keywords(q, 4).join(' ');
  if (!kw) return [];
  return cached(`eu|${kw}`, TTL_MS, async () => {
    const params = new URLSearchParams({ wskey: ctx.keys.europeana, query: kw, rows: String(Math.min(20, ctx.limit * 2)), profile: 'standard', media: 'true', thumbnail: 'true', reusability: 'open' });
    params.append('qf', 'TYPE:IMAGE');
    const data = await getJson(`https://api.europeana.eu/record/v2/search.json?${params}`, ctx);
    const first = (v) => (Array.isArray(v) ? v[0] : v);
    return (data.items || [])
      .map((it) => {
        const preview = httpsUrl(first(it.edmPreview));
        const shownBy = httpsUrl(first(it.edmIsShownBy));
        const url = shownBy && !UNSUPPORTED_EXT.test(shownBy) && /\.(jpe?g|png|webp)(\?|$)/i.test(shownBy) ? shownBy : preview;
        if (!url) return null;
        return {
          url,
          thumb: preview || undefined,
          title: cleanText(first(it.title)),
          credit: { source: 'Europeana', author: cleanText(first(it.dcCreator) || first(it.dataProvider), 60), license: rightsLabel(first(it.rights)), page: httpsUrl(it.guid) || httpsUrl(first(it.edmIsShownAt)) },
        };
      })
      .filter(Boolean)
      .slice(0, ctx.limit);
  });
}

// Library of Congress: сейчас сайт закрыт проверкой Cloudflare («Just a moment…»), которую мы не обходим; адаптер работает, когда её нет.
async function loc(q, ctx) {
  const kw = keywords(q, 4).join(' ');
  if (!kw) return [];
  return cached(`loc|${kw}`, TTL_MS, async () => {
    const data = await getJson(`https://www.loc.gov/photos/?${new URLSearchParams({ q: kw, fo: 'json', c: String(Math.min(20, ctx.limit * 2)) })}`, ctx);
    return (data.results || [])
      .map((r) => {
        const imgs = (Array.isArray(r.image_url) ? r.image_url : [r.image_url]).map(httpsUrl).filter((u) => u && /\.jpe?g(\?|$)/i.test(u));
        if (!imgs.length) return null;
        const rights = cleanText(Array.isArray(r.rights_advisory) ? r.rights_advisory[0] : r.rights_advisory || r.rights, 160);
        if (/restricted|copyright|все права/i.test(rights) && !/no known/i.test(rights)) return null;
        return {
          url: imgs[imgs.length - 1],
          thumb: imgs[0],
          title: cleanText(r.title),
          credit: { source: 'Library of Congress', license: /no known/i.test(rights) ? 'нет известных ограничений' : 'см. страницу', page: httpsUrl(r.url) || httpsUrl(r.id) },
        };
      })
      .filter(Boolean)
      .slice(0, ctx.limit);
  });
}

async function pexels(q, ctx) {
  const kw = keywords(q, 5).join(' ');
  if (!kw) return [];
  return cached(`px|${kw}`, TTL_MS, async () => {
    const data = await getJson(`https://api.pexels.com/v1/search?${new URLSearchParams({ query: kw, per_page: String(Math.min(30, ctx.limit * 2)) })}`, ctx, { Authorization: ctx.keys.pexels });
    return (data.photos || [])
      .map((p) => {
        const url = httpsUrl(p.src?.large);
        if (!url) return null;
        return {
          url,
          thumb: httpsUrl(p.src?.medium) || undefined,
          title: cleanText(p.alt),
          credit: { source: 'Pexels', author: cleanText(p.photographer, 60), license: 'Pexels License', page: httpsUrl(p.url), authorPage: httpsUrl(p.photographer_url) },
        };
      })
      .filter(Boolean)
      .slice(0, ctx.limit);
  });
}

async function pixabay(q, ctx) {
  const kw = keywords(q, 5).join(' ');
  if (!kw) return [];
  const lang = hasCyrillic(q) ? 'ru' : 'en';
  return cached(`pb|${lang}|${kw}`, PIXABAY_TTL_MS, async () => {
    const params = new URLSearchParams({ key: ctx.keys.pixabay, q: kw.slice(0, 100), lang, image_type: 'all', safesearch: 'true', per_page: String(Math.max(3, Math.min(30, ctx.limit * 2))), min_width: '640' });
    const data = await getJson(`https://pixabay.com/api/?${params}`, ctx);
    return (data.hits || [])
      .map((h) => {
        const url = httpsUrl(h.webformatURL);
        if (!url) return null;
        return {
          url,
          // «_640» в адресе можно заменить на «_340» — копия поменьше для оценки.
          thumb: url.replace('_640.', '_340.'),
          title: cleanText(h.tags),
          credit: { source: 'Pixabay', author: cleanText(h.user, 60), license: 'Pixabay License', page: httpsUrl(h.pageURL) },
        };
      })
      .filter(Boolean)
      .slice(0, ctx.limit);
  });
}

async function unsplash(q, ctx) {
  const kw = keywords(q, 5).join(' ');
  if (!kw) return [];
  const utm = 'utm_source=learn_mindmaper&utm_medium=referral';
  const withUtm = (u) => (httpsUrl(u) ? `${u}${u.includes('?') ? '&' : '?'}${utm}` : '');
  return cached(`us|${kw}`, TTL_MS, async () => {
    const data = await getJson(`https://api.unsplash.com/search/photos?${new URLSearchParams({ query: kw, per_page: String(Math.min(30, ctx.limit * 2)), content_filter: 'high' })}`, ctx, { Authorization: `Client-ID ${ctx.keys.unsplash}`, 'Accept-Version': 'v1' });
    return (data.results || [])
      .map((p) => {
        const url = httpsUrl(p.urls?.regular);
        if (!url) return null;
        return {
          url,
          thumb: httpsUrl(p.urls?.small) || undefined,
          title: cleanText(p.alt_description || p.description),
          credit: { source: 'Unsplash', author: cleanText(p.user?.name, 60), license: 'Unsplash License', page: withUtm(p.links?.html), authorPage: withUtm(p.user?.links?.html), ping: httpsUrl(p.links?.download_location) },
        };
      })
      .filter(Boolean)
      .slice(0, ctx.limit);
  });
}

// ---- реестр ----

// needs — какой ключ нужен (имя поля в keys); без ключа источник не спрашивается.
const SOURCES = {
  wikipedia: { name: 'Википедия', run: wikipedia },
  commons: { name: 'Wikimedia Commons', run: commons },
  nasa: { name: 'NASA', run: nasa },
  inaturalist: { name: 'iNaturalist', run: inaturalist },
  gbif: { name: 'GBIF', run: gbif },
  openverse: { name: 'Openverse', run: openverse },
  smithsonian: { name: 'Smithsonian Open Access', run: smithsonian, needs: 'smithsonian' },
  met: { name: 'Metropolitan Museum', run: met },
  aic: { name: 'Art Institute of Chicago', run: aic },
  europeana: { name: 'Europeana', run: europeana, needs: 'europeana' },
  loc: { name: 'Library of Congress', run: loc },
  pexels: { name: 'Pexels', run: pexels, needs: 'pexels' },
  pixabay: { name: 'Pixabay', run: pixabay, needs: 'pixabay' },
  unsplash: { name: 'Unsplash', run: unsplash, needs: 'unsplash' },
};

// Сведения для страницы и журнала: какие источники подключены, каким нужен ключ.
// hostIds — источники хозяина (на сайте ddg, на локальном сервере web): они не в реестре и ключа не требуют, но в списке выбора баз нужны; идут первыми.
// englishOnly — база не понимает русский запрос (planSources такие для русского не спрашивает; в списке выбора пользователь видит это заранее).
function describeSources(keys = {}, hostIds = []) {
  const host = hostIds.map((id) => ({ id, name: sourceLabel(id), needsKey: false, configured: true, englishOnly: false, host: true }));
  const registry = Object.entries(SOURCES).map(([id, d]) => ({ id, name: d.name, needsKey: Boolean(d.needs), configured: !d.needs || Boolean(keys[d.needs]), englishOnly: ENGLISH_ONLY.has(id) }));
  return [...host, ...registry];
}

// Дополнительные заголовки для скачивания картинки с некоторых сайтов (иначе Cloudflare показывает им проверку «не робот»).
function fetchHeadersFor(url) {
  try {
    const host = new URL(url).hostname;
    if (host === 'www.artic.edu') return AIC_HEADERS;
  } catch { /* не адрес */ }
  return {};
}

// ---- план и слияние ----

const MAX_SOURCES = 7;

// Сколько кандидатов отдаёт поиск. Страница оценивает ровно столько же (app.js: EXPLAIN_IMAGE_LIMIT и RANK_LIMIT), остальные ни на что не шли.
// Первые шесть при круговой выдаче те же, что были бы первыми из двадцати четырёх; число запросов к источникам от этого не меняется.
const CANDIDATE_TOTAL = 6;

// Названия источников хозяина (поиск по всему интернету): в реестре SOURCES их нет, а подписать картинку в списке нужно.
const HOST_SOURCE_NAMES = { ddg: 'DuckDuckGo', bing: 'Bing', web: 'Bing / DuckDuckGo' };

// Человеческое название источника по его id (для подписи у картинки в карточке «Поиск картинок»).
function sourceLabel(id) {
  return SOURCES[id]?.name || HOST_SOURCE_NAMES[id] || String(id || '');
}

// Описательный запрос — не название предмета («жираф», «Эйфелева башня»), а описание сцены («giraffe camouflaged in dappled shade of tree»). Такое понимает поиск
// по всему интернету (Google, Bing/DuckDuckGo), а каталоги вроде iNaturalist, Commons и музеев ищут по названию и описанием не кормятся. Описательным считаем
// запрос от четырёх значимых слов (служебные, английские и русские, не в счёт).
const DESCRIPTIVE_WORDS = 4;
const HOST_SHARE_DESCRIPTIVE = 3; // сколько мест из шести отдаём источнику хозяина (поиск по всему интернету) на описательный запрос
const RU_STOP_WORDS = new Set(['на', 'по', 'из', 'за', 'от', 'до', 'под', 'над', 'при', 'про', 'для', 'без', 'или', 'что', 'как', 'это', 'его', 'ее', 'её', 'их', 'так', 'там', 'тут', 'вот', 'вся', 'все', 'всё']);

function isDescriptiveQuery(query) {
  const sig = new Set(words(query).filter((w) => w.length >= 2 && !STOP_WORDS.has(w) && !RU_STOP_WORDS.has(w)));
  return sig.size >= DESCRIPTIVE_WORDS;
}

// Какие источники спросить для этого запроса и в каком порядке. hostIds — источники хозяина (ddg, bing, web).
// Каждый пункт плана: { id, score, share } — share: сколько мест в круговой выдаче (mergeCandidates) берёт источник за круг; у всех 1, а у источника хозяина
// на описательном запросе HOST_SHARE_DESCRIPTIVE. Такие источники ставятся первыми и в семёрку попадают независимо от веса (иначе стоки с ключами вытеснили бы их).
function planSources(query, keys = {}, hostIds = []) {
  const cat = classifyQuery(query);
  const cyr = hasCyrillic(query);
  const descriptive = isDescriptiveQuery(query);
  const ids = [...new Set([...Object.keys(SOURCES).filter((id) => !SOURCES[id].needs || keys[SOURCES[id].needs]), ...hostIds])];
  const ranked = ids
    .filter((id) => AFFINITY[id] && !(cyr && ENGLISH_ONLY.has(id)) && !(blockedUntil.get(id) > Date.now()))
    .map((id) => ({ id, score: Object.entries(AFFINITY[id]).reduce((sum, [c, w]) => sum + w * (cat[c] || 0), 0), share: descriptive && hostIds.includes(id) ? HOST_SHARE_DESCRIPTIVE : 1 }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!descriptive) return ranked.slice(0, MAX_SOURCES);
  return [...ranked.filter((s) => s.share > 1), ...ranked.filter((s) => s.share <= 1)].slice(0, MAX_SOURCES);
}

// Круговая выдача по плану: первая картинка каждого источника, потом вторая и т. д. Так первые кандидаты (их оценивают) — лучшие из разных источников.
// Источник с share > 1 берёт за круг до share картинок подряд (повторяющийся адрес не в счёт и места не занимает); не хватило у него — места отдаются остальным.
function mergeCandidates(plan, resultsById, limit = CANDIDATE_TOTAL) {
  const out = [];
  const seen = new Set();
  const queues = plan.map((p) => ({ id: p.id, share: p.share || 1, items: (resultsById[p.id] || []).slice() })).filter((q) => q.items.length);
  while (out.length < limit && queues.some((q) => q.items.length)) {
    for (const q of queues) {
      let taken = 0;
      while (taken < q.share && q.items.length && out.length < limit) {
        const item = q.items.shift();
        if (seen.has(item.url)) continue;
        seen.add(item.url);
        out.push({ ...item, source: q.id });
        taken++;
      }
      if (out.length >= limit) break;
    }
  }
  return out;
}

function cleanCredit(c) {
  if (!c || typeof c !== 'object') return null;
  const out = { source: cleanText(c.source, 40) };
  if (c.author) out.author = cleanText(c.author, 80);
  if (c.license) out.license = cleanText(c.license, 40);
  for (const k of ['page', 'authorPage', 'ping']) if (httpsUrl(c[k])) out[k] = c[k];
  return out.source ? out : null;
}

// Всё вместе: спросить подходящие источники одновременно (у каждого свой срок; опоздавших не ждём) и слить ответы.
// extra — источники хозяина: { ddg: (signal) => Promise<[{url, thumb?, credit?}]>, web: … }.
// Возвращает { items: [{url, thumb, title, credit, source}], plan, report: [{id, count, ms, error}] }.
async function searchSources(query, { keys = {}, limit = 6, total = CANDIDATE_TOTAL, deadlineMs = 6000, extra = {}, fetchImpl } = {}) {
  const plan = planSources(query, keys, Object.keys(extra));
  const results = {};
  const report = [];
  const controllers = [];

  const jobs = plan.map(async ({ id }) => {
    const controller = new AbortController();
    controllers.push(controller);
    const t0 = Date.now();
    const timer = setTimeout(() => controller.abort(), deadlineMs);
    try {
      let items;
      if (extra[id]) items = await extra[id](controller.signal);
      else if (blockedUntil.get(id) > Date.now()) items = [];
      else items = await SOURCES[id].run(query, { keys, limit, signal: controller.signal, fetch: fetchImpl });
      // Источники хозяина (поиск по всему интернету) бывают с адресами http://; наши — только https.
      results[id] = (items || []).filter((i) => i && (extra[id] ? /^https?:\/\/\S+$/i.test(i.url || '') : httpsUrl(i.url)) && !UNSUPPORTED_EXT.test(i.url));
      report.push({ id, count: results[id].length, ms: Date.now() - t0 });
    } catch (err) {
      // Лимит запросов или проверка «не робот» — источник отдыхает: следующие запросы к нему не тратят время.
      if (err.status === 429 || (err.status === 403 && err.html)) blockedUntil.set(id, Date.now() + BLOCK_MS);
      results[id] = [];
      report.push({ id, count: 0, ms: Date.now() - t0, error: err.name === 'AbortError' ? 'не ответил вовремя' : err.message });
    } finally {
      clearTimeout(timer);
    }
  });

  await Promise.race([Promise.allSettled(jobs), new Promise((resolve) => setTimeout(resolve, deadlineMs + 300))]);
  controllers.forEach((c) => c.abort());

  const items = mergeCandidates(plan, results, total).map((i) => ({ ...i, credit: cleanCredit(i.credit) }));
  return { items, plan, report };
}

// Одна база по выбору человека (кнопки «Искать одну» и «Искать 6» в карточке поиска): без плана и круговой выдачи спрашиваем только её и берём
// первые count картинок (1…CANDIDATE_TOTAL; лишнее и нечисловое сводится к границам, 1 по умолчанию).
// Выбор человека главнее плана: база, которую planSources для этого запроса не взял бы (русский запрос к английской базе, «отдыхающая» после лимита),
// здесь всё равно спрашивается; если она ничего не нашла, note объясняет, почему так могло выйти. Возвращает
// { items: [от нуля до count картинок], count (сколько просили на самом деле), report, note? } либо { status, error } (400 — база неизвестна или без ключа, 502 — база не ответила).
// limit тот же, что у общего поиска (6): адаптеры кэшируют ответ по запросу без учёта limit, и укороченный ответ достался бы следующему общему поиску.
async function searchOne(id, query, { keys = {}, deadlineMs = 6000, extra = {}, fetchImpl, count = 1 } = {}) {
  const want = Math.min(CANDIDATE_TOTAL, Math.max(1, Math.floor(Number(count)) || 1));
  const host = typeof extra[id] === 'function';
  const def = SOURCES[id];
  if (!host && !def) return { status: 400, error: `Неизвестная база «${id}»` };
  const name = sourceLabel(id);
  if (!host && def.needs && !keys[def.needs]) return { status: 400, error: `У базы «${name}» на сервере нет ключа, спросить её нельзя` };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  const t0 = Date.now();
  try {
    const found = host ? await extra[id](controller.signal) : await def.run(query, { keys, limit: 6, signal: controller.signal, fetch: fetchImpl });
    // Один и тот же адрес дважды не берём (Commons добирает результаты вторым поиском и может повторить первые).
    const seen = new Set();
    const good = (found || []).filter((i) => i && (host ? /^https?:\/\/\S+$/i.test(i.url || '') : httpsUrl(i.url)) && !UNSUPPORTED_EXT.test(i.url) && !seen.has(i.url) && seen.add(i.url));
    const report = { id, count: good.length, ms: Date.now() - t0 };
    if (!good.length) {
      const hints = [];
      if (ENGLISH_ONLY.has(id) && hasCyrillic(query)) hints.push('база понимает только английский запрос');
      if (id === 'inaturalist' || id === 'gbif') hints.push('она ищет животных и растения по названию вида, на длинное описание отвечает пустотой');
      return { items: [], count: want, report, note: `База «${name}» ничего не нашла по этому запросу${hints.length ? ` (${hints.join('; ')})` : ''}.` };
    }
    return { items: good.slice(0, want).map((i) => ({ ...i, source: id, credit: cleanCredit(i.credit) })), count: want, report };
  } catch (err) {
    if (err.status === 429 || (err.status === 403 && err.html)) blockedUntil.set(id, Date.now() + BLOCK_MS);
    return { status: 502, error: `База «${name}»: ${err.name === 'AbortError' ? 'не ответила вовремя' : err.message}`, report: { id, count: 0, ms: Date.now() - t0, error: err.message } };
  } finally {
    clearTimeout(timer);
  }
}

export default {
  SOURCES,
  AFFINITY,
  classifyQuery,
  planSources,
  mergeCandidates,
  searchSources,
  searchOne,
  isDescriptiveQuery,
  describeSources,
  sourceLabel,
  CANDIDATE_TOTAL,
  fetchHeadersFor,
  keywords,
  cleanCredit,
  // для проверок
  _blockedUntil: blockedUntil,
  _cache: cache,
};
