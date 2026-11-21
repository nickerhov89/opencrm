// Connects a mailbox from the server, without pasting a password or key into the browser.
// Does what Settings → Mail does: checks IMAP and SMTP, stores the secret encrypted, writes the
// security log. The secret is read from a file and is never printed. In Docker:
//   docker compose exec opencrm node scripts/mail-add.mjs --email sales@company.ru --google-sa-file /tmp/sa.json
//
//   --email ADDRESS            the mailbox
//   --google-sa-file FILE      Google Workspace: JSON key of a service account with domain-wide delegation
//   --password-file FILE       IMAP/SMTP: file with the app password (first line), together with
//     --imap-host HOST [--imap-port 993] --smtp-host HOST [--smtp-port 465] [--username LOGIN]
//   --name TEXT                sender name in replies
//   --history-days N           history loaded on the first sync (default 60)
//   --update                   the mailbox is already connected: replace its key or password
//   --sync                     read the mail now instead of waiting for the server (up to two minutes)
import {readFileSync} from 'node:fs';
import {createDb} from '../server/db.js';
import {addMailbox, changeMailbox, createSecretBox, secretFilePath, syncMailbox} from '../server/mail.js';

const args = process.argv.slice(2);
const flag = name => args.includes(name);
const option = name => { const index = args.indexOf(name); return index >= 0 && args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : undefined; };
const usage = 'Использование:\n  node scripts/mail-add.mjs --email ADDRESS --google-sa-file FILE [--name TEXT] [--history-days N] [--update] [--sync]\n  node scripts/mail-add.mjs --email ADDRESS --password-file FILE --imap-host HOST --smtp-host HOST [--imap-port N] [--smtp-port N] [--username LOGIN] [--name TEXT] [--update] [--sync]';
const fail = message => { console.error(message); process.exit(1); };

const email = String(option('--email') || '').trim().toLowerCase();
const saFile = option('--google-sa-file'), passwordFile = option('--password-file');
if (!email || !!saFile === !!passwordFile) fail(usage);
const read = file => { try { return readFileSync(file, 'utf8'); } catch (error) { fail(`Не удалось прочитать ${file}: ${error.code || error.message}`); } };

const body = {email, auth_type: saFile ? 'google_sa' : 'password'};
if (saFile) body.service_account = read(saFile);
else {
  body.password = read(passwordFile).split(/\r?\n/)[0];
  for (const [key, name] of [['imap_host', '--imap-host'], ['imap_port', '--imap-port'], ['smtp_host', '--smtp-host'], ['smtp_port', '--smtp-port'], ['username', '--username']]) if (option(name) !== undefined) body[key] = option(name);
}
if (option('--name') !== undefined) body.name = option('--name');
if (option('--history-days') !== undefined) body.history_days = Number(option('--history-days'));

const db = await createDb();
const box = createSecretBox(secretFilePath());
const audit = (action, target, details) => db.prepare("INSERT INTO audit_log (user_id,actor,action,target,details,ip) VALUES (NULL,'cli',?,?,?,'')").run(action, target, `Команда на сервере; ${details}`);
try {
  const old = await db.prepare('SELECT * FROM mailboxes WHERE email=?').get(email);
  let id;
  if (old) {
    if (!flag('--update')) throw new Error(`Ящик ${email} уже подключён. Чтобы заменить ключ или пароль, добавьте --update`);
    if (old.auth_type !== body.auth_type) throw new Error(`Ящик ${email} подключён другим способом (${old.auth_type}). Отключите его в настройках и подключите заново`);
    const {auth_type, email: _, ...changes} = body;
    const result = await changeMailbox(db, box, old, {...changes, enabled: true});
    await audit('mailbox.updated', `mailbox:${old.id} ${email}`, result.details || 'без изменений');
    id = old.id;
    console.log(`Ящик ${email} обновлён, вход по IMAP и SMTP проверен.`);
  } else {
    const result = await addMailbox(db, box, body);
    await audit('mailbox.created', `mailbox:${result.id} ${email}`, result.details);
    id = result.id;
    console.log(`Ящик ${email} подключён (${result.details}), вход по IMAP и SMTP проверен.`);
  }
  if (flag('--sync')) {
    console.log('Читаем почту…');
    const result = await syncMailbox(db, box, id);
    console.log(`Новых писем: ${result.added ?? 0}, привязано повторной проверкой: ${result.relinked ?? 0}.`);
  } else console.log('Сервер заберёт почту в течение двух минут; ход видно в «Настройки → Почта».');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await db.close?.();
}
