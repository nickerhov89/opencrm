// Connected mailboxes. Every few minutes the worker reads new mail over IMAP into the emails table
// and links each letter to a deal: first by thread (In-Reply-To / References point at a letter that
// already belongs to a deal), then by address (from, to or cc is the e-mail of a contact or company;
// the contact's open deal wins, otherwise its latest one). Letters without a deal are kept unlinked
// and are checked again on every sync. Replies from a deal go out over SMTP from the same mailbox.
//
// Two ways to sign in: IMAP/SMTP with a password (an app password for Gmail, Yandex, Mail.ru...) or
// a Google service account with domain-wide delegation (XOAUTH2, the mailbox is impersonated).
// Passwords and keys are stored encrypted with AES-256-GCM; the key is OPENCRM_SECRET_KEY or, when
// it is not set, a random key in <data>/secret.key (next to the uploads, outside the backups).
import {createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, sign} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';

// The mail libraries load on first use, so they do not slow down the start of the server.
let libraries;
const mailLibraries = async () => libraries ??= {ImapFlow: (await import('imapflow')).ImapFlow, nodemailer: (await import('nodemailer')).default, simpleParser: (await import('mailparser')).default.simpleParser, htmlToText: (await import('html-to-text')).convert};
const googleTokenUrl = 'https://oauth2.googleapis.com/token';
const googleServers = {imap_host: 'imap.gmail.com', imap_port: 993, smtp_host: 'smtp.gmail.com', smtp_port: 465};
const maxSource = 2 * 1024 * 1024;   // bytes of a letter read for headers and text; attachments come from BODYSTRUCTURE
const maxBody = 200000;              // characters of text kept per letter
const previewBody = 4000;            // characters sent with the deal card; the rest on request
const fetchChunk = 20;

// Tests replace these to run without real servers.
export const mailHooks = {
  imapClient: async options => new (await mailLibraries()).ImapFlow(options),
  smtpTransport: async options => (await mailLibraries()).nodemailer.createTransport(options),
  fetch: (...args) => fetch(...args),
};

export class MailError extends Error { constructor(status, message) { super(message); this.status = status; } }
const bad = message => { throw new MailError(400, message); };

// ---------- secrets ----------
export function createSecretBox(file) {
  let key;
  const load = () => {
    if (key) return key;
    if (process.env.OPENCRM_SECRET_KEY) return key = createHash('sha256').update(process.env.OPENCRM_SECRET_KEY).digest();
    const read = () => { try { return readFileSync(file, 'utf8').trim(); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
    let text = read();
    if (text == null) {
      mkdirSync(dirname(file), {recursive: true});
      try { writeFileSync(file, randomBytes(32).toString('hex'), {mode: 0o600, flag: 'wx'}); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      text = read();
    }
    if (!/^[0-9a-f]{64}$/i.test(text || '')) throw new Error(`Файл ключа шифрования повреждён: ${file}`);
    return key = Buffer.from(text, 'hex');
  };
  return {
    seal(value) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', load(), iv);
      const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
      return `v1.${Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url')}`;
    },
    open(text) {
      if (!text) return null;
      try {
        const raw = Buffer.from(String(text).replace(/^v1\./, ''), 'base64url');
        const decipher = createDecipheriv('aes-256-gcm', load(), raw.subarray(0, 12));
        decipher.setAuthTag(raw.subarray(12, 28));
        return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'));
      } catch { throw new Error('Не удалось расшифровать пароль ящика: ключ шифрования сменился. Укажите пароль или ключ заново'); }
    },
  };
}

// ---------- Google service account (domain-wide delegation) ----------
const tokenCache = new Map();
export function parseServiceAccount(raw) {
  let value = raw;
  if (typeof raw === 'string') { try { value = JSON.parse(raw); } catch { bad('Ключ сервисного аккаунта: вставьте JSON-файл ключа целиком'); } }
  if (!value || typeof value !== 'object' || value.type !== 'service_account' || typeof value.client_email !== 'string' || !value.client_email.includes('@') || typeof value.private_key !== 'string' || !value.private_key.includes('PRIVATE KEY')) bad('Ключ сервисного аккаунта: нужен JSON с type=service_account, client_email и private_key');
  return {client_email: value.client_email.trim(), private_key: value.private_key, client_id: String(value.client_id || '')};
}
export async function googleAccessToken(account, user, now = Date.now) {
  const cacheKey = `${account.client_email}|${user}`, hit = tokenCache.get(cacheKey);
  if (hit && hit.expires > now() + 60000) return hit.token;
  const iat = Math.floor(now() / 1000), part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${part({alg: 'RS256', typ: 'JWT'})}.${part({iss: account.client_email, sub: user, scope: 'https://mail.google.com/', aud: googleTokenUrl, iat, exp: iat + 3600})}`;
  let signature;
  try { signature = sign('RSA-SHA256', Buffer.from(unsigned), account.private_key).toString('base64url'); }
  catch { throw new Error('Ключ сервисного аккаунта не подходит: не удалось подписать запрос'); }
  const response = await mailHooks.fetch(googleTokenUrl, {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams({grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}`}).toString(), signal: AbortSignal.timeout(20000)});
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw new Error(`Google не дал доступ к ${user}: ${[data.error, data.error_description].filter(Boolean).join(' — ') || `HTTP ${response.status}`}. Проверьте делегирование домена и scope https://mail.google.com/`);
  tokenCache.set(cacheKey, {token: data.access_token, expires: now() + (Number(data.expires_in) || 3600) * 1000});
  return data.access_token;
}

async function signIn(mailbox, secret) {
  if (mailbox.auth_type === 'google_sa') {
    const accessToken = await googleAccessToken(secret.service_account, mailbox.email);
    return {imap: {user: mailbox.email, accessToken}, smtp: {type: 'OAuth2', user: mailbox.email, accessToken}};
  }
  const user = mailbox.username || mailbox.email;
  return {imap: {user, pass: secret.password}, smtp: {user, pass: secret.password}};
}
// Only for local test servers with self-signed certificates (GreenMail and the like).
const tls = () => process.env.OPENCRM_MAIL_INSECURE_TLS === '1' ? {tls: {rejectUnauthorized: false}} : {};
async function imapOptions(mailbox, secret) {
  return {host: mailbox.imap_host, port: Number(mailbox.imap_port), secure: Number(mailbox.imap_port) !== 143, auth: (await signIn(mailbox, secret)).imap, logger: false, connectionTimeout: 30000, greetingTimeout: 20000, socketTimeout: 300000, ...tls()};
}
async function smtpOptions(mailbox, secret) {
  const port = Number(mailbox.smtp_port);
  const starttls = [25, 587, 2525].includes(port);   // other ports: TLS from the first byte, as on 465
  return {host: mailbox.smtp_host, port, secure: !starttls, requireTLS: starttls, auth: (await signIn(mailbox, secret)).smtp, connectionTimeout: 30000, greetingTimeout: 20000, socketTimeout: 120000, ...tls()};
}

