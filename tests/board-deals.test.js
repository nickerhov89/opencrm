import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('deals of a pipeline: every open deal, plus the 1000 most recently changed closed ones', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opencrm-board-'));
  process.env.PGLITE_DIR = join(dir, 'pg');
  process.env.UPLOAD_DIR = join(dir, 'uploads');
  process.env.NODE_ENV = 'test';
  const {app, db} = await import('../server/index.js');
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const setup = await fetch(`${base}/api/setup`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({name: 'Admin', email: 'admin@agency.test', password: 'passphrase-for-tests'})});
    const cookie = setup.headers.get('set-cookie').split(';')[0];
    const stage = kind => db.prepare('SELECT id,pipeline_id FROM stages WHERE kind=? ORDER BY id LIMIT 1').get(kind);
    const active = await stage('active'), lost = await stage('lost');
    // Closed deals changed recently, open ones long ago: a plain «latest 1000» would lose the open ones.
    await db.prepare(`INSERT INTO deals (name,stage_id,updated_at) SELECT 'Закрытая ' || g, ?, '2026-11-01 10:00:00' FROM generate_series(1,1100) g`).run(lost.id);
    for (let i = 0; i < 3; i++) await db.prepare("INSERT INTO deals (name,stage_id,updated_at) VALUES (?,?,'2020-01-01 10:00:00')").run(`Открытая ${i}`, active.id);
    const response = await fetch(`${base}/api/deals?pipeline_id=${active.pipeline_id}`, {headers: {Cookie: cookie}});
    assert.equal(response.status, 200);
    const deals = await response.json();
    assert.equal(deals.filter(item => item.stage_id === active.id).length, 3);
    assert.equal(deals.filter(item => item.stage_id === lost.id).length, 1000);
  } finally {
    server.close();
    await db.close?.();
    rmSync(dir, {recursive: true, force: true});
  }
});
