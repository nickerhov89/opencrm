import {test} from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

// Proxies that fail in different ways: none of them may take the process down, each gives an error.
async function proxy(onSocket) {
  const sockets = new Set();
  const server = net.createServer(socket => { sockets.add(socket); socket.on('error', () => {}); onSocket(socket); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {url: `http://127.0.0.1:${server.address().port}`, close: () => { for (const socket of sockets) socket.destroy(); return new Promise(resolve => server.close(resolve)); }};
}
const afterConnect = (socket, then) => socket.once('data', () => then(socket));

test('amoCRM client: a failing proxy gives an error, not a crash', async () => {
  const {httpsGet, amoClient} = await import('../scripts/amocrm-lib.mjs');
  const uncaught = [];
  const catcher = error => uncaught.push(error);
  process.on('uncaughtException', catcher);
  try {
    const cases = [
      ['resets the connection', socket => socket.resetAndDestroy()],
      ['closes after CONNECT 200, during TLS', socket => afterConnect(socket, s => { s.write('HTTP/1.1 200 Connection established\r\n\r\n'); setTimeout(() => s.resetAndDestroy(), 20); })],
      ['sends garbage', socket => afterConnect(socket, s => s.end('not http at all\r\n\r\n'))],
      ['never answers', () => {}]
    ];
    for (const [name, behave] of cases) {
      const server = await proxy(behave);
      try {
        const started = Date.now();
        await assert.rejects(httpsGet('https://agency.amocrm.ru/api/v4/account', {}, server.url, 2000, 'GET', null, 500), /proxy|прерван|закрыт|socket|ECONNRESET/i, name);
        assert.ok(Date.now() - started < 3000, `${name}: the proxy timeout is short`);
      } finally { await server.close(); }
    }

    // Refused: nothing listens there.
    const closed = await proxy(() => {});
    const port = new URL(closed.url).port;
    await closed.close();
    await assert.rejects(httpsGet('https://agency.amocrm.ru/', {}, `http://127.0.0.1:${port}`, 2000, 'GET', null, 500), /^Error: proxy: /);

    // Through the client: the request fails after its retries like any network error.
    const dead = await proxy(socket => socket.resetAndDestroy());
    try {
      const client = amoClient({baseUrl: 'https://agency.amocrm.ru', token: 't', proxyUrl: dead.url, minIntervalMs: 0, retries: 2, get: (url, headers, proxyUrl) => httpsGet(url, headers, proxyUrl, 2000, 'GET', null, 500)});
      await assert.rejects(client.request('/api/v4/account'), /\/api\/v4\/account: proxy/);
    } finally { await dead.close(); }
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(uncaught, []);
  } finally {
    process.off('uncaughtException', catcher);
  }
});
