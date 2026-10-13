import {createHash, createHmac, randomBytes} from 'node:crypto';
import {lookup} from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import {isIP} from 'node:net';

const scopes = ['leads:write', 'deals:read', 'deals:write'];
const eventTypes = ['lead.created', 'deal.created', 'deal.stage_changed'];
const sha256 = value => createHash('sha256').update(value).digest('hex');
const positiveId = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const clean = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const fail = (res, status, message) => res.status(status).json({error: message});
const privateHostAllowed = hostname => process.env.OPENCRM_ALLOW_LOCAL_WEBHOOKS === '1' || (process.env.OPENCRM_WEBHOOK_ALLOWED_HOSTS || '').split(',').some(host => host.trim().toLowerCase() === hostname.toLowerCase());

function validWebhookUrl(raw) {
  try {
    const url = new URL(raw);
    const local = privateHostAllowed(url.hostname);
    if (!['https:', ...(local ? ['http:'] : [])].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash || url.hostname.includes(':')) return false;
    if (!local && /(^|\.)localhost$/i.test(url.hostname)) return false;
    if (!local && isIP(url.hostname) === 4 && !publicIPv4(url.hostname)) return false;
    return raw.length <= 2048;
  } catch { return false; }
}

function publicIPv4(address) {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 0 || b === 168 || b === 88 && c === 99)) return false;
  if (a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

async function sendDelivery(endpoint, delivery, event) {
  if (!validWebhookUrl(endpoint.url)) throw new Error('Недопустимый адрес webhook');
  const url = new URL(endpoint.url);
  const addresses = await lookup(url.hostname, {all: true, family: 4});
  if (!addresses.length || (!privateHostAllowed(url.hostname) && addresses.some(item => !publicIPv4(item.address)))) throw new Error('Webhook должен вести на публичный IPv4-адрес или разрешённый хост');
  const address = addresses[0].address;
  const body = JSON.stringify({id: event.id, type: event.event_type, created_at: event.created_at, data: JSON.parse(event.payload_json)});
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', endpoint.secret).update(`${timestamp}.${body}`).digest('hex');
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request(url, {
      method: 'POST',
      lookup: (_host, _options, callback) => callback(null, address, 4),
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-OpenCRM-Event': event.event_type,
        'X-OpenCRM-Delivery': String(delivery.id),
        'X-OpenCRM-Timestamp': timestamp,
        'X-OpenCRM-Signature': `sha256=${signature}`
      }
    }, response => { clearTimeout(timer); resolve(response.statusCode || 0); response.destroy(); });
    const timer = setTimeout(() => request.destroy(new Error('Webhook: превышено время ожидания')), 5000);
    request.on('error', error => { clearTimeout(timer); reject(error); });
    request.end(body);
  });
}

const busy = new WeakSet();
export async function processWebhookQueue(db, limit = 10) {
  if (busy.has(db)) return 0;
  busy.add(db);
  let processed = 0;
  try {
    const now = Date.now();
    const pending = db.prepare(`SELECT d.id,d.endpoint_id,d.event_id,d.attempts,w.url,w.secret,e.event_type,e.payload_json,e.created_at
      FROM webhook_deliveries d JOIN webhook_endpoints w ON w.id=d.endpoint_id JOIN webhook_events e ON e.id=d.event_id
      WHERE d.status='pending' AND w.active=1 AND d.next_attempt_at<=? AND (d.locked_until IS NULL OR d.locked_until<?)
      ORDER BY d.id LIMIT ?`).all(now, now, Math.min(Math.max(Number(limit) || 1, 1), 100));
    for (const item of pending) {
      const claimed = db.prepare("UPDATE webhook_deliveries SET locked_until=?,attempts=attempts+1 WHERE id=? AND status='pending' AND (locked_until IS NULL OR locked_until<?)").run(Date.now() + 30000, item.id, Date.now());
      if (!claimed.changes) continue;
      processed++;
      let status = null, error = '';
      try { status = await sendDelivery(item, item, item); if (status < 200 || status >= 300) error = `HTTP ${status}`; }
      catch (failure) { error = String(failure.message || failure).slice(0, 300); }
      if (!error) db.prepare("UPDATE webhook_deliveries SET status='delivered',response_status=?,last_error='',locked_until=NULL,delivered_at=CURRENT_TIMESTAMP WHERE id=?").run(status, item.id);
      else {
        const attempts = item.attempts + 1;
        const final = attempts >= 5;
        const delay = [0, 5000, 30000, 120000, 600000][Math.min(attempts, 4)];
        db.prepare('UPDATE webhook_deliveries SET status=?,response_status=?,last_error=?,next_attempt_at=?,locked_until=NULL WHERE id=?').run(final ? 'failed' : 'pending', status, error, Date.now() + delay, item.id);
      }
    }
    db.prepare("DELETE FROM webhook_events WHERE created_at<datetime('now','-30 days') AND NOT EXISTS (SELECT 1 FROM webhook_deliveries d WHERE d.event_id=webhook_events.id AND d.status='pending')").run();
    db.prepare("DELETE FROM api_idempotency WHERE created_at<datetime('now','-30 days')").run();
  } finally { busy.delete(db); }
  return processed;
}

