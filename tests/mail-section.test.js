import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const day = 864e5;
const rfcDate = date => date.toUTCString().replace('GMT', '+0000');
const letter = ({from, to, subject, id, inReplyTo, date, body = 'Текст'}) => [`From: ${from}`, `To: ${to}`, `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`, `Message-ID: ${id}`, inReplyTo && `In-Reply-To: ${inReplyTo}`, inReplyTo && `References: ${inReplyTo}`, `Date: ${rfcDate(date)}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', Buffer.from(body).toString('base64'), ''].filter(item => item !== undefined && item !== null && item !== false).join('\r\n');

test('mail section: folders, read marks, new letters and the «Сообщения» panel', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opencrm-mail-section-'));
  process.env.PGLITE_DIR = join(dir, 'pg');
  process.env.UPLOAD_DIR = join(dir, 'uploads');
  process.env.NODE_ENV = 'test';
  delete process.env.OPENCRM_SECRET_KEY;
  const {app, db} = await import('../server/index.js');
  const {mailHooks} = await import('../server/mail.js');
  const messages = [], sent = [];
  mailHooks.imapClient = () => {
    let folder = null;
    const client = {
      mailbox: null,
      async connect() {}, async logout() {},
      async list() { return [{path: 'INBOX', specialUse: '\\Inbox'}, {path: 'Sent', specialUse: '\\Sent'}]; },
      async getMailboxLock(path) { folder = path; client.mailbox = {uidValidity: 1n}; return {release() {}}; },
      async search(query) { const items = messages.filter(item => item.folder === folder); if (query.since) return items.map(item => item.uid); const from = Number(query.uid.split(':')[0]); const found = items.filter(item => item.uid >= from).map(item => item.uid); return found.length ? found : items.slice(-1).map(item => item.uid); },
      async *fetch(range) { const wanted = new Set(range.split(',').map(Number)); for (const item of messages) if (item.folder === folder && wanted.has(item.uid)) yield {uid: item.uid, flags: new Set(item.flags || []), internalDate: item.date, source: Buffer.from(item.source)}; },
    };
    return client;
  };
  mailHooks.smtpTransport = () => ({async verify() { return true; }, async sendMail(message) { sent.push(message); return {}; }, close() {}});
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  async function call(path, {method = 'GET', body, status = 200, as} = {}) {
    const response = await fetch(base + path, {method, headers: {'Content-Type': 'application/json', Cookie: as ?? cookie}, body: body ? JSON.stringify(body) : undefined});
    const text = await response.text();
    assert.equal(response.status, status, `${method} ${path}: ${text}`);
    if (as === undefined && response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return text ? JSON.parse(text) : null;
  }
  try {
    await call('/api/setup', {method: 'POST', body: {name: 'Admin', email: 'admin@agency.test', password: 'passphrase-for-tests'}});
    const adminId = (await db.prepare("SELECT id FROM users WHERE email='admin@agency.test'").get()).id;
    const active = (await db.prepare("SELECT id FROM stages WHERE kind='active' ORDER BY id LIMIT 1").get()).id;
    const allRights = {create: true, edit: true, delete: true, export: true};
    await call('/api/users', {method: 'POST', body: {name: 'Менеджер', email: 'member@agency.test', password: 'member-password', role: 'member', deal_access: 'own', task_access: 'own', permissions: {deal: allRights, task: allRights}}, status: 201});
    const memberId = (await db.prepare("SELECT id FROM users WHERE email='member@agency.test'").get()).id;
    const login = await fetch(`${base}/api/login`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({email: 'member@agency.test', password: 'member-password'})});
    const member = login.headers.get('set-cookie').split(';')[0];
    const contact = async (name, email) => (await db.prepare('INSERT INTO contacts (name,email) VALUES (?,?)').run(name, email)).lastInsertRowid;
    const deal = async (name, contactId, owner) => { const id = (await db.prepare('INSERT INTO deals (name,stage_id,contact_id,owner_id) VALUES (?,?,?,?)').run(name, active, contactId, owner)).lastInsertRowid; await db.prepare('INSERT INTO deal_contacts (deal_id,contact_id) VALUES (?,?)').run(id, contactId); return id; };
    const mine = await deal('Сделка менеджера', await contact('Клиент', 'client@acme.test'), memberId);
    const foreign = await deal('Чужая сделка', await contact('Другой', 'other@beta.test'), adminId);

    // Without a mailbox there is nothing to send from.
    assert.deepEqual(await call('/api/mail/summary'), {unread: 0, can_send: true, mailboxes: []});
    await call('/api/mail/send', {method: 'POST', body: {to: ['client@acme.test'], subject: 'Тема', text: 'Текст'}, status: 400});
    const mailbox = await call('/api/mail/mailboxes', {method: 'POST', body: {email: 'sales@agency.test', name: 'Отдел продаж', auth_type: 'password', imap_host: 'imap.agency.test', smtp_host: 'smtp.agency.test', password: 'app-password'}, status: 201});
    const now = Date.now();
    messages.push(
      {folder: 'INBOX', uid: 1, date: new Date(now - 2 * day), source: letter({from: 'Клиент <client@acme.test>', to: 'sales@agency.test', subject: 'Счёт', id: '<a1@acme.test>', date: new Date(now - 2 * day), body: 'Пришлите счёт, пожалуйста'})},
      {folder: 'INBOX', uid: 2, date: new Date(now - day), flags: ['\\Seen'], source: letter({from: 'other@beta.test', to: 'sales@agency.test', subject: 'Прочитанное', id: '<b1@beta.test>', date: new Date(now - day)})},
      {folder: 'INBOX', uid: 3, date: new Date(now - day), source: letter({from: 'news@spam.test', to: 'sales@agency.test', subject: 'Рассылка', id: '<n1@spam.test>', date: new Date(now - day)})},
      {folder: 'Sent', uid: 1, date: new Date(now - day), source: letter({from: 'sales@agency.test', to: 'client@acme.test', subject: 'Re: Счёт', id: '<s1@agency.test>', inReplyTo: '<a1@acme.test>', date: new Date(now - day)})},
    );
    assert.deepEqual(await call(`/api/mail/mailboxes/${mailbox.id}/sync?wait=1`, {method: 'POST'}), {added: 4, relinked: 0});

    // Folders: the admin sees every letter, the \Seen flag of the mailbox counts as read.
    const subjects = async (query, as) => (await call(`/api/mail/emails?${query}`, {as})).items.map(item => item.subject);
    const inbox = (await call('/api/mail/emails?folder=inbox')).items;
    assert.equal(inbox.length, 3);
    assert.deepEqual(new Set(inbox.map(item => item.subject)), new Set(['Счёт', 'Прочитанное', 'Рассылка']));
    assert.equal(inbox.find(item => item.subject === 'Прочитанное').read, true, 'the mailbox had it as \\Seen');
    assert.equal(inbox.find(item => item.subject === 'Счёт').deal_name, 'Сделка менеджера');
    assert.deepEqual(await subjects('folder=sent'), ['Re: Счёт']);
    assert.equal((await call('/api/mail/emails?folder=sent')).items[0].read, true, 'outgoing letters are never unread');
    assert.deepEqual(new Set(await subjects('folder=unread')), new Set(['Счёт', 'Рассылка']));
    assert.deepEqual(await subjects('folder=unlinked'), ['Рассылка']);
    assert.deepEqual(await subjects('folder=all&q=%D1%81%D1%87%D1%91%D1%82'), ['Re: Счёт', 'Счёт'], 'search in the subject');
    assert.deepEqual(await subjects('folder=all&q=spam.test'), ['Рассылка'], 'search in the sender');
    assert.equal((await call('/api/mail/emails?folder=all&limit=2')).more, true);
    await call('/api/mail/emails?folder=trash', {status: 400});
    assert.equal((await call('/api/mail/summary')).unread, 2);

    // The employee with access to own deals sees only the letters of those deals.
    assert.deepEqual(await subjects('folder=all', member), ['Re: Счёт', 'Счёт']);
    assert.equal((await call('/api/mail/summary', {as: member})).unread, 1);
    const spam = inbox.find(item => item.subject === 'Рассылка'), invoice = inbox.find(item => item.subject === 'Счёт');
    await call(`/api/mail/emails/${spam.id}`, {as: member, status: 404});
    await call(`/api/mail/emails/${spam.id}/read`, {method: 'POST', body: {read: true}, as: member, status: 404});

    // Opening a letter marks it read and shows its thread.
    const opened = await call(`/api/mail/emails/${invoice.id}`, {as: member});
    assert.equal(opened.text, 'Пришлите счёт, пожалуйста');
    assert.deepEqual(opened.thread.map(item => item.subject), ['Re: Счёт']);
    assert.equal((await call('/api/mail/summary', {as: member})).unread, 0);
    await call(`/api/mail/emails/${invoice.id}/read`, {method: 'POST', body: {read: false}, as: member});
    assert.equal((await call('/api/mail/summary', {as: member})).unread, 1, 'marked unread again');

    // The «Сообщения» panel: the unread letter of the employee's deal, own tasks, new requests.
    const due = (minutes, owner, title, dealId) => db.prepare('INSERT INTO tasks (title,due_at,owner_id,deal_id) VALUES (?,?,?,?)').run(title, new Date(now + minutes * 60000).toISOString(), owner, dealId);
    await due(-120, memberId, 'Позвонить клиенту', mine);
    await due(30, memberId, 'Отправить КП', mine);
    await due(600, memberId, 'Завтрашняя', mine);
    await due(-60, adminId, 'Задача админа', foreign);
    await db.prepare("INSERT INTO inbox_leads (pipeline_id,title,contact_name,email) VALUES ((SELECT id FROM pipelines ORDER BY id LIMIT 1),'Заявка с сайта','Иван','ivan@site.test')").run();
    const panel = await call('/api/notifications', {as: member});
    assert.deepEqual(panel.items.map(item => item.kind).sort(), ['email', 'lead', 'task_due', 'task_overdue']);
    assert.equal(panel.items.find(item => item.kind === 'task_overdue').text, 'Связаться: Позвонить клиенту');
    assert.equal(panel.items.find(item => item.kind === 'task_due').title, 'Пора выполнить задачу');
    assert.equal(panel.items.find(item => item.kind === 'email').email_id, invoice.id);
    assert.equal(panel.items.find(item => item.kind === 'email').deal_id, mine);
    assert.equal(panel.unseen, 4);
    assert.equal((await call('/api/notifications/count', {as: member})).unseen, 4);
    await call('/api/notifications/seen', {method: 'POST', as: member});
    assert.equal((await call('/api/notifications/count', {as: member})).unseen, 0, 'everything is seen once the panel was opened');
    assert.ok((await call('/api/notifications', {as: member})).items.every(item => !item.new));
    const adminPanel = await call('/api/notifications');
    assert.deepEqual(adminPanel.items.map(item => item.kind).sort(), ['email', 'email', 'lead', 'task_overdue'], 'the admin: own tasks, letters of every deal and unlinked ones');

    // A new letter: from the section without a deal (linked by the address), and from the card with one.
    const plain = await call('/api/mail/send', {method: 'POST', body: {mailbox_id: mailbox.id, to: ['Client@Acme.test'], subject: 'Договор', text: 'Высылаю договор'}, status: 201});
    assert.equal(plain.deal_id, mine, 'linked by the client address');
    assert.equal(plain.direction, 'outgoing');
    assert.deepEqual(sent.at(-1).to, ['client@acme.test']);
    assert.equal(sent.at(-1).subject, 'Договор');
    assert.equal(sent.at(-1).inReplyTo, undefined);
    assert.deepEqual(sent.at(-1).from, {name: 'Отдел продаж', address: 'sales@agency.test'});
    const fromCard = await call('/api/mail/send', {method: 'POST', body: {mailbox_id: mailbox.id, to: ['boss@gamma.test'], cc: ['client@acme.test'], subject: 'КП', text: 'Коммерческое предложение', deal_id: foreign}, status: 201});
    assert.equal(fromCard.deal_id, foreign);
    assert.equal(fromCard.linked_by, 'sent');
    assert.deepEqual(sent.at(-1).cc, ['client@acme.test']);
    await call('/api/mail/send', {method: 'POST', body: {mailbox_id: mailbox.id, to: ['boss@gamma.test'], subject: 'КП', text: 'x', deal_id: foreign}, as: member, status: 404});
    await call('/api/mail/send', {method: 'POST', body: {mailbox_id: mailbox.id, to: [], subject: 'КП', text: 'x'}, status: 400});
    await call('/api/mail/send', {method: 'POST', body: {mailbox_id: mailbox.id, to: ['client@acme.test'], subject: 'КП', text: ' '}, status: 400});
    await call('/api/mail/send', {method: 'POST', body: {mailbox_id: 999, to: ['client@acme.test'], subject: 'КП', text: 'x'}, status: 400});
    const fromMember = await call('/api/mail/send', {method: 'POST', body: {mailbox_id: mailbox.id, to: ['client@acme.test'], subject: 'От менеджера', text: 'Добрый день', deal_id: mine}, as: member, status: 201});
    assert.equal(fromMember.author, 'Менеджер');
    assert.ok((await call(`/api/deals/${mine}`, {as: member})).emails.some(item => item.subject === 'От менеджера'));
    // Reply from the section.
    const answer = await call(`/api/mail/emails/${invoice.id}/reply`, {method: 'POST', body: {text: 'Счёт во вложении', quote: false}, as: member, status: 201});
    assert.equal(answer.deal_id, mine);
    assert.equal(sent.at(-1).inReplyTo, '<a1@acme.test>');
    await call(`/api/mail/emails/${spam.id}/reply`, {method: 'POST', body: {text: 'x'}, as: member, status: 404});
    await call('/api/mail/read-all', {method: 'POST'});
    assert.equal((await call('/api/mail/summary')).unread, 0);
  } finally {
    server.close();
    await db.close?.();
    rmSync(dir, {recursive: true, force: true});
  }
});
