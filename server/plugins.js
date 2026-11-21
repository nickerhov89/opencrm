import express from 'express';
import {randomBytes} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {dirname, join, posix, resolve, sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {eventTypes} from './integrations.js';
import {createSecretBox, secretFilePath} from './mail.js';
import {readZip, safeEntryName, ZipError} from './zip.js';

// Plugins extend OpenCRM without changing its code. A plugin is a folder (or a ZIP of it) with
// plugin.json and optional server and browser modules; see docs/PLUGINS.md for the format.
// Plugins are trusted code: their server module runs inside the CRM process with full database
// access, so only administrators can install them, and uploads can be turned off.

export const pluginApiVersion = 1;
export const settingTypes = ['text', 'textarea', 'password', 'number', 'boolean', 'select'];
export class PluginError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const bad = message => { throw new PluginError(message); };
const idPattern = /^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/;
const versionPattern = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:[-+][0-9A-Za-z.-]{1,40})?$/;
const keyPattern = /^[A-Za-z][A-Za-z0-9_]{0,49}$/;
const text = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const moduleFile = value => typeof value === 'string' && /\.(m?js)$/.test(value) ? safeEntryName(value) : null;

export const pluginsDir = (uploadDir = process.env.UPLOAD_DIR || 'data/uploads') => resolve(process.env.PLUGINS_DIR || resolve(uploadDir, '..', 'plugins'));

// Checks plugin.json; `has(name)` says whether a file exists in the package.
export function validateManifest(raw, has = () => true) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad('plugin.json должен быть JSON-объектом');
  const id = raw.id;
  if (typeof id !== 'string' || !idPattern.test(id)) bad('id плагина: 2–50 символов, латиница в нижнем регистре, цифры и дефис');
  const name = text(raw.name, 80);
  if (!name) bad('Укажите name плагина');
  if (typeof raw.version !== 'string' || !versionPattern.test(raw.version)) bad('version плагина — в формате 1.0.0');
  if (raw.api !== pluginApiVersion) bad(`Плагин написан для API ${JSON.stringify(raw.api ?? null)}, а OpenCRM поддерживает API ${pluginApiVersion}`);
  const manifest = {id, name, version: raw.version, api: raw.api, description: text(raw.description, 500), author: text(raw.author, 120)};
  for (const part of ['server', 'client']) {
    if (raw[part] === undefined) continue;
    const file = moduleFile(raw[part]);
    if (!file) bad(`${part}: путь к файлу .js или .mjs внутри плагина`);
    if (!has(file)) bad(`Файл ${file} из поля ${part} не найден в плагине`);
    manifest[part] = file;
  }
  const settings = raw.settings ?? [];
  if (!Array.isArray(settings) || settings.length > 50) bad('settings — список не длиннее 50 полей');
  const keys = new Set();
  manifest.settings = settings.map(item => {
    if (!item || typeof item !== 'object' || !keyPattern.test(item.key || '')) bad('У каждой настройки нужен key: латиница, цифры, _');
    if (keys.has(item.key)) bad(`Настройка ${item.key} повторяется`);
    keys.add(item.key);
    const type = item.type ?? 'text';
    if (!settingTypes.includes(type)) bad(`Тип настройки ${item.key}: ${settingTypes.join(', ')}`);
    const field = {key: item.key, label: text(item.label, 120) || item.key, type, help: text(item.help, 500), required: item.required === true, public: item.public === true && type !== 'password'};
    if (type === 'select') {
      if (!Array.isArray(item.options) || !item.options.length || item.options.length > 100) bad(`У настройки ${item.key} нужен список options`);
      field.options = item.options.map(option => typeof option === 'object' && option ? {value: String(option.value), label: text(String(option.label ?? option.value), 120)} : {value: String(option), label: String(option).slice(0, 120)});
    }
    if (item.default !== undefined && type !== 'password') field.default = coerce(field, item.default, `Значение по умолчанию ${item.key}`);
    return field;
  });
  const endpoints = raw.endpoints ?? [];
  if (!Array.isArray(endpoints) || endpoints.length > 20) bad('endpoints — список не длиннее 20 адресов');
  manifest.endpoints = endpoints.map(item => {
    if (!item || typeof item.path !== 'string' || !/^\/[A-Za-z0-9_\-/.]{0,200}$/.test(item.path) || item.path.includes('..')) bad('endpoints[].path начинается с / и состоит из латиницы, цифр, -_./');
    return {path: item.path, label: text(item.label, 120) || item.path};
  });
  return manifest;
}

