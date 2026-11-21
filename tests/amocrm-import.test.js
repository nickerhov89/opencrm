import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {amoClient, exportAccount, readDump, loadDump} from '../scripts/amocrm-lib.mjs';

// 2025-03-10 09:00 UTC and friends.
const t = (iso) => Math.floor(Date.parse(iso) / 1000);
const statuses = (pipelineId, list) => list.map(([id, name, sort, type = 0]) => ({id, name, sort, type, color: '#99ccff', pipeline_id: pipelineId}));

function fixture() {
  return {
    account: {id: 1, name: 'Agency', subdomain: 'agency', timezone: 'Europe/Moscow', task_types: [{id: 1, name: 'Связаться'}, {id: 2, name: 'Встреча'}, {id: 3001, name: 'Аудит'}, {id: 3002, name: 'Пинг'}]},
    pipelines: [
      {id: 7001, name: 'Первичка', sort: 1, _embedded: {statuses: statuses(7001, [[142, 'Успешно', 10000], [143, 'Отказ', 11000], [5001, 'Неразобранное', 10, 1], [5002, 'Квалификация', 20], [5003, 'КП', 30]])}},
      {id: 7002, name: 'Продления', sort: 2, _embedded: {statuses: statuses(7002, [[142, 'Продлили', 10000], [143, 'Не продлили', 11000], [5101, 'Неразобранное', 10, 1], [5102, 'Переговоры', 20]])}}
    ],
    users: [
      {id: 9001, name: 'Анна', email: 'Anna@Agency.test', rights: {is_admin: true, is_active: true}},
      {id: 9002, name: 'Борис', email: 'boris@agency.test', rights: {is_admin: false, is_active: false}},
      {id: 9003, name: 'Админ (уже есть)', email: 'admin@example.test', rights: {is_admin: true, is_active: true}}
    ],
    custom_fields_leads: [
      {id: 1314379, name: 'Источник', type: 'select', sort: 1, enums: [{id: 1, value: 'Сайт', sort: 1}, {id: 2, value: 'Telegram', sort: 2}]},
      {id: 399447, name: 'utm_source', type: 'tracking_data', sort: 2},
      {id: 1317297, name: 'Дата старта проекта', type: 'date', sort: 3},
      {id: 1317305, name: 'Потенциал продления, ₽', type: 'numeric', sort: 4},
      {id: 1400001, name: 'Услуги', type: 'multiselect', sort: 5, enums: [{id: 5, value: 'SEO', sort: 1}, {id: 6, value: 'Контекст', sort: 2}]},
      {id: 1400002, name: 'Оплачено', type: 'checkbox', sort: 6}
    ],
    custom_fields_contacts: [
      {id: 100, name: 'Телефон', code: 'PHONE', type: 'multitext', sort: 1},
      {id: 101, name: 'Email', code: 'EMAIL', type: 'multitext', sort: 2},
      {id: 102, name: 'Должность', code: 'POSITION', type: 'text', sort: 3},
      {id: 103, name: 'Telegram', type: 'text', sort: 4}
    ],
    custom_fields_companies: [
      {id: 200, name: 'Телефон', code: 'PHONE', type: 'multitext', sort: 1},
      {id: 201, name: 'Web', code: 'WEB', type: 'url', sort: 2},
      {id: 202, name: 'ИНН', type: 'text', sort: 3}
    ],
    companies: [{id: 3001, name: 'ООО Ромашка', responsible_user_id: 9001, created_at: t('2024-01-05T10:00:00Z'), updated_at: t('2024-02-01T10:00:00Z'), custom_fields_values: [{field_id: 200, field_code: 'PHONE', values: [{value: '+7 900 000-00-01'}]}, {field_id: 201, field_code: 'WEB', values: [{value: 'https://romashka.test'}]}, {field_id: 202, field_name: 'ИНН', values: [{value: '7700000000'}]}], _embedded: {tags: [{name: 'VIP'}]}}],
    contacts: [
      {id: 4001, name: 'Иван Петров', responsible_user_id: 9002, created_at: t('2024-01-05T10:05:00Z'), updated_at: t('2024-01-06T10:00:00Z'), custom_fields_values: [{field_id: 100, field_code: 'PHONE', values: [{value: '+7 900 111-11-11'}, {value: '+7 900 222-22-22'}]}, {field_id: 101, field_code: 'EMAIL', values: [{value: 'Ivan@Romashka.test'}]}, {field_id: 102, field_code: 'POSITION', values: [{value: 'Директор'}]}, {field_id: 103, field_name: 'Telegram', values: [{value: '@ivan_p'}]}], _embedded: {companies: [{id: 3001}], tags: []}},
      {id: 4002, name: '', first_name: 'Мария', last_name: 'Сидорова', responsible_user_id: 12345, created_at: t('2024-03-01T00:00:00Z'), updated_at: t('2024-03-01T00:00:00Z'), _embedded: {companies: [{id: 99999}]}}
    ],
    leads: [
      {id: 21000001, name: 'Сайт для Ромашки', price: 150000, responsible_user_id: 9001, created_by: 9001, status_id: 142, pipeline_id: 7001, created_at: t('2025-03-10T09:00:00Z'), updated_at: t('2025-04-01T09:00:00Z'), closed_at: t('2025-04-01T08:00:00Z'), custom_fields_values: [
        {field_id: 1314379, field_name: 'Источник', values: [{value: 'Сайт', enum_id: 1}]},
        {field_id: 399447, field_name: 'utm_source', values: [{value: 'yandex'}]},
        {field_id: 1317297, field_name: 'Дата старта проекта', values: [{value: t('2025-04-14T21:00:00Z')}]},
        {field_id: 1317305, field_name: 'Потенциал продления, ₽', values: [{value: '300 000'}]},
        {field_id: 1400001, field_name: 'Услуги', values: [{value: 'SEO'}, {value: 'Контекст'}]},
        {field_id: 1400002, field_name: 'Оплачено', values: [{value: true}]},
        {field_id: 555, field_name: 'Удалённое поле', values: [{value: 'x'}]}
      ], _embedded: {tags: [{name: 'сайт'}, {name: 'a,b'}], contacts: [{id: 4002, is_main: false}, {id: 4001, is_main: true}], companies: [{id: 3001}]}},
      {id: 21000002, name: 'Продление Ромашки', price: 50000.6, responsible_user_id: 9003, created_by: 0, status_id: 143, pipeline_id: 7002, created_at: t('2025-05-01T09:00:00Z'), updated_at: t('2025-05-20T09:00:00Z'), closed_at: null, custom_fields_values: [{field_id: 1314379, field_name: 'Источник', values: [{value: 'Партнёр'}]}], _embedded: {loss_reason: [{id: 1, name: 'Дорого'}], contacts: [{id: 4001, is_main: true}], companies: []}},
      {id: 21000003, name: '', price: 0, responsible_user_id: 9002, created_by: 9002, status_id: 5001, pipeline_id: 7001, created_at: t('2025-06-01T09:00:00Z'), updated_at: t('2025-06-01T09:00:00Z'), _embedded: {}}
    ],
    tasks: [
      {id: 61000001, entity_type: 'leads', entity_id: 21000001, task_type_id: 2, text: 'Встреча с клиентом\nОбсудить смету и сроки', complete_till: t('2025-03-12T08:00:00Z'), duration: 3600, is_completed: true, result: {text: 'Договорились'}, responsible_user_id: 9001, created_at: t('2025-03-10T09:10:00Z'), updated_at: t('2025-03-12T09:00:00Z')},
      {id: 61000002, entity_type: 'contacts', entity_id: 4001, task_type_id: 3001, text: 'Позвонить', complete_till: t('2025-03-13T20:59:00Z'), duration: 0, is_completed: false, responsible_user_id: 9002, created_at: t('2025-03-10T09:10:00Z'), updated_at: t('2025-03-10T09:10:00Z')},
      {id: 61000003, entity_type: 'leads', entity_id: 99, task_type_id: 3002, text: '', complete_till: t('2025-03-13T10:00:00Z'), is_completed: false, responsible_user_id: 9001, created_at: t('2025-03-10T09:10:00Z'), updated_at: t('2025-03-10T09:10:00Z')}
    ],
    notes_leads: [
      {id: 81000001, entity_id: 21000001, note_type: 'common', params: {text: 'Клиент просит скидку'}, created_by: 9001, created_at: t('2025-03-11T09:00:00Z'), updated_at: t('2025-03-11T09:00:00Z')},
      {id: 81000002, entity_id: 21000001, note_type: 'call_in', params: {phone: '+79001111111', duration: 125, link: 'https://records.test/1.mp3', call_result: 'Поговорили'}, created_by: 9001, created_at: t('2025-03-11T10:00:00Z'), updated_at: t('2025-03-11T10:00:00Z')},
      {id: 81000003, entity_id: 99, note_type: 'common', params: {text: 'чужая'}, created_by: 9001, created_at: t('2025-03-11T10:00:00Z')},
      {id: 81000004, entity_id: 21000001, note_type: 'attachment', params: {file_uuid: 'u1', version_uuid: 'v1', file_name: 'smeta.pdf', original_name: 'Смета.pdf', is_drive_attachment: true}, created_by: 9001, created_at: t('2025-03-12T10:00:00Z')},
      {id: 81000005, entity_id: 21000001, note_type: 'amomail_message', params: {income: true, from: {name: 'Иван', email: 'ivan@romashka.test'}, to: {name: 'Анна', email: 'anna@agency.test'}, subject: 'Смета', content_summary: 'Посмотрите, пожалуйста', attach_cnt: 1}, created_by: 0, created_at: t('2025-03-12T11:00:00Z')},
      {id: 81000006, entity_id: 21000001, note_type: 'extended_service_message', params: {service: {name: 'Tilda'}, text: 'Заявка с сайта'}, created_by: 0, created_at: t('2025-03-12T12:00:00Z')}
    ],
    notes_contacts: [{id: 82000001, entity_id: 4001, note_type: 'common', params: {text: 'Любит звонки после обеда'}, created_by: 9002, created_at: t('2024-01-07T10:00:00Z'), updated_at: t('2024-01-07T10:00:00Z')}],
    notes_companies: [{id: 83000001, entity_id: 3001, note_type: 'service_message', params: {service: 'Робот', text: 'Создана из формы'}, created_by: 0, created_at: t('2024-01-05T10:00:00Z')}],
    events: [
      {id: 'e1', type: 'lead_status_changed', entity_id: 21000001, created_by: 9001, created_at: t('2025-03-11T09:00:00Z'), value_before: [{lead_status: {id: 5001, pipeline_id: 7001}}], value_after: [{lead_status: {id: 5002, pipeline_id: 7001}}]},
      {id: 'e2', type: 'lead_status_changed', entity_id: 21000001, created_by: 9001, created_at: t('2025-04-01T08:00:00Z'), value_before: [{lead_status: {id: 5002, pipeline_id: 7001}}], value_after: [{lead_status: {id: 142, pipeline_id: 7001}}]},
      {id: 'e3', type: 'lead_status_changed', entity_id: 21000002, created_by: 9003, created_at: t('2025-05-20T09:00:00Z'), value_before: [{lead_status: {id: 5101, pipeline_id: 7002}}], value_after: [{lead_status: {id: 143, pipeline_id: 7002}}]},
      {id: 'e4', type: 'lead_status_changed', entity_id: 77777, created_by: 9003, created_at: t('2025-05-20T09:00:00Z'), value_before: [], value_after: [{lead_status: {id: 5101, pipeline_id: 7002}}]}
    ]
  };
}

