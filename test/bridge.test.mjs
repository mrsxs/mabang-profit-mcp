import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BridgeClient, BridgeDown } from '../lib/bridge.mjs';
import { MabangError } from '../lib/session.mjs';

const dir = mkdtempSync(join(tmpdir(), 'mbb-'));

test('BridgeClient：没有桥文件 / 进程不在 = 不可用', async () => {
  assert.equal(new BridgeClient(join(dir, 'none.json')).available(), false);
  const f = join(dir, 'dead.json');
  writeFileSync(f, JSON.stringify({ port: 1, token: 'x', pid: 999_999_99 }));
  assert.equal(new BridgeClient(f).available(), false);
  await assert.rejects(new BridgeClient(f).call('finance', {}), BridgeDown);
});

test('BridgeClient：带令牌调用，错误按类型还原', async () => {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(req.headers['x-bridge-token'] === 't0k' ? (JSON.parse(body).path === 'bad' ? 400 : 200) : 403, { 'content-type': 'application/json' });
      res.end(JSON.stringify(JSON.parse(body).path === 'bad' ? { error: '马帮利润报表：失败', kind: 'mabang' } : { data: { got: JSON.parse(body) } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const f = join(dir, 'ok.json');
  writeFileSync(f, JSON.stringify({ port: server.address().port, token: 't0k', pid: process.pid }));
  const c = new BridgeClient(f);
  assert.equal(c.available(), true);
  assert.deepEqual(await c.call('finance', { path: 'p', body: { a: 1 } }), { got: { path: 'p', body: { a: 1 } } });
  await assert.rejects(c.call('finance', { path: 'bad' }), MabangError);
  writeFileSync(f, JSON.stringify({ port: server.address().port, token: 'wrong', pid: process.pid }));
  await assert.rejects(c.call('finance', { path: 'p' }), BridgeDown);
  server.close();
});
