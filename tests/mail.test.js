import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, verify} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const day = 864e5;
const rfcDate = date => date.toUTCString().replace('GMT', '+0000');
function letter({from, to, cc, subject, id, inReplyTo, references, date = new Date(Date.now() - day), body = 'Текст письма', html, extraHeaders = ''}) {
  const head = [`From: ${from}`, `To: ${to}`, cc && `Cc: ${cc}`, `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`, `Message-ID: ${id}`, inReplyTo && `In-Reply-To: ${inReplyTo}`, references && `References: ${references}`, `Date: ${rfcDate(date)}`, 'MIME-Version: 1.0'].filter(Boolean).join('\r\n') + extraHeaders;
  if (html) return `${head}\r\nContent-Type: multipart/mixed; boundary="b1"\r\n\r\n--b1\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(html).toString('base64')}\r\n--b1\r\nContent-Type: application/pdf; name="kp.pdf"\r\nContent-Disposition: attachment; filename="kp.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0xLjQK\r\n--b1--\r\n`;
  return `${head}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(body).toString('base64')}\r\n`;
}

// A minimal stand-in for ImapFlow: folders with UIDVALIDITY and messages.
function fakeImap(server) {
  return options => {
    server.options.push(options);
    let folder = null;
    const client = {
      mailbox: null,
      async connect() { if (server.fail) throw new Error(server.fail); },
      async list() { return server.folders.map(item => ({path: item.path, specialUse: item.specialUse})); },
      async getMailboxLock(path) { folder = server.folders.find(item => item.path === path); client.mailbox = {uidValidity: BigInt(folder.validity)}; return {release() { folder = null; }}; },
      async search(query) {
        server.searches.push(query);
        if (query.since) return folder.messages.filter(item => item.date >= query.since).map(item => item.uid);
        const from = Number(query.uid.split(':')[0]), found = folder.messages.filter(item => item.uid >= from).map(item => item.uid);
        return found.length ? found : folder.messages.slice(-1).map(item => item.uid);   // IMAP n:* returns the last message
      },
      async *fetch(range) {
        const wanted = new Set(range.split(',').map(Number));
        for (const item of folder.messages) if (wanted.has(item.uid)) yield {uid: item.uid, flags: new Set(item.flags || []), internalDate: item.date, bodyStructure: item.structure, source: Buffer.from(item.source)};
      },
      async logout() {},
    };
    return client;
  };
}
function fakeSmtp(server) {
  return options => ({
    async verify() { server.smtpOptions.push(options); if (server.smtpFail) throw new Error(server.smtpFail); return true; },
    async sendMail(message) { server.sent.push(message); return {messageId: message.messageId}; },
    close() {},
  });
}

