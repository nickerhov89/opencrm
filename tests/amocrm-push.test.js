import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const t = iso => Math.floor(Date.parse(iso) / 1000);
const now = () => Math.floor(Date.now() / 1000);
const statuses = list => list.map(([id, name, sort, type = 0]) => ({id, name, sort, type, color: '#99ccff', pipeline_id: 7001}));

function baseDump() {
  return {
    account: {timezone: 'Europe/Moscow', task_types: []},
    pipelines: [{id: 7001, name: 'Первичка', sort: 1, _embedded: {statuses: statuses([[5001, 'Неразобранное', 10, 1], [5002, 'Взять в работу', 20], [5003, 'Квалификация', 30], [142, 'Успешно', 10000], [143, 'Отказ', 11000]])}}],
    users: [{id: 9001, name: 'Анна', email: 'anna@agency.test', rights: {is_admin: true, is_active: true}}, {id: 9002, name: 'Борис', email: 'boris@agency.test', rights: {is_active: true}}],
    custom_fields_leads: [{id: 1314379, name: 'Источник', type: 'select', sort: 1, enums: [{id: 1, value: 'Сайт', sort: 1}, {id: 2, value: 'Реклама', sort: 2}]}, {id: 1317000, name: 'Дата встречи', type: 'date', sort: 2}],
    custom_fields_contacts: [{id: 100, name: 'Телефон', code: 'PHONE', type: 'multitext', sort: 1}, {id: 101, name: 'Мессенджер', code: 'IM', type: 'multitext', sort: 2}, {id: 102, name: 'Email', code: 'EMAIL', type: 'multitext', sort: 3}],
    custom_fields_companies: [],
    companies: [{id: 3001, name: 'ООО Ромашка', responsible_user_id: 9001, created_at: t('2025-01-01T10:00:00Z'), updated_at: t('2025-01-01T10:00:00Z')}],
    contacts: [{id: 4001, name: 'Иван', responsible_user_id: 9001, created_at: t('2025-01-01T10:00:00Z'), updated_at: t('2025-01-01T10:00:00Z'), custom_fields_values: [{field_id: 100, field_code: 'PHONE', values: [{value: '+7 900 111-11-11', enum_code: 'MOB'}]}], _embedded: {companies: [{id: 3001}]}}],
    leads: [{id: 21000001, name: 'Сайт для Ромашки', price: 100000, responsible_user_id: 9001, created_by: 9001, status_id: 5002, pipeline_id: 7001, created_at: t('2025-11-20T09:00:00Z'), updated_at: t('2025-11-20T09:00:00Z'),
      custom_fields_values: [{field_id: 1314379, values: [{value: 'Сайт', enum_id: 1}]}], _embedded: {tags: [{name: 'сайт'}], contacts: [{id: 4001, is_main: true}], companies: [{id: 3001}]}}],
    tasks: [{id: 61000001, entity_type: 'leads', entity_id: 21000001, task_type_id: 1, text: 'Позвонить', complete_till: t('2025-11-25T08:00:00Z'), is_completed: false, responsible_user_id: 9001, created_at: t('2025-11-20T09:00:00Z'), updated_at: t('2025-11-20T09:00:00Z')}],
    notes_leads: [], notes_contacts: [], notes_companies: [], events: [], events_history: [], event_types: [], files: []
  };
}

