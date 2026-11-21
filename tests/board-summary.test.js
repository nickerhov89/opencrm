import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('board summary: tasks today, deals without tasks, overdue tasks, new deals, forecast', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opencrm-board-summary-'));
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
    await call('/api/setup', {method: 'POST', body: {name: 'Админ', email: 'admin@agency.test', password: 'passphrase-for-tests'}});
    const admin = Number((await db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get()).id);
    const pipeline = (await db.prepare('SELECT id FROM pipelines ORDER BY id LIMIT 1').get()).id;
    const active = (await db.prepare("SELECT id FROM stages WHERE pipeline_id=? AND kind='active' ORDER BY sort_order LIMIT 1").get(pipeline)).id;
    const won = (await db.prepare("SELECT id FROM stages WHERE pipeline_id=? AND kind='won'").get(pipeline)).id;
    const deal = async (name, stage, createdAt) => Number((await db.prepare(`INSERT INTO deals (name,stage_id,owner_id,amount${createdAt ? ',created_at' : ''}) VALUES (?,?,?,100${createdAt ? ',?' : ''})`).run(name, stage, admin, ...(createdAt ? [createdAt] : []))).lastInsertRowid);
    const fresh = await deal('Сегодня', active);
    const old = await deal('Старая', active, '2020-01-01 10:00:00');
    await deal('Без задачи', active, '2020-01-01 10:00:00');
    const closed = await deal('Закрыта', won, '2020-01-01 10:00:00');
    const later = new Date(Date.now() + 60_000).toISOString(), past = new Date(Date.now() - 3 * 864e5).toISOString();
    await db.prepare('INSERT INTO tasks (title,due_at,owner_id,deal_id) VALUES (?,?,?,?)').run('Сегодня позже', later, admin, fresh);
    await db.prepare('INSERT INTO tasks (title,due_at,owner_id,deal_id) VALUES (?,?,?,?)').run('Просрочена', past, admin, old);
    await db.prepare('INSERT INTO tasks (title,due_at,owner_id,deal_id) VALUES (?,?,?,?)').run('У закрытой', past, admin, closed);
    const {summary} = await call(`/api/stats?pipeline_id=${pipeline}`);
    const moscowHour = (new Date().getUTCHours() + 3) % 24;
    if (moscowHour < 23) assert.equal(summary.tasks_today, 1, 'a task later today');
    assert.equal(summary.without_tasks, 1, 'only working deals count');
    assert.equal(summary.overdue_tasks, 1, 'tasks of closed deals do not count');
    assert.equal(summary.new_today, 1);
    assert.equal(summary.new_yesterday, 0);
    assert.equal(summary.forecast, null, 'no goals — no forecast');
    const month = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 7);
    await call('/api/reports/goals', {method: 'PUT', body: {month, goals: [{user_id: admin, amount: 1000, deals: 0}]}});
    await db.prepare('UPDATE deals SET closed_at=? WHERE id=?').run(`${month}-02 10:00:00`, closed);
    assert.deepEqual((await call(`/api/stats?pipeline_id=${pipeline}`)).summary.forecast, {goal: 1000, won: 100});
  } finally {
    server.close();
    await db.close?.();
    rmSync(dir, {recursive: true, force: true});
  }
});