function coerce(field, value, label = field.label) {
  if (field.type === 'boolean') { if (typeof value !== 'boolean') bad(`${label}: да или нет`); return value; }
  if (field.type === 'number') { const number = typeof value === 'number' ? value : value === '' ? NaN : Number(value); if (!Number.isFinite(number)) bad(`${label}: нужно число`); return number; }
  if (typeof value !== 'string') bad(`${label}: нужна строка`);
  const clean = value.slice(0, field.type === 'textarea' ? 20000 : 2000);
  if (field.type === 'select' && clean !== '' && !field.options.some(option => option.value === clean)) bad(`${label}: значение не из списка`);
  return clean;
}

// Finds plugin.json at the archive root or inside its only top folder and strips that folder.
export function packageFiles(entries) {
  let files = entries;
  if (!files.some(file => file.name === 'plugin.json')) {
    const tops = new Set(files.map(file => file.name.split('/')[0]));
    const [top] = tops;
    if (tops.size !== 1 || !files.some(file => file.name === `${top}/plugin.json`)) bad('В архиве нет plugin.json');
    files = files.map(file => ({...file, name: file.name.slice(top.length + 1)}));
  }
  let raw;
  try { raw = JSON.parse(files.find(file => file.name === 'plugin.json').data.toString('utf8')); } catch { bad('plugin.json — неверный JSON'); }
  const names = new Set(files.map(file => file.name));
  return {manifest: validateManifest(raw, name => names.has(name)), files};
}

// Writes a package into dir/<id>, replacing an older copy only after the new one is complete.
export function writePackage(dir, {manifest, files}) {
  mkdirSync(dir, {recursive: true});
  const target = join(dir, manifest.id), temp = join(dir, `.tmp-${manifest.id}-${randomBytes(4).toString('hex')}`), old = join(dir, `.old-${manifest.id}-${randomBytes(4).toString('hex')}`);
  try {
    for (const file of files) {
      const path = resolve(temp, file.name);
      if (!path.startsWith(resolve(temp) + sep)) bad(`Недопустимый путь: ${file.name}`);
      mkdirSync(dirname(path), {recursive: true});
      writeFileSync(path, file.data);
    }
    if (existsSync(target)) renameSync(target, old);
    renameSync(temp, target);
  } finally {
    rmSync(temp, {recursive: true, force: true});
    rmSync(old, {recursive: true, force: true});
  }
  return target;
}

export function readInstalledManifest(dir, id) {
  const root = join(dir, id);
  let raw;
  try { raw = JSON.parse(readFileSync(join(root, 'plugin.json'), 'utf8')); } catch { bad(`Не удалось прочитать ${id}/plugin.json`); }
  const manifest = validateManifest(raw, name => { try { return statSync(join(root, name)).isFile(); } catch { return false; } });
  if (manifest.id !== id) bad(`Папка ${id} содержит плагин ${manifest.id}: имя папки должно совпадать с id`);
  return manifest;
}

