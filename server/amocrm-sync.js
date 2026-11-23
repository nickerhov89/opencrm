// amoCRM ⇄ OpenCRM sync while both CRMs run side by side (AMOCRM_SYNC_MODE, off by default).
//
// Stage 1 — amoCRM → OpenCRM. Every AMOCRM_SYNC_INTERVAL_SEC the sync reads what changed in amoCRM
// since the cursor (minus AMOCRM_SYNC_OVERLAP_SEC): companies, contacts, deals, tasks, notes and
// card events. The records go through the same transform as the one-time move
// (scripts/amocrm-lib.mjs), so stages 142/143, custom fields and lists, phones, e-mails, Telegram,
// task types and note texts are mapped exactly as there; records keep their amoCRM numbers.
//
// The sync compares states, not events. amocrm_sync_links keeps for every record the state last seen
// equal on both sides (the snapshot; for records of the move it starts as the OpenCRM state). A field
// changed only in amoCRM is copied to OpenCRM; a field changed only in OpenCRM waits for stage 2 (copy
// to amoCRM, logged as pending_to_amo); a field changed on both sides is a conflict: the value of
// AMOCRM_SYNC_PRIMARY wins, the other one goes to the log and, for deals, contacts and companies,
// into a note. A record read twice (overlap) matches its snapshot and is left alone.
//
// Writes go straight to the database: no stage transition rules, no distribution, no stage tasks.
// The stage history, closed_at and webhooks come from the usual triggers; the card history comes from
// the amoCRM events, as in the move. Notes are only added. Deleting in amoCRM moves the record to the
// trash here. dry_run does all of the reading and comparing and only writes the log.
//
// A record that fails (a database error, a number above the OpenCRM counter, a note whose record is
// missing) goes to amocrm_sync_retry and is read again from amoCRM by its ID in later cycles, so the
// moving cursor never loses it; after 10 attempts it stays in the log as an error. Stages and
// pipelines new in amoCRM are created here first, so a deal is never put into another stage.
import {exportPlan, insertRows, transform} from '../scripts/amocrm-lib.mjs';

export const syncModes = ['off', 'dry_run', 'amo_to_opencrm', 'both'];
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;

export function syncConfig(env = process.env) {
  const since = env.AMOCRM_SYNC_SINCE ? Date.parse(env.AMOCRM_SYNC_SINCE) : NaN;
  return {
    mode: syncModes.includes(env.AMOCRM_SYNC_MODE) ? env.AMOCRM_SYNC_MODE : 'off',
    primary: env.AMOCRM_SYNC_PRIMARY === 'opencrm' ? 'opencrm' : 'amo',
    intervalMs: clamp(Number(env.AMOCRM_SYNC_INTERVAL_SEC) || 60, 15, 3600) * 1000,
    overlapSec: clamp(Number(env.AMOCRM_SYNC_OVERLAP_SEC ?? 120) || 0, 0, 3600),
    since: Number.isFinite(since) ? Math.floor(since / 1000) : null,
    defaultOwner: positive(env.AMOCRM_SYNC_DEFAULT_OWNER_ID)
  };
}

// What is compared, per record type. Custom fields are compared one by one (cf:<id>), deal contacts
// as a list (main contact first), deleted = in the trash.
const specs = {
  company: {table: 'companies', amo: 'companies', fields: ['name', 'owner_id', 'website', 'address', 'phone', 'email', 'tags'], custom: true},
  contact: {table: 'contacts', amo: 'contacts', fields: ['name', 'company_id', 'owner_id', 'phone', 'email', 'position', 'telegram', 'tags'], custom: true},
  deal: {table: 'deals', amo: 'leads', fields: ['name', 'stage_id', 'owner_id', 'amount', 'tags', 'loss_reason', 'company_id'], custom: true, contacts: true},
  task: {table: 'tasks', amo: 'tasks', fields: ['title', 'description', 'task_type', 'due_at', 'duration_minutes', 'all_day', 'completed', 'completion_result', 'owner_id', 'deal_id', 'contact_id', 'company_id']}
};
const order = ['company', 'contact', 'deal', 'task'];
const labels = {name: 'Название', owner_id: 'Ответственный', website: 'Сайт', address: 'Адрес', phone: 'Телефон', email: 'Email', tags: 'Теги', company_id: 'Компания', position: 'Должность', telegram: 'Telegram', stage_id: 'Этап', amount: 'Бюджет', loss_reason: 'Причина отказа', contacts: 'Контакты', deleted: 'Удалена', title: 'Задача', description: 'Описание', completed: 'Выполнена'};
const deleteEvents = {lead_deleted: 'deal', contact_deleted: 'contact', company_deleted: 'company', task_deleted: 'task'};
// Where a record that failed is read again: the export file it belongs to and its amoCRM URL.
const retrySources = {
  deal: ['leads', id => `/api/v4/leads/${id}`, {with: 'contacts,loss_reason'}], contact: ['contacts', id => `/api/v4/contacts/${id}`, {}],
  company: ['companies', id => `/api/v4/companies/${id}`, {}], task: ['tasks', id => `/api/v4/tasks/${id}`, {}],
  note_leads: ['notes_leads', id => `/api/v4/leads/notes/${id}`, {}], note_contacts: ['notes_contacts', id => `/api/v4/contacts/notes/${id}`, {}],
  note_companies: ['notes_companies', id => `/api/v4/companies/notes/${id}`, {}]
};
export const retryLimit = 10;
const retryDelay = attempts => Math.min(3600, 60 * 2 ** Math.max(0, attempts - 1));

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const setting = async (db, key) => { const row = (await db.query('SELECT value FROM app_settings WHERE key=$1', [key])).rows[0]; return row ? JSON.parse(row.value) : null; };
const saveSetting = (db, key, value) => db.query('INSERT INTO app_settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', [key, JSON.stringify(value)]);
const ids = list => [...new Set(list.map(Number).filter(id => Number.isSafeInteger(id) && id > 0))];

