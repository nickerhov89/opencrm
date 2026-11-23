import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// The amoCRM bridge key (mirror:write): amoCRM numbers, authors and times, no stage rules, no robots.
test('mirror key: amoCRM numbers and authors, no stage rules, distribution or stage tasks', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opencrm-mirror-'));
  process.env.PGLITE_DIR = join(directory, 'pg');
  process.env.UPLOAD_DIR = join(directory, 'uploads');
  process.env.NODE_ENV = 'test';
  const {app, db} = await import('../server/index.js');
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  let cookie = '';
  async function call(path, {method = 'GET', body, status = 200, key} = {}) {
    const response = await fetch(base + path, {method, headers: {'Content-Type': 'application/json', ...(key ? {Authorization: `Bearer ${key}`} : {Cookie: cookie})}, body: body == null ? undefined : JSON.stringify(body)});
    const text = await response.text();
    assert.equal(response.status, status, `${method} ${path}: ${text}`);
    if (!key && response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return text ? JSON.parse(text) : null;
  }
  const events = async type => (await db.prepare('SELECT payload_json FROM webhook_events WHERE event_type=? ORDER BY id').all(type)).map(row => JSON.parse(row.payload_json));
  try {
    await call('/setup', {method: 'POST', body: {name: 'Admin', email: 'admin@example.test', password: 'test-password-123'}});
    const manager = (await call('/users', {method: 'POST', body: {name: 'Менеджер', email: 'manager@example.test', password: 'manager-password-1', role: 'member'}, status: 201})).id;
    const former = (await call('/users', {method: 'POST', body: {name: 'Уволенный', email: 'former@example.test', password: 'former-password-1', role: 'member'}, status: 201})).id;
    await db.prepare('UPDATE users SET disabled_at=CURRENT_TIMESTAMP WHERE id=?').run(former);
    const writes = ['deals:read', 'deals:write', 'contacts:read', 'contacts:write', 'companies:read', 'companies:write', 'tasks:read', 'tasks:write'];
    const bridgeKey = await call('/integrations/keys', {method: 'POST', body: {name: 'amoCRM', scopes: [...writes, 'mirror:write']}, status: 201});
    const bridge = bridgeKey.token, portal = (await call('/integrations/keys', {method: 'POST', body: {name: 'Portal', scopes: writes}, status: 201})).token;
    await call('/integrations/webhooks', {method: 'POST', body: {name: 'Bridge', url: 'https://bridge.example.test/hook', events: ['deal.created', 'deal.updated', 'deal.stage_changed', 'contact.updated', 'task.created', 'note.created', 'note.updated', 'note.deleted']}, status: 201});
    // OpenCRM numbers start far above amoCRM ones, as in production.
    for (const [table, start] of [['deals', 50000000], ['contacts', 50000000], ['companies', 50000000], ['tasks', 50000000], ['notes', 500000000], ['entity_notes', 500000000]]) await db.query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), ${start})`);

    // A pipeline with strict transitions, a stage task and distribution of API deals.
    const pipeline = (await db.prepare("SELECT id FROM pipelines ORDER BY id LIMIT 1").get()).id;
    const stages = await db.prepare('SELECT id,name,kind FROM stages WHERE pipeline_id=? ORDER BY sort_order').all(pipeline);
    const [first, second, third] = stages, lost = stages.find(stage => stage.kind === 'lost');
    await call(`/pipelines/${pipeline}/transitions`, {method: 'PUT', body: {mode: 'restricted', transitions: [{from_stage_id: first.id, to_stage_id: second.id}]}});
    await db.prepare("INSERT INTO stage_automations (stage_id,task_title,due_days) VALUES (?,'Задача этапа',1),(?,'Задача этапа',1)").run(first.id, third.id);
    await db.prepare("INSERT INTO deal_distribution_rules (name,origins_json,user_ids_json,active) VALUES ('Все','[\"api\"]',?,1)").run(JSON.stringify([manager]));
    const field = await call('/custom-fields', {method: 'POST', body: {entity_type: 'deal', name: 'Канал', field_type: 'text'}, status: 201});
    const other = await db.prepare('SELECT id FROM pipelines WHERE id<>? LIMIT 1').get(pipeline) || {id: (await call('/pipelines', {method: 'POST', body: {name: 'Вторая'}, status: 201})).id};
    const otherStage = (await db.prepare("SELECT id FROM stages WHERE pipeline_id=? AND kind='active' ORDER BY sort_order LIMIT 1").get(other.id)).id;

    // Contacts and companies keep the amoCRM number and times; a former employee may own them.
    const company = await call('/v1/companies', {key: bridge, method: 'POST', body: {id: 30000001, name: 'ООО Ромашка', owner_id: former, created_at: 1763800000, updated_at: '2025-11-22T10:00:00Z', author_id: manager}, status: 201});
    assert.equal(company.id, 30000001);
    assert.equal(company.created_at, '2025-11-22 08:26:40');
    assert.equal(company.updated_at, '2025-11-22 10:00:00');
    const contact = await call('/v1/contacts', {key: bridge, method: 'POST', body: {id: 30000002, name: 'Иван', company_id: company.id, owner_id: manager, author_id: manager}, status: 201});
    assert.equal(contact.id, 30000002);
    await call('/v1/contacts', {key: portal, method: 'POST', body: {name: 'Чужой', owner_id: former}, status: 400});
    assert.equal((await db.prepare('SELECT user_id FROM entity_activity WHERE entity_type=? AND entity_id=? ORDER BY id LIMIT 1').get('company', company.id)).user_id, manager, 'history names the author');

    // A deal with the amoCRM number: no distribution, no stage task, author in history.
    const body = {id: 36000001, name: 'Сделка из amoCRM', stage_id: first.id, owner_id: manager, contact_ids: [contact.id], company_id: company.id, custom_fields: {[field.id]: 'Сайт'}, created_at: '2025-11-23 09:00:00', updated_at: '2025-11-23 09:05:00', author_id: manager};
    const deal = await call('/v1/deals', {key: bridge, method: 'POST', body, status: 201});
    assert.equal(deal.id, 36000001);
    assert.equal(deal.created_at, '2025-11-23 09:00:00');
    assert.equal(deal.updated_at, '2025-11-23 09:05:00', 'contacts and fields saved after the insert keep the given updated_at');
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM tasks WHERE deal_id=?').get(deal.id)).n, 0, 'no stage task');
    assert.equal(await db.prepare('SELECT 1 FROM deal_distribution_queue WHERE deal_id=?').get(deal.id), undefined, 'not distributed');
    assert.equal((await db.prepare('SELECT user_id FROM activity WHERE deal_id=? ORDER BY id LIMIT 1').get(deal.id)).user_id, manager);
    const created = await db.prepare('SELECT user_id,api_key_id,changed_at FROM deal_stage_changes WHERE deal_id=?').get(deal.id);
    assert.deepEqual({...created, user_id: Number(created.user_id), api_key_id: Number(created.api_key_id)}, {user_id: manager, api_key_id: bridgeKey.id, changed_at: '2025-11-23 09:00:00'});
    assert.deepEqual((await events('deal.created')).at(-1).changed_by, {user_id: manager, api_key_id: bridgeKey.id});
    assert.equal((await events('deal.updated')).length, 0, 'creating with contacts and fields sends no deal.updated');

    await call('/v1/deals', {key: bridge, method: 'POST', body, status: 409});
    await call('/v1/deals', {key: bridge, method: 'POST', body: {...body, id: 60000000}, status: 400});
    await call('/v1/deals', {key: bridge, method: 'POST', body: {...body, id: 36000002, author_id: 999999}, status: 400});
    // Other keys: id and times are ignored, robots work as before, the sequence was not moved.
    const native = await call('/v1/deals', {key: portal, method: 'POST', body: {...body, id: 36000003, contact_ids: [], custom_fields: {}}, status: 201});
    assert.equal(native.id, 50000001);
    assert.notEqual(native.created_at, '2025-11-23 09:00:00');
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM tasks WHERE deal_id=?').get(native.id)).n, 1);
    assert.ok(await db.prepare('SELECT 1 FROM deal_distribution_queue WHERE deal_id=?').get(native.id));

    // Stage changes: the bridge skips the rules and the loss reason, starts no stage task.
    await call(`/v1/deals/${deal.id}/stage`, {key: portal, method: 'PATCH', body: {stage_id: third.id}, status: 403});
    await call(`/v1/deals/${deal.id}/stage`, {key: bridge, method: 'PATCH', body: {stage_id: third.id, author_id: manager}});
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM tasks WHERE deal_id=?').get(deal.id)).n, 0);
    await call(`/v1/deals/${deal.id}`, {key: bridge, method: 'PATCH', body: {stage_id: lost.id, author_id: manager}});
    await call(`/v1/deals/${deal.id}/stage`, {key: bridge, method: 'PATCH', body: {stage_id: otherStage}});
    assert.equal((await call(`/v1/deals/${deal.id}`, {key: bridge})).pipeline_id, other.id, 'the bridge moves deals between pipelines');
    const history = (await call(`/v1/stage-changes?deal_id=${deal.id}`, {key: bridge})).items;
    assert.deepEqual(history.map(item => item.changed_by), [
      {type: 'user', id: manager, api_key_id: bridgeKey.id}, {type: 'user', id: manager, api_key_id: bridgeKey.id},
      {type: 'user', id: manager, api_key_id: bridgeKey.id}, {type: 'api_key', id: bridgeKey.id}]);
    assert.deepEqual((await events('deal.stage_changed')).at(-1).changed_by, {user_id: null, api_key_id: bridgeKey.id});
    assert.ok((await db.prepare("SELECT user_id FROM activity WHERE deal_id=? AND event LIKE 'Этап изменён%' ORDER BY id LIMIT 1").get(deal.id)).user_id === manager);

    // updated_at and deal.updated follow custom fields and the list of deal contacts.
    const stamp = async () => (await db.prepare('SELECT updated_at FROM deals WHERE id=?').get(native.id)).updated_at;
    const reset = () => db.prepare("UPDATE deals SET updated_at='2020-01-01 00:00:00' WHERE id=?").run(native.id);
    await reset();
    await call(`/v1/deals/${native.id}`, {key: portal, method: 'PATCH', body: {custom_fields: {[field.id]: 'Реклама'}}});
    assert.notEqual(await stamp(), '2020-01-01 00:00:00', 'a custom field moves updated_at');
    await reset();
    const before = (await events('deal.updated')).length;
    await call(`/v1/deals/${native.id}/contacts`, {key: portal, method: 'POST', body: {contact_id: contact.id}, status: 201});
    assert.notEqual(await stamp(), '2020-01-01 00:00:00', 'adding a contact moves updated_at');
    assert.equal((await events('deal.updated')).length, before + 1, 'one deal.updated for the change');
    await reset();
    await call(`/v1/deals/${native.id}/contacts/${contact.id}`, {key: portal, method: 'DELETE'});
    assert.notEqual(await stamp(), '2020-01-01 00:00:00', 'removing a contact moves updated_at');
    await db.prepare("UPDATE contacts SET updated_at='2020-01-01 00:00:00' WHERE id=?").run(contact.id);
    await call('/custom-fields', {method: 'POST', body: {entity_type: 'contact', name: 'Город', field_type: 'text'}, status: 201}).then(city => call(`/v1/contacts/${contact.id}`, {key: portal, method: 'PATCH', body: {custom_fields: {[city.id]: 'Москва'}}}));
    assert.notEqual((await db.prepare('SELECT updated_at FROM contacts WHERE id=?').get(contact.id)).updated_at, '2020-01-01 00:00:00');

    // Tasks: amoCRM number, created done; completing moves updated_at.
    const done = await call('/v1/tasks', {key: bridge, method: 'POST', body: {id: 26000001, title: 'Позвонить', deal_id: native.id, owner_id: manager, completed: true, result: 'Дозвонился', completed_at: 1763820000, created_at: 1763810000, author_id: manager}, status: 201});
    assert.deepEqual([done.id, done.completed, done.completion_result, done.completed_at], [26000001, true, 'Дозвонился', '2025-11-22T14:00:00.000Z']);
    assert.equal(Number((await db.prepare('SELECT completed_by FROM tasks WHERE id=?').get(done.id)).completed_by), manager);
    const open = await call('/v1/tasks', {key: bridge, method: 'POST', body: {id: 26000002, title: 'Написать', deal_id: native.id, owner_id: manager, updated_at: '2025-11-22 10:00:00'}, status: 201});
    assert.equal(open.updated_at, '2025-11-22 10:00:00');
    const closed = await call(`/v1/tasks/${open.id}`, {key: bridge, method: 'PATCH', body: {completed: true, result: 'Готово', author_id: manager}});
    assert.notEqual(closed.updated_at, '2025-11-22 10:00:00', 'completing a task moves updated_at');
    assert.equal(Number((await db.prepare('SELECT completed_by FROM tasks WHERE id=?').get(open.id)).completed_by), manager, 'completed by the author');

    // Notes: amoCRM number, type and time; note.updated and note.deleted.
    const call_in = await call(`/v1/deals/${native.id}/notes`, {key: bridge, method: 'POST', body: {id: 117000001, body: 'Входящий звонок', note_type: 'call_in', created_at: 1763810000, author_id: manager}, status: 201});
    assert.deepEqual([call_in.id, call_in.note_type, call_in.user_id, call_in.created_at], [117000001, 'call_in', manager, '2025-11-22 11:13:20']);
    const contactNote = await call(`/v1/contacts/${contact.id}/notes`, {key: bridge, method: 'POST', body: {id: 117000002, body: 'Заметка', created_at: 1763810000}, status: 201});
    assert.equal(contactNote.id, 117000002);
    await call(`/v1/deals/${native.id}/notes`, {key: bridge, method: 'POST', body: {id: 117000001, body: 'Повтор'}, status: 409});
    const plain = await call(`/v1/deals/${native.id}/notes`, {key: portal, method: 'POST', body: {id: 117000003, body: 'Обычная', note_type: 'call_in'}, status: 201});
    assert.deepEqual([plain.id > 500000000, plain.note_type], [true, 'common']);
    await call(`/v1/deals/${native.id}/notes/${call_in.id}`, {key: portal, method: 'PATCH', body: {pinned: true}});
    await db.prepare('DELETE FROM entity_notes WHERE id=?').run(contactNote.id);
    assert.deepEqual((await events('note.updated')).map(item => [item.id, item.pinned]), [[call_in.id, true]]);
    assert.deepEqual((await events('note.deleted')).map(item => [item.id, item.entity_type, item.entity_id]), [[contactNote.id, 'contact', contact.id]]);
    assert.deepEqual((await events('note.created')).find(item => item.id === call_in.id).changed_by, {user_id: manager, api_key_id: bridgeKey.id});

    // The amoCRM sync status and log are readable with a key (the sync itself is off here).
    const status = await call('/v1/sync/status', {key: portal});
    assert.deepEqual([status.mode, status.errors_last_hour, status.writes_to_amo], ['off', 0, false]);
    assert.deepEqual((await call('/v1/sync/log', {key: portal})).items, []);
    assert.equal((await call('/sync/status')).mode, 'off');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await db.close();
    rmSync(directory, {recursive: true, force: true});
  }
});
