// One-time move of an amoCRM account into OpenCRM: export through the amoCRM API v4 into JSON
// files, then load them into PostgreSQL keeping the amoCRM IDs. See docs/AMOCRM_IMPORT.md.
import {mkdir,readFile,rename,writeFile,access,stat,unlink} from 'node:fs/promises';
import {join,resolve,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import {fullPermissions,defaultMemberPermissions} from '../server/security.js';
import {taskTypes} from '../src/task-types.js';

// ---------------------------------------------------------------- export

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// GET over HTTPS, optionally through an HTTP CONNECT proxy (http://user:pass@host:port).
function httpsGet(url, headers, proxyUrl, timeoutMs = 60000, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const finish = socket => {
      const request = https.request({host: target.hostname, port: target.port || 443, path: target.pathname + target.search, method, headers, timeout: timeoutMs,
        ...(socket ? {agent: false, createConnection: () => tls.connect({socket, servername: target.hostname})} : {})}, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve({status: response.statusCode, headers: response.headers, raw: Buffer.concat(chunks), get body() { return this.raw.toString('utf8'); }}));
        response.on('error', reject);
      });
      request.on('timeout', () => request.destroy(new Error('timeout')));
      request.on('error', reject);
      request.end(body || undefined);
    };
    if (!proxyUrl) return finish(null);
    const proxy = new URL(proxyUrl);
    const auth = proxy.username ? {'Proxy-Authorization': `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}`} : {};
    const connect = http.request({host: proxy.hostname, port: proxy.port || 80, method: 'CONNECT', path: `${target.hostname}:${target.port || 443}`, headers: {Host: `${target.hostname}:${target.port || 443}`, ...auth}, timeout: timeoutMs});
    connect.on('connect', (response, socket) => {
      if (response.statusCode !== 200) { socket.destroy(); return reject(new Error(`proxy CONNECT ${response.statusCode}`)); }
      finish(socket);
    });
    connect.on('timeout', () => connect.destroy(new Error('proxy timeout')));
    connect.on('error', reject);
    connect.end();
  });
}