// Normalized state of a record: from a transform row (amoCRM) or from the database (OpenCRM).
function normalize(type, row, custom, contacts) {
  const spec = specs[type], state = {};
  for (const key of spec.fields) {
    let value = key === 'completed' ? !!row.completed_at : row[key];
    if (['owner_id', 'company_id', 'contact_id', 'deal_id', 'stage_id', 'amount', 'duration_minutes', 'all_day'].includes(key)) value = value == null ? null : Number(value);
    else if (typeof value === 'string' || value == null) value = value == null ? '' : value;
    state[key] = value;
  }
  if (spec.custom) for (const [field, value] of custom || []) if (value !== '') state[`cf:${field}`] = value;
  if (spec.contacts) state.contacts = contacts || [];
  state.deleted = !!row.deleted_at;
  return state;
}
const orderContacts = (main, list) => { const rest = [...new Set(list.map(Number))].filter(id => id !== Number(main)).sort((a, b) => a - b); return main ? [Number(main), ...rest] : rest; };

// amo, local, snapshot → what to write and the next snapshot.
export function planRecord(amo, local, snapshot, primary) {
  const keys = new Set([...Object.keys(amo), ...Object.keys(local), ...Object.keys(snapshot)]);
  const apply = {}, conflicts = [], pending = [], next = {};
  for (const key of keys) {
    const empty = key.startsWith('cf:') ? '' : null;
    const a = amo[key] ?? empty, o = local[key] ?? empty, s = snapshot[key] ?? empty;
    if (same(a, o)) { if (a !== empty) next[key] = a; continue; }
    if (same(a, s)) { pending.push(key); if (s !== empty) next[key] = s; continue; }
    if (same(o, s) || primary === 'amo') { apply[key] = a; if (a !== empty) next[key] = a; if (!same(o, s)) conflicts.push({key, amo: a, opencrm: o, kept: 'amo'}); continue; }
    conflicts.push({key, amo: a, opencrm: o, kept: 'opencrm'});
    if (s !== empty) next[key] = s;
  }
  return {apply, conflicts, pending, next};
}

async function nextNativeId(db, table) {
  const {seq} = (await db.query("SELECT pg_get_serial_sequence($1, 'id') seq", [table])).rows[0];
  const state = (await db.query(`SELECT last_value,is_called FROM ${seq}`)).rows[0];
  return state.is_called ? Number(state.last_value) + 1 : Number(state.last_value);
}

const referenceCache = new WeakMap();
async function reference(client) {
  const cached = referenceCache.get(client);
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.data;
  const account = await client.request('/api/v4/account', {with: 'task_types,datetime_settings'});
  const data = {
    account: {timezone: account?.datetime_settings?.timezone || account?._embedded?.datetime_settings?.timezone || account?.timezone || 'Europe/Moscow', task_types: account?._embedded?.task_types || []},
    users: await client.list('/api/v4/users', 'users', {}, 250),
    pipelines: (await client.request('/api/v4/leads/pipelines'))?._embedded?.pipelines || [],
    event_types: []
  };
  for (const entity of ['leads', 'contacts', 'companies']) data[`custom_fields_${entity}`] = await client.list(`/api/v4/${entity}/custom_fields`, 'custom_fields', {}, 50);
  try { data.event_types = Object.values((await client.request('/api/v4/events/types', {language_code: 'ru'}))?._embedded || {}).find(Array.isArray) || []; } catch { /* names of event types are optional */ }
  referenceCache.set(client, {at: Date.now(), data});
  return data;
}

// Changes in amoCRM since `from` (Unix seconds).
async function readChanges(client, from) {
  const plan = Object.fromEntries(exportPlan.map(([file, path, key, params, limit]) => [file, {path, key, params, limit}]));
  const read = (file, filter) => client.list(plan[file].path, plan[file].key, {...plan[file].params, ...filter}, plan[file].limit);
  const updated = {'filter[updated_at][from]': from};
  const changes = {};
  for (const file of ['companies', 'contacts', 'leads', 'tasks', 'notes_leads', 'notes_contacts', 'notes_companies']) changes[file] = await read(file, updated);
  changes.events_history = await read('events_history', {'filter[created_at][from]': from, 'filter[entity][]': ['lead', 'contact', 'company', 'task']});
  return changes;
}

