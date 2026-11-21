// One-time move of an amoCRM account into OpenCRM: export through the amoCRM API v4 into JSON
// files, then load them into PostgreSQL keeping the amoCRM IDs. See docs/AMOCRM_IMPORT.md.
import {mkdir,readFile,rename,writeFile,access} from 'node:fs/promises';
import {join} from 'node:path';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import {fullPermissions,defaultMemberPermissions} from '../server/security.js';
import {taskTypes} from '../src/task-types.js';

// ---------------------------------------------------------------- export

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// GET over HTTPS, optionally through an HTTP CONNECT proxy (http://user:pass@host:port).
function httpsGet(url, headers, proxyUrl, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const finish = socket => {
      const request = https.request({host: target.hostname, port: target.port || 443, path: target.pathname + target.search, method: 'GET', headers, timeout: timeoutMs,
        ...(socket ? {agent: false, createConnection: () => tls.connect({socket, servername: target.hostname})} : {})}, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve({status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8')}));
        response.on('error', reject);
      });
      request.on('timeout', () => request.destroy(new Error('timeout')));
      request.on('error', reject);
      request.end();
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

export function amoClient({baseUrl, token, proxyUrl = '', minIntervalMs = 160, retries = 8, get = httpsGet, log = () => {}} = {}) {
  if (!baseUrl || !token) throw new Error('Нужны AMO_BASE_URL (https://<поддомен>.amocrm.ru) и AMO_ACCESS_TOKEN (долгосрочный токен интеграции)');
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:') throw new Error('AMO_BASE_URL должен начинаться с https://');
  let last = 0;
  async function request(path, params = {}) {
    const url = new URL(path, base.origin);
    for (const [key, value] of Object.entries(params)) url.searchParams.append(key, String(value));
    for (let attempt = 1; ; attempt++) {
      const wait = last + minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      let response;
      try { response = await get(url.href, {Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': 'opencrm-import'}, proxyUrl); }
      catch (error) {
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
  return {request, list};
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
  ['events', '/api/v4/events', 'events', {'filter[type]': 'lead_status_changed'}, 100]
];

const exists = path => access(path).then(() => true, () => false);
async function saveJson(path, data) { await writeFile(`${path}.tmp`, JSON.stringify(data)); await rename(`${path}.tmp`, path); }

// Downloads everything into dir. Files already there are kept (a broken export resumes), unless force.
export async function exportAccount({client, dir, force = false, log = console.log}) {
  await mkdir(dir, {recursive: true});
  const counts = {};
  const accountFile = join(dir, 'account.json');
  if (force || !await exists(accountFile)) {
    const account = await client.request('/api/v4/account', {with: 'task_types'});
    await saveJson(accountFile, {id: account.id, name: account.name, subdomain: account.subdomain, timezone: account.timezone, task_types: account._embedded?.task_types || []});
    log(`Аккаунт: ${account.name} (${account.subdomain}), часовой пояс ${account.timezone}`);
  }
  const pipelinesFile = join(dir, 'pipelines.json');
  if (force || !await exists(pipelinesFile)) {
    const pipelines = (await client.request('/api/v4/leads/pipelines'))?._embedded?.pipelines || [];
    await saveJson(pipelinesFile, pipelines);
    log(`Воронки: ${pipelines.length}`);
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
  await saveJson(join(dir, 'export-meta.json'), {exported_at: new Date().toISOString(), counts});
  return counts;
}

export async function readDump(dir) {
  const read = async name => JSON.parse(await readFile(join(dir, `${name}.json`), 'utf8'));
  const dump = {account: await read('account'), pipelines: await read('pipelines')};
  for (const [file] of exportPlan) dump[file] = await read(file);
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
const safeZone = zone => { try { new Intl.DateTimeFormat('en-GB', {timeZone: zone}); return zone; } catch { return 'Europe/Moscow'; } };
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

function noteBody(note) {
  const p = note.params || {};
  const text = String(p.text ?? '').trim();
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
    case 'service_message': case 'extended_service_message': return [p.service, text].filter(Boolean).join(': ');
    case 'attachment': return `Файл: ${p.original_name || p.file_name || 'без имени'}`;
    case 'geolocation': return [text, p.address].filter(Boolean).join('\n');
    default: return text || (Object.keys(p).length ? JSON.stringify(p) : '');
  }
}

// Turns an export into table rows. existing = what the target database already has.
export function transform(dump, existing = {users: [], maxStageId: 0}) {
  const warnings = {};
  const warn = (key, example) => { warnings[key] ??= {count: 0, examples: []}; warnings[key].count++; if (example !== undefined && warnings[key].examples.length < 5) warnings[key].examples.push(example); };
  const zone = safeZone(dump.account?.timezone);
  const rows = {users: [], pipelines: [], stages: [], custom_fields: [], custom_field_values: [], companies: [], contacts: [], deals: [], deal_contacts: [], tasks: [], notes: [], entity_notes: [], deal_stage_changes: []};

  // Users. An e-mail that already has an account here keeps that account; amoCRM records point at it.
  const userMap = new Map(), byEmail = new Map(existing.users.map(user => [user.email.toLowerCase(), user.id])), takenIds = new Set(existing.users.map(user => user.id)), mergedUsers = [];
  for (const user of dump.users) {
    const email = String(user.email || `amo-user-${user.id}@import.invalid`).trim().toLowerCase();
    if (byEmail.has(email)) { userMap.set(user.id, byEmail.get(email)); if (byEmail.get(email) !== user.id) mergedUsers.push({amo_id: user.id, email, id: byEmail.get(email)}); continue; }
    if (takenIds.has(user.id)) throw new Error(`ID пользователя amoCRM ${user.id} уже занят другим пользователем OpenCRM`);
    const admin = !!user.rights?.is_admin;
    rows.users.push({id: user.id, name: clip(user.name || email, 120), email, password_hash: 'x:y', role: admin ? 'admin' : 'member', permissions_json: JSON.stringify(admin ? fullPermissions() : defaultMemberPermissions()), disabled_at: user.rights?.is_active === false ? toText(Date.now() / 1000) : null});
    userMap.set(user.id, user.id); byEmail.set(email, user.id); takenIds.add(user.id);
  }
  const uid = id => userMap.get(Number(id)) ?? null;

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
  const companyIds = new Set(), contactIds = new Set(), dealIds = new Set(), dealStage = new Map();
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
  const noteRow = note => ({id: note.id, user_id: uid(note.created_by), body: noteBody(note) || `[${note.note_type}]`, created_at: toText(note.created_at) ?? toText(Date.now() / 1000), updated_at: toText(note.updated_at) ?? toText(note.created_at) ?? toText(Date.now() / 1000)});
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

  for (const field of rows.custom_fields) { field.options_json = JSON.stringify(field.options); delete field.options; delete field.amoType; }
  return {rows, warnings, mergedUsers, closing: Object.fromEntries([...closing].map(([pipeline, ids]) => [pipeline, {won: ids[142], lost: ids[143]}]))};
}

// ---------------------------------------------------------------- load

const loadOrder = ['users', 'pipelines', 'stages', 'custom_fields', 'companies', 'contacts', 'deals', 'deal_contacts', 'custom_field_values', 'tasks', 'notes', 'entity_notes', 'deal_stage_changes'];
const businessTables = ['deals', 'contacts', 'companies', 'tasks', 'custom_fields', 'notes', 'entity_notes'];

async function insertRows(db, table, rows) {
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
  if (await count(db, 'SELECT COUNT(*) n FROM attachments')) throw new Error('В CRM есть вложения: --replace их не удаляет. Удалите их в интерфейсе или загружайте в пустую базу');
  for (const sql of ['DELETE FROM custom_field_values', 'DELETE FROM custom_fields', 'DELETE FROM deal_contacts', 'DELETE FROM notes', 'DELETE FROM deal_communications', 'DELETE FROM activity', 'DELETE FROM deal_stage_changes', 'DELETE FROM tasks', 'DELETE FROM entity_notes', 'DELETE FROM entity_activity', 'UPDATE inbox_leads SET deal_id=NULL WHERE deal_id IS NOT NULL', 'DELETE FROM deals', 'DELETE FROM contacts', 'DELETE FROM companies']) await db.query(sql);
  await dropPipelines(db, pipelineIds);
}
async function dropPipelines(db, ids) {
  if (!ids.length) return;
  await db.query('DELETE FROM stage_transitions WHERE from_stage_id IN (SELECT id FROM stages WHERE pipeline_id = ANY($1)) OR to_stage_id IN (SELECT id FROM stages WHERE pipeline_id = ANY($1))', [ids]);
  await db.query('DELETE FROM stage_automations WHERE stage_id IN (SELECT id FROM stages WHERE pipeline_id = ANY($1))', [ids]);
  await db.query('DELETE FROM deal_card_layouts WHERE pipeline_id = ANY($1)', [ids]);
  await db.query('DELETE FROM stages WHERE pipeline_id = ANY($1)', [ids]);
  await db.query('DELETE FROM pipelines WHERE id = ANY($1)', [ids]);
}

class DryRun extends Error {}

// Loads an export in one transaction. dryRun: everything is written, checked and rolled back.
export async function loadDump(db, dump, {dryRun = false, replace = false, keepDefaultPipeline = false, log = console.log} = {}) {
  let report;
  try {
    await db.transaction(async () => {
      await db.query('SET LOCAL session_replication_role = replica');
      const present = {};
      for (const table of businessTables) present[table] = await count(db, `SELECT COUNT(*) n FROM ${table}`);
      const amoPipelines = dump.pipelines.map(p => p.id);
      const busy = Object.entries(present).filter(([, n]) => n > 0);
      if (busy.length && !replace) throw new Error(`В CRM уже есть данные (${busy.map(([t, n]) => `${t}: ${n}`).join(', ')}). Загрузка идёт в пустую CRM; чтобы заменить данные, запустите с --replace`);
      if (replace) await wipe(db, (await db.query('SELECT id FROM pipelines WHERE id = ANY($1)', [amoPipelines])).rows.map(r => Number(r.id)));
      else if ((await db.query('SELECT id FROM pipelines WHERE id = ANY($1)', [amoPipelines])).rows.length) throw new Error('Воронки с ID из amoCRM уже есть в CRM; для повторной загрузки используйте --replace');
      const users = (await db.query('SELECT id,email FROM users')).rows.map(u => ({id: Number(u.id), email: u.email}));
      const maxStageId = await count(db, 'SELECT COALESCE(MAX(id),0) n FROM stages');
      const result = transform(dump, {users, maxStageId});
      for (const table of loadOrder) { await insertRows(db, table, result.rows[table]); log(`  ${table}: ${result.rows[table].length}`); }
      // The seed pipeline of a fresh install goes away when nothing uses it.
      let droppedPipelines = [];
      if (!keepDefaultPipeline) {
        droppedPipelines = (await db.query("SELECT p.id FROM pipelines p WHERE p.id <> ALL($1) AND p.name = 'Воронка — новые лиды' AND NOT EXISTS (SELECT 1 FROM deals d JOIN stages s ON s.id=d.stage_id WHERE s.pipeline_id=p.id) AND NOT EXISTS (SELECT 1 FROM inbox_leads l WHERE l.pipeline_id=p.id) AND NOT EXISTS (SELECT 1 FROM lead_forms f WHERE f.pipeline_id=p.id)", [amoPipelines])).rows.map(r => Number(r.id));
        await dropPipelines(db, droppedPipelines);
      }
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
      report = {dry_run: dryRun, counts: Object.fromEntries(loadOrder.map(table => [table, result.rows[table].length])), closing_stages: result.closing, merged_users: result.mergedUsers, dropped_pipelines: droppedPipelines, warnings: result.warnings, deals_by_stage: byStage};
      if (dryRun) throw new DryRun();
    })();
  } catch (error) { if (!(error instanceof DryRun)) throw error; }
  return report;
}
