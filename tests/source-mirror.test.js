import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('deals.source mirrors the «Источник» field; a completed task keeps who completed it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opencrm-source-'));
  process.env.PGLITE_DIR = join(dir, 'pg');
  process.env.UPLOAD_DIR = join(dir, 'uploads');
  process.env.NODE_ENV = 'test';
  const {app, db} = await import('../server/index.js');
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
    await call('/api/setup', {method: 'POST', body: {name: 'Admin', email: 'admin@agency.test', password: 'passphrase-for-tests'}});
    const stage = (await db.prepare("SELECT id FROM stages WHERE kind='active' ORDER BY id LIMIT 1").get()).id;
    const deal = (await db.prepare("INSERT INTO deals (name,stage_id,updated_at) VALUES ('Сделка',?,'2026-01-01 10:00:00')").run(stage)).lastInsertRowid;
    await call('/api/integrations/webhooks', {method: 'POST', body: {name: 'Портал', url: 'https://portal.example.test/hook', events: ['deal.updated']}, status: 201});
    const field = await call('/api/custom-fields', {method: 'POST', body: {entity_type: 'deal', name: 'Источник', field_type: 'select', options: ['Сайт', 'Партнер']}, status: 201});
    const other = await call('/api/custom-fields', {method: 'POST', body: {entity_type: 'deal', name: 'Подысточник', field_type: 'text'}, status: 201});
    const row = () => db.prepare('SELECT source,updated_at FROM deals WHERE id=?').get(deal);
    await call(`/api/custom-fields/${field.id}/values/${deal}`, {method: 'PUT', body: {value: 'Партнер'}});
    const changed = await row();
    assert.equal(changed.source, 'Партнер', 'the source follows the field');
    assert.notEqual(changed.updated_at, '2026-01-01 10:00:00', 'a field change moves updated_at');
    await call(`/api/custom-fields/${other.id}/values/${deal}`, {method: 'PUT', body: {value: 'Вебинар'}});
    assert.equal((await row()).source, 'Партнер', 'other fields do not touch the source');
    await db.prepare('DELETE FROM custom_field_values WHERE field_id=? AND entity_id=?').run(field.id, deal);
    assert.equal((await row()).source, '');
    const updates = (await db.prepare("SELECT payload_json FROM webhook_events WHERE event_type='deal.updated' ORDER BY id").all()).map(item => JSON.parse(item.payload_json));
    assert.equal(updates.length, 3, 'one deal.updated per field change, none for copying the source');
    assert.equal(updates[0].source, 'Партнер', 'the event carries the copied source');

    // Completing a task in the interface records who did it; reopening clears it.
    const task = await call('/api/tasks', {method: 'POST', body: {title: 'Позвонить', deal_id: deal, due_at: '2026-11-20T07:00:00.000Z'}, status: 201});
    await call(`/api/tasks/${task.id}`, {method: 'PATCH', body: {completed: true, result: 'Дозвонился'}});
    const done = (await call(`/api/deals/${deal}`)).tasks.find(item => item.id === task.id);
    assert.equal(done.completed_by_name, 'Admin');
    assert.ok(done.completed_at > '2026-11-20T08');
    await call(`/api/tasks/${task.id}`, {method: 'PATCH', body: {completed: false}});
    assert.equal((await call(`/api/deals/${deal}`)).tasks.find(item => item.id === task.id).completed_by_name, null);

    // Deals loaded before the mirror get their source on the next start.
    await db.prepare("INSERT INTO custom_field_values (field_id,entity_id,value) VALUES (?,?,'Сайт')").run(field.id, deal);
    await db.prepare("UPDATE deals SET source='' WHERE id=?").run(deal);
    const {createDb} = await import('../server/db.js');
    await db.close?.();
    const again = await createDb();
    assert.equal((await again.prepare('SELECT source FROM deals WHERE id=?').get(deal)).source, 'Сайт');
    await again.close?.();
  } finally {
    server.close();
    rmSync(dir, {recursive: true, force: true});
  }
});

test('a task completed by an employee keeps who completed it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opencrm-task-done-'));
  const {createDb} = await import('../server/db.js');
  const db = await createDb({dataDir: join(dir, 'pg'), url: ''});
  try {
    const user = (await db.prepare("INSERT INTO users (name,email,password_hash) VALUES ('Юлия','julia@agency.test','x')").run()).lastInsertRowid;
    const task = (await db.prepare("INSERT INTO tasks (title,owner_id) VALUES ('Позвонить',?)").run(user)).lastInsertRowid;
    await db.runAs(`user:${user}`, () => db.transaction(() => db.prepare('UPDATE tasks SET completed_at=? WHERE id=?').run(new Date().toISOString(), task))());
    assert.equal(Number((await db.prepare('SELECT completed_by FROM tasks WHERE id=?').get(task)).completed_by), Number(user), 'from the acting employee');
    await db.prepare('UPDATE tasks SET completed_at=NULL WHERE id=?').run(task);
    assert.equal((await db.prepare('SELECT completed_by FROM tasks WHERE id=?').get(task)).completed_by, null);
  } finally {
    await db.close?.();
    rmSync(dir, {recursive: true, force: true});
  }
});
