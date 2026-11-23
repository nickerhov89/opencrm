import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const t = iso => Math.floor(Date.parse(iso) / 1000);
const statuses = list => list.map(([id, name, sort, type = 0]) => ({id, name, sort, type, color: '#99ccff', pipeline_id: 7001}));

function baseDump() {
  return {
    account: {timezone: 'Europe/Moscow', task_types: []},
    pipelines: [{id: 7001, name: 'Первичка', sort: 1, _embedded: {statuses: statuses([[5001, 'Неразобранное', 10, 1], [5002, 'Взять в работу', 20], [5003, 'Квалификация', 30], [142, 'Успешно', 10000], [143, 'Отказ', 11000]])}}],
    users: [{id: 9001, name: 'Анна', email: 'anna@agency.test', rights: {is_admin: true, is_active: true}}, {id: 9002, name: 'Борис', email: 'boris@agency.test', rights: {is_active: true}}],
    custom_fields_leads: [{id: 1314379, name: 'Источник', type: 'select', sort: 1, enums: [{id: 1, value: 'Сайт', sort: 1}, {id: 2, value: 'Реклама', sort: 2}]}, {id: 1317000, name: 'Канал', type: 'text', sort: 2}],
    custom_fields_contacts: [{id: 100, name: 'Телефон', code: 'PHONE', type: 'multitext', sort: 1}],
    custom_fields_companies: [],
    companies: [{id: 3001, name: 'ООО Ромашка', responsible_user_id: 9001, created_at: t('2025-01-01T10:00:00Z'), updated_at: t('2025-01-01T10:00:00Z')}],
    contacts: [{id: 4001, name: 'Иван', responsible_user_id: 9001, created_at: t('2025-01-01T10:00:00Z'), updated_at: t('2025-01-01T10:00:00Z'), custom_fields_values: [{field_id: 100, field_code: 'PHONE', values: [{value: '+7 900 111-11-11'}]}], _embedded: {companies: [{id: 3001}]}}],
    leads: [{id: 21000001, name: 'Сайт для Ромашки', price: 100000, responsible_user_id: 9001, created_by: 9001, status_id: 5002, pipeline_id: 7001, created_at: t('2025-11-20T09:00:00Z'), updated_at: t('2025-11-20T09:00:00Z'),
      custom_fields_values: [{field_id: 1314379, values: [{value: 'Сайт', enum_id: 1}]}], _embedded: {tags: [{name: 'сайт'}], contacts: [{id: 4001, is_main: true}], companies: [{id: 3001}]}}],
    tasks: [{id: 61000001, entity_type: 'leads', entity_id: 21000001, task_type_id: 1, text: 'Позвонить', complete_till: t('2025-11-25T08:00:00Z'), is_completed: false, responsible_user_id: 9001, created_at: t('2025-11-20T09:00:00Z'), updated_at: t('2025-11-20T09:00:00Z')}],
    notes_leads: [], notes_contacts: [], notes_companies: [], events: [], events_history: [], event_types: [], files: []
  };
}

// Answers like amoCRM API v4; `changes` is what «changed since the cursor» returns.
function fakeAmo(dump) {
  const state = {changes: {}, records: {}};
  const lists = {'/api/v4/companies': 'companies', '/api/v4/contacts': 'contacts', '/api/v4/leads': 'leads', '/api/v4/tasks': 'tasks', '/api/v4/leads/notes': 'notes_leads', '/api/v4/contacts/notes': 'notes_contacts', '/api/v4/companies/notes': 'notes_companies', '/api/v4/events': 'events_history'};
  const client = {
    requests: [],
    async request(path) {
      if (path === '/api/v4/account') return {datetime_settings: {timezone: dump.account.timezone}, _embedded: {task_types: []}};
      if (path === '/api/v4/leads/pipelines') return {_embedded: {pipelines: dump.pipelines}};
      if (path === '/api/v4/events/types') return {_embedded: {events_types: []}};
      if (state.records[path]) return structuredClone(state.records[path]);
      throw new Error(`unexpected ${path}`);
    },
    async list(path, _key, params) {
      client.requests.push([path, params]);
      if (path === '/api/v4/users') return dump.users;
      const fields = /^\/api\/v4\/(leads|contacts|companies)\/custom_fields$/.exec(path);
      if (fields) return dump[`custom_fields_${fields[1]}`];
      if (lists[path]) return structuredClone(state.changes[lists[path]] || []);
      throw new Error(`unexpected list ${path}`);
    }
  };
  return {client, state};
}

