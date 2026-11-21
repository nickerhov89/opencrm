// «Чат» in a deal: employees write to each other about the deal, like amoCRM's chat with an
// employee. A message has an author and recipients; it shows in the deal feed with who has read it
// and in the recipients' «Сообщения» panel until they open the deal.

const text = (value, max) => String(value ?? '').trim().slice(0, max);

// Messages of a deal, oldest first, with recipients and read marks. Opening the deal marks the
// viewer's messages read.
export async function dealChat(db, dealId, viewerId) {
  if (viewerId) await db.prepare('UPDATE team_message_recipients SET read_at=now_text() WHERE user_id=? AND read_at IS NULL AND message_id IN (SELECT id FROM team_messages WHERE deal_id=?)').run(viewerId, dealId);
  const messages = await db.prepare('SELECT m.id,m.deal_id,m.author_id,m.body,m.created_at,u.name author FROM team_messages m LEFT JOIN users u ON u.id=m.author_id WHERE m.deal_id=? ORDER BY m.id').all(dealId);
  if (!messages.length) return [];
  const recipients = await db.prepare('SELECT r.message_id,r.user_id,r.read_at,u.name FROM team_message_recipients r JOIN team_messages m ON m.id=r.message_id LEFT JOIN users u ON u.id=r.user_id WHERE m.deal_id=? ORDER BY u.name').all(dealId);
  const byMessage = new Map();
  for (const row of recipients) {
    const list = byMessage.get(Number(row.message_id)) || [];
    list.push({id: Number(row.user_id), name: row.name || `Сотрудник #${row.user_id}`, read_at: row.read_at});
    byMessage.set(Number(row.message_id), list);
  }
  return messages.map(message => ({...message, recipients: byMessage.get(Number(message.id)) || []}));
}

// Unread messages for the «Сообщения» panel.
export async function unreadChat(db, userId, since) {
  return db.prepare(`SELECT m.id,m.deal_id,m.body,m.created_at,u.name author,d.name deal_name FROM team_message_recipients r
    JOIN team_messages m ON m.id=r.message_id JOIN deals d ON d.id=m.deal_id LEFT JOIN users u ON u.id=m.author_id
    WHERE r.user_id=? AND r.read_at IS NULL AND d.deleted_at IS NULL AND m.created_at>=? ORDER BY m.id DESC LIMIT 100`).all(userId, since);
}

export function registerTeamChat(app, db, {auth, dealAllowed}) {
  const fail = (res, status, error) => res.status(status).json({error});

  app.get('/api/deals/:id/chat', auth, async (req, res) => {
    const id = Number(req.params.id) || 0;
    if (!await dealAllowed(req, id)) return fail(res, 404, 'Сделка не найдена');
    res.json(await dealChat(db, id, req.user.id));
  });

  // body: {body, to: [user ids] | 'all'}. 'all' is every active employee except the author.
  app.post('/api/deals/:id/chat', auth, async (req, res) => {
    const id = Number(req.params.id) || 0;
    if (!await dealAllowed(req, id)) return fail(res, 404, 'Сделка не найдена');
    const body = text(req.body?.body, 5000);
    if (!body) return fail(res, 400, 'Напишите сообщение');
    // Only employees who can open the deal: administrators, full access, or its owner.
    const active = (await db.prepare("SELECT u.id FROM users u WHERE u.disabled_at IS NULL AND u.id<>? AND (u.role='admin' OR u.deal_access<>'own' OR u.id=(SELECT owner_id FROM deals WHERE id=?))").all(req.user.id, id)).map(row => Number(row.id));
    const to = req.body?.to === 'all' ? active : Array.isArray(req.body?.to) ? [...new Set(req.body.to.map(Number))] : [];
    if (!to.length) return fail(res, 400, 'Выберите, кому написать');
    if (to.length > 200 || to.some(userId => !active.includes(userId))) return fail(res, 400, 'Получатель не найден или отключён');
    const messageId = await db.transaction(async () => {
      const created = (await db.prepare('INSERT INTO team_messages (deal_id,author_id,body) VALUES (?,?,?)').run(id, req.user.id, body)).lastInsertRowid;
      for (const userId of to) await db.prepare('INSERT INTO team_message_recipients (message_id,user_id) VALUES (?,?)').run(created, userId);
      return created;
    })();
    const message = (await dealChat(db, id, null)).find(item => Number(item.id) === Number(messageId));
    res.status(201).json(message);
  });
}
