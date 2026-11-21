// Distribution of new deals between managers, like the amoCRM «Распределение сделок» widget.
// Every new deal is queued by a trigger (deal_distribution_queue). A few seconds later — after the
// portal or the API has written the custom fields, «Источник» included — the first active rule that
// matches the deal's pipeline and source picks the next manager in turn. The manager becomes the
// owner of the deal, its main contact, its company and its open tasks; then the rule's task
// («Связаться: Взять в работу») is created for that manager.
// Deals loaded with an old creation date (moves from amoCRM) are never redistributed.
export const origins = ['api', 'inbox', 'manual'];
// Called where a deal is created: api — API v1 (the portal, integrations), inbox — a request accepted
// from «Неразобранное», manual — created by an employee. Queued only when an active rule takes that origin.
export async function queueDistribution(db, dealId, origin) {
  const rules = await db.prepare("SELECT origins_json FROM deal_distribution_rules WHERE active=1").all();
  if (!rules.some(rule => json(rule.origins_json, []).includes(origin))) return false;
  await db.prepare("INSERT INTO deal_distribution_queue (deal_id,origin,queued_at) VALUES (?,?,?) ON CONFLICT (deal_id) DO NOTHING").run(dealId, origin, Date.now());
  return true;
}
export const distributionDelayMs = () => Math.max(Number(process.env.OPENCRM_DISTRIBUTION_DELAY_MS ?? 3000), 0);
const maxAgeMs = 30 * 60 * 1000;
const stampOf = value => Date.parse(String(value || '').includes('T') ? value : String(value || '').replace(' ', 'T') + 'Z');
const json = (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } };
const lower = value => String(value || '').trim().toLowerCase();

// End of the deal's creation day in Moscow, as amoCRM robots set «до конца дня».
function endOfDay(createdAt) {
  const moscow = new Date(stampOf(createdAt) + 3 * 3600e3);
  return new Date(Date.UTC(moscow.getUTCFullYear(), moscow.getUTCMonth(), moscow.getUTCDate(), 23, 59) - 3 * 3600e3).toISOString();
}

export function ruleView(row, users = []) {
  const ids = json(row.user_ids_json, []);
  return {id: row.id, name: row.name, pipeline_id: row.pipeline_id, origins: json(row.origins_json, []), sources: json(row.sources_json, []), user_ids: ids, users: ids.map(id => users.find(user => Number(user.id) === Number(id))?.name || `#${id}`), task_title: row.task_title, task_type: row.task_type, active: !!row.active, sort_order: Number(row.sort_order), next_index: Number(row.next_index), assigned: Number(row.assigned || 0), created_at: row.created_at};
}

async function matchRule(db, deal) {
  const rules = (await db.prepare('SELECT * FROM deal_distribution_rules WHERE active=1 ORDER BY sort_order,id').all()).filter(rule => json(rule.origins_json, []).includes(deal.origin));
  return rules.find(rule => (rule.pipeline_id == null || Number(rule.pipeline_id) === Number(deal.pipeline_id))
    && (() => { const sources = json(rule.sources_json, []).map(lower).filter(Boolean); return !sources.length || sources.includes(lower(deal.source)); })()) || null;
}