test('amoCRM sync: dry run, copy to OpenCRM by state, conflicts, deletion', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opencrm-amo-sync-'));
  const {createDb} = await import('../server/db.js');
  const {loadDump} = await import('../scripts/amocrm-lib.mjs');
  const {runSyncCycle, syncStatus, syncLog, planRecord} = await import('../server/amocrm-sync.js');
  const db = await createDb({dataDir: join(dir, 'pg'), url: ''});
  try {
    const dump = baseDump();
    await loadDump(db, dump, {log: () => {}, uploads: join(dir, 'uploads')});
    for (const [table, start] of [['deals', 50000000], ['contacts', 50000000], ['companies', 50000000], ['tasks', 50000000], ['notes', 500000000], ['entity_notes', 500000000]]) await db.query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), ${start})`);
    // Robots that must not react to the sync, and a field that only OpenCRM has.
    await db.query("INSERT INTO stage_automations (stage_id,task_title,due_days) VALUES (5003,'Задача этапа',1)");
    await db.query(`INSERT INTO deal_distribution_rules (name,origins_json,user_ids_json,active) VALUES ('Все','["api","manual","inbox"]','[9002]',1)`);
    const own = Number((await db.query("INSERT INTO custom_fields (entity_type,name,field_type) VALUES ('deal','Внутреннее','text') RETURNING id")).rows[0].id);
    await db.query("INSERT INTO custom_field_values (field_id,entity_id,value) VALUES ($1,21000001,'только у нас')", [own]);
    const deal = async id => (await db.query('SELECT d.*,(SELECT value FROM custom_field_values WHERE field_id=1317000 AND entity_id=d.id) channel FROM deals d WHERE id=$1', [id])).rows[0];
    const {client, state} = fakeAmo(dump);
    const config = mode => ({mode, primary: 'amo', overlapSec: 0, since: t('2026-11-23T16:19:41Z'), defaultOwner: null});
    const changedLead = {...dump.leads[0], name: 'Сайт для Ромашки (новый)', status_id: 5003, updated_by: 9002, updated_at: t('2026-11-23T17:00:00Z'), custom_fields_values: [{field_id: 1314379, values: [{value: 'Реклама', enum_id: 2}]}, {field_id: 1317000, values: [{value: 'Вебинар'}]}]};
    const newLead = {id: 21000002, name: 'Новая заявка', price: 0, responsible_user_id: 9002, created_by: 9002, status_id: 5002, pipeline_id: 7001, created_at: t('2026-11-23T17:01:00Z'), updated_at: t('2026-11-23T17:01:00Z'), _embedded: {contacts: [{id: 4001, is_main: true}]}};
    state.changes = {
      leads: [changedLead, newLead],
      notes_leads: [{id: 117000001, entity_id: 21000002, note_type: 'call_in', params: {phone: '+79001111111', duration: 65}, created_by: 9002, created_at: t('2026-11-23T17:02:00Z'), updated_at: t('2026-11-23T17:02:00Z')}],
      events_history: [{id: 'ev1', type: 'lead_added', entity_type: 'lead', entity_id: 21000002, created_by: 9002, created_at: t('2026-11-23T17:01:00Z'), value_before: [], value_after: []}]
    };

    // dry_run: only the log; repeated reads of the same changes are not logged again.
    const dry = await runSyncCycle(db, client, config('dry_run'), {log: () => {}});
    assert.deepEqual([dry.created, dry.updated, dry.notes], [1, 1, 1]);
    assert.equal((await deal(21000001)).name, 'Сайт для Ромашки', 'dry run changes nothing');
    assert.equal(await deal(21000002), undefined);
    const plan = (await syncLog(db, {action: 'update'})).items;
    assert.equal(plan.length, 1);
    assert.equal(plan[0].dry_run, true);
    assert.deepEqual(plan[0].details.fields, {name: 'Сайт для Ромашки (новый)', stage_id: 5003, 'cf:1314379': 'Реклама', 'cf:1317000': 'Вебинар'});
    assert.equal(client.requests.find(([path]) => path === '/api/v4/leads')[1]['filter[updated_at][from]'], t('2026-11-23T16:19:41Z'), 'the first run reads from AMOCRM_SYNC_SINCE');
    const again = await runSyncCycle(db, client, config('dry_run'), {log: () => {}});
    assert.deepEqual([again.created, again.updated], [0, 0]);

    // amo_to_opencrm: the same changes are written, records keep the amoCRM numbers.
    const real = await runSyncCycle(db, client, config('amo_to_opencrm'), {log: () => {}});
    assert.deepEqual([real.created, real.updated, real.errors], [1, 1, 0]);
    const changed = await deal(21000001);
    assert.deepEqual([changed.name, Number(changed.stage_id), changed.source, changed.channel], ['Сайт для Ромашки (новый)', 5003, 'Реклама', 'Вебинар']);
    assert.equal((await db.query('SELECT value FROM custom_field_values WHERE field_id=$1 AND entity_id=21000001', [own])).rows[0].value, 'только у нас', 'fields amoCRM does not have stay');
    const moved = (await db.query('SELECT user_id FROM deal_stage_changes WHERE deal_id=21000001 AND to_stage_id=5003')).rows[0];
    assert.equal(Number(moved.user_id), 9002, 'the stage history names the amoCRM employee');
    const created = await deal(21000002);
    assert.deepEqual([created.name, Number(created.owner_id), Number(created.contact_id), created.created_at], ['Новая заявка', 9002, 4001, '2026-11-23 17:01:00']);
    assert.equal(Number((await db.query('SELECT COUNT(*) n FROM tasks WHERE deal_id = ANY($1)', [[21000001, 21000002]])).rows[0].n), 1, 'no stage task, only the amoCRM task');
    assert.equal(Number((await db.query('SELECT COUNT(*) n FROM deal_distribution_queue')).rows[0].n), 0, 'nothing is distributed');
    assert.equal((await db.query('SELECT note_type FROM notes WHERE id=117000001')).rows[0].note_type, 'call_in');
    assert.equal((await db.query("SELECT event FROM activity WHERE amo_event_id='ev1'")).rows[0].event, 'Сделка создана');
    const repeat = await runSyncCycle(db, client, config('amo_to_opencrm'), {log: () => {}});
    assert.deepEqual([repeat.created, repeat.updated, repeat.notes, repeat.conflicts], [0, 0, 0, 0], 'a record read again matches its snapshot');
    assert.equal(Number((await db.query("SELECT COUNT(*) n FROM activity WHERE amo_event_id='ev1'")).rows[0].n), 1);

    // Both sides changed the budget: amoCRM wins, the lost value goes to a note. Tags changed only here: kept.
    await db.query("UPDATE deals SET amount=999, tags='сайт, срочно' WHERE id=21000001");
    state.changes = {leads: [{...changedLead, price: 500, updated_at: t('2026-11-23T18:00:00Z')}]};
    const clash = await runSyncCycle(db, client, config('amo_to_opencrm'), {log: () => {}});
    assert.deepEqual([clash.updated, clash.conflicts, clash.pending], [1, 1, 1]);
    assert.deepEqual([Number((await deal(21000001)).amount), (await deal(21000001)).tags], [500, 'сайт, срочно']);
    assert.match((await db.query("SELECT body FROM notes WHERE deal_id=21000001 AND body LIKE 'Синхронизация%'")).rows[0].body, /«Бюджет»: в OpenCRM было 999, из amoCRM 500/);
    assert.deepEqual((await syncLog(db, {action: 'pending_to_amo'})).items.at(-1).details.fields, ['tags']);

    // Deleted in amoCRM: moved to the trash here.
    state.changes = {events_history: [{id: 'ev2', type: 'lead_deleted', entity_type: 'lead', entity_id: 21000002, created_by: 9002, created_at: t('2026-11-23T19:00:00Z'), value_before: [], value_after: []}]};
    const gone = await runSyncCycle(db, client, config('amo_to_opencrm'), {log: () => {}});
    assert.equal(gone.deleted, 1);
    assert.ok((await deal(21000002)).deleted_at);

    const status = await syncStatus(db, config('amo_to_opencrm'));
    assert.equal(status.mode, 'amo_to_opencrm');
    assert.equal(status.conflicts_last_hour, 1);
    assert.equal(status.errors_last_hour, 0);
    assert.ok(status.lag_seconds.amo_to_opencrm >= 0 && status.lag_seconds.amo_to_opencrm < 60);

    // A stage new in amoCRM is created here, so the deal is not put into the first stage.
    dump.pipelines[0]._embedded.statuses.push({id: 5004, name: 'Встреча', sort: 35, type: 0, color: '#ffcc99', pipeline_id: 7001});
    state.changes = {leads: [{...changedLead, price: 500, status_id: 5004, updated_at: t('2026-11-23T19:30:00Z')}]};
    const staged = await runSyncCycle(db, client, config('amo_to_opencrm'), {log: () => {}});
    assert.equal(staged.errors, 0);
    assert.equal(Number((await deal(21000001)).stage_id), 5004);
    assert.deepEqual((await db.query('SELECT id FROM stages WHERE pipeline_id=7001 ORDER BY sort_order')).rows.map(row => Number(row.id)).slice(0, 4), [5001, 5002, 5003, 5004], 'in the amoCRM order');

    // A record that fails is retried by its ID later, even though the cursor moved on.
    const late = {...newLead, id: 60000001, name: 'Номер выше счётчика'};
    state.changes = {leads: [late]};
    const failedRun = await runSyncCycle(db, client, config('amo_to_opencrm'), {log: () => {}});
    assert.deepEqual([failedRun.errors, failedRun.retrying], [1, 1]);
    assert.equal(Number((await db.query("SELECT attempts FROM amocrm_sync_retry WHERE entity_type='deal' AND amo_id=60000001")).rows[0].attempts), 1);
    await db.query("SELECT setval(pg_get_serial_sequence('deals', 'id'), 70000000)");
    await db.query('UPDATE amocrm_sync_retry SET next_at=0');
    state.changes = {};
    state.records['/api/v4/leads/60000001'] = late;
    const retried = await runSyncCycle(db, client, config('amo_to_opencrm'), {log: () => {}});
    assert.deepEqual([retried.created, retried.errors, retried.retrying], [1, 0, 0]);
    assert.equal((await deal(60000001)).name, 'Номер выше счётчика');
    assert.equal(Number((await db.query('SELECT COUNT(*) n FROM amocrm_sync_retry')).rows[0].n), 0);
    assert.equal((await syncStatus(db, config('amo_to_opencrm'))).retry_queue, 0);

    // A task deleted in amoCRM goes to the trash.
    state.changes = {events_history: [{id: 'ev3', type: 'task_deleted', entity_type: 'task', entity_id: 61000001, created_by: 9001, created_at: t('2026-11-23T20:00:00Z'), value_before: [], value_after: []}]};
    assert.equal((await runSyncCycle(db, client, config('amo_to_opencrm'), {log: () => {}})).deleted, 1);
    assert.ok((await db.query('SELECT deleted_at FROM tasks WHERE id=61000001')).rows[0].deleted_at);

    // With OpenCRM as the primary CRM its value stays on a conflict.
    const kept = planRecord({amount: 1}, {amount: 2}, {amount: 3}, 'opencrm');
    assert.deepEqual([kept.apply, kept.conflicts[0].kept, kept.next], [{}, 'opencrm', {amount: 3}]);
  } finally {
    await db.close();
    rmSync(dir, {recursive: true, force: true});
  }
});