export function registerIntegrations(app, db, {auth, admin, event, runStageAutomation}) {
  function apiKey(requiredScope) {
    return (req, res, next) => {
      const match = /^Bearer (ocrm_[A-Za-z0-9_-]{43})$/.exec(req.get('authorization') || '');
      const key = match && db.prepare('SELECT id,name,scopes_json FROM api_keys WHERE token_hash=? AND revoked_at IS NULL').get(sha256(match[1]));
      if (!key) return fail(res, 401, 'Нужен действующий ключ API');
      if (!JSON.parse(key.scopes_json).includes(requiredScope)) return fail(res, 403, 'У ключа нет нужного права');
      db.prepare('UPDATE api_keys SET last_used_at=CURRENT_TIMESTAMP WHERE id=?').run(key.id);
      req.apiKey = key;
      next();
    };
  }

  app.get('/api/integrations/keys', auth, admin, (_req, res) => {
    res.json(db.prepare('SELECT id,name,prefix,scopes_json,created_at,last_used_at,revoked_at FROM api_keys ORDER BY id DESC').all().map(({scopes_json, ...row}) => ({...row, scopes: JSON.parse(scopes_json)})));
  });
  app.post('/api/integrations/keys', auth, admin, (req, res) => {
    const name = clean(req.body.name, 120), selected = req.body.scopes;
    if (!name || !Array.isArray(selected) || !selected.length || new Set(selected).size !== selected.length || selected.some(scope => !scopes.includes(scope))) return fail(res, 400, 'Проверьте название и права ключа');
    if (db.prepare('SELECT COUNT(*) n FROM api_keys WHERE revoked_at IS NULL').get().n >= 50) return fail(res, 400, 'Не больше 50 активных ключей');
    const token = `ocrm_${randomBytes(32).toString('base64url')}`;
    const row = db.prepare('INSERT INTO api_keys (name,token_hash,prefix,scopes_json) VALUES (?,?,?,?)').run(name, sha256(token), token.slice(0, 13), JSON.stringify(selected));
    res.status(201).json({id: row.lastInsertRowid, name, prefix: token.slice(0, 13), scopes: selected, token});
  });
  app.delete('/api/integrations/keys/:id', auth, admin, (req, res) => {
    const result = db.prepare('UPDATE api_keys SET revoked_at=CURRENT_TIMESTAMP WHERE id=? AND revoked_at IS NULL').run(positiveId(req.params.id));
    if (!result.changes) return fail(res, 404, 'Ключ не найден');
    res.json({ok: true});
  });

  app.get('/api/v1/pipelines', apiKey('deals:read'), (_req, res) => {
    const rows = db.prepare('SELECT id,name,sort_order FROM pipelines ORDER BY sort_order,id').all();
    const stages = db.prepare('SELECT id,pipeline_id,name,kind,sort_order FROM stages ORDER BY pipeline_id,sort_order,id').all();
    res.json({items: rows.map(row => ({...row, stages: stages.filter(stage => stage.pipeline_id === row.id)}))});
  });
  const dealQuery = `SELECT d.id,d.name,d.stage_id,s.pipeline_id,s.kind stage_kind,d.owner_id,d.contact_id,d.company_id,d.amount,d.source,d.tags,d.description,d.loss_reason,d.created_at,d.updated_at
    FROM deals d JOIN stages s ON s.id=d.stage_id WHERE d.deleted_at IS NULL`;
  app.get('/api/v1/deals', apiKey('deals:read'), (req, res) => {
    const after = req.query.after == null ? 0 : Number(req.query.after), limit = req.query.limit == null ? 50 : Number(req.query.limit);
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) return fail(res, 400, 'Проверьте пагинацию');
    const rows = db.prepare(`${dealQuery} AND d.id>? ORDER BY d.id LIMIT ?`).all(after, limit + 1);
    res.json({items: rows.slice(0, limit), next_after: rows.length > limit ? rows[limit - 1].id : null});
  });
  app.get('/api/v1/deals/:id', apiKey('deals:read'), (req, res) => {
    const deal = db.prepare(`${dealQuery} AND d.id=?`).get(positiveId(req.params.id));
    if (!deal) return fail(res, 404, 'Сделка не найдена');
    res.json(deal);
  });
  app.patch('/api/v1/deals/:id/stage', apiKey('deals:write'), (req, res) => {
    const id = positiveId(req.params.id), stageId = positiveId(req.body.stage_id), deal = db.prepare('SELECT d.id,d.stage_id,d.owner_id,s.pipeline_id FROM deals d JOIN stages s ON s.id=d.stage_id WHERE d.id=? AND d.deleted_at IS NULL').get(id);
    if (!deal) return fail(res, 404, 'Сделка не найдена');
    const stage = db.prepare('SELECT id,pipeline_id,kind,name FROM stages WHERE id=?').get(stageId);
    if (!stage || stage.pipeline_id !== deal.pipeline_id) return fail(res, 400, 'Выберите этап этой воронки');
    if (stage.id === deal.stage_id) return res.json({id, stage_id: stage.id, unchanged: true});
    const reason = clean(req.body.loss_reason, 120);
    if (stage.kind === 'lost' && !reason) return fail(res, 400, 'Укажите причину отказа');
    db.transaction(() => {
      db.prepare('UPDATE deals SET stage_id=?,loss_reason=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(stage.id, stage.kind === 'lost' ? reason : '', id);
      event(id, null, `Этап изменён через API: ${stage.name}`);
      runStageAutomation(id, stage.id, deal.owner_id, null);
    })();
    res.json({id, stage_id: stage.id});
  });
  app.post('/api/v1/leads', apiKey('leads:write'), (req, res) => {
    const raw = req.body || {}, pipeline = positiveId(raw.pipeline_id), title = clean(raw.title, 255), contact = clean(raw.contact_name, 255), company = clean(raw.company_name, 255), phone = clean(raw.phone, 80), email = clean(raw.email, 254).toLowerCase();
    if (!db.prepare('SELECT id FROM pipelines WHERE id=?').get(pipeline) || !title || (!contact && !company && !phone && !email) || email && !email.includes('@')) return fail(res, 400, 'Проверьте данные заявки');
    const normalized = {pipeline_id: pipeline, title, contact_name: contact, company_name: company, phone, email, website: clean(raw.website, 255), source: clean(raw.source, 255) || `API: ${req.apiKey.name}`, message: clean(raw.message, 10000)};
    const idempotencyKey = req.get('idempotency-key');
    if (idempotencyKey && !/^[A-Za-z0-9._~-]{1,128}$/.test(idempotencyKey)) return fail(res, 400, 'Неверный Idempotency-Key');
    const requestHash = sha256(JSON.stringify(normalized));
    const result = db.transaction(() => {
      if (idempotencyKey) {
        const existing = db.prepare('SELECT lead_id,request_hash FROM api_idempotency WHERE api_key_id=? AND idempotency_key=?').get(req.apiKey.id, idempotencyKey);
        if (existing) return {id: existing.lead_id, repeated: true, conflict: existing.request_hash !== requestHash};
      }
      const created = db.prepare('INSERT INTO inbox_leads (pipeline_id,title,contact_name,company_name,phone,email,website,source,message) VALUES (?,?,?,?,?,?,?,?,?)').run(...Object.values(normalized));
      if (idempotencyKey) db.prepare('INSERT INTO api_idempotency (api_key_id,idempotency_key,request_hash,lead_id) VALUES (?,?,?,?)').run(req.apiKey.id, idempotencyKey, requestHash, created.lastInsertRowid);
      return {id: created.lastInsertRowid, repeated: false, conflict: false};
    })();
    if (result.conflict) return fail(res, 409, 'Idempotency-Key уже использован с другими данными');
    res.status(result.repeated ? 200 : 201).json({id: result.id, status: 'pending', repeated: result.repeated});
  });

  app.get('/api/integrations/webhooks', auth, admin, (_req, res) => {
    res.json(db.prepare('SELECT id,name,url,events_json,active,created_at FROM webhook_endpoints ORDER BY id DESC').all().map(({events_json, ...row}) => ({...row, events: JSON.parse(events_json)})));
  });
  app.post('/api/integrations/webhooks', auth, admin, (req, res) => {
    const name = clean(req.body.name, 120), url = clean(req.body.url, 2048), selected = req.body.events;
    if (!name || !validWebhookUrl(url) || !Array.isArray(selected) || !selected.length || new Set(selected).size !== selected.length || selected.some(type => !eventTypes.includes(type))) return fail(res, 400, 'Проверьте адрес и события webhook');
    if (db.prepare('SELECT COUNT(*) n FROM webhook_endpoints').get().n >= 20) return fail(res, 400, 'Не больше 20 webhook-адресов');
    const secret = randomBytes(32).toString('hex');
    const row = db.prepare('INSERT INTO webhook_endpoints (name,url,secret,events_json) VALUES (?,?,?,?)').run(name, url, secret, JSON.stringify(selected));
    res.status(201).json({id: row.lastInsertRowid, name, url, events: selected, active: 1, secret});
  });
  app.patch('/api/integrations/webhooks/:id', auth, admin, (req, res) => {
    const id = positiveId(req.params.id), old = db.prepare('SELECT * FROM webhook_endpoints WHERE id=?').get(id);
    if (!old) return fail(res, 404, 'Webhook не найден');
    const name = req.body.name === undefined ? old.name : clean(req.body.name, 120), url = req.body.url === undefined ? old.url : clean(req.body.url, 2048), selected = req.body.events === undefined ? JSON.parse(old.events_json) : req.body.events, active = req.body.active === undefined ? !!old.active : req.body.active;
    if (!name || !validWebhookUrl(url) || !Array.isArray(selected) || !selected.length || new Set(selected).size !== selected.length || selected.some(type => !eventTypes.includes(type)) || typeof active !== 'boolean') return fail(res, 400, 'Проверьте настройки webhook');
    db.prepare('UPDATE webhook_endpoints SET name=?,url=?,events_json=?,active=? WHERE id=?').run(name, url, JSON.stringify(selected), active ? 1 : 0, id);
    res.json({id, name, url, events: selected, active: active ? 1 : 0});
  });
  app.delete('/api/integrations/webhooks/:id', auth, admin, (req, res) => {
    const result = db.prepare('DELETE FROM webhook_endpoints WHERE id=?').run(positiveId(req.params.id));
    if (!result.changes) return fail(res, 404, 'Webhook не найден');
    res.json({ok: true});
  });
  app.post('/api/integrations/webhooks/:id/rotate-secret', auth, admin, (req, res) => {
    const id = positiveId(req.params.id), secret = randomBytes(32).toString('hex');
    const result = db.prepare('UPDATE webhook_endpoints SET secret=? WHERE id=?').run(secret, id);
    if (!result.changes) return fail(res, 404, 'Webhook не найден');
    res.json({id, secret});
  });
  app.post('/api/integrations/webhooks/:id/test', auth, admin, (req, res) => {
    const id = positiveId(req.params.id), endpoint = db.prepare('SELECT id FROM webhook_endpoints WHERE id=? AND active=1').get(id);
    if (!endpoint) return fail(res, 404, 'Webhook не найден');
    const deliveryId = db.transaction(() => {
      const event = db.prepare('INSERT INTO webhook_events (event_type,payload_json) VALUES (?,?)').run('test.ping', JSON.stringify({message: 'OpenCRM webhook test'}));
      return db.prepare('INSERT INTO webhook_deliveries (endpoint_id,event_id) VALUES (?,?)').run(id, event.lastInsertRowid).lastInsertRowid;
    })();
    if (process.env.NODE_ENV !== 'test' || process.env.OPENCRM_WEBHOOK_WORKER === '1') void processWebhookQueue(db).catch(error => console.error('Webhook delivery:', error));
    res.status(202).json({delivery_id: deliveryId});
  });
  app.get('/api/integrations/webhooks/:id/deliveries', auth, admin, (req, res) => {
    const id = positiveId(req.params.id);
    if (!db.prepare('SELECT id FROM webhook_endpoints WHERE id=?').get(id)) return fail(res, 404, 'Webhook не найден');
    res.json(db.prepare('SELECT d.id,d.status,d.attempts,d.response_status,d.last_error,d.delivered_at,e.event_type,e.created_at FROM webhook_deliveries d JOIN webhook_events e ON e.id=d.event_id WHERE d.endpoint_id=? ORDER BY d.id DESC LIMIT 50').all(id));
  });
  app.post('/api/integrations/webhooks/:id/deliveries/:deliveryId/retry', auth, admin, (req, res) => {
    const result = db.prepare("UPDATE webhook_deliveries SET status='pending',attempts=0,next_attempt_at=0,locked_until=NULL,last_error='' WHERE id=? AND endpoint_id=? AND status='failed'").run(positiveId(req.params.deliveryId), positiveId(req.params.id));
    if (!result.changes) return fail(res, 404, 'Неуспешная доставка не найдена');
    res.json({ok: true});
  });

  if (process.env.NODE_ENV !== 'test' || process.env.OPENCRM_WEBHOOK_WORKER === '1') {
    const run = () => processWebhookQueue(db).catch(error => console.error('Webhook delivery:', error));
    setTimeout(run, 1000).unref();
    setInterval(run, 5000).unref();
  }
}