// Pipelines and stages new in amoCRM are created here with the amoCRM IDs (a new pipeline also gets
// its won and lost stages); the order of working stages follows amoCRM. A dry run only logs them and
// returns stand-ins, so its plan shows the right stage.
async function ensureStages(db, pipelines, dry, note) {
  const havePipelines = new Set((await db.query('SELECT id FROM pipelines')).rows.map(row => Number(row.id)));
  const haveStages = new Set((await db.query('SELECT id FROM stages')).rows.map(row => Number(row.id)));
  const color = value => /^#[0-9a-f]{3,8}$/i.test(value || '') ? value : '#dce7fb';
  const virtual = [];
  for (const pipeline of pipelines) {
    const statuses = pipeline._embedded?.statuses || [];
    const active = statuses.filter(s => s.id !== 142 && s.id !== 143).sort((a, b) => (a.type === 1 ? -1 : 0) - (b.type === 1 ? -1 : 0) || a.sort - b.sort || a.id - b.id);
    const fresh = !havePipelines.has(Number(pipeline.id)), missing = active.filter(s => !haveStages.has(Number(s.id)));
    if (!fresh && !missing.length) continue;
    note({action: 'stage_created', entity_type: 'pipeline', amo_id: pipeline.id, details: {pipeline: pipeline.name, new_pipeline: fresh, stages: missing.map(s => s.name)}});
    if (dry) {
      missing.forEach((s, index) => virtual.push({id: Number(s.id), pipeline_id: Number(pipeline.id), kind: 'active', sort_order: index}));
      if (fresh) virtual.push({id: -Number(pipeline.id) * 2, pipeline_id: Number(pipeline.id), kind: 'won', sort_order: 1000}, {id: -Number(pipeline.id) * 2 - 1, pipeline_id: Number(pipeline.id), kind: 'lost', sort_order: 1001});
      continue;
    }
    await db.transaction(async () => {
      if (fresh) await db.query('INSERT INTO pipelines (id,name,sort_order) VALUES ($1,$2,(SELECT COUNT(*) FROM pipelines))', [pipeline.id, String(pipeline.name || `Воронка ${pipeline.id}`).slice(0, 120)]);
      for (const s of missing) await db.query("INSERT INTO stages (id,pipeline_id,name,color,sort_order,kind) VALUES ($1,$2,$3,$4,0,'active')", [s.id, pipeline.id, String(s.name || `Этап ${s.id}`).slice(0, 120), color(s.color)]);
      if (fresh) for (const [code, kind, name, fallback] of [[142, 'won', 'Успешно реализовано', '#a9ddb1'], [143, 'lost', 'Закрыто и не реализовано', '#e8b7b7']]) {
        const s = statuses.find(item => item.id === code);
        await db.query('INSERT INTO stages (pipeline_id,name,color,sort_order,kind) VALUES ($1,$2,$3,1000,$4)', [pipeline.id, String(s?.name || name).slice(0, 120), s ? color(s.color) : fallback, kind]);
      }
      const current = (await db.query('SELECT id,kind FROM stages WHERE pipeline_id=$1 ORDER BY sort_order,id', [pipeline.id])).rows.map(row => ({id: Number(row.id), kind: row.kind}));
      const working = current.filter(row => row.kind === 'active').map(row => row.id), amoOrder = active.map(s => Number(s.id)).filter(id => working.includes(id));
      const ordered = [...amoOrder, ...working.filter(id => !amoOrder.includes(id)), ...current.filter(row => row.kind !== 'active').map(row => row.id)];
      for (const [index, id] of ordered.entries()) await db.query('UPDATE stages SET sort_order=$1 WHERE id=$2', [index, id]);
    })();
  }
  return virtual;
}