test('mail: secrets are encrypted at rest with a key file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opencrm-secret-'));
  try {
    const {createSecretBox} = await import('../server/mail.js');
    const saved = process.env.OPENCRM_SECRET_KEY; delete process.env.OPENCRM_SECRET_KEY;
    const file = join(dir, 'data', 'secret.key'), box = createSecretBox(file);
    const sealed = box.seal({password: 'app-password-1'});
    assert.match(sealed, /^v1\./);
    assert.ok(!sealed.includes('app-password'));
    assert.deepEqual(createSecretBox(file).open(sealed), {password: 'app-password-1'}, 'a new box reads the same key file');
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.match(readFileSync(file, 'utf8'), /^[0-9a-f]{64}$/);
    assert.throws(() => box.open(sealed.slice(0, -4) + 'AAAA'), /ключ шифрования сменился/);
    process.env.OPENCRM_SECRET_KEY = 'another key';
    assert.throws(() => createSecretBox(file).open(sealed), /ключ шифрования сменился/);
    if (saved === undefined) delete process.env.OPENCRM_SECRET_KEY; else process.env.OPENCRM_SECRET_KEY = saved;
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('mail: Google service account signs a delegated token request', async () => {
  const {googleAccessToken, parseServiceAccount, mailHooks} = await import('../server/mail.js');
  const {privateKey, publicKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
  const account = parseServiceAccount(JSON.stringify({type: 'service_account', client_email: 'sync@project.iam.gserviceaccount.com', private_key: privateKey.export({type: 'pkcs8', format: 'pem'}), client_id: '1'}));
  assert.throws(() => parseServiceAccount('{"type":"user"}'), /service_account/);
  const calls = [], original = mailHooks.fetch;
  mailHooks.fetch = async (url, init) => { calls.push({url, body: new URLSearchParams(init.body)}); return {ok: true, status: 200, json: async () => ({access_token: 'ya29.token', expires_in: 3600})}; };
  try {
    assert.equal(await googleAccessToken(account, 'polza@agency.test'), 'ya29.token');
    assert.equal(await googleAccessToken(account, 'polza@agency.test'), 'ya29.token');
    assert.equal(calls.length, 1, 'the token is cached');
    assert.equal(calls[0].url, 'https://oauth2.googleapis.com/token');
    const [head, claims, signature] = calls[0].body.get('assertion').split('.');
    assert.ok(verify('RSA-SHA256', Buffer.from(`${head}.${claims}`), publicKey, Buffer.from(signature, 'base64url')));
    const payload = JSON.parse(Buffer.from(claims, 'base64url'));
    assert.equal(payload.iss, 'sync@project.iam.gserviceaccount.com');
    assert.equal(payload.sub, 'polza@agency.test', 'the mailbox is impersonated');
    assert.equal(payload.scope, 'https://mail.google.com/');
    mailHooks.fetch = async () => ({ok: false, status: 401, json: async () => ({error: 'unauthorized_client', error_description: 'Client is unauthorized'})});
    await assert.rejects(googleAccessToken(account, 'julia@agency.test'), /unauthorized_client — Client is unauthorized.*делегирование/);
  } finally { mailHooks.fetch = original; }
});

test('mail: mailboxes sync, letters link to deals, replies keep the thread', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opencrm-mail-'));
  process.env.PGLITE_DIR = join(dir, 'pg');
  process.env.UPLOAD_DIR = join(dir, 'uploads');
  process.env.NODE_ENV = 'test';
  delete process.env.OPENCRM_SECRET_KEY;
  const {app, db} = await import('../server/index.js');
  const {mailHooks} = await import('../server/mail.js');
  const imap = {options: [], searches: [], folders: []}, smtp = {smtpOptions: [], sent: []};
  mailHooks.imapClient = fakeImap(imap);
  mailHooks.smtpTransport = fakeSmtp(smtp);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  async function call(path, {method = 'GET', body, status = 200, key, as} = {}) {
    const response = await fetch(base + path, {method, headers: {'Content-Type': 'application/json', ...(key ? {Authorization: `Bearer ${key}`} : {Cookie: as ?? cookie})}, body: body ? JSON.stringify(body) : undefined});
    const text = await response.text();
    assert.equal(response.status, status, `${method} ${path}: ${text}`);
    if (!key && as === undefined && response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return text ? JSON.parse(text) : null;
  }
  try {
    await call('/api/setup', {method: 'POST', body: {name: 'Admin', email: 'admin@agency.test', password: 'passphrase-for-tests'}});
    const stage = kind => db.prepare('SELECT id FROM stages WHERE kind=? ORDER BY id LIMIT 1').get(kind).then(row => row.id);
    const active = await stage('active'), lost = await stage('lost');
    const contact = async (name, email) => (await db.prepare('INSERT INTO contacts (name,email) VALUES (?,?)').run(name, email)).lastInsertRowid;
    const deal = async (name, stageId, contactId, updated) => {
      const id = (await db.prepare('INSERT INTO deals (name,stage_id,contact_id,updated_at) VALUES (?,?,?,?)').run(name, stageId, contactId, updated)).lastInsertRowid;
      await db.prepare('INSERT INTO deal_contacts (deal_id,contact_id) VALUES (?,?)').run(id, contactId);
      return id;
    };
    const client = await contact('Клиент', 'client@acme.test');
    const lostDeal = await deal('Старая сделка', lost, client, '2026-11-20 10:00:00');
    const openDeal = await deal('Открытая сделка', active, client, '2026-01-01 10:00:00');
    const second = await contact('Второй', 'other@one.test, second@acme2.test');   // several addresses, as amoCRM loads keep them
    const secondDeal = await deal('Только закрытая', lost, second, '2026-11-01 10:00:00');

    // Connecting checks IMAP and SMTP first and never returns the password.
    imap.fail = 'Invalid credentials (Failure)';
    const refused = await call('/api/mail/mailboxes', {method: 'POST', body: {email: 'polza@agency.test', auth_type: 'password', imap_host: 'imap.agency.test', smtp_host: 'smtp.agency.test', password: 'app-password-1'}, status: 400});
    assert.match(refused.error, /IMAP imap\.agency\.test: Invalid credentials/);
    delete imap.fail;
    const mailbox = await call('/api/mail/mailboxes', {method: 'POST', body: {email: 'Polza@Agency.test', name: 'Polza Agency', auth_type: 'password', imap_host: 'imap.agency.test', smtp_host: 'smtp.agency.test', password: 'app-password-1'}, status: 201});
    assert.equal(mailbox.email, 'polza@agency.test');
    assert.equal(mailbox.imap_port, 993);
    assert.equal(mailbox.username, 'polza@agency.test');
    assert.ok(!JSON.stringify(mailbox).includes('app-password-1'));
    assert.ok(!JSON.stringify(await call('/api/mail/mailboxes')).includes('app-password-1'));
    const stored = await db.prepare('SELECT secret FROM mailboxes WHERE id=?').get(mailbox.id);
    assert.match(stored.secret, /^v1\./);
    assert.ok(!stored.secret.includes('app-password'));
    assert.deepEqual(imap.options.at(-1).auth, {user: 'polza@agency.test', pass: 'app-password-1'});
    assert.equal(smtp.smtpOptions.at(-1).secure, true);
    await call('/api/mail/mailboxes', {method: 'POST', body: {email: 'polza@agency.test', auth_type: 'password', imap_host: 'imap.agency.test', smtp_host: 'smtp.agency.test', password: 'x'}, status: 400});

    const now = Date.now();
    imap.folders = [{path: 'INBOX', specialUse: '\\Inbox', validity: 1, messages: []}, {path: '[Gmail]/Вся почта', specialUse: '\\All', validity: 7, messages: [
      {uid: 10, date: new Date(now - 90 * day), source: letter({from: 'client@acme.test', to: 'polza@agency.test', subject: 'Очень старое', id: '<old@acme.test>', date: new Date(now - 90 * day)})},
      {uid: 11, date: new Date(now - 3 * day), source: letter({from: 'Клиент <client@acme.test>', to: 'polza@agency.test', subject: 'Вопрос', id: '<m1@acme.test>', body: 'Здравствуйте!\nЕсть вопрос.', date: new Date(now - 3 * day)})},
      // The portal's outreach letter: sent from the mailer box to the client, our box in copy.
      {uid: 12, date: new Date(now - 2 * day), source: letter({from: 'Outreach <outreach@mailer.test>', to: 'client@acme.test', cc: 'polza@agency.test', subject: 'Предложение', id: '<f1@mailer.test>', body: 'Коммерческое предложение', date: new Date(now - 2 * day)})},
      // The manager answers the outreach letter: only the mailer box is a recipient.
      {uid: 13, date: new Date(now - day), source: letter({from: 'polza@agency.test', to: 'outreach@mailer.test', subject: 'Re: Предложение', id: '<r1@agency.test>', inReplyTo: '<f1@mailer.test>', references: '<f1@mailer.test>', body: 'Ответ менеджера', date: new Date(now - day)})},
      {uid: 14, date: new Date(now - day), source: letter({from: 'news@spam.test', to: 'polza@agency.test', subject: 'Рассылка', id: '<n1@spam.test>'})},
      {uid: 15, date: new Date(now - day), flags: ['\\Draft'], source: letter({from: 'polza@agency.test', to: 'client@acme.test', subject: 'Черновик', id: '<d1@agency.test>'})},
      {uid: 16, date: new Date(now - day), source: letter({from: 'second@acme2.test', to: 'polza@agency.test', subject: 'HTML', id: '<h1@acme2.test>', html: '<p>Добрый <b>день</b></p><img src="cid:x"><a href="https://x.test">ссылка</a>'}),
        structure: {type: 'multipart/mixed', childNodes: [{part: '1', type: 'text/html', size: 100}, {part: '2', type: 'application/pdf', disposition: 'attachment', dispositionParameters: {filename: 'kp.pdf'}, encoding: 'base64', size: 400}]}},
    ]}];
    const first = await call(`/api/mail/mailboxes/${mailbox.id}/sync?wait=1`, {method: 'POST'});
    assert.deepEqual(first, {added: 5, relinked: 0});
    assert.equal(imap.searches.length, 1, 'Gmail: only All Mail is read');
    assert.ok(Math.abs(imap.searches[0].since.getTime() - (now - 60 * day)) < 60000, 'the first sync takes 60 days of history');
    const rows = Object.fromEntries((await db.prepare('SELECT message_id,deal_id,linked_by,direction FROM emails').all()).map(row => [row.message_id, row]));
    assert.equal(rows['<old@acme.test>'], undefined);
    assert.equal(rows['<d1@agency.test>'], undefined, 'drafts are skipped');
    assert.deepEqual(rows['<m1@acme.test>'], {message_id: '<m1@acme.test>', deal_id: openDeal, linked_by: 'address', direction: 'incoming'}, 'the open deal wins over a more recent closed one');
    assert.deepEqual(rows['<f1@mailer.test>'], {message_id: '<f1@mailer.test>', deal_id: openDeal, linked_by: 'address', direction: 'outgoing'}, 'the client in To links the outreach letter; it comes from our mailer box, so it is outgoing');
    assert.deepEqual(rows['<r1@agency.test>'], {message_id: '<r1@agency.test>', deal_id: openDeal, linked_by: 'thread', direction: 'outgoing'}, 'the reply to the mailer box links by thread');
    assert.equal(rows['<n1@spam.test>'].deal_id, null, 'letters without a deal are kept');
    assert.equal(rows['<h1@acme2.test>'].deal_id, secondDeal, 'one of several contact addresses; a closed deal when there is no open one');
    assert.notEqual(lostDeal, openDeal);

    const card = await call(`/api/deals/${openDeal}`);
    assert.deepEqual(card.emails.map(item => item.subject), ['Вопрос', 'Предложение', 'Re: Предложение'], 'oldest first');
    const question = card.emails[0];
    assert.equal(question.text, 'Здравствуйте!\nЕсть вопрос.');
    assert.deepEqual(question.from, {address: 'client@acme.test', name: 'Клиент'});
    assert.deepEqual(question.to, [{address: 'polza@agency.test', name: ''}]);
    assert.equal(question.mailbox, 'polza@agency.test');
    const htmlLetter = (await call(`/api/deals/${secondDeal}/emails`))[0];
    assert.match(htmlLetter.text, /Добрый день/);
    assert.ok(!htmlLetter.text.includes('https://x.test'));
    assert.deepEqual(htmlLetter.attachments, [{filename: 'kp.pdf', content_type: 'application/pdf', size: 292}]);
    assert.equal((await call(`/api/deals/${openDeal}/emails/${question.id}`)).message_id, '<m1@acme.test>');
    await call(`/api/deals/${secondDeal}/emails/${question.id}`, {status: 404});

    // Incremental sync: only UIDs above the last one; unlinked letters get linked when a contact appears.
    const spamContact = await contact('Рассылка', 'NEWS@spam.test');
    const spamDeal = await deal('Сделка рассылки', active, spamContact, '2026-11-21 10:00:00');
    imap.folders[1].messages.push({uid: 17, date: new Date(), source: letter({from: 'client@acme.test', to: 'polza@agency.test', subject: 'Ещё вопрос', id: '<m2@acme.test>', date: new Date()})});
    assert.deepEqual(await call(`/api/mail/mailboxes/${mailbox.id}/sync?wait=1`, {method: 'POST'}), {added: 1, relinked: 1});
    assert.equal(imap.searches.at(-1).uid, '17:*');
    assert.deepEqual(await db.prepare('SELECT deal_id,linked_by FROM emails WHERE message_id=?').get('<n1@spam.test>'), {deal_id: spamDeal, linked_by: 'address'});
    assert.deepEqual(await call(`/api/mail/mailboxes/${mailbox.id}/sync?wait=1`, {method: 'POST'}), {added: 0, relinked: 0}, 'nothing new');
    // A new UIDVALIDITY means the folder was rebuilt: read again, without duplicates.
    imap.folders[1].validity = 8;
    assert.deepEqual(await call(`/api/mail/mailboxes/${mailbox.id}/sync?wait=1`, {method: 'POST'}), {added: 0, relinked: 0});
    assert.ok(imap.searches.at(-1).since);

    // Reply from the card: to the mailer box (From of the letter), thread headers, subject kept.
    const outreach = card.emails[1];
    const reply = await call(`/api/deals/${openDeal}/emails/${outreach.id}/reply`, {method: 'POST', body: {text: 'Спасибо, ждём договор'}, status: 201});
    const sent = smtp.sent.at(-1);
    assert.deepEqual(sent.to, ['outreach@mailer.test']);
    assert.equal(sent.cc, undefined);
    assert.equal(sent.subject, 'Re: Предложение');
    assert.equal(sent.inReplyTo, '<f1@mailer.test>');
    assert.equal(sent.references, '<f1@mailer.test>');
    assert.deepEqual(sent.from, {name: 'Polza Agency', address: 'polza@agency.test'});
    assert.match(sent.messageId, /^<[0-9a-f-]{36}@agency\.test>$/);
    assert.match(sent.text, /^Спасибо, ждём договор\n\n.+Outreach <outreach@mailer\.test> пишет:\n> Коммерческое предложение$/s);
    assert.equal(reply.direction, 'outgoing');
    assert.equal(reply.linked_by, 'reply');
    assert.equal(reply.deal_id, openDeal);
    assert.equal(reply.author, 'Admin');
    assert.equal(reply.message_id, sent.messageId);
    // Reply all: everyone else from the letter in copy, without our own box; Re: is not doubled.
    const managerReply = card.emails[2];
    await call(`/api/deals/${openDeal}/emails/${outreach.id}/reply`, {method: 'POST', body: {text: 'Всем', reply_all: true, quote: false}, status: 201});
    assert.deepEqual(smtp.sent.at(-1).to, ['outreach@mailer.test']);
    assert.deepEqual(smtp.sent.at(-1).cc, ['client@acme.test']);
    assert.equal(smtp.sent.at(-1).text, 'Всем');
    await call(`/api/deals/${openDeal}/emails/${managerReply.id}/reply`, {method: 'POST', body: {text: 'Ещё раз'}, status: 201});
    assert.deepEqual(smtp.sent.at(-1).to, ['outreach@mailer.test'], 'our own sent letter: reply to its recipients');
    assert.equal(smtp.sent.at(-1).subject, 'Re: Предложение');
    assert.equal(smtp.sent.at(-1).references, '<f1@mailer.test> <r1@agency.test>');
    await call(`/api/deals/${openDeal}/emails/${outreach.id}/reply`, {method: 'POST', body: {text: 'x', to: ['not an address']}, status: 400});
    await call(`/api/deals/${openDeal}/emails/${outreach.id}/reply`, {method: 'POST', body: {text: ' '}, status: 400});
    const custom = await call(`/api/deals/${openDeal}/emails/${outreach.id}/reply`, {method: 'POST', body: {text: 'Другим', to: ['Boss@Acme.test'], cc: []}, status: 201});
    assert.deepEqual(custom.to, [{address: 'boss@acme.test', name: ''}]);
    // Gmail keeps the sent copy in All Mail with our Message-ID: the next sync does not duplicate it.
    imap.folders[1].messages.push({uid: 18, date: new Date(), source: letter({from: 'polza@agency.test', to: 'outreach@mailer.test', subject: 'Re: Предложение', id: sent.messageId, inReplyTo: '<f1@mailer.test>', references: '<f1@mailer.test>', date: new Date()})});
    assert.deepEqual(await call(`/api/mail/mailboxes/${mailbox.id}/sync?wait=1`, {method: 'POST'}), {added: 0, relinked: 0});
    const feed = await call(`/api/deals/${openDeal}/emails`);
    assert.equal(feed.filter(item => item.message_id === sent.messageId).length, 1);
    assert.equal(feed.length, 8, JSON.stringify(feed.map(item => [item.message_id, item.subject, item.text.slice(0, 20)])));

    // Manual linking and the unlinked list.
    const unlinked = await call('/api/mail/unlinked');
    assert.deepEqual(unlinked, []);
    await call(`/api/mail/emails/${question.id}/link`, {method: 'POST', body: {deal_id: null}});
    assert.equal((await call('/api/mail/unlinked'))[0].id, question.id);
    await call(`/api/mail/emails/${question.id}/link`, {method: 'POST', body: {deal_id: lostDeal}});
    assert.deepEqual(await db.prepare('SELECT deal_id,linked_by FROM emails WHERE id=?').get(question.id), {deal_id: lostDeal, linked_by: 'manual'});

    // API v1: letters need the emails:read scope.
    const reader = await call('/api/integrations/keys', {method: 'POST', body: {name: 'Портал', scopes: ['emails:read']}, status: 201});
    const dealsOnly = await call('/api/integrations/keys', {method: 'POST', body: {name: 'Сделки', scopes: ['deals:read']}, status: 201});
    const v1 = await call(`/api/v1/deals/${openDeal}/emails`, {key: reader.token});
    assert.equal(v1.items.length, 7);
    const v1Reply = v1.items.find(item => item.message_id === sent.messageId);
    assert.equal(v1Reply.in_reply_to, '<f1@mailer.test>');
    assert.deepEqual(v1Reply.references, ['<f1@mailer.test>']);
    assert.equal(v1Reply.direction, 'outgoing');
    assert.equal(v1Reply.text_truncated, false);
    await call(`/api/v1/deals/${openDeal}/emails`, {key: dealsOnly.token, status: 403});
    const page = await call('/api/v1/emails?limit=2', {key: reader.token});
    assert.equal(page.items.length, 2);
    assert.ok(page.next_after);
    assert.deepEqual((await call('/api/v1/emails?message_id=%3Cf1%40mailer.test%3E', {key: reader.token})).items.map(item => item.message_id).sort(), ['<f1@mailer.test>', '<r1@agency.test>', ...feed.filter(item => item.in_reply_to === '<f1@mailer.test>' && item.message_id !== '<r1@agency.test>').map(item => item.message_id)].sort());
    assert.equal((await call('/api/v1/emails?linked=0', {key: reader.token})).items.length, 0);

    // Employees: only admins manage mailboxes; deal visibility rules apply to letters.
    const allRights = {create: true, edit: true, delete: true, export: true};
    await call('/api/users', {method: 'POST', body: {name: 'Member', email: 'member@agency.test', password: 'member-password', role: 'member', deal_access: 'own', permissions: {deal: allRights}}, status: 201});
    const login = await fetch(`${base}/api/login`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({email: 'member@agency.test', password: 'member-password'})});
    assert.equal(login.status, 200);
    const member = login.headers.get('set-cookie').split(';')[0];
    await call('/api/mail/mailboxes', {as: member, status: 403});
    await call(`/api/deals/${openDeal}/emails`, {as: member, status: 403});
    await call(`/api/deals/${openDeal}/emails/${outreach.id}/reply`, {method: 'POST', as: member, body: {text: 'x'}, status: 403});

    // Direction inside a deal: the client (its address, or its domain unless it is a free mail service)
    // writes in; everyone else is ours. Threads with incomplete References link by subject.
    const {letterDirection, subjectKey} = await import('../server/mail.js');
    assert.equal(subjectKey('Re: Fwd: [#AB12CD34] Предложение  по CRM'), 'предложение по crm');
    assert.equal(subjectKey('Ответ: RE[2]: Тема'), 'тема');
    const buyer = await contact('Покупатель', 'buyer@gmail.com');
    const gmailDeal = await deal('Gmail', active, buyer, '2026-11-01 10:00:00');
    assert.equal(await letterDirection(db, {from_address: 'buyer@gmail.com'}, gmailDeal, new Set()), 'incoming');
    assert.equal(await letterDirection(db, {from_address: 'someone@gmail.com'}, gmailDeal, new Set()), 'outgoing', 'a free mail domain does not make a stranger the client');
    assert.equal(await letterDirection(db, {from_address: 'news@spam.test'}, null, new Set()), 'incoming', 'without a deal only our mailboxes are outgoing');
    const sync = `/api/mail/mailboxes/${mailbox.id}/sync?wait=1`;
    imap.folders[1].messages.push(
      {uid: 19, date: new Date(), source: letter({from: 'Коллега <colleague@acme.test>', to: 'polza@agency.test', subject: 'Re: Вопрос', id: '<c1@acme.test>', inReplyTo: '<m1@acme.test>', references: '<m1@acme.test>', date: new Date()})},
      {uid: 20, date: new Date(), source: letter({from: 'polza@agency.test', to: 'outreach@mailer.test', subject: 'RE: [#AB12CD34] Предложение', id: '<s1@agency.test>', date: new Date()})},
    );
    assert.deepEqual(await call(sync, {method: 'POST'}), {added: 2, relinked: 0});
    const stored1 = id => db.prepare('SELECT deal_id,linked_by,direction FROM emails WHERE message_id=?').get(id);
    assert.deepEqual(await stored1('<c1@acme.test>'), {deal_id: lostDeal, linked_by: 'thread', direction: 'incoming'}, 'a colleague on the client domain writes in');
    assert.deepEqual(await stored1('<s1@agency.test>'), {deal_id: openDeal, linked_by: 'subject', direction: 'outgoing'}, 'no References: same subject with the same correspondent');
    // The same subject with the same mailer box in two deals is ambiguous: the letter stays unlinked.
    await db.prepare("INSERT INTO emails (deal_id,linked_by,direction,message_id,from_address,to_json,subject,subject_key,sent_at) VALUES (?,'address','outgoing','<f2@mailer.test>','outreach@mailer.test','[{\"address\":\"other@one.test\",\"name\":\"\"}]','Предложение','предложение',?)").run(secondDeal, new Date().toISOString().slice(0, 19).replace('T', ' '));
    imap.folders[1].messages.push({uid: 21, date: new Date(), source: letter({from: 'polza@agency.test', to: 'outreach@mailer.test', subject: 'Re: Предложение', id: '<s2@agency.test>', date: new Date()})});
    assert.deepEqual(await call(sync, {method: 'POST'}), {added: 1, relinked: 0});
    assert.deepEqual(await stored1('<s2@agency.test>'), {deal_id: null, linked_by: '', direction: 'outgoing'});

    // Turning a mailbox off stops replies; deleting it keeps the letters in their deals.
    await call(`/api/mail/mailboxes/${mailbox.id}`, {method: 'PATCH', body: {enabled: false}});
    assert.match((await call(`/api/deals/${openDeal}/emails/${outreach.id}/reply`, {method: 'POST', body: {text: 'x'}, status: 409})).error, /выключен/);
    await call(`/api/mail/mailboxes/${mailbox.id}`, {method: 'DELETE'});
    assert.equal((await call(`/api/deals/${openDeal}/emails`)).length, 8, 'the letters stay after the mailbox is deleted');
    assert.match((await call(`/api/deals/${openDeal}/emails/${outreach.id}/reply`, {method: 'POST', body: {text: 'x'}, status: 409})).error, /отключён/);
    assert.ok(await db.prepare("SELECT 1 FROM audit_log WHERE action='email.sent'").get());

    // Google mailbox: Gmail servers and an XOAUTH2 token for the impersonated address.
    const {privateKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
    const originalFetch = mailHooks.fetch;
    mailHooks.fetch = async () => ({ok: true, status: 200, json: async () => ({access_token: 'ya29.google', expires_in: 3600})});
    try {
      const google = await call('/api/mail/mailboxes', {method: 'POST', body: {email: 'julia@agency.test', auth_type: 'google_sa', service_account: JSON.stringify({type: 'service_account', client_email: 'sync@p.iam.gserviceaccount.com', private_key: privateKey.export({type: 'pkcs8', format: 'pem'})})}, status: 201});
      assert.equal(google.imap_host, 'imap.gmail.com');
      assert.equal(google.smtp_host, 'smtp.gmail.com');
      assert.equal(google.service_account, 'sync@p.iam.gserviceaccount.com');
      assert.ok(!JSON.stringify(google).includes('PRIVATE KEY'));
      assert.deepEqual(imap.options.at(-1).auth, {user: 'julia@agency.test', accessToken: 'ya29.google'});
      assert.deepEqual(smtp.smtpOptions.at(-1).auth, {type: 'OAuth2', user: 'julia@agency.test', accessToken: 'ya29.google'});
    } finally { mailHooks.fetch = originalFetch; }
  } finally {
    server.close();
    await db.close?.();
    rmSync(dir, {recursive: true, force: true});
  }
});
