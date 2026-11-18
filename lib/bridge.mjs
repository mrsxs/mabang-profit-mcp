// 马帮桥：常驻进程，只连一次主 Chrome（用户点一次「允许远程调试」），之后各个 MCP 进程（Accio、Claude Code）都经它在马帮页面里查数据，不用再点。
// 只在 127.0.0.1 上听，带随机令牌（bridge.json，600）；只转发 Mabang 会话里白名单内的只读查询，马帮的登录始终留在浏览器里。
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { ChromeError } from './chrome.mjs';
import { Mabang, MabangError } from './session.mjs';

export const bridgeFile = (env = process.env) => env.MABANG_BRIDGE_FILE || join(homedir(), '.config', 'mabang-profit', 'bridge.json');
const MAX_BODY = 64 * 1024;
const CALL_TIMEOUT_MS = 5 * 60_000;

/** 桥没开着 / 连不上：调用方改为自己连 Chrome */
export class BridgeDown extends Error {}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('请求太大'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function startBridge({ port = 0, file = bridgeFile(), log = () => {} } = {}) {
  const mb = new Mabang({ log });
  // 先连上 Chrome 并确认马帮已登录（这一步 Chrome 会弹一次「允许远程调试」）
  await mb.finance('compute/status/166', { platformId: 166, dimension: 'item', isNewVersion: true });
  const token = randomBytes(24).toString('hex');
  let actualPort = port;
  const server = createServer(async (req, res) => {
    const reply = (status, obj) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };
    // 只认本机地址和令牌（防别的网页通过 DNS 重绑定访问）
    if (req.headers.host !== `127.0.0.1:${actualPort}` || req.headers['x-bridge-token'] !== token) return reply(403, { error: '无权访问' });
    if (req.method === 'GET' && req.url === '/health') return reply(200, { ok: true, pid: process.pid });
    if (req.method !== 'POST' || !['/finance', '/stock', '/order'].includes(req.url)) return reply(404, { error: '没有这个接口' });
    let arg;
    try {
      arg = JSON.parse(await readBody(req));
    } catch {
      return reply(400, { error: '请求不是 JSON' });
    }
    try {
      const data = req.url === '/finance'
        ? await mb.finance(String(arg?.path ?? ''), arg?.body ?? {})
        : req.url === '/order'
          ? await mb.order(arg?.values, arg?.by)
          : await mb.stock(String(arg?.value ?? '').slice(0, 80), Math.min(Number(arg?.rows) || 50, 200));
      return reply(200, { data });
    } catch (err) {
      return reply(err instanceof ChromeError ? 503 : 400, { error: err.message, kind: err instanceof ChromeError ? 'chrome' : 'mabang' });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  actualPort = server.address().port;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ port: actualPort, token, pid: process.pid, startedAt: new Date().toISOString() }), { mode: 0o600 });
  chmodSync(file, 0o600);
  const stop = async () => {
    try {
      if (JSON.parse(readFileSync(file, 'utf8')).pid === process.pid) rmSync(file);
    } catch {}
    server.close();
    await Promise.race([mb.close(), new Promise((r) => setTimeout(r, 3000))]).catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  return { port: actualPort, file };
}

/** MCP 进程这边：有桥就走桥 */
export class BridgeClient {
  constructor(file = bridgeFile()) {
    this.file = file;
  }

  #info() {
    let info;
    try {
      info = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      return null;
    }
    try {
      process.kill(info.pid, 0);
    } catch {
      return null; // 桥进程已经不在了
    }
    return Number.isInteger(info.port) && typeof info.token === 'string' ? info : null;
  }

  available() {
    return Boolean(this.#info());
  }

  async call(kind, arg) {
    const info = this.#info();
    if (!info) throw new BridgeDown('马帮桥没开');
    let res;
    try {
      res = await fetch(`http://127.0.0.1:${info.port}/${kind}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-bridge-token': info.token }, body: JSON.stringify(arg), signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch (err) {
      if (err.name === 'TimeoutError') throw new MabangError('马帮桥超时没返回');
      throw new BridgeDown(`连不上马帮桥：${err.message}`);
    }
    const d = await res.json().catch(() => ({}));
    if (res.ok) return d.data;
    if (res.status === 403) throw new BridgeDown('马帮桥拒绝访问（令牌不对）');
    throw d.kind === 'chrome' ? new ChromeError(d.error) : new MabangError(d.error ?? `马帮桥出错（HTTP ${res.status}）`);
  }
}