// One queued deal. Returns the manager's id, or null when no rule applies.
export async function distributeDeal(db, dealId, {now = Date.now} = {}) {
  const queued = await db.prepare('SELECT origin FROM deal_distribution_queue WHERE deal_id=?').get(dealId);
  return await db.transaction(async () => {
    const deal = await db.prepare('SELECT d.id,d.name,d.owner_id,d.contact_id,d.company_id,d.source,d.created_at,d.deleted_at,s.pipeline_id FROM deals d JOIN stages s ON s.id=d.stage_id WHERE d.id=? FOR UPDATE OF d').get(dealId);
    await db.prepare('DELETE FROM deal_distribution_queue WHERE deal_id=?').run(dealId);
    if (!deal || !queued || deal.deleted_at || now() - stampOf(deal.created_at) > maxAgeMs) return null;
    const rule = await matchRule(db, {...deal, origin: queued.origin});
    if (!rule) return null;
    const locked = await db.prepare('SELECT * FROM deal_distribution_rules WHERE id=? FOR UPDATE').get(rule.id);
    const active = (await db.prepare("SELECT id,name FROM users WHERE disabled_at IS NULL").all()).map(user => [Number(user.id), user.name]);
    const candidates = json(locked.user_ids_json, []).map(Number).filter(id => active.some(([user]) => user === id));
    if (!candidates.length) return null;
    const index = Number(locked.next_index) % candidates.length, owner = candidates[index], name = active.find(([user]) => user === owner)[1];
    await db.prepare('UPDATE deal_distribution_rules SET next_index=?,assigned=assigned+1 WHERE id=?').run((index + 1) % candidates.length, rule.id);
    await db.prepare('UPDATE deals SET owner_id=? WHERE id=?').run(owner, deal.id);
    if (deal.contact_id) await db.prepare('UPDATE contacts SET owner_id=? WHERE id=? AND deleted_at IS NULL').run(owner, deal.contact_id);
    if (deal.company_id) await db.prepare('UPDATE companies SET owner_id=? WHERE id=? AND deleted_at IS NULL').run(owner, deal.company_id);
    await db.prepare('UPDATE tasks SET owner_id=? WHERE deal_id=? AND completed_at IS NULL AND deleted_at IS NULL').run(owner, deal.id);
    await db.prepare('INSERT INTO activity (deal_id,user_id,event) VALUES (?,NULL,?)').run(deal.id, `Распределение сделок («${rule.name}»): ответственный — ${name}`);
    if (rule.task_title) {
      await db.prepare('INSERT INTO tasks (title,task_type,due_at,deal_id,owner_id) VALUES (?,?,?,?,?)').run(rule.task_title, rule.task_type || 'Связаться', endOfDay(deal.created_at), deal.id, owner);
      await db.prepare('INSERT INTO activity (deal_id,user_id,event) VALUES (?,NULL,?)').run(deal.id, `Робот: задача «${rule.task_type || 'Связаться'}: ${rule.task_title}» для ${name}`);
    }
    return owner;
  })();
}

// Deals queued at least `delay` ms ago.
export async function processDistributionQueue(db, {now = Date.now, delay = distributionDelayMs()} = {}) {
  const before = now() - delay;
  const rows = await db.prepare('SELECT deal_id FROM deal_distribution_queue WHERE queued_at<=? ORDER BY queued_at,deal_id LIMIT 200').all(before);
  let assigned = 0;
  for (const row of rows) { try { if (await distributeDeal(db, row.deal_id, {now})) assigned++; } catch (error) { console.error(`Распределение, сделка ${row.deal_id}:`, error.message); } }
  return assigned;
}