const withTimeout = (promise, ms, label) => {
  let timer;
  return Promise.race([Promise.resolve(promise), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: нет ответа за ${ms / 1000} с`)), ms); timer.unref?.(); })]).finally(() => clearTimeout(timer));
};

export function registerPlugins(app, db, {auth, admin, audit = async () => {}, uploadDir, dir = pluginsDir(uploadDir), secretFile = secretFilePath(uploadDir)}) {
  const runtimes = new Map(), logs = new Map(), errors = new Map();
  const box = createSecretBox(secretFile);
  const uploadEnabled = () => process.env.OPENCRM_PLUGIN_UPLOAD !== '0';
  const eventLag = process.env.NODE_ENV === 'test' ? 0 : 1;

  function log(id, level, message) {
    const list = logs.get(id) || [];
    list.push({at: new Date().toISOString(), level, message: String(message).slice(0, 2000)});
    if (list.length > 200) list.splice(0, list.length - 200);
    logs.set(id, list);
    if (process.env.NODE_ENV !== 'test' || level === 'error') (level === 'error' ? console.error : console.log)(`[plugin ${id}] ${message}`);
  }
  const failure = error => error?.stack && process.env.NODE_ENV !== 'production' ? `${error.message}\n${error.stack.split('\n').slice(1, 4).join('\n')}` : String(error?.message || error);

  async function settingsOf(manifest, row) {
    let stored = {}, secrets = {};
    try { stored = JSON.parse(row?.settings_json || '{}'); } catch {}
    try { secrets = row?.secrets ? box.open(row.secrets) || {} : {}; } catch { log(manifest.id, 'error', 'Не удалось расшифровать секретные настройки: ключ шифрования сменился, укажите их заново'); }
    return Object.fromEntries(manifest.settings.map(field => [field.key, field.type === 'password' ? secrets[field.key] ?? '' : stored[field.key] ?? field.default ?? (field.type === 'boolean' ? false : field.type === 'number' ? null : '')]));
  }

  // ---------- running plugins ----------
  async function deactivate(id, {disable = false} = {}) {
    const runtime = runtimes.get(id);
    runtimes.delete(id);
    if (disable) await db.prepare("UPDATE plugins SET events_json='[]' WHERE id=?").run(id);
    if (!runtime) return;
    for (const timer of runtime.timers) clearInterval(timer);
    runtime.stopped = true;
    for (const cleanup of runtime.cleanups.reverse()) {
      try { await withTimeout(cleanup(), 5000, 'Остановка плагина'); } catch (error) { log(id, 'error', `Остановка: ${failure(error)}`); }
    }
  }

  async function activate(id) {
    await deactivate(id);
    errors.delete(id);
    const row = await db.prepare('SELECT * FROM plugins WHERE id=?').get(id);
    const runtime = {id, events: new Map(), timers: new Set(), cleanups: [], router: express.Router(), publicRouter: express.Router()};
    try {
      const manifest = readInstalledManifest(dir, id);
      runtime.manifest = manifest;
      runtime.settings = await settingsOf(manifest, row);
      const handler = express.Router();
      handler.get('/assets/{*file}', auth, (req, res, next) => assetFile(runtime, req, res, next));
      handler.use('/public', express.urlencoded({extended: false, limit: '1mb'}), express.text({type: 'text/*', limit: '1mb'}), runtime.publicRouter);
      handler.use(auth, runtime.router);
      runtime.handler = handler;
      if (manifest.server) {
        const module = await import(`${pathToFileURL(join(dir, id, manifest.server)).href}?v=${Date.now()}`);
        const start = typeof module.activate === 'function' ? module.activate : typeof module.default === 'function' ? module.default : null;
        if (!start) bad(`${manifest.server} должен экспортировать функцию activate(ctx)`);
        const ctx = context(runtime);
        const stop = await withTimeout(start(ctx), 15000, 'Запуск плагина');
        if (typeof stop === 'function') runtime.cleanups.push(stop);
        if (typeof module.deactivate === 'function') runtime.cleanups.push(() => module.deactivate(ctx));
      }
      runtimes.set(id, runtime);
      runtime.active = true;
      await saveSubscriptions(runtime);
      log(id, 'info', `Запущен, версия ${manifest.version}`);
      return true;
    } catch (error) {
      runtimes.set(id, runtime);
      await deactivate(id, {disable: true});
      errors.set(id, failure(error));
      log(id, 'error', `Не запустился: ${failure(error)}`);
      return false;
    }
  }

  const saveSubscriptions = runtime => db.prepare('UPDATE plugins SET events_json=? WHERE id=?').run(JSON.stringify([...runtime.events.keys()]), runtime.id);

  function assetFile(runtime, req, res, next) {
    const client = runtime.manifest.client;
    if (!client) return next();
    const name = safeEntryName([].concat(req.params.file).join('/'));
    const base = posix.dirname(client);
    if (!name || (base === '.' ? name !== client : !name.startsWith(`${base}/`))) return res.status(404).json({error: 'Файл плагина не найден'});
    res.sendFile(join(dir, runtime.id, name), {dotfiles: 'deny', headers: {'Cache-Control': 'no-cache'}}, error => { if (error && !res.headersSent) res.status(404).json({error: 'Файл плагина не найден'}); });
  }

  function context(runtime) {
    const {id, manifest} = runtime;
    const guard = () => { if (runtime.stopped) throw new Error('Плагин остановлен'); };
    return {
      id, version: manifest.version, manifest, dir: join(dir, id), db,
      settings: runtime.settings,
      router: runtime.router,
      publicRouter: runtime.publicRouter,
      publicPath: path => `/api/plugins/${id}/public${path || ''}`,
      log: {info: message => log(id, 'info', message), warn: message => log(id, 'warn', message), error: message => log(id, 'error', message instanceof Error ? failure(message) : message)},
      on(type, handler) {
        if (!eventTypes.includes(type)) bad(`Неизвестное событие ${type}. Доступны: ${eventTypes.join(', ')}`);
        if (typeof handler !== 'function') bad('Обработчик события должен быть функцией');
        const list = runtime.events.get(type) || [];
        list.push(handler);
        runtime.events.set(type, list);
        if (runtime.active) void saveSubscriptions(runtime).catch(error => log(id, 'error', failure(error)));
      },
      every(ms, task) {
        guard();
        let running = false;
        const timer = setInterval(async () => {
          if (running || runtime.stopped) return;
          running = true;
          try { await task(); } catch (error) { log(id, 'error', `Периодическая задача: ${failure(error)}`); } finally { running = false; }
        }, Math.max(1000, Number(ms) || 0));
        timer.unref?.();
        runtime.timers.add(timer);
        return () => { clearInterval(timer); runtime.timers.delete(timer); };
      },
      storage: {
        async get(key) { const row = await db.prepare('SELECT value_json FROM plugin_storage WHERE plugin_id=? AND key=?').get(id, String(key)); return row ? JSON.parse(row.value_json) : undefined; },
        async set(key, value) {
          const json = JSON.stringify(value ?? null);
          if (String(key).length > 200 || json.length > 1_000_000) bad('Ключ до 200 символов, значение до 1 МБ');
          await db.prepare('INSERT INTO plugin_storage (plugin_id,key,value_json) VALUES (?,?,?) ON CONFLICT (plugin_id,key) DO UPDATE SET value_json=EXCLUDED.value_json,updated_at=CURRENT_TIMESTAMP').run(id, String(key), json);
        },
        async delete(key) { await db.prepare('DELETE FROM plugin_storage WHERE plugin_id=? AND key=?').run(id, String(key)); },
        async list(prefix = '') { return (await db.prepare("SELECT key,value_json FROM plugin_storage WHERE plugin_id=? AND left(key,length(?))=? ORDER BY key LIMIT 1000").all(id, String(prefix), String(prefix))).map(row => ({key: row.key, value: JSON.parse(row.value_json)})); },
      },
      crm: {
        // A request in «Неразобранное»: a manager accepts it into a deal or rejects it.
        async createLead(input = {}) {
          guard();
          const pipelineId = Number(input.pipeline_id) || (await db.prepare('SELECT id FROM pipelines ORDER BY id LIMIT 1').get())?.id;
          if (!await db.prepare('SELECT id FROM pipelines WHERE id=?').get(pipelineId)) bad('Воронка для заявки не найдена');
          const lead = {title: text(input.title, 255), contact_name: text(input.contact_name, 255), company_name: text(input.company_name, 255), phone: text(input.phone, 80), email: text(input.email, 254).toLowerCase(), website: text(input.website, 255), source: text(input.source, 255) || manifest.name, message: text(input.message, 10000)};
          if (!lead.title) lead.title = lead.contact_name || lead.company_name || lead.phone || lead.email;
          if (!lead.title) bad('В заявке нет ни названия, ни контакта');
          if (lead.email && !lead.email.includes('@')) lead.email = '';
          const row = await db.prepare('INSERT INTO inbox_leads (pipeline_id,title,contact_name,company_name,phone,email,website,source,message) VALUES (?,?,?,?,?,?,?,?,?)').run(pipelineId, ...Object.values(lead));
          return {id: row.lastInsertRowid, pipeline_id: pipelineId, ...lead};
        },
        async addDealEvent(dealId, message) {
          guard();
          if (!await db.prepare('SELECT id FROM deals WHERE id=?').get(Number(dealId) || 0)) bad('Сделка не найдена');
          const body = text(message, 2000);
          if (!body) bad('Пустое событие');
          return (await db.prepare('INSERT INTO activity (deal_id,user_id,event) VALUES (?,NULL,?)').run(Number(dealId), `${manifest.name}: ${body}`)).lastInsertRowid;
        },
        async addEntityEvent(type, entityId, message) {
          guard();
          if (!['contact', 'company'].includes(type)) bad('Тип записи: contact или company');
          const body = text(message, 2000);
          if (!body) bad('Пустое событие');
          return (await db.prepare('INSERT INTO entity_activity (entity_type,entity_id,user_id,event) VALUES (?,?,NULL,?)').run(type, Number(entityId), `${manifest.name}: ${body}`)).lastInsertRowid;
        },
        // A call, letter or message in the deal feed, as if an employee had recorded it by hand.
        async addCommunication(dealId, {kind = 'call', direction = 'incoming', subject = '', body = '', user_id = null, created_at} = {}) {
          guard();
          if (!await db.prepare('SELECT id FROM deals WHERE id=?').get(Number(dealId) || 0)) bad('Сделка не найдена');
          if (!['call', 'email', 'message'].includes(kind) || !['incoming', 'outgoing'].includes(direction)) bad('kind: call, email или message; direction: incoming или outgoing');
          const user = Number(user_id) && await db.prepare('SELECT id FROM users WHERE id=?').get(Number(user_id)) ? Number(user_id) : null;
          const at = created_at ? new Date(created_at) : new Date();
          if (Number.isNaN(at.getTime())) bad('created_at — дата');
          const text = body === undefined || body === null ? '' : String(body).slice(0, 20000);
          return (await db.prepare('INSERT INTO deal_communications (deal_id,user_id,kind,direction,subject,body,created_at) VALUES (?,?,?,?,?,?,?)').run(Number(dealId), user, kind, direction, String(subject).slice(0, 255), text || String(subject).slice(0, 255) || '—', at.toISOString().slice(0, 19).replace('T', ' '))).lastInsertRowid;
        },
        async addNote(dealId, message) {
          guard();
          if (!await db.prepare('SELECT id FROM deals WHERE id=?').get(Number(dealId) || 0)) bad('Сделка не найдена');
          const body = text(message, 20000);
          if (!body) bad('Пустое примечание');
          return (await db.prepare('INSERT INTO notes (deal_id,user_id,body) VALUES (?,NULL,?)').run(Number(dealId), body)).lastInsertRowid;
        },
      },
      audit: (action, details = '') => audit(null, `plugin.${id}.${text(action, 60)}`, {actor: `plugin:${id}`, target: `plugin:${id}`, details: text(String(details), 2000)}),
    };
  }

  // Events come from the same queue as webhooks: OpenCRM stores an event while an enabled plugin
  // listens to it. Each plugin keeps its own cursor; a batch is claimed by moving the cursor first,
  // so with several app instances an event goes to one of them.
  let busy = false;
  async function processEvents() {
    if (busy) return 0;
    busy = true;
    let handled = 0;
    try {
      for (const runtime of runtimes.values()) {
        if (!runtime.active || !runtime.events.size) continue;
        const row = await db.prepare('SELECT event_cursor FROM plugins WHERE id=? AND enabled=1').get(runtime.id);
        if (!row) continue;
        const list = await db.prepare("SELECT id,event_type,payload_json,created_at FROM webhook_events WHERE id>? AND event_type IN (SELECT json_array_elements_text(?::json)) AND created_at<=datetime('now',?) ORDER BY id LIMIT 100")
          .all(row.event_cursor, JSON.stringify([...runtime.events.keys()]), `-${eventLag} seconds`);
        if (!list.length) continue;
        const claimed = await db.prepare('UPDATE plugins SET event_cursor=? WHERE id=? AND event_cursor=?').run(list.at(-1).id, runtime.id, row.event_cursor);
        if (!claimed.changes) continue;
        for (const item of list) {
          const payload = {id: Number(item.id), type: item.event_type, created_at: item.created_at, data: JSON.parse(item.payload_json)};
          for (const handler of runtime.events.get(item.event_type) || []) {
            if (runtime.stopped) break;
            try { await withTimeout(handler(payload), 30000, `Событие ${item.event_type}`); handled++; }
            catch (error) { log(runtime.id, 'error', `Событие ${item.event_type} #${item.id}: ${failure(error)}`); }
          }
        }
      }
    } finally { busy = false; }
    return handled;
  }

  // ---------- installed plugins ----------
  function folders() {
    try { return readdirSync(dir, {withFileTypes: true}).filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && idPattern.test(entry.name)).map(entry => entry.name); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  // Folders copied to the plugins directory by hand appear switched off.
  async function discover() {
    const found = [];
    for (const id of folders()) {
      try {
        const manifest = readInstalledManifest(dir, id);
        await db.prepare('INSERT INTO plugins (id,version) VALUES (?,?) ON CONFLICT (id) DO UPDATE SET version=EXCLUDED.version').run(id, manifest.version);
        found.push({id, manifest});
      } catch (error) { found.push({id, error: failure(error)}); }
    }
    return found;
  }

  async function view(item) {
    const row = await db.prepare('SELECT * FROM plugins WHERE id=?').get(item.id);
    const runtime = runtimes.get(item.id);
    const base = {id: item.id, enabled: !!row?.enabled, logs: (logs.get(item.id) || []).slice(-50).reverse()};
    if (!item.manifest) return {...base, name: item.id, version: row?.version || '', status: 'broken', error: item.error, settings_schema: [], settings: {}, endpoints: []};
    const {manifest} = item, values = await settingsOf(manifest, row);
    return {
      ...base, name: manifest.name, version: manifest.version, description: manifest.description, author: manifest.author,
      has_server: !!manifest.server, has_client: !!manifest.client,
      status: runtime?.active ? 'active' : errors.has(item.id) ? 'error' : row?.enabled ? 'stopped' : 'disabled',
      error: errors.get(item.id) || '',
      events: runtime ? [...runtime.events.keys()] : [],
      settings_schema: manifest.settings,
      settings: Object.fromEntries(manifest.settings.map(field => [field.key, field.type === 'password' ? '' : values[field.key]])),
      secrets_set: manifest.settings.filter(field => field.type === 'password' && values[field.key]).map(field => field.key),
      endpoints: manifest.endpoints.map(endpoint => ({...endpoint, url: `/api/plugins/${item.id}/public${endpoint.path}`})),
    };
  }

  async function saveSettings(id, manifest, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) bad('Настройки — объект');
    const row = await db.prepare('SELECT settings_json,secrets FROM plugins WHERE id=?').get(id);
    const current = await settingsOf(manifest, row);
    const plain = {}, secrets = {};
    for (const key of Object.keys(input)) if (!manifest.settings.some(field => field.key === key)) bad(`У плагина нет настройки ${key}`);
    for (const field of manifest.settings) {
      let value = current[field.key];
      if (field.key in input) {
        const raw = input[field.key];
        // An empty password field keeps the saved secret; null clears it.
        if (field.type === 'password') value = raw === null ? '' : raw === '' ? value : coerce(field, raw);
        else value = raw === null ? (field.default ?? '') : coerce(field, raw);
      }
      if (field.required && (value === '' || value === null || value === undefined)) bad(`Заполните «${field.label}»`);
      if (field.type === 'password') { if (value) secrets[field.key] = value; }
      else plain[field.key] = value;
    }
    await db.prepare('UPDATE plugins SET settings_json=?,secrets=? WHERE id=?').run(JSON.stringify(plain), Object.keys(secrets).length ? box.seal(secrets) : '', id);
  }

  const send = (res, error) => {
    if (error instanceof PluginError || error instanceof ZipError) return res.status(error.status || 400).json({error: error.message});
    throw error;
  };
  const find = async id => (await discover()).find(item => item.id === id);

  // ---------- HTTP ----------
  app.get('/api/plugins', auth, async (_req, res) => {
    const list = [];
    for (const runtime of runtimes.values()) {
      if (!runtime.active || !runtime.manifest.client) continue;
      const {manifest} = runtime;
      list.push({id: runtime.id, name: manifest.name, version: manifest.version, client: `/api/plugins/${runtime.id}/assets/${manifest.client}?v=${encodeURIComponent(manifest.version)}`, settings: Object.fromEntries(manifest.settings.filter(field => field.public).map(field => [field.key, runtime.settings[field.key]]))});
    }
    res.json(list.sort((a, b) => a.name.localeCompare(b.name, 'ru')));
  });

  app.get('/api/admin/plugins', auth, admin, async (_req, res) => {
    const items = [];
    for (const item of await discover()) items.push(await view(item));
    res.json({upload_enabled: uploadEnabled(), api_version: pluginApiVersion, events: eventTypes, plugins: items.sort((a, b) => a.name.localeCompare(b.name, 'ru'))});
  });

  app.post('/api/admin/plugins', auth, admin, express.raw({type: () => true, limit: '20mb'}), async (req, res) => {
    try {
      if (!uploadEnabled()) throw new PluginError('Загрузка плагинов через интерфейс выключена (OPENCRM_PLUGIN_UPLOAD=0). Установите плагин на сервере: npm run plugin -- install <файл.zip>', 403);
      if (!Buffer.isBuffer(req.body) || !req.body.length) bad('Пришлите ZIP-архив плагина');
      const pkg = packageFiles(readZip(req.body));
      if (req.query.expect && pkg.manifest.id !== req.query.expect) bad(`В архиве другой плагин («${pkg.manifest.name}», ${pkg.manifest.id}), а не ${req.query.expect}. Для установки нового плагина используйте кнопку «Загрузить плагин» в списке.`);
      const before = await db.prepare('SELECT enabled,version FROM plugins WHERE id=?').get(pkg.manifest.id);
      if (runtimes.has(pkg.manifest.id)) await deactivate(pkg.manifest.id);
      writePackage(dir, pkg);
      await db.prepare('INSERT INTO plugins (id,version) VALUES (?,?) ON CONFLICT (id) DO UPDATE SET version=EXCLUDED.version').run(pkg.manifest.id, pkg.manifest.version);
      await audit(req, before ? 'plugin.updated' : 'plugin.installed', {target: `plugin:${pkg.manifest.id}`, details: `${pkg.manifest.name} ${before ? `${before.version} → ` : ''}${pkg.manifest.version}`});
      if (before?.enabled) await activate(pkg.manifest.id);
      res.status(before ? 200 : 201).json(await view({id: pkg.manifest.id, manifest: pkg.manifest}));
    } catch (error) { send(res, error); }
  });

  app.patch('/api/admin/plugins/:id', auth, admin, async (req, res) => {
    try {
      const item = await find(req.params.id);
      if (!item) throw new PluginError('Плагин не найден', 404);
      const {enabled, settings} = req.body || {};
      if (enabled !== undefined && typeof enabled !== 'boolean') bad('enabled: true или false');
      if (!item.manifest && enabled) bad(`Плагин повреждён: ${item.error}`);
      if (settings !== undefined) {
        await saveSettings(item.id, item.manifest, settings);
        await audit(req, 'plugin.settings_changed', {target: `plugin:${item.id}`, details: Object.keys(settings).join(', ')});
      }
      const row = await db.prepare('SELECT enabled FROM plugins WHERE id=?').get(item.id);
      if (enabled === true && !row.enabled) {
        const values = await settingsOf(item.manifest, await db.prepare('SELECT settings_json,secrets FROM plugins WHERE id=?').get(item.id));
        const missing = item.manifest.settings.find(field => field.required && (values[field.key] === '' || values[field.key] == null));
        if (missing) bad(`Перед включением заполните «${missing.label}»`);
        // A newly enabled plugin receives events from now on, not the backlog.
        await db.prepare('UPDATE plugins SET enabled=1,event_cursor=(SELECT COALESCE(MAX(id),0) FROM webhook_events) WHERE id=?').run(item.id);
        await audit(req, 'plugin.enabled', {target: `plugin:${item.id}`, details: `${item.manifest.name} ${item.manifest.version}`});
        await activate(item.id);
      } else if (enabled === false && row.enabled) {
        await db.prepare('UPDATE plugins SET enabled=0 WHERE id=?').run(item.id);
        await deactivate(item.id, {disable: true});
        errors.delete(item.id);
        log(item.id, 'info', 'Выключен');
        await audit(req, 'plugin.disabled', {target: `plugin:${item.id}`});
      } else if (settings !== undefined && row.enabled) await activate(item.id);
      res.json(await view(item));
    } catch (error) { send(res, error); }
  });

  app.delete('/api/admin/plugins/:id', auth, admin, async (req, res) => {
    try {
      const id = req.params.id;
      if (!idPattern.test(id) || (!await db.prepare('SELECT id FROM plugins WHERE id=?').get(id) && !folders().includes(id))) throw new PluginError('Плагин не найден', 404);
      await deactivate(id, {disable: true});
      rmSync(join(dir, id), {recursive: true, force: true});
      await db.prepare('DELETE FROM plugins WHERE id=?').run(id);
      logs.delete(id);
      errors.delete(id);
      await audit(req, 'plugin.deleted', {target: `plugin:${id}`});
      res.json({ok: true});
    } catch (error) { send(res, error); }
  });

  // Requests to a plugin: /api/plugins/<id>/public/... without a session (incoming webhooks),
  // /api/plugins/<id>/assets/... the browser module, everything else needs a signed-in user.
  app.use('/api/plugins/:pluginId', (req, res, next) => {
    const runtime = runtimes.get(req.params.pluginId);
    if (!runtime?.active) return res.status(404).json({error: 'Плагин не найден или выключен'});
    runtime.handler(req, res, next);
  });

  async function start() {
    await discover();
    for (const row of await db.prepare('SELECT id FROM plugins WHERE enabled=1 ORDER BY id').all()) {
      if (folders().includes(row.id)) await activate(row.id);
      else { errors.set(row.id, 'Папка плагина не найдена'); await db.prepare("UPDATE plugins SET events_json='[]' WHERE id=?").run(row.id); }
    }
    if (process.env.NODE_ENV !== 'test' || process.env.OPENCRM_PLUGIN_WORKER === '1') {
      const timer = setInterval(() => processEvents().catch(error => console.error('Plugin events:', error)), 2000);
      timer.unref();
    }
  }

  return {start, activate, deactivate, processEvents, runtimes, dir};
}