export function amoClient({baseUrl, token, proxyUrl = '', minIntervalMs = 160, retries = 8, get = httpsGet, transport = (url, headers, proxy, method, body) => httpsGet(url, headers, proxy, 60000, method, body), log = () => {}} = {}) {
  if (!baseUrl || !token) throw new Error('Нужны AMO_BASE_URL (https://<поддомен>.amocrm.ru) и AMO_ACCESS_TOKEN (долгосрочный токен интеграции)');
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:') throw new Error('AMO_BASE_URL должен начинаться с https://');
  let last = 0;
  const direct = new Set();
  async function request(path, params = {}) {
    const url = new URL(path, base.origin);
    for (const [key, value] of Object.entries(params)) for (const item of [].concat(value)) url.searchParams.append(key, String(item));
    for (let attempt = 1; ; attempt++) {
      const slot = Math.max(Date.now(), last + minIntervalMs);
      last = slot;
      if (slot > Date.now()) await sleep(slot - Date.now());
      let response;
      const headers = {Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': 'opencrm-import'};
      try {
        try { response = await get(url.href, headers, direct.has(url.hostname) ? '' : proxyUrl); }
        catch (error) {
          // A proxy may refuse some amoCRM hosts: those are then reached directly.
          if (!proxyUrl || direct.has(url.hostname) || !/^proxy CONNECT/.test(error.message)) throw error;
          direct.add(url.hostname);
          log(`  ${url.hostname}: прокси не пускает, запросы напрямую`);
          response = await get(url.href, headers, '');
        }
      } catch (error) {
        if (attempt >= retries) throw new Error(`${url.pathname}: ${error.message}`);
        log(`  сеть: ${error.message}, повтор ${attempt}`);
        await sleep(Math.min(30000, 1000 * 2 ** (attempt - 1)));
        continue;
      }
      if (response.status === 204) return null;
      if (response.status === 401 || response.status === 403) throw new Error(`amoCRM ответил ${response.status} на ${url.pathname}: проверьте токен и его права`);
      if (response.status === 429 || response.status >= 500) {
        if (attempt >= retries) throw new Error(`amoCRM ответил ${response.status} на ${url.pathname}`);
        log(`  amoCRM ${response.status}, повтор ${attempt}`);
        await sleep(Math.min(30000, 1500 * 2 ** (attempt - 1)));
        continue;
      }
      if (response.status !== 200) throw new Error(`amoCRM ответил ${response.status} на ${url.pathname}: ${response.body.slice(0, 300)}`);
      return JSON.parse(response.body);
    }
  }
  // Binary GET (files on amoCRM Drive and the storage it redirects to). Redirects are followed; the
  // token goes to amoCRM hosts only. Files go directly first (proxies often allow only the API
  // hosts); after a network error the next attempt switches between direct and proxy.
  async function download(url) {
    const trusted = host => host === base.hostname || /(^|\.)(amocrm\.(ru|com)|kommo\.com)$/i.test(host);
    for (let hop = 0, attempt = 1, viaProxy = false; hop < 6;) {
      const target = new URL(url);
      const slot = Math.max(Date.now(), last + minIntervalMs);
      last = slot;
      if (slot > Date.now()) await sleep(slot - Date.now());
      let response;
      try { response = await get(target.href, {...(trusted(target.hostname) ? {Authorization: `Bearer ${token}`} : {}), 'User-Agent': 'opencrm-import'}, viaProxy ? proxyUrl : '', 120000); }
      catch (error) {
        if (attempt++ >= retries) throw error;
        if (proxyUrl) viaProxy = !viaProxy;
        await sleep(Math.min(10000, 500 * 2 ** attempt));
        continue;
      }
      if ([301, 302, 303, 307, 308].includes(response.status) && response.headers?.location) { url = new URL(response.headers.location, target).href; hop++; continue; }
      if ((response.status === 429 || response.status >= 500) && attempt++ < retries) { await sleep(Math.min(30000, 1500 * 2 ** attempt)); continue; }
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
      return {data: response.raw ?? Buffer.from(response.body ?? ''), type: String(response.headers?.['content-type'] || '').split(';')[0].trim()};
    }
    throw new Error('слишком много перенаправлений');
  }
  async function list(path, key, params = {}, limit = 250, onPage = () => {}) {
    const items = [];
    for (let page = 1; ; page++) {
      const data = await request(path, {...params, limit, page});
      const chunk = data?._embedded?.[key] || [];
      items.push(...chunk);
      onPage(page, items.length);
      if (!chunk.length || !data._links?.next) return items;
    }
  }
  // Writes (POST, PATCH, DELETE) share the rate limit. 429 is always tried again; a 5xx or a network
  // error only for PATCH and DELETE — a POST may have been done already, so it is not repeated here.
  async function send(method, path, body) {
    const url = new URL(path, base.origin);
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    for (let attempt = 1; ; attempt++) {
      const slot = Math.max(Date.now(), last + minIntervalMs);
      last = slot;
      if (slot > Date.now()) await sleep(slot - Date.now());
      const headers = {Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': 'opencrm-sync', ...(payload ? {'Content-Type': 'application/json', 'Content-Length': payload.length} : {})};
      let response;
      try {
        try { response = await transport(url.href, headers, direct.has(url.hostname) ? '' : proxyUrl, method, payload); }
        catch (error) {
          if (!proxyUrl || direct.has(url.hostname) || !/^proxy CONNECT/.test(error.message)) throw error;
          direct.add(url.hostname);
          response = await transport(url.href, headers, '', method, payload);
        }
      } catch (error) {
        if (method === 'POST' || attempt >= retries) throw new Error(`${method} ${url.pathname}: ${error.message}`);
        await sleep(Math.min(30000, 1000 * 2 ** (attempt - 1)));
        continue;
      }
      if (response.status === 429 || response.status >= 500 && method !== 'POST') {
        if (attempt >= retries) throw new Error(`amoCRM ответил ${response.status} на ${method} ${url.pathname}`);
        log(`  amoCRM ${response.status} на ${method}, повтор ${attempt}`);
        await sleep(Math.min(30000, 1500 * 2 ** (attempt - 1)));
        continue;
      }
      if (response.status === 204) return null;
      if (response.status >= 200 && response.status < 300) return response.body ? JSON.parse(response.body) : null;
      throw new Error(`amoCRM ответил ${response.status} на ${method} ${url.pathname}: ${String(response.body || '').slice(0, 500)}`);
    }
  }
  return {request, list, download, send};
}

// What is exported, file by file: [file, path, embedded key, params, page size].
export const exportPlan = [
  ['users', '/api/v4/users', 'users', {}, 250],
  ['custom_fields_leads', '/api/v4/leads/custom_fields', 'custom_fields', {}, 50],
  ['custom_fields_contacts', '/api/v4/contacts/custom_fields', 'custom_fields', {}, 50],
  ['custom_fields_companies', '/api/v4/companies/custom_fields', 'custom_fields', {}, 50],
  ['companies', '/api/v4/companies', 'companies', {}, 250],
  ['contacts', '/api/v4/contacts', 'contacts', {}, 250],
  ['leads', '/api/v4/leads', 'leads', {with: 'contacts,loss_reason'}, 250],
  ['tasks', '/api/v4/tasks', 'tasks', {}, 250],
  ['notes_leads', '/api/v4/leads/notes', 'notes', {}, 250],
  ['notes_contacts', '/api/v4/contacts/notes', 'notes', {}, 250],
  ['notes_companies', '/api/v4/companies/notes', 'notes', {}, 250],
  ['events', '/api/v4/events', 'events', {'filter[type]': 'lead_status_changed'}, 100],
  // Every event of deals, contacts and companies: the history of the cards (field changes, tags, responsible, links...).
  ['events_history', '/api/v4/events', 'events', {'filter[entity][]': ['lead', 'contact', 'company']}, 100]
];
// Files added to the export later: an older export without them still loads (without that part).
const optionalFiles = new Set(['events_history', 'event_types']);

const exists = path => access(path).then(() => true, () => false);
async function saveJson(path, data) { await writeFile(`${path}.tmp`, JSON.stringify(data)); await rename(`${path}.tmp`, path); }

// Downloads everything into dir. Files already there are kept (a broken export resumes), unless force.
export async function exportAccount({client, dir, force = false, log = console.log}) {
  await mkdir(dir, {recursive: true});
  const counts = {};
  // The account and pipelines are small: they are always downloaded again.
  {
    const account = await client.request('/api/v4/account', {with: 'task_types,datetime_settings,drive_url'});
    const timezone = account.datetime_settings?.timezone || account._embedded?.datetime_settings?.timezone || account.timezone || 'Europe/Moscow';
    await saveJson(join(dir, 'account.json'), {id: account.id, name: account.name, subdomain: account.subdomain, timezone, drive_url: account.drive_url || '', task_types: account._embedded?.task_types || []});
    log(`Аккаунт: ${account.name} (${account.subdomain}), часовой пояс ${timezone}`);
  }
  {
    const pipelinesFile = join(dir, 'pipelines.json');
    const pipelines = (await client.request('/api/v4/leads/pipelines'))?._embedded?.pipelines || [];
    await saveJson(pipelinesFile, pipelines);
    log(`Воронки: ${pipelines.length}`);
  }
  {
    // Names of event types, used for events the load does not describe itself.
    const typesFile = join(dir, 'event_types.json');
    if (force || !await exists(typesFile)) {
      let types = [];
      try {
        const data = await client.request('/api/v4/events/types', {language_code: 'ru'});
        types = Object.values(data?._embedded || {}).find(Array.isArray) || [];
      } catch (error) { log(`  типы событий: ${error.message}`); }
      await saveJson(typesFile, types.map(type => ({key: type.key, lang: type.lang})));
    }
  }
  for (const [file, path, key, params, limit] of exportPlan) {
    const target = join(dir, `${file}.json`);
    if (!force && await exists(target)) { counts[file] = JSON.parse(await readFile(target, 'utf8')).length; log(`${file}: уже выгружено (${counts[file]})`); continue; }
    let lastLog = 0;
    const items = await client.list(path, key, params, limit, (page, total) => { if (Date.now() - lastLog > 5000) { lastLog = Date.now(); log(`  ${file}: страница ${page}, записей ${total}`); } });
    await saveJson(target, items);
    counts[file] = items.length;
    log(`${file}: ${items.length}`);
  }
  counts.files = await exportFiles({client, dir, log});
  await saveJson(join(dir, 'export-meta.json'), {exported_at: new Date().toISOString(), counts});
  return counts;
}

// Files attached to notes live on amoCRM Drive. Each goes to files/<note id>; files.json describes them.
// A failed download is recorded and retried on the next run.
async function exportFiles({client, dir, log}) {
  const account = JSON.parse(await readFile(join(dir, 'account.json'), 'utf8'));
  const listFile = join(dir, 'files.json');
  const known = new Map((await exists(listFile) ? JSON.parse(await readFile(listFile, 'utf8')) : []).map(item => [item.note_id, item]));
  await mkdir(join(dir, 'files'), {recursive: true});
  const result = [];
  for (const [file, entity] of [['notes_leads', 'leads'], ['notes_contacts', 'contacts'], ['notes_companies', 'companies']]) {
    for (const note of JSON.parse(await readFile(join(dir, `${file}.json`), 'utf8'))) {
      const p = note.params || {};
      if (!p.file_uuid) continue;
      const item = {note_id: note.id, entity, entity_id: note.entity_id, created_by: note.created_by, created_at: note.created_at, name: String(p.original_name || p.file_name || `file-${note.id}`), file_uuid: p.file_uuid};
      const path = join(dir, 'files', String(note.id)), before = known.get(note.id);
      if (before && !before.error && await exists(path)) { result.push(before); continue; }
      try {
        if (!account.drive_url) throw new Error('amoCRM не сообщил адрес Drive');
        const drive = account.drive_url.replace(/\/+$/, '');
        let href = '', mime = '';
        try {
          const meta = await client.request(`${drive}/v1.0/files/${p.file_uuid}`);
          href = meta?._links?.download?.href || '';
          mime = meta?.metadata?.mime_type || meta?.mime_type || '';
        } catch (error) { if (/401|403/.test(error.message)) throw error; }
        if (!href) href = `${drive}/download/${p.file_uuid}/${p.version_uuid}/${encodeURIComponent(p.file_name || item.name)}`;
        const {data, type} = await client.download(href);
        await writeFile(path, data);
        result.push({...item, mime_type: mime || type || 'application/octet-stream', size: data.length});
      } catch (error) {
        result.push({...item, error: error.message});
        log(`  файл ${item.name} (примечание ${note.id}): ${error.message}`);
      }
    }
  }
  await saveJson(listFile, result);
  const failed = result.filter(item => item.error).length;
  log(`files: ${result.length - failed}${failed ? `, не скачано ${failed} (повторный запуск export попробует снова)` : ''}`);
  return result.length - failed;
}

export async function readDump(dir) {
  const read = async name => JSON.parse(await readFile(join(dir, `${name}.json`), 'utf8'));
  const dump = {account: await read('account'), pipelines: await read('pipelines')};
  for (const [file] of exportPlan) dump[file] = optionalFiles.has(file) && !await exists(join(dir, `${file}.json`)) ? null : await read(file);
  dump.event_types = await exists(join(dir, 'event_types.json')) ? await read('event_types') : [];
  dump.files = await exists(join(dir, 'files.json')) ? (await read('files')).map(item => ({...item, path: join(dir, 'files', String(item.note_id))})) : [];
  return dump;
}

// ---------------------------------------------------------------- transform

const pad = n => String(n).padStart(2, '0');
const unix = value => { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : null; };
export const toText = value => { const n = unix(value); return n === null ? null : new Date(n * 1000).toISOString().slice(0, 19).replace('T', ' '); };
const toIso = value => { const n = unix(value); return n === null ? null : new Date(n * 1000).toISOString(); };
// Calendar parts of a moment in the account's time zone.
function localParts(seconds, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).formatToParts(new Date(seconds * 1000)).map(p => [p.type, p.value]));
  return parts;
}
const safeZone = zone => { if (!zone) return 'Europe/Moscow'; try { new Intl.DateTimeFormat('en-GB', {timeZone: zone}); return zone; } catch { return 'Europe/Moscow'; } };
const clip = (value, max) => { const text = value === null || value === undefined ? '' : String(value); return text.length > max ? text.slice(0, max) : text; };
const tagsOf = record => (record?._embedded?.tags || []).map(tag => String(tag.name || '').replace(/,/g, ' ').trim()).filter(Boolean).join(', ');
const valuesOf = (record, code) => (record.custom_fields_values || []).filter(field => field.field_code === code).flatMap(field => field.values || []).map(v => String(v.value ?? '').trim()).filter(Boolean);