export async function runSyncCycle(db, client, config, {log = console.log} = {}) {
  const dry = config.mode === 'dry_run', started = Math.floor(Date.now() / 1000);
  const cursorKey = dry ? 'amocrm_sync_cursor_dry_run' : 'amocrm_sync_cursor';
  let cursor = await setting(db, cursorKey);
  if (cursor == null) {
    cursor = config.since ?? started;
    if (config.since == null) log('amoCRM sync: AMOCRM_SYNC_SINCE не задан — изменения читаются с текущего момента');
    await saveSetting(db, cursorKey, cursor);
  }
  const counts = {created: 0, updated: 0, deleted: 0, conflicts: 0, pending: 0, notes: 0, history: 0, errors: 0};
  const entries = [];
  const note = ({action, entity_type = '', amo_id = null, opencrm_id = null, details = {}}) => entries.push({dry_run: dry ? 1 : 0, direction: 'amo_to_opencrm', entity_type, amo_id, opencrm_id, action, details: JSON.stringify(details)});
  const ref = await reference(client);
  const changes = await readChanges(client, Math.max(0, cursor - config.overlapSec));

  // Records that failed before are read again by their ID, together with the batch.
  const failed = new Map(), succeeded = new Set(), key = (type, id) => `${type}:${id}`;
  const fail = (type, id, error) => { succeeded.delete(key(type, id)); failed.set(key(type, id), {type, id: Number(id), error: String(error).slice(0, 500)}); };
  const retries = (await db.query('SELECT entity_type,amo_id,attempts FROM amocrm_sync_retry WHERE dry_run=$1 AND next_at<=$2 ORDER BY next_at LIMIT 200', [dry ? 1 : 0, started])).rows;
  const attemptsOf = new Map((await db.query('SELECT entity_type,amo_id,attempts FROM amocrm_sync_retry WHERE dry_run=$1', [dry ? 1 : 0])).rows.map(row => [key(row.entity_type, Number(row.amo_id)), Number(row.attempts)]));
  for (const retry of retries) {
    const source = retrySources[retry.entity_type], id = Number(retry.amo_id);
    if (!source) continue;
    const [file, path, params] = source;
    if (changes[file].some(record => Number(record.id) === id)) continue;
    try {
      const record = await client.request(path(id), params);
      if (record) changes[file].push(record);
      else fail(retry.entity_type, id, 'amoCRM не вернул запись');
    } catch (error) { fail(retry.entity_type, id, error.message || error); }
  }
  const dump = {...ref, ...changes, events: [], files: []};
  const virtualStages = await ensureStages(db, ref.pipelines, dry, entry => entries.push({dry_run: dry ? 1 : 0, direction: 'amo_to_opencrm', entity_type: entry.entity_type, amo_id: entry.amo_id, opencrm_id: null, action: entry.action, details: JSON.stringify(entry.details)}));

  // What the database already has: users, stages, records referenced by the batch.
  const users = (await db.query('SELECT id,email FROM users')).rows.map(row => ({id: Number(row.id), email: String(row.email).toLowerCase()}));
  const byEmail = new Map(users.map(user => [user.email, user.id])), userIds = new Set(users.map(user => user.id));
  const amoUsers = new Map(ref.users.map(user => [Number(user.id), String(user.email || '').trim().toLowerCase()]));
  const userMap = id => { if (!id) return null; const email = amoUsers.get(id); return (email && byEmail.get(email)) ?? (userIds.has(id) ? id : null); };
  const stages = [...(await db.query('SELECT id,pipeline_id,kind,sort_order FROM stages')).rows.map(row => ({id: Number(row.id), pipeline_id: Number(row.pipeline_id), kind: row.kind, sort_order: Number(row.sort_order)})), ...virtualStages];
  const wanted = {deal: [], contact: [], company: []};
  for (const lead of changes.leads) { wanted.deal.push(lead.id); wanted.contact.push(...(lead._embedded?.contacts || []).map(c => c.id)); wanted.company.push(...(lead._embedded?.companies || []).map(c => c.id)); }
  for (const contact of changes.contacts) { wanted.contact.push(contact.id); wanted.company.push(...(contact._embedded?.companies || []).map(c => c.id)); }
  for (const company of changes.companies) wanted.company.push(company.id);
  const byEntity = {leads: 'deal', contacts: 'contact', companies: 'company', lead: 'deal', contact: 'contact', company: 'company'};
  for (const task of changes.tasks) if (byEntity[task.entity_type]) wanted[byEntity[task.entity_type]].push(task.entity_id);
  for (const [file, type] of [['notes_leads', 'deal'], ['notes_contacts', 'contact'], ['notes_companies', 'company']]) wanted[type].push(...changes[file].map(n => n.entity_id));
  for (const event of changes.events_history) if (byEntity[event.entity_type]) wanted[byEntity[event.entity_type]].push(event.entity_id);
  const known = {};
  for (const type of ['deal', 'contact', 'company']) known[type] = new Set((await db.query(`SELECT id FROM ${specs[type].table} WHERE id = ANY($1)`, [ids(wanted[type])])).rows.map(row => Number(row.id)));
  // Records of this batch count as known too: they are written before what links to them.
  for (const lead of changes.leads) known.deal.add(Number(lead.id));
  for (const contact of changes.contacts) known.contact.add(Number(contact.id));
  for (const company of changes.companies) known.company.add(Number(company.id));

  // strictStages: a deal whose stage is still unknown is skipped (and retried), never moved elsewhere.
  const result = transform(dump, {users: [], userMap, stages, known, strictStages: true});
  const transformed = new Set(result.rows.deals.map(row => Number(row.id)));
  for (const lead of changes.leads) if (!transformed.has(Number(lead.id))) fail('deal', lead.id, `этап ${lead.status_id} воронки ${lead.pipeline_id} не найден`);
  const notesOut = new Set([...result.rows.notes.map(row => key('note_leads', row.id)), ...result.rows.entity_notes.map(row => key(row.entity_type === 'contact' ? 'note_contacts' : 'note_companies', row.id))]);
  for (const file of ['notes_leads', 'notes_contacts', 'notes_companies']) for (const record of changes[file]) if (!notesOut.has(key(`note_${file.slice(6)}`, record.id))) fail(`note_${file.slice(6)}`, record.id, `запись ${record.entity_id} для примечания не найдена`);
  // Warnings about records; the ones about field definitions would repeat every cycle.
  for (const [key, warning] of Object.entries(result.warnings)) if (!/^(Повторяющиеся названия полей|Мультисписки)/.test(key)) note({action: 'warning', details: {warning: key, count: warning.count, examples: warning.examples}});

  // Custom fields: new amoCRM fields are added, new list options appended.
  const fieldRows = new Map((await db.query('SELECT id,entity_type,field_type,options_json FROM custom_fields')).rows.map(row => [Number(row.id), row]));
  const fieldType = new Map([...fieldRows].map(([id, row]) => [id, row.entity_type]));
  // Only fields amoCRM has are compared: fields made in OpenCRM alone are never cleared.
  const amoFields = new Set(result.rows.custom_fields.map(field => field.id));
  for (const field of result.rows.custom_fields) {
    const current = fieldRows.get(field.id);
    if (!current) {
      fieldType.set(field.id, field.entity_type);
      note({action: 'field_created', entity_type: field.entity_type, amo_id: field.id, details: {name: field.name}});
      if (!dry) await db.query('INSERT INTO custom_fields (id,entity_type,name,field_type,options_json,sort_order) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING', [field.id, field.entity_type, field.name, field.field_type, field.options_json, field.sort_order]);
    } else if (current.field_type === 'select') {
      const options = JSON.parse(current.options_json || '[]'), extra = JSON.parse(field.options_json).filter(option => !options.includes(option));
      if (extra.length && !dry) await db.query('UPDATE custom_fields SET options_json=$1 WHERE id=$2', [JSON.stringify([...options, ...extra]), field.id]);
    }
  }
  const amoCustom = {deal: new Map(), contact: new Map(), company: new Map()};
  for (const value of result.rows.custom_field_values) {
    const type = fieldType.get(value.field_id);
    if (!amoCustom[type]) continue;
    if (!amoCustom[type].has(value.entity_id)) amoCustom[type].set(value.entity_id, []);
    amoCustom[type].get(value.entity_id).push([value.field_id, value.value]);
  }
  const amoContacts = new Map();
  for (const link of result.rows.deal_contacts) { if (!amoContacts.has(link.deal_id)) amoContacts.set(link.deal_id, []); amoContacts.get(link.deal_id).push(link.contact_id); }

  // Deletions in amoCRM (records that are not live in this batch).
  const deleted = {deal: new Set(), contact: new Set(), company: new Set(), task: new Set()};
  for (const event of changes.events_history) {
    const type = deleteEvents[event.type];
    if (type) deleted[type].add(Number(event.entity_id));
  }
  for (const lead of changes.leads) deleted.deal.delete(Number(lead.id));
  for (const contact of changes.contacts) deleted.contact.delete(Number(contact.id));
  for (const company of changes.companies) deleted.company.delete(Number(company.id));
  for (const task of changes.tasks) deleted.task.delete(Number(task.id));

  const actorOf = id => { const user = userMap(Number(id)); return user ? `user:${user}` : null; };
  for (const type of order) {
    const spec = specs[type], rows = result.rows[spec.table] || [];
    const raw = new Map((changes[spec.amo] || []).map(record => [Number(record.id), record]));
    for (const row of rows) {
      if (!row.owner_id && config.defaultOwner && raw.get(row.id)?.responsible_user_id) row.owner_id = config.defaultOwner;
    }
    const targets = [...rows.map(row => row.id), ...(deleted[type] || [])];
    if (!targets.length) continue;
    const localRows = new Map((await db.query(`SELECT * FROM ${spec.table} WHERE id = ANY($1)`, [ids(targets)])).rows.map(row => [Number(row.id), row]));
    const localCustom = new Map();
    if (spec.custom) for (const value of (await db.query("SELECT v.field_id,v.entity_id,v.value FROM custom_field_values v JOIN custom_fields f ON f.id=v.field_id WHERE f.entity_type=$1 AND v.entity_id = ANY($2) AND v.value<>'' ORDER BY v.field_id", [type, ids(targets)])).rows) {
      const id = Number(value.entity_id);
      if (!amoFields.has(Number(value.field_id))) continue;
      if (!localCustom.has(id)) localCustom.set(id, []);
      localCustom.get(id).push([Number(value.field_id), value.value]);
    }
    const localContacts = new Map();
    if (spec.contacts) for (const link of (await db.query('SELECT deal_id,contact_id FROM deal_contacts WHERE deal_id = ANY($1)', [ids(targets)])).rows) {
      const id = Number(link.deal_id);
      if (!localContacts.has(id)) localContacts.set(id, []);
      localContacts.get(id).push(Number(link.contact_id));
    }
    const links = new Map((await db.query('SELECT amo_id,snapshot_json,dry_snapshot_json FROM amocrm_sync_links WHERE entity_type=$1 AND amo_id = ANY($2)', [type, ids(targets)])).rows.map(row => [Number(row.amo_id), row]));
    const localState = id => { const row = localRows.get(id); return row && normalize(type, row, localCustom.get(id), spec.contacts ? orderContacts(row.contact_id, localContacts.get(id) || []) : undefined); };

    const work = [...rows.map(row => ({row, amo: normalize(type, row, (amoCustom[type]?.get(row.id) || []).sort((a, b) => a[0] - b[0]), spec.contacts ? orderContacts(row.contact_id, amoContacts.get(row.id) || []) : undefined)})),
      ...[...(deleted[type] || [])].map(id => ({id, gone: true}))];
    for (const item of work) {
      const id = item.row?.id ?? item.id, link = links.get(id), raw_record = raw.get(id);
      if (!item.gone) succeeded.add(key(type, id));
      try {
        let local = localState(id);
        const stored = link?.snapshot_json ? JSON.parse(link.snapshot_json) : null;
        if (dry && link?.dry_snapshot_json) local = JSON.parse(link.dry_snapshot_json);
        if (item.gone) {
          if (!local || local.deleted) continue;
          item.amo = {...(stored || local), deleted: true};
        }
        if (!local) {
          // New in amoCRM: created here with the same number.
          if (id >= await nextNativeId(db, spec.table)) throw new Error(`номер ${id} не ниже счётчика OpenCRM — запись не создана`);
          note({action: 'create', entity_type: type, amo_id: id, opencrm_id: id, details: {name: item.row.name || item.row.title}});
          counts.created++;
          if (!dry) await db.runAs(actorOf(raw_record?.created_by), () => db.transaction(() => createRecord(db, type, item.row, amoCustom[type]?.get(id) || [], amoContacts.get(id) || []))());
          await saveLink(db, type, id, item.amo, dry);
          continue;
        }
        const plan = planRecord(item.amo, local, dry && link?.dry_snapshot_json ? local : stored || local, config.primary);
        if (plan.pending.length) { counts.pending++; note({action: 'pending_to_amo', entity_type: type, amo_id: id, opencrm_id: id, details: {fields: plan.pending}}); }
        for (const conflict of plan.conflicts) { counts.conflicts++; note({action: 'conflict', entity_type: type, amo_id: id, opencrm_id: id, details: conflict}); }
        const changed = Object.keys(plan.apply);
        if (changed.length) {
          const action = plan.apply.deleted === true ? 'delete' : plan.apply.deleted === false ? 'restore' : 'update';
          counts[action === 'delete' ? 'deleted' : 'updated']++;
          note({action, entity_type: type, amo_id: id, opencrm_id: id, details: {fields: Object.fromEntries(changed.map(key => [key, plan.apply[key]]))}});
          if (!dry) await db.runAs(actorOf(raw_record?.updated_by), () => db.transaction(async () => {
            await updateRecord(db, type, id, plan.apply, item.row, item.amo);
            const lost = plan.conflicts.filter(conflict => conflict.kept === 'amo');
            if (lost.length && type !== 'task') await conflictNote(db, type, id, lost);
          })());
        }
        if (changed.length || !link || !same(plan.next, stored)) await saveLink(db, type, id, plan.next, dry);
      } catch (error) {
        counts.errors++;
        note({action: 'error', entity_type: type, amo_id: id, details: {error: String(error.message || error).slice(0, 500)}});
        if (!item.gone) fail(type, id, error.message || error);
      }
    }
  }

  // Notes are only added; the card history comes from amoCRM events, as in the move. Rows whose record
  // is not here (it failed above, or a dry run did not create it) are left for a later cycle.
  const liveIds = async (table, list) => new Set((await db.query(`SELECT id FROM ${table} WHERE id = ANY($1)`, [ids(list)])).rows.map(row => Number(row.id)));
  const dealsHere = await liveIds('deals', [...result.rows.notes.map(row => row.deal_id), ...result.rows.activity.map(row => row.deal_id)]);
  const entityHere = {contact: await liveIds('contacts', result.rows.entity_notes.filter(row => row.entity_type === 'contact').map(row => row.entity_id)), company: await liveIds('companies', result.rows.entity_notes.filter(row => row.entity_type === 'company').map(row => row.entity_id))};
  const noteKey = row => row.deal_id !== undefined ? key('note_leads', row.id) : key(row.entity_type === 'contact' ? 'note_contacts' : 'note_companies', row.id);
  const noteType = row => noteKey(row).split(':')[0];
  const noteRows = {notes: result.rows.notes.filter(row => dry || dealsHere.has(row.deal_id)), entity_notes: result.rows.entity_notes.filter(row => dry || entityHere[row.entity_type]?.has(row.entity_id))};
  for (const row of [...result.rows.notes, ...result.rows.entity_notes]) succeeded.add(noteKey(row));
  for (const row of result.rows.notes.filter(row => !dry && !dealsHere.has(row.deal_id))) fail(noteType(row), row.id, `сделки ${row.deal_id} нет в OpenCRM`);
  for (const row of result.rows.entity_notes.filter(row => !dry && !entityHere[row.entity_type]?.has(row.entity_id))) fail(noteType(row), row.id, `записи ${row.entity_id} нет в OpenCRM`);
  for (const [table, rows] of Object.entries(noteRows)) {
    if (!rows.length) continue;
    const present = new Set((await db.query(`SELECT id FROM ${table} WHERE id = ANY($1)`, [ids(rows.map(row => row.id))])).rows.map(row => Number(row.id)));
    const fresh = rows.filter(row => !present.has(row.id));
    if (!fresh.length) continue;
    const next = await nextNativeId(db, table), ok = fresh.filter(row => row.id < next);
    for (const row of fresh.filter(row => row.id >= next)) { counts.errors++; note({action: 'error', entity_type: 'note', amo_id: row.id, details: {error: `номер ${row.id} не ниже счётчика OpenCRM — примечание не создано`}}); fail(noteType(row), row.id, 'номер не ниже счётчика OpenCRM'); }
    counts.notes += ok.length;
    for (const row of ok) note({action: 'create', entity_type: 'note', amo_id: row.id, opencrm_id: row.id, details: {note_type: row.note_type, entity_type: row.entity_type || 'deal', entity_id: row.entity_id || row.deal_id}});
    if (!dry && ok.length) await db.transaction(() => insertRows(db, table, ok))();
  }
  const activity = result.rows.activity.filter(row => dealsHere.has(row.deal_id)), history = [...activity, ...result.rows.entity_activity];
  counts.history = history.length;
  if (!dry && history.length) await db.transaction(async () => {
    const eventIds = [...new Set(history.map(row => row.amo_event_id))];
    await db.query('DELETE FROM activity WHERE amo_event_id = ANY($1)', [eventIds]);
    await db.query('DELETE FROM entity_activity WHERE amo_event_id = ANY($1)', [eventIds]);
    await insertRows(db, 'activity', activity);
    await insertRows(db, 'entity_activity', result.rows.entity_activity);
  })();

  // The retry queue: done records leave it, failed ones get the next attempt or, after the last, an error.
  counts.retrying = 0;
  for (const done of succeeded) if (!failed.has(done) && attemptsOf.has(done)) { const [type, id] = done.split(':'); await db.query('DELETE FROM amocrm_sync_retry WHERE dry_run=$1 AND entity_type=$2 AND amo_id=$3', [dry ? 1 : 0, type, Number(id)]); }
  for (const [name, item] of failed) {
    const attempts = (attemptsOf.get(name) || 0) + 1;
    if (attempts >= retryLimit) {
      await db.query('DELETE FROM amocrm_sync_retry WHERE dry_run=$1 AND entity_type=$2 AND amo_id=$3', [dry ? 1 : 0, item.type, item.id]);
      counts.errors++;
      note({action: 'error', entity_type: item.type, amo_id: item.id, details: {error: item.error, gave_up: true, attempts}});
      continue;
    }
    counts.retrying++;
    await db.query('INSERT INTO amocrm_sync_retry (dry_run,entity_type,amo_id,attempts,last_error,next_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (dry_run,entity_type,amo_id) DO UPDATE SET attempts=EXCLUDED.attempts,last_error=EXCLUDED.last_error,next_at=EXCLUDED.next_at', [dry ? 1 : 0, item.type, item.id, attempts, item.error, started + retryDelay(attempts)]);
  }
  if (entries.length) await insertRows(db, 'amocrm_sync_log', entries);
  await saveSetting(db, cursorKey, started);
  return counts;
}