test('amoCRM client pages through lists, retries and exports to files', async () => {
  const calls = [];
  let failures = 1;
  const pages = {'/api/v4/leads': [[{id: 1}, {id: 2}], [{id: 3}]]};
  const get = async (url, headers) => {
    const u = new URL(url);
    calls.push(u.pathname + u.search);
    if (u.hostname !== 'storage.example.test') assert.equal(headers.Authorization, 'Bearer secret-token');
    if (u.pathname === '/api/v4/leads' && failures-- > 0) return {status: 429, body: ''};
    if (u.pathname === '/api/v4/account') return {status: 200, body: JSON.stringify({id: 1, name: 'A', subdomain: 'a', drive_url: 'https://drive-b.amocrm.ru', datetime_settings: {timezone: 'Europe/Moscow'}, _embedded: {task_types: []}})};
    if (u.pathname === '/api/v4/leads/notes') return {status: 200, body: JSON.stringify({_embedded: {notes: [{id: 5, entity_id: 1, note_type: 'attachment', params: {file_uuid: 'u1', version_uuid: 'v1', file_name: 'a.pdf', original_name: 'Смета.pdf'}}, {id: 6, entity_id: 1, note_type: 'attachment', params: {file_uuid: 'u2', version_uuid: 'v2', file_name: 'b.txt', original_name: 'b.txt'}}]}})};
    if (u.hostname === 'drive-b.amocrm.ru' && u.pathname === '/v1.0/files/u1') return {status: 200, body: JSON.stringify({_links: {download: {href: 'https://drive-b.amocrm.ru/download/u1/v1/a.pdf'}}, metadata: {mime_type: 'application/pdf'}})};
    if (u.hostname === 'drive-b.amocrm.ru' && u.pathname === '/download/u1/v1/a.pdf') return {status: 302, headers: {location: 'https://storage.example.test/blob/1'}, body: ''};
    if (u.hostname === 'storage.example.test') { assert.equal(headers.Authorization, undefined, 'the token stays on amoCRM hosts'); return {status: 200, raw: Buffer.from('%PDF-1'), headers: {'content-type': 'application/octet-stream'}}; }
    if (u.hostname === 'drive-b.amocrm.ru') return {status: 404, body: ''};
    if (u.pathname === '/api/v4/leads/pipelines') return {status: 200, body: JSON.stringify({_embedded: {pipelines: fixture().pipelines}})};
    const list = pages[u.pathname];
    if (!list) return {status: 204, body: ''};
    const page = Number(u.searchParams.get('page'));
    const items = list[page - 1];
    return {status: 200, body: JSON.stringify({_embedded: {leads: items}, _links: page < list.length ? {next: {href: 'x'}} : {}})};
  };
  const client = amoClient({baseUrl: 'https://agency.amocrm.ru', token: 'secret-token', minIntervalMs: 0, get});
  const dir = mkdtempSync(join(tmpdir(), 'opencrm-amo-export-'));
  const counts = await exportAccount({client, dir, log: () => {}});
  assert.equal(counts.leads, 3);
  assert.equal(counts.contacts, 0);
  assert.equal(counts.files, 1);
  assert.equal(readFileSync(join(dir, 'files', '5'), 'utf8'), '%PDF-1');
  assert.ok(calls.includes('/download/u2/v2/b.txt'), 'without a download link the known Drive path is tried');
  assert.ok(calls.includes('/api/v4/leads?with=contacts%2Closs_reason&limit=250&page=2'));
  assert.ok(calls.some(c => c.startsWith('/api/v4/events?filter%5Btype%5D=lead_status_changed&limit=100')));
  const dump = await readDump(dir);
  assert.deepEqual(dump.leads.map(l => l.id), [1, 2, 3]);
  assert.deepEqual(dump.files.map(f => [f.note_id, f.name, f.mime_type, f.size, !!f.error]), [[5, 'Смета.pdf', 'application/pdf', 6, false], [6, 'b.txt', undefined, undefined, true]]);
  // A second run downloads only the account and pipelines again.
  calls.length = 0;
  await exportAccount({client, dir, log: () => {}});
  assert.deepEqual(calls.map(c => c.split('?')[0]), ['/api/v4/account', '/api/v4/leads/pipelines', '/v1.0/files/u2', '/download/u2/v2/b.txt'], 'only the failed file is tried again');
  assert.equal(dump.account.timezone, 'Europe/Moscow');
  assert.throws(() => amoClient({baseUrl: 'http://agency.amocrm.ru', token: 'x'}), /https/);
});

