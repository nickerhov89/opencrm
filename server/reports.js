// Analytics reports beyond the pipeline: «Звонки» (calls by employee, like amoCRM's call report)
// and «Цели» (monthly goals per employee by won budget and number of won deals).
//
// Calls come from three places:
//   - notes of type call_in / call_out — calls loaded from amoCRM (deal, contact and company notes);
//   - deal_communications with kind 'call' — calls an employee recorded in the deal feed;
//   - plugin_mango_calls — calls of the Mango Office plugin, when it is installed. The plugin also
//     writes deal_communications; those rows are skipped so a call is counted once.

const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/;

// «Длительность: 1:05» or «1:02:03» in a note loaded from amoCRM → seconds.
export function noteSeconds(body) {
  const match = String(body || '').match(/Длительность:\s*(\d+(?::\d{1,2}){0,2})/);
  if (!match) return 0;
  return match[1].split(':').map(Number).reduce((total, part) => total * 60 + part, 0);
}

const noteResult = body => String(body || '').match(/Результат:\s*([^\n]*)/)?.[1]?.trim() || '';
const noteRecording = body => String(body || '').match(/Запись:\s*(https?:\/\/\S+)/)?.[1] || '';

export function registerReports(app, db, {auth, admin, audit}) {
  const fail = (res, status, error) => res.status(status).json({error});
  const fullAccess = user => user.role === 'admin' || user.deal_access !== 'own' && user.task_access !== 'own';
  const period = req => {
    const {from, to} = req.query;
    if (typeof from !== 'string' || typeof to !== 'string' || !dayPattern.test(from) || !dayPattern.test(to) || !Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to)) || from > to || Date.parse(to) - Date.parse(from) > 366 * 864e5) return null;
    return [from, to];
  };
  const mangoInstalled = async () => !!await db.prepare("SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'plugin_mango_calls'").get();

  async function calls(from, to) {
    const range = [from, `${to} 23:59:59`];
    const rows = [];
    for (const row of await db.prepare(`SELECT n.id,n.note_type,n.user_id,n.body,n.created_at,d.id deal_id,d.name deal_name FROM notes n JOIN deals d ON d.id=n.deal_id
      WHERE n.note_type IN ('call_in','call_out') AND d.deleted_at IS NULL AND n.created_at BETWEEN ? AND ?`).all(...range))
      rows.push({key: `n${row.id}`, at: row.created_at, direction: row.note_type === 'call_in' ? 'incoming' : 'outgoing', user_id: row.user_id, seconds: noteSeconds(row.body), result: noteResult(row.body), recording: noteRecording(row.body), target: {kind: 'deal', id: row.deal_id, name: row.deal_name}});
    for (const row of await db.prepare(`SELECT e.id,e.note_type,e.user_id,e.body,e.created_at,e.entity_type,e.entity_id,COALESCE(c.name,co.name) name FROM entity_notes e
      LEFT JOIN contacts c ON e.entity_type='contact' AND c.id=e.entity_id AND c.deleted_at IS NULL
      LEFT JOIN companies co ON e.entity_type='company' AND co.id=e.entity_id AND co.deleted_at IS NULL
      WHERE e.note_type IN ('call_in','call_out') AND e.created_at BETWEEN ? AND ? AND COALESCE(c.id,co.id) IS NOT NULL`).all(...range))
      rows.push({key: `e${row.id}`, at: row.created_at, direction: row.note_type === 'call_in' ? 'incoming' : 'outgoing', user_id: row.user_id, seconds: noteSeconds(row.body), result: noteResult(row.body), recording: noteRecording(row.body), target: {kind: row.entity_type, id: row.entity_id, name: row.name}});
    const mango = await mangoInstalled();
    for (const row of await db.prepare(`SELECT m.id,m.direction,m.user_id,m.subject,m.body,m.created_at,d.id deal_id,d.name deal_name FROM deal_communications m JOIN deals d ON d.id=m.deal_id
      WHERE m.kind='call' AND d.deleted_at IS NULL AND m.created_at BETWEEN ? AND ?
      ${mango ? 'AND NOT EXISTS (SELECT 1 FROM plugin_mango_calls p WHERE p.deal_id=m.deal_id AND p.started_at=m.created_at)' : ''}`).all(...range))
      rows.push({key: `c${row.id}`, at: row.created_at, direction: row.direction, user_id: row.user_id, seconds: 0, result: row.subject || '', recording: '', target: {kind: 'deal', id: row.deal_id, name: row.deal_name}});
    if (mango) {
      for (const row of await db.prepare(`SELECT p.entry_id,p.direction,p.user_id,p.answered,p.duration,p.started_at,p.number,p.recording_id,p.deal_id,p.contact_id,p.company_id,p.lead_id,d.name deal_name,c.name contact_name,co.name company_name
        FROM plugin_mango_calls p LEFT JOIN deals d ON d.id=p.deal_id AND d.deleted_at IS NULL LEFT JOIN contacts c ON c.id=p.contact_id AND c.deleted_at IS NULL LEFT JOIN companies co ON co.id=p.company_id AND co.deleted_at IS NULL
        WHERE p.started_at BETWEEN ? AND ?`).all(...range)) {
        const target = row.deal_name ? {kind: 'deal', id: row.deal_id, name: row.deal_name} : row.contact_name ? {kind: 'contact', id: row.contact_id, name: row.contact_name} : row.company_name ? {kind: 'company', id: row.company_id, name: row.company_name} : {kind: row.lead_id ? 'lead' : 'phone', id: row.lead_id || null, name: row.number};
        rows.push({key: `m${row.entry_id}`, at: row.started_at, direction: row.direction, user_id: row.user_id, seconds: Number(row.duration) || 0, result: row.answered ? 'Разговор' : row.direction === 'incoming' ? 'Пропущен' : 'Не дозвонились', recording: row.recording_id ? `/api/plugins/mango-office/recording/${encodeURIComponent(row.entry_id)}` : '', target});
      }
    }
    return rows;
  }

  app.get('/api/reports/calls', auth, async (req, res) => {
    if (!fullAccess(req.user)) return fail(res, 403, 'Аналитика доступна только при полном доступе к сделкам и задачам');
    const range = period(req);
    if (!range) return fail(res, 400, 'Проверьте период отчёта');
    const direction = ['incoming', 'outgoing'].includes(req.query.direction) ? req.query.direction : '';
    const rows = await calls(...range);
    const users = new Map((await db.prepare('SELECT id,name FROM users').all()).map(user => [Number(user.id), user.name]));
    const people = new Map();
    for (const row of rows) {
      const id = row.user_id == null ? null : Number(row.user_id);
      const person = people.get(id) || {user_id: id, name: id == null ? 'Без сотрудника' : users.get(id) || `Сотрудник #${id}`, incoming: 0, outgoing: 0, seconds: 0};
      person[row.direction === 'incoming' ? 'incoming' : 'outgoing']++;
      person.seconds += row.seconds;
      people.set(id, person);
    }
    const list = [...people.values()].sort((a, b) => (a.user_id == null) - (b.user_id == null) || b.incoming + b.outgoing - a.incoming - a.outgoing || a.name.localeCompare(b.name, 'ru'));
    const total = list.reduce((sum, person) => ({incoming: sum.incoming + person.incoming, outgoing: sum.outgoing + person.outgoing, seconds: sum.seconds + person.seconds}), {incoming: 0, outgoing: 0, seconds: 0});
    // As in amoCRM, the average is over every row of the chart, calls without an employee included.
    const staff = list.length || 1;
    const recent = rows.filter(row => !direction || row.direction === direction)
      .sort((a, b) => b.at.localeCompare(a.at) || b.key.localeCompare(a.key)).slice(0, 100)
      .map(row => ({...row, user_name: row.user_id == null ? '' : users.get(Number(row.user_id)) || ''}));
    res.json({from: range[0], to: range[1], people: list, total, average: {incoming: Math.round(total.incoming / staff), outgoing: Math.round(total.outgoing / staff), seconds: Math.round(total.seconds / staff)}, recent});
  });

  // Goals: one row per employee and month. Progress is won deals of the employee closed that month.
  async function goals(month) {
    const [year, number] = month.split('-').map(Number);
    const next = number === 12 ? `${year + 1}-01` : `${year}-${String(number + 1).padStart(2, '0')}`;
    const rows = await db.prepare(`SELECT u.id user_id,u.name,u.disabled_at,g.amount goal_amount,g.deals goal_deals,
      (SELECT COUNT(*) FROM deals d JOIN stages s ON s.id=d.stage_id WHERE d.deleted_at IS NULL AND s.kind='won' AND d.owner_id=u.id AND d.closed_at>=? AND d.closed_at<?) won_deals,
      (SELECT COALESCE(SUM(d.amount),0) FROM deals d JOIN stages s ON s.id=d.stage_id WHERE d.deleted_at IS NULL AND s.kind='won' AND d.owner_id=u.id AND d.closed_at>=? AND d.closed_at<?) won_amount
      FROM users u LEFT JOIN sales_goals g ON g.user_id=u.id AND g.month=? ORDER BY u.name`).all(`${month}-01`, `${next}-01`, `${month}-01`, `${next}-01`, month);
    const people = rows.filter(row => !row.disabled_at || row.goal_amount != null).map(row => ({user_id: Number(row.user_id), name: row.name, goal_amount: Number(row.goal_amount) || 0, goal_deals: Number(row.goal_deals) || 0, won_amount: Number(row.won_amount) || 0, won_deals: Number(row.won_deals) || 0}));
    const sum = key => people.reduce((total, person) => total + person[key], 0);
    return {month, people, total: {goal_amount: sum('goal_amount'), goal_deals: sum('goal_deals'), won_amount: sum('won_amount'), won_deals: sum('won_deals')}};
  }

  app.get('/api/reports/goals', auth, async (req, res) => {
    if (!fullAccess(req.user)) return fail(res, 403, 'Аналитика доступна только при полном доступе к сделкам и задачам');
    const month = typeof req.query.month === 'string' ? req.query.month : '';
    if (!monthPattern.test(month)) return fail(res, 400, 'Месяц: ГГГГ-ММ');
    res.json(await goals(month));
  });

  app.put('/api/reports/goals', auth, admin, async (req, res) => {
    const {month, goals: input} = req.body || {};
    if (typeof month !== 'string' || !monthPattern.test(month) || !Array.isArray(input) || input.length > 500) return fail(res, 400, 'Передайте month (ГГГГ-ММ) и goals: [{user_id, amount, deals}]');
    const items = input.map(item => ({user_id: Number(item?.user_id), amount: Number(item?.amount ?? 0), deals: Number(item?.deals ?? 0)}));
    if (items.some(item => !Number.isSafeInteger(item.user_id) || !Number.isSafeInteger(item.amount) || item.amount < 0 || item.amount > 1e13 || !Number.isSafeInteger(item.deals) || item.deals < 0 || item.deals > 1e6)) return fail(res, 400, 'Цель — целые неотрицательные бюджет и количество сделок');
    const known = new Set((await db.prepare('SELECT id FROM users').all()).map(user => Number(user.id)));
    if (items.some(item => !known.has(item.user_id))) return fail(res, 400, 'Сотрудник не найден');
    await db.transaction(async () => {
      for (const item of items) {
        if (!item.amount && !item.deals) await db.prepare('DELETE FROM sales_goals WHERE month=? AND user_id=?').run(month, item.user_id);
        else await db.prepare('INSERT INTO sales_goals (month,user_id,amount,deals) VALUES (?,?,?,?) ON CONFLICT (month,user_id) DO UPDATE SET amount=excluded.amount,deals=excluded.deals').run(month, item.user_id, item.amount, item.deals);
      }
    })();
    const result = await goals(month);
    await audit(req, 'goals.updated', {target: `goals:${month}`, details: `Бюджет ${result.total.goal_amount} ₽, сделок ${result.total.goal_deals}`});
    res.json(result);
  });
}
