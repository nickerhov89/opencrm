// The «Сообщения» panel at the bottom of the menu: what needs the employee's attention, built from the
// data on request (nothing is stored except when the panel was last opened).
//   - overdue tasks and tasks due within the hour (own tasks);
//   - unread incoming letters of the employee's deals (admins: of all deals and unlinked ones);
//   - new requests in «Неразобранное» (who may create deals);
//   - unread «Чат» messages from colleagues (30 days), until the deal is opened.
import {unreadChat} from './team-chat.js';

const iso = date => date.toISOString();

export function registerNotifications(app, db, {auth}) {
  async function collect(req) {
    const now = new Date(), soon = new Date(now.getTime() + 60 * 60 * 1000), week = new Date(now.getTime() - 7 * 864e5);
    const user = req.user, admin = user.role === 'admin', items = [];
    const tasks = await db.prepare(`SELECT t.id,t.title,t.task_type,t.due_at,t.all_day,t.deal_id,t.contact_id,t.company_id,d.name deal_name FROM tasks t LEFT JOIN deals d ON d.id=t.deal_id
      WHERE t.owner_id=? AND t.completed_at IS NULL AND t.deleted_at IS NULL AND (t.deal_id IS NULL OR d.deleted_at IS NULL) AND t.due_at IS NOT NULL AND t.due_at<? ORDER BY t.due_at DESC LIMIT 100`).all(user.id, iso(soon));
    for (const task of tasks) {
      const overdue = task.due_at < iso(now);
      items.push({id: `task:${task.id}:${overdue ? 'overdue' : 'due'}`, kind: overdue ? 'task_overdue' : 'task_due', title: overdue ? 'Просроченная задача' : 'Пора выполнить задачу', text: `${task.task_type || 'Задача'}: ${task.title}`, subtitle: task.deal_name || '', at: task.due_at, shown: overdue ? task.due_at : iso(new Date(Date.parse(task.due_at) - 60 * 60 * 1000)), deal_id: task.deal_id, task_id: task.id, contact_id: task.contact_id, company_id: task.company_id});
    }
    const scope = admin ? '1=1' : `e.deal_id IN (SELECT d.id FROM deals d WHERE d.deleted_at IS NULL AND d.owner_id=?)`;
    const letters = await db.prepare(`SELECT e.id,e.subject,e.from_address,e.from_name,e.body,e.sent_at,e.deal_id,d.name deal_name FROM emails e LEFT JOIN deals d ON d.id=e.deal_id
      WHERE e.direction='incoming' AND e.read_at IS NULL AND e.sent_at>=? AND ${scope} ORDER BY e.sent_at DESC LIMIT 100`).all(iso(week).slice(0, 19).replace('T', ' '), ...(admin ? [] : [user.id]));
    for (const letter of letters) items.push({id: `email:${letter.id}`, kind: 'email', title: letter.subject || 'Без темы', text: `От: ${letter.from_name ? `${letter.from_name} <${letter.from_address}>` : letter.from_address}`, subtitle: [letter.deal_name, letter.body.replace(/\s+/g, ' ').slice(0, 120)].filter(Boolean).join(' · '), at: letter.sent_at, deal_id: letter.deal_id, email_id: letter.id});
    for (const message of await unreadChat(db, user.id, iso(new Date(now.getTime() - 30 * 864e5)).slice(0, 19).replace('T', ' ')))
      items.push({id: `chat:${message.id}`, kind: 'chat', title: `Чат: ${message.deal_name}`, text: `${message.author || 'Сотрудник'}: ${message.body.replace(/\s+/g, ' ').slice(0, 160)}`, subtitle: '', at: message.created_at, deal_id: message.deal_id});
    if (admin || user.permissions?.deal?.create === true) {
      // «Only own deals» employees see only the requests they added themselves (as in «Неразобранное»).
      const own = !admin && user.deal_access === 'own';
      const leads = await db.prepare(`SELECT id,title,contact_name,company_name,phone,email,created_at FROM inbox_leads WHERE status='pending' AND created_at>=?${own ? ' AND created_by=?' : ''} ORDER BY id DESC LIMIT 50`).all(iso(week).slice(0, 19).replace('T', ' '), ...(own ? [user.id] : []));
      for (const lead of leads) items.push({id: `lead:${lead.id}`, kind: 'lead', title: 'Новая заявка', text: lead.title, subtitle: [lead.contact_name, lead.company_name, lead.phone, lead.email].filter(Boolean).join(', '), at: lead.created_at, lead_id: lead.id});
    }
    const stamp = value => { const text = String(value || ''); return Date.parse(text.includes('T') ? text : text.replace(' ', 'T') + 'Z') || 0; };
    items.sort((a, b) => stamp(b.at) - stamp(a.at));
    const seen = (await db.prepare('SELECT notifications_seen_at FROM users WHERE id=?').get(user.id))?.notifications_seen_at;
    const seenAt = seen ? stamp(seen) : 0;
    // An item is new when it appeared after the panel was last opened: a task «пора выполнить» an hour
    // before its time, an overdue task at its time, a letter or a request when it arrived.
    const isNew = item => stamp(item.shown || item.at) > seenAt;
    return {items: items.slice(0, 200).map(({shown, ...item}) => ({...item, new: isNew({shown, ...item})})), unseen: items.filter(isNew).length};
  }
  app.get('/api/notifications', auth, async (req, res) => res.json(await collect(req)));
  app.get('/api/notifications/count', auth, async (req, res) => res.json({unseen: (await collect(req)).unseen}));
  app.post('/api/notifications/seen', auth, async (req, res) => {
    await db.prepare('UPDATE users SET notifications_seen_at=? WHERE id=?').run(new Date().toISOString(), req.user.id);
    res.json({ok: true});
  });
}
