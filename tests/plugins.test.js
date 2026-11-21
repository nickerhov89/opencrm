import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, readdirSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, relative, sep} from 'node:path';
import {readZip, writeZip, safeEntryName} from '../server/zip.js';
import {packageFiles, validateManifest} from '../server/plugins.js';

const examples = new URL('../examples/plugins/', import.meta.url);
function folder(name) {
  const root = new URL(`${name}/`, examples).pathname.replace(/^\/([a-z]:)/i, '$1');
  const files = [];
  const walk = dir => { for (const entry of readdirSync(dir, {withFileTypes: true})) { const path = join(dir, entry.name); if (entry.isDirectory()) walk(path); else files.push({name: relative(root, path).split(sep).join('/'), data: readFileSync(path)}); } };
  walk(decodeURIComponent(root));
  return files;
}
const zipOf = name => writeZip(folder(name));

test('ZIP: архив читается обратно, опасные пути отклоняются', () => {
  const files = [{name: 'plugin.json', data: Buffer.from('{"a":1}')}, {name: 'client/index.js', data: Buffer.from('x'.repeat(5000))}];
  assert.deepEqual(readZip(writeZip(files)).map(file => [file.name, file.data.toString()]), files.map(file => [file.name, file.data.toString()]));
  assert.equal(safeEntryName('../evil.js'), null);
  assert.equal(safeEntryName('/etc/passwd'), null);
  assert.equal(safeEntryName('C:/x.js'), null);
  assert.equal(safeEntryName('a/./b.js'), null);
  assert.throws(() => readZip(writeZip([{name: '../evil.js', data: Buffer.from('1')}])), /Недопустимое имя/);
  assert.throws(() => readZip(Buffer.from('not a zip at all, definitely not')), /ZIP/);
  const broken = writeZip(files);
  broken[43] ^= 0xff;
  assert.throws(() => readZip(broken));
});

test('plugin.json проверяется', () => {
  const ok = {id: 'demo-plugin', name: 'Demo', version: '1.2.3', api: 1};
  assert.equal(validateManifest(ok).id, 'demo-plugin');
  assert.throws(() => validateManifest({...ok, id: 'Bad_Id'}), /id плагина/);
  assert.throws(() => validateManifest({...ok, api: 2}), /API/);
  assert.throws(() => validateManifest({...ok, version: 'v1'}), /version/);
  assert.throws(() => validateManifest({...ok, server: '../x.js'}), /server/);
  assert.throws(() => validateManifest({...ok, server: 'x.js'}, () => false), /не найден/);
  assert.throws(() => validateManifest({...ok, settings: [{key: 'a'}, {key: 'a'}]}), /повторяется/);
  assert.throws(() => validateManifest({...ok, settings: [{key: 'a', type: 'select'}]}), /options/);
  assert.equal(validateManifest({...ok, settings: [{key: 'secret', type: 'password', public: true}]}).settings[0].public, false);
  // A ZIP of the plugin folder itself (one top folder) is accepted too.
  const nested = packageFiles(folder('tilda-forms').map(file => ({...file, name: `tilda-forms/${file.name}`})));
  assert.equal(nested.manifest.id, 'tilda-forms');
  assert.ok(nested.files.some(file => file.name === 'server.js'));
});