// ---------- parsing ----------
const lower = value => String(value || '').trim().toLowerCase();
export const validEmail = value => typeof value === 'string' && value.length <= 254 && /^[^\s@<>(),;:"\[\]\\]+@[^\s@<>(),;:"\[\]\\]+\.[^\s@<>(),;:"\[\]\\]+$/.test(value);
const json = (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } };
const stamp = date => (date instanceof Date && Number.isFinite(date.getTime()) ? date : new Date()).toISOString().slice(0, 19).replace('T', ' ');
const messageIds = value => [].concat(value || []).flatMap(item => String(item).match(/<[^<>\s]{1,500}>/g) || []);
function addresses(field) {
  const out = [];
  const walk = list => { for (const item of list || []) { if (item.group) walk(item.group); else if (validEmail(lower(item.address))) out.push({address: lower(item.address), name: String(item.name || '').trim().slice(0, 200)}); } };
  for (const object of [].concat(field || [])) walk(object.value);
  return out;
}
function structureAttachments(node, out = []) {
  if (!node) return out;
  if (node.childNodes?.length) { for (const child of node.childNodes) structureAttachments(child, out); return out; }
  const filename = node.dispositionParameters?.filename || node.parameters?.name || '';
  if (node.disposition === 'attachment' || filename && node.disposition !== 'inline' && !/^text\/(plain|html)$/i.test(node.type || '')) {
    const size = Number(node.size) || 0;
    out.push({filename: String(filename || 'Без имени').slice(0, 255), content_type: String(node.type || 'application/octet-stream').slice(0, 120), size: lower(node.encoding) === 'base64' ? Math.round(size * 3 / 4 * 76 / 78) : size});
  }
  return out;
}
const cleanText = text => String(text || '').replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

export async function parseMessage(source, {mailboxEmail, uid, folder, mailboxId, validity, internalDate, bodyStructure}) {
  const {simpleParser, htmlToText} = await mailLibraries();
  const parsed = await simpleParser(source, {skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true});
  const from = addresses(parsed.from)[0] || {address: '', name: ''};
  const text = parsed.text?.trim() ? parsed.text : parsed.html ? htmlToText(parsed.html, {wordwrap: false, selectors: [{selector: 'img', format: 'skip'}, {selector: 'a', options: {ignoreHref: true}}]}) : '';
  const attachments = bodyStructure ? structureAttachments(bodyStructure) : (parsed.attachments || []).filter(item => !item.related && item.contentDisposition !== 'inline').map(item => ({filename: String(item.filename || 'Без имени').slice(0, 255), content_type: String(item.contentType || 'application/octet-stream').slice(0, 120), size: Number(item.size) || 0}));
  return {
    message_id: messageIds(parsed.messageId)[0] || `<opencrm.${mailboxId}.${validity}.${uid}@missing-message-id>`,
    in_reply_to: messageIds(parsed.inReplyTo)[0] || '',
    references: messageIds(parsed.references).slice(-50),
    from_address: from.address, from_name: from.name,
    reply_to: addresses(parsed.replyTo)[0]?.address || '',
    to: addresses(parsed.to).slice(0, 100), cc: addresses(parsed.cc).slice(0, 100),
    subject: String(parsed.subject || '').trim().slice(0, 998),
    body: cleanText(text).slice(0, maxBody),
    attachments: attachments.slice(0, 100),
    sent_at: stamp(parsed.date || internalDate),
    direction: lower(from.address) === lower(mailboxEmail) ? 'outgoing' : 'incoming',
    folder, uid,
  };
}