test('amoCRM load keeps IDs, maps won/lost per pipeline and leaves a working CRM', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opencrm-amo-load-'));
  process.env.PGLITE_DIR = join(directory, 'pg');
  process.env.UPLOAD_DIR = join(directory, 'uploads');
  process.env.NODE_ENV = 'test';
  process.env.OPENCRM_ALLOW_LOCAL_WEBHOOKS = '1';
  const {app, db} = await import('../server/index.js');
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  let cookie = '';
  async function call(path, {method = 'GET', body, status = 200, key} = {}) {
    const response = await fetch(base + path, {method, headers: {'Content-Type': 'application/json', ...(key ? {Authorization: `Bearer ${key}`} : cookie ? {Cookie: cookie} : {})}, body: body == null ? undefined : JSON.stringify(body)});
    const text = await response.text();
    assert.equal(response.status, status, `${method} ${path}: ${text}`);
    if (!key && response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return text ? JSON.parse(text) : null;
  }
  const one = async (sql, ...params) => (await db.query(sql, params)).rows[0];
  try {
    await call('/setup', {method: 'POST', body: {name: 'Admin', email: 'admin@example.test', password: 'test-password-123'}});
    const key = (await call('/integrations/keys', {method: 'POST', body: {name: 'Portal', scopes: ['deals:read', 'deals:write', 'contacts:read', 'companies:read', 'tasks:read', 'users:read']}, status: 201})).token;
    await call('/integrations/webhooks', {method: 'POST', body: {name: 'Hook', url: 'http://127.0.0.1:9/hook', events: ['deal.created', 'deal.updated', 'contact.created', 'task.created']}, status: 201});
    const admin = await one('SELECT id FROM users WHERE email=$1', 'admin@example.test');
    const quiet = () => {};
    const uploads = process.env.UPLOAD_DIR;
    const filePath = join(directory, 'smeta.bin');
    writeFileSync(filePath, 'PDF-CONTENT');
    const withFiles = () => ({...fixture(), files: [
      {note_id: 81000004, entity: 'leads', entity_id: 21000001, created_by: 9001, created_at: t('2025-03-12T10:00:00Z'), name: 'Смета.pdf', mime_type: 'application/pdf', size: 11, path: filePath},
      {note_id: 81000007, entity: 'leads', entity_id: 21000001, name: 'lost.doc', error: 'HTTP 404'}
    ]});
    const uploaded = () => existsSync(uploads) ? readdirSync(uploads) : [];

    // Dry run: full report, nothing stays.
    const dry = await loadDump(db, withFiles(), {dryRun: true, log: quiet});
    assert.equal(dry.counts.attachments, 1);
    assert.equal(dry.attachment_bytes, 11);
    assert.deepEqual(uploaded(), [], 'a dry run copies no files');
    assert.equal(dry.dry_run, true);
    assert.equal(dry.counts.deals, 3);
    assert.equal(Number((await one('SELECT COUNT(*) n FROM deals')).n), 0);
    assert.equal(Number((await one('SELECT COUNT(*) n FROM pipelines WHERE id=7001')).n), 0);

    const report = await loadDump(db, withFiles(), {log: quiet});
    assert.deepEqual(report.counts, {users: 2, pipelines: 2, stages: 9, custom_fields: 8, companies: 1, contacts: 2, deals: 3, deal_contacts: 3, custom_field_values: 9, tasks: 3, notes: 5, entity_notes: 2, deal_stage_changes: 6, attachments: 1});
    assert.deepEqual(report.rekeyed_users, [{email: 'admin@example.test', from: admin.id, to: 9003}]);
    assert.deepEqual(report.merged_users, []);
    assert.equal(Number((await one('SELECT COUNT(*) n FROM users WHERE email=$1', 'admin@example.test')).n), 1);
    assert.equal(Number((await one('SELECT id FROM users WHERE email=$1', 'admin@example.test')).id), 9003);
    assert.equal(Number((await one('SELECT COUNT(*) n FROM sessions WHERE user_id=9003')).n), 1, 'the signed-in session follows the new ID');
    assert.ok(Number((await one('SELECT COUNT(*) n FROM audit_log WHERE user_id=9003')).n) > 0);
    await call('/me');
    assert.equal(report.dropped_pipelines.length, 1, 'the empty seed pipeline is removed');
    assert.equal(Number((await one("SELECT COUNT(*) n FROM pipelines WHERE name='Воронка — новые лиды'")).n), 0);
    assert.ok(report.warnings['Значения удалённых полей пропущены']);
    assert.ok(report.warnings['Варианты списков добавлены из значений']);
    assert.equal(report.warnings['Задачи без найденной записи перенесены без привязки'].count, 1);
    assert.equal(report.warnings['Файлы, которые не удалось скачать'].count, 1);
    const attachment = await one("SELECT id,entity_type,entity_id,user_id,filename,mime_type,byte_size,stored_name,created_at FROM attachments");
    assert.deepEqual({...attachment, id: undefined, stored_name: undefined, entity_id: Number(attachment.entity_id), user_id: Number(attachment.user_id), byte_size: Number(attachment.byte_size)}, {id: undefined, stored_name: undefined, entity_type: 'deal', entity_id: 21000001, user_id: 9001, filename: 'Смета.pdf', mime_type: 'application/pdf', byte_size: 11, created_at: '2025-03-12 10:00:00'});
    assert.deepEqual(uploaded(), [attachment.stored_name]);
    const downloaded = await fetch(`${base}/attachments/${attachment.id}/download`, {headers: {Cookie: cookie}});
    assert.equal(downloaded.status, 200);
    assert.equal(await downloaded.text(), 'PDF-CONTENT');

    // Users: amo IDs, no login, inactive disabled; an existing e-mail reuses that account.
    const anna = await one('SELECT id,email,role,password_hash,disabled_at FROM users WHERE id=9001');
    assert.deepEqual({...anna, id: Number(anna.id)}, {id: 9001, email: 'anna@agency.test', role: 'admin', password_hash: 'x:y', disabled_at: null});
    assert.ok((await one('SELECT disabled_at FROM users WHERE id=9002')).disabled_at);

    // Pipelines and stages keep their IDs; 142/143 become per-pipeline won/lost stages.
    const {won: won1, lost: lost1} = report.closing_stages[7001], {won: won2, lost: lost2} = report.closing_stages[7002];
    assert.equal(new Set([won1, lost1, won2, lost2]).size, 4);
    const stages = (await db.query('SELECT id,name,kind,sort_order FROM stages WHERE pipeline_id=7001 ORDER BY sort_order')).rows.map(s => [Number(s.id), s.name, s.kind]);
    assert.deepEqual(stages, [[5001, 'Неразобранное', 'active'], [5002, 'Квалификация', 'active'], [5003, 'КП', 'active'], [won1, 'Успешно', 'won'], [lost1, 'Отказ', 'lost']]);

    // Deals through the API.
    const deal = await call('/v1/deals/21000001', {key});
    assert.equal(deal.stage_id, won1);
    assert.equal(deal.pipeline_id, 7001);
    assert.equal(deal.amount, 150000);
    assert.equal(deal.contact_id, 4001);
    assert.deepEqual([...deal.contact_ids].sort(), [4001, 4002]);
    assert.equal(deal.company_id, 3001);
    assert.equal(deal.owner_id, 9001);
    assert.equal(deal.created_at, '2025-03-10 09:00:00');
    assert.equal(deal.closed_at, '2025-04-01 08:00:00');
    assert.equal(deal.tags, 'сайт, a b');
    assert.deepEqual(deal.custom_fields.find(f => f.id === 1314379), {id: 1314379, name: 'Источник', field_type: 'select', value: 'Сайт'});
    const values = Object.fromEntries((await db.query('SELECT field_id,value FROM custom_field_values WHERE entity_id=21000001')).rows.map(r => [Number(r.field_id), r.value]));
    assert.deepEqual(values, {1314379: 'Сайт', 399447: 'yandex', 1317297: '2025-04-15', 1317305: '300000', 1400001: 'SEO, Контекст', 1400002: 'Да'});
    assert.deepEqual(JSON.parse((await one('SELECT options_json FROM custom_fields WHERE id=1314379')).options_json), ['Сайт', 'Telegram', 'Партнёр']);
    const lost = await call('/v1/deals/21000002', {key});
    assert.equal(lost.stage_id, lost2);
    assert.equal(lost.loss_reason, 'Дорого');
    assert.equal(lost.amount, 50001);
    assert.equal(lost.owner_id, 9003, 'the existing account now has the amoCRM ID');
    assert.equal(lost.closed_at, '2025-05-20 09:00:00');
    const unnamed = await call('/v1/deals/21000003', {key});
    assert.equal(unnamed.name, 'Сделка #21000003');
    assert.equal(unnamed.closed_at, null);

    // Contacts and companies.
    const ivan = await call('/v1/contacts/4001', {key});
    assert.equal(ivan.phone, '+7 900 111-11-11, +7 900 222-22-22');
    assert.equal(ivan.email, 'ivan@romashka.test');
    assert.equal(ivan.position, 'Директор');
    assert.equal(ivan.telegram, '@ivan_p');
    assert.equal(ivan.company_id, 3001);
    const maria = await one('SELECT name,company_id,owner_id FROM contacts WHERE id=4002');
    assert.deepEqual(maria, {name: 'Мария Сидорова', company_id: null, owner_id: null});
    const company = await one('SELECT name,phone,website,tags FROM companies WHERE id=3001');
    assert.deepEqual(company, {name: 'ООО Ромашка', phone: '+7 900 000-00-01', website: 'https://romashka.test', tags: 'VIP'});
    assert.equal((await one('SELECT value FROM custom_field_values WHERE field_id=202 AND entity_id=3001')).value, '7700000000');

    // Tasks keep IDs, types, description, all-day and results.
    const meeting = await call('/v1/tasks/61000001', {key});
    assert.equal(meeting.title, 'Встреча с клиентом');
    assert.equal(meeting.description, 'Встреча с клиентом\nОбсудить смету и сроки');
    assert.equal(meeting.task_type, 'Встреча');
    assert.equal(meeting.deal_id, 21000001);
    assert.equal(meeting.duration_minutes, 60);
    assert.equal(meeting.completed, true);
    assert.equal(meeting.completion_result, 'Договорились');
    const call2 = await call('/v1/tasks/61000002', {key});
    assert.equal(call2.task_type, 'Аудит');
    assert.equal(call2.all_day, true);
    assert.equal(call2.contact_id, 4001);
    const orphan = await call('/v1/tasks/61000003', {key});
    assert.equal(orphan.title, 'пинг');
    assert.equal(orphan.task_type, 'пинг', 'custom types matching a preset use its spelling');
    assert.equal(orphan.deal_id, null);

    // Notes keep IDs; calls become readable text.
    const notes = await call('/v1/deals/21000001/notes', {key});
    const list = notes.items;
    assert.deepEqual(list.map(n => n.id).sort(), [81000001, 81000002, 81000004, 81000005, 81000006]);
    assert.equal(list.find(n => n.id === 81000005).body, 'Входящее письмо\nОт: Иван <ivan@romashka.test>\nКому: Анна <anna@agency.test>\nТема: Смета\nВложений: 1\n\nПосмотрите, пожалуйста');
    assert.equal(list.find(n => n.id === 81000006).body, 'Tilda: Заявка с сайта');
    assert.equal(list.find(n => n.id === 81000004).body, 'Файл: Смета.pdf');
    assert.deepEqual(Object.fromEntries(list.map(n => [n.id, n.note_type])), {81000001: 'common', 81000002: 'call_in', 81000004: 'attachment', 81000005: 'amomail_message', 81000006: 'extended_service_message'});
    assert.deepEqual((await call('/v1/deals/21000001/notes?note_type=common', {key})).items.map(n => n.id), [81000001]);
    assert.deepEqual((await call('/v1/notes?entity_type=deal&note_type=call_in', {key})).items.map(n => n.id), [81000002]);
    assert.deepEqual((await call('/v1/contacts/4001/notes?note_type=common', {key})).items.map(n => [n.id, n.note_type]), [[82000001, 'common']]);
    assert.equal((await call('/v1/notes?entity_type=company', {key})).items[0].note_type, 'service_message');
    assert.match(list.find(n => n.id === 81000002).body, /Входящий звонок[\s\S]*Длительность: 2:05[\s\S]*https:\/\/records\.test\/1\.mp3/);
    assert.equal((await one('SELECT body FROM entity_notes WHERE id=83000001')).body, 'Робот: Создана из формы');

    // Stage history with creation rows and per-pipeline won/lost.
    const history = (await db.query('SELECT deal_id,from_stage_id,to_stage_id,to_pipeline_id,user_id,changed_at FROM deal_stage_changes ORDER BY deal_id,changed_at,id')).rows.map(r => [Number(r.deal_id), r.from_stage_id === null ? null : Number(r.from_stage_id), Number(r.to_stage_id), Number(r.to_pipeline_id), r.user_id === null ? null : Number(r.user_id), r.changed_at]);
    assert.deepEqual(history, [
      [21000001, null, 5001, 7001, 9001, '2025-03-10 09:00:00'],
      [21000001, 5001, 5002, 7001, 9001, '2025-03-11 09:00:00'],
      [21000001, 5002, won1, 7001, 9001, '2025-04-01 08:00:00'],
      [21000002, null, 5101, 7002, null, '2025-05-01 09:00:00'],
      [21000002, 5101, lost2, 7002, 9003, '2025-05-20 09:00:00'],
      [21000003, null, 5001, 7001, 9002, '2025-06-01 09:00:00']
    ]);
    const changes = await call('/v1/stage-changes?deal_id=21000001', {key});
    assert.equal(changes.items.length, 3);

    // Triggers were off: no webhooks for loaded rows, timestamps kept.
    assert.equal(Number((await one('SELECT COUNT(*) n FROM webhook_events')).n), 0);
    assert.equal((await one('SELECT updated_at FROM deals WHERE id=21000001')).updated_at, '2025-04-01 09:00:00');

    // After the load the CRM works as usual: new IDs above amo ones, triggers back on.
    const created = await call('/v1/deals', {method: 'POST', key, body: {name: 'Новая', stage_id: 5002}, status: 201});
    assert.equal((await call(`/v1/deals/${created.id}/notes`, {method: 'POST', key, body: {body: 'Руками'}, status: 201})).note_type, 'common', 'notes written here are common');
    assert.ok(created.id > 21000003);
    await call('/v1/deals/21000003/stage', {method: 'PATCH', key, body: {stage_id: 5002}});
    assert.equal(Number((await one('SELECT COUNT(*) n FROM deal_stage_changes WHERE deal_id=21000003')).n), 2);
    assert.ok(Number((await one('SELECT COUNT(*) n FROM webhook_events')).n) >= 1);

    // A second load needs --replace; with it the data is replaced, users and keys stay.
    await assert.rejects(loadDump(db, fixture(), {log: quiet}), /--replace/);
    const firstStored = attachment.stored_name;
    const again = await loadDump(db, withFiles(), {replace: true, log: quiet});
    assert.equal(again.counts.attachments, 1);
    const storedNow = (await one('SELECT stored_name FROM attachments')).stored_name;
    assert.notEqual(storedNow, firstStored);
    assert.deepEqual(uploaded(), [storedNow], '--replace removes the files of the replaced records');
    assert.equal(again.counts.users, 0, 'users from the first load are reused by e-mail');
    assert.equal(Number((await one('SELECT COUNT(*) n FROM deals')).n), 3);
    assert.equal(Number((await one('SELECT COUNT(*) n FROM deal_stage_changes')).n), 6);
    await call('/v1/deals/21000001', {key});
  } finally {
    server.close();
    await db.close();
  }
});