export function registerDistribution(app, db, {auth, admin, audit}) {
  const users = () => db.prepare('SELECT id,name FROM users').all();
  const read = async (body, old = {}) => {
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 120) : old.name;
    if (!name) throw Object.assign(new Error('Название правила'), {status: 400});
    const pipeline = body.pipeline_id === undefined ? old.pipeline_id ?? null : body.pipeline_id === null || body.pipeline_id === '' ? null : Number(body.pipeline_id);
    if (pipeline !== null && !(await db.prepare('SELECT 1 FROM pipelines WHERE id=?').get(pipeline))) throw Object.assign(new Error('Воронка не найдена'), {status: 400});
    const sources = body.sources === undefined ? json(old.sources_json, []) : body.sources;
    if (!Array.isArray(sources) || sources.length > 100 || sources.some(item => typeof item !== 'string' || item.length > 200)) throw Object.assign(new Error('Источники: список строк'), {status: 400});
    const from = body.origins === undefined ? json(old.origins_json, ['api']) : body.origins;
    if (!Array.isArray(from) || !from.length || from.some(item => !origins.includes(item))) throw Object.assign(new Error('Откуда сделки: api, inbox, manual'), {status: 400});
    const ids = body.user_ids === undefined ? json(old.user_ids_json, []) : body.user_ids;
    if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some(id => !Number.isInteger(Number(id)))) throw Object.assign(new Error('Выберите сотрудников'), {status: 400});
    const known = new Set((await users()).map(user => Number(user.id)));
    if (ids.some(id => !known.has(Number(id)))) throw Object.assign(new Error('Сотрудник не найден'), {status: 400});
    const title = body.task_title === undefined ? old.task_title ?? '' : String(body.task_title || '').trim().slice(0, 500);
    const type = body.task_type === undefined ? old.task_type ?? 'Связаться' : String(body.task_type || 'Связаться').trim().slice(0, 50);
    const active = body.active === undefined ? (old.active ?? 0) : body.active === true ? 1 : 0;
    const order = body.sort_order === undefined ? Number(old.sort_order ?? 0) : Number(body.sort_order);
    if (!Number.isInteger(order)) throw Object.assign(new Error('Порядок: целое число'), {status: 400});
    return {name, pipeline, origins: [...new Set(from)], sources: [...new Set(sources.map(item => item.trim()).filter(Boolean))], ids: [...new Set(ids.map(Number))], title, type, active, order};
  };
  const route = fn => async (req, res, next) => { try { await fn(req, res); } catch (error) { if (error.status) return res.status(error.status).json({error: error.message}); next(error); } };
  const list = async () => { const all = await users(); return (await db.prepare('SELECT * FROM deal_distribution_rules ORDER BY sort_order,id').all()).map(row => ruleView(row, all)); };
  app.get('/api/distribution/rules', auth, admin, route(async (req, res) => res.json(await list())));
  app.post('/api/distribution/rules', auth, admin, route(async (req, res) => {
    const rule = await read(req.body || {});
    const row = await db.prepare('INSERT INTO deal_distribution_rules (name,pipeline_id,origins_json,sources_json,user_ids_json,task_title,task_type,active,sort_order) VALUES (?,?,?,?,?,?,?,?,?)').run(rule.name, rule.pipeline, JSON.stringify(rule.origins), JSON.stringify(rule.sources), JSON.stringify(rule.ids), rule.title, rule.type, rule.active, rule.order);
    await audit(req, 'distribution.rule_created', {target: `distribution_rule:${row.lastInsertRowid}`, details: `${rule.name}${rule.active ? '' : ' (выключено)'}`});
    res.status(201).json((await list()).find(item => Number(item.id) === Number(row.lastInsertRowid)));
  }));
  app.patch('/api/distribution/rules/:id', auth, admin, route(async (req, res) => {
    const old = await db.prepare('SELECT * FROM deal_distribution_rules WHERE id=?').get(Number(req.params.id) || 0);
    if (!old) return res.status(404).json({error: 'Правило не найдено'});
    const rule = await read(req.body || {}, old);
    const usersChanged = JSON.stringify(rule.ids) !== JSON.stringify(json(old.user_ids_json, []));
    await db.prepare('UPDATE deal_distribution_rules SET name=?,pipeline_id=?,origins_json=?,sources_json=?,user_ids_json=?,task_title=?,task_type=?,active=?,sort_order=?,next_index=CASE WHEN ? THEN 0 ELSE next_index END WHERE id=?').run(rule.name, rule.pipeline, JSON.stringify(rule.origins), JSON.stringify(rule.sources), JSON.stringify(rule.ids), rule.title, rule.type, rule.active, rule.order, usersChanged ? 1 : 0, old.id);
    if (!!old.active !== !!rule.active || usersChanged) await audit(req, 'distribution.rule_updated', {target: `distribution_rule:${old.id}`, details: [rule.name, !!old.active !== !!rule.active && (rule.active ? 'включено' : 'выключено'), usersChanged && 'сотрудники изменены'].filter(Boolean).join('; ')});
    res.json((await list()).find(item => Number(item.id) === Number(old.id)));
  }));
  app.delete('/api/distribution/rules/:id', auth, admin, route(async (req, res) => {
    const old = await db.prepare('SELECT * FROM deal_distribution_rules WHERE id=?').get(Number(req.params.id) || 0);
    if (!old) return res.status(404).json({error: 'Правило не найдено'});
    await db.prepare('DELETE FROM deal_distribution_rules WHERE id=?').run(old.id);
    await audit(req, 'distribution.rule_deleted', {target: `distribution_rule:${old.id}`, details: old.name});
    res.json({ok: true});
  }));

  if (process.env.NODE_ENV !== 'test' || process.env.OPENCRM_DISTRIBUTION_WORKER === '1') {
    let busy = false;
    const run = async () => { if (busy) return; busy = true; try { await processDistributionQueue(db); } catch (error) { console.error('Распределение:', error.message); } finally { busy = false; } };
    setInterval(run, 2000).unref();
  }
}
