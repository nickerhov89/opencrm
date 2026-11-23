// OpenCRM → amoCRM, the second half of the sync (AMOCRM_SYNC_MODE=both, see server/amocrm-sync.js).
//
// Runs after the amoCRM changes of the cycle are in. Candidates are the records changed here since the
// cursor (minus the overlap), records made here that amoCRM does not have yet (numbers from
// AMOCRM_SYNC_NATIVE_FROM) and records waiting in the retry queue. A record whose state matches its
// snapshot goes nowhere; the others are read from amoCRM and compared like in the other direction:
// fields changed only here (and conflicts won by OpenCRM) are written to amoCRM through API v4.
//
// After writing, the record is read back from amoCRM and its snapshot is that state, so reading it
// back in the next cycle finds nothing to copy. Where amoCRM keeps a value in another shape (a phone
// moved to another field type, a task text), the amoCRM shape is written back here once.
//
// AMOCRM_SYNC_TO_AMO=dry_run (the default) writes nothing to amoCRM: the log shows, for every record,
// the API requests that would be sent, once per distinct change.
const amoPath = {deal: 'leads', contact: 'contacts', company: 'companies', task: 'tasks'};
const notePath = {note_lead: 'leads', note_contact: 'contacts', note_company: 'companies'};
const presetTypes = {'связаться': 1, 'встреча': 2, 'письмо': 3};
const linkKeys = {deal: ['company_id', 'contacts'], contact: ['company_id'], company: [], task: []};
const checkLimit = 250, createLimit = 50;

