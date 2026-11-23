// Server-to-server API v1: deals, contacts, companies, tasks, notes, users, custom fields and pipelines.
// Every route takes an API key (Authorization: Bearer ocrm_...) with the listed scope. Keys are
// instance-wide service credentials: employee visibility settings do not apply to them, the stage
// transition rules of pipelines do.
//
// mirror:write marks the key of the amoCRM bridge, which keeps both CRMs equal while they run side by
// side. It adds to the usual write scopes: creates may keep the amoCRM number (id), times (created_at,
// updated_at) and author (author_id); stage changes skip the transition rules and the loss reason;
// its deals skip distribution and stage tasks, and its changes start no automation. History names the
// employee from author_id, changed_by.api_key_id in webhooks and stage changes still names the key.
import {createHash} from 'node:crypto';
import {queueDistribution} from './distribution.js';
import {RuleError} from './stage-rules.js';
import {taskTypes} from '../src/task-types.js';
import {emailSelect, emailView} from './mail.js';
import {syncLog, syncStatus} from './amocrm-sync.js';

export const apiScopes = ['leads:write', 'deals:read', 'deals:write', 'contacts:read', 'contacts:write', 'companies:read', 'companies:write', 'tasks:read', 'tasks:write', 'users:read', 'pipelines:write', 'fields:write', 'emails:read', 'mirror:write'];

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = message => { throw new ApiError(400, message); };
const sha256 = value => createHash('sha256').update(value).digest('hex');
const positiveId = value => (typeof value === 'number' || typeof value === 'string' && /^\d+$/.test(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const has = (body, key) => Object.prototype.hasOwnProperty.call(body, key) && body[key] !== undefined;
const placeholders = list => list.map(() => '?').join(',');

function objectBody(req) {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) bad('Передайте JSON-объект с Content-Type: application/json');
  return body;
}
function text(body, key, max, {required = false} = {}) {
  if (!has(body, key) || body[key] === null) {
    if (required) bad(`Поле ${key} обязательно`);
    return has(body, key) ? '' : undefined;
  }
  const raw = body[key];
  if (typeof raw !== 'string' && typeof raw !== 'number') bad(`${key}: ожидается строка`);
  const value = String(raw).trim();
  if (required && !value) bad(`Поле ${key} не может быть пустым`);
  if (value.length > max) bad(`${key}: не длиннее ${max} символов`);
  return value;
}
function idField(body, key) {
  if (!has(body, key)) return undefined;
  if (body[key] === null || body[key] === '') return null;
  const id = positiveId(body[key]);
  if (!id) bad(`${key}: ожидается положительное целое число`);
  return id;
}
function idList(raw, key, max = 100) {
  if (!Array.isArray(raw) || raw.length > max) bad(`${key}: список ID, не больше ${max}`);
  const ids = raw.map(positiveId);
  if (ids.some(id => !id)) bad(`${key}: ожидаются положительные целые числа`);
  return [...new Set(ids)];
}
function flag(body, key) {
  if (!has(body, key)) return undefined;
  if (typeof body[key] !== 'boolean') bad(`${key}: true или false`);
  return body[key];
}
function timestamp(raw, key) {
  if (raw == null || raw === '') return undefined;
  const value = String(raw);
  if (/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}:\d{2})?$/.test(value)) return value.length === 10 ? `${value} 00:00:00` : value;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || value.length > 40) bad(`${key}: дата в формате ISO 8601, например 2026-01-31T10:00:00Z`);
  return new Date(parsed).toISOString().slice(0, 19).replace('T', ' ');
}
function queryId(req, key) {
  const raw = req.query[key];
  if (raw == null || raw === '') return undefined;
  const id = positiveId(String(raw));
  if (!id) bad(`${key}: ожидается положительное целое число`);
  return id;
}
function queryText(req, key, max = 200) {
  const raw = req.query[key];
  if (raw == null || raw === '') return undefined;
  if (typeof raw !== 'string' || raw.length > max) bad(`${key}: строка до ${max} символов`);
  return raw.trim();
}
function pageParams(req) {
  const after = req.query.after == null ? 0 : Number(req.query.after), limit = req.query.limit == null ? 50 : Number(req.query.limit);
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 250) bad('Проверьте пагинацию: limit от 1 до 250, after — ID последней записи');
  return {after, limit};
}

