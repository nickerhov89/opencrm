// One-time move of an amoCRM account into OpenCRM with the amoCRM IDs. See docs/AMOCRM_IMPORT.md.
//
//   node scripts/amocrm-import.mjs export [--dir DIR] [--force]
//       Downloads users, pipelines, fields, companies, contacts, deals, tasks, notes, files and the
//       stage history through the amoCRM API v4 into JSON files in DIR (default data/amocrm-export).
//       Needs AMO_BASE_URL (https://<subdomain>.amocrm.ru) and AMO_ACCESS_TOKEN (long-lived token);
//       AMO_PROXY_URL (http://[user:pass@]host:port) sends the requests through an HTTP CONNECT proxy.
//       AMO_RPS (default 3, at most 7) limits requests per second: the token's limit is shared with
//       other integrations that use it.
//       Files already downloaded are kept, so a broken export continues where it stopped.
//
//   node scripts/amocrm-import.mjs load [--dir DIR] [--dry-run] [--replace] [--keep-default-pipeline]
//       Loads the files into the database of DATABASE_URL in one transaction. --dry-run writes,
//       checks and rolls everything back, printing the same report. --replace first removes deals,
//       contacts, companies, tasks, notes, custom fields, attachments and the pipelines with amoCRM IDs.
//       The report is also saved as DIR/load-report.json.
//
//   node scripts/amocrm-import.mjs history [--dir DIR] [--dry-run]
//       Adds only the card history (field changes, tags, responsible, links, stages...) of the export
//       to a CRM where it is already loaded; everything else stays. History loaded this way before is
//       replaced, history written in OpenCRM stays.
import {writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {createDb} from '../server/db.js';
import {amoClient, exportAccount, readDump, loadDump, loadHistory} from './amocrm-lib.mjs';

const [command, ...args] = process.argv.slice(2);
const flag = name => args.includes(name);
const option = (name, fallback) => { const index = args.indexOf(name); return index >= 0 && args[index + 1] ? args[index + 1] : fallback; };
const dir = resolve(option('--dir', 'data/amocrm-export'));
const usage = 'Использование:\n  node scripts/amocrm-import.mjs export [--dir DIR] [--force]\n  node scripts/amocrm-import.mjs load [--dir DIR] [--dry-run] [--replace] [--keep-default-pipeline]\n  node scripts/amocrm-import.mjs history [--dir DIR] [--dry-run]';

try {
  if (command === 'export') {
    const client = amoClient({baseUrl: process.env.AMO_BASE_URL, token: process.env.AMO_ACCESS_TOKEN || process.env.AMO_TOKEN, proxyUrl: process.env.AMO_PROXY_URL || '', minIntervalMs: Math.ceil(1000 / Math.min(7, Math.max(0.5, Number(process.env.AMO_RPS) || 3))), log: console.log});
    console.log(`Выгрузка из amoCRM в ${dir}${process.env.AMO_PROXY_URL ? ' через прокси' : ''}`);
    const counts = await exportAccount({client, dir, force: flag('--force')});
    console.log(`Готово: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}\nВ файлах персональные данные клиентов: удалите папку после загрузки.`);
  } else if (command === 'load') {
    const dump = await readDump(dir);
    const db = await createDb();
    try {
      console.log(`${flag('--dry-run') ? 'Пробная загрузка (с откатом)' : 'Загрузка'} из ${dir}`);
      const report = await loadDump(db, dump, {dryRun: flag('--dry-run'), replace: flag('--replace'), keepDefaultPipeline: flag('--keep-default-pipeline')});
      await writeFile(join(dir, 'load-report.json'), JSON.stringify(report, null, 2));
      console.log(`\nЗагружено${report.dry_run ? ' (откачено, это пробный прогон)' : ''}:`);
      for (const [table, n] of Object.entries(report.counts)) console.log(`  ${table}: ${n}`);
      if (report.rekeyed_users.length) console.log(`Пользователи OpenCRM с почтой сотрудника amoCRM получили его ID: ${report.rekeyed_users.map(u => `${u.email} (${u.from} → ${u.to})`).join(', ')}`);
      if (report.merged_users.length) console.log(`Пользователи amoCRM с уже существующей почтой привязаны к имеющимся учётным записям: ${report.merged_users.map(u => `${u.email} (amo ${u.amo_id} → ${u.id})`).join(', ')}`);
      if (report.dropped_pipelines.length) console.log(`Удалена пустая стартовая воронка: ${report.dropped_pipelines.join(', ')}`);
      for (const [text, {count, examples}] of Object.entries(report.warnings)) console.log(`Внимание: ${text}: ${count}${examples.length ? ` (например ${examples.join('; ')})` : ''}`);
      console.log(`\nСделки по этапам — в ${join(dir, 'load-report.json')}`);
      if (!report.dry_run) console.log('Пароли сотрудникам: node scripts/admin.mjs reset-password <email> или «Настройки → Пользователи».');
    } finally { await db.close(); }
  } else if (command === 'history') {
    const dump = await readDump(dir);
    if (dump.events_history == null) throw new Error(`В ${dir} нет events_history.json: запустите export ещё раз (уже скачанные файлы не перекачиваются)`);
    const db = await createDb();
    try {
      console.log(`${flag('--dry-run') ? 'Пробная загрузка истории (с откатом)' : 'Загрузка истории'} из ${dir}`);
      const report = await loadHistory(db, dump, {dryRun: flag('--dry-run')});
      console.log(`\nИстория${report.dry_run ? ' (откачено, это пробный прогон)' : ''}: сделки ${report.counts.activity}, контакты и компании ${report.counts.entity_activity}; заменено ранее загруженной ${report.replaced.activity + report.replaced.entity_activity}; пропущено событий записей, которых нет в CRM: ${report.skipped.activity + report.skipped.entity_activity}`);
    } finally { await db.close(); }
  } else { console.error(usage); process.exitCode = 1; }
} catch (error) { console.error(`Ошибка: ${error.message}`); process.exitCode = 1; }