const safeZone = zone => { try { new Intl.DateTimeFormat('en-GB', {timeZone: zone}); return zone; } catch { return 'Europe/Moscow'; } };
function partsAt(seconds, zone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).formatToParts(new Date(seconds * 1000)).map(x => [x.type, x.value]));
  return {year: Number(p.year), month: Number(p.month), day: Number(p.day), hour: Number(p.hour), minute: Number(p.minute)};
}
// Unix time of a wall-clock moment (date YYYY-MM-DD, hour, minute) in the account's time zone.
export function zonedTime(date, hour, minute, zone) {
  const [y, m, d] = String(date).slice(0, 10).split('-').map(Number);
  const wanted = Date.UTC(y, m - 1, d, hour, minute) / 1000;
  let t = wanted;
  for (let i = 0; i < 3; i++) { const p = partsAt(t, zone); t += wanted - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) / 1000; }
  return t;
}
const localDate = (seconds, zone) => { const p = partsAt(seconds, zone); return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`; };
const list = text => String(text || '').split(/,\s*/).map(item => item.trim()).filter(Boolean);
const emptyOf = key => key.startsWith('cf:') ? '' : null;
const textTime = text => Math.floor(Date.parse(`${String(text).replace(' ', 'T')}Z`) / 1000);

export async function pushToAmo(db, client, config, ctx) {
  const {ref, pairs, started, note, prepare, loadLocal, linksOf, planRecord, updateRecord, saveLink, readByIds, remapRaw, emptyChanges, settleRetries, setting, saveSetting, specs, order, same, ids, unixToText, deletedTag, conflictNotePrefix} = ctx;
  const dry = config.toAmo !== 'on', flag = dry ? 1 : 0;
  const counts = {created: 0, updated: 0, deleted: 0, notes: 0, unsupported: 0, conflicts: 0, errors: 0, retrying: 0};
  const cursorKey = dry ? 'amocrm_sync_cursor_to_amo_dry' : 'amocrm_sync_cursor_to_amo';
  let cursor = await setting(db, cursorKey);
  if (cursor == null) cursor = config.since ?? started;
  const since = unixToText(Math.max(0, cursor - config.overlapSec));
  let nextCursor = started;
  const zone = safeZone(ref.account.timezone);
  // A dry run logs a record again only when what would be sent changes.
  const seenKey = 'amocrm_push_dry_seen', seenBefore = dry ? await setting(db, seenKey) || {} : {}, seenNow = {};
  const log = (entry, requests) => {
    if (dry) {
      const name = `${entry.entity_type}:${entry.opencrm_id}:${entry.action}`, hash = JSON.stringify([entry.action, requests ?? entry.details]);
      seenNow[name] = hash;
      if (seenBefore[name] === hash) return;
    }
    note({...entry, details: requests ? {...entry.details, requests} : entry.details});
  };

  // The retry queue of this direction: entity_type to_amo:<type>, amo_id holds the OpenCRM number.
  const retryRows = (await db.query("SELECT entity_type,amo_id,attempts,next_at FROM amocrm_sync_retry WHERE dry_run=$1 AND entity_type LIKE 'to_amo:%'", [flag])).rows;
  const attemptsOf = new Map(retryRows.map(row => [`${row.entity_type}:${Number(row.amo_id)}`, Number(row.attempts)]));
  const due = {};
  for (const row of retryRows) if (Number(row.next_at) <= started) (due[row.entity_type.slice(7)] ||= []).push(Number(row.amo_id));
  const failed = new Map(), succeeded = new Set();
  const fail = (type, id, error) => { const name = `to_amo:${type}:${id}`; succeeded.delete(name); failed.set(name, {type: `to_amo:${type}`, id, error: String(error).slice(0, 500)}); };
  const done = (type, id) => { const name = `to_amo:${type}:${id}`; if (!failed.has(name)) succeeded.add(name); };

  // Reference data: users by e-mail, stages, fields, loss reasons, task types.
  const localEmail = new Map((await db.query('SELECT id,email FROM users')).rows.map(row => [Number(row.id), String(row.email).toLowerCase()]));
  const amoByEmail = new Map(ref.users.filter(user => user.email).map(user => [String(user.email).trim().toLowerCase(), Number(user.id)]));
  const amoUserIds = new Set(ref.users.map(user => Number(user.id)));
  const amoUser = id => { if (!id) return null; const email = localEmail.get(Number(id)); return (email && amoByEmail.get(email)) ?? (amoUserIds.has(Number(id)) ? Number(id) : null); };
  const stages = new Map((await db.query('SELECT id,pipeline_id,kind FROM stages')).rows.map(row => [Number(row.id), {pipeline: Number(row.pipeline_id), kind: row.kind}]));
  const amoStatuses = new Map(ref.pipelines.flatMap(p => (p._embedded?.statuses || []).map(s => [`${p.id}:${s.id}`, s])));
  const fieldsOf = {deal: ref.custom_fields_leads || [], contact: ref.custom_fields_contacts || [], company: ref.custom_fields_companies || []};
  const fieldById = new Map(Object.values(fieldsOf).flat().map(field => [Number(field.id), field]));
  const codeField = (type, code) => fieldsOf[type].find(field => field.code === code);
  const lossReasons = new Map((ref.loss_reasons || []).map(reason => [String(reason.name).trim().toLowerCase(), Number(reason.id)]));
  const taskTypes = new Map((ref.account.task_types || []).map(type => [String(type.name).trim().toLowerCase(), Number(type.id)]));
  const taskTypeId = name => presetTypes[String(name).trim().toLowerCase()] ?? taskTypes.get(String(name).trim().toLowerCase()) ?? null;
  // Made here and not in amoCRM yet: a number from AMOCRM_SYNC_NATIVE_FROM, no pair, created after
  // AMOCRM_SYNC_SINCE (records of the move keep their amoCRM numbers, which may be just as high).
  const sinceStart = config.since != null ? unixToText(config.since) : '';
  const nativeIds = {};
  for (const type of order) nativeIds[type] = new Set((await db.query(`SELECT id FROM ${specs[type].table} t WHERE id >= $1 AND created_at >= $2 AND NOT EXISTS (SELECT 1 FROM amocrm_sync_links l WHERE l.entity_type=$3 AND l.opencrm_id=t.id)`, [config.nativeFrom, sinceStart, type])).rows.map(row => Number(row.id)));
  const native = (type, id) => type.startsWith('note_') ? Number(id) >= config.nativeNotesFrom : nativeIds[type].has(Number(id));
  // amoCRM number of a record here; undefined when it is made here and not in amoCRM yet.
  const amoRef = (type, id) => { if (!id) return null; if (native(type, id) && !pairs.paired(type, id)) return undefined; return pairs.amo(type, id); };
  const {amoFields} = await prepare(db, ref, emptyChanges());

  // amoCRM records → {row, state, raw (with amoCRM numbers)} by OpenCRM number.
  async function readAmo(type, localIds) {
    const out = new Map();
    if (!localIds.length) return out;
    const raw = await readByIds(client, type, localIds.map(id => pairs.amo(type, id)));
    const copy = JSON.parse(JSON.stringify(raw)), changes = emptyChanges();
    changes[specs[type].amo] = raw;
    remapRaw(changes, pairs);
    const prepared = await prepare(db, ref, changes);
    const rawOf = new Map(raw.map((record, index) => [Number(record.id), copy[index]]));
    for (const row of prepared.result.rows[specs[type].table] || []) {
      if (!row.owner_id && config.defaultOwner && rawOf.get(row.id)?.responsible_user_id) row.owner_id = config.defaultOwner;
      out.set(Number(row.id), {row, state: prepared.stateOf(type, row), raw: rawOf.get(row.id)});
    }
    return out;
  }

  function customValue(fieldId, value) {
    const field = fieldById.get(fieldId);
    if (!field) return {unsupported: 'поля нет в amoCRM'};
    if (value === '' || value == null) return {entry: {field_id: fieldId, values: null}};
    const enums = field.enums || [], byText = text => enums.find(item => String(item.value ?? '').trim() === String(text).trim());
    if (field.type === 'checkbox') return {entry: {field_id: fieldId, values: [{value: value === 'Да'}]}};
    if (['select', 'radiobutton', 'category'].includes(field.type)) { const option = byText(value); return option ? {entry: {field_id: fieldId, values: [{enum_id: option.id}]}} : {unsupported: `варианта «${value}» нет в amoCRM`}; }
    if (field.type === 'multiselect') {
      const options = list(value).map(byText);
      return options.every(Boolean) ? {entry: {field_id: fieldId, values: options.map(option => ({enum_id: option.id}))}} : {unsupported: `не все варианты «${value}» есть в amoCRM`};
    }
    if (['date', 'date_time', 'birthday'].includes(field.type)) return /^\d{4}-\d{2}-\d{2}/.test(value) ? {entry: {field_id: fieldId, values: [{value: zonedTime(value, 0, 0, zone)}]}} : {unsupported: `дата «${value}» не в формате ГГГГ-ММ-ДД`};
    if (['numeric', 'price', 'monetary'].includes(field.type)) return Number.isFinite(Number(value)) ? {entry: {field_id: fieldId, values: [{value: Number(value)}]}} : {unsupported: `«${value}» не число`};
    if (['text', 'textarea', 'url', 'streetaddress'].includes(field.type)) return {entry: {field_id: fieldId, values: [{value: String(value)}]}};
    return {unsupported: `поле типа ${field.type} не записывается`};
  }
  // PHONE / EMAIL: every value, keeping the amoCRM type of values already there (WORK for new ones).
  function multi(type, code, text, raw) {
    const field = codeField(type, code), had = new Map(((raw?.custom_fields_values || []).find(item => item.field_code === code)?.values || []).map(v => [String(v.value).trim().toLowerCase(), v.enum_code]));
    const values = list(text).map(value => ({value, enum_code: had.get(value.toLowerCase()) || 'WORK'}));
    return {...(field ? {field_id: Number(field.id)} : {field_code: code}), values: values.length ? values : null};
  }
  function single(type, code, text) {
    const field = codeField(type, code);
    return {...(field ? {field_id: Number(field.id)} : {field_code: code}), values: text ? [{value: text}] : null};
  }
  // Telegram goes where the transform reads it from: the messenger field (IM, TELEGRAM) or a field named Telegram.
  function telegram(value, raw) {
    const im = codeField('contact', 'IM'), had = raw?.custom_fields_values || [];
    const imValues = had.find(item => item.field_code === 'IM')?.values || [];
    const named = had.find(item => item.field_code !== 'IM' && /telegram|телеграм/i.test(item.field_name || ''));
    if (im && (imValues.some(v => v.enum_code === 'TELEGRAM') || !named)) {
      const values = [...imValues.filter(v => v.enum_code !== 'TELEGRAM').map(v => ({value: v.value, enum_code: v.enum_code})), ...(value ? [{value, enum_code: 'TELEGRAM'}] : [])];
      return {entry: {field_id: Number(im.id), values: values.length ? values : null}};
    }
    const field = named ? fieldById.get(Number(named.field_id)) : fieldsOf.contact.find(item => item.code !== 'IM' && /telegram|телеграм/i.test(item.name || ''));
    return field ? {entry: {field_id: Number(field.id), values: value ? [{value}] : null}} : {unsupported: 'в amoCRM нет поля Telegram'};
  }
  const amoTags = raw => (raw?._embedded?.tags || []).map(tag => ({name: String(tag.name || ''), shown: String(tag.name || '').replace(/,/g, ' ').trim()})).filter(tag => tag.shown);

  // What to send for the keys of a record. raw = the amoCRM record (null when it is created).
  // → {body, links, notes, sent, unsupported: {key: reason}, deferred}
  function build(type, id, state, raw, keys) {
    const body = {}, links = [], notes = [], sent = [], unsupported = {}, deferred = [], custom = [];
    const creating = !raw, amoId = raw ? Number(raw.id) : null;
    const put = (key, fn) => { const result = fn(); if (result?.unsupported) unsupported[key] = result.unsupported; else if (result?.deferred) deferred.push(key); else sent.push(key); };
    const tags = {add: [], remove: []};
    for (const key of keys) {
      if (key === 'name') put(key, () => { body.name = state.name; });
      else if (key === 'owner_id') put(key, () => { const user = amoUser(state.owner_id); if (!user) return {unsupported: state.owner_id ? `у сотрудника ${state.owner_id} нет пользователя в amoCRM` : 'ответственный не указан'}; body.responsible_user_id = user; });
      else if (key === 'tags') put(key, () => {
        const wanted = list(state.tags), had = amoTags(raw);
        for (const name of wanted) if (!had.some(tag => tag.shown === name)) tags.add.push(name);
        for (const tag of had) if (!wanted.includes(tag.shown) && tag.shown !== deletedTag) tags.remove.push(tag.name);
      });
      else if (key.startsWith('cf:')) put(key, () => { const result = customValue(Number(key.slice(3)), state[key]); if (result.entry) custom.push(result.entry); return result; });
      else if (key === 'deleted') put(key, () => {
        if (type === 'task') { body.is_completed = true; body.result = {text: deletedTag}; return; }
        if (state.deleted) { tags.add.push(deletedTag); if (type === 'deal' && raw) { body.status_id = 143; body.pipeline_id = Number(raw.pipeline_id); } }
        else tags.remove.push(...amoTags(raw).filter(tag => tag.shown === deletedTag).map(tag => tag.name));
      });
      else if (key === 'company_id') put(key, () => {
        const target = amoRef('company', state.company_id), current = raw?._embedded?.companies?.[0]?.id ?? null;
        if (target === undefined) return {deferred: true};
        if (current && Number(current) !== target) links.push(['unlink', {to_entity_id: Number(current), to_entity_type: 'companies'}]);
        if (target && Number(current) !== target) links.push(['link', {to_entity_id: target, to_entity_type: 'companies'}]);
      });
      else if (key === 'contacts') put(key, () => {
        const wanted = state.contacts.map(contact => amoRef('contact', contact)), known = wanted.filter(Boolean);
        const current = (raw?._embedded?.contacts || []).map(contact => ({id: Number(contact.id), main: !!contact.is_main}));
        for (const contact of current) if (!known.includes(contact.id)) links.push(['unlink', {to_entity_id: contact.id, to_entity_type: 'contacts'}]);
        known.forEach((contact, index) => {
          const had = current.find(item => item.id === contact), main = index === 0 && wanted[0] === contact;
          if (!had || main && !had.main) links.push(['link', {to_entity_id: contact, to_entity_type: 'contacts', metadata: {is_main: main}}]);
        });
        if (wanted.includes(undefined)) return {deferred: true};
      });
      else if (type === 'deal' && key === 'amount') put(key, () => { body.price = Number(state.amount) || 0; });
      else if (type === 'deal' && key === 'stage_id') put(key, () => {
        const stage = stages.get(state.stage_id);
        if (!stage) return {unsupported: `этапа ${state.stage_id} нет в OpenCRM`};
        const status = stage.kind === 'won' ? 142 : stage.kind === 'lost' ? 143 : state.stage_id, amo = amoStatuses.get(`${stage.pipeline}:${status}`);
        if (!amo && status !== 142 && status !== 143) return {unsupported: `этапа ${status} воронки ${stage.pipeline} нет в amoCRM`};
        if (amo?.type === 1) return {unsupported: 'в «Неразобранное» API amoCRM сделку не ставит'};
        body.status_id = status; body.pipeline_id = stage.pipeline;
      });
      else if (type === 'deal' && key === 'loss_reason') put(key, () => {
        if (!state.loss_reason) return {unsupported: 'причину отказа API amoCRM не очищает'};
        const reason = lossReasons.get(state.loss_reason.trim().toLowerCase());
        if (reason) { body.loss_reason_id = reason; return; }
        notes.push(`Причина отказа (из OpenCRM): ${state.loss_reason}`);
        return {unsupported: `причины «${state.loss_reason}» нет в amoCRM — записана примечанием`};
      });
      else if (key === 'phone' || key === 'email') put(key, () => { custom.push(multi(type, key === 'phone' ? 'PHONE' : 'EMAIL', state[key], raw)); });
      else if (key === 'position' || key === 'website' || key === 'address') put(key, () => { custom.push(single(type, {position: 'POSITION', website: 'WEB', address: 'ADDRESS'}[key], state[key])); });
      else if (key === 'telegram') put(key, () => { const result = telegram(state.telegram, raw); if (result.entry) custom.push(result.entry); return result; });
      else if (type === 'task' && (key === 'title' || key === 'description')) put(key, () => {
        const description = state.description || '';
        body.text = !description ? state.title : description.startsWith(state.title) ? description : `${state.title}\n${description}`;
      });
      else if (type === 'task' && key === 'task_type') put(key, () => { const typeId = taskTypeId(state.task_type); if (!typeId) return {unsupported: `типа задачи «${state.task_type}» нет в amoCRM`}; body.task_type_id = typeId; });
      else if (type === 'task' && ['due_at', 'all_day', 'duration_minutes'].includes(key)) put(key, () => {
        const due = state.due_at ? Math.floor(Date.parse(state.due_at) / 1000) : null;
        if (state.all_day || due == null) body.complete_till = zonedTime(localDate(due ?? Math.floor(Date.now() / 1000), zone), 23, 59, zone);
        else body.complete_till = due;
        body.duration = state.all_day ? 0 : (Number(state.duration_minutes) || 0) * 60;
      });
      else if (type === 'task' && (key === 'completed' || key === 'completion_result')) put(key, () => {
        if (state.deleted) return;
        body.is_completed = !!state.completed;
        if (state.completed && state.completion_result) body.result = {text: state.completion_result};
      });
      else if (type === 'task' && ['deal_id', 'contact_id', 'company_id'].includes(key)) put(key, () => {
        const [entityType, localId] = state.deal_id ? ['deal', state.deal_id] : state.contact_id ? ['contact', state.contact_id] : state.company_id ? ['company', state.company_id] : [null, null];
        if (!entityType) return {unsupported: 'задачу в amoCRM нельзя отвязать от записи'};
        const target = amoRef(entityType, localId);
        if (target === undefined) return {deferred: true};
        body.entity_id = target; body.entity_type = amoPath[entityType];
      });
      else unsupported[key] = 'поле не записывается в amoCRM';
    }
    if (custom.length) body.custom_fields_values = custom;
    if (creating) { if (tags.add.length) body._embedded = {tags: tags.add.map(name => ({name}))}; }
    else { if (tags.add.length) body.tags_to_add = tags.add.map(name => ({name})); if (tags.remove.length) body.tags_to_delete = tags.remove.map(name => ({name})); }
    return {body, links, notes, sent: [...new Set(sent)], unsupported, deferred, amoId};
  }
  // The API requests of a build; idText stands for a number amoCRM gives on create.
  function requests(type, built, amoId) {
    const path = amoPath[type], out = [], id = amoId ?? '<новый>';
    const body = {...built.body};
    let after = null;
    if (amoId == null) {
      // A task is created open and completed by a second request.
      if (type === 'task' && 'is_completed' in body) { after = {is_completed: body.is_completed, ...(body.result ? {result: body.result} : {})}; delete body.is_completed; delete body.result; }
      out.push({method: 'POST', path: `/api/v4/${path}`, body: [body]});
      if (after?.is_completed) out.push({method: 'PATCH', path: `/api/v4/${path}/${id}`, body: after});
    } else if (Object.keys(body).length) out.push({method: 'PATCH', path: `/api/v4/${path}/${id}`, body});
    for (const action of ['unlink', 'link']) {
      const items = built.links.filter(link => link[0] === action).map(link => link[1]);
      if (items.length) out.push({method: 'POST', path: `/api/v4/${path}/${id}/${action}`, body: items});
    }
    for (const text of built.notes) out.push({method: 'POST', path: `/api/v4/${path}/notes`, body: [{entity_id: id, note_type: 'common', params: {text}}]});
    return out;
  }
  async function send(list, amoId) {
    let id = amoId;
    for (const request of list) {
      const path = request.path.replace('<новый>', id), body = JSON.parse(JSON.stringify(request.body).replaceAll('"<новый>"', String(id)));
      const response = await client.send(request.method, path, body);
      if (request.method === 'POST' && id == null) {
        id = Number(response?._embedded?.[request.path.split('/')[3]]?.[0]?.id);
        if (!id) throw new Error(`amoCRM не вернул номер новой записи (${request.path})`);
      }
    }
    return id;
  }
  const differs = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].some(key => !same(a[key] ?? emptyOf(key), b[key] ?? emptyOf(key)));

  for (const type of order) {
    const spec = specs[type];
    const changed = (await db.query(`SELECT id,updated_at FROM ${spec.table} WHERE updated_at >= $1 ORDER BY updated_at,id`, [since])).rows;
    const candidates = ids([...changed.map(row => row.id), ...[...nativeIds[type]].sort((a, b) => a - b), ...(due[type] || [])]);
    if (!candidates.length) continue;
    const updatedAt = new Map(changed.map(row => [Number(row.id), row.updated_at]));
    const local = await loadLocal(db, type, candidates, amoFields), links = await linksOf(db, type, candidates);
    const creates = [], checks = [];
    for (const id of candidates) {
      const item = local.get(id), link = links.get(id), snap = link?.snapshot_json ? JSON.parse(link.snapshot_json) : null;
      if (!item) { done(type, id); continue; }
      if (!link && native(type, id)) { if (item.state.deleted) done(type, id); else creates.push(id); continue; }
      if (snap && (!differs(item.state, snap) || item.state.deleted && snap.deleted)) { done(type, id); continue; }
      checks.push(id);
    }
    // A long backlog is worked off over several cycles: the cursor stops at the first record left.
    if (checks.length > checkLimit) { const at = textTime(updatedAt.get(checks[checkLimit])); if (Number.isFinite(at)) nextCursor = Math.min(nextCursor, at); checks.length = checkLimit; }

    const pushed = [];
    const amo = checks.length ? await readAmo(type, checks) : new Map();
    for (const id of checks) {
      const item = local.get(id), link = links.get(id), snap = link?.snapshot_json ? JSON.parse(link.snapshot_json) : null, remote = amo.get(id), amoId = pairs.amo(type, id);
      const entry = {entity_type: type, amo_id: amoId, opencrm_id: id};
      try {
        if (!remote) { done(type, id); continue; } // deleted in amoCRM or its stage is unknown: the other direction handles it
        if (item.state.deleted && remote.state.deleted) { done(type, id); continue; }
        const plan = planRecord(remote.state, item.state, snap || remote.state, config.primary);
        const won = plan.conflicts.filter(conflict => conflict.kept === 'opencrm');
        for (const conflict of won) { counts.conflicts++; log({...entry, action: 'conflict', details: conflict}); }
        let keys = [...plan.pending, ...won.map(conflict => conflict.key)];
        if (item.state.deleted) keys = keys.includes('deleted') ? ['deleted'] : [];
        if (!keys.length) {
          if (!dry && !snap) await saveLink(db, type, id, plan.next, false, amoId);
          done(type, id); continue;
        }
        const built = build(type, id, item.state, remote.raw, keys), list = requests(type, built, amoId);
        const action = keys.includes('deleted') ? (item.state.deleted ? 'delete' : 'restore') : 'update';
        const unsupported = Object.keys(built.unsupported);
        if (unsupported.length) { counts.unsupported++; log({...entry, action: 'unsupported', details: {fields: built.unsupported}}); }
        if (list.length) { counts[action === 'delete' ? 'deleted' : 'updated']++; log({...entry, action, details: {fields: Object.fromEntries([...built.sent, ...built.deferred].map(key => [key, item.state[key]]))}}, list); }
        if (dry) { done(type, id); continue; }
        if (list.length) await send(list, amoId);
        pushed.push({id, amoId, built, snap, keep: Object.keys(plan.apply)});
      } catch (error) {
        counts.errors++;
        note({...entry, action: 'error', details: {error: String(error.message || error).slice(0, 500)}});
        fail(type, id, error.message || error);
      }
    }

    for (const id of creates.slice(0, createLimit)) {
      const item = local.get(id), entry = {entity_type: type, amo_id: null, opencrm_id: id};
      try {
        const keys = Object.keys(item.state).filter(key => key !== 'deleted' && item.state[key] !== '' && item.state[key] != null && !(Array.isArray(item.state[key]) && !item.state[key].length));
        const built = build(type, id, item.state, null, keys), list = requests(type, built, null);
        if (type === 'task' && !('complete_till' in built.body)) { built.body.complete_till = zonedTime(localDate(Math.floor(Date.now() / 1000), zone), 23, 59, zone); list[0].body[0].complete_till = built.body.complete_till; }
        if (type === 'deal' && !('status_id' in built.body) && stages.get(item.state.stage_id)) built.body.pipeline_id = list[0].body[0].pipeline_id = stages.get(item.state.stage_id).pipeline;
        if (Object.keys(built.unsupported).length) { counts.unsupported++; log({...entry, action: 'unsupported', details: {fields: built.unsupported}}); }
        counts.created++;
        log({...entry, action: 'create', details: {name: item.state.name || item.state.title}}, list);
        if (dry) { if (built.deferred.length) fail(type, id, `ещё нет в amoCRM: ${built.deferred.join(', ')}`); else done(type, id); continue; }
        // The pair is saved right after the create, so a failure later never makes a second copy.
        const [first, ...rest] = list, amoId = await send([first]);
        pairs.add(type, amoId, id);
        const afterCreate = {...item.state};
        for (const key of [...linkKeys[type], ...built.deferred]) afterCreate[key] = Array.isArray(afterCreate[key]) ? [] : emptyOf(key);
        await saveLink(db, type, id, afterCreate, false, amoId);
        if (rest.length) await send(rest, amoId);
        pushed.push({id, amoId, built, snap: null, keep: [], created: true});
      } catch (error) {
        counts.errors++;
        note({...entry, action: 'error', details: {error: String(error.message || error).slice(0, 500)}});
        fail(type, id, error.message || error);
      }
    }

    // Read back what was written: the snapshot becomes the amoCRM state, and where amoCRM keeps a value
    // in another shape, that shape is written here, so nothing goes back and forth.
    if (pushed.length) {
      let back;
      try { back = await readAmo(type, pushed.map(item => item.id)); } catch (error) { for (const item of pushed) fail(type, item.id, `не удалось прочитать запись после записи: ${error.message || error}`); continue; }
      const current = await loadLocal(db, type, pushed.map(item => item.id), amoFields);
      for (const item of pushed) {
        const remote = back.get(item.id), here = current.get(item.id)?.state;
        if (!remote || !here) { fail(type, item.id, 'amoCRM не вернул запись после записи'); continue; }
        const snapshot = {...remote.state};
        for (const key of Object.keys(item.built.unsupported)) snapshot[key] = here[key];
        for (const key of item.keep) snapshot[key] = item.snap?.[key];
        const writeBack = {};
        // Every field but the ones amoCRM did not take: what was sent may come back in another shape, and
        // a value may show up in another field too (Telegram also fills the messenger field).
        const skip = new Set(['deleted', ...Object.keys(item.built.unsupported), ...item.built.deferred, ...item.keep]);
        if (!here.deleted) for (const key of new Set([...Object.keys(remote.state), ...Object.keys(here)])) if (!skip.has(key) && !same(remote.state[key] ?? emptyOf(key), here[key] ?? emptyOf(key))) writeBack[key] = remote.state[key] ?? emptyOf(key);
        try {
          if (Object.keys(writeBack).length) {
            await db.transaction(() => updateRecord(db, type, item.id, writeBack, remote.row))();
            note({entity_type: type, amo_id: item.amoId, opencrm_id: item.id, action: 'normalized', details: {fields: writeBack}});
          }
          await saveLink(db, type, item.id, snapshot, false, item.amoId);
          if (item.built.deferred.length) fail(type, item.id, `ещё нет в amoCRM: ${item.built.deferred.join(', ')}`);
          else done(type, item.id);
        } catch (error) { counts.errors++; note({entity_type: type, amo_id: item.amoId, opencrm_id: item.id, action: 'error', details: {error: String(error.message || error).slice(0, 500)}}); fail(type, item.id, error.message || error); }
      }
    }
  }

  // Notes made here (numbers from AMOCRM_SYNC_NATIVE_NOTES_FROM) are added to amoCRM as common notes.
  // Notes the sync itself writes about conflicts stay here; note edits are not copied.
  const noteSets = [
    ['note_lead', 'deal', 'SELECT id,deal_id entity_id,body,note_type,user_id FROM notes n', ''],
    ['note_contact', 'contact', "SELECT id,entity_id,body,note_type,user_id FROM entity_notes n", "AND n.entity_type='contact'"],
    ['note_company', 'company', "SELECT id,entity_id,body,note_type,user_id FROM entity_notes n", "AND n.entity_type='company'"]
  ];
  for (const [noteType, entityType, select, extra] of noteSets) {
    const rows = (await db.query(`${select} WHERE n.id >= $1 ${extra} AND (n.created_at >= $2 OR n.id = ANY($3)) AND n.created_at >= $5 AND NOT EXISTS (SELECT 1 FROM amocrm_sync_links l WHERE l.entity_type=$4 AND l.opencrm_id=n.id) ORDER BY n.id LIMIT 200`, [config.nativeNotesFrom, since, ids(due[noteType] || []), noteType, sinceStart])).rows;
    for (const row of rows) {
      const id = Number(row.id), entry = {entity_type: noteType, amo_id: null, opencrm_id: id};
      if (row.note_type !== 'common' || String(row.body).startsWith(conflictNotePrefix)) { done(noteType, id); continue; }
      try {
        const target = amoRef(entityType, row.entity_id);
        const user = amoUser(row.user_id);
        const request = {method: 'POST', path: `/api/v4/${notePath[noteType]}/notes`, body: [{entity_id: target ?? `<${entityType}:${row.entity_id}>`, note_type: 'common', params: {text: String(row.body)}, ...(user ? {created_by: user} : {})}]};
        if (target === undefined) { if (!dry) { fail(noteType, id, `записи ${row.entity_id} ещё нет в amoCRM`); continue; } }
        counts.notes++;
        log({...entry, action: 'create', details: {entity_type: entityType, entity_id: Number(row.entity_id)}}, [request]);
        if (dry) { done(noteType, id); continue; }
        const response = await client.send(request.method, request.path, request.body), amoId = Number(response?._embedded?.notes?.[0]?.id);
        if (!amoId) throw new Error('amoCRM не вернул номер примечания');
        pairs.add(noteType, amoId, id);
        await saveLink(db, noteType, id, {}, false, amoId);
        done(noteType, id);
      } catch (error) {
        counts.errors++;
        note({...entry, action: 'error', details: {error: String(error.message || error).slice(0, 500)}});
        fail(noteType, id, error.message || error);
      }
    }
  }

  await settleRetries(db, {dry, started, succeeded, failed, attemptsOf, counts, note});
  if (dry) await saveSetting(db, seenKey, seenNow);
  await saveSetting(db, cursorKey, nextCursor);
  return counts;
}