test('amoCRM client goes directly to hosts the proxy refuses', async () => {
  const seen = [];
  const get = async (url, headers, proxy) => {
    const host = new URL(url).hostname;
    seen.push(`${host} ${proxy ? 'proxy' : 'direct'}`);
    if (proxy && host === 'drive-b.amocrm.ru') throw new Error('proxy CONNECT 403');
    if (host === 'storage.example.test' && proxy) throw new Error('timeout');
    if (host === 'drive-b.amocrm.ru' && new URL(url).pathname.startsWith('/download')) return {status: 301, headers: {location: 'https://storage.example.test/f'}, body: ''};
    if (host === 'storage.example.test') return {status: 200, raw: Buffer.from('data'), headers: {}};
    return {status: 200, body: '{"ok":true}', headers: {}};
  };
  const client = amoClient({baseUrl: 'https://agency.amocrm.ru', token: 't', proxyUrl: 'http://proxy.example.test:3128', minIntervalMs: 0, get});
  assert.deepEqual(await client.request('https://drive-b.amocrm.ru/v1.0/files/u1'), {ok: true});
  assert.deepEqual(await client.request('https://drive-b.amocrm.ru/v1.0/files/u2'), {ok: true});
  assert.deepEqual(seen.splice(0), ['drive-b.amocrm.ru proxy', 'drive-b.amocrm.ru direct', 'drive-b.amocrm.ru direct'], 'a refused host is remembered');
  assert.equal(String((await client.download('https://drive-b.amocrm.ru/download/u1')).data), 'data');
  assert.deepEqual(seen, ['drive-b.amocrm.ru direct', 'storage.example.test direct'], 'files go directly first');
  await client.request('/api/v4/account');
  assert.equal(seen.at(-1), 'agency.amocrm.ru proxy', 'the API still goes through the proxy');
});
