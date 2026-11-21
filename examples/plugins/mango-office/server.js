import {createHash, timingSafeEqual} from 'node:crypto';
import {Readable} from 'node:stream';

// Mango Office VPBX API. Mango sends realtime events as form POSTs (vpbx_api_key, sign, json) to
// <address>/events/<name>; sign = sha256(vpbx_api_key + json + salt). The plugin uses:
//   events/summary       — one per finished call: direction, numbers, extension, times, answered or not;
//   events/record/added  — the recording of a call is saved (recording_id).
// Recordings are fetched through POST queries/recording/post, which redirects to a one-time file link.

const sha256 = text => createHash('sha256').update(text).digest('hex');
const sameHex = (a, b) => typeof a === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const digits = value => String(value ?? '').replace(/\D/g, '');
const phoneKey = value => digits(value).slice(-10);
export const prettyPhone = value => {
  const d = digits(value);
  if (d.length === 11 && /^[78]/.test(d)) return `+7 ${d.slice(1, 4)} ${d.slice(4, 7)}-${d.slice(7, 9)}-${d.slice(9)}`;
  if (d.length === 10) return `+7 ${d.slice(0, 3)} ${d.slice(3, 6)}-${d.slice(6, 8)}-${d.slice(8)}`;
  return d ? (d.length > 7 ? `+${d}` : d) : 'скрытый номер';
};
export const callLength = seconds => seconds >= 3600
  ? `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
  : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
// Event times are Unix seconds.
const moment = value => Number(value) > 0 ? new Date(Number(value) * 1000) : new Date();
const sqlTime = date => date.toISOString().slice(0, 19).replace('T', ' ');

// «101 = anna@company.ru» lines → extension → user id.
async function employeeMap(ctx) {
  const map = new Map();
  for (const line of String(ctx.settings.employees || '').split(/\r?\n/)) {
    const match = /^\s*(\d{1,10})\s*[=:;,\s]\s*(\S+@\S+)\s*$/.exec(line);
    if (!match) continue;
    const user = await ctx.db.prepare('SELECT id,name FROM users WHERE lower(email)=lower(?) AND disabled_at IS NULL').get(match[2]);
    if (user) map.set(match[1], user);
  }
  return map;
}

// A phone field can hold several numbers («+7 900 111-22-33, 8 912 000-11-22», «Тел. … Сот. …»,
// moved from amoCRM). Anything but digits and the characters of a written number (space, brackets,
// plus, dash, dot) separates numbers; then the last 10 digits are looked for inside each one, so an
// extension after the number («… доб. 12») does not get in the way either.
const phoneDigits = column => `regexp_replace(regexp_replace(${column},'[^0-9 ()+.-]+',',','g'),'[^0-9,]','','g')`;
const phoneLike = number => `%${phoneKey(number)}%`;

const canSeeAll = user => user.role === 'admin' || user.deal_access !== 'own';

export async function activate(ctx) {
  const {db} = ctx;
  await db.exec(`CREATE TABLE IF NOT EXISTS plugin_mango_calls (
    entry_id TEXT PRIMARY KEY, direction TEXT NOT NULL, number TEXT NOT NULL DEFAULT '', extension TEXT NOT NULL DEFAULT '',
    line_number TEXT NOT NULL DEFAULT '', user_id BIGINT, answered INTEGER NOT NULL DEFAULT 0, duration INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL, deal_id BIGINT, contact_id BIGINT, company_id BIGINT, lead_id BIGINT, recording_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT now_text());
  CREATE INDEX IF NOT EXISTS idx_plugin_mango_calls_deal ON plugin_mango_calls(deal_id, started_at);
  CREATE INDEX IF NOT EXISTS idx_plugin_mango_calls_started ON plugin_mango_calls(started_at);`);

  // Who is calling: a contact or company with this phone, and their open deal.
  async function findClient(number) {
    const key = phoneKey(number);
    if (key.length < 7) return {};
    const like = phoneLike(number);
    const contact = await db.prepare(`SELECT id,company_id FROM contacts WHERE deleted_at IS NULL AND ${phoneDigits('phone')} LIKE ? ORDER BY updated_at DESC LIMIT 1`).get(like);
    const company = contact?.company_id ? {id: contact.company_id} : await db.prepare(`SELECT id FROM companies WHERE deleted_at IS NULL AND ${phoneDigits('phone')} LIKE ? ORDER BY updated_at DESC LIMIT 1`).get(like);
    const open = "SELECT d.id FROM deals d JOIN stages s ON s.id=d.stage_id WHERE d.deleted_at IS NULL AND s.kind='active' AND ";
    let deal = contact && await db.prepare(`${open}(d.contact_id=? OR d.id IN (SELECT deal_id FROM deal_contacts WHERE contact_id=?)) ORDER BY d.updated_at DESC LIMIT 1`).get(contact.id, contact.id);
    if (!deal && company) deal = await db.prepare(`${open}d.company_id=? ORDER BY d.updated_at DESC LIMIT 1`).get(company.id);
    return {contact, company, deal};
  }

  async function summary(event) {
    const direction = Number(event.call_direction);
    if (direction !== 1 && direction !== 2) return;                      // 0 = internal call
    const entry = String(event.entry_id || '');
    if (!entry) return;
    const incoming = direction === 1;
    const number = digits(incoming ? event.from?.number : event.to?.number);
    const extension = String((incoming ? event.to?.extension : event.from?.extension) ?? '');
    const answered = Number(event.entry_result) === 1;
    const talk = Number(event.talk_time) || 0, end = Number(event.end_time) || 0;
    const seconds = answered && talk && end > talk ? end - talk : 0;
    const started = moment(event.create_time);
    const employee = (await employeeMap(ctx)).get(extension);
    // Claim the call first: of two deliveries of the same event only one gets the row and writes the feed.
    const claimed = await db.prepare(`INSERT INTO plugin_mango_calls (entry_id,direction,number,extension,line_number,user_id,answered,duration,started_at)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT (entry_id) DO NOTHING`).run(
      entry, incoming ? 'incoming' : 'outgoing', number, extension, digits(event.line_number), employee?.id ?? null, answered ? 1 : 0, seconds, sqlTime(started));
    if (!claimed.changes) return;
    try { await record(); }
    catch (error) {
      // Let Mango's retry process the call again.
      await db.prepare('DELETE FROM plugin_mango_calls WHERE entry_id=?').run(entry);
      throw error;
    }

    async function record() {
      const client = await findClient(number);

      const subject = incoming ? (answered ? 'Входящий звонок' : 'Пропущенный входящий звонок') : (answered ? 'Исходящий звонок' : 'Исходящий звонок — не дозвонились');
      const parts = [`${incoming ? 'от' : 'на'} ${prettyPhone(number)}`];
      if (seconds) parts.push(`разговор ${callLength(seconds)}`);
      if (employee) parts.push(`${incoming ? 'ответил' : 'звонил'} ${employee.name}`);
      else if (extension) parts.push(`внутр. ${extension}`);
      if (event.line_number) parts.push(`линия ${prettyPhone(event.line_number)}`);
      const body = parts.join(', ');

      let leadId = null;
      if (client.deal) {
        // The feed already titles it «Входящий/Исходящий звонок»; the subject adds the outcome or the length.
        const outcome = seconds ? callLength(seconds) : answered ? '' : incoming ? 'пропущен' : 'не дозвонились';
        await ctx.crm.addCommunication(client.deal.id, {kind: 'call', direction: incoming ? 'incoming' : 'outgoing', subject: outcome, body, user_id: employee?.id, created_at: started});
      } else if (client.contact) {
        await ctx.crm.addEntityEvent('contact', client.contact.id, `${subject} ${body}`);
      } else if (client.company) {
        await ctx.crm.addEntityEvent('company', client.company.id, `${subject} ${body}`);
      } else if (incoming && ctx.settings.create_leads !== false && number) {
        // One request per unknown number: a repeat call goes to the request that is still waiting.
        const waiting = await db.prepare(`SELECT id FROM inbox_leads WHERE status='pending' AND ${phoneDigits('phone')} LIKE ? ORDER BY id DESC LIMIT 1`).get(phoneLike(number));
        leadId = waiting?.id || (await ctx.crm.createLead({
          pipeline_id: ctx.settings.pipeline_id || undefined,
          title: `Звонок ${prettyPhone(number)}`,
          phone: prettyPhone(number),
          source: 'Mango Office',
          message: `${subject} ${body}. Запись разговора — в разделе «Звонки».`,
        })).id;
      }
      const pending = await ctx.storage.get(`record:${entry}`);
      // A recording that arrived while the call was processed is already in the row; keep it.
      await db.prepare("UPDATE plugin_mango_calls SET deal_id=?,contact_id=?,company_id=?,lead_id=?,recording_id=CASE WHEN ?<>'' THEN ? ELSE recording_id END WHERE entry_id=?").run(
        client.deal?.id ?? null, client.contact?.id ?? null, client.company?.id ?? null, leadId, pending || '', pending || '', entry);
      if (pending) await ctx.storage.delete(`record:${entry}`);
      ctx.log.info(`${subject} ${body}${client.deal ? ` → сделка #${client.deal.id}` : leadId ? ` → заявка #${leadId}` : ''}`);
    }
  }

  async function recordAdded(event) {
    const entry = String(event.entry_id || ''), recording = String(event.recording_id || '');
    if (!entry || !recording) return;
    const updated = await db.prepare('UPDATE plugin_mango_calls SET recording_id=? WHERE entry_id=?').run(recording, entry);
    // The recording can arrive before the call summary.
    if (!updated.changes) await ctx.storage.set(`record:${entry}`, recording);
  }

  // Mango appends /events/<name> to the address; a trailing slash in the address is tolerated.
  ctx.publicRouter.use('/mango', async (req, res) => {
    const name = req.path.replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
    if (!name || name === 'ping') return res.json({success: true});
    const {vpbx_api_key: key, sign, json} = req.body || {};
    if (typeof json !== 'string' || key !== ctx.settings.api_key || !ctx.settings.api_salt || !sameHex(sign, sha256(`${key}${json}${ctx.settings.api_salt}`))) {
      ctx.log.warn(`Отклонено событие ${name}: неверный код АТС или подпись`);
      return res.status(403).json({error: 'Неверная подпись'});
    }
    let event;
    try { event = JSON.parse(json); } catch { return res.status(400).json({error: 'json — не JSON'}); }
    if (name === 'events/summary') await summary(event);
    else if (name === 'events/record/added' || (name === 'events/recording' && event.recording_state === 'Completed')) await recordAdded(event);
    res.json({success: true});
  });

  // ---------- for the browser ----------
  const select = `SELECT c.*,u.name user_name,d.name deal_name,ct.name contact_name,co.name company_name FROM plugin_mango_calls c
    LEFT JOIN users u ON u.id=c.user_id LEFT JOIN deals d ON d.id=c.deal_id LEFT JOIN contacts ct ON ct.id=c.contact_id LEFT JOIN companies co ON co.id=c.company_id`;
  const view = row => ({entry_id: row.entry_id, direction: row.direction, number: prettyPhone(row.number), answered: !!row.answered, duration: row.duration ? callLength(row.duration) : '',
    started_at: row.started_at, user_name: row.user_name || (row.extension ? `внутр. ${row.extension}` : ''), deal_id: row.deal_id, deal_name: row.deal_name, contact_name: row.contact_name, company_name: row.company_name,
    lead_id: row.lead_id, has_recording: !!row.recording_id});
  const allowed = async (user, row) => canSeeAll(user) || row.user_id === user.id || (row.deal_id && (await db.prepare('SELECT owner_id FROM deals WHERE id=?').get(row.deal_id))?.owner_id === user.id);

  ctx.router.get('/deal/:id', async (req, res) => {
    const deal = await db.prepare('SELECT id,owner_id FROM deals WHERE id=? AND deleted_at IS NULL').get(Number(req.params.id) || 0);
    if (!deal || (!canSeeAll(req.user) && deal.owner_id !== req.user.id)) return res.status(404).json({error: 'Сделка не найдена'});
    res.json((await db.prepare(`${select} WHERE c.deal_id=? ORDER BY c.started_at DESC LIMIT 100`).all(deal.id)).map(view));
  });

  ctx.router.get('/calls', async (req, res) => {
    const missed = req.query.filter === 'missed';
    const own = !canSeeAll(req.user);
    const rows = await db.prepare(`${select} WHERE (?=0 OR (c.direction='incoming' AND c.answered=0)) AND (?=0 OR c.user_id=? OR d.owner_id=?) ORDER BY c.started_at DESC LIMIT 200`)
      .all(missed ? 1 : 0, own ? 1 : 0, req.user.id, req.user.id);
    res.json(rows.map(view));
  });

  ctx.router.get('/recording/:entry', async (req, res) => {
    const row = await db.prepare('SELECT * FROM plugin_mango_calls WHERE entry_id=?').get(String(req.params.entry));
    if (!row || !row.recording_id || !await allowed(req.user, row)) return res.status(404).json({error: 'Записи нет'});
    const json = JSON.stringify({recording_id: row.recording_id, action: 'play'});
    const base = String(ctx.settings.api_url || 'https://app.mango-office.ru/vpbx').replace(/\/+$/, '');
    let response;
    try {
      response = await fetch(`${base}/queries/recording/post`, {method: 'POST', redirect: 'follow', signal: AbortSignal.timeout(30000),
        headers: {'Content-Type': 'application/x-www-form-urlencoded'},
        body: new URLSearchParams({vpbx_api_key: ctx.settings.api_key, sign: sha256(`${ctx.settings.api_key}${json}${ctx.settings.api_salt}`), json})});
    } catch (error) { ctx.log.error(`Запись ${row.entry_id}: ${error.message}`); return res.status(502).json({error: 'Mango Office не ответил'}); }
    if (!response.ok || !response.body) {
      ctx.log.warn(`Запись ${row.entry_id}: Mango Office ответил ${response.status}`);
      return res.status(502).json({error: 'Mango Office не отдал запись — возможно, она ещё не сохранилась'});
    }
    res.set('Content-Type', /^audio\//.test(response.headers.get('content-type') || '') ? response.headers.get('content-type') : 'audio/mpeg');
    res.set('Cache-Control', 'private, max-age=3600');
    if (response.headers.get('content-length')) res.set('Content-Length', response.headers.get('content-length'));
    Readable.fromWeb(response.body).pipe(res);
  });
}