const systemFieldCodes = {contacts: ['PHONE', 'EMAIL', 'POSITION'], companies: ['PHONE', 'EMAIL', 'WEB', 'ADDRESS'], leads: []};
const entityTypes = {leads: 'deal', contacts: 'contact', companies: 'company'};
function fieldType(type) {
  if (['numeric', 'price', 'monetary'].includes(type)) return 'number';
  if (['date', 'date_time', 'birthday'].includes(type)) return 'date';
  if (type === 'url') return 'url';
  if (['select', 'radiobutton', 'category', 'checkbox'].includes(type)) return 'select';
  return 'text';
}

const presetTaskTypes = {1: 'Связаться', 2: 'Встреча', 3: 'Письмо'};

const plain = value => value === null || value === undefined ? '' : typeof value === 'object' ? String(value.name ?? value.text ?? value.title ?? JSON.stringify(value)) : String(value).trim();
function noteBody(note) {
  const p = note.params || {};
  const text = plain(p.text);
  switch (note.note_type) {
    case 'common': return text;
    case 'call_in': case 'call_out': {
      const lines = [note.note_type === 'call_in' ? 'Входящий звонок' : 'Исходящий звонок'];
      if (p.phone) lines.push(`Телефон: ${p.phone}`);
      if (Number(p.duration) > 0) lines.push(`Длительность: ${Math.floor(p.duration / 60)}:${pad(p.duration % 60)}`);
      if (p.call_result) lines.push(`Результат: ${p.call_result}`);
      if (p.call_status !== undefined && p.call_status !== null) lines.push(`Статус: ${p.call_status}`);
      if (p.link) lines.push(`Запись: ${p.link}`);
      if (p.source) lines.push(`Источник: ${p.source}`);
      if (text) lines.push(text);
      return lines.join('\n');
    }
    case 'sms_in': case 'sms_out': return `${note.note_type === 'sms_in' ? 'Входящее SMS' : 'Исходящее SMS'}${p.phone ? ` (${p.phone})` : ''}: ${text}`;
    case 'service_message': case 'extended_service_message': return [plain(p.service), plain(p.text)].filter(Boolean).join(': ');
    case 'attachment': return `Файл: ${p.original_name || p.file_name || 'без имени'}`;
    case 'amomail_message': {
      const who = person => person ? [person.name, person.email && `<${person.email}>`].filter(Boolean).join(' ') : '';
      const lines = [p.income ? 'Входящее письмо' : 'Исходящее письмо'];
      if (who(p.from)) lines.push(`От: ${who(p.from)}`);
      if (who(p.to)) lines.push(`Кому: ${who(p.to)}`);
      if (p.subject) lines.push(`Тема: ${p.subject}`);
      if (Number(p.attach_cnt) > 0) lines.push(`Вложений: ${p.attach_cnt}`);
      if (p.content_summary) lines.push('', String(p.content_summary));
      return lines.join('\n');
    }
    case 'lead_auto_created': return `Сделка создана автоматически${p.type ? ` (${p.type})` : ''}`;
    case 'link_followed': return `Переход по ссылке: ${p.url || ''}`;
    case 'geolocation': return [text, p.address].filter(Boolean).join('\n');
    default: return text || (Object.keys(p).length ? JSON.stringify(p) : '');
  }
}

// Card history from amoCRM events: one text row per change, in the wording OpenCRM uses for its own
// history («Поле «X»: было → стало», «Этап изменён: …»). Events that only point at a note (calls,
// SMS, notes, files) are skipped: the notes themselves are loaded.
const noteEvents = new Set(['common_note_added', 'attachment_note_added', 'targeting_in_note_added', 'targeting_out_note_added', 'geo_note_added', 'service_note_added', 'site_visit_note_added', 'message_to_cashier_note_added', 'incoming_call', 'outgoing_call', 'incoming_sms', 'outgoing_sms', 'link_followed', 'task_result_added']);
const fixedEvents = {
  lead_added: 'Сделка создана', contact_added: 'Контакт создан', company_added: 'Компания создана',
  lead_deleted: 'Сделка удалена', lead_restored: 'Сделка восстановлена', contact_deleted: 'Контакт удалён', contact_restored: 'Контакт восстановлен', company_deleted: 'Компания удалена', company_restored: 'Компания восстановлена',
  incoming_chat_message: 'Входящее сообщение в чате', outgoing_chat_message: 'Исходящее сообщение в чате', entity_direct_message: 'Сообщение во внутреннем чате',
  common_note_deleted: 'Примечание удалено', entity_merged: 'Объединено с дублем', robot_replied: 'Ответ бота', intent_identified: 'Бот определил намерение', transaction_added: 'Добавлена покупка', key_action_completed: 'Ключевое действие выполнено'
};
const linkWords = {lead: ['Сделка привязана', 'Сделка отвязана'], contact: ['Контакт привязан', 'Контакт отвязан'], company: ['Компания привязана', 'Компания отвязана'], customer: ['Покупатель привязан', 'Покупатель отвязан']};
const leaf = value => value === null || value === undefined ? '' : typeof value !== 'object' ? String(value).trim() : Object.values(value).map(leaf).filter(Boolean).join(', ');
const shown = value => { const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim(); return text ? clip(text, 300) : '—'; };

