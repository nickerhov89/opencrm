import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('distribution: new deals from the API go to managers in turn, with the robot task after it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opencrm-distribution-'));
  process.env.PGLITE_DIR = join(dir, 'pg');
  process.env.UPLOAD_DIR = join(dir, 'uploads');
  process.env.NODE_ENV = 'test';
  const {app, db} = await import('../server/index.js');
  const {processDistributionQueue} = await import('../server/distribution.js');
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (path, {method = 'GET', body, status = 200, key} = {}) => {
    const response = await fetch(base + path, {method, headers: {'Content-Type': 'application/json', ...(key ? {Authorization: `Bearer ${key}`} : {Cookie: cookie})}, body: body ? JSON.stringify(body) : undefined});
    const text = await response.text();
    assert.equal(response.status, status, `${method} ${path}: ${text}`);
    if (!key && response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return text ? JSON.parse(text) : null;
  };
  const run = () => processDistributionQueue(db, {delay: 0});
  try {
    await call('/api/setup', {method: 'POST', body: {name: 'Сальнов', email: 'admin@agency.test', password: 'passphrase-for-tests'}});
    const admin = (await db.prepare("SELECT id FROM users WHERE email='admin@agency.test'").get()).id;
    const user = async name => (await call('/api/users', {method: 'POST', body: {name, email: `${name.toLowerCase()}@agency.test`, password: 'member-password', role: 'member'}, status: 201})).id
      ?? (await db.prepare('SELECT id FROM users WHERE name=?').get(name)).id;
    const mironova = Number(await user('Миронова')), lebedev = Number(await user('Лебедев'));
    const pipeline = (await db.prepare('SELECT id FROM pipelines ORDER BY id LIMIT 1').get()).id;
    const field = await call('/api/custom-fields', {method: 'POST', body: {entity_type: 'deal', name: 'Источник', field_type: 'select', options: ['Автоаутрич', 'SEO']}, status: 201});
    const key = (await call('/api/integrations/keys', {method: 'POST', body: {name: 'Портал', scopes: ['deals:write', 'deals:read', 'contacts:write']}, status: 201})).token;

    // Rules: Автоаутрич → Миронова and Лебедев in turn; everything else in the pipeline → all three.
    await call('/api/distribution/rules', {method: 'POST', body: {name: 'Пустое', user_ids: []}, status: 400});
    const auto = await call('/api/distribution/rules', {method: 'POST', body: {name: 'Автоаутрич', pipeline_id: pipeline, sources: ['Автоаутрич'], user_ids: [mironova, lebedev], task_title: 'Взять в работу', task_type: 'Связаться', active: true, sort_order: 1}, status: 201});
    const rest = await call('/api/distribution/rules', {method: 'POST', body: {name: 'Первичка', pipeline_id: pipeline, user_ids: [Number(admin), mironova, lebedev], task_title: 'Взять в работу', active: true, sort_order: 2}, status: 201});
    assert.deepEqual(auto.origins, ['api']);
    assert.deepEqual(auto.users, ['Миронова', 'Лебедев']);

    const create = async (name, source) => {
      const contact = (await call('/api/v1/contacts', {method: 'POST', key, body: {name: `Контакт ${name}`, owner_id: Number(admin)}, status: 201})).id;
      return (await call('/api/v1/deals', {method: 'POST', key, body: {name, pipeline_id: pipeline, owner_id: Number(admin), contact_id: contact, custom_fields: source ? {[field.id]: source} : {}}, status: 201})).id;
    };
    const owners = async ids => Promise.all(ids.map(async id => Number((await db.prepare('SELECT owner_id FROM deals WHERE id=?').get(id)).owner_id)));
    const a = [await create('A1', 'Автоаутрич'), await create('A2', 'Автоаутрич'), await create('A3', 'Автоаутрич')];
    const s = [await create('S1', 'SEO'), await create('S2', ''), await create('S3', 'SEO'), await create('S4', 'SEO')];
    assert.equal(await run(), 7);
    assert.deepEqual(await owners(a), [mironova, lebedev, mironova]);
    assert.deepEqual(await owners(s), [Number(admin), mironova, lebedev, Number(admin)]);

    // The contact, the open tasks and the robot task go to the chosen manager; the feed says so.
    const deal = await call(`/api/deals/${a[1]}`);
    assert.equal(Number((await db.prepare('SELECT owner_id FROM contacts WHERE id=?').get(deal.contact_id)).owner_id), lebedev);
    const robot = deal.tasks.filter(task => task.title === 'Взять в работу');
    assert.equal(robot.length, 1);
    assert.equal(Number(robot[0].owner_id), lebedev);
    assert.equal(robot[0].task_type, 'Связаться');
    assert.ok(deal.tasks.every(task => Number(task.owner_id) === lebedev), 'stage automation tasks follow the deal');
    assert.ok(deal.activity.some(item => item.event === 'Распределение сделок («Автоаутрич»): ответственный — Лебедев'));

    // Deals created by an employee stay with the chosen owner; so do deals loaded with an old date.
    const manual = (await call('/api/deals/quick', {method: 'POST', body: {name: 'Своя', stage_id: deal.stage_id, owner_id: Number(admin)}, status: 201})).id;
    const old = (await db.prepare("INSERT INTO deals (name,stage_id,owner_id,created_at) VALUES ('Из amo',?,?,'2025-01-01 10:00:00')").run(deal.stage_id, admin)).lastInsertRowid;
    await db.prepare("INSERT INTO deal_distribution_queue (deal_id,origin,queued_at) VALUES (?,'api',0)").run(old);
    assert.equal(await run(), 0);
    assert.deepEqual(await owners([manual, old]), [Number(admin), Number(admin)]);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM deal_distribution_queue').get()).n, 0);

    // Conditions on another field: «Автоаутрич EN» to one manager, any other Автоаутрич to another.
    const sub = await call('/api/custom-fields', {method: 'POST', body: {entity_type: 'deal', name: 'Подысточник', field_type: 'text'}, status: 201});
    await call('/api/distribution/rules', {method: 'POST', body: {name: 'EN', pipeline_id: pipeline, sources: ['Автоаутрич'], conditions: [{field_id: 999999, values: ['x']}], user_ids: [mironova], active: true}, status: 400});
    const en = await call('/api/distribution/rules', {method: 'POST', body: {name: 'Автоаутрич EN', pipeline_id: pipeline, sources: ['Автоаутрич'], conditions: [{field_id: sub.id, values: [' автоаутрич en ']}], user_ids: [mironova], task_title: 'Взять в работу', active: true, sort_order: -2}, status: 201});
    assert.deepEqual(en.conditions, [{field_id: sub.id, values: ['автоаутрич en']}]);
    await call(`/api/distribution/rules/${auto.id}`, {method: 'PATCH', body: {user_ids: [Number(admin)], sort_order: -1}});
    const withSub = async (name, value) => {
      const id = (await call('/api/v1/deals', {method: 'POST', key, body: {name, pipeline_id: pipeline, owner_id: lebedev, custom_fields: {[field.id]: 'Автоаутрич', ...(value ? {[sub.id]: value} : {})}}, status: 201})).id;
      return id;
    };
    const english = await withSub('EN', 'Автоаутрич EN'), russian = await withSub('RU', 'Автоаутрич RU'), unknown = await withSub('Без подысточника', '');
    assert.equal(await run(), 3);
    assert.deepEqual(await owners([english, russian, unknown]), [mironova, Number(admin), Number(admin)], 'EN by the condition, the rest by the default Автоаутрич rule');
    await call(`/api/distribution/rules/${en.id}`, {method: 'DELETE'});

    // A switched-off rule is skipped; a disabled employee is skipped in the turn.
    await call(`/api/distribution/rules/${auto.id}`, {method: 'PATCH', body: {active: false}});
    await db.prepare('UPDATE users SET disabled_at=now_text() WHERE id=?').run(mironova);
    const next = await create('A4', 'Автоаутрич');
    assert.equal(await run(), 1);
    assert.notEqual((await owners([next]))[0], mironova);
    const list = await call('/api/distribution/rules');
    assert.equal(list.find(item => item.id === rest.id).assigned, 5);
    await call(`/api/distribution/rules/${rest.id}`, {method: 'DELETE'});
    assert.ok(await db.prepare("SELECT 1 FROM audit_log WHERE action='distribution.rule_deleted'").get());
  } finally {
    server.close();
    await db.close?.();
    rmSync(dir, {recursive: true, force: true});
  }
});