async function saveLink(db, type, id, snapshot, dry) {
  if (dry) await db.query("INSERT INTO amocrm_sync_links (entity_type,amo_id,opencrm_id,dry_snapshot_json) VALUES ($1,$2,$2,$3) ON CONFLICT (entity_type,amo_id) DO UPDATE SET dry_snapshot_json=EXCLUDED.dry_snapshot_json", [type, id, JSON.stringify(snapshot)]);
  else await db.query('INSERT INTO amocrm_sync_links (entity_type,amo_id,opencrm_id,snapshot_json,synced_at) VALUES ($1,$2,$2,$3,now_text()) ON CONFLICT (entity_type,amo_id) DO UPDATE SET snapshot_json=EXCLUDED.snapshot_json,synced_at=EXCLUDED.synced_at', [type, id, JSON.stringify(snapshot)]);
}

const columnsOf = {
  company: ['id', 'name', 'owner_id', 'website', 'address', 'phone', 'email', 'notes', 'tags', 'created_at'],
  contact: ['id', 'name', 'company_id', 'owner_id', 'phone', 'email', 'position', 'telegram', 'notes', 'tags', 'created_at'],
  deal: ['id', 'name', 'stage_id', 'company_id', 'contact_id', 'owner_id', 'amount', 'source', 'tags', 'description', 'loss_reason', 'created_at', 'closed_at'],
  task: ['id', 'title', 'description', 'task_type', 'due_at', 'duration_minutes', 'all_day', 'completed_at', 'completion_result', 'deal_id', 'contact_id', 'company_id', 'owner_id', 'created_at']
};

