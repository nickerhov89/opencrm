import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('reports: calls by employee, monthly goals, letter templates', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opencrm-reports-'));
  process.env.PGLITE_DIR = join(dir, 'pg');
  process.env.UPLOAD_DIR = join(dir, 'uploads');
  process.env.NODE_ENV = 'test';
  const {app, db} = await import('../server/index.js');
  const {noteSeconds} = await import('../server/reports.js');
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (path, {method = 'GET', body, status = 200} = {}) => {
    const response = await fetch(base + path, {method, headers: {'Content-Type': 'application/json', Cookie: cookie}, body: body ? JSON.stringify(body) : undefined});
    const text = await response.text();
    assert.equal(response.status, status, `${method} ${path}: ${text}`);
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return text ? JSON.parse(text) : null;
  };
  try {
    assert.equal(noteSeconds('Исходящий звонок\nДлительность: 1:05\nРезультат: исходящий'), 65);
    assert.equal(noteSeconds('Длительность: 1:02:03'), 3723);
    assert.equal(noteSeconds('без длительности'), 0);

    await call('/api/setup', {method: 'POST', body: {name: 'Админ', email: 'admin@agency.test', password: 'passphrase-for-tests'}});
    const admin = Number((await db.prepare("SELECT id FROM users WHERE email='admin@agency.test'").get()).id);
    const julia = Number((await call('/api/users', {method: 'POST', body: {name: 'Юлия', email: 'julia@agency.test', password: 'member-password', role: 'member'}, status: 201})).id);
    const stage = (await db.prepare("SELECT id FROM stages WHERE kind='active' ORDER BY id LIMIT 1").get()).id;
    const won = (await db.prepare("SELECT id FROM stages WHERE kind='won' ORDER BY id LIMIT 1").get()).id;
    const deal = (await db.prepare("INSERT INTO deals (name,stage_id,owner_id) VALUES ('Ромашка',?,?)").run(stage, julia)).lastInsertRowid;
    const contact = (await db.prepare("INSERT INTO contacts (name,owner_id) VALUES ('Ольга',?)").run(julia)).lastInsertRowid;

    // Calls loaded from amoCRM (deal and contact notes), one recorded by hand, one from Mango.
    await db.prepare("INSERT INTO notes (deal_id,user_id,body,note_type,created_at) VALUES (?,?,?,'call_out','2026-11-10 09:00:00')").run(deal, julia, 'Исходящий звонок\nТелефон: +7 900\nДлительность: 0:30\nРезультат: исходящий\nЗапись: https://records.example.test/1');
    await db.prepare("INSERT INTO notes (deal_id,user_id,body,note_type,created_at) VALUES (?,?,?,'call_in','2026-11-11 09:00:00')").run(deal, julia, 'Входящий звонок\nДлительность: 2:00');
    await db.prepare("INSERT INTO entity_notes (entity_type,entity_id,user_id,body,note_type,created_at) VALUES ('contact',?,?,?,'call_out','2026-11-12 09:00:00')").run(contact, admin, 'Исходящий звонок\nДлительность: 1:00');
    await db.prepare("INSERT INTO notes (deal_id,user_id,body,note_type,created_at) VALUES (?,NULL,?,'call_in','2025-01-01 09:00:00')").run(deal, 'Вне периода');
    await call(`/api/deals/${deal}/communications`, {method: 'POST', body: {kind: 'call', direction: 'outgoing', body: 'Договорились о встрече'}, status: 201});
    await db.exec(`CREATE TABLE plugin_mango_calls (entry_id TEXT PRIMARY KEY, direction TEXT NOT NULL, number TEXT NOT NULL DEFAULT '', extension TEXT NOT NULL DEFAULT '', line_number TEXT NOT NULL DEFAULT '', user_id BIGINT, answered INTEGER NOT NULL DEFAULT 0, duration INTEGER NOT NULL DEFAULT 0, started_at TEXT NOT NULL, deal_id BIGINT, contact_id BIGINT, company_id BIGINT, lead_id BIGINT, recording_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT now_text())`);
    await db.prepare("INSERT INTO plugin_mango_calls (entry_id,direction,number,user_id,answered,duration,started_at,deal_id,recording_id) VALUES ('e1','incoming','79001112233',?,1,90,'2026-11-13 10:00:00',?,'r1')").run(julia, deal);
    await db.prepare("INSERT INTO deal_communications (deal_id,user_id,kind,direction,subject,body,created_at) VALUES (?,?,'call','incoming','1:30','от +7 900','2026-11-13 10:00:00')").run(deal, julia);
    await db.prepare("INSERT INTO plugin_mango_calls (entry_id,direction,number,answered,started_at) VALUES ('e2','incoming','79005556677',0,'2026-11-14 10:00:00')").run();

    const today = new Date().toISOString().slice(0, 10);
    const report = await call(`/api/reports/calls?from=2026-11-01&to=${today}`);
    const byName = Object.fromEntries(report.people.map(person => [person.name, person]));
    assert.deepEqual([byName['Юлия'].incoming, byName['Юлия'].outgoing, byName['Юлия'].seconds], [2, 1, 30 + 120 + 90], 'amoCRM notes and Mango; the Mango feed row is not counted twice');
    assert.deepEqual([byName['Админ'].incoming, byName['Админ'].outgoing, byName['Админ'].seconds], [0, 2, 60], 'a contact call and a call recorded by hand');
    assert.equal(byName['Без сотрудника'].incoming, 1, 'a missed call nobody answered');
    assert.equal(report.people.at(-1).name, 'Без сотрудника');
    assert.deepEqual(report.total, {incoming: 3, outgoing: 3, seconds: 300});
    assert.deepEqual(report.average, {incoming: 1, outgoing: 1, seconds: 100}, 'over three rows, the one without an employee included');
    assert.equal(report.recent.length, 6);
    assert.equal(report.recent[0].result, '', 'the call recorded today is the latest');
    assert.deepEqual(report.recent.find(row => row.key === 'me2').target, {kind: 'phone', id: null, name: '79005556677'});
    assert.equal(report.recent.find(row => row.key === 'me1').recording, '/api/plugins/mango-office/recording/e1');
    assert.equal(report.recent.find(row => row.target.kind === 'contact').target.name, 'Ольга');
    assert.equal(report.recent.find(row => row.recording.startsWith('https')).seconds, 30);
    const incoming = await call(`/api/reports/calls?from=2026-11-01&to=${today}&direction=incoming`);
    assert.ok(incoming.recent.every(row => row.direction === 'incoming') && incoming.recent.length === 3);
    await call('/api/reports/calls?from=2026-11-10&to=2026-11-01', {status: 400});

    // Goals: progress is won deals closed in the month; zero goals are removed.
    await db.prepare("UPDATE deals SET stage_id=?,amount=150000,closed_at='2026-11-15 12:00:00' WHERE id=?").run(won, deal);
    await db.prepare("INSERT INTO deals (name,stage_id,owner_id,amount,closed_at) VALUES ('Октябрь',?,?,99999,'2026-10-31 23:00:00')").run(won, julia);
    await call('/api/reports/goals', {method: 'PUT', body: {month: '2026-11', goals: [{user_id: julia, amount: 300000, deals: 2}, {user_id: admin, amount: -1}]}, status: 400});
    const goals = await call('/api/reports/goals', {method: 'PUT', body: {month: '2026-11', goals: [{user_id: julia, amount: 300000, deals: 2}, {user_id: admin, amount: 0, deals: 0}]}});
    const juliaGoal = goals.people.find(person => person.user_id === julia);
    assert.deepEqual([juliaGoal.goal_amount, juliaGoal.goal_deals, juliaGoal.won_amount, juliaGoal.won_deals], [300000, 2, 150000, 1]);
    assert.deepEqual(goals.total, {goal_amount: 300000, goal_deals: 2, won_amount: 150000, won_deals: 1});
    assert.equal((await call('/api/reports/goals?month=2026-10')).total.won_amount, 99999);
    await call('/api/reports/goals?month=2026-13', {status: 400});
    assert.ok(await db.prepare("SELECT 1 FROM audit_log WHERE action='goals.updated'").get());

    // Templates: administrators edit, everyone reads.
    await call('/api/mail/templates', {method: 'POST', body: {name: 'Пусто'}, status: 400});
    const template = await call('/api/mail/templates', {method: 'POST', body: {name: 'КП', subject: 'Коммерческое предложение', body: 'Добрый день!'}, status: 201});
    await call(`/api/mail/templates/${template.id}`, {method: 'PATCH', body: {name: 'КП', subject: 'Предложение Polza', body: 'Добрый день!'}});
    await call('/api/login', {method: 'POST', body: {email: 'julia@agency.test', password: 'member-password'}});
    assert.equal((await call('/api/mail/templates'))[0].subject, 'Предложение Polza');
    await call('/api/mail/templates', {method: 'POST', body: {name: 'Своё', subject: 'x'}, status: 403});
    await call('/api/reports/goals', {method: 'PUT', body: {month: '2026-11', goals: []}, status: 403});
    assert.equal((await call(`/api/reports/calls?from=2026-11-01&to=${today}`)).total.incoming, 3, 'a member with full access sees the report');
    await call('/api/login', {method: 'POST', body: {email: 'admin@agency.test', password: 'passphrase-for-tests'}});
    await call(`/api/mail/templates/${template.id}`, {method: 'DELETE'});
    assert.equal((await call('/api/mail/templates')).length, 0);
  } finally {
    server.close();
    await db.close?.();
    rmSync(dir, {recursive: true, force: true});
  }
});
