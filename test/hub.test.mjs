import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { ExtensionOffline, Hub, callHub } from '../lib/hub.mjs';
import { MabangError } from '../lib/session.mjs';

const freePort = () => new Promise((resolve) => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});
const secret = 'x'.repeat(40);

/** 假扩展：长轮询取任务，按 handler 回结果 */
function fakeExtension(port, handler) {
  let stop = false;
  const headers = { 'x-ext-secret': secret };
  (async () => {
    while (!stop) {
      const res = await fetch(`http://127.0.0.1:${port}/ext/next`, { headers }).catch(() => null);
      if (!res || res.status === 204) continue;
      const job = await res.json();
      await fetch(`http://127.0.0.1:${port}/ext/result`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ id: job.id, ...handler(job) }) });
    }
  })();
  return () => (stop = true);
}

test('Hub：扩展长轮询取任务、交结果；别的进程经 /call 交任务', async () => {
  const port = await freePort();
  const hub = new Hub({ port, secret }, { pollHoldMs: 200 });
  assert.equal(await hub.start(), true);
  assert.equal(await new Hub({ port, secret }).start(), false); // 端口已被占：当客户端
  const stop = fakeExtension(port, (job) => (job.arg.path === 'bad' ? { error: '马帮利润报表：失败' } : { data: { echo: job.arg } }));
  assert.deepEqual(await hub.submit('finance', { path: 'p', body: { a: 1 } }), { echo: { path: 'p', body: { a: 1 } } });
  await assert.rejects(hub.submit('finance', { path: 'bad' }), MabangError);
  assert.deepEqual(await callHub({ port, secret }, 'stock', { value: 'A' }), { data: { echo: { value: 'A' } } });
  await assert.rejects(hub.submit('evil', {}), /不支持/);
  stop();
  hub.stop();
});

test('Hub：密钥或 Host 不对一律 403；扩展不在线报 ExtensionOffline', async () => {
  const port = await freePort();
  const hub = new Hub({ port, secret }, { pollHoldMs: 100, waitOnlineMs: 150, onlineMs: 100 });
  await hub.start();
  assert.equal((await fetch(`http://127.0.0.1:${port}/health`, { headers: { 'x-ext-secret': 'nope' } })).status, 403);
  assert.equal((await fetch(`http://localhost:${port}/health`, { headers: { 'x-ext-secret': secret } })).status, 403);
  assert.equal((await fetch(`http://127.0.0.1:${port}/health`, { headers: { 'x-ext-secret': secret } })).status, 200);
  await assert.rejects(hub.submit('finance', { path: 'p' }), ExtensionOffline);
  const t0 = Date.now();
  await assert.rejects(hub.submit('finance', { path: 'p' }, { wait: false }), ExtensionOffline);
  assert.ok(Date.now() - t0 < 100); // 不等
  assert.deepEqual(await callHub({ port, secret: 'wrong'.repeat(8) }, 'finance', {}), { down: true });
  hub.stop();
});