async function createRecord(db, type, row, custom, contacts) {
  const spec = specs[type], columns = columnsOf[type];
  await db.query(`INSERT INTO ${spec.table} (${columns.join(',')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(',')})`, columns.map(key => row[key] ?? (['notes', 'source', 'description', 'completion_result'].includes(key) ? '' : null)));
  if (type === 'deal') {
    for (const contact of contacts) await db.query('INSERT INTO deal_contacts (deal_id,contact_id,created_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [row.id, contact, row.created_at]);
    await db.query('UPDATE deal_stage_changes SET changed_at=$1 WHERE deal_id=$2 AND from_stage_id IS NULL', [row.created_at, row.id]);
  }
  for (const [field, value] of custom) await db.query('INSERT INTO custom_field_values (field_id,entity_id,value) VALUES ($1,$2,$3) ON CONFLICT (field_id,entity_id) DO UPDATE SET value=EXCLUDED.value', [field, row.id, value]);
}

async function updateRecord(db, type, id, apply, row, amo) {
  const spec = specs[type], sets = [], params = [];
  const put = (column, value) => { params.push(value); sets.push(`${column}=$${params.length}`); };
  for (const key of spec.fields) {
    if (!(key in apply)) continue;
    if (key === 'completed') { put('completed_at', apply.completed ? row?.completed_at || new Date().toISOString() : null); continue; }
    put(key, apply[key]);
  }
  if ('stage_id' in apply && row?.closed_at) put('closed_at', row.closed_at);
  if ('deleted' in apply) sets.push(apply.deleted ? 'deleted_at=now_text()' : 'deleted_at=NULL');
  if ('contacts' in apply) put('contact_id', apply.contacts[0] ?? null);
  if (sets.length) await db.query(`UPDATE ${spec.table} SET ${sets.join(',')} WHERE id=$${params.length + 1}`, [...params, id]);
  if ('contacts' in apply) {
    await db.query('DELETE FROM deal_contacts WHERE deal_id=$1 AND NOT (contact_id = ANY($2))', [id, apply.contacts]);
    for (const contact of apply.contacts) await db.query('INSERT INTO deal_contacts (deal_id,contact_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, contact]);
  }
  for (const key of Object.keys(apply).filter(key => key.startsWith('cf:'))) {
    const field = Number(key.slice(3));
    if (apply[key] === '' || apply[key] == null) await db.query('DELETE FROM custom_field_values WHERE field_id=$1 AND entity_id=$2', [field, id]);
    else await db.query('INSERT INTO custom_field_values (field_id,entity_id,value) VALUES ($1,$2,$3) ON CONFLICT (field_id,entity_id) DO UPDATE SET value=EXCLUDED.value', [field, id, apply[key]]);
  }
}

const shown = value => value === '' || value == null ? '—' : Array.isArray(value) ? value.join(', ') : String(value);
async function conflictNote(db, type, id, conflicts) {
  const fieldNames = new Map((await db.query('SELECT id,name FROM custom_fields WHERE id = ANY($1)', [ids(conflicts.filter(c => c.key.startsWith('cf:')).map(c => c.key.slice(3)))])).rows.map(row => [`cf:${row.id}`, row.name]));
  const body = ['Синхронизация с amoCRM: поле изменили в обеих CRM, оставлено значение из amoCRM.', ...conflicts.map(c => `«${fieldNames.get(c.key) || labels[c.key] || c.key}»: в OpenCRM было ${shown(c.opencrm)}, из amoCRM ${shown(c.amo)}`)].join('\n');
  if (type === 'deal') await db.query("INSERT INTO notes (deal_id,body,note_type) VALUES ($1,$2,'common')", [id, body.slice(0, 10000)]);
  else await db.query("INSERT INTO entity_notes (entity_type,entity_id,body,note_type) VALUES ($1,$2,$3,'common')", [type, id, body.slice(0, 10000)]);
}

// Status for the portal's health checks: GET /api/v1/sync/status.
export async function syncStatus(db, config = syncConfig()) {
  const state = await setting(db, 'amocrm_sync_status') || {};
  const cursor = await setting(db, config.mode === 'dry_run' ? 'amocrm_sync_cursor_dry_run' : 'amocrm_sync_cursor');
  const hour = (await db.query("SELECT action,COUNT(*) n FROM amocrm_sync_log WHERE created_at >= to_char(timezone('UTC', now() - interval '1 hour'), 'YYYY-MM-DD HH24:MI:SS') AND action IN ('error','conflict') GROUP BY action")).rows;
  const per = action => Number(hour.find(row => row.action === action)?.n || 0);
  return {
    mode: config.mode, primary: config.primary, writes_to_amo: false,
    cursor: cursor ? new Date(cursor * 1000).toISOString() : null,
    lag_seconds: {amo_to_opencrm: cursor ? Math.max(0, Math.floor(Date.now() / 1000) - cursor) : null, opencrm_to_amo: null},
    errors_last_hour: per('error'), conflicts_last_hour: per('conflict'),
    retry_queue: Number((await db.query('SELECT COUNT(*) n FROM amocrm_sync_retry WHERE dry_run=$1', [config.mode === 'dry_run' ? 1 : 0])).rows[0].n),
    last_started_at: state.last_started_at || null, last_finished_at: state.last_finished_at || null, last_ok_at: state.last_ok_at || null,
    last_error: state.last_error || null, last_counts: state.last_counts || null
  };
}

export async function syncLog(db, {after = 0, limit = 100, action = '', entityType = '', amoId = null} = {}) {
  const where = ['id > $1'], params = [after];
  if (action) { params.push(action); where.push(`action = $${params.length}`); }
  if (entityType) { params.push(entityType); where.push(`entity_type = $${params.length}`); }
  if (amoId) { params.push(amoId); where.push(`amo_id = $${params.length}`); }
  params.push(limit + 1);
  const rows = (await db.query(`SELECT id,created_at,dry_run,direction,entity_type,amo_id,opencrm_id,action,details FROM amocrm_sync_log WHERE ${where.join(' AND ')} ORDER BY id LIMIT $${params.length}`, params)).rows;
  const items = rows.slice(0, limit).map(row => ({...row, dry_run: !!row.dry_run, details: JSON.parse(row.details || '{}')}));
  return {items, next_after: rows.length > limit ? items.at(-1).id : null};
}

// Background loop: one cycle at a time, the next one AMOCRM_SYNC_INTERVAL_SEC after the previous ends.
export function startAmoSync(db, client, config = syncConfig(), {log = console.log} = {}) {
  if (config.mode === 'off') return null;
  if (config.mode === 'both') log('amoCRM sync: режим both — пока работает как amo_to_opencrm, запись в amoCRM будет следующим этапом');
  log(`amoCRM sync: режим ${config.mode}, главная CRM — ${config.primary === 'amo' ? 'amoCRM' : 'OpenCRM'}`);
  let timer = null, stopped = false;
  const cycle = async () => {
    const state = await setting(db, 'amocrm_sync_status').catch(() => null) || {};
    state.last_started_at = new Date().toISOString();
    try {
      const counts = await runSyncCycle(db, client, config, {log});
      Object.assign(state, {last_finished_at: new Date().toISOString(), last_ok_at: new Date().toISOString(), last_error: null, last_counts: counts});
      if (counts.created || counts.updated || counts.deleted || counts.conflicts || counts.errors) log(`amoCRM sync${config.mode === 'dry_run' ? ' (dry_run)' : ''}: ${JSON.stringify(counts)}`);
      await db.query("DELETE FROM amocrm_sync_log WHERE created_at < to_char(timezone('UTC', now() - interval '30 days'), 'YYYY-MM-DD HH24:MI:SS')");
    } catch (error) {
      Object.assign(state, {last_finished_at: new Date().toISOString(), last_error: String(error.message || error).slice(0, 500)});
      log(`amoCRM sync: ${error.message}`);
      await db.query("INSERT INTO amocrm_sync_log (dry_run,action,details) VALUES ($1,'error',$2)", [config.mode === 'dry_run' ? 1 : 0, JSON.stringify({error: state.last_error, cycle: true})]).catch(() => {});
    }
    await saveSetting(db, 'amocrm_sync_status', state).catch(() => {});
    if (!stopped) { timer = setTimeout(cycle, config.intervalMs); timer.unref?.(); }
  };
  timer = setTimeout(cycle, 1000); timer.unref?.();
  return {stop() { stopped = true; clearTimeout(timer); }};
}