// A small amoCRM: keeps records, answers reads like API v4 and applies writes.
function fakeAmo(dump) {
  const store = {leads: structuredClone(dump.leads), contacts: structuredClone(dump.contacts), companies: structuredClone(dump.companies), tasks: structuredClone(dump.tasks), notes_leads: [], notes_contacts: [], notes_companies: []};
  const next = {leads: 21100001, contacts: 4100001, companies: 3100001, tasks: 61100001, notes: 117100001};
  const defs = new Map(['leads', 'contacts', 'companies'].flatMap(entity => dump[`custom_fields_${entity}`].map(field => [`${entity}:${field.id}`, field]).concat(dump[`custom_fields_${entity}`].filter(f => f.code).map(field => [`${entity}:${field.code}`, field]))));
  const lists = {'/api/v4/companies': 'companies', '/api/v4/contacts': 'contacts', '/api/v4/leads': 'leads', '/api/v4/tasks': 'tasks', '/api/v4/leads/notes': 'notes_leads', '/api/v4/contacts/notes': 'notes_contacts', '/api/v4/companies/notes': 'notes_companies'};
  const lossReasons = [{id: 801, name: 'Дорого'}];
  const find = (entity, id) => store[entity].find(record => Number(record.id) === Number(id));
  const touch = record => { record.updated_at = now(); };
  function patch(entity, record, body) {
    for (const key of ['name', 'price', 'status_id', 'pipeline_id', 'responsible_user_id', 'text', 'complete_till', 'duration', 'task_type_id', 'is_completed', 'result', 'entity_id', 'entity_type']) if (key in body) record[key] = body[key];
    if ('loss_reason_id' in body) { record._embedded ||= {}; record._embedded.loss_reason = lossReasons.filter(reason => reason.id === body.loss_reason_id); }
    if ([142, 143].includes(body.status_id)) record.closed_at = now();
    for (const entry of body.custom_fields_values || []) {
      const def = defs.get(`${entity}:${entry.field_id ?? entry.field_code}`);
      record.custom_fields_values = (record.custom_fields_values || []).filter(item => item.field_id !== def.id);
      if (entry.values) record.custom_fields_values.push({field_id: def.id, field_code: def.code || null, field_name: def.name, values: entry.values.map(value => value.enum_id ? {enum_id: value.enum_id, value: def.enums.find(item => item.id === value.enum_id).value} : {...value})});
    }
    record._embedded ||= {};
    const tags = record._embedded.tags || [];
    for (const tag of body.tags_to_add || []) if (!tags.some(item => item.name === tag.name)) tags.push({name: tag.name});
    record._embedded.tags = tags.filter(tag => !(body.tags_to_delete || []).some(item => item.name === tag.name));
    if (body._embedded?.tags) record._embedded.tags = body._embedded.tags.map(tag => ({name: tag.name}));
    touch(record);
  }
  const client = {
    writes: [],
    async request(path) {
      if (path === '/api/v4/account') return {datetime_settings: {timezone: dump.account.timezone}, _embedded: {task_types: []}};
      if (path === '/api/v4/leads/pipelines') return {_embedded: {pipelines: dump.pipelines}};
      if (path === '/api/v4/events/types') return {_embedded: {events_types: []}};
      if (path === '/api/v4/leads/loss_reasons') return {_embedded: {loss_reasons: lossReasons}};
      const one = /^\/api\/v4\/(leads|contacts|companies|tasks)\/(\d+)$/.exec(path);
      if (one) return structuredClone(find(one[1], one[2]) || null);
      throw new Error(`unexpected ${path}`);
    },
    async list(path, _key, params = {}) {
      if (path === '/api/v4/users') return dump.users;
      const fields = /^\/api\/v4\/(leads|contacts|companies)\/custom_fields$/.exec(path);
      if (fields) return dump[`custom_fields_${fields[1]}`];
      if (path === '/api/v4/events') return [];
      const name = lists[path];
      if (!name) throw new Error(`unexpected list ${path}`);
      let records = store[name];
      if (params['filter[id][]']) records = records.filter(record => params['filter[id][]'].map(Number).includes(Number(record.id)));
      if (params['filter[updated_at][from]'] != null) records = records.filter(record => record.updated_at >= params['filter[updated_at][from]']);
      return structuredClone(records);
    },
    async send(method, path, body) {
      client.writes.push([method, path, structuredClone(body)]);
      let match;
      if (method === 'PATCH' && (match = /^\/api\/v4\/(leads|contacts|companies|tasks)\/(\d+)$/.exec(path))) { const record = find(match[1], match[2]); patch(match[1], record, body); return {id: record.id}; }
      if (method === 'POST' && (match = /^\/api\/v4\/(leads|contacts|companies)\/notes$/.exec(path))) {
        const created = body.map(item => { const note = {...item, id: next.notes++, created_at: now(), updated_at: now()}; store[`notes_${match[1]}`].push(note); return {id: note.id, entity_id: item.entity_id}; });
        return {_embedded: {notes: created}};
      }
      if (method === 'POST' && (match = /^\/api\/v4\/(leads|contacts|companies|tasks)$/.exec(path))) {
        const created = body.map(item => {
          const record = {id: next[match[1]]++, created_at: now(), created_by: 0, is_completed: false, _embedded: {tags: [], contacts: [], companies: []}};
          patch(match[1], record, item);
          store[match[1]].push(record);
          return {id: record.id};
        });
        return {_embedded: {[match[1]]: created}};
      }
      if (method === 'POST' && (match = /^\/api\/v4\/(leads|contacts|companies)\/(\d+)\/(link|unlink)$/.exec(path))) {
        const record = find(match[1], match[2]);
        record._embedded ||= {};
        for (const item of body) {
          const list = record._embedded[item.to_entity_type] ||= [];
          const rest = list.filter(link => Number(link.id) !== item.to_entity_id);
          if (match[3] === 'unlink') record._embedded[item.to_entity_type] = rest;
          else if (item.to_entity_type === 'contacts') record._embedded.contacts = [...(item.metadata?.is_main ? rest.map(link => ({...link, is_main: false})) : rest), {id: item.to_entity_id, is_main: !!item.metadata?.is_main}];
          else record._embedded[item.to_entity_type] = [{id: item.to_entity_id}];
        }
        touch(record);
        return null;
      }
      throw new Error(`unexpected ${method} ${path}`);
    }
  };
  return {client, store, find};
}

