import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import http from 'node:http';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

test('production worker delivers a webhook without a manual queue call', {timeout: 20000}, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opencrm-worker-'));
  const receiver = http.createServer();
  const portProbe = http.createServer();
  receiver.listen(0, '127.0.0.1');
  portProbe.listen(0, '127.0.0.1');
  await Promise.all([new Promise(resolve => receiver.once('listening', resolve)), new Promise(resolve => portProbe.once('listening', resolve))]);
  const port = portProbe.address().port;
  await new Promise(resolve => portProbe.close(resolve));
  const project = resolve(import.meta.dirname, '..');
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: project,
    env: {...process.env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port), DATABASE_PATH: join(directory, 'crm.db'), UPLOAD_DIR: join(directory, 'uploads'), OPENCRM_WEBHOOK_ALLOWED_HOSTS: '127.0.0.1'},
    stdio: 'ignore'
  });
  const base = `http://127.0.0.1:${port}/api`;
  let cookie = '';
  const payloads = [];
  receiver.on('request', async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    payloads.push({body, headers: req.headers});
    res.writeHead(204).end();
  });
  async function request(path, method = 'GET', body) {
    const response = await fetch(base + path, {method, headers: {'Content-Type': 'application/json', ...(cookie ? {Cookie: cookie} : {})}, body: body ? JSON.stringify(body) : undefined});
    assert.ok(response.ok, `${method} ${path}: ${response.status}`);
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return response.json();
  }
  try {
    const deadline = Date.now() + 8000;
    while (true) {
      try { await request('/status'); break; }
      catch (error) { if (Date.now() > deadline || child.exitCode !== null) throw error; await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    await request('/setup', 'POST', {name: 'Admin', email: 'admin@example.test', password: 'test-password-123'});
    const pipeline = (await request('/pipelines'))[0];
    const endpoint = await request('/integrations/webhooks', 'POST', {name: 'Worker test', url: `http://127.0.0.1:${receiver.address().port}/hook`, events: ['lead.created']});
    await request('/inbox', 'POST', {pipeline_id: pipeline.id, title: 'Worker test lead', contact_name: 'Synthetic Person'});
    const deliveryDeadline = Date.now() + 9000;
    while (!payloads.length && Date.now() < deliveryDeadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(payloads.length, 1);
    const item = payloads[0];
    assert.equal(JSON.parse(item.body).type, 'lead.created');
    const expected = createHmac('sha256', endpoint.secret).update(`${item.headers['x-opencrm-timestamp']}.${item.body}`).digest('hex');
    assert.equal(item.headers['x-opencrm-signature'], `sha256=${expected}`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await new Promise(resolve => child.once('exit', resolve));
    }
    await new Promise(resolve => receiver.close(resolve));
    rmSync(directory, {recursive: true, force: true});
  }
});
