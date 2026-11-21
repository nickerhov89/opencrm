import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import http from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('API v1: deals, contacts, companies, tasks, notes, fields, pipelines and stage rules', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opencrm-api-v1-'));
  process.env.PGLITE_DIR = join(directory, 'pg');
  process.env.UPLOAD_DIR = join(directory, 'uploads');
  process.env.NODE_ENV = 'test';
  process.env.OPENCRM_ALLOW_LOCAL_WEBHOOKS = '1';
  const {app, db} = await import('../server/index.js');
  const {processWebhookQueue} = await import('../server/integrations.js');
  const received = [];
  const receiver = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    received.push(JSON.parse(body));
    res.writeHead(204).end();
  });
  const server = app.listen(0, '127.0.0.1');
  receiver.listen(0, '127.0.0.1');
  await Promise.all([new Promise(resolve => server.once('listening', resolve)), new Promise(resolve => receiver.once('listening', resolve))]);
  const base = `http://127.0.0.1:${server.address().port}/api`;
  let cookie = '';
  async function call(path, {method = 'GET', body, status = 200, key, headers = {}} = {}) {
    const response = await fetch(base + path, {method, headers: {'Content-Type': 'application/json', ...(key ? {Authorization: `Bearer ${key}`} : cookie ? {Cookie: cookie} : {}), ...headers}, body: body == null ? undefined : JSON.stringify(body)});
    const text = await response.text();
    assert.equal(response.status, status, `${method} ${path}: ${text}`);
    if (!key && response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return text ? JSON.parse(text) : null;
  }
  try {
    await call('/setup', {method: 'POST', body: {name: 'Admin', email: 'admin@example.test', password: 'test-password-123'}});
    const all = ['deals:read', 'deals:write', 'contacts:read', 'contacts:write', 'companies:read', 'companies:write', 'tasks:read', 'tasks:write', 'users:read', 'pipelines:write', 'fields:write'];
    const portalKey = await call('/integrations/keys', {method: 'POST', body: {name: 'Portal', scopes: all}, status: 201}), key = portalKey.token;
    const readOnly = (await call('/integrations/keys', {method: 'POST', body: {name: 'Reader', scopes: ['deals:read']}, status: 201})).token;
    await call('/integrations/keys', {method: 'POST', body: {name: 'Bad', scopes: ['everything']}, status: 400});
    await call('/integrations/webhooks', {method: 'POST', body: {name: 'Portal hook', url: `http://127.0.0.1:${receiver.address().port}/hook`, events: ['deal.updated', 'deal.deleted', 'contact.created', 'contact.updated', 'company.created', 'task.created', 'task.completed', 'note.created']}, status: 201});

    const me = await call('/v1/me', {key: readOnly});
    assert.equal(me.key.name, 'Reader');
    assert.deepEqual(me.key.scopes, ['deals:read']);
    const users = await call('/v1/users', {key});
    assert.equal(users.items[0].email, 'admin@example.test');
    assert.equal(users.items[0].active, true);
    const owner = users.items[0].id;
    await call('/v1/users', {key: readOnly, status: 403});
    await call('/v1/nothing-here', {key, status: 404});

    // Pipelines and stages
    const pipeline = await call('/v1/pipelines', {key, method: 'POST', body: {name: 'Portal sales', stages: [{name: 'New'}, {name: 'Qualified', color: '#bcd3f6'}, {name: 'Won', kind: 'won'}]}, status: 201});
    assert.deepEqual(pipeline.stages.map(stage => [stage.name, stage.kind]), [['New', 'active'], ['Qualified', 'active'], ['Won', 'won'], ['Закрыто и не реализовано', 'lost']]);
    const added = await call(`/v1/pipelines/${pipeline.id}/stages`, {key, method: 'POST', body: {name: 'Proposal', position: 1}, status: 201});
    const [newStage, proposal, qualified, won, lost] = (await call(`/v1/pipelines/${pipeline.id}`, {key})).stages;
    assert.equal(proposal.id, added.id);
    assert.equal(qualified.name, 'Qualified');
    await call(`/v1/stages/${proposal.id}`, {key, method: 'PATCH', body: {name: 'Offer'}});
    await call(`/v1/pipelines/${pipeline.id}/stage-order`, {key, method: 'PUT', body: {ids: [newStage.id, qualified.id, proposal.id]}});
    assert.deepEqual((await call(`/v1/pipelines/${pipeline.id}`, {key})).stages.map(stage => stage.name), ['New', 'Qualified', 'Offer', 'Won', 'Закрыто и не реализовано']);
    await call('/v1/pipelines', {key: readOnly, method: 'POST', body: {name: 'No'}, status: 403});
    assert.ok((await call('/v1/pipelines', {key: readOnly})).items.some(item => item.id === pipeline.id));

    // Custom fields
    const budgetField = await call('/v1/custom-fields', {key, method: 'POST', body: {entity_type: 'deal', name: 'Portal ID', field_type: 'number'}, status: 201});
    const segment = await call('/v1/custom-fields', {key, method: 'POST', body: {entity_type: 'contact', name: 'Segment', field_type: 'select', options: ['A', 'B']}, status: 201});
    await call('/v1/custom-fields', {key, method: 'POST', body: {entity_type: 'deal', name: 'portal id', field_type: 'text'}, status: 409});
    await call(`/v1/custom-fields/${segment.id}`, {key, method: 'PATCH', body: {options: ['A', 'B', 'C']}});
    assert.deepEqual((await call('/v1/custom-fields?entity_type=contact', {key})).items[0].options, ['A', 'B', 'C']);
    assert.deepEqual((await call('/v1/custom-fields', {key: readOnly})).items.map(item => item.entity_type), ['deal']);
    await call('/v1/custom-fields?entity_type=contact', {key: readOnly, status: 403});

    // Companies and contacts
    const company = await call('/v1/companies', {key, method: 'POST', body: {name: 'Example LLC', phone: '+7 (900) 111-22-33', tags: ['vip', 'portal', 'VIP'], owner_id: owner}, status: 201});
    assert.equal(company.tags, 'vip, portal');
    const contactBody = {name: 'Synthetic Person', company_id: company.id, phone: '+7 900 555-44-33', email: 'Person@Example.test', telegram: '@Synthetic_TG', custom_fields: {[segment.id]: 'B'}};
    const contact = await call('/v1/contacts', {key, method: 'POST', body: contactBody, status: 201, headers: {'Idempotency-Key': 'contact-1'}});
    assert.equal(contact.custom_fields[0].value, 'B');
    assert.equal((await call('/v1/contacts', {key, method: 'POST', body: contactBody, headers: {'Idempotency-Key': 'contact-1'}})).id, contact.id);
    await call('/v1/contacts', {key, method: 'POST', body: {...contactBody, name: 'Other'}, status: 409, headers: {'Idempotency-Key': 'contact-1'}});
    await call('/v1/contacts', {key, method: 'POST', body: {name: 'Bad', custom_fields: {[segment.id]: 'Z'}}, status: 400});
    await call('/v1/contacts', {key, method: 'POST', body: {name: 'Bad', company_id: 999999}, status: 400});
    assert.equal((await call('/v1/contacts?phone=8%20900%20555%2044%2033', {key})).items[0].id, contact.id);
    assert.equal((await call('/v1/contacts?email=person@example.test', {key})).items[0].id, contact.id);
    assert.equal((await call(`/v1/contacts?company_id=${company.id}`, {key})).items.length, 1);
    const updatedContact = await call(`/v1/contacts/${contact.id}`, {key, method: 'PATCH', body: {position: 'CTO', owner_id: owner}});
    assert.equal(updatedContact.position, 'CTO');
    assert.equal(updatedContact.email, 'Person@Example.test');
    const contactNote = await call(`/v1/contacts/${contact.id}/notes`, {key, method: 'POST', body: {body: 'Called from the portal', user_id: owner}, status: 201});
    assert.equal((await call(`/v1/contacts/${contact.id}/notes`, {key})).items[0].id, contactNote.id);
    await call(`/v1/contacts/${contact.id}`, {key: readOnly, status: 403});
    const second = await call('/v1/contacts', {key, method: 'POST', body: {name: 'Second Person'}, status: 201});

    // Deals
    const deal = await call('/v1/deals', {key, method: 'POST', body: {name: 'Portal deal', pipeline_id: pipeline.id, amount: 15000, owner_id: owner, contact_ids: [contact.id, second.id], company_id: company.id, source: 'Portal', custom_fields: [{id: budgetField.id, value: 42}]}, status: 201, headers: {'Idempotency-Key': 'deal-1'}});
    assert.equal(deal.stage_id, newStage.id);
    assert.deepEqual(deal.contact_ids, [contact.id, second.id]);
    assert.equal(deal.contact_id, contact.id);
    assert.equal(deal.custom_fields[0].value, '42');
    assert.equal((await call('/v1/deals', {key, method: 'POST', body: {name: 'Portal deal', pipeline_id: pipeline.id, amount: 15000, owner_id: owner, contact_ids: [contact.id, second.id], company_id: company.id, source: 'Portal', custom_fields: [{id: budgetField.id, value: 42}]}, headers: {'Idempotency-Key': 'deal-1'}})).id, deal.id);
    await call('/v1/deals', {key, method: 'POST', body: {name: 'No stage'}, status: 400});
    await call('/v1/deals', {key, method: 'POST', body: {name: 'Bad custom', pipeline_id: pipeline.id, custom_fields: {[budgetField.id]: 'abc'}}, status: 400});
    const listed = await call(`/v1/deals?pipeline_id=${pipeline.id}&contact_id=${second.id}&limit=1`, {key: readOnly});
    assert.equal(listed.items[0].id, deal.id);
    assert.equal(listed.next_after, null);
    const moved = await call(`/v1/deals/${deal.id}`, {key, method: 'PATCH', body: {stage_id: qualified.id, amount: 20000, contact_ids: [second.id], tags: 'hot'}});
    assert.equal(moved.stage_id, qualified.id);
    assert.equal(moved.contact_id, second.id);
    assert.deepEqual(moved.contact_ids, [second.id]);
    await call(`/v1/deals/${deal.id}/contacts`, {key, method: 'POST', body: {contact_id: contact.id, main: true}, status: 201});
    assert.deepEqual((await call(`/v1/deals/${deal.id}`, {key})).contact_ids, [contact.id, second.id]);
    await call(`/v1/deals/${deal.id}/contacts/${second.id}`, {key, method: 'DELETE'});
    const note = await call(`/v1/deals/${deal.id}/notes`, {key, method: 'POST', body: {body: 'Synced from portal', pinned: true}, status: 201});
    assert.equal(note.pinned, true);
    await call(`/v1/deals/${deal.id}/notes/${note.id}`, {key, method: 'PATCH', body: {pinned: false}});
    assert.equal((await call(`/v1/deals/${deal.id}/notes`, {key: readOnly})).items[0].pinned, false);
    await call(`/v1/deals/${deal.id}/communications`, {key, method: 'POST', body: {kind: 'call', direction: 'outgoing', body: 'Discussed the offer'}, status: 201});
    assert.equal((await call(`/v1/deals/${deal.id}/communications`, {key})).items.length, 1);
    const history = (await call(`/v1/deals/${deal.id}/activity`, {key})).items.map(item => item.event);
    assert.ok(history.some(line => line.startsWith('Сделка создана через API («Portal»)')));
    assert.ok(history.some(line => line.startsWith('Этап изменён: Qualified')));

    // Tasks attached to the deal
    const longText = 'Описание задачи из портала. '.repeat(140).trim();
    const task = await call('/v1/tasks', {key, method: 'POST', body: {title: 'Call the client', description: longText, deal_id: deal.id, due_at: '2026-12-01T09:00:00Z', duration_minutes: 30}, status: 201});
    assert.equal(task.description, longText);
    await call('/v1/tasks', {key, method: 'POST', body: {title: 'x'.repeat(501), deal_id: deal.id}, status: 400});
    assert.equal((await call(`/v1/tasks/${task.id}`, {key, method: 'PATCH', body: {description: 'Short'}})).description, 'Short');
    const cookies = await call('/v1/custom-fields', {key, method: 'POST', body: {entity_type: 'deal', name: 'COOKIES', field_type: 'text'}, status: 201});
    const cookieValue = 'c'.repeat(1075);
    assert.equal((await call(`/v1/deals/${deal.id}`, {key, method: 'PATCH', body: {custom_fields: {[cookies.id]: cookieValue}}})).custom_fields.find(field => field.id === cookies.id).value, cookieValue);
    await call(`/custom-fields/${cookies.id}/values/${deal.id}`, {method: 'PUT', body: {value: cookieValue + 'd'}});
    await call(`/v1/deals/${deal.id}`, {key, method: 'PATCH', body: {custom_fields: {[cookies.id]: 'c'.repeat(5001)}}, status: 400});
    assert.equal(task.owner_id, owner, 'owner defaults to the deal owner');
    assert.equal(task.due_at, '2026-12-01T09:00:00.000Z');
    await call('/v1/tasks', {key, method: 'POST', body: {title: 'Bad', company_id: company.id, deal_id: deal.id}, status: 400});
    await call('/v1/tasks', {key, method: 'POST', body: {title: 'Nobody', contact_id: second.id}, status: 400});
    assert.equal((await call(`/v1/tasks?deal_id=${deal.id}&state=open`, {key})).items.length, 1);
    const done = await call(`/v1/tasks/${task.id}`, {key, method: 'PATCH', body: {completed: true, result: 'Agreed on a meeting'}});
    assert.equal(done.completed, true);
    assert.equal((await call(`/v1/tasks?deal_id=${deal.id}&state=open`, {key})).items.length, 0);
    assert.equal((await call(`/v1/tasks?deal_id=${deal.id}&state=done`, {key})).items[0].completion_result, 'Agreed on a meeting');
    const companyTask = await call('/v1/tasks', {key, method: 'POST', body: {title: 'Company task', company_id: company.id, all_day: true, due_at: '2026-12-02'}, status: 201});
    assert.equal(companyTask.all_day, true);
    await call(`/v1/tasks/${companyTask.id}`, {key, method: 'DELETE'});
    await call(`/v1/tasks/${companyTask.id}`, {key, status: 404});

    // Sync by updated_at
    const since = (await db.prepare('SELECT now_text() now').get()).now;
    await db.prepare("UPDATE contacts SET updated_at='2000-01-01 00:00:00'").run();
    await db.prepare("UPDATE contacts SET created_at='2000-01-01 00:00:00'").run();
    assert.ok((await call(`/v1/contacts?updated_since=${encodeURIComponent(since)}`, {key})).items.length >= 1, 'any update refreshes updated_at');

    // Stage transition rules
    await call(`/v1/pipelines/${pipeline.id}/transitions`, {key, method: 'PUT', body: {mode: 'restricted', lock_deals: true, transitions: {[newStage.id]: [qualified.id], [qualified.id]: [proposal.id, lost.id], [proposal.id]: [won.id, lost.id]}}});
    const rules = await call(`/v1/pipelines/${pipeline.id}/transitions`, {key: readOnly});
    assert.equal(rules.mode, 'restricted');
    assert.equal(rules.lock_deals, true);
    assert.equal(rules.transitions.length, 5);
    assert.deepEqual((await call(`/v1/deals/${deal.id}/allowed-stages`, {key})).stage_ids.sort(), [proposal.id, lost.id].sort());
    const blocked = await call(`/v1/deals/${deal.id}`, {key, method: 'PATCH', body: {stage_id: won.id}, status: 403});
    assert.match(blocked.error, /запрещён правилами/);
    await call(`/v1/deals/${deal.id}/stage`, {key, method: 'PATCH', body: {stage_id: newStage.id}, status: 403});
    const defaultPipeline = (await call('/v1/pipelines', {key})).items.find(item => item.id !== pipeline.id);
    await call(`/v1/deals/${deal.id}`, {key, method: 'PATCH', body: {pipeline_id: defaultPipeline.id}, status: 403});
    await call(`/v1/deals/${deal.id}`, {key, method: 'PATCH', body: {stage_id: proposal.id}});
    await call(`/v1/pipelines/${pipeline.id}/transitions`, {key, method: 'PUT', body: {transitions: [{from_stage_id: newStage.id, to_stage_id: defaultPipeline.stages[0].id}]}, status: 400});

    // Rules also bind employees in the web interface, administrators are exempt.
    await call('/users', {method: 'POST', body: {name: 'Member', email: 'member@example.test', password: 'member-password-123', role: 'member'}, status: 201});
    await call(`/deals/${deal.id}`, {method: 'PATCH', body: {stage_id: newStage.id}});
    await call(`/deals/${deal.id}`, {method: 'PATCH', body: {stage_id: qualified.id}});
    assert.equal((await call(`/pipelines/${pipeline.id}/transitions`)).mode, 'restricted');
    await call('/login', {method: 'POST', body: {email: 'member@example.test', password: 'member-password-123'}});
    const memberBlocked = await call(`/deals/${deal.id}`, {method: 'PATCH', body: {stage_id: won.id}, status: 403});
    assert.match(memberBlocked.error, /запрещён правилами/);
    await call('/deals/bulk', {method: 'POST', body: {ids: [deal.id], action: 'stage', stage_id: newStage.id}, status: 403});
    await call(`/deals/${deal.id}`, {method: 'PATCH', body: {stage_id: proposal.id}});
    assert.deepEqual((await call(`/deals/${deal.id}/allowed-stages`)).stage_ids.sort(), [won.id, lost.id].sort());
    await call(`/pipelines/${pipeline.id}/transitions`, {method: 'PUT', body: {mode: 'any'}, status: 403});
    await call('/login', {method: 'POST', body: {email: 'admin@example.test', password: 'test-password-123'}});
    // With rules_for_admins the administrator is bound too; the error lists where the deal may go.
    assert.equal((await call(`/pipelines/${pipeline.id}/transitions`, {method: 'PUT', body: {rules_for_admins: true}})).rules_for_admins, true);
    const adminBlocked = await call(`/deals/${deal.id}`, {method: 'PATCH', body: {stage_id: newStage.id}, status: 403});
    assert.match(adminBlocked.error, new RegExp(`можно перейти в: «${won.name}», «${lost.name}»`));
    await call('/deals/bulk', {method: 'POST', body: {ids: [deal.id], action: 'stage', stage_id: newStage.id}, status: 403});
    assert.deepEqual((await call(`/deals/${deal.id}/allowed-stages`)).stage_ids.sort(), [won.id, lost.id].sort());
    await call(`/pipelines/${pipeline.id}/transitions`, {method: 'PUT', body: {rules_for_admins: false}});
    await call(`/deals/${deal.id}`, {method: 'PATCH', body: {stage_id: qualified.id}});
    await call(`/deals/${deal.id}`, {method: 'PATCH', body: {stage_id: proposal.id}});
    await call(`/pipelines/${pipeline.id}/transitions`, {method: 'PUT', body: {mode: 'any', lock_deals: false}});
    await call(`/v1/deals/${deal.id}`, {key, method: 'PATCH', body: {pipeline_id: defaultPipeline.id}});

    // Stage history with the actor, closed_at
    const defaultWon = defaultPipeline.stages.find(stage => stage.kind === 'won'), defaultFirst = defaultPipeline.stages[0];
    const closed = await call(`/v1/deals/${deal.id}`, {key, method: 'PATCH', body: {stage_id: defaultWon.id}});
    assert.match(closed.closed_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.equal((await call(`/v1/deals?closed_since=2000-01-01&pipeline_id=${defaultPipeline.id}`, {key})).items[0].id, deal.id);
    assert.equal((await call(`/v1/deals/${deal.id}`, {key, method: 'PATCH', body: {stage_id: defaultFirst.id}})).closed_at, null);
    const changes = (await call(`/v1/stage-changes?deal_id=${deal.id}&limit=250`, {key: readOnly})).items;
    assert.equal(changes[0].from_stage_id, null);
    assert.equal(changes[0].to_stage_id, newStage.id);
    assert.deepEqual(changes[0].changed_by, {type: 'api_key', id: portalKey.id});
    const byAdmin = changes.find(change => change.to_stage_id === qualified.id && change.user_id);
    assert.deepEqual(byAdmin.changed_by.type, 'user');
    assert.deepEqual(changes.slice(-2).map(change => [change.from_stage_id, change.to_stage_id]), [[defaultFirst.id, defaultWon.id], [defaultWon.id, defaultFirst.id]]);
    assert.equal(new Set(changes.map(change => change.id)).size, changes.length);
    assert.ok((await call(`/v1/stage-changes?pipeline_id=${pipeline.id}`, {key})).items.length >= 5);

    // Notes of all deals, Telegram and custom field lookups, task types
    const allNotes = await call('/v1/notes?entity_type=deal', {key});
    assert.equal(allNotes.items[0].entity_id, deal.id);
    assert.ok(allNotes.items[0].updated_at);
    assert.equal((await call('/v1/notes?entity_type=contact', {key})).items[0].id, contactNote.id);
    await call('/v1/notes?entity_type=contact', {key: readOnly, status: 403});
    await call('/v1/notes', {key, status: 400});
    assert.equal((await call('/v1/contacts?telegram=https%3A%2F%2Ft.me%2Fsynthetic_tg', {key})).items[0].id, contact.id);
    assert.equal((await call('/v1/contacts?telegram=other', {key})).items.length, 0);
    assert.equal((await call(`/v1/contacts?custom_field%5B${segment.id}%5D=b`, {key})).items[0].id, contact.id);
    assert.equal((await call(`/v1/deals?custom_field%5B${budgetField.id}%5D=42&include_deleted=1`, {key})).items[0].id, deal.id);
    await call(`/v1/contacts?custom_field%5B${budgetField.id}%5D=42`, {key, status: 400});
    assert.ok((await call('/v1/task-types', {key})).items.includes('Встреча'));

    // Deleting moves records to the trash and fires webhooks
    await call(`/v1/deals/${deal.id}`, {key, method: 'DELETE'});
    await call(`/v1/deals/${deal.id}`, {key, status: 404});
    await call(`/v1/contacts/${second.id}`, {key, method: 'DELETE'});
    await call(`/v1/contacts/${second.id}`, {key, status: 404});
    assert.equal((await call(`/v1/deals?pipeline_id=${defaultPipeline.id}`, {key})).items.some(item => item.id === deal.id), false);
    const trashed = (await call(`/v1/deals?deleted_since=2000-01-01`, {key})).items;
    assert.deepEqual(trashed.map(item => item.id), [deal.id]);
    assert.ok(trashed[0].deleted_at);
    assert.ok((await call('/v1/deals?include_deleted=1', {key})).items.some(item => item.id === deal.id));
    assert.ok((await call('/v1/contacts?deleted_since=2000-01-01', {key})).items.some(item => item.id === second.id));
    assert.ok((await call('/v1/tasks?deleted_since=2000-01-01', {key})).items.some(item => item.id === companyTask.id));
    assert.equal((await call(`/v1/tasks?deal_id=${deal.id}`, {key})).items.length, 0, 'tasks of a trashed deal are hidden');
    while (await processWebhookQueue(db, 100));
    const types = new Set(received.map(item => item.type));
    for (const type of ['deal.updated', 'deal.deleted', 'contact.created', 'contact.updated', 'company.created', 'task.created', 'task.completed', 'note.created']) assert.ok(types.has(type), `webhook ${type}`);
    assert.equal(received.find(item => item.type === 'deal.deleted').data.id, deal.id);
    assert.deepEqual(received.find(item => item.type === 'deal.deleted').data.changed_by, {user_id: null, api_key_id: portalKey.id});
    assert.equal((await db.prepare("SELECT COUNT(*) n FROM webhook_events WHERE event_type='contact.deleted'").get()).n, 0, 'events nobody subscribed to are not stored');
  } finally {
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => receiver.close(resolve))]);
    await db.close();
    rmSync(directory, {recursive: true, force: true});
    delete process.env.OPENCRM_ALLOW_LOCAL_WEBHOOKS;
  }
});
