// Хранилище аккаунтов в Firestore (Firebase) вместо Deno KV. Тот же интерфейс get / put / delete / list, что у kv.js.
// Сервер Deno ходит в Firestore по REST под сервисным аккаунтом Firebase; страница из браузера в базу не обращается никогда.
//
// Документы лежат в коллекции «kv»: id документа = ключ в виде encodeURIComponent, поля key (строка), value (строка),
// expireAt (мс, только у ключей с ограниченным сроком). Просроченные ключи читаются как отсутствующие и удаляются при чтении.
//
// Нужна переменная окружения FIREBASE_SERVICE_ACCOUNT — содержимое JSON-файла сервисного аккаунта (Firebase → Настройки проекта → Сервисные аккаунты).
const COLLECTION = 'kv';
const SCOPE = 'https://www.googleapis.com/auth/datastore';

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const textBytes = (s) => new TextEncoder().encode(s);

async function importKey(pem) {
  const body = pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

export function makeFirestoreKv(serviceAccountJson, fetchFn = fetch) {
  const account = typeof serviceAccountJson === 'string' ? JSON.parse(serviceAccountJson) : serviceAccountJson;
  if (!account.client_email || !account.private_key || !account.project_id) throw new Error('В FIREBASE_SERVICE_ACCOUNT нет client_email, private_key или project_id');
  const base = `https://firestore.googleapis.com/v1/projects/${account.project_id}/databases/(default)/documents`;
  let signKey = null;
  let token = null;
  let tokenUntil = 0;

  async function accessToken() {
    if (token && Date.now() < tokenUntil - 60_000) return token;
    signKey ||= await importKey(account.private_key);
    const now = Math.floor(Date.now() / 1000);
    const head = b64url(textBytes(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
    const claims = b64url(textBytes(JSON.stringify({ iss: account.client_email, scope: SCOPE, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })));
    const signature = b64url(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signKey, textBytes(`${head}.${claims}`)));
    const res = await fetchFn('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${signature}` }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) throw new Error(`Firestore: не удалось получить доступ (${res.status} ${data.error_description || data.error || ''})`);
    token = data.access_token;
    tokenUntil = Date.now() + (Number(data.expires_in) || 3600) * 1000;
    return token;
  }

  async function call(method, url, body) {
    const res = await fetchFn(url, {
      method,
      headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 404 && method !== 'POST') return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Firestore ${method} ${res.status}: ${data.error?.message || ''}`);
    return data;
  }

  const docUrl = (key) => `${base}/${COLLECTION}/${encodeURIComponent(String(key))}`;
  const fieldsOf = (doc) => ({
    key: doc?.fields?.key?.stringValue,
    value: doc?.fields?.value?.stringValue,
    expireAt: doc?.fields?.expireAt?.integerValue ? Number(doc.fields.expireAt.integerValue) : 0,
  });
  const expired = (f) => f.expireAt > 0 && f.expireAt <= Date.now();

  return {
    async get(key, type) {
      const doc = await call('GET', docUrl(key));
      if (!doc) return null;
      const f = fieldsOf(doc);
      if (f.value === undefined) return null;
      if (expired(f)) { await call('DELETE', docUrl(key)).catch(() => {}); return null; }
      return type === 'json' ? JSON.parse(f.value) : f.value;
    },
    async put(key, value, options = {}) {
      const ttl = Number(options.expirationTtl);
      const fields = { key: { stringValue: String(key) }, value: { stringValue: String(value) } };
      if (ttl > 0) fields.expireAt = { integerValue: String(Date.now() + ttl * 1000) };
      await call('PATCH', docUrl(key), { fields });
    },
    async delete(key) {
      await call('DELETE', docUrl(key));
    },
    async list({ prefix = '', limit = 1000 } = {}) {
      const filters = [{ fieldFilter: { field: { fieldPath: 'key' }, op: 'GREATER_THAN_OR_EQUAL', value: { stringValue: prefix } } }];
      if (prefix) filters.push({ fieldFilter: { field: { fieldPath: 'key' }, op: 'LESS_THAN', value: { stringValue: prefix + '￿' } } });
      const rows = await call('POST', `${base}:runQuery`, {
        structuredQuery: { from: [{ collectionId: COLLECTION }], where: { compositeFilter: { op: 'AND', filters } }, orderBy: [{ field: { fieldPath: 'key' } }], limit },
      });
      const keys = [];
      for (const row of rows || []) {
        if (!row.document) continue;
        const f = fieldsOf(row.document);
        if (f.key && !expired(f)) keys.push({ name: f.key });
      }
      return { keys, list_complete: true };
    },
  };
}