export function registerApiV1(app, db, helpers) {
  const {apiKey, event, entityEvent, logEntityChanges, logDealChanges, runStageAutomation, customValueError, parseTags, taskSchedule, stageRules, audit} = helpers;
  const route = fn => async (req, res, next) => {
    try { await fn(req, res); }
    catch (error) {
      if (error instanceof ApiError || error instanceof RuleError) return res.status(error.status).json({error: error.message});
      next(error);
    }
  };
  const via = req => `через API («${req.apiKey.name}»)`;
  const apiActor = req => `API: ${req.apiKey.name}`.slice(0, 254);
  const mirror = req => !!req.apiKey?.mirror;
  // The employee a mirror key writes for (author_id), null for other keys.
  const who = req => mirror(req) ? req.apiKey.author : null;

  async function listPage(req, res, {sql, params, alias}, decorate) {
    const {after, limit} = pageParams(req);
    const rows = await db.prepare(`${sql} AND ${alias}.id>? ORDER BY ${alias}.id LIMIT ?`).all(...params, after, limit + 1);
    const items = rows.slice(0, limit);
    res.json({items: await decorate(items), next_after: rows.length > limit ? items.at(-1).id : null});
  }
  function syncFilters(req, alias, where, params) {
    const updated = timestamp(req.query.updated_since, 'updated_since'), created = timestamp(req.query.created_since, 'created_since');
    if (updated) { where.push(`${alias}.updated_at>=?`); params.push(updated); }
    if (created) { where.push(`${alias}.created_at>=?`); params.push(created); }
  }
  // By default lists hold live records; include_deleted=1 adds the ones in the trash (deleted_at is
  // set), deleted_since=<time> returns only records moved to the trash since then.
  function deletedFilter(req, alias, where, params, live = `${alias}.deleted_at IS NULL`) {
    const since = timestamp(req.query.deleted_since, 'deleted_since');
    if (since) { where.push(`${alias}.deleted_at IS NOT NULL AND ${alias}.deleted_at>=?`); params.push(since); return; }
    const include = req.query.include_deleted == null ? '' : String(req.query.include_deleted);
    if (!['', '0', '1', 'true', 'false'].includes(include)) bad('include_deleted: 1 или 0');
    if (!['1', 'true'].includes(include)) where.push(live);
  }
  // custom_field[<field id>]=<value>: exact match, ignoring case.
  async function customFieldFilter(req, type, alias, where, params) {
    for (const [key, raw] of Object.entries(req.query)) {
      const match = /^custom_field\[(\d+)\]$/.exec(key);
      const pairs = match ? [[match[1], raw]] : key === 'custom_field' && raw && typeof raw === 'object' ? Object.entries(raw) : [];
      for (const [rawId, value] of pairs) {
        const id = positiveId(rawId), field = id && await db.prepare('SELECT id FROM custom_fields WHERE id=? AND entity_type=?').get(id, type);
        if (!field) bad(`custom_field[${rawId}]: поле не найдено для этого типа записей`);
        if (typeof value !== 'string' || value.length > 5000) bad(`custom_field[${rawId}]: строка до 5000 символов`);
        where.push(`EXISTS(SELECT 1 FROM custom_field_values cv WHERE cv.field_id=? AND cv.entity_id=${alias}.id AND lower(cv.value)=lower(?))`);
        params.push(id, value.trim());
      }
    }
  }

  // ---------- shared lookups and writers ----------
  const missing = {pipelines: 'Воронка не найдена', stages: 'Этап не найден', custom_fields: 'Поле не найдено', deals: 'Сделка не найдена', contacts: 'Контакт не найден', companies: 'Компания не найдена'};
  async function liveRow(table, id) {
    const row = id && await db.prepare(`SELECT * FROM ${table} WHERE id=?${['contacts', 'companies', 'deals'].includes(table) ? ' AND deleted_at IS NULL' : ''}`).get(id);
    if (!row) throw new ApiError(404, missing[table]);
    return row;
  }
  // anyUser: a disabled employee also fits (the mirror key copies records of former employees).
  async function ensureRef(table, id, label, {anyUser = false} = {}) {
    if (!id) return;
    const row = await db.prepare(`SELECT id FROM ${table} WHERE id=?${['contacts', 'companies', 'deals'].includes(table) ? ' AND deleted_at IS NULL' : ''}${table === 'users' && !anyUser ? ' AND disabled_at IS NULL' : ''}`).get(id);
    if (!row) bad(`${label} ${id} не найден`);
  }
  const userRef = (req, id) => ensureRef('users', id, 'Пользователь', {anyUser: mirror(req)});
  // amoCRM gives Unix seconds; ISO 8601 and "YYYY-MM-DD HH:MM:SS" are taken as well.
  function mirrorTime(raw, key) {
    if (typeof raw === 'number') {
      if (!Number.isFinite(raw) || raw <= 0 || raw > 32503680000) bad(`${key}: время в секундах Unix или ISO 8601`);
      return new Date(raw * 1000).toISOString().slice(0, 19).replace('T', ' ');
    }
    return timestamp(raw, key);
  }
  // Mirror creates: the amoCRM number, created_at and updated_at. The number must lie below the next
  // OpenCRM number of the table (OpenCRM numbers start far above amoCRM ones), so the sequence is left
  // alone and later OpenCRM records never collide with it. A taken number, also in the trash, is 409.
  async function mirrorCreate(req, body, table) {
    if (!mirror(req)) return {};
    const out = {}, id = idField(body, 'id');
    if (id) {
      const {seq} = await db.prepare("SELECT pg_get_serial_sequence(?, 'id') seq").get(table);
      const state = await db.prepare(`SELECT last_value,is_called FROM ${seq}`).get();
      const next = state.is_called ? Number(state.last_value) + 1 : Number(state.last_value);
      if (id >= next) bad(`id: ${id} не ниже следующего номера OpenCRM в этой таблице (${next}); номер из amoCRM должен быть ниже`);
      if (await db.prepare(`SELECT id FROM ${table} WHERE id=?`).get(id)) throw new ApiError(409, `Номер ${id} уже занят`);
      out.id = id;
    }
    for (const key of ['created_at', 'updated_at']) {
      const value = mirrorTime(body[key], key);
      if (value) out[key] = value;
    }
    return out;
  }
  async function insertRow(table, row) {
    const keys = Object.keys(row).filter(key => row[key] !== undefined);
    try { return (await db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${placeholders(keys)})`).run(...keys.map(key => row[key]))).lastInsertRowid; }
    catch (error) {
      if (error?.code === '23505' && row.id) throw new ApiError(409, `Номер ${row.id} уже занят`);
      throw error;
    }
  }
  // The given updated_at is written last: contacts and custom fields saved after the insert move it.
  async function finishMirror(table, id, times) {
    if (times.updated_at) await db.prepare(`UPDATE ${table} SET updated_at=? WHERE id=?`).run(times.updated_at, id);
    if (table === 'deals' && times.created_at) await db.prepare('UPDATE deal_stage_changes SET changed_at=? WHERE deal_id=? AND from_stage_id IS NULL').run(times.created_at, id);
  }
  // Tasks keep completed_at as ISO 8601.
  function isoTime(raw, key) {
    const value = mirrorTime(raw, key);
    return value && `${value.replace(' ', 'T')}.000Z`;
  }
  function tagsField(body) {
    if (!has(body, 'tags')) return undefined;
    const raw = body.tags;
    if (raw === null) return '';
    if (!(typeof raw === 'string' || Array.isArray(raw) && raw.every(item => typeof item === 'string'))) bad('tags: строка через запятую или список строк');
    const value = parseTags(Array.isArray(raw) ? raw.join(',') : raw).join(', ');
    if (value.length > 1000) bad('tags: не длиннее 1000 символов');
    return value;
  }
  function amountField(body) {
    if (!has(body, 'amount')) return undefined;
    const value = body.amount === null || body.amount === '' ? 0 : Number(body.amount);
    if (!Number.isSafeInteger(value) || value < 0 || typeof body.amount === 'boolean') bad('amount: целое число не меньше 0');
    return value;
  }
  async function customInput(type, body) {
    if (!has(body, 'custom_fields')) return [];
    const raw = body.custom_fields;
    let entries;
    if (Array.isArray(raw)) entries = raw.map(item => [item?.id ?? item?.field_id, item?.value]);
    else if (raw && typeof raw === 'object') entries = Object.entries(raw);
    else bad('custom_fields: объект {"ID поля": "значение"} или список [{"id": 1, "value": "..."}]');
    if (entries.length > 200) bad('custom_fields: не больше 200 полей за запрос');
    const result = [];
    for (const [rawId, rawValue] of entries) {
      const id = positiveId(rawId), field = id && await db.prepare('SELECT * FROM custom_fields WHERE id=? AND entity_type=?').get(id, type);
      if (!field) bad(`Поле ${rawId} не найдено для этого типа записей`);
      if (rawValue != null && !['string', 'number'].includes(typeof rawValue)) bad(`Поле «${field.name}»: значение должно быть строкой или числом`);
      const value = rawValue == null ? '' : String(rawValue).trim();
      if (value.length > 5000) bad(`Поле «${field.name}»: не длиннее 5000 символов`);
      const error = customValueError(field, value);
      if (error) bad(`Поле «${field.name}»: ${error}`);
      result.push({field, value});
    }
    return result;
  }
  async function saveCustom(type, entityId, values, userLabel, userId = null) {
    for (const {field, value} of values) {
      const previous = (await db.prepare('SELECT value FROM custom_field_values WHERE field_id=? AND entity_id=?').get(field.id, entityId))?.value || '';
      if (previous === value) continue;
      await db.prepare('INSERT INTO custom_field_values (field_id,entity_id,value) VALUES (?,?,?) ON CONFLICT(field_id,entity_id) DO UPDATE SET value=excluded.value').run(field.id, entityId, value);
      const line = `Поле «${field.name}»: ${previous || '—'} → ${value || '—'} ${userLabel}`.slice(0, 1000);
      if (type === 'deal') await event(entityId, userId, line);
      else await entityEvent(type, entityId, userId, line);
    }
  }
  async function customValues(type, ids) {
    const map = new Map(ids.map(id => [id, []]));
    if (!ids.length) return map;
    const rows = await db.prepare(`SELECT v.entity_id,f.id,f.name,f.field_type,v.value FROM custom_field_values v JOIN custom_fields f ON f.id=v.field_id WHERE f.entity_type=? AND v.value<>'' AND v.entity_id IN (${placeholders(ids)}) ORDER BY f.sort_order,f.id`).all(type, ...ids);
    for (const {entity_id, ...field} of rows) map.get(entity_id)?.push(field);
    return map;
  }
  // Idempotency-Key for creates: the same key and body return the first result, other data gives 409.
  async function idempotent(req, resource, normalized, create) {
    const key = req.get('idempotency-key');
    if (!key) return {id: await db.transaction(create)(), repeated: false};
    if (!/^[A-Za-z0-9._~-]{1,128}$/.test(key)) bad('Неверный Idempotency-Key: латиница, цифры, . _ ~ -, до 128 символов');
    const hash = sha256(`${resource}:${JSON.stringify(normalized)}`);
    try {
      return await db.transaction(async () => {
        const existing = await db.prepare('SELECT resource,resource_id,request_hash FROM api_requests WHERE api_key_id=? AND idempotency_key=?').get(req.apiKey.id, key);
        if (existing) {
          if (existing.request_hash !== hash) throw new ApiError(409, 'Idempotency-Key уже использован с другими данными');
          return {id: existing.resource_id, repeated: true};
        }
        const id = await create();
        await db.prepare('INSERT INTO api_requests (api_key_id,idempotency_key,request_hash,resource,resource_id) VALUES (?,?,?,?,?)').run(req.apiKey.id, key, hash, resource, id);
        return {id, repeated: false};
      })();
    } catch (error) {
      if (error?.code === '23505') throw new ApiError(409, 'Запрос с этим Idempotency-Key уже выполняется');
      throw error;
    }
  }

  // ---------- account ----------
  app.get('/api/v1/me', apiKey(), route(async (req, res) => {
    const name = (await db.prepare("SELECT value FROM app_settings WHERE key='name'").get())?.value || 'OpenCRM';
    res.json({account: {name}, key: {id: req.apiKey.id, name: req.apiKey.name, scopes: req.apiKey.scopes}, scopes: apiScopes});
  }));
  app.get('/api/v1/users', apiKey('users:read'), route(async (_req, res) => {
    const rows = await db.prepare('SELECT u.id,u.name,u.email,u.role,u.group_id,g.name group_name,u.disabled_at,u.created_at FROM users u LEFT JOIN user_groups g ON g.id=u.group_id ORDER BY u.id').all();
    res.json({items: rows.map(({disabled_at, ...row}) => ({...row, active: !disabled_at}))});
  }));

  app.get('/api/v1/task-types', apiKey('tasks:read', 'tasks:write'), route(async (_req, res) => {
    const used = (await db.prepare("SELECT DISTINCT task_type FROM tasks WHERE task_type<>'' ORDER BY task_type").all()).map(row => row.task_type);
    res.json({items: taskTypes, used: used.filter(type => !taskTypes.includes(type))});
  }));

  // ---------- amoCRM sync: status for health checks and the log ----------
  app.get('/api/v1/sync/status', apiKey('deals:read'), route(async (_req, res) => res.json(await syncStatus(db))));
  app.get('/api/v1/sync/log', apiKey('deals:read'), route(async (req, res) => {
    const {after, limit} = pageParams(req);
    const action = queryText(req, 'action', 40), entityType = queryText(req, 'entity_type', 20);
    res.json(await syncLog(db, {after, limit, action, entityType, amoId: queryId(req, 'amo_id') ?? null}));
  }));

  // ---------- stage history (all deals) ----------
  app.get('/api/v1/stage-changes', apiKey('deals:read'), route(async (req, res) => {
    const where = ['TRUE'], params = [];
    for (const key of ['deal_id', 'user_id', 'api_key_id']) {
      const id = queryId(req, key);
      if (id) { where.push(`c.${key}=?`); params.push(id); }
    }
    const pipeline = queryId(req, 'pipeline_id');
    if (pipeline) { where.push('(c.to_pipeline_id=? OR c.from_pipeline_id=?)'); params.push(pipeline, pipeline); }
    const stage = queryId(req, 'to_stage_id');
    if (stage) { where.push('c.to_stage_id=?'); params.push(stage); }
    for (const [key, op] of [['created_since', '>='], ['changed_since', '>='], ['changed_before', '<']]) {
      const time = timestamp(req.query[key], key);
      if (time) { where.push(`c.changed_at${op}?`); params.push(time); }
    }
    await listPage(req, res, {sql: `SELECT c.id,c.deal_id,c.from_stage_id,c.from_pipeline_id,c.to_stage_id,c.to_pipeline_id,c.user_id,c.api_key_id,c.changed_at FROM deal_stage_changes c WHERE ${where.join(' AND ')}`, params, alias: 'c'},
      async rows => rows.map(row => ({...row, changed_by: row.user_id ? {type: 'user', id: row.user_id, ...(row.api_key_id ? {api_key_id: row.api_key_id} : {})} : row.api_key_id ? {type: 'api_key', id: row.api_key_id} : null})));
  }));

  // ---------- notes of all records of one type ----------
  const noteSources = {
    deal: {scope: 'deals:read', sql: "SELECT n.id,'deal' entity_type,n.deal_id entity_id,n.body,n.pinned,n.note_type,n.user_id,n.created_at,n.updated_at FROM notes n JOIN deals e ON e.id=n.deal_id WHERE TRUE", entity: 'n.deal_id'},
    contact: {scope: 'contacts:read', sql: "SELECT n.id,n.entity_type,n.entity_id,n.body,n.note_type,n.user_id,n.created_at,n.updated_at FROM entity_notes n WHERE n.entity_type='contact'", entity: 'n.entity_id'},
    company: {scope: 'companies:read', sql: "SELECT n.id,n.entity_type,n.entity_id,n.body,n.note_type,n.user_id,n.created_at,n.updated_at FROM entity_notes n WHERE n.entity_type='company'", entity: 'n.entity_id'}
  };
  app.get('/api/v1/notes', apiKey('deals:read', 'contacts:read', 'companies:read'), route(async (req, res) => {
    const type = queryText(req, 'entity_type', 20), source = noteSources[type];
    if (!source) bad('entity_type: deal, contact или company');
    if (!req.apiKey.scopes.includes(source.scope)) throw new ApiError(403, `У ключа нет нужного права: ${source.scope}`);
    const where = [], params = [];
    const entity = queryId(req, 'entity_id');
    if (entity) { where.push(`${source.entity}=?`); params.push(entity); }
    const noteType = queryText(req, 'note_type', 40);
    if (noteType) { where.push('n.note_type=?'); params.push(noteType); }
    syncFilters(req, 'n', where, params);
    await listPage(req, res, {sql: `${source.sql}${where.map(item => ` AND ${item}`).join('')}`, params, alias: 'n'}, async rows => rows.map(noteView));
  }));

  // ---------- pipelines, stages and transition rules ----------
  async function pipelineView(rows) {
    if (!rows.length) return [];
    const ids = rows.map(row => row.id);
    const stages = await db.prepare(`SELECT id,pipeline_id,name,kind,color,sort_order FROM stages WHERE pipeline_id IN (${placeholders(ids)}) ORDER BY pipeline_id,sort_order,id`).all(...ids);
    const transitions = await db.prepare(`SELECT t.from_stage_id,t.to_stage_id,s.pipeline_id FROM stage_transitions t JOIN stages s ON s.id=t.from_stage_id WHERE s.pipeline_id IN (${placeholders(ids)}) ORDER BY t.from_stage_id,t.to_stage_id`).all(...ids);
    return rows.map(({transition_mode, lock_deals, ...row}) => ({...row, transition_mode, lock_deals: !!lock_deals, stages: stages.filter(stage => stage.pipeline_id === row.id), transitions: transitions.filter(item => item.pipeline_id === row.id).map(({from_stage_id, to_stage_id}) => ({from_stage_id, to_stage_id}))}));
  }
  const pipelineRead = apiKey('deals:read', 'pipelines:write');
  app.get('/api/v1/pipelines', pipelineRead, route(async (_req, res) => {
    res.json({items: await pipelineView(await db.prepare('SELECT id,name,sort_order,transition_mode,lock_deals FROM pipelines ORDER BY sort_order,id').all())});
  }));
  app.get('/api/v1/pipelines/:id', pipelineRead, route(async (req, res) => {
    const [pipeline] = await pipelineView(await db.prepare('SELECT id,name,sort_order,transition_mode,lock_deals FROM pipelines WHERE id=?').all(positiveId(req.params.id)));
    if (!pipeline) throw new ApiError(404, 'Воронка не найдена');
    res.json(pipeline);
  }));
  const getPipeline = async id => (await pipelineView(await db.prepare('SELECT id,name,sort_order,transition_mode,lock_deals FROM pipelines WHERE id=?').all(id)))[0];
  function stageInput(item, index) {
    if (!item || typeof item !== 'object') bad(`stages[${index}]: ожидается объект`);
    const kind = item.kind ?? 'active';
    if (!['active', 'won', 'lost'].includes(kind)) bad(`stages[${index}].kind: active, won или lost`);
    if (index === null) return {name: text(item, 'name', 120, {required: true}), color: text(item, 'color', 20) || '#cbd9ee', kind};
    return {name: text(item, 'name', 120, {required: true}), color: text(item, 'color', 20) || '#cbd9ee', kind};
  }
  app.post('/api/v1/pipelines', apiKey('pipelines:write'), route(async (req, res) => {
    const body = objectBody(req), name = text(body, 'name', 120, {required: true});
    let stages = [['Новый лид', '#f5e768', 'active'], ['В работе', '#bcd3f6', 'active']].map(([stageName, color, kind]) => ({name: stageName, color, kind}));
    if (has(body, 'stages')) {
      if (!Array.isArray(body.stages) || body.stages.length > 50) bad('stages: список этапов, не больше 50');
      stages = body.stages.map(stageInput);
    }
    if (!stages.some(stage => stage.kind === 'active')) bad('Нужен хотя бы один рабочий этап (kind: active)');
    if (stages.filter(stage => stage.kind === 'won').length > 1 || stages.filter(stage => stage.kind === 'lost').length > 1) bad('Успешный и проигранный этапы — не больше одного каждого');
    // Every pipeline ends with one won and one lost stage, as in the web interface.
    const ordered = [...stages.filter(stage => stage.kind === 'active'), stages.find(stage => stage.kind === 'won') || {name: 'Успешно реализовано', color: '#a9ddb1', kind: 'won'}, stages.find(stage => stage.kind === 'lost') || {name: 'Закрыто и не реализовано', color: '#e8b7b7', kind: 'lost'}];
    const id = await db.transaction(async () => {
      const created = await db.prepare('INSERT INTO pipelines (name,sort_order) VALUES (?,?)').run(name, (await db.prepare('SELECT COUNT(*) n FROM pipelines').get()).n);
      for (const [index, stage] of ordered.entries()) await db.prepare('INSERT INTO stages (pipeline_id,name,color,sort_order,kind) VALUES (?,?,?,?,?)').run(created.lastInsertRowid, stage.name, stage.color, index, stage.kind);
      return created.lastInsertRowid;
    })();
    await audit(req, 'api.pipeline_created', {target: `pipeline:${id}`, details: name, actor: apiActor(req), userId: null});
    res.status(201).json(await getPipeline(id));
  }));
  app.patch('/api/v1/pipelines/:id', apiKey('pipelines:write'), route(async (req, res) => {
    const id = positiveId(req.params.id), body = objectBody(req);
    await liveRow('pipelines', id);
    const name = text(body, 'name', 120, {required: has(body, 'name')}), sort = has(body, 'sort_order') ? Number(body.sort_order) : undefined;
    if (sort !== undefined && (!Number.isSafeInteger(sort) || sort < 0 || sort > 10000)) bad('sort_order: целое число от 0 до 10000');
    if (name !== undefined) await db.prepare('UPDATE pipelines SET name=? WHERE id=?').run(name, id);
    if (sort !== undefined) await db.prepare('UPDATE pipelines SET sort_order=? WHERE id=?').run(sort, id);
    res.json(await getPipeline(id));
  }));
  app.post('/api/v1/pipelines/:id/stages', apiKey('pipelines:write'), route(async (req, res) => {
    const pipelineId = positiveId(req.params.id), body = objectBody(req);
    await liveRow('pipelines', pipelineId);
    const stage = stageInput({...body, kind: 'active'}, null);
    const activeCount = (await db.prepare("SELECT COUNT(*) n FROM stages WHERE pipeline_id=? AND kind='active'").get(pipelineId)).n;
    const position = has(body, 'position') ? Number(body.position) : activeCount;
    if (!Number.isSafeInteger(position) || position < 0 || position > activeCount) bad(`position: от 0 до ${activeCount}`);
    const id = await db.transaction(async () => {
      const active = await db.prepare("SELECT id FROM stages WHERE pipeline_id=? AND kind='active' ORDER BY sort_order,id").all(pipelineId);
      const created = await db.prepare('INSERT INTO stages (pipeline_id,name,color,sort_order,kind) VALUES (?,?,?,?,?)').run(pipelineId, stage.name, stage.color, 0, 'active');
      const ids = active.map(row => row.id);
      ids.splice(position, 0, created.lastInsertRowid);
      for (const [index, stageId] of ids.entries()) await db.prepare('UPDATE stages SET sort_order=? WHERE id=?').run(index, stageId);
      const terminal = await db.prepare("SELECT id FROM stages WHERE pipeline_id=? AND kind<>'active' ORDER BY sort_order,id").all(pipelineId);
      for (const [index, row] of terminal.entries()) await db.prepare('UPDATE stages SET sort_order=? WHERE id=?').run(ids.length + index, row.id);
      return created.lastInsertRowid;
    })();
    res.status(201).json(await db.prepare('SELECT id,pipeline_id,name,kind,color,sort_order FROM stages WHERE id=?').get(id));
  }));
  app.patch('/api/v1/stages/:id', apiKey('pipelines:write'), route(async (req, res) => {
    const id = positiveId(req.params.id), body = objectBody(req), old = await liveRow('stages', id);
    const name = text(body, 'name', 120, {required: has(body, 'name')}) ?? old.name, color = text(body, 'color', 20) || old.color;
    await db.prepare('UPDATE stages SET name=?,color=? WHERE id=?').run(name, color, id);
    res.json(await db.prepare('SELECT id,pipeline_id,name,kind,color,sort_order FROM stages WHERE id=?').get(id));
  }));
  app.put('/api/v1/pipelines/:id/stage-order', apiKey('pipelines:write'), route(async (req, res) => {
    const pipelineId = positiveId(req.params.id), body = objectBody(req);
    await liveRow('pipelines', pipelineId);
    const actual = (await db.prepare("SELECT id FROM stages WHERE pipeline_id=? AND kind='active' ORDER BY sort_order,id").all(pipelineId)).map(row => row.id);
    const ids = idList(body.ids, 'ids', 100);
    if (ids.length !== actual.length || body.ids.length !== actual.length || ids.some(id => !actual.includes(id))) bad('ids: все рабочие этапы воронки без повторов');
    await db.transaction(async () => { for (const [index, id] of ids.entries()) await db.prepare('UPDATE stages SET sort_order=? WHERE id=?').run(index, id); })();
    res.json(await getPipeline(pipelineId));
  }));
  app.get('/api/v1/pipelines/:id/transitions', pipelineRead, route(async (req, res) => {
    const rules = await stageRules.rulesFor(positiveId(req.params.id));
    if (!rules) throw new ApiError(404, 'Воронка не найдена');
    res.json(rules);
  }));
  app.put('/api/v1/pipelines/:id/transitions', apiKey('pipelines:write'), route(async (req, res) => {
    const rules = await stageRules.saveRules(positiveId(req.params.id), objectBody(req));
    await audit(req, 'pipeline.transitions_updated', {target: `pipeline:${rules.pipeline_id}`, details: `${rules.mode}; переходов: ${rules.transitions.length}${rules.lock_deals ? '; без переноса в другие воронки' : ''}`, actor: apiActor(req), userId: null});
    res.json(rules);
  }));

  // ---------- custom fields ----------
  const fieldTypes = {deal: 'deals', contact: 'contacts', company: 'companies'};
  const fieldView = ({options_json, ...row}) => ({...row, options: JSON.parse(options_json || '[]')});
  function fieldOptions(input) {
    if (!Array.isArray(input) || input.length < 1 || input.length > 50) bad('options: от 1 до 50 вариантов');
    const options = input.map(item => typeof item === 'string' ? item.trim() : '');
    if (options.some(item => !item || item.length > 120)) bad('options: непустые строки до 120 символов');
    if (new Set(options.map(item => item.toLocaleLowerCase('ru-RU'))).size !== options.length) bad('options: варианты не должны повторяться');
    return options;
  }
  app.get('/api/v1/custom-fields', apiKey('deals:read', 'contacts:read', 'companies:read', 'fields:write'), route(async (req, res) => {
    const type = queryText(req, 'entity_type', 20);
    if (type && !fieldTypes[type]) bad('entity_type: deal, contact или company');
    const scopes = req.apiKey.scopes, readable = Object.entries(fieldTypes).filter(([kind, table]) => scopes.includes('fields:write') || scopes.includes(`${table}:read`)).map(([kind]) => kind);
    if (type && !readable.includes(type)) throw new ApiError(403, 'У ключа нет права читать записи этого типа');
    const kinds = type ? [type] : readable;
    res.json({items: (await db.prepare(`SELECT id,entity_type,name,field_type,options_json,sort_order,created_at FROM custom_fields WHERE entity_type IN (${placeholders(kinds)}) ORDER BY entity_type,sort_order,id`).all(...kinds)).map(fieldView)});
  }));
  app.post('/api/v1/custom-fields', apiKey('fields:write'), route(async (req, res) => {
    const body = objectBody(req), name = text(body, 'name', 120, {required: true}), type = body.entity_type, fieldType = body.field_type;
    if (!fieldTypes[type]) bad('entity_type: deal, contact или company');
    if (!['text', 'number', 'date', 'url', 'select'].includes(fieldType)) bad('field_type: text, number, date, url или select');
    const options = fieldType === 'select' ? fieldOptions(body.options) : [];
    if (await db.prepare('SELECT id FROM custom_fields WHERE entity_type=? AND lower(name)=lower(?)').get(type, name)) throw new ApiError(409, 'Поле с таким названием уже есть');
    const order = (await db.prepare('SELECT COUNT(*) n FROM custom_fields WHERE entity_type=?').get(type)).n;
    const created = await db.prepare('INSERT INTO custom_fields (entity_type,name,field_type,options_json,sort_order) VALUES (?,?,?,?,?)').run(type, name, fieldType, JSON.stringify(options), order);
    await audit(req, 'api.custom_field_created', {target: `custom_field:${created.lastInsertRowid}`, details: `${type}: ${name}`, actor: apiActor(req), userId: null});
    res.status(201).json(fieldView(await db.prepare('SELECT id,entity_type,name,field_type,options_json,sort_order,created_at FROM custom_fields WHERE id=?').get(created.lastInsertRowid)));
  }));
  app.patch('/api/v1/custom-fields/:id', apiKey('fields:write'), route(async (req, res) => {
    const id = positiveId(req.params.id), body = objectBody(req), old = await liveRow('custom_fields', id);
    const name = text(body, 'name', 120, {required: has(body, 'name')}) ?? old.name;
    if (await db.prepare('SELECT id FROM custom_fields WHERE entity_type=? AND lower(name)=lower(?) AND id<>?').get(old.entity_type, name, id)) throw new ApiError(409, 'Поле с таким названием уже есть');
    let options = JSON.parse(old.options_json || '[]');
    if (has(body, 'options')) {
      if (old.field_type !== 'select') bad('options есть только у полей field_type=select');
      options = fieldOptions(body.options);
      if ((await db.prepare("SELECT DISTINCT value FROM custom_field_values WHERE field_id=? AND value<>''").all(id)).some(row => !options.includes(row.value))) bad('Нельзя удалить вариант, который уже используется');
    }
    await db.prepare('UPDATE custom_fields SET name=?,options_json=? WHERE id=?').run(name, JSON.stringify(options), id);
    res.json(fieldView(await db.prepare('SELECT id,entity_type,name,field_type,options_json,sort_order,created_at FROM custom_fields WHERE id=?').get(id)));
  }));

  // ---------- deals ----------
  const dealColumns = 'd.id,d.name,d.stage_id,s.pipeline_id,s.kind stage_kind,d.owner_id,d.contact_id,d.company_id,d.amount,d.source,d.tags,d.description,d.loss_reason,d.created_at,d.updated_at,d.closed_at,d.deleted_at';
  async function decorateDeals(rows) {
    if (!rows.length) return [];
    const ids = rows.map(row => row.id);
    const links = await db.prepare(`SELECT dc.deal_id,dc.contact_id FROM deal_contacts dc JOIN contacts c ON c.id=dc.contact_id AND c.deleted_at IS NULL WHERE dc.deal_id IN (${placeholders(ids)}) ORDER BY dc.created_at,dc.contact_id`).all(...ids);
    const custom = await customValues('deal', ids);
    return rows.map(row => {
      const contacts = links.filter(link => link.deal_id === row.id).map(link => link.contact_id);
      const ordered = row.contact_id && contacts.includes(row.contact_id) ? [row.contact_id, ...contacts.filter(id => id !== row.contact_id)] : contacts;
      return {...row, contact_ids: ordered, custom_fields: custom.get(row.id)};
    });
  }
  const getDeal = async id => (await decorateDeals(await db.prepare(`SELECT ${dealColumns} FROM deals d JOIN stages s ON s.id=d.stage_id WHERE d.deleted_at IS NULL AND d.id=?`).all(id)))[0];
  async function dealContactsInput(body) {
    if (!has(body, 'contact_ids') && !has(body, 'contact_id')) return undefined;
    const ids = [];
    if (has(body, 'contact_id') && body.contact_id !== null) { const id = idField(body, 'contact_id'); if (id) ids.push(id); }
    if (has(body, 'contact_ids')) ids.push(...idList(body.contact_ids ?? [], 'contact_ids'));
    const unique = [...new Set(ids)];
    for (const id of unique) await ensureRef('contacts', id, 'Контакт');
    return unique;
  }
  async function replaceDealContacts(dealId, wanted, label, userId = null) {
    const current = (await db.prepare('SELECT dc.contact_id,c.name FROM deal_contacts dc JOIN contacts c ON c.id=dc.contact_id WHERE dc.deal_id=?').all(dealId));
    // The main contact first: its deal.updated then covers the link changes below (one event).
    await db.prepare('UPDATE deals SET contact_id=? WHERE id=?').run(wanted[0] || null, dealId);
    for (const row of current.filter(row => !wanted.includes(row.contact_id))) {
      await db.prepare('DELETE FROM deal_contacts WHERE deal_id=? AND contact_id=?').run(dealId, row.contact_id);
      await event(dealId, userId, `Контакт удалён из сделки: ${row.name} ${label}`);
    }
    for (const id of wanted.filter(id => !current.some(row => row.contact_id === id))) {
      await db.prepare('INSERT INTO deal_contacts (deal_id,contact_id) VALUES (?,?) ON CONFLICT DO NOTHING').run(dealId, id);
      await event(dealId, userId, `Контакт добавлен: ${(await db.prepare('SELECT name FROM contacts WHERE id=?').get(id)).name} ${label}`);
    }
  }
  async function resolveStage(body, current) {
    const stageId = idField(body, 'stage_id'), pipelineId = idField(body, 'pipeline_id');
    if (stageId === null || pipelineId === null) bad('stage_id и pipeline_id не могут быть пустыми');
    if (stageId) {
      const stage = await db.prepare('SELECT id,pipeline_id,kind,name FROM stages WHERE id=?').get(stageId);
      if (!stage) bad(`Этап ${stageId} не найден`);
      if (pipelineId && stage.pipeline_id !== pipelineId) bad('Этап не относится к указанной воронке');
      return stage;
    }
    if (pipelineId) {
      if (current && current.pipeline_id === pipelineId) return current;
      const stage = await db.prepare("SELECT id,pipeline_id,kind,name FROM stages WHERE pipeline_id=? AND kind='active' ORDER BY sort_order,id LIMIT 1").get(pipelineId);
      if (!stage) bad(`Воронка ${pipelineId} не найдена`);
      return stage;
    }
    if (current) return current;
    bad('Укажите stage_id или pipeline_id');
  }

  app.get('/api/v1/deals', apiKey('deals:read'), route(async (req, res) => {
    const where = ['TRUE'], params = [];
    deletedFilter(req, 'd', where, params);
    for (const [key, column] of [['pipeline_id', 's.pipeline_id'], ['stage_id', 'd.stage_id'], ['owner_id', 'd.owner_id'], ['company_id', 'd.company_id']]) {
      const id = queryId(req, key);
      if (id) { where.push(`${column}=?`); params.push(id); }
    }
    const contact = queryId(req, 'contact_id');
    if (contact) { where.push('(d.contact_id=? OR EXISTS(SELECT 1 FROM deal_contacts dc WHERE dc.deal_id=d.id AND dc.contact_id=?))'); params.push(contact, contact); }
    const kind = queryText(req, 'stage_kind', 10);
    if (kind) { if (!['active', 'won', 'lost'].includes(kind)) bad('stage_kind: active, won или lost'); where.push('s.kind=?'); params.push(kind); }
    const q = queryText(req, 'q');
    if (q) { where.push('contains_search(d.name,?)'); params.push(q); }
    for (const [key, op] of [['closed_since', '>='], ['closed_before', '<']]) {
      const time = timestamp(req.query[key], key);
      if (time) { where.push(`d.closed_at IS NOT NULL AND d.closed_at${op}?`); params.push(time); }
    }
    await customFieldFilter(req, 'deal', 'd', where, params);
    syncFilters(req, 'd', where, params);
    await listPage(req, res, {sql: `SELECT ${dealColumns} FROM deals d JOIN stages s ON s.id=d.stage_id WHERE ${where.join(' AND ')}`, params, alias: 'd'}, decorateDeals);
  }));
  app.get('/api/v1/deals/:id', apiKey('deals:read'), route(async (req, res) => {
    const deal = await getDeal(positiveId(req.params.id));
    if (!deal) throw new ApiError(404, 'Сделка не найдена');
    res.json(deal);
  }));
  app.post('/api/v1/deals', apiKey('deals:write'), route(async (req, res) => {
    const body = objectBody(req), stage = await resolveStage(body);
    const saved = {name: text(body, 'name', 255, {required: true}), owner_id: idField(body, 'owner_id') ?? null, company_id: idField(body, 'company_id') ?? null, amount: amountField(body) ?? 0, source: text(body, 'source', 255) ?? '', tags: tagsField(body) ?? '', description: text(body, 'description', 10000) ?? '', loss_reason: stage.kind === 'lost' ? text(body, 'loss_reason', 120) ?? '' : ''};
    await userRef(req, saved.owner_id);
    await ensureRef('companies', saved.company_id, 'Компания');
    const contacts = await dealContactsInput(body) ?? [], custom = await customInput('deal', body);
    const times = await mirrorCreate(req, body, 'deals'), closedAt = mirror(req) && stage.kind !== 'active' ? mirrorTime(body.closed_at, 'closed_at') : undefined;
    const result = await idempotent(req, 'deal', {...saved, stage_id: stage.id, contacts, custom: custom.map(item => [item.field.id, item.value]), ...times, closed_at: closedAt}, async () => {
      const id = await insertRow('deals', {id: times.id, name: saved.name, stage_id: stage.id, contact_id: contacts[0] || null, company_id: saved.company_id, owner_id: saved.owner_id, amount: saved.amount, source: saved.source, tags: saved.tags, description: saved.description, loss_reason: saved.loss_reason, created_at: times.created_at, closed_at: closedAt});
      for (const contactId of contacts) await db.prepare('INSERT INTO deal_contacts (deal_id,contact_id) VALUES (?,?) ON CONFLICT DO NOTHING').run(id, contactId);
      await event(id, who(req), `Сделка создана ${via(req)}`);
      await saveCustom('deal', id, custom, via(req), who(req));
      if (!mirror(req)) {
        await runStageAutomation(id, stage.id, saved.owner_id, null);
        await queueDistribution(db, id, 'api');
      }
      await finishMirror('deals', id, times);
      return id;
    });
    res.status(result.repeated ? 200 : 201).json({...await getDeal(result.id), repeated: result.repeated});
  }));
  app.patch('/api/v1/deals/:id', apiKey('deals:write'), route(async (req, res) => {
    const id = positiveId(req.params.id), body = objectBody(req), old = await liveRow('deals', id);
    const current = await db.prepare('SELECT id,pipeline_id,kind,name FROM stages WHERE id=?').get(old.stage_id);
    const stage = await resolveStage(body, current);
    if (stage.id !== old.stage_id && !mirror(req)) { const ruleError = await stageRules.transitionError(old.stage_id, stage.id); if (ruleError) throw new ApiError(403, ruleError); }
    const reason = text(body, 'loss_reason', 120);
    const saved = {
      name: text(body, 'name', 255, {required: has(body, 'name')}) ?? old.name,
      owner_id: has(body, 'owner_id') ? idField(body, 'owner_id') : old.owner_id,
      company_id: has(body, 'company_id') ? idField(body, 'company_id') : old.company_id,
      amount: amountField(body) ?? old.amount, source: text(body, 'source', 255) ?? old.source, tags: tagsField(body) ?? old.tags,
      description: text(body, 'description', 10000) ?? old.description,
      loss_reason: stage.kind !== 'lost' ? '' : reason ?? (stage.id === old.stage_id ? old.loss_reason : '')
    };
    if (saved.owner_id !== old.owner_id) await userRef(req, saved.owner_id);
    if (saved.company_id !== old.company_id) await ensureRef('companies', saved.company_id, 'Компания');
    const contacts = await dealContactsInput(body), custom = await customInput('deal', body);
    await db.transaction(async () => {
      await db.prepare('UPDATE deals SET name=?,stage_id=?,company_id=?,owner_id=?,amount=?,source=?,tags=?,description=?,loss_reason=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(saved.name, stage.id, saved.company_id, saved.owner_id, saved.amount, saved.source, saved.tags, saved.description, saved.loss_reason, id);
      if (contacts) await replaceDealContacts(id, contacts, via(req), who(req));
      if (stage.id !== old.stage_id) {
        const moved = await db.prepare('SELECT s.name,s.pipeline_id,p.name pipeline_name FROM stages s JOIN pipelines p ON p.id=s.pipeline_id WHERE s.id=?').get(stage.id);
        await event(id, who(req), `Этап изменён: ${moved.name}${moved.pipeline_id !== current.pipeline_id ? ` · Перенос в воронку «${moved.pipeline_name}»` : ''}${saved.loss_reason ? ` · ${saved.loss_reason}` : ''} ${via(req)}`);
        if (!mirror(req)) await runStageAutomation(id, stage.id, saved.owner_id, null);
      } else if (saved.loss_reason !== old.loss_reason) await event(id, who(req), `Причина отказа: ${saved.loss_reason || 'Без причины'} ${via(req)}`);
      const fresh = await db.prepare('SELECT * FROM deals WHERE id=?').get(id);
      await logDealChanges(id, who(req), old, fresh);
      await saveCustom('deal', id, custom, via(req), who(req));
    })();
    res.json(await getDeal(id));
  }));
  app.patch('/api/v1/deals/:id/stage', apiKey('deals:write'), route(async (req, res) => {
    const id = positiveId(req.params.id), body = objectBody(req), stageId = positiveId(body.stage_id), deal = await db.prepare('SELECT d.id,d.stage_id,d.owner_id,s.pipeline_id FROM deals d JOIN stages s ON s.id=d.stage_id WHERE d.id=? AND d.deleted_at IS NULL').get(id);
    if (!deal) throw new ApiError(404, 'Сделка не найдена');
    const stage = await db.prepare('SELECT s.id,s.pipeline_id,s.kind,s.name,p.name pipeline_name FROM stages s JOIN pipelines p ON p.id=s.pipeline_id WHERE s.id=?').get(stageId);
    // The mirror key may also move the deal to another pipeline.
    if (!stage || stage.pipeline_id !== deal.pipeline_id && !mirror(req)) bad('Выберите этап этой воронки');
    if (stage.id === deal.stage_id) return res.json({id, stage_id: stage.id, unchanged: true});
    if (!mirror(req)) {
      const ruleError = await stageRules.transitionError(deal.stage_id, stage.id);
      if (ruleError) throw new ApiError(403, ruleError);
    }
    const reason = typeof body.loss_reason === 'string' ? body.loss_reason.trim().slice(0, 120) : '';
    if (stage.kind === 'lost' && !reason && !mirror(req)) bad('Укажите причину отказа');
    await db.transaction(async () => {
      await db.prepare('UPDATE deals SET stage_id=?,loss_reason=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(stage.id, stage.kind === 'lost' ? reason : '', id);
      await event(id, who(req), `Этап изменён через API: ${stage.name}${stage.pipeline_id !== deal.pipeline_id ? ` · Перенос в воронку «${stage.pipeline_name}»` : ''}`);
      if (!mirror(req)) await runStageAutomation(id, stage.id, deal.owner_id, null);
    })();
    res.json({id, stage_id: stage.id});
  }));
  app.get('/api/v1/deals/:id/allowed-stages', apiKey('deals:read'), route(async (req, res) => {
    const deal = await liveRow('deals', positiveId(req.params.id));
    res.json({stage_id: deal.stage_id, stage_ids: await stageRules.allowedTargets(deal.stage_id)});
  }));
  app.delete('/api/v1/deals/:id', apiKey('deals:write'), route(async (req, res) => {
    const id = positiveId(req.params.id);
    await liveRow('deals', id);
    await db.transaction(async () => {
      await event(id, who(req), `Сделка перемещена в корзину ${via(req)}`);
      await db.prepare('UPDATE deals SET deleted_at=CURRENT_TIMESTAMP WHERE id=?').run(id);
    })();
    res.json({ok: true});
  }));
  app.post('/api/v1/deals/:id/contacts', apiKey('deals:write'), route(async (req, res) => {
    const id = positiveId(req.params.id), body = objectBody(req), contactId = idField(body, 'contact_id');
    await liveRow('deals', id);
    if (!contactId) bad('Укажите contact_id');
    await ensureRef('contacts', contactId, 'Контакт');
    const ids = (await getDeal(id)).contact_ids;
    if (!ids.includes(contactId)) await db.transaction(() => replaceDealContacts(id, flag(body, 'main') ? [contactId, ...ids] : [...ids, contactId], via(req), who(req)))();
    else if (flag(body, 'main')) await db.transaction(() => replaceDealContacts(id, [contactId, ...ids.filter(item => item !== contactId)], via(req), who(req)))();
    res.status(201).json(await getDeal(id));
  }));
  app.delete('/api/v1/deals/:id/contacts/:contactId', apiKey('deals:write'), route(async (req, res) => {
    const id = positiveId(req.params.id), contactId = positiveId(req.params.contactId);
    await liveRow('deals', id);
    const ids = (await getDeal(id)).contact_ids;
    if (!ids.includes(contactId)) throw new ApiError(404, 'Контакт не связан со сделкой');
    await db.transaction(() => replaceDealContacts(id, ids.filter(item => item !== contactId), via(req), who(req)))();
    res.json(await getDeal(id));
  }));
  app.get('/api/v1/deals/:id/activity', apiKey('deals:read'), route(async (req, res) => {
    const id = positiveId(req.params.id);
    await liveRow('deals', id);
    res.json({items: await db.prepare('SELECT a.id,a.event,a.user_id,u.name author,a.created_at FROM activity a LEFT JOIN users u ON u.id=a.user_id WHERE a.deal_id=? ORDER BY a.id DESC LIMIT 500').all(id)});
  }));
  app.get('/api/v1/deals/:id/communications', apiKey('deals:read'), route(async (req, res) => {
    const id = positiveId(req.params.id);
    await liveRow('deals', id);
    res.json({items: await db.prepare('SELECT id,kind,direction,subject,body,user_id,created_at FROM deal_communications WHERE deal_id=? ORDER BY id DESC LIMIT 500').all(id)});
  }));
  // Letters from connected mailboxes linked to the deal, oldest first.
  app.get('/api/v1/deals/:id/emails', apiKey('emails:read'), route(async (req, res) => {
    const id = positiveId(req.params.id);
    await liveRow('deals', id);
    res.json({items: (await db.prepare(`${emailSelect} WHERE e.deal_id=? ORDER BY e.sent_at,e.id LIMIT 1000`).all(id)).map(row => emailView(row))});
  }));
  // Every stored letter, including the ones not linked to a deal (linked=0).
  app.get('/api/v1/emails', apiKey('emails:read'), route(async (req, res) => {
    const where = ['1=1'], params = [];
    const deal = queryId(req, 'deal_id'), mailbox = queryId(req, 'mailbox_id'), messageId = queryText(req, 'message_id', 500), created = timestamp(req.query.created_since, 'created_since');
    const linked = req.query.linked == null ? '' : String(req.query.linked);
    if (!['', '0', '1'].includes(linked)) bad('linked: 1 или 0');
    if (deal) { where.push('e.deal_id=?'); params.push(deal); }
    if (mailbox) { where.push('e.mailbox_id=?'); params.push(mailbox); }
    if (messageId) { where.push('(e.message_id=? OR e.in_reply_to=?)'); params.push(messageId, messageId); }
    if (created) { where.push('e.created_at>=?'); params.push(created); }
    if (linked) where.push(linked === '1' ? 'e.deal_id IS NOT NULL' : 'e.deal_id IS NULL');
    await listPage(req, res, {sql: `${emailSelect} WHERE ${where.join(' AND ')}`, params, alias: 'e'}, async items => items.map(row => emailView(row)));
  }));
  app.post('/api/v1/deals/:id/communications', apiKey('deals:write'), route(async (req, res) => {
    const id = positiveId(req.params.id), body = objectBody(req);
    await liveRow('deals', id);
    if (!['call', 'email', 'message'].includes(body.kind)) bad('kind: call, email или message');
    if (!['incoming', 'outgoing'].includes(body.direction)) bad('direction: incoming или outgoing');
    const subject = text(body, 'subject', 255) ?? '', content = text(body, 'body', 10000, {required: true}), userId = idField(body, 'user_id') ?? who(req);
    if (body.kind !== 'email' && subject) bad('subject есть только у писем (kind: email)');
    await userRef(req, userId);
    const created = await db.prepare('INSERT INTO deal_communications (deal_id,user_id,kind,direction,subject,body) VALUES (?,?,?,?,?,?)').run(id, userId, body.kind, body.direction, subject, content);
    res.status(201).json(await db.prepare('SELECT id,deal_id,kind,direction,subject,body,user_id,created_at FROM deal_communications WHERE id=?').get(created.lastInsertRowid));
  }));

  // ---------- notes (deals, contacts, companies) ----------
  const noteView = ({pinned, ...row}) => ({...row, ...(pinned === undefined ? {} : {pinned: !!pinned})});
  app.get('/api/v1/deals/:id/notes', apiKey('deals:read'), route(async (req, res) => {
    const id = positiveId(req.params.id);
    await liveRow('deals', id);
    const noteType = queryText(req, 'note_type', 40);
    res.json({items: (await db.prepare(`SELECT id,deal_id,body,pinned,note_type,user_id,created_at,updated_at FROM notes WHERE deal_id=?${noteType ? ' AND note_type=?' : ''} ORDER BY id DESC LIMIT 500`).all(id, ...(noteType ? [noteType] : []))).map(noteView)});
  }));
  app.post('/api/v1/deals/:id/notes', apiKey('deals:write'), route(async (req, res) => {
    const id = positiveId(req.params.id), body = objectBody(req);
    await liveRow('deals', id);
    const content = text(body, 'body', 10000, {required: true}), userId = idField(body, 'user_id') ?? who(req), pinned = flag(body, 'pinned') ?? false;
    await userRef(req, userId);
    const times = await mirrorCreate(req, body, 'notes'), noteType = mirror(req) ? text(body, 'note_type', 40) || undefined : undefined;
    const noteId = await db.transaction(async () => {
      const created = await insertRow('notes', {id: times.id, deal_id: id, user_id: userId, body: content, pinned: pinned ? 1 : 0, note_type: noteType, created_at: times.created_at, updated_at: times.updated_at ?? times.created_at});
      await event(id, userId, `Добавлена заметка ${via(req)}`);
      return created;
    })();
    res.status(201).json(noteView(await db.prepare('SELECT id,deal_id,body,pinned,note_type,user_id,created_at,updated_at FROM notes WHERE id=?').get(noteId)));
  }));
  app.patch('/api/v1/deals/:id/notes/:noteId', apiKey('deals:write'), route(async (req, res) => {
    const id = positiveId(req.params.id), noteId = positiveId(req.params.noteId), body = objectBody(req), pinned = flag(body, 'pinned');
    if (pinned === undefined) bad('Передайте pinned: true или false');
    const result = await db.prepare('UPDATE notes SET pinned=? WHERE id=? AND deal_id=?').run(pinned ? 1 : 0, noteId, id);
    if (!result.changes) throw new ApiError(404, 'Примечание не найдено');
    res.json(noteView(await db.prepare('SELECT id,deal_id,body,pinned,note_type,user_id,created_at,updated_at FROM notes WHERE id=?').get(noteId)));
  }));

  // ---------- contacts and companies ----------
  const entities = {
    contact: {table: 'contacts', path: 'contacts', scope: 'contacts', label: 'Контакт', created: 'Контакт создан',
      fields: [['name', 255], ['phone', 80], ['email', 254], ['telegram', 120], ['position', 255], ['notes', 5000]], refs: [['company_id', 'companies', 'Компания']],
      columns: 'x.id,x.name,x.company_id,x.owner_id,x.phone,x.email,x.telegram,x.position,x.notes,x.tags,x.created_at,x.updated_at,x.deleted_at'},
    company: {table: 'companies', path: 'companies', scope: 'companies', label: 'Компания', created: 'Компания создана',
      fields: [['name', 255], ['phone', 80], ['email', 254], ['website', 255], ['address', 500], ['notes', 5000]], refs: [],
      columns: 'x.id,x.name,x.owner_id,x.phone,x.email,x.website,x.address,x.notes,x.tags,x.created_at,x.updated_at,x.deleted_at'}
  };
  for (const [type, spec] of Object.entries(entities)) {
    const read = apiKey(`${spec.scope}:read`), write = apiKey(`${spec.scope}:write`);
    const decorate = async rows => { const custom = await customValues(type, rows.map(row => row.id)); return rows.map(row => ({...row, custom_fields: custom.get(row.id)})); };
    const getOne = async id => (await decorate(await db.prepare(`SELECT ${spec.columns} FROM ${spec.table} x WHERE x.deleted_at IS NULL AND x.id=?`).all(id)))[0];
    const columns = ['owner_id', ...spec.refs.map(([key]) => key), ...spec.fields.map(([key]) => key), 'tags'];

    app.get(`/api/v1/${spec.path}`, read, route(async (req, res) => {
      const where = ['TRUE'], params = [];
      deletedFilter(req, 'x', where, params);
      for (const key of ['owner_id', ...spec.refs.map(([key]) => key)]) {
        const id = queryId(req, key);
        if (id) { where.push(`x.${key}=?`); params.push(id); }
      }
      const q = queryText(req, 'q');
      if (q) { where.push('(contains_search(x.name,?) OR contains_search(x.email,?) OR contains_search(x.phone,?))'); params.push(q, q, q); }
      const email = queryText(req, 'email', 254);
      if (email) { where.push('lower(x.email)=lower(?)'); params.push(email); }
      const phone = queryText(req, 'phone', 80);
      if (phone) {
        const digits = phone.replace(/\D/g, '');
        if (digits.length < 5) bad('phone: нужно хотя бы 5 цифр');
        where.push("strpos(regexp_replace(x.phone,'[^0-9]','','g'),?)>0"); params.push(digits.slice(-10));
      }
      const telegram = queryText(req, 'telegram', 120);
      if (telegram) {
        if (type !== 'contact') bad('Фильтр telegram есть только у контактов');
        where.push("x.telegram<>'' AND normalize_telegram(x.telegram)=normalize_telegram(?)"); params.push(telegram);
      }
      await customFieldFilter(req, type, 'x', where, params);
      const tag = queryText(req, 'tag', 120);
      if (tag) { where.push('has_entity_tag(x.tags,?)'); params.push(tag); }
      syncFilters(req, 'x', where, params);
      await listPage(req, res, {sql: `SELECT ${spec.columns} FROM ${spec.table} x WHERE ${where.join(' AND ')}`, params, alias: 'x'}, decorate);
    }));
    app.get(`/api/v1/${spec.path}/:id`, read, route(async (req, res) => {
      const row = await getOne(positiveId(req.params.id));
      if (!row) throw new ApiError(404, missing[spec.table]);
      res.json(row);
    }));
    async function entityInput(body, old, anyUser = false) {
      const saved = {};
      for (const [key, max] of spec.fields) {
        const value = text(body, key, max, {required: key === 'name' && (!old || has(body, 'name'))});
        saved[key] = value ?? (old ? old[key] : '');
      }
      saved.tags = tagsField(body) ?? (old ? old.tags : '');
      saved.owner_id = has(body, 'owner_id') ? idField(body, 'owner_id') : old ? old.owner_id : null;
      if (!old || saved.owner_id !== old.owner_id) await ensureRef('users', saved.owner_id, 'Пользователь', {anyUser});
      for (const [key, table, label] of spec.refs) {
        saved[key] = has(body, key) ? idField(body, key) : old ? old[key] : null;
        if (!old || saved[key] !== old[key]) await ensureRef(table, saved[key], label);
      }
      return saved;
    }
    app.post(`/api/v1/${spec.path}`, write, route(async (req, res) => {
      const body = objectBody(req), saved = await entityInput(body, undefined, mirror(req)), custom = await customInput(type, body);
      const times = await mirrorCreate(req, body, spec.table);
      const result = await idempotent(req, type, {...saved, custom: custom.map(item => [item.field.id, item.value]), ...times}, async () => {
        const id = await insertRow(spec.table, {id: times.id, ...Object.fromEntries(columns.map(key => [key, saved[key]])), created_at: times.created_at});
        await entityEvent(type, id, who(req), `${spec.created} ${via(req)}`);
        await saveCustom(type, id, custom, via(req), who(req));
        await finishMirror(spec.table, id, times);
        return id;
      });
      res.status(result.repeated ? 200 : 201).json({...await getOne(result.id), repeated: result.repeated});
    }));
    app.patch(`/api/v1/${spec.path}/:id`, write, route(async (req, res) => {
      const id = positiveId(req.params.id), body = objectBody(req), old = await liveRow(spec.table, id);
      const saved = await entityInput(body, old, mirror(req)), custom = await customInput(type, body);
      await db.transaction(async () => {
        await db.prepare(`UPDATE ${spec.table} SET ${columns.map(key => `${key}=?`).join(',')} WHERE id=?`).run(...columns.map(key => saved[key]), id);
        await logEntityChanges(type, id, who(req), old, saved);
        await saveCustom(type, id, custom, via(req), who(req));
      })();
      res.json(await getOne(id));
    }));
    app.delete(`/api/v1/${spec.path}/:id`, write, route(async (req, res) => {
      const id = positiveId(req.params.id);
      const result = await db.prepare(`UPDATE ${spec.table} SET deleted_at=CURRENT_TIMESTAMP WHERE id=? AND deleted_at IS NULL`).run(id);
      if (!result.changes) throw new ApiError(404, missing[spec.table]);
      await entityEvent(type, id, who(req), `Запись перемещена в корзину ${via(req)}`);
      res.json({ok: true});
    }));
    app.get(`/api/v1/${spec.path}/:id/notes`, read, route(async (req, res) => {
      const id = positiveId(req.params.id);
      await liveRow(spec.table, id);
      const noteType = queryText(req, 'note_type', 40);
      res.json({items: await db.prepare(`SELECT id,entity_type,entity_id,body,note_type,user_id,created_at,updated_at FROM entity_notes WHERE entity_type=? AND entity_id=?${noteType ? ' AND note_type=?' : ''} ORDER BY id DESC LIMIT 500`).all(type, id, ...(noteType ? [noteType] : []))});
    }));
    app.post(`/api/v1/${spec.path}/:id/notes`, write, route(async (req, res) => {
      const id = positiveId(req.params.id), body = objectBody(req);
      await liveRow(spec.table, id);
      const content = text(body, 'body', 10000, {required: true}), userId = idField(body, 'user_id') ?? who(req);
      await userRef(req, userId);
      const times = await mirrorCreate(req, body, 'entity_notes'), noteType = mirror(req) ? text(body, 'note_type', 40) || undefined : undefined;
      const created = await db.transaction(() => insertRow('entity_notes', {id: times.id, entity_type: type, entity_id: id, user_id: userId, body: content, note_type: noteType, created_at: times.created_at, updated_at: times.updated_at ?? times.created_at}))();
      res.status(201).json(await db.prepare('SELECT id,entity_type,entity_id,body,note_type,user_id,created_at,updated_at FROM entity_notes WHERE id=?').get(created));
    }));
  }

  // ---------- tasks ----------
  const taskColumns = 't.id,t.title,t.description,t.task_type,t.due_at,t.duration_minutes,t.all_day,t.completed_at,t.completion_result,t.deal_id,t.contact_id,t.company_id,t.owner_id,t.created_at,t.updated_at,t.deleted_at';
  const taskView = row => ({...row, all_day: !!row.all_day, completed: !!row.completed_at});
  const taskLive = 't.deleted_at IS NULL AND (t.deal_id IS NULL OR d.deleted_at IS NULL)';
  const taskFrom = `FROM tasks t LEFT JOIN deals d ON d.id=t.deal_id WHERE ${taskLive}`;
  const getTask = async id => { const row = await db.prepare(`SELECT ${taskColumns} ${taskFrom} AND t.id=?`).get(id); return row && taskView(row); };
  app.get('/api/v1/tasks', apiKey('tasks:read'), route(async (req, res) => {
    const where = [], params = [];
    deletedFilter(req, 't', where, params, taskLive);
    for (const key of ['deal_id', 'contact_id', 'company_id', 'owner_id']) {
      const id = queryId(req, key);
      if (id) { where.push(`t.${key}=?`); params.push(id); }
    }
    const state = queryText(req, 'state', 10) || 'all';
    if (!['open', 'done', 'all'].includes(state)) bad('state: open, done или all');
    if (state === 'open') where.push('t.completed_at IS NULL');
    if (state === 'done') where.push('t.completed_at IS NOT NULL');
    for (const [key, op] of [['due_from', '>='], ['due_to', '<']]) {
      const raw = queryText(req, key, 40);
      if (!raw) continue;
      const parsed = Date.parse(raw);
      if (!Number.isFinite(parsed)) bad(`${key}: дата в формате ISO 8601`);
      where.push(`t.due_at IS NOT NULL AND t.due_at${op}?`); params.push(new Date(parsed).toISOString());
    }
    syncFilters(req, 't', where, params);
    const typeFilter = queryText(req, 'task_type', 50);
    if (typeFilter) { where.push('t.task_type=?'); params.push(typeFilter); }
    await listPage(req, res, {sql: `SELECT ${taskColumns} FROM tasks t LEFT JOIN deals d ON d.id=t.deal_id WHERE TRUE${where.map(item => ` AND ${item}`).join('')}`, params, alias: 't'}, async rows => rows.map(taskView));
  }));
  app.get('/api/v1/tasks/:id', apiKey('tasks:read'), route(async (req, res) => {
    const task = await getTask(positiveId(req.params.id));
    if (!task) throw new ApiError(404, 'Задача не найдена');
    res.json(task);
  }));
  async function taskInput(body, old, anyUser = false) {
    const links = {};
    for (const [key, table, label] of [['deal_id', 'deals', 'Сделка'], ['contact_id', 'contacts', 'Контакт'], ['company_id', 'companies', 'Компания']]) {
      links[key] = has(body, key) ? idField(body, key) : old ? old[key] : null;
      if (!old || links[key] !== old[key]) await ensureRef(table, links[key], label);
    }
    if (links.company_id && (links.deal_id || links.contact_id)) bad('Задачу привязывают либо к компании, либо к сделке и/или контакту');
    let owner = has(body, 'owner_id') ? idField(body, 'owner_id') : old ? old.owner_id : null;
    if (!old && !owner) {
      // Like the web interface the task needs an owner: by default the owner of the linked record.
      const linked = links.deal_id ? await db.prepare('SELECT owner_id FROM deals WHERE id=?').get(links.deal_id) : links.contact_id ? await db.prepare('SELECT owner_id FROM contacts WHERE id=?').get(links.contact_id) : links.company_id ? await db.prepare('SELECT owner_id FROM companies WHERE id=?').get(links.company_id) : null;
      owner = linked?.owner_id || null;
      if (!owner) bad('Укажите owner_id: у связанной записи нет ответственного');
    }
    if (!old || owner !== old.owner_id) await ensureRef('users', owner, 'Пользователь', {anyUser});
    const schedule = taskSchedule({
      due_at: has(body, 'due_at') ? body.due_at : old?.due_at ?? null,
      duration_minutes: has(body, 'duration_minutes') ? body.duration_minutes : old?.duration_minutes ?? 0,
      all_day: has(body, 'all_day') ? body.all_day : old ? old.all_day : false
    });
    if (!schedule) bad('Проверьте срок: due_at в ISO 8601, duration_minutes 0–1440 и только вместе с due_at, all_day — только вместе с due_at');
    return {title: text(body, 'title', 500, {required: !old || has(body, 'title')}) ?? old.title, description: text(body, 'description', 5000) ?? (old ? old.description : ''), task_type: text(body, 'task_type', 50) || (old ? old.task_type : 'Связаться'), owner_id: owner, ...links, ...schedule};
  }
  app.post('/api/v1/tasks', apiKey('tasks:write'), route(async (req, res) => {
    const body = objectBody(req), saved = await taskInput(body, undefined, mirror(req));
    const times = await mirrorCreate(req, body, 'tasks');
    // The mirror key may create a task that is already done (completed, result, completed_at).
    const done = mirror(req) && flag(body, 'completed') === true ? {completed_at: isoTime(body.completed_at, 'completed_at') || new Date().toISOString(), completion_result: text(body, 'result', 5000) ?? '', completed_by: who(req)} : {};
    const result = await idempotent(req, 'task', {...saved, ...times, ...done}, async () => {
      const id = await insertRow('tasks', {id: times.id, title: saved.title, description: saved.description, task_type: saved.task_type, due_at: saved.due_at, duration_minutes: saved.duration_minutes, all_day: saved.all_day, deal_id: saved.deal_id, contact_id: saved.contact_id, company_id: saved.company_id, owner_id: saved.owner_id, created_at: times.created_at, ...done});
      if (saved.deal_id) await event(saved.deal_id, who(req), `Задача создана ${via(req)}: ${saved.title}`.slice(0, 1000));
      await finishMirror('tasks', id, times);
      return id;
    });
    res.status(result.repeated ? 200 : 201).json({...await getTask(result.id), repeated: result.repeated});
  }));
  app.patch('/api/v1/tasks/:id', apiKey('tasks:write'), route(async (req, res) => {
    const id = positiveId(req.params.id), body = objectBody(req), old = await getTask(id);
    if (!old) throw new ApiError(404, 'Задача не найдена');
    const saved = await taskInput(body, {...old, all_day: old.all_day ? 1 : 0}, mirror(req)), completed = flag(body, 'completed');
    const resultText = text(body, 'result', 5000);
    const doneAt = mirror(req) && isoTime(body.completed_at, 'completed_at');
    const completedAt = completed === true ? old.completed_at || doneAt || new Date().toISOString() : completed === false ? null : old.completed_at;
    const completionResult = completed === false ? '' : resultText ?? old.completion_result;
    await db.transaction(async () => {
      await db.prepare('UPDATE tasks SET title=?,description=?,task_type=?,due_at=?,duration_minutes=?,all_day=?,owner_id=?,deal_id=?,contact_id=?,company_id=?,completed_at=?,completion_result=? WHERE id=?').run(saved.title, saved.description, saved.task_type, saved.due_at, saved.duration_minutes, saved.all_day, saved.owner_id, saved.deal_id, saved.contact_id, saved.company_id, completedAt, completionResult, id);
      if (saved.deal_id && !old.completed_at && completedAt) await event(saved.deal_id, who(req), `Задача выполнена${completionResult ? `: ${completionResult}` : ''} ${via(req)}`.slice(0, 1000));
      if (saved.deal_id && old.completed_at && !completedAt) await event(saved.deal_id, who(req), `Задача возвращена в работу ${via(req)}`);
    })();
    res.json(await getTask(id));
  }));
  app.delete('/api/v1/tasks/:id', apiKey('tasks:write'), route(async (req, res) => {
    const id = positiveId(req.params.id), task = await getTask(id);
    if (!task) throw new ApiError(404, 'Задача не найдена');
    await db.prepare('UPDATE tasks SET deleted_at=CURRENT_TIMESTAMP WHERE id=?').run(id);
    if (task.deal_id) await event(task.deal_id, who(req), `Задача перемещена в корзину ${via(req)}`);
    res.json({ok: true});
  }));

}