// ---------- linking ----------
async function connectedAddresses(db) {
  return new Set((await db.prepare('SELECT email FROM mailboxes').all()).map(row => lower(row.email)));
}
// Every address stored on a live contact or company (amoCRM loads keep several, comma-separated).
async function knownAddresses(db) {
  const rows = await db.prepare("SELECT email FROM contacts WHERE deleted_at IS NULL AND email<>'' UNION ALL SELECT email FROM companies WHERE deleted_at IS NULL AND email<>''").all();
  return new Set(rows.flatMap(row => lower(row.email).split(/[,;\s]+/)).filter(Boolean));
}
// Subject without Re:/Fwd: prefixes and Instantly-style [#XXXXXXXX] tags, for the subject rule.
export function subjectKey(subject) {
  let text = String(subject || '').replace(/\[#[^\]\s]{1,40}\]/g, ' '), previous;
  do { previous = text; text = text.replace(/^\s*(re|fwd?|aw|wg|ответ|отв|пересл|переслано)\s*(\[\d+\]|\(\d+\))?\s*:\s*/i, ''); } while (text !== previous);
  return text.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 300);
}
const participants = (letter, own) => [...new Set([letter.from_address, letter.reply_to, ...letter.to.map(item => item.address), ...letter.cc.map(item => item.address)].map(lower))].filter(address => address && !own.has(address));
// Free mail services: only the exact address of a contact counts there, not the whole domain.
const publicDomains = new Set(['gmail.com', 'googlemail.com', 'mail.ru', 'bk.ru', 'list.ru', 'inbox.ru', 'internet.ru', 'yandex.ru', 'ya.ru', 'yandex.com', 'yandex.by', 'yandex.kz', 'yandex.ua', 'narod.ru', 'rambler.ru', 'lenta.ru', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com', 'yahoo.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'gmx.de', 'gmx.net', 'zoho.com', 'mail.com', 'ukr.net', 'tut.by', 'qq.com', '163.com']);
const domainOf = address => lower(address).split('@')[1] || '';
// A letter of a deal is incoming when it comes from the deal's client: the e-mail of its contact or
// company, or another address on the same (non-public) domain. Everything else is ours: connected
// mailboxes, outreach mailboxes, managers. Without a deal only connected mailboxes count as ours.
export async function letterDirection(db, letter, dealId, own) {
  const from = lower(letter.from_address);
  if (own.has(from)) return 'outgoing';
  if (!dealId) return 'incoming';
  const rows = await db.prepare(`SELECT c.email FROM contacts c WHERE c.deleted_at IS NULL AND (c.id IN (SELECT dc.contact_id FROM deal_contacts dc WHERE dc.deal_id=?) OR c.id=(SELECT d.contact_id FROM deals d WHERE d.id=?))
    UNION ALL SELECT co.email FROM companies co JOIN deals d ON d.company_id=co.id WHERE d.id=? AND co.deleted_at IS NULL`).all(dealId, dealId, dealId);
  const client = new Set(rows.flatMap(row => lower(row.email).split(/[,;\s]+/)).filter(address => address.includes('@')));
  if (client.has(from)) return 'incoming';
  const domain = domainOf(from);
  return domain && !publicDomains.has(domain) && [...client].some(address => domainOf(address) === domain) ? 'incoming' : 'outgoing';
}
const emailListSql = column => `string_to_array(regexp_replace(lower(${column}),'[;\\s]+',',','g'),',')`;
export async function findDeal(db, letter, {own, known}) {
  const refs = [...new Set([letter.in_reply_to, ...(letter.references || [])].filter(Boolean))];
  if (refs.length) {
    const parent = await db.prepare(`SELECT e.deal_id FROM emails e JOIN deals d ON d.id=e.deal_id WHERE d.deleted_at IS NULL AND e.message_id IN (${refs.map(() => '?').join(',')}) ORDER BY e.sent_at DESC,e.id DESC LIMIT 1`).get(...refs);
    if (parent) return {deal_id: parent.deal_id, linked_by: 'thread'};
  }
  const people = participants(letter, own).filter(address => !known || known.has(address));
  if (!people.length) return await bySubject(db, letter, own);
  const list = `ARRAY[${people.map(() => '?').join(',')}]::text[]`;
  const deal = await db.prepare(`SELECT d.id,
      CASE WHEN EXISTS(SELECT 1 FROM contacts c WHERE c.deleted_at IS NULL AND (c.id=d.contact_id OR c.id IN (SELECT dc.contact_id FROM deal_contacts dc WHERE dc.deal_id=d.id)) AND ${emailListSql('c.email')} && ${list}) THEN 1 ELSE 0 END by_contact
    FROM deals d JOIN stages s ON s.id=d.stage_id
    WHERE d.deleted_at IS NULL AND (
      EXISTS(SELECT 1 FROM contacts c WHERE c.deleted_at IS NULL AND (c.id=d.contact_id OR c.id IN (SELECT dc.contact_id FROM deal_contacts dc WHERE dc.deal_id=d.id)) AND ${emailListSql('c.email')} && ${list})
      OR EXISTS(SELECT 1 FROM companies co WHERE co.deleted_at IS NULL AND co.id=d.company_id AND ${emailListSql('co.email')} && ${list}))
    ORDER BY by_contact DESC, CASE WHEN s.kind='active' THEN 0 ELSE 1 END, d.updated_at DESC, d.id DESC LIMIT 1`).get(...people, ...people, ...people);
  return deal ? {deal_id: deal.id, linked_by: 'address'} : await bySubject(db, letter, own);
}
// Last resort for threads with incomplete References (Instantly): the same subject with the same
// correspondent within 60 days. Only when all such letters point to one deal.
async function bySubject(db, letter, own) {
  const key = letter.subject_key ?? subjectKey(letter.subject), partners = participants(letter, own);
  if (key.length < 3 || !partners.length) return null;
  const at = Date.parse(String(letter.sent_at || '').replace(' ', 'T') + 'Z'), since = stamp(new Date((Number.isFinite(at) ? at : Date.now()) - 60 * 864e5));
  const rows = await db.prepare('SELECT e.deal_id,e.from_address,e.reply_to,e.to_json,e.cc_json FROM emails e JOIN deals d ON d.id=e.deal_id WHERE d.deleted_at IS NULL AND e.subject_key=? AND e.sent_at>=? AND e.message_id<>? ORDER BY e.sent_at DESC LIMIT 500').all(key, since, letter.message_id || '');
  const deals = new Set(rows.filter(row => participants({from_address: row.from_address, reply_to: row.reply_to, to: json(row.to_json, []), cc: json(row.cc_json, [])}, own).some(address => partners.includes(address))).map(row => row.deal_id));
  return deals.size === 1 ? {deal_id: [...deals][0], linked_by: 'subject'} : null;
}

async function storeLetter(db, letter, {mailboxId, userId = null, dealId, linkedBy, read = false}) {
  const result = await db.prepare(`INSERT INTO emails (mailbox_id,deal_id,linked_by,direction,message_id,in_reply_to,references_json,from_address,from_name,reply_to,to_json,cc_json,subject,subject_key,body,attachments_json,sent_at,user_id,folder,uid,read_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CASE WHEN ? THEN now_text() END) ON CONFLICT (message_id) DO NOTHING`).run(mailboxId, dealId ?? null, dealId ? linkedBy : '', letter.direction, letter.message_id, letter.in_reply_to, JSON.stringify(letter.references), letter.from_address, letter.from_name, letter.reply_to, JSON.stringify(letter.to), JSON.stringify(letter.cc), letter.subject, subjectKey(letter.subject), letter.body, JSON.stringify(letter.attachments), letter.sent_at, userId, letter.folder || '', letter.uid ?? null, read || letter.direction === 'outgoing' ? 1 : 0);
  return result.changes;
}

// Unlinked letters of the last days get another chance: a contact may have been added since, or a
// later letter of the same thread may have found its deal.
export async function relinkUnlinked(db, {days = 60, now = Date.now} = {}) {
  const since = stamp(new Date(now() - days * 864e5)), own = await connectedAddresses(db), known = await knownAddresses(db);
  const rows = await db.prepare('SELECT id,message_id,from_address,reply_to,to_json,cc_json,in_reply_to,references_json,subject_key,sent_at FROM emails WHERE deal_id IS NULL AND sent_at>=? ORDER BY sent_at,id LIMIT 20000').all(since);
  const linkedSubjects = new Set((await db.prepare("SELECT DISTINCT e.subject_key FROM emails e WHERE e.deal_id IS NOT NULL AND e.subject_key<>'' AND e.subject_key IN (SELECT u.subject_key FROM emails u WHERE u.deal_id IS NULL AND u.sent_at>=?)").all(since)).map(row => row.subject_key));
  const threadParents = new Set((await db.prepare(`SELECT p.message_id FROM emails p JOIN deals d ON d.id=p.deal_id WHERE d.deleted_at IS NULL AND p.message_id IN (SELECT e.in_reply_to FROM emails e WHERE e.deal_id IS NULL AND e.sent_at>=? UNION SELECT jsonb_array_elements_text(e.references_json::jsonb) FROM emails e WHERE e.deal_id IS NULL AND e.sent_at>=?)`).all(since, since)).map(row => row.message_id));
  let linked = 0;
  for (const row of rows) {
    const letter = {message_id: row.message_id, from_address: row.from_address, reply_to: row.reply_to, to: json(row.to_json, []), cc: json(row.cc_json, []), in_reply_to: row.in_reply_to, references: json(row.references_json, []), subject_key: row.subject_key, sent_at: row.sent_at};
    const thread = [letter.in_reply_to, ...letter.references].some(id => threadParents.has(id));
    const people = [letter.from_address, letter.reply_to, ...letter.to.map(item => item.address), ...letter.cc.map(item => item.address)].some(address => address && !own.has(address) && known.has(address));
    if (!thread && !people && !linkedSubjects.has(row.subject_key)) continue;
    const found = await findDeal(db, letter, {own, known});
    if (!found) continue;
    linked += (await db.prepare('UPDATE emails SET deal_id=?,linked_by=?,direction=? WHERE id=? AND deal_id IS NULL').run(found.deal_id, found.linked_by, await letterDirection(db, letter, found.deal_id, own), row.id)).changes;
  }
  return linked;
}

// ---------- IMAP sync ----------
async function syncFolders(client) {
  const folders = await client.list();
  const all = folders.find(folder => folder.specialUse === '\\All');
  if (all) return [all.path];   // Gmail: "All Mail" holds inbox and sent mail in one place
  const sent = folders.find(folder => folder.specialUse === '\\Sent');
  return ['INBOX', ...(sent ? [sent.path] : [])];
}

const running = new Set();
export async function syncMailbox(db, box, id, {now = Date.now} = {}) {
  if (running.has(id)) return {skipped: true};
  running.add(id);
  let client;
  try {
    const mailbox = await db.prepare('SELECT * FROM mailboxes WHERE id=?').get(id);
    if (!mailbox || !mailbox.enabled) return {skipped: true};
    const state = json(mailbox.sync_state, {}), own = await connectedAddresses(db), known = await knownAddresses(db);
    let added = 0;
    try {
      client = await mailHooks.imapClient(await imapOptions(mailbox, box.open(mailbox.secret)));
      await client.connect();
      for (const path of await syncFolders(client)) {
        const lock = await client.getMailboxLock(path);
        try {
          const validity = String(client.mailbox.uidValidity);
          let folder = state[path], uids;
          if (!folder || folder.validity !== validity) {
            folder = state[path] = {validity, last: 0};
            uids = await client.search({since: new Date(now() - Number(mailbox.history_days) * 864e5)}, {uid: true}) || [];
          } else {
            uids = (await client.search({uid: `${folder.last + 1}:*`}, {uid: true}) || []).filter(uid => uid > folder.last);
          }
          uids = [...new Set(uids)].sort((a, b) => a - b);
          for (let index = 0; index < uids.length; index += fetchChunk) {
            const chunk = uids.slice(index, index + fetchChunk), messages = [];
            for await (const message of client.fetch(chunk.join(','), {uid: true, flags: true, internalDate: true, bodyStructure: true, source: {maxLength: maxSource}}, {uid: true})) messages.push(message);
            messages.sort((a, b) => a.uid - b.uid);
            for (const message of messages) {
              if (message.flags?.has?.('\\Draft') || !message.source) continue;
              const letter = await parseMessage(message.source, {mailboxEmail: mailbox.email, uid: message.uid, folder: path, mailboxId: mailbox.id, validity, internalDate: message.internalDate, bodyStructure: message.bodyStructure});
              if (await db.prepare('SELECT 1 FROM emails WHERE message_id=?').get(letter.message_id)) continue;
              const found = await findDeal(db, letter, {own, known});
              letter.direction = await letterDirection(db, letter, found?.deal_id, own);
              added += await storeLetter(db, letter, {mailboxId: mailbox.id, dealId: found?.deal_id, linkedBy: found?.linked_by, read: !!message.flags?.has?.('\\Seen')});
            }
            folder.last = Math.max(folder.last, ...chunk);
            await db.prepare('UPDATE mailboxes SET sync_state=? WHERE id=?').run(JSON.stringify(state), mailbox.id);
          }
        } finally { lock.release(); }
      }
      const relinked = await relinkUnlinked(db, {days: Number(mailbox.history_days), now});
      await db.prepare("UPDATE mailboxes SET last_sync_at=CURRENT_TIMESTAMP,last_error='' WHERE id=?").run(mailbox.id);
      return {added, relinked};
    } catch (error) {
      await db.prepare('UPDATE mailboxes SET last_sync_at=CURRENT_TIMESTAMP,last_error=? WHERE id=?').run(String(error?.message || error).slice(0, 500), mailbox.id);
      throw error;
    }
  } finally {
    running.delete(id);
    if (client) await client.logout().catch(() => client.close?.());
  }
}

export async function syncAll(db, box) {
  for (const {id} of await db.prepare('SELECT id FROM mailboxes WHERE enabled=1 ORDER BY id').all()) {
    await syncMailbox(db, box, id).catch(error => console.error(`Почта, ящик ${id}:`, error.message));
  }
}

// ---------- sending ----------
const reSubject = subject => /^\s*(re|ответ)\s*(\[\d+\])?\s*:/i.test(subject) ? subject : `Re: ${subject}`;
// Reply goes to Reply-To or From of the letter; for our own sent letter, to its recipients (as mail
// apps do). "Reply all" adds the other recipients, without the sending mailbox itself.
export function replyRecipients(letter, mailboxEmail, all = false) {
  const self = lower(mailboxEmail), ours = lower(letter.from_address) === self;
  const to = ours ? letter.to.map(item => item.address) : [letter.reply_to || letter.from_address];
  const cc = !all ? [] : ours ? letter.cc.map(item => item.address) : [...letter.to, ...letter.cc].map(item => item.address);
  const unique = list => [...new Set(list.map(lower))].filter(address => address && validEmail(address));
  const toList = unique(to).filter(address => address !== self);
  return {to: toList, cc: unique(cc).filter(address => address !== self && !toList.includes(address))};
}
function quote(letter) {
  const when = new Date(letter.sent_at.replace(' ', 'T') + 'Z').toLocaleString('ru-RU', {timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit'});
  const lines = letter.body.split('\n').slice(0, 300).map(line => `> ${line}`).join('\n');
  return `${when}, ${letter.from_name ? `${letter.from_name} <${letter.from_address}>` : letter.from_address} пишет:\n${lines}`;
}

async function deliver(db, box, mailbox, {to, cc, subject, text, inReplyTo = '', references = []}) {
  const messageId = `<${randomUUID()}@${mailbox.email.split('@')[1]}>`;
  const transport = await mailHooks.smtpTransport(await smtpOptions(mailbox, box.open(mailbox.secret)));
  try {
    await transport.sendMail({from: {name: mailbox.name || '', address: mailbox.email}, to, cc: cc.length ? cc : undefined, subject, text, messageId, ...(inReplyTo ? {inReplyTo, references: references.join(' ')} : {})});
  } catch (error) {
    throw new MailError(502, `Письмо не отправлено: ${String(error?.response || error?.message || error).slice(0, 300)}`);
  } finally { transport.close?.(); }
  return {direction: 'outgoing', message_id: messageId, in_reply_to: inReplyTo, references, from_address: lower(mailbox.email), from_name: mailbox.name || '', reply_to: '', to: to.map(address => ({address, name: ''})), cc: cc.map(address => ({address, name: ''})), subject, body: text.slice(0, maxBody), attachments: [], sent_at: stamp(new Date()), folder: '', uid: null};
}
const recipientList = (list, name, required) => {
  if (list === undefined || list === null) list = [];
  if (!Array.isArray(list) || list.length > 50 || list.some(item => !validEmail(lower(item)))) bad(`${name}: список адресов e-mail`);
  const unique = [...new Set(list.map(lower))];
  if (required && !unique.length) bad('Укажите получателя');
  return unique;
};
// A new letter (not a reply) from a connected mailbox; with dealId it goes to that deal, otherwise
// the usual address rules find one.
export async function sendNew(db, box, {mailboxId, user, to, cc, subject, text, dealId = null}) {
  const mailbox = await db.prepare('SELECT * FROM mailboxes WHERE id=? AND enabled=1').get(Number(mailboxId) || 0);
  if (!mailbox) bad('Выберите подключённый ящик');
  const toList = recipientList(to, 'to', true), ccList = recipientList(cc, 'cc').filter(address => !toList.includes(address));
  if (typeof subject !== 'string' || subject.length > 998) bad('Тема: до 998 символов');
  if (typeof text !== 'string' || !text.trim() || text.length > 50000) bad('Напишите текст письма');
  const sent = await deliver(db, box, mailbox, {to: toList, cc: ccList, subject: subject.trim(), text: text.trim()});
  const own = await connectedAddresses(db);
  const found = dealId ? {deal_id: dealId, linked_by: 'sent'} : await findDeal(db, sent, {own});
  await storeLetter(db, sent, {mailboxId: mailbox.id, userId: user.id, dealId: found?.deal_id, linkedBy: found?.linked_by});
  return await db.prepare('SELECT * FROM emails WHERE message_id=?').get(sent.message_id);
}

export async function sendReply(db, box, {original, user, text, to, cc, all = false, withQuote = true}) {
  const mailbox = original.mailbox_id && await db.prepare('SELECT * FROM mailboxes WHERE id=?').get(original.mailbox_id);
  if (!mailbox) throw new MailError(409, 'Ящик этого письма отключён от CRM — ответить из карточки нельзя');
  if (!mailbox.enabled) throw new MailError(409, `Ящик ${mailbox.email} выключен в настройках почты`);
  const letter = emailRow(original);
  const defaults = replyRecipients(letter, mailbox.email, all);
  const check = (list, name) => { if (list === undefined) return undefined; if (!Array.isArray(list) || list.length > 50 || list.some(item => !validEmail(lower(item)))) bad(`${name}: список адресов e-mail`); return [...new Set(list.map(lower))]; };
  const toList = check(to, 'to') ?? defaults.to, ccList = check(cc, 'cc') ?? defaults.cc;
  if (!toList.length) bad('Укажите получателя');
  if (typeof text !== 'string' || !text.trim() || text.length > 50000) bad('Напишите текст ответа');
  const body = withQuote && letter.body ? `${text.trim()}\n\n${quote(letter)}` : text.trim();
  const references = [...new Set([...letter.references, letter.message_id])].slice(-50);
  const sent = await deliver(db, box, mailbox, {to: toList, cc: ccList, subject: reSubject(letter.subject || ''), text: body, inReplyTo: letter.message_id, references});
  await storeLetter(db, sent, {mailboxId: mailbox.id, userId: user.id, dealId: original.deal_id, linkedBy: 'reply'});
  return await db.prepare('SELECT * FROM emails WHERE message_id=?').get(sent.message_id);
}

// ---------- views ----------
export function emailRow(row) {
  return {...row, references: json(row.references_json, []), to: json(row.to_json, []), cc: json(row.cc_json, []), attachments: json(row.attachments_json, [])};
}
export function emailView(row, {preview = false} = {}) {
  const item = emailRow(row), long = preview && item.body.length > previewBody;
  return {id: item.id, mailbox_id: item.mailbox_id, mailbox: item.mailbox_email || null, deal_id: item.deal_id, linked_by: item.linked_by || null, direction: item.direction, message_id: item.message_id, in_reply_to: item.in_reply_to || null, references: item.references, from: {address: item.from_address, name: item.from_name}, reply_to: item.reply_to || null, to: item.to, cc: item.cc, subject: item.subject, text: long ? item.body.slice(0, previewBody) : item.body, text_truncated: long, attachments: item.attachments, sent_at: item.sent_at, user_id: item.user_id, author: item.author || null, read: !!item.read_at, ...(item.deal_name !== undefined ? {deal_name: item.deal_name} : {}), created_at: item.created_at};
}
export const emailSelect = 'SELECT e.*,m.email mailbox_email,u.name author FROM emails e LEFT JOIN mailboxes m ON m.id=e.mailbox_id LEFT JOIN users u ON u.id=e.user_id';
export async function dealEmails(db, dealId) {
  return (await db.prepare(`${emailSelect} WHERE e.deal_id=? ORDER BY e.sent_at,e.id LIMIT 1000`).all(dealId)).map(row => emailView(row, {preview: true}));
}

// ---------- settings and routes ----------
const clean = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const port = (value, fallback) => { if (value === undefined || value === null || value === '') return fallback; const n = Number(value); if (!Number.isInteger(n) || n < 1 || n > 65535) bad('Порт: число от 1 до 65535'); return n; };
const host = value => { const text = clean(value, 255).toLowerCase(); if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(text)) bad('Сервер: укажите имя хоста, например imap.yandex.ru'); return text; };
function mailboxView(row, box) {
  let account = null;
  if (row.auth_type === 'google_sa') { try { account = box.open(row.secret)?.service_account?.client_email || null; } catch { account = null; } }
  return {id: row.id, email: row.email, name: row.name, auth_type: row.auth_type, imap_host: row.imap_host, imap_port: row.imap_port, smtp_host: row.smtp_host, smtp_port: row.smtp_port, username: row.username, service_account: account, history_days: row.history_days, enabled: !!row.enabled, last_sync_at: row.last_sync_at, last_error: row.last_error, syncing: running.has(row.id), emails: Number(row.emails || 0), unlinked: Number(row.unlinked || 0), created_at: row.created_at};
}

async function checkConnection(mailbox, secret) {
  const client = await mailHooks.imapClient(await imapOptions(mailbox, secret));
  try { await client.connect(); } catch (error) { throw new MailError(400, `IMAP ${mailbox.imap_host}: ${error?.responseText || error?.message || error}`); }
  finally { await client.logout().catch(() => client.close?.()); }
  const transport = await mailHooks.smtpTransport(await smtpOptions(mailbox, secret));
  try { await transport.verify(); } catch (error) { throw new MailError(400, `SMTP ${mailbox.smtp_host}: ${error?.response || error?.message || error}`); }
  finally { transport.close?.(); }
}

// Where the encryption key file lives: next to the uploads directory, outside the backups.
export function secretFilePath(uploadDir = process.env.UPLOAD_DIR || 'data/uploads') {
  return resolve(process.env.OPENCRM_SECRET_FILE || resolve(uploadDir, '..', 'secret.key'));
}

function readSettings(box, body, old) {
    const authType = old?.auth_type ?? body.auth_type;
    if (!['password', 'google_sa'].includes(authType)) bad('Способ входа: password или google_sa');
    const email = old ? old.email : lower(body.email);
    if (!validEmail(email)) bad('Укажите адрес ящика');
    const days = body.history_days === undefined ? (old?.history_days ?? 60) : Number(body.history_days);
    if (!Number.isInteger(days) || days < 1 || days > 365) bad('История: от 1 до 365 дней');
    const name = body.name === undefined ? (old?.name ?? '') : clean(body.name, 120);
    let secret = old ? box.open(old.secret) : null, servers;
    if (authType === 'google_sa') {
      servers = googleServers;
      if (body.service_account !== undefined && body.service_account !== '') secret = {service_account: parseServiceAccount(body.service_account)};
      if (!secret?.service_account) bad('Вставьте JSON-ключ сервисного аккаунта');
    } else {
      servers = {
        imap_host: body.imap_host === undefined && old ? old.imap_host : host(body.imap_host), imap_port: port(body.imap_port, old?.imap_port ?? 993),
        smtp_host: body.smtp_host === undefined && old ? old.smtp_host : host(body.smtp_host), smtp_port: port(body.smtp_port, old?.smtp_port ?? 465),
      };
      if (typeof body.password === 'string' && body.password !== '') { if (body.password.length > 1024) bad('Пароль слишком длинный'); secret = {password: body.password}; }
      if (!secret?.password) bad('Укажите пароль приложения');
    }
    const username = authType === 'password' ? (body.username === undefined ? (old?.username ?? '') : clean(body.username, 254)) || email : '';
    const enabled = body.enabled === undefined ? (old ? !!old.enabled : true) : body.enabled === true;
    return {email, name, auth_type: authType, ...servers, username, history_days: days, enabled, secret};
}
const accessDetails = settings => settings.auth_type === 'google_sa' ? `Google, сервисный аккаунт ${settings.secret.service_account.client_email}` : `IMAP ${settings.imap_host}, SMTP ${settings.smtp_host}`;

// Shared by the settings page and scripts/mail-add.mjs: check the sign-in, then save.
export async function addMailbox(db, box, body) {
  const settings = readSettings(box, body || {});
  if (await db.prepare('SELECT 1 FROM mailboxes WHERE email=?').get(settings.email)) bad('Этот ящик уже подключён');
  await checkConnection(settings, settings.secret);
  const row = await db.prepare('INSERT INTO mailboxes (email,name,auth_type,imap_host,imap_port,smtp_host,smtp_port,username,secret,history_days,enabled) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(settings.email, settings.name, settings.auth_type, settings.imap_host, settings.imap_port, settings.smtp_host, settings.smtp_port, settings.username, box.seal(settings.secret), settings.history_days, settings.enabled ? 1 : 0);
  return {id: row.lastInsertRowid, settings, details: accessDetails(settings)};
}
export async function changeMailbox(db, box, old, body) {
  const settings = readSettings(box, body || {}, old);
  const credentialsChanged = ['imap_host', 'imap_port', 'smtp_host', 'smtp_port', 'username', 'password', 'service_account'].some(key => body[key] !== undefined && body[key] !== '');
  if (credentialsChanged && settings.enabled) await checkConnection(settings, settings.secret);
  await db.prepare("UPDATE mailboxes SET name=?,imap_host=?,imap_port=?,smtp_host=?,smtp_port=?,username=?,secret=?,history_days=?,enabled=?,last_error=CASE WHEN ? THEN '' ELSE last_error END WHERE id=?").run(settings.name, settings.imap_host, settings.imap_port, settings.smtp_host, settings.smtp_port, settings.username, credentialsChanged ? box.seal(settings.secret) : old.secret, settings.history_days, settings.enabled ? 1 : 0, credentialsChanged ? 1 : 0, old.id);
  return {settings, credentialsChanged, details: [credentialsChanged && `доступ изменён (${accessDetails(settings)})`, !!old.enabled !== settings.enabled && (settings.enabled ? 'включён' : 'выключен')].filter(Boolean).join('; ')};
}

export function registerMail(app, db, {auth, admin, audit, requirePermission, secretFile}) {
  const box = createSecretBox(secretFile);
  const route = fn => async (req, res, next) => {
    try { await fn(req, res); }
    catch (error) { if (error instanceof MailError) return res.status(error.status).json({error: error.message}); if (error?.message?.startsWith('Google не дал') || error?.message?.startsWith('Ключ сервисного')) return res.status(400).json({error: error.message}); next(error); }
  };
  const startSync = id => { void syncMailbox(db, box, id).catch(error => console.error(`Почта, ящик ${id}:`, error.message)); };
  const listMailboxes = async () => (await db.prepare('SELECT m.*,(SELECT COUNT(*) FROM emails e WHERE e.mailbox_id=m.id) emails,(SELECT COUNT(*) FROM emails e WHERE e.mailbox_id=m.id AND e.deal_id IS NULL) unlinked FROM mailboxes m ORDER BY m.id').all()).map(row => mailboxView(row, box));

  app.get('/api/mail/mailboxes', auth, admin, route(async (_req, res) => res.json(await listMailboxes())));
  app.post('/api/mail/mailboxes', auth, admin, route(async (req, res) => {
    const {id, settings, details} = await addMailbox(db, box, req.body);
    await audit(req, 'mailbox.created', {target: `mailbox:${id} ${settings.email}`, details});
    if (settings.enabled && process.env.NODE_ENV !== 'test') startSync(id);
    res.status(201).json((await listMailboxes()).find(item => item.id === id));
  }));
  app.patch('/api/mail/mailboxes/:id', auth, admin, route(async (req, res) => {
    const old = await db.prepare('SELECT * FROM mailboxes WHERE id=?').get(Number(req.params.id) || 0);
    if (!old) throw new MailError(404, 'Ящик не найден');
    const body = req.body || {}, {settings, credentialsChanged, details} = await changeMailbox(db, box, old, body);
    await audit(req, 'mailbox.updated', {target: `mailbox:${old.id} ${old.email}`, details});
    if (settings.enabled && (credentialsChanged || !old.enabled) && process.env.NODE_ENV !== 'test') startSync(old.id);
    res.json((await listMailboxes()).find(item => item.id === old.id));
  }));
  app.delete('/api/mail/mailboxes/:id', auth, admin, route(async (req, res) => {
    const old = await db.prepare('SELECT id,email FROM mailboxes WHERE id=?').get(Number(req.params.id) || 0);
    if (!old) throw new MailError(404, 'Ящик не найден');
    await db.prepare('DELETE FROM mailboxes WHERE id=?').run(old.id);   // letters stay in their deals
    await audit(req, 'mailbox.deleted', {target: `mailbox:${old.id} ${old.email}`});
    res.json({ok: true});
  }));
  app.post('/api/mail/mailboxes/:id/sync', auth, admin, route(async (req, res) => {
    const row = await db.prepare('SELECT id,enabled FROM mailboxes WHERE id=?').get(Number(req.params.id) || 0);
    if (!row) throw new MailError(404, 'Ящик не найден');
    if (!row.enabled) bad('Ящик выключен');
    if (req.query.wait === '1') return res.json(await syncMailbox(db, box, row.id).catch(error => { throw new MailError(502, error.message); }));
    startSync(row.id);
    res.status(202).json({ok: true});
  }));
  app.get('/api/mail/unlinked', auth, admin, route(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    res.json((await db.prepare(`${emailSelect} WHERE e.deal_id IS NULL ORDER BY e.sent_at DESC,e.id DESC LIMIT ?`).all(limit)).map(row => emailView(row, {preview: true})));
  }));
  app.post('/api/mail/emails/:id/link', auth, admin, route(async (req, res) => {
    const email = await db.prepare('SELECT id,deal_id,subject,from_address FROM emails WHERE id=?').get(Number(req.params.id) || 0);
    if (!email) throw new MailError(404, 'Письмо не найдено');
    const dealId = req.body?.deal_id === null ? null : Number(req.body?.deal_id);
    if (dealId !== null && !(await db.prepare('SELECT 1 FROM deals WHERE id=? AND deleted_at IS NULL').get(dealId))) bad('Сделка не найдена');
    await db.prepare('UPDATE emails SET deal_id=?,linked_by=?,direction=? WHERE id=?').run(dealId, dealId ? 'manual' : '', await letterDirection(db, email, dealId, await connectedAddresses(db)), email.id);
    await audit(req, 'email.linked', {target: `email:${email.id}`, details: dealId ? `К сделке ${dealId}` : 'Отвязано от сделки'});
    res.json({ok: true});
  }));

  // ---------- the «Почта» section ----------
  // Admins see every letter; employees see the letters of deals they can open.
  const visible = req => req.user.role === 'admin' ? {sql: '1=1', params: []} : {sql: 'e.deal_id IN (SELECT d.id FROM deals d WHERE d.deleted_at IS NULL AND (?=0 OR d.owner_id=?))', params: [req.user.deal_access === 'own' ? 1 : 0, req.user.id]};
  const listSelect = 'SELECT e.*,m.email mailbox_email,u.name author,d.name deal_name FROM emails e LEFT JOIN mailboxes m ON m.id=e.mailbox_id LEFT JOIN users u ON u.id=e.user_id LEFT JOIN deals d ON d.id=e.deal_id';
  const visibleLetter = async (req, id) => {
    const scope = visible(req), row = await db.prepare(`${listSelect} WHERE e.id=? AND ${scope.sql}`).get(Number(id) || 0, ...scope.params);
    if (!row) throw new MailError(404, 'Письмо не найдено');
    return row;
  };
  const canSend = req => req.user.role === 'admin' || req.user.permissions?.deal?.edit === true;
  app.get('/api/mail/summary', auth, route(async (req, res) => {
    const scope = visible(req);
    const unread = (await db.prepare(`SELECT COUNT(*) n FROM emails e WHERE e.read_at IS NULL AND e.direction='incoming' AND ${scope.sql}`).get(...scope.params)).n;
    res.json({unread: Number(unread), can_send: canSend(req), mailboxes: (await db.prepare('SELECT id,email,name FROM mailboxes WHERE enabled=1 ORDER BY id').all()).map(row => ({id: row.id, email: row.email, name: row.name}))});
  }));
  app.get('/api/mail/emails', auth, route(async (req, res) => {
    const scope = visible(req), where = [scope.sql], params = [...scope.params];
    const folder = String(req.query.folder || 'inbox');
    if (folder === 'inbox') where.push("e.direction='incoming'");
    else if (folder === 'sent') where.push("e.direction='outgoing'");
    else if (folder === 'unlinked') where.push('e.deal_id IS NULL');
    else if (folder === 'unread') where.push("e.read_at IS NULL AND e.direction='incoming'");
    else if (folder !== 'all') bad('Папка: inbox, sent, unread, unlinked или all');
    if (req.query.mailbox_id) { where.push('e.mailbox_id=?'); params.push(Number(req.query.mailbox_id) || 0); }
    const q = clean(String(req.query.q || ''), 200).toLowerCase();
    if (q) { where.push("(lower(e.subject) LIKE ? OR lower(e.from_address) LIKE ? OR lower(e.from_name) LIKE ? OR lower(e.to_json) LIKE ? OR lower(e.body) LIKE ?)"); const like = `%${q.replace(/[\\%_]/g, char => '\\' + char)}%`; params.push(like, like, like, like, like); }
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200), offset = Math.min(Math.max(Number(req.query.offset) || 0, 0), 100000);
    const rows = await db.prepare(`${listSelect} WHERE ${where.join(' AND ')} ORDER BY e.sent_at DESC,e.id DESC LIMIT ? OFFSET ?`).all(...params, limit + 1, offset);
    res.json({items: rows.slice(0, limit).map(row => { const view = emailView(row, {preview: true}); view.text = view.text.slice(0, 300); return view; }), more: rows.length > limit});
  }));
  app.get('/api/mail/emails/:id', auth, route(async (req, res) => {
    const row = await visibleLetter(req, req.params.id), scope = visible(req);
    if (!row.read_at) await db.prepare('UPDATE emails SET read_at=now_text() WHERE id=? AND read_at IS NULL').run(row.id);
    const thread = await db.prepare(`${listSelect} WHERE ${scope.sql} AND e.id<>? AND (e.message_id IN (SELECT jsonb_array_elements_text(references_json::jsonb) FROM emails WHERE id=? UNION SELECT in_reply_to FROM emails WHERE id=?) OR e.in_reply_to=? OR jsonb_exists(e.references_json::jsonb, ?)) ORDER BY e.sent_at,e.id LIMIT 100`).all(...scope.params, row.id, row.id, row.id, row.message_id, row.message_id);
    res.json({...emailView({...row, read_at: row.read_at || 'now'}), thread: thread.map(item => emailView(item, {preview: true}))});
  }));
  app.post('/api/mail/emails/:id/read', auth, route(async (req, res) => {
    const row = await visibleLetter(req, req.params.id);
    await db.prepare(`UPDATE emails SET read_at=${req.body?.read === false ? 'NULL' : 'COALESCE(read_at,now_text())'} WHERE id=?`).run(row.id);
    res.json({ok: true});
  }));
  app.post('/api/mail/read-all', auth, route(async (req, res) => {
    const scope = visible(req);
    const result = await db.prepare(`UPDATE emails SET read_at=now_text() WHERE id IN (SELECT e.id FROM emails e WHERE e.read_at IS NULL AND ${scope.sql})`).run(...scope.params);
    res.json({updated: result.changes});
  }));
  app.post('/api/mail/emails/:id/reply', auth, route(async (req, res) => {
    if (!canSend(req)) throw new MailError(403, 'Нет прав на это действие');
    const original = await visibleLetter(req, req.params.id), body = req.body || {};
    const sent = await sendReply(db, box, {original, user: req.user, text: body.text, to: body.to, cc: body.cc, all: body.reply_all === true, withQuote: body.quote !== false});
    await audit(req, 'email.sent', {target: `email:${sent.id}`, details: `${original.deal_id ? `Сделка ${original.deal_id}; ` : ''}кому: ${emailRow(sent).to.map(item => item.address).join(', ')}`});
    res.status(201).json(emailView({...sent, mailbox_email: original.mailbox_email, author: req.user.name}));
  }));
  app.post('/api/mail/send', auth, route(async (req, res) => {
    if (!canSend(req)) throw new MailError(403, 'Нет прав на это действие');
    const body = req.body || {}, dealId = body.deal_id == null || body.deal_id === '' ? null : Number(body.deal_id);
    if (dealId !== null) {
      const deal = await db.prepare('SELECT id,owner_id FROM deals WHERE id=? AND deleted_at IS NULL').get(dealId);
      if (!deal || req.user.role !== 'admin' && req.user.deal_access === 'own' && deal.owner_id !== req.user.id) throw new MailError(404, 'Сделка не найдена');
    }
    const sent = await sendNew(db, box, {mailboxId: body.mailbox_id, user: req.user, to: body.to, cc: body.cc, subject: body.subject ?? '', text: body.text, dealId});
    await audit(req, 'email.sent', {target: `email:${sent.id}`, details: `${sent.deal_id ? `Сделка ${sent.deal_id}; ` : ''}кому: ${emailRow(sent).to.map(item => item.address).join(', ')}`});
    res.status(201).json(emailView({...sent, author: req.user.name}));
  }));

  // Deal routes: the /api/deals/:id middleware has already checked the deal and the user's access to it.
  const dealLetter = async req => {
    const row = await db.prepare(`${emailSelect} WHERE e.id=? AND e.deal_id=?`).get(Number(req.params.emailId) || 0, Number(req.params.id));
    if (!row) throw new MailError(404, 'Письмо не найдено');
    return row;
  };
  app.get('/api/deals/:id/emails', auth, route(async (req, res) => res.json(await dealEmails(db, Number(req.params.id)))));
  app.get('/api/deals/:id/emails/:emailId', auth, route(async (req, res) => res.json(emailView(await dealLetter(req)))));
  app.post('/api/deals/:id/emails/:emailId/reply', auth, requirePermission('deal', 'edit'), route(async (req, res) => {
    const original = await dealLetter(req), body = req.body || {};
    const sent = await sendReply(db, box, {original, user: req.user, text: body.text, to: body.to, cc: body.cc, all: body.reply_all === true, withQuote: body.quote !== false});
    await audit(req, 'email.sent', {target: `email:${sent.id}`, details: `Сделка ${original.deal_id}; кому: ${emailRow(sent).to.map(item => item.address).join(', ')}`});
    res.status(201).json(emailView({...sent, mailbox_email: original.mailbox_email, author: req.user.name}));
  }));

  if (process.env.NODE_ENV !== 'test' || process.env.OPENCRM_MAIL_WORKER === '1') {
    const seconds = Math.max(Number(process.env.OPENCRM_MAIL_SYNC_SECONDS) || 120, 30);
    let busy = false;
    const run = async () => { if (busy) return; busy = true; try { await syncAll(db, box); } finally { busy = false; } };
    setTimeout(run, 15000).unref();
    setInterval(run, seconds * 1000).unref();
  }
  return {box};
}
