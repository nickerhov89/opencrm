import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import http from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('API keys, idempotent leads and signed webhook retries work end to end', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opencrm-integrations-'));
  process.env.DATABASE_PATH = join(directory, 'crm.db');
  process.env.UPLOAD_DIR = join(directory, 'uploads');
  process.env.NODE_ENV = 'test';
  process.env.OPENCRM_ALLOW_LOCAL_WEBHOOKS = '1';
  const {app, db} = await import('../server/index.js');
  const {processWebhookQueue} = await import('../server/integrations.js');
  const received = [];
  let failNext = true;
  const receiver = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    received.push({headers: req.headers, body, data: JSON.parse(body)});
    res.writeHead(failNext ? 503 : 204).end();
    failNext = false;
  });
  const server = app.listen(0, '127.0.0.1');
  receiver.listen(0, '127.0.0.1');
  await Promise.all([new Promise(resolve => server.once('listening', resolve)), new Promise(resolve => receiver.once('listening', resolve))]);
  const base = `http://127.0.0.1:${server.address().port}/api`;
  let cookie = '';
  async function request(path, method = 'GET', body, status = 200, headers = {}) {
    const response = await fetch(base + path, {method, headers: {'Content-Type': 'application/json', ...(cookie ? {Cookie: cookie} : {}), ...headers}, body: body == null ? undefined : JSON.stringify(body)});
    assert.equal(response.status, status, `${method} ${path}: ${await response.clone().text()}`);
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return response.json();
  }
  try {
    await request('/setup', 'POST', {name: 'Admin', email: 'admin@example.test', password: 'test-password-123'});
    const pipeline = (await request('/pipelines'))[0];
    const stages = await request(`/stages?pipeline_id=${pipeline.id}`);
    const endpoint = await request('/integrations/webhooks', 'POST', {name: 'Local receiver', url: `http://127.0.0.1:${receiver.address().port}/hook`, events: ['lead.created', 'deal.created', 'deal.stage_changed']}, 201);
    assert.match(endpoint.secret, /^[a-f0-9]{64}$/);
    assert.equal('secret' in (await request('/integrations/webhooks'))[0], false);
    await request('/integrations/webhooks', 'POST', {name: 'Bad', url: 'ftp://example.com', events: ['lead.created']}, 400);
    process.env.OPENCRM_ALLOW_LOCAL_WEBHOOKS = '0';
    await request('/integrations/webhooks', 'POST', {name: 'Local blocked', url: endpoint.url, events: ['lead.created']}, 400);
    process.env.OPENCRM_WEBHOOK_ALLOWED_HOSTS = '127.0.0.1';
    await request(`/integrations/webhooks/${endpoint.id}`, 'PATCH', {active: true});
    delete process.env.OPENCRM_WEBHOOK_ALLOWED_HOSTS;
    process.env.OPENCRM_ALLOW_LOCAL_WEBHOOKS = '1';

    const leadKey = await request('/integrations/keys', 'POST', {name: 'Website', scopes: ['leads:write']}, 201);
    assert.match(leadKey.token, /^ocrm_/);
    assert.equal('token' in (await request('/integrations/keys'))[0], false);
    const lead = {pipeline_id: pipeline.id, title: 'Inbound test', contact_name: 'Synthetic Contact', email: 'synthetic@example.test'};
    await request('/v1/leads', 'POST', lead, 401);
    const leadHeaders = {Authorization: `Bearer ${leadKey.token}`, 'Idempotency-Key': 'external-42'};
    const created = await request('/v1/leads', 'POST', lead, 201, leadHeaders);
    assert.equal(created.status, 'pending');
    assert.equal((await request('/v1/leads', 'POST', lead, 200, leadHeaders)).id, created.id);
    await request('/v1/leads', 'POST', {...lead, title: 'Other'}, 409, leadHeaders);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM inbox_leads').get().n, 1);
    await request('/v1/pipelines', 'GET', null, 403, {Authorization: `Bearer ${leadKey.token}`});

    assert.equal(await processWebhookQueue(db), 1);
    let delivery = (await request(`/integrations/webhooks/${endpoint.id}/deliveries`))[0];
    assert.equal(delivery.status, 'pending');
    assert.equal(delivery.response_status, 503);
    db.prepare('UPDATE webhook_deliveries SET next_attempt_at=0 WHERE id=?').run(delivery.id);
    assert.equal(await processWebhookQueue(db), 1);
    delivery = (await request(`/integrations/webhooks/${endpoint.id}/deliveries`))[0];
    assert.equal(delivery.status, 'delivered');
    assert.equal(delivery.attempts, 2);
    assert.equal(received[1].data.type, 'lead.created');
    assert.equal(received[1].data.data.id, created.id);
    for (const item of received) {
      const expected = createHmac('sha256', endpoint.secret).update(`${item.headers['x-opencrm-timestamp']}.${item.body}`).digest('hex');
      assert.equal(item.headers['x-opencrm-signature'], `sha256=${expected}`);
    }
    const rotated = await request(`/integrations/webhooks/${endpoint.id}/rotate-secret`, 'POST');
    assert.notEqual(rotated.secret, endpoint.secret);

    const dealKey = await request('/integrations/keys', 'POST', {name: 'Automation', scopes: ['deals:read', 'deals:write']}, 201);
    const dealHeaders = {Authorization: `Bearer ${dealKey.token}`};
    assert.equal((await request('/v1/pipelines', 'GET', null, 200, dealHeaders)).items[0].id, pipeline.id);
    const deal = await request('/deals', 'POST', {name: 'Synthetic deal', stage_id: stages[0].id, amount: 1000}, 201);
    assert.equal((await request('/v1/deals?limit=1', 'GET', null, 200, dealHeaders)).items[0].id, deal.id);
    assert.equal((await request(`/v1/deals/${deal.id}`, 'GET', null, 200, dealHeaders)).stage_id, stages[0].id);
    await request(`/v1/deals/${deal.id}/stage`, 'PATCH', {stage_id: stages[1].id}, 401);
    await request(`/v1/deals/${deal.id}/stage`, 'PATCH', {stage_id: stages[1].id}, 200, dealHeaders);
    assert.equal((await request(`/v1/deals/${deal.id}`, 'GET', null, 200, dealHeaders)).stage_id, stages[1].id);
    assert.equal(await processWebhookQueue(db), 2);
    const events = (await request(`/integrations/webhooks/${endpoint.id}/deliveries`)).map(item => item.event_type);
    assert.ok(events.includes('deal.created'));
    assert.ok(events.includes('deal.stage_changed'));
    for (const item of received.slice(2)) {
      const expected = createHmac('sha256', rotated.secret).update(`${item.headers['x-opencrm-timestamp']}.${item.body}`).digest('hex');
      assert.equal(item.headers['x-opencrm-signature'], `sha256=${expected}`);
    }
    const ping = await request(`/integrations/webhooks/${endpoint.id}/test`, 'POST', null, 202);
    assert.equal(await processWebhookQueue(db), 1);
    assert.equal(received.at(-1).data.type, 'test.ping');
    db.prepare("UPDATE webhook_deliveries SET status='failed' WHERE id=?").run(ping.delivery_id);
    await request(`/integrations/webhooks/${endpoint.id}/deliveries/${ping.delivery_id}/retry`, 'POST');
    assert.equal(await processWebhookQueue(db), 1);
    assert.equal(db.prepare('SELECT status FROM webhook_deliveries WHERE id=?').get(ping.delivery_id).status, 'delivered');

    await request(`/integrations/keys/${leadKey.id}`, 'DELETE');
    await request('/v1/leads', 'POST', lead, 401, leadHeaders);
    const member = await request('/users', 'POST', {name: 'Member', email: 'member@example.test', password: 'member-password-123', role: 'member'}, 201);
    assert.ok(member.id);
    await request('/login', 'POST', {email: 'member@example.test', password: 'member-password-123'});
    await request('/integrations/keys', 'GET', null, 403);
    await request('/integrations/webhooks', 'GET', null, 403);
  } finally {
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => receiver.close(resolve))]);
    db.close();
    rmSync(directory, {recursive: true, force: true});
    delete process.env.OPENCRM_ALLOW_LOCAL_WEBHOOKS;
  }
});