function historyRows(dump, rows, {uid, dealIds, contactIds, companyIds, warn}) {
  const targets = {lead: ['deal', dealIds], contact: ['contact', contactIds], company: ['company', companyIds]};
  const userNames = new Map(dump.users.map(user => [Number(user.id), String(user.name || user.email || `#${user.id}`)]));
  const pipelineNames = new Map(dump.pipelines.map(p => [Number(p.id), String(p.name || `Воронка ${p.id}`)]));
  const statusNames = new Map(dump.pipelines.flatMap(p => (p._embedded?.statuses || []).map(s => [`${p.id}:${s.id}`, String(s.name || `Этап ${s.id}`)])));
  const fieldNames = new Map(['leads', 'contacts', 'companies'].flatMap(entity => (dump[`custom_fields_${entity}`] || []).map(f => [Number(f.id), String(f.name || `Поле ${f.id}`)])));
  const names = {lead: new Map(dump.leads.map(r => [Number(r.id), r.name])), contact: new Map(dump.contacts.map(r => [Number(r.id), r.name || [r.first_name, r.last_name].filter(Boolean).join(' ')])), company: new Map(dump.companies.map(r => [Number(r.id), r.name]))};
  const typeNames = new Map((dump.event_types || []).map(type => [type.key, type.lang]));
  const user = id => Number(id) > 0 ? userNames.get(Number(id)) || `#${id}` : '';
  const describe = event => {
    const before = event.value_before || [], after = event.value_after || [];
    const type = String(event.type || '');
    if (noteEvents.has(type)) return [];
    if (fixedEvents[type]) return [fixedEvents[type]];
    if (type === 'lead_status_changed') {
      const from = before[0]?.lead_status, to = after[0]?.lead_status;
      if (!to) return [];
      const moved = from && Number(from.pipeline_id) !== Number(to.pipeline_id);
      return [`Этап изменён: ${statusNames.get(`${to.pipeline_id}:${to.id}`) || `Этап ${to.id}`}${moved ? ` · Перенос в воронку «${pipelineNames.get(Number(to.pipeline_id)) || to.pipeline_id}»` : ''}`];
    }
    if (type === 'custom_field_value_changed' || /^custom_field_\d+_value_changed$/.test(type)) {
      const ids = [...new Set([...before, ...after].map(v => v.custom_field_value?.field_id).filter(id => id !== undefined && id !== null))];
      const text = (list, id) => list.map(v => v.custom_field_value).filter(v => v && v.field_id === id).map(v => leaf(v.text)).filter(Boolean).join(', ');
      return ids.map(id => `Поле «${fieldNames.get(Number(id)) || `Поле ${id}`}»: ${shown(text(before, id))} → ${shown(text(after, id))}`);
    }
    const plainField = {sale_field_changed: 'Бюджет', name_field_changed: 'Название', ltv_field_changed: 'Сумма покупок'}[type];
    if (plainField) return [`Поле «${plainField}»: ${shown(leaf(before))} → ${shown(leaf(after))}`];
    if (type === 'entity_responsible_changed') return [`Поле «Ответственный»: ${shown(user(before[0]?.responsible_user?.id))} → ${shown(user(after[0]?.responsible_user?.id))}`];
    if (type === 'entity_tag_added' || type === 'entity_tag_deleted') {
      const tags = (type === 'entity_tag_added' ? after : before).map(v => leaf(v.tag?.name)).filter(Boolean).join(', ');
      return [`${type === 'entity_tag_added' ? 'Теги добавлены' : 'Теги удалены'}: ${tags || '—'}`];
    }
    if (/_(un)?linked$/.test(type)) {
      const unlinked = type.endsWith('_unlinked');
      const ref = [...after, ...before].map(v => v.link || v.unlink).find(Boolean)?.entity;
      if (!ref) return [];
      const name = names[ref.type]?.get(Number(ref.id));
      return [`${(linkWords[ref.type] || ['Привязана запись', 'Отвязана запись'])[unlinked ? 1 : 0]}: ${name ? clip(String(name), 255) : `#${ref.id}`}`];
    }
    if (type === 'nps_rate_added') return [`Оценка NPS: ${leaf(after[0]?.nps?.rate) || '—'}`];
    return [typeNames.get(type) || type];
  };
  const events = [...(dump.events_history || [])].sort((a, b) => a.created_at - b.created_at || String(a.id).localeCompare(String(b.id)));
  for (const event of events) {
    const [type, ids] = targets[event.entity_type] || [];
    if (!type || !ids.has(Number(event.entity_id))) continue;
    for (const text of describe(event)) {
      const row = {user_id: uid(event.created_by), event: clip(text, 2000), created_at: toText(event.created_at) ?? toText(Date.now() / 1000), amo_event_id: clip(event.id, 64)};
      if (type === 'deal') rows.activity.push({deal_id: Number(event.entity_id), ...row});
      else rows.entity_activity.push({entity_type: type, entity_id: Number(event.entity_id), ...row});
    }
  }
  if (dump.events_history == null && dump.leads.length) warn('В выгрузке нет истории событий (выгрузка сделана старой версией скрипта): запустите export ещё раз');
}

// Turns an export into table rows. existing = what the target database already has. The amoCRM sync
// (server/amocrm-sync.js) turns a small batch of changes and passes more of the database:
//   userMap(amoUserId) → OpenCRM user ID or null — no users are created;
//   stages: [{id, pipeline_id, kind, sort_order}] — stage IDs of the database instead of new ones;
//   known: {deal, contact, company} — IDs already in the database, so links to them are kept.
//   strictStages: a deal with an unknown stage is skipped instead of going to the first stage.
export function transform(dump, existing = {users: [], maxStageId: 0}) {
  const warnings = {};
  const warn = (key, example) => { warnings[key] ??= {count: 0, examples: []}; warnings[key].count++; if (example !== undefined && warnings[key].examples.length < 5) warnings[key].examples.push(example); };
  const zone = safeZone(dump.account?.timezone);
  const rows = {users: [], pipelines: [], stages: [], custom_fields: [], custom_field_values: [], companies: [], contacts: [], deals: [], deal_contacts: [], tasks: [], notes: [], entity_notes: [], deal_stage_changes: [], activity: [], entity_activity: []};

  // Users. An e-mail that already has an account here keeps that account; amoCRM records point at it.
  const userMap = new Map(), byEmail = new Map(existing.users.map(user => [user.email.toLowerCase(), user.id])), takenIds = new Set(existing.users.map(user => user.id)), mergedUsers = [];
  for (const user of existing.userMap ? [] : dump.users) {
    const email = String(user.email || `amo-user-${user.id}@import.invalid`).trim().toLowerCase();
    if (byEmail.has(email)) { userMap.set(user.id, byEmail.get(email)); if (byEmail.get(email) !== user.id) mergedUsers.push({amo_id: user.id, email, id: byEmail.get(email)}); continue; }
    if (takenIds.has(user.id)) throw new Error(`ID пользователя amoCRM ${user.id} уже занят другим пользователем OpenCRM`);
    const admin = !!user.rights?.is_admin;
    rows.users.push({id: user.id, name: clip(user.name || email, 120), email, password_hash: 'x:y', role: admin ? 'admin' : 'member', permissions_json: JSON.stringify(admin ? fullPermissions() : defaultMemberPermissions()), disabled_at: user.rights?.is_active === false ? toText(Date.now() / 1000) : null});
    userMap.set(user.id, user.id); byEmail.set(email, user.id); takenIds.add(user.id);
  }
  const uid = existing.userMap ? id => existing.userMap(Number(id)) ?? null : id => userMap.get(Number(id)) ?? null;

  // Pipelines and stages; 142/143 are shared in amoCRM, every pipeline here gets its own won/lost stage.
  const stageIds = new Set(), closing = new Map(), firstStage = new Map(), stageKind = new Map();
  let nextStageId = Math.max(existing.maxStageId || 0, ...dump.pipelines.flatMap(p => (p._embedded?.statuses || []).map(s => s.id))) + 1;
  for (const pipeline of [...dump.pipelines].sort((a, b) => a.sort - b.sort || a.id - b.id)) {
    rows.pipelines.push({id: pipeline.id, name: clip(pipeline.name, 120) || `Воронка ${pipeline.id}`, sort_order: rows.pipelines.length});
    const statuses = [...(pipeline._embedded?.statuses || [])].sort((a, b) => (a.type === 1 ? -1 : 0) - (b.type === 1 ? -1 : 0) || a.sort - b.sort || a.id - b.id);
    const active = statuses.filter(s => s.id !== 142 && s.id !== 143);
    const won = statuses.find(s => s.id === 142), lost = statuses.find(s => s.id === 143);
    const ordered = [...active.map(s => ({...s, kind: 'active', newId: s.id})),
      {...(won || {name: 'Успешно реализовано', color: '#a9ddb1'}), kind: 'won', newId: nextStageId++},
      {...(lost || {name: 'Закрыто и не реализовано', color: '#e8b7b7'}), kind: 'lost', newId: nextStageId++}];
    closing.set(pipeline.id, {142: ordered.at(-2).newId, 143: ordered.at(-1).newId});
    ordered.forEach((stage, index) => {
      rows.stages.push({id: stage.newId, pipeline_id: pipeline.id, name: clip(stage.name, 120) || `Этап ${stage.newId}`, color: /^#[0-9a-f]{3,8}$/i.test(stage.color || '') ? stage.color : '#dce7fb', sort_order: index, kind: stage.kind});
      stageIds.add(stage.newId); stageKind.set(stage.newId, stage.kind);
    });
    if (active.length) firstStage.set(pipeline.id, active[0].id);
  }
  if (existing.stages) {
    closing.clear(); firstStage.clear(); stageIds.clear(); stageKind.clear();
    for (const stage of [...existing.stages].sort((a, b) => a.sort_order - b.sort_order || a.id - b.id)) {
      stageIds.add(stage.id); stageKind.set(stage.id, stage.kind);
      const ids = closing.get(stage.pipeline_id) || {};
      if (stage.kind === 'won') ids[142] ??= stage.id;
      if (stage.kind === 'lost') ids[143] ??= stage.id;
      closing.set(stage.pipeline_id, ids);
      if (stage.kind === 'active' && !firstStage.has(stage.pipeline_id)) firstStage.set(stage.pipeline_id, stage.id);
    }
  }
  const mapStatus = (pipelineId, statusId) => {
    if (statusId === 142 || statusId === 143) return closing.get(Number(pipelineId))?.[statusId] ?? null;
    return statusId ?? null;
  };

  // Custom fields.
  const fields = new Map();
  for (const entity of ['leads', 'contacts', 'companies']) {
    const names = new Set();
    for (const field of [...dump[`custom_fields_${entity}`]].sort((a, b) => a.sort - b.sort || a.id - b.id)) {
      if (systemFieldCodes[entity].includes(field.code)) continue;
      const type = fieldType(field.type);
      let name = clip(String(field.name || '').trim() || `Поле ${field.id}`, 120);
      if (names.has(name.toLowerCase())) { warn('Повторяющиеся названия полей (добавлен id)', `${entity}: ${name}`); name = clip(`${name} (${field.id})`, 120); }
      names.add(name.toLowerCase());
      const options = type !== 'select' ? [] : field.type === 'checkbox' ? ['Да', 'Нет'] : [...new Set((field.enums || []).sort((a, b) => a.sort - b.sort).map(e => clip(String(e.value ?? '').trim(), 200)).filter(Boolean))];
      if (field.type === 'multiselect') warn('Мультисписки перенесены текстом через запятую', `${entity}: ${name}`);
      const row = {id: field.id, entity_type: entityTypes[entity], name, field_type: type, options, sort_order: rows.custom_fields.length, amoType: field.type};
      fields.set(field.id, row); rows.custom_fields.push(row);
    }
  }
  const dateOf = value => {
    const n = unix(value);
    if (n !== null) { const p = localParts(n, zone); return `${p.year}-${p.month}-${p.day}`; }
    const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value || ''));
    return match ? match[1] : '';
  };
  const saveValues = (record, entity) => {
    for (const item of record.custom_fields_values || []) {
      if (systemFieldCodes[entity].includes(item.field_code)) continue;
      const field = fields.get(item.field_id);
      if (!field) { warn('Значения удалённых полей пропущены', `${entity} ${record.id}: ${item.field_name || item.field_id}`); continue; }
      const values = (item.values || []).map(v => v.value).filter(v => v !== null && v !== undefined && v !== '');
      if (!values.length) continue;
      let value;
      if (field.amoType === 'checkbox') value = values[0] === true || values[0] === 'true' || values[0] === 1 || values[0] === '1' ? 'Да' : 'Нет';
      else if (field.field_type === 'date') value = dateOf(values[0]);
      else if (field.field_type === 'number') value = String(values[0]).replace(/\s+/g, '').replace(',', '.');
      else if (field.field_type === 'select') { value = clip(String(values[0]).trim(), 200); if (value && !field.options.includes(value)) { field.options.push(value); warn('Варианты списков добавлены из значений', `${field.name}: ${value}`); } }
      else value = values.map(v => typeof v === 'object' ? JSON.stringify(v) : String(v)).join(', ');
      if (!value) continue;
      if (value.length > 5000) { warn('Значения полей обрезаны до 5000 символов', `${entity} ${record.id}: ${field.name}`); value = value.slice(0, 5000); }
      rows.custom_field_values.push({field_id: field.id, entity_id: record.id, value});
    }
  };

  // Companies, contacts, deals.
  const companyIds = new Set(existing.known?.company), contactIds = new Set(existing.known?.contact), dealIds = new Set(existing.known?.deal), dealStage = new Map();
  for (const company of dump.companies) {
    rows.companies.push({id: company.id, name: clip(String(company.name || '').trim() || `Компания #${company.id}`, 255), owner_id: uid(company.responsible_user_id), website: clip(valuesOf(company, 'WEB').join(', '), 255), address: clip(valuesOf(company, 'ADDRESS').join(', '), 500), phone: clip(valuesOf(company, 'PHONE').join(', '), 255), email: clip(valuesOf(company, 'EMAIL').join(', ').toLowerCase(), 254), notes: '', tags: tagsOf(company), created_at: toText(company.created_at) ?? toText(Date.now() / 1000), updated_at: toText(company.updated_at) ?? toText(company.created_at) ?? toText(Date.now() / 1000), deleted_at: null});
    companyIds.add(company.id); saveValues(company, 'companies');
  }
  for (const contact of dump.contacts) {
    const companyId = contact._embedded?.companies?.[0]?.id ?? null;
    const telegramField = (contact.custom_fields_values || []).find(field => /telegram|телеграм/i.test(field.field_name || ''));
    const imTelegram = (contact.custom_fields_values || []).filter(field => field.field_code === 'IM').flatMap(field => field.values || []).find(v => v.enum_code === 'TELEGRAM');
    const name = String(contact.name || '').trim() || [contact.first_name, contact.last_name].filter(Boolean).join(' ').trim() || `Контакт #${contact.id}`;
    rows.contacts.push({id: contact.id, name: clip(name, 255), company_id: companyIds.has(companyId) ? companyId : null, owner_id: uid(contact.responsible_user_id), phone: clip(valuesOf(contact, 'PHONE').join(', '), 255), email: clip(valuesOf(contact, 'EMAIL').join(', ').toLowerCase(), 254), position: clip(valuesOf(contact, 'POSITION').join(', '), 255), telegram: clip(String(imTelegram?.value ?? telegramField?.values?.[0]?.value ?? '').trim(), 255), notes: '', tags: tagsOf(contact), created_at: toText(contact.created_at) ?? toText(Date.now() / 1000), updated_at: toText(contact.updated_at) ?? toText(contact.created_at) ?? toText(Date.now() / 1000), deleted_at: null});
    contactIds.add(contact.id); saveValues(contact, 'contacts');
  }
  for (const lead of dump.leads) {
    let stage = mapStatus(lead.pipeline_id, lead.status_id);
    if (!stageIds.has(stage)) {
      const fallback = firstStage.get(lead.pipeline_id);
      if (!fallback) { warn('Сделки из неизвестных воронок пропущены', lead.id); continue; }
      if (existing.strictStages) { warn('Сделки с неизвестным этапом пропущены', lead.id); continue; }
      warn('Сделки с неизвестным этапом поставлены в первый этап воронки', lead.id); stage = fallback;
    }
    const contacts = (lead._embedded?.contacts || []).filter(c => contactIds.has(c.id));
    const main = contacts.find(c => c.is_main) || contacts[0];
    const companyId = lead._embedded?.companies?.[0]?.id ?? null;
    const closed = stageKind.get(stage) !== 'active';
    rows.deals.push({id: lead.id, name: clip(String(lead.name || '').trim() || `Сделка #${lead.id}`, 255), stage_id: stage, company_id: companyIds.has(companyId) ? companyId : null, contact_id: main?.id ?? null, owner_id: uid(lead.responsible_user_id), amount: Math.max(0, Math.round(Number(lead.price) || 0)), source: '', tags: tagsOf(lead), description: '', loss_reason: clip(lead._embedded?.loss_reason?.[0]?.name || '', 120), created_at: toText(lead.created_at) ?? toText(Date.now() / 1000), updated_at: toText(lead.updated_at) ?? toText(lead.created_at) ?? toText(Date.now() / 1000), closed_at: closed ? toText(lead.closed_at) ?? toText(lead.updated_at) : null, deleted_at: null});
    dealIds.add(lead.id); dealStage.set(lead.id, {stage, pipeline: lead.pipeline_id, created_at: lead.created_at, created_by: lead.created_by});
    for (const c of contacts) rows.deal_contacts.push({deal_id: lead.id, contact_id: c.id, created_at: toText(lead.created_at) ?? toText(Date.now() / 1000)});
    saveValues(lead, 'leads');
  }

  // Tasks.
  const customTypes = new Map((dump.account?.task_types || []).map(type => [type.id, String(type.name || '').trim()]));
  for (const task of dump.tasks) {
    const link = {deal_id: null, contact_id: null, company_id: null};
    if (task.entity_type === 'leads' && dealIds.has(task.entity_id)) link.deal_id = task.entity_id;
    else if (task.entity_type === 'contacts' && contactIds.has(task.entity_id)) link.contact_id = task.entity_id;
    else if (task.entity_type === 'companies' && companyIds.has(task.entity_id)) link.company_id = task.entity_id;
    else if (task.entity_id) warn('Задачи без найденной записи перенесены без привязки', task.id);
    const custom = customTypes.get(task.task_type_id);
    const type = presetTaskTypes[task.task_type_id] || taskTypes.find(name => name.toLowerCase() === String(custom || '').toLowerCase()) || clip(custom || 'Связаться', 60);
    const text = String(task.text || '').trim();
    const title = clip(text.split('\n')[0].trim() || type, 500);
    const due = unix(task.complete_till);
    const local = due !== null ? localParts(due, zone) : null;
    const allDay = local && local.hour === '23' && local.minute === '59' ? 1 : 0;
    rows.tasks.push({id: task.id, title, description: text !== title ? clip(text, 5000) : '', task_type: type, due_at: toIso(task.complete_till), duration_minutes: allDay ? 0 : Math.max(0, Math.round((Number(task.duration) || 0) / 60)), all_day: allDay, completed_at: task.is_completed ? toIso(task.updated_at) ?? toIso(task.created_at) : null, completion_result: clip(task.result?.text || '', 5000), ...link, owner_id: uid(task.responsible_user_id), created_at: toText(task.created_at) ?? toText(Date.now() / 1000), updated_at: toText(task.updated_at) ?? toText(task.created_at) ?? toText(Date.now() / 1000), deleted_at: null});
  }

  // Notes.
  const noteRow = note => ({id: note.id, note_type: clip(note.note_type || 'common', 40), user_id: uid(note.created_by), body: noteBody(note) || `[${note.note_type}]`, created_at: toText(note.created_at) ?? toText(Date.now() / 1000), updated_at: toText(note.updated_at) ?? toText(note.created_at) ?? toText(Date.now() / 1000)});
  for (const note of dump.notes_leads) {
    if (!dealIds.has(note.entity_id)) { warn('Примечания удалённых сделок пропущены', note.id); continue; }
    rows.notes.push({...noteRow(note), deal_id: note.entity_id, pinned: 0});
  }
  for (const [file, type, ids] of [['notes_contacts', 'contact', contactIds], ['notes_companies', 'company', companyIds]]) {
    for (const note of dump[file]) {
      if (!ids.has(note.entity_id)) { warn('Примечания удалённых контактов и компаний пропущены', note.id); continue; }
      rows.entity_notes.push({...noteRow(note), entity_type: type, entity_id: note.entity_id});
    }
  }

  // Stage history: a creation row per deal, then every lead_status_changed event.
  const events = new Map();
  for (const event of dump.events) {
    if (!dealIds.has(event.entity_id)) continue;
    if (!events.has(event.entity_id)) events.set(event.entity_id, []);
    events.get(event.entity_id).push(event);
  }
  const statusOf = list => list?.[0]?.lead_status || null;
  for (const [dealId, deal] of dealStage) {
    const list = (events.get(dealId) || []).sort((a, b) => a.created_at - b.created_at || String(a.id).localeCompare(String(b.id)));
    const start = statusOf(list[0]?.value_before);
    const startStage = start ? mapStatus(start.pipeline_id, start.id) : deal.stage;
    if (startStage) rows.deal_stage_changes.push({deal_id: dealId, from_stage_id: null, from_pipeline_id: null, to_stage_id: startStage, to_pipeline_id: start ? start.pipeline_id : deal.pipeline, user_id: uid(deal.created_by), changed_at: toText(deal.created_at) ?? toText(Date.now() / 1000)});
    for (const event of list) {
      const before = statusOf(event.value_before), after = statusOf(event.value_after);
      if (!after) { warn('События смены этапа без нового этапа пропущены', event.id); continue; }
      rows.deal_stage_changes.push({deal_id: dealId, from_stage_id: before ? mapStatus(before.pipeline_id, before.id) : null, from_pipeline_id: before?.pipeline_id ?? null, to_stage_id: mapStatus(after.pipeline_id, after.id) ?? after.id, to_pipeline_id: after.pipeline_id ?? null, user_id: uid(event.created_by), changed_at: toText(event.created_at) ?? toText(Date.now() / 1000)});
    }
  }

  historyRows(dump, rows, {uid, dealIds, contactIds, companyIds, warn});

  // Files: kept next to the record the note belonged to.
  const files = [];
  const fileTargets = {leads: ['deal', dealIds], contacts: ['contact', contactIds], companies: ['company', companyIds]};
  for (const item of dump.files || []) {
    if (item.error) { warn('Файлы, которые не удалось скачать', `${item.name}: ${item.error}`); continue; }
    const [type, ids] = fileTargets[item.entity] || [];
    if (!type || !ids.has(item.entity_id)) { warn('Файлы удалённых записей пропущены', item.name); continue; }
    files.push({entity_type: type, entity_id: item.entity_id, user_id: uid(item.created_by), filename: clip(String(item.name).split(/[\\/]/).pop().replace(/[\x00-\x1f\x7f]/g, '').trim() || `file-${item.note_id}`, 255), mime_type: clip(item.mime_type || 'application/octet-stream', 120), byte_size: item.size, created_at: toText(item.created_at) ?? toText(Date.now() / 1000), path: item.path});
  }

  for (const field of rows.custom_fields) { field.options_json = JSON.stringify(field.options); delete field.options; delete field.amoType; }
  return {rows, files, warnings, mergedUsers, closing: Object.fromEntries([...closing].map(([pipeline, ids]) => [pipeline, {won: ids[142], lost: ids[143]}]))};
}

// ---------------------------------------------------------------- load

const loadOrder = ['users', 'pipelines', 'stages', 'custom_fields', 'companies', 'contacts', 'deals', 'deal_contacts', 'custom_field_values', 'tasks', 'notes', 'entity_notes', 'deal_stage_changes', 'activity', 'entity_activity'];
const businessTables = ['deals', 'contacts', 'companies', 'tasks', 'custom_fields', 'notes', 'entity_notes', 'attachments'];
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
export const uploadDir = () => resolve(process.env.UPLOAD_DIR || join(projectRoot, 'data/uploads'));

export async function insertRows(db, table, rows) {
  if (!rows.length) return;
  const columns = Object.keys(rows[0]);
  const perChunk = Math.max(1, Math.floor(30000 / columns.length));
  for (let start = 0; start < rows.length; start += perChunk) {
    const chunk = rows.slice(start, start + perChunk), params = [];
    const values = chunk.map(row => `(${columns.map(column => { params.push(row[column]); return `$${params.length}`; }).join(',')})`).join(',');
    await db.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${values}`, params);
  }
}

const count = async (db, sql, params = []) => Number((await db.query(sql, params)).rows[0].n);

// Removes the previous CRM data before a repeated load. Triggers (and ON DELETE actions) are off in
// replica mode, so children are removed explicitly. Users, API keys, webhooks and settings stay.
async function wipe(db, pipelineIds) {
  const stored = (await db.query('SELECT stored_name FROM attachments')).rows.map(r => r.stored_name);
  await db.query('DELETE FROM attachments');
  for (const sql of ['DELETE FROM custom_field_values', 'DELETE FROM custom_fields', 'DELETE FROM deal_contacts', 'DELETE FROM notes', 'DELETE FROM deal_communications', 'DELETE FROM activity', 'DELETE FROM deal_stage_changes', 'DELETE FROM tasks', 'DELETE FROM entity_notes', 'DELETE FROM entity_activity', 'UPDATE inbox_leads SET deal_id=NULL WHERE deal_id IS NOT NULL', 'DELETE FROM deals', 'DELETE FROM contacts', 'DELETE FROM companies']) await db.query(sql);
  await dropPipelines(db, pipelineIds);
  return stored;
}
async function dropPipelines(db, ids) {
  if (!ids.length) return;
  await db.query('DELETE FROM stage_transitions WHERE from_stage_id IN (SELECT id FROM stages WHERE pipeline_id = ANY($1)) OR to_stage_id IN (SELECT id FROM stages WHERE pipeline_id = ANY($1))', [ids]);
  await db.query('DELETE FROM stage_automations WHERE stage_id IN (SELECT id FROM stages WHERE pipeline_id = ANY($1))', [ids]);
  await db.query('DELETE FROM deal_card_layouts WHERE pipeline_id = ANY($1)', [ids]);
  await db.query('DELETE FROM stages WHERE pipeline_id = ANY($1)', [ids]);
  await db.query('DELETE FROM pipelines WHERE id = ANY($1)', [ids]);
}

// An OpenCRM user with the e-mail of an amoCRM user takes the amoCRM ID, so integrations that match
// employees by amoCRM ID keep working. Every reference follows (foreign keys are off in replica mode).
async function rekeyUsers(db, dump) {
  const users = (await db.query('SELECT id,email FROM users')).rows.map(u => ({id: Number(u.id), email: u.email.toLowerCase()}));
  const byEmail = new Map(users.map(u => [u.email, u.id])), ids = new Set(users.map(u => u.id));
  const moves = [];
  for (const amo of dump.users) {
    const email = String(amo.email || '').trim().toLowerCase(), current = byEmail.get(email);
    if (!email || current === undefined || current === amo.id) continue;
    if (ids.has(amo.id)) throw new Error(`ID сотрудника amoCRM ${amo.id} (${email}) уже занят другим пользователем OpenCRM`);
    moves.push({email, from: current, to: amo.id}); ids.delete(current); ids.add(amo.id);
  }
  if (!moves.length) return moves;
  const columns = (await db.query("SELECT c.conrelid::regclass::text tbl, a.attname col FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum = ANY(c.conkey) WHERE c.contype='f' AND c.confrelid='users'::regclass")).rows.map(r => [r.tbl, r.col]);
  columns.push(['deal_stage_changes', 'user_id']);
  for (const {from, to} of moves) {
    await db.query('UPDATE users SET id=$1 WHERE id=$2', [to, from]);
    for (const [table, column] of columns) await db.query(`UPDATE ${table} SET ${column}=$1 WHERE ${column}=$2`, [to, from]);
  }
  return moves;
}

class DryRun extends Error {}

// Loads an export in one transaction. dryRun: everything is written, checked and rolled back.
export async function loadDump(db, dump, {dryRun = false, replace = false, keepDefaultPipeline = false, log = console.log, uploads = uploadDir()} = {}) {
  let report, replaced = [];
  const copied = [];
  try {
    await db.transaction(async () => {
      await db.query('SET LOCAL session_replication_role = replica');
      const present = {};
      for (const table of businessTables) present[table] = await count(db, `SELECT COUNT(*) n FROM ${table}`);
      const amoPipelines = dump.pipelines.map(p => p.id);
      const busy = Object.entries(present).filter(([, n]) => n > 0);
      if (busy.length && !replace) throw new Error(`В CRM уже есть данные (${busy.map(([t, n]) => `${t}: ${n}`).join(', ')}). Загрузка идёт в пустую CRM; чтобы заменить данные, запустите с --replace`);
      if (replace) replaced = await wipe(db, (await db.query('SELECT id FROM pipelines WHERE id = ANY($1)', [amoPipelines])).rows.map(r => Number(r.id)));
      else if ((await db.query('SELECT id FROM pipelines WHERE id = ANY($1)', [amoPipelines])).rows.length) throw new Error('Воронки с ID из amoCRM уже есть в CRM; для повторной загрузки используйте --replace');
      const rekeyed = await rekeyUsers(db, dump);
      const users = (await db.query('SELECT id,email FROM users')).rows.map(u => ({id: Number(u.id), email: u.email}));
      const maxStageId = await count(db, 'SELECT COALESCE(MAX(id),0) n FROM stages');
      const result = transform(dump, {users, maxStageId});
      for (const table of loadOrder) { await insertRows(db, table, result.rows[table]); log(`  ${table}: ${result.rows[table].length}`); }
      // Files: checked in a dry run, copied into the upload folder otherwise (removed again on failure).
      let fileBytes = 0;
      if (result.files.length && !dryRun) await mkdir(uploads, {recursive: true});
      for (const file of result.files) {
        const info = await stat(file.path).catch(() => null);
        if (!info || info.size !== file.byte_size) throw new Error(`Файл ${file.filename} не найден в выгрузке или повреждён: запустите export ещё раз`);
        fileBytes += info.size;
        const {path, ...row} = file;
        row.stored_name = randomBytes(24).toString('hex');
        if (!dryRun) { const target = resolve(uploads, row.stored_name); await writeFile(target, await readFile(path), {flag: 'wx', mode: 0o600}); copied.push(target); }
        await insertRows(db, 'attachments', [row]);
      }
      log(`  attachments: ${result.files.length}`);
      // The seed pipeline of a fresh install goes away when nothing uses it.
      let droppedPipelines = [];
      if (!keepDefaultPipeline) {
        droppedPipelines = (await db.query("SELECT p.id FROM pipelines p WHERE p.id <> ALL($1) AND p.name = 'Воронка — новые лиды' AND NOT EXISTS (SELECT 1 FROM deals d JOIN stages s ON s.id=d.stage_id WHERE s.pipeline_id=p.id) AND NOT EXISTS (SELECT 1 FROM inbox_leads l WHERE l.pipeline_id=p.id) AND NOT EXISTS (SELECT 1 FROM lead_forms f WHERE f.pipeline_id=p.id)", [amoPipelines])).rows.map(r => Number(r.id));
        await dropPipelines(db, droppedPipelines);
      }
      // With the history in the export the server need not load it from amoCRM after start.
      if (dump.events_history != null) await db.query('INSERT INTO app_settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', [historySettingKey, JSON.stringify({at: new Date().toISOString(), from: 'export'})]);
      await db.query('SET LOCAL session_replication_role = origin');
      await db.query('SELECT sync_id_sequences()');
      // Consistency check, since foreign keys were not enforced during the load.
      const broken = {};
      for (const [name, sql] of Object.entries({
        'сделки без этапа': 'SELECT COUNT(*) n FROM deals d LEFT JOIN stages s ON s.id=d.stage_id WHERE s.id IS NULL',
        'этапы без воронки': 'SELECT COUNT(*) n FROM stages s LEFT JOIN pipelines p ON p.id=s.pipeline_id WHERE p.id IS NULL',
        'ссылки на несуществующих пользователей': 'SELECT (SELECT COUNT(*) FROM deals d WHERE d.owner_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id=d.owner_id)) + (SELECT COUNT(*) FROM contacts c WHERE c.owner_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id=c.owner_id)) + (SELECT COUNT(*) FROM tasks t WHERE t.owner_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id=t.owner_id)) n',
        'значения полей без поля': 'SELECT COUNT(*) n FROM custom_field_values v LEFT JOIN custom_fields f ON f.id=v.field_id WHERE f.id IS NULL'
      })) { const n = await count(db, sql); if (n) broken[name] = n; }
      if (Object.keys(broken).length) throw new Error(`Проверка целостности не прошла: ${JSON.stringify(broken)}`);
      const byStage = (await db.query('SELECT p.id pipeline_id, p.name pipeline, s.id stage_id, s.name stage, s.kind, COUNT(d.id) deals FROM pipelines p JOIN stages s ON s.pipeline_id=p.id LEFT JOIN deals d ON d.stage_id=s.id GROUP BY p.id,p.name,s.id,s.name,s.kind,s.sort_order,p.sort_order ORDER BY p.sort_order,p.id,s.sort_order')).rows.map(r => ({...r, pipeline_id: Number(r.pipeline_id), stage_id: Number(r.stage_id), deals: Number(r.deals)}));
      report = {dry_run: dryRun, counts: {...Object.fromEntries(loadOrder.map(table => [table, result.rows[table].length])), attachments: result.files.length}, attachment_bytes: fileBytes, closing_stages: result.closing, rekeyed_users: rekeyed, merged_users: result.mergedUsers, dropped_pipelines: droppedPipelines, warnings: result.warnings, deals_by_stage: byStage};
      if (dryRun) throw new DryRun();
    })();
  } catch (error) {
    if (!(error instanceof DryRun)) { await Promise.all(copied.map(path => unlink(path).catch(() => {}))); throw error; }
  }
  // Files of records removed by --replace go once the new data is committed.
  if (!dryRun) await Promise.all(replaced.map(name => unlink(resolve(uploads, name)).catch(() => {})));
  return report;
}

// Run once by the server after a deploy (server/index.js) when AMO_BASE_URL and AMO_ACCESS_TOKEN are
// set: downloads the events of deals, contacts and companies straight from amoCRM and writes the card
// history of the records already loaded here. Names come from this database and from the small amoCRM
// lists (users, pipelines, fields). Events are read up to the moment of the first start (amoCRM takes the range only with both ends), newest first,
// several pages at a time within the rate limit. The page reached is kept in app_settings, so a restart
// (a deploy) continues where the load stopped; the rows of a page are written again, never doubled. When
// all is loaded, app_settings remembers it and nothing more happens.
export const historySettingKey = 'amocrm_history_loaded';
export const historyProgressKey = 'amocrm_history_progress';
export async function syncHistoryFromAmo(db, client, {log = console.log, parallel = 6} = {}) {
  if ((await db.query('SELECT value FROM app_settings WHERE key=$1', [historySettingKey])).rows.length) return null;
  const all = async (sql) => (await db.query(sql)).rows.map(r => ({...r, id: Number(r.id)}));
  const [deals, contacts, companies, users] = [await all('SELECT id,name FROM deals'), await all('SELECT id,name FROM contacts'), await all('SELECT id,name FROM companies'), await all('SELECT id,email FROM users')];
  if (!deals.length && !contacts.length && !companies.length) { log('amoCRM: в CRM нет записей, история не нужна'); return null; }
  const list = async (path, key, params = {}, limit = 250) => client.list(path, key, params, limit);
  const amoUsers = await list('/api/v4/users', 'users');
  const pipelines = (await client.request('/api/v4/leads/pipelines'))?._embedded?.pipelines || [];
  const dump = {users: amoUsers, pipelines, leads: deals, contacts, companies, event_types: []};
  for (const entity of ['leads', 'contacts', 'companies']) dump[`custom_fields_${entity}`] = await list(`/api/v4/${entity}/custom_fields`, 'custom_fields', {}, 50);
  try { dump.event_types = Object.values((await client.request('/api/v4/events/types', {language_code: 'ru'}))?._embedded || {}).find(Array.isArray) || []; } catch (error) { log(`amoCRM: типы событий: ${error.message}`); }
  // An amoCRM employee is the account here with the same e-mail, or the account with the amoCRM ID.
  const byEmail = new Map(users.map(u => [String(u.email).toLowerCase(), u.id])), userIds = new Set(users.map(u => u.id));
  const userMap = new Map(amoUsers.map(u => [Number(u.id), byEmail.get(String(u.email || '').trim().toLowerCase()) ?? (userIds.has(Number(u.id)) ? Number(u.id) : null)]));
  const ids = {uid: id => userMap.get(Number(id)) ?? null, dealIds: new Set(deals.map(r => r.id)), contactIds: new Set(contacts.map(r => r.id)), companyIds: new Set(companies.map(r => r.id)), warn: () => {}};
  const saveSetting = (key, value) => db.query('INSERT INTO app_settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', [key, JSON.stringify(value)]);
  const saved = (await db.query('SELECT value FROM app_settings WHERE key=$1', [historyProgressKey])).rows[0];
  const progress = saved ? JSON.parse(saved.value) : {until: Math.floor(Date.now() / 1000), page: 1, events: 0, activity: 0, entity_activity: 0};
  if (!saved) await saveSetting(historyProgressKey, progress);
  log(progress.page > 1 ? `amoCRM: продолжение загрузки истории со страницы ${progress.page} (событий уже ${progress.events})` : 'amoCRM: загрузка истории карточек');
  const params = page => ({'filter[entity][]': ['lead', 'contact', 'company'], 'filter[created_at][from]': 1, 'filter[created_at][to]': progress.until, limit: 100, page});
  let lastLog = Date.now(), done = false;
  while (!done) {
    const pages = Array.from({length: parallel}, (_, i) => progress.page + i);
    const results = await Promise.all(pages.map(page => client.request('/api/v4/events', params(page))));
    // amoCRM paging is not perfectly stable: an event may show up on two neighbouring pages.
    const events = [], seen = new Set();
    for (const data of results) {
      const chunk = data?._embedded?.events || [];
      for (const event of chunk) if (!seen.has(event.id)) { seen.add(event.id); events.push(event); }
      if (!chunk.length || !data._links?.next) { done = true; break; }
    }
    const rows = {activity: [], entity_activity: []};
    historyRows({...dump, events_history: events}, rows, ids);
    await db.transaction(async () => {
      const eventIds = events.map(event => clip(event.id, 64));
      if (eventIds.length) {
        await db.query('DELETE FROM activity WHERE amo_event_id = ANY($1)', [eventIds]);
        await db.query('DELETE FROM entity_activity WHERE amo_event_id = ANY($1)', [eventIds]);
      }
      await insertRows(db, 'activity', rows.activity);
      await insertRows(db, 'entity_activity', rows.entity_activity);
      progress.page += parallel; progress.events += events.length; progress.activity += rows.activity.length; progress.entity_activity += rows.entity_activity.length;
      await saveSetting(historyProgressKey, progress);
    })();
    if (Date.now() - lastLog > 30000) { lastLog = Date.now(); log(`amoCRM: событий ${progress.events}, записей истории ${progress.activity + progress.entity_activity}`); }
  }
  const counts = {events: progress.events, activity: progress.activity, entity_activity: progress.entity_activity};
  await saveSetting(historySettingKey, {at: new Date().toISOString(), ...counts});
  await db.query('DELETE FROM app_settings WHERE key=$1', [historyProgressKey]);
  log(`amoCRM: история загружена — событий ${counts.events}, в сделках ${counts.activity}, в контактах и компаниях ${counts.entity_activity}`);
  return counts;
}

// Adds the card history of an export to a CRM where the export is already loaded, without touching
// anything else. History loaded from amoCRM earlier (rows with amo_event_id) is replaced; history
// written in OpenCRM stays. Records missing here are skipped.
export async function loadHistory(db, dump, {dryRun = false, log = console.log} = {}) {
  let report;
  try {
    await db.transaction(async () => {
      await db.query('SET LOCAL session_replication_role = replica');
      const users = (await db.query('SELECT id,email FROM users')).rows.map(u => ({id: Number(u.id), email: u.email}));
      const userIds = new Set(users.map(u => u.id));
      const {rows, warnings} = transform(dump, {users, maxStageId: await count(db, 'SELECT COALESCE(MAX(id),0) n FROM stages')});
      const present = async (table, ids) => new Set((await db.query(`SELECT id FROM ${table} WHERE id = ANY($1)`, [[...new Set(ids)]])).rows.map(r => Number(r.id)));
      const deals = await present('deals', rows.activity.map(r => r.deal_id));
      const entities = {contact: await present('contacts', rows.entity_activity.filter(r => r.entity_type === 'contact').map(r => r.entity_id)), company: await present('companies', rows.entity_activity.filter(r => r.entity_type === 'company').map(r => r.entity_id))};
      const person = row => ({...row, user_id: userIds.has(row.user_id) ? row.user_id : null});
      const activity = rows.activity.filter(r => deals.has(r.deal_id)).map(person);
      const entityActivity = rows.entity_activity.filter(r => entities[r.entity_type].has(r.entity_id)).map(person);
      const affected = result => Number(result.rowCount ?? result.affectedRows ?? 0);
      const removed = {activity: affected(await db.query('DELETE FROM activity WHERE amo_event_id IS NOT NULL')), entity_activity: affected(await db.query('DELETE FROM entity_activity WHERE amo_event_id IS NOT NULL'))};
      await insertRows(db, 'activity', activity); log(`  activity: ${activity.length}`);
      await insertRows(db, 'entity_activity', entityActivity); log(`  entity_activity: ${entityActivity.length}`);
      await db.query('INSERT INTO app_settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', [historySettingKey, JSON.stringify({at: new Date().toISOString(), from: 'export'})]);
      await db.query('SET LOCAL session_replication_role = origin');
      await db.query('SELECT sync_id_sequences()');
      const historyWarnings = Object.fromEntries(Object.entries(warnings).filter(([text]) => /истори/i.test(text)));
      report = {dry_run: dryRun, counts: {activity: activity.length, entity_activity: entityActivity.length}, replaced: removed, skipped: {activity: rows.activity.length - activity.length, entity_activity: rows.entity_activity.length - entityActivity.length}, warnings: historyWarnings};
      if (dryRun) throw new DryRun();
    })();
  } catch (error) { if (!(error instanceof DryRun)) throw error; }
  return report;
}
