import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import http from 'node:http';
import {mkdtempSync, readdirSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, relative, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {writeZip} from '../server/zip.js';

const root = fileURLToPath(new URL('../examples/plugins/mango-office/', import.meta.url));
const pluginZip = () => {
  const files = [];
  const walk = dir => { for (const entry of readdirSync(dir, {withFileTypes: true})) { const path = join(dir, entry.name); if (entry.isDirectory()) walk(path); else files.push({name: relative(root, path).split(sep).join('/'), data: readFileSync(path)}); } };
  walk(root);
  return writeZip(files);
};
const sha256 = text => createHash('sha256').update(text).digest('hex');
const key = 'test-vpbx-key', salt = 'test-salt';

test('Mango Office: звонки в ленту сделки, «Неразобранное», журнал и записи', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opencrm-mango-'));
  process.env.PGLITE_DIR = join(dir, 'pg');
  process.env.UPLOAD_DIR = join(dir, 'uploads');
  process.env.PLUGINS_DIR = join(dir, 'plugins');
  process.env.NODE_ENV = 'test';

  // A stand-in for app.mango-office.ru: checks the signature and redirects to the audio file.
  const mangoRequests = [];
  const mango = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      if (req.url === '/vpbx/queries/recording/post') {
        const form = new URLSearchParams(body);
        mangoRequests.push(JSON.parse(form.get('json')));
        if (form.get('vpbx_api_key') !== key || form.get('sign') !== sha256(key + form.get('json') + salt)) { res.writeHead(401); return res.end(); }
        res.writeHead(302, {Location: `/files/${JSON.parse(form.get('json')).recording_id}.mp3`});
        return res.end();
      }
      if (req.url.startsWith('/files/')) { res.writeHead(200, {'Content-Type': 'audio/mp3'}); return res.end(`ID3-${req.url}`); }
      res.writeHead(404); res.end();
    });
  });
  await new Promise(resolve => mango.listen(0, '127.0.0.1', resolve));

  const {app, db} = await import('../server/index.js');
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  let cookie = '';
  async function request(path, method = 'GET', body, status = 200, headers = {}) {
    const raw = Buffer.isBuffer(body) || typeof body === 'string';
    const response = await fetch(base + path, {method, headers: {...(raw ? {} : {'Content-Type': 'application/json'}), ...(cookie ? {Cookie: cookie} : {}), ...headers}, body: body === undefined ? undefined : raw ? body : JSON.stringify(body)});
    const type = response.headers.get('content-type') || '';
    const data = type.includes('json') ? await response.json() : type.startsWith('audio/') ? Buffer.from(await response.arrayBuffer()) : await response.text();
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(data)}`);
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return data;
  }
  // What Mango sends: a form with the key, the event as a JSON string and its signature.
  const send = async (name, event, {status = 200, sign} = {}) => {
    const json = JSON.stringify(event);
    const form = new URLSearchParams({vpbx_api_key: key, sign: sign || sha256(key + json + salt), json}).toString();
    const saved = cookie;
    cookie = '';
    try { return await request(`/plugins/mango-office/public/mango/${name}`, 'POST', form, status, {'Content-Type': 'application/x-www-form-urlencoded'}); }
    finally { cookie = saved; }
  };
  const t0 = Math.floor(Date.parse('2026-11-20T10:00:00Z') / 1000);
  const summary = (entry, direction, number, extension, {answered = true, talk = 0, line = '74950000000'} = {}) => ({
    entry_id: entry, call_direction: direction, line_number: line, create_time: t0, forward_time: t0 + 2, talk_time: answered ? t0 + 5 : 0, end_time: t0 + 5 + talk, entry_result: answered ? 1 : 0, disconnect_reason: 1110,
    from: direction === 1 ? {number} : {extension: String(extension), number: '74950000000'},
    to: direction === 1 ? {extension: String(extension), number: '74950000000'} : {number},
  });

  try {
    const admin = await request('/setup', 'POST', {name: 'Админ', email: 'admin@example.test', password: 'passphrase-for-tests'});
    await request('/admin/plugins', 'POST', pluginZip(), 201, {'Content-Type': 'application/zip'});
    await request('/admin/plugins/mango-office', 'PATCH', {settings: {api_key: key, api_salt: salt, employees: '101 = ADMIN@example.test\n102 = nobody@example.test\nмусор', api_url: `http://127.0.0.1:${mango.address().port}/vpbx`}});
    const state = await request('/admin/plugins/mango-office', 'PATCH', {enabled: true});
    assert.equal(state.status, 'active', state.error);
    assert.equal(state.endpoints[0].url, '/api/plugins/mango-office/public/mango');

    // Mango checks the address; a wrong signature or key is refused.
    await send('ping', {});
    await send('events/summary', summary('bad', 1, '79001112233', 101), {status: 403, sign: 'f'.repeat(64)});

    const [pipeline] = await request('/pipelines');
    const stages = await request(`/stages?pipeline_id=${pipeline.id}`);
    const contact = await request('/contacts', 'POST', {name: 'Ирина', phone: '+7 (900) 111-22-33'}, 201);
    const deal = await request('/deals', 'POST', {name: 'Сделка Ирины', stage_id: stages[0].id, contact_id: contact.id}, 201);

    // A known number with an open deal: the call goes to the deal feed from the employee.
    await send('events/summary', summary('e1', 1, '79001112233', 101, {talk: 135}));
    await send('events/summary', summary('e1', 1, '79001112233', 101, {talk: 135}));
    let calls = await db.prepare('SELECT * FROM deal_communications WHERE deal_id=?').all(deal.id);
    assert.equal(calls.length, 1, 'повтор события не дублирует звонок');
    assert.equal(calls[0].kind, 'call');
    assert.equal(calls[0].direction, 'incoming');
    assert.equal(Number(calls[0].user_id), admin.id);
    assert.equal(calls[0].subject, '2:15', 'в теме — длительность, «Входящий звонок» лента пишет сама');
    assert.match(calls[0].body, /от \+7 900 111-22-33, разговор 2:15, ответил Админ/);
    assert.equal(calls[0].created_at, '2026-11-20 10:00:00');

    // An unknown number: one request in «Неразобранное», a repeat call goes to the same one.
    await send('events/summary', summary('e2', 1, '79005556677', 102, {answered: false}));
    await send('events/summary', summary('e3', 1, '89005556677', 102, {answered: false}));
    const leads = await db.prepare('SELECT * FROM inbox_leads').all();
    assert.equal(leads.length, 1);
    assert.equal(leads[0].title, 'Звонок +7 900 555-66-77');
    assert.equal(leads[0].source, 'Mango Office');
    assert.match(leads[0].message, /Пропущенный входящий звонок от \+7 900 555-66-77, внутр\. 102/);

    // An outgoing call to a contact without a deal goes to the contact's history; internal calls are skipped.
    const other = await request('/contacts', 'POST', {name: 'Пётр', phone: '8 912 000 11 22'}, 201);
    await send('events/summary', summary('e4', 2, '79120001122', 101, {talk: 30}));
    await send('events/summary', {...summary('e5', 0, '', 101), from: {extension: '101'}, to: {extension: '102'}});
    const history = await db.prepare("SELECT event FROM entity_activity WHERE entity_type='contact' AND entity_id=?").all(other.id);
    assert.ok(history.some(item => /^Mango Office: Исходящий звонок на \+7 912 000-11-22, разговор 0:30, звонил Админ/.test(item.event)), JSON.stringify(history));
    assert.equal((await db.prepare("SELECT COUNT(*) n FROM plugin_mango_calls WHERE entry_id='e5'").get()).n, 0);

    // Recordings: one arrives after the call summary, another before it.
    await send('events/record/added', {entry_id: 'e1', recording_id: 'rec-1', product_id: 1, user_id: 1, timestamp: t0 + 200});
    await send('events/record/added', {entry_id: 'e6', recording_id: 'rec-6', product_id: 1, user_id: 1, timestamp: t0 + 200});
    await send('events/summary', summary('e6', 1, '79001112233', 101, {talk: 10}));

    calls = await request(`/plugins/mango-office/deal/${deal.id}`);
    // Both calls started at the same second, so the order between them is not fixed.
    calls.sort((a, b) => a.entry_id.localeCompare(b.entry_id));
    assert.deepEqual(calls.map(call => [call.entry_id, call.has_recording, call.user_name]), [['e1', true, 'Админ'], ['e6', true, 'Админ']]);
    assert.equal(calls[0].number, '+7 900 111-22-33');
    assert.equal(calls[0].duration, '2:15');
    const journal = await request('/plugins/mango-office/calls');
    assert.equal(journal.length, 5);
    assert.deepEqual((await request('/plugins/mango-office/calls?filter=missed')).map(call => call.entry_id).sort(), ['e2', 'e3']);
    assert.ok((await request('/plugins/mango-office/calls?filter=missed')).every(call => call.lead_id === leads[0].id));

    const audio = await request('/plugins/mango-office/recording/e1');
    assert.equal(audio.toString(), 'ID3-/files/rec-1.mp3');
    assert.deepEqual(mangoRequests.at(-1), {recording_id: 'rec-1', action: 'play'});
    await request('/plugins/mango-office/recording/e2', 'GET', undefined, 404);

    // An employee who sees only their own deals cannot list or play other calls.
    await request('/users', 'POST', {name: 'Менеджер', email: 'member@example.test', password: 'member-password', role: 'member', deal_access: 'own'}, 201);
    const adminCookie = cookie;
    cookie = '';
    await request('/login', 'POST', {email: 'member@example.test', password: 'member-password'});
    assert.deepEqual(await request('/plugins/mango-office/calls'), []);
    await request('/plugins/mango-office/recording/e1', 'GET', undefined, 404);
    await request(`/plugins/mango-office/deal/${deal.id}`, 'GET', undefined, 404);
    cookie = '';
    await request('/plugins/mango-office/calls', 'GET', undefined, 401);
    cookie = adminCookie;
  } finally {
    server.close();
    mango.close();
    await db.close?.();
    rmSync(dir, {recursive: true, force: true});
  }
});