test('amoCRM sync, stage 2: OpenCRM changes go to amoCRM, read back without echo', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opencrm-amo-push-'));
  const {createDb} = await import('../server/db.js');
  const {loadDump} = await import('../scripts/amocrm-lib.mjs');
  const {runSyncCycle, syncStatus, syncLog} = await import('../server/amocrm-sync.js');
  const db = await createDb({dataDir: join(dir, 'pg'), url: ''});
  try {
    const dump = baseDump();
    await loadDump(db, dump, {log: () => {}, uploads: join(dir, 'uploads')});
    for (const [table, start] of [['deals', 50000000], ['contacts', 50000000], ['companies', 50000000], ['tasks', 50000000], ['notes', 500000000], ['entity_notes', 500000000]]) await db.query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), ${start})`);
    const {client, store, find} = fakeAmo(dump);
    const config = toAmo => ({mode: 'both', toAmo, primary: 'amo', overlapSec: 0, since: now() - 5, defaultOwner: null, nativeFrom: 50000001, nativeNotesFrom: 500000001});
    const cycle = toAmo => runSyncCycle(db, client, config(toAmo), {log: () => {}});
    const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
    const count = async (sql, params = []) => Number((await one(sql, params)).n);

    // Nothing changed anywhere: nothing goes either way.
    const idle = await cycle('on');
    assert.deepEqual([idle.created, idle.updated, idle.to_amo.created, idle.to_amo.updated], [0, 0, 0, 0]);

    // Changes made in OpenCRM.
    await db.query("UPDATE deals SET name='Сайт для Ромашки (v2)', stage_id=5003, tags='сайт, важно' WHERE id=21000001");
    await db.query("UPDATE custom_field_values SET value='Реклама' WHERE field_id=1314379 AND entity_id=21000001");
    await db.query("INSERT INTO custom_field_values (field_id,entity_id,value) VALUES (1317000,21000001,'2026-12-01')");
    const contactId = Number((await one("INSERT INTO contacts (name,company_id,owner_id,phone,email,telegram) VALUES ('Пётр',3001,9002,'+7 900 222-22-22','petr@client.test','@petr') RETURNING id")).id);
    assert.equal(contactId, 50000001);
    const dealId = Number((await one("INSERT INTO deals (name,stage_id,owner_id,amount,contact_id,company_id) VALUES ('Новая из OpenCRM',5002,9002,5000,$1,3001) RETURNING id", [contactId])).id);
    await db.query('INSERT INTO deal_contacts (deal_id,contact_id) VALUES ($1,$2)', [dealId, contactId]);
    const taskId = Number((await one("INSERT INTO tasks (title,description,task_type,due_at,deal_id,owner_id) VALUES ('Перезвонить','Обсудить КП','Встреча','2026-11-25T09:00:00.000Z',21000001,9001) RETURNING id")).id);
    await db.query("UPDATE tasks SET completed_at=$1, completion_result='Готово' WHERE id=61000001", [new Date().toISOString()]);
    const noteId = Number((await one("INSERT INTO notes (deal_id,body,user_id) VALUES (21000001,'Клиент просил скидку',9002) RETURNING id")).id);
    await db.query("INSERT INTO notes (deal_id,body) VALUES (21000001,'Синхронизация с amoCRM: служебное')");

    // dry_run: amoCRM is not touched, the log shows the requests, once.
    const dry = await cycle('dry_run');
    assert.equal(client.writes.length, 0);
    assert.deepEqual([dry.to_amo.created, dry.to_amo.updated, dry.to_amo.notes], [3, 2, 1]);
    const planned = (await syncLog(db, {direction: 'opencrm_to_amo'})).items;
    assert.ok(planned.every(item => item.dry_run));
    const leadPlan = planned.find(item => item.entity_type === 'deal' && item.opencrm_id === 21000001);
    assert.deepEqual(leadPlan.details.requests[0], {method: 'PATCH', path: '/api/v4/leads/21000001', body: {name: 'Сайт для Ромашки (v2)', status_id: 5003, pipeline_id: 7001, custom_fields_values: [{field_id: 1314379, values: [{enum_id: 2}]}, {field_id: 1317000, values: [{value: t('2026-11-30T21:00:00Z')}]}], tags_to_add: [{name: 'важно'}]}});
    const before = planned.length;
    await cycle('dry_run');
    assert.equal((await syncLog(db, {direction: 'opencrm_to_amo'})).items.length, before, 'a dry run logs the same plan once');
    assert.equal(client.writes.length, 0);

    // on: written to amoCRM.
    const live = await cycle('on');
    assert.deepEqual([live.to_amo.created, live.to_amo.updated, live.to_amo.notes, live.to_amo.errors], [3, 2, 1, 0]);
    const lead = find('leads', 21000001);
    assert.deepEqual([lead.name, lead.status_id, lead._embedded.tags.map(tag => tag.name)], ['Сайт для Ромашки (v2)', 5003, ['сайт', 'важно']]);
    assert.deepEqual(lead.custom_fields_values.find(item => item.field_id === 1314379).values, [{enum_id: 2, value: 'Реклама'}]);
    const contact = store.contacts.find(item => item.name === 'Пётр');
    assert.ok(contact.id < 50000000, 'amoCRM gives its own number');
    assert.deepEqual(contact.custom_fields_values.find(item => item.field_code === 'PHONE').values, [{value: '+7 900 222-22-22', enum_code: 'WORK'}]);
    assert.deepEqual(contact.custom_fields_values.find(item => item.field_code === 'IM').values, [{value: '@petr', enum_code: 'TELEGRAM'}]);
    assert.deepEqual(contact._embedded.companies, [{id: 3001}]);
    const newLead = store.leads.find(item => item.name === 'Новая из OpenCRM');
    assert.deepEqual([newLead.status_id, newLead.price, newLead.responsible_user_id, newLead._embedded.contacts], [5002, 5000, 9002, [{id: contact.id, is_main: true}]]);
    const newTask = store.tasks.find(item => item.text?.startsWith('Перезвонить'));
    assert.deepEqual([newTask.text, newTask.task_type_id, newTask.entity_type, newTask.entity_id, newTask.complete_till], ['Перезвонить\nОбсудить КП', 2, 'leads', 21000001, t('2026-11-25T09:00:00Z')]);
    assert.deepEqual([find('tasks', 61000001).is_completed, find('tasks', 61000001).result], [true, {text: 'Готово'}]);
    assert.deepEqual(store.notes_leads.map(item => [item.entity_id, item.params.text]), [[21000001, 'Клиент просил скидку']], 'notes of the sync itself stay here');
    const pair = await one("SELECT amo_id,opencrm_id FROM amocrm_sync_links WHERE entity_type='contact' AND opencrm_id=$1", [contactId]);
    assert.equal(Number(pair.amo_id), contact.id);
    assert.ok(await one("SELECT 1 FROM amocrm_sync_links WHERE entity_type='note_lead' AND opencrm_id=$1", [noteId]));

    // The circle OpenCRM → amoCRM → reading amoCRM: nothing comes back, nothing goes again.
    const writes = client.writes.length;
    const echo = await cycle('on');
    assert.deepEqual([echo.created, echo.updated, echo.conflicts, echo.notes, echo.errors], [0, 0, 0, 0, 0], 'nothing is copied back');
    assert.deepEqual([echo.to_amo.created, echo.to_amo.updated, echo.to_amo.notes, echo.to_amo.errors], [0, 0, 0, 0]);
    assert.equal(client.writes.length, writes);
    assert.equal(await count('SELECT COUNT(*) n FROM contacts'), 2, 'no copy of the new contact');
    assert.equal(await count('SELECT COUNT(*) n FROM deals'), 2);
    assert.equal(await count('SELECT COUNT(*) n FROM tasks'), 2);
    assert.equal(await count('SELECT COUNT(*) n FROM notes WHERE deal_id=21000001'), 2, 'the note is not loaded back');
    assert.equal((await one('SELECT description FROM tasks WHERE id=$1', [taskId])).description, 'Перезвонить\nОбсудить КП', 'the amoCRM shape of the text is kept here');

    // amoCRM → OpenCRM still works and finds the new records by their pair of numbers.
    contact.name = 'Пётр Петров'; contact.updated_at = now();
    const back = await cycle('on');
    assert.deepEqual([back.updated, back.created, back.to_amo.updated], [1, 0, 0]);
    assert.equal((await one('SELECT name FROM contacts WHERE id=$1', [contactId])).name, 'Пётр Петров');

    // «Неразобранное» cannot be set through the API: logged once, nothing written.
    await db.query('UPDATE deals SET stage_id=5001 WHERE id=$1', [dealId]);
    const unsorted = await cycle('on');
    assert.deepEqual([unsorted.to_amo.unsupported, unsorted.to_amo.updated], [1, 0]);
    assert.equal(newLead.status_id, 5002);
    assert.equal((await cycle('on')).to_amo.unsupported, 0, 'not logged again');

    // Deleted here: the deal gets the tag and goes to 143 in amoCRM, and stays in the trash here.
    await db.query('UPDATE deals SET deleted_at=now_text() WHERE id=21000001');
    const removed = await cycle('on');
    assert.equal(removed.to_amo.deleted, 1);
    assert.deepEqual([lead.status_id, lead._embedded.tags.map(tag => tag.name).includes('Удалена в OpenCRM')], [143, true]);
    const after = await cycle('on');
    assert.deepEqual([after.updated, after.deleted, after.to_amo.updated, after.to_amo.deleted], [0, 0, 0, 0]);
    assert.ok((await one('SELECT deleted_at FROM deals WHERE id=21000001')).deleted_at);
    assert.equal(Number((await one('SELECT stage_id FROM deals WHERE id=21000001')).stage_id), 5003, 'the stage here stays');

    const status = await syncStatus(db, config('on'));
    assert.equal(status.writes_to_amo, true);
    assert.ok(status.lag_seconds.opencrm_to_amo >= 0 && status.lag_seconds.opencrm_to_amo < 60);
    assert.equal(status.directions.opencrm_to_amo.errors_last_hour, 0);
    assert.equal(status.retry_queue, 0);
  } finally {
    await db.close();
    rmSync(dir, {recursive: true, force: true});
  }
});