test('плагины: установка, настройки, приём заявок Tilda, страницы, события, удаление', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opencrm-plugins-'));
  process.env.PGLITE_DIR = join(dir, 'pg');
  process.env.UPLOAD_DIR = join(dir, 'uploads');
  process.env.PLUGINS_DIR = join(dir, 'plugins');
  process.env.NODE_ENV = 'test';
  const {app, db, plugins} = await import('../server/index.js');
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, base = `${origin}/api`;
  let cookie = '';
  async function request(path, method = 'GET', body, status = 200, headers = {}) {
    const raw = Buffer.isBuffer(body) || typeof body === 'string';
    const response = await fetch(base + path, {method, headers: {...(raw ? {} : {'Content-Type': 'application/json'}), ...(cookie ? {Cookie: cookie} : {}), ...headers}, body: body === undefined ? undefined : raw ? body : JSON.stringify(body)});
    const text = await response.text();
    assert.equal(response.status, status, `${method} ${path}: ${text}`);
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text;
  }
  try {
    await request('/setup', 'POST', {name: 'Admin', email: 'admin@example.test', password: 'passphrase-for-tests'});
    assert.deepEqual((await request('/admin/plugins')).plugins, []);
    assert.deepEqual(await request('/plugins'), []);

    // Install Tilda from a ZIP: it starts switched off.
    const tilda = await request('/admin/plugins', 'POST', zipOf('tilda-forms'), 201, {'Content-Type': 'application/zip'});
    assert.equal(tilda.status, 'disabled');
    assert.equal(tilda.endpoints[0].url, '/api/plugins/tilda-forms/public/hook');
    await request('/plugins/tilda-forms/public/hook', 'POST', 'test=test', 404, {'Content-Type': 'application/x-www-form-urlencoded'});
    await request('/admin/plugins/tilda-forms', 'PATCH', {enabled: true}, 400);
    await request('/admin/plugins/tilda-forms', 'PATCH', {settings: {unknown: 1}}, 400);
    await request('/admin/plugins/tilda-forms', 'PATCH', {settings: {token: 'tilda-secret-token', title: 'Сайт'}});
    let state = await request('/admin/plugins/tilda-forms', 'PATCH', {enabled: true});
    assert.equal(state.status, 'active');
    assert.equal(state.settings.token, '', 'секрет не возвращается в интерфейс');
    assert.deepEqual(state.secrets_set, ['token']);
    const row = await db.prepare('SELECT settings_json,secrets FROM plugins WHERE id=?').get('tilda-forms');
    assert.ok(!row.settings_json.includes('tilda-secret-token') && !row.secrets.includes('tilda-secret-token'), 'секрет хранится зашифрованным');
    // An empty password keeps the saved one.
    await request('/admin/plugins/tilda-forms', 'PATCH', {settings: {token: '', source: 'Лендинг'}});

    const savedCookie = cookie;
    cookie = '';
    const form = 'application/x-www-form-urlencoded';
    await request('/plugins/tilda-forms/public/hook', 'POST', 'test=test', 403, {'Content-Type': form});
    assert.equal(await request('/plugins/tilda-forms/public/hook', 'POST', 'test=test&api_key=tilda-secret-token', 200, {'Content-Type': form}), 'ok');
    const lead = new URLSearchParams({Name: 'Ирина', Phone: '+7 900 000-00-00', Email: 'IRINA@example.test', Comment: 'Перезвоните', formname: 'Обратный звонок', tranid: '123:456', utm_source: 'yandex'}).toString();
    await request('/plugins/tilda-forms/public/hook', 'POST', lead, 200, {'Content-Type': form, api_key: 'tilda-secret-token'});
    await request('/plugins/tilda-forms/public/hook', 'POST', lead, 200, {'Content-Type': form, api_key: 'tilda-secret-token'});
    await request('/plugins/tilda-forms/public/hook?token=tilda-secret-token', 'POST', {name: 'Пётр', phone: '1', tranid: '789'}, 200);
    const leads = await db.prepare('SELECT * FROM inbox_leads ORDER BY id').all();
    assert.equal(leads.length, 2, 'повтор с тем же tranid не создаёт заявку');
    assert.equal(leads[0].title, 'Сайт: Обратный звонок');
    assert.equal(leads[0].contact_name, 'Ирина');
    assert.equal(leads[0].email, 'irina@example.test');
    assert.equal(leads[0].source, 'Лендинг / yandex');
    assert.match(leads[0].message, /Comment: Перезвоните/);
    assert.doesNotMatch(leads[0].message, /tranid|api_key/);
    // Routes without /public need a session.
    await request('/plugins/hello-world/stats', 'GET', undefined, 404);
    cookie = savedCookie;

    // A plugin with a browser part, its own API and event handlers.
    await request('/admin/plugins', 'POST', zipOf('hello-world'), 201, {'Content-Type': 'application/zip'});
    await request('/admin/plugins/hello-world', 'PATCH', {settings: {logStages: true}});
    state = await request('/admin/plugins/hello-world', 'PATCH', {enabled: true});
    assert.equal(state.status, 'active');
    assert.deepEqual(state.events, ['deal.stage_changed']);
    const client = await request('/plugins');
    assert.deepEqual(client.map(item => item.id), ['hello-world'], 'в браузер уходят только плагины с интерфейсом');
    assert.deepEqual(client[0].settings, {greeting: 'Привет из плагина!'}, 'в браузер уходят только публичные настройки');
    const asset = await fetch(origin + client[0].client, {headers: {Cookie: cookie}});
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('content-type'), /javascript/);
    assert.match(await asset.text(), /addDealPanel/);
    await request('/plugins/hello-world/assets/server.js', 'GET', undefined, 404);
    await request('/plugins/hello-world/assets/plugin.json', 'GET', undefined, 404);
    assert.equal((await fetch(origin + client[0].client)).status, 401);
    assert.equal((await request('/plugins/hello-world/stats')).leads, 2);
    cookie = '';
    await request('/plugins/hello-world/stats', 'GET', undefined, 401);
    cookie = savedCookie;

    const [pipeline] = await request('/pipelines');
    const stages = await request(`/stages?pipeline_id=${pipeline.id}`);
    const deal = await request('/deals', 'POST', {name: 'Plugin deal', stage_id: stages[0].id}, 201);
    assert.equal((await request(`/plugins/hello-world/deal/${deal.id}`)).opened, 1);
    await request(`/deals/${deal.id}`, 'PATCH', {stage_id: stages[1].id});
    assert.equal(await plugins.processEvents(), 1);
    assert.equal(await plugins.processEvents(), 0, 'событие доставляется один раз');
    assert.equal((await request('/plugins/hello-world/stats')).stage_changes, 1);
    const feed = await db.prepare('SELECT event FROM activity WHERE deal_id=? ORDER BY id').all(deal.id);
    assert.ok(feed.some(item => item.event.startsWith('Пример плагина: сделка перешла на этап')), JSON.stringify(feed));

    // Members do not manage plugins.
    await request('/users', 'POST', {name: 'Member', email: 'member@example.test', password: 'member-password', role: 'member'}, 201);
    const adminCookie = cookie;
    cookie = '';
    await request('/login', 'POST', {email: 'member@example.test', password: 'member-password'});
    await request('/admin/plugins', 'GET', undefined, 403);
    await request('/admin/plugins', 'POST', zipOf('hello-world'), 403, {'Content-Type': 'application/zip'});
    assert.equal((await request('/plugins')).length, 1);
    cookie = adminCookie;

    // Broken packages are refused and leave the installed copy alone.
    await request('/admin/plugins', 'POST', writeZip([{name: 'plugin.json', data: Buffer.from(JSON.stringify({id: 'hello-world', name: 'x', version: '2.0.0', api: 99}))}]), 400, {'Content-Type': 'application/zip'});
    await request('/admin/plugins', 'POST', writeZip([{name: 'readme.txt', data: Buffer.from('x')}]), 400, {'Content-Type': 'application/zip'});
    await request('/admin/plugins', 'POST', Buffer.from('nope'), 400, {'Content-Type': 'application/zip'});
    assert.equal((await request('/admin/plugins')).plugins.find(item => item.id === 'hello-world').version, '1.0.0');

    // An update keeps settings and restarts the plugin.
    const updated = folder('hello-world').map(file => file.name === 'plugin.json' ? {...file, data: Buffer.from(file.data.toString().replace('"1.0.0"', '"1.1.0"'))} : file);
    state = await request('/admin/plugins', 'POST', writeZip(updated), 200, {'Content-Type': 'application/zip'});
    assert.equal(state.version, '1.1.0');
    assert.equal(state.status, 'active');
    assert.equal(state.settings.logStages, true);

    process.env.OPENCRM_PLUGIN_UPLOAD = '0';
    await request('/admin/plugins', 'POST', zipOf('hello-world'), 403, {'Content-Type': 'application/zip'});
    delete process.env.OPENCRM_PLUGIN_UPLOAD;

    // Switching off stops routes and event delivery.
    await request('/admin/plugins/hello-world', 'PATCH', {enabled: false});
    await request('/plugins/hello-world/stats', 'GET', undefined, 404);
    assert.deepEqual(await request('/plugins'), []);
    assert.equal((await db.prepare('SELECT events_json FROM plugins WHERE id=?').get('hello-world')).events_json, '[]');

    await request('/admin/plugins/hello-world', 'DELETE');
    assert.ok(!existsSync(join(process.env.PLUGINS_DIR, 'hello-world')));
    assert.equal((await db.prepare("SELECT COUNT(*) n FROM plugin_storage WHERE plugin_id='hello-world'").get()).n, 0);
    await request('/admin/plugins/hello-world', 'DELETE', undefined, 404);
    const actions = (await db.prepare("SELECT action FROM audit_log WHERE action LIKE 'plugin.%' ORDER BY id").all()).map(item => item.action);
    for (const action of ['plugin.installed', 'plugin.settings_changed', 'plugin.enabled', 'plugin.updated', 'plugin.disabled', 'plugin.deleted']) assert.ok(actions.includes(action), action);
  } finally {
    server.close();
    await db.close?.();
    rmSync(dir, {recursive: true, force: true});
  }
});
