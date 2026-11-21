import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('deal chat: a message to colleagues, «Сообщения» until the deal is opened, read marks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opencrm-chat-'));
  process.env.PGLITE_DIR = join(dir, 'pg');
  process.env.UPLOAD_DIR = join(dir, 'uploads');
  process.env.NODE_ENV = 'test';
  const {app, db} = await import('../server/index.js');
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const jar = {};
  const as = who => async (path, {method = 'GET', body, status = 200} = {}) => {
    const response = await fetch(base + path, {method, headers: {'Content-Type': 'application/json', Cookie: jar[who] || ''}, body: body ? JSON.stringify(body) : undefined});
    const text = await response.text();
    assert.equal(response.status, status, `${who} ${method} ${path}: ${text}`);
    if (response.headers.get('set-cookie')) jar[who] = response.headers.get('set-cookie').split(';')[0];
    return text ? JSON.parse(text) : null;
  };
  const admin = as('admin'), alex = as('alex'), julia = as('julia');
  try {
    await admin('/api/setup', {method: 'POST', body: {name: 'Сальнов', email: 'admin@agency.test', password: 'passphrase-for-tests'}});
    const adminId = Number((await db.prepare("SELECT id FROM users WHERE email='admin@agency.test'").get()).id);
    const alexId = Number((await admin('/api/users', {method: 'POST', body: {name: 'Лебедев', email: 'alex@agency.test', password: 'member-password', role: 'member'}, status: 201})).id);
    const juliaId = Number((await admin('/api/users', {method: 'POST', body: {name: 'Миронова', email: 'julia@agency.test', password: 'member-password', role: 'member', deal_access: 'own'}, status: 201})).id);
    await alex('/api/login', {method: 'POST', body: {email: 'alex@agency.test', password: 'member-password'}});
    await julia('/api/login', {method: 'POST', body: {email: 'julia@agency.test', password: 'member-password'}});
    const stage = (await db.prepare("SELECT id FROM stages WHERE kind='active' ORDER BY id LIMIT 1").get()).id;
    const deal = Number((await db.prepare("INSERT INTO deals (name,stage_id,owner_id) VALUES ('Beata Game',?,?)").run(stage, alexId)).lastInsertRowid);

    await alex(`/api/deals/${deal}/chat`, {method: 'POST', body: {body: '  ', to: [adminId]}, status: 400});
    await alex(`/api/deals/${deal}/chat`, {method: 'POST', body: {body: 'Привет', to: []}, status: 400});
    await alex(`/api/deals/${deal}/chat`, {method: 'POST', body: {body: 'Привет', to: [juliaId]}, status: 400});
    const sent = await alex(`/api/deals/${deal}/chat`, {method: 'POST', body: {body: 'дубль лида, он у меня уже в воронке 1 месяц', to: [adminId]}, status: 201});
    assert.equal(sent.author, 'Лебедев');
    assert.deepEqual(sent.recipients.map(user => [user.name, user.read_at]), [['Сальнов', null]]);
    const all = await alex(`/api/deals/${deal}/chat`, {method: 'POST', body: {body: 'Всем: созвон в 15:00', to: 'all'}, status: 201});
    assert.deepEqual(all.recipients.map(user => user.name), ['Сальнов'], 'an employee who cannot open the deal is not among «all»');

    const panel = await admin('/api/notifications');
    const chats = panel.items.filter(item => item.kind === 'chat');
    assert.equal(chats.length, 2);
    assert.equal(chats[0].title, 'Чат: Beata Game');
    assert.match(chats.find(item => item.text.includes('дубль')).text, /^Лебедев: дубль лида/);
    assert.equal(chats[0].deal_id, deal);
    assert.equal((await alex('/api/notifications')).items.filter(item => item.kind === 'chat').length, 0, 'the author gets nothing');

    // Opening the deal reads the messages: they leave the panel and the author sees the read mark.
    const opened = await admin(`/api/deals/${deal}`);
    assert.equal(opened.chat.length, 2);
    assert.equal((await admin('/api/notifications')).items.filter(item => item.kind === 'chat').length, 0);
    const seen = await alex(`/api/deals/${deal}/chat`);
    assert.ok(seen.every(message => message.recipients.every(user => user.read_at)));

    // The reply goes the other way; someone without access to the deal cannot read or write.
    await admin(`/api/deals/${deal}/chat`, {method: 'POST', body: {body: 'Ок, закрываю', to: [alexId]}, status: 201});
    assert.equal((await alex('/api/notifications')).items.filter(item => item.kind === 'chat').length, 1);
    await julia(`/api/deals/${deal}/chat`, {status: 403});
    await julia(`/api/deals/${deal}/chat`, {method: 'POST', body: {body: 'x', to: [adminId]}, status: 403});

    // A deleted deal takes its chat out of the panel.
    await db.prepare("UPDATE deals SET deleted_at=now_text() WHERE id=?").run(deal);
    assert.equal((await alex('/api/notifications')).items.filter(item => item.kind === 'chat').length, 0);
  } finally {
    server.close();
    await db.close?.();
    rmSync(dir, {recursive: true, force: true});
  }
});
