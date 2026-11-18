// 扩展中转：只在 127.0.0.1 上听。马帮利润助手扩展（在用户 Chrome 里常驻）长轮询来取任务、交结果，
// 在马帮页面里用用户已有的登录查数据——不用远程调试，所以永远不弹「允许远程调试」，登录也始终留在浏览器里。
// 几个 MCP 进程（Accio、Claude Code）同时开着时，第一个占到端口的当中转，其余的把任务交给它（/call）。
import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MabangError } from './session.mjs';

export const extensionFile = (env = process.env) => env.MABANG_EXTENSION_FILE || join(homedir(), '.config', 'mabang-profit', 'extension.json');
const POLL_HOLD_MS = 20_000; // 扩展一次长轮询最多挂这么久
const ONLINE_MS = 70_000; // 这么久没来取任务就算扩展不在线
const WAIT_ONLINE_MS = 40_000; // 扩展不在线时等它上线（扩展每 30 秒自己检查一次）
const JOB_TIMEOUT_MS = 150_000;
const MAX_BODY = 8 * 1024 * 1024;

/** 扩展没装 / 没开 / Chrome 没开 */
export class ExtensionOffline extends Error {}

/** 打包扩展时生成的 { port, secret }（文件 600）；没有 = 没装扩展 */
export function loadExtensionConfig(file = extensionFile()) {
  try {
    if ((statSync(file).mode & 0o077) !== 0) return null; // 权限太宽不用
    const c = JSON.parse(readFileSync(file, 'utf8'));
    return Number.isInteger(c.port) && typeof c.secret === 'string' && c.secret.length >= 32 ? { port: c.port, secret: c.secret } : null;
  } catch {
    return null;
  }
}

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

const OFFLINE = '马帮利润助手扩展没连上：确认 Chrome 开着、扩展已启用（chrome://extensions 里「马帮利润助手」是打开的），马帮已登录';

export class Hub {
  constructor({ port, secret }, { log = () => {}, pollHoldMs = POLL_HOLD_MS, onlineMs = ONLINE_MS, waitOnlineMs = WAIT_ONLINE_MS, jobTimeoutMs = JOB_TIMEOUT_MS } = {}) {
    Object.assign(this, { port, secret, log, pollHoldMs, onlineMs, waitOnlineMs, jobTimeoutMs });
    this.queue = [];
    this.waiters = []; // 正挂着的长轮询
    this.pending = new Map(); // id → { resolve, reject, timer }
    this.lastSeen = 0;
    this.onlineWaiters = [];
    this.server = null;
  }

  /** 占端口；端口被别的进程占了返回 false（那边是中转） */
  start() {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => this.#handle(req, res).catch(() => this.#reply(res, 500, { error: '中转出错' })));
      server.once('error', (err) => (err.code === 'EADDRINUSE' ? resolve(false) : reject(err)));
      server.listen(this.port, '127.0.0.1', () => {
        this.server = server;
        resolve(true);
      });
    });
  }

  stop() {
    this.server?.close();
    for (const w of this.waiters) this.#reply(w.res, 204);
    this.waiters = [];
  }

  online() {
    return Date.now() - this.lastSeen < this.onlineMs;
  }

  #reply(res, status, obj) {
    if (res.writableEnded) return;
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(obj === undefined ? '' : JSON.stringify(obj));
  }

  #seen() {
    this.lastSeen = Date.now();
    for (const w of this.onlineWaiters.splice(0)) w();
  }

  async #handle(req, res) {
    // 只认本机地址 + 打包时生成的密钥（网页访问不到也猜不到）
    if (req.headers.host !== `127.0.0.1:${this.port}` || req.headers['x-ext-secret'] !== this.secret) return this.#reply(res, 403, { error: '无权访问' });
    const path = req.url.split('?')[0];
    if (req.method === 'GET' && path === '/health') return this.#reply(res, 200, { ok: true, extensionOnline: this.online(), pid: process.pid });
    if (req.method === 'GET' && path === '/ext/next') return this.#next(req, res);
    if (req.method !== 'POST') return this.#reply(res, 404, { error: '没有这个接口' });
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return this.#reply(res, 400, { error: '请求不是 JSON' });
    }
    if (path === '/ext/result') {
      this.#seen();
      const p = this.pending.get(String(body?.id));
      if (p) {
        this.pending.delete(String(body.id));
        clearTimeout(p.timer);
        if (body.error) p.reject(new MabangError(String(body.error)));
        else p.resolve(body.data);
      }
      return this.#reply(res, 200, { ok: true });
    }
    if (path === '/call') {
      try {
        return this.#reply(res, 200, { data: await this.submit(String(body?.kind ?? ''), body?.arg ?? {}, { wait: body?.wait !== false }) });
      } catch (err) {
        return this.#reply(res, err instanceof ExtensionOffline ? 503 : 400, { error: err.message, kind: err instanceof ExtensionOffline ? 'offline' : 'mabang' });
      }
    }
    return this.#reply(res, 404, { error: '没有这个接口' });
  }

  #next(req, res) {
    this.#seen();
    const job = this.queue.shift();
    if (job) return this.#reply(res, 200, job);
    const w = { res };
    w.timer = setTimeout(() => {
      this.waiters = this.waiters.filter((x) => x !== w);
      this.#reply(res, 204);
    }, this.pollHoldMs);
    this.waiters.push(w);
    req.on('close', () => {
      clearTimeout(w.timer);
      this.waiters = this.waiters.filter((x) => x !== w);
    });
  }

  async #waitOnline() {
    if (this.online()) return;
    this.log('等马帮利润助手扩展连上…');
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.onlineWaiters = this.onlineWaiters.filter((x) => x !== done);
        reject(new ExtensionOffline(OFFLINE));
      }, this.waitOnlineMs);
      const done = () => {
        clearTimeout(t);
        resolve();
      };
      this.onlineWaiters.push(done);
    });
  }

  /** 把一个查询交给扩展，等结果；wait=false 时扩展不在线立刻报 ExtensionOffline（调用方有别的取数办法） */
  async submit(kind, arg, { wait = true } = {}) {
    if (!['finance', 'stock', 'order'].includes(kind)) throw new MabangError(`不支持的查询：${kind}`);
    if (!wait && !this.online()) throw new ExtensionOffline(OFFLINE);
    await this.#waitOnline();
    const job = { id: randomUUID(), kind, arg };
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(job.id);
        this.queue = this.queue.filter((j) => j.id !== job.id);
        reject(new MabangError('马帮利润助手扩展超时没返回结果（马帮页面可能很慢，或 Chrome 被关了），请重试'));
      }, this.jobTimeoutMs);
      this.pending.set(job.id, { resolve, reject, timer });
    });
    const w = this.waiters.shift();
    if (w) {
      clearTimeout(w.timer);
      this.#reply(w.res, 200, job);
    } else this.queue.push(job);
    return result;
  }
}

/** 别的进程是中转时：把查询交给它 */
export async function callHub({ port, secret }, kind, arg, { wait = true } = {}) {
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${port}/call`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-ext-secret': secret }, body: JSON.stringify({ kind, arg, wait }), signal: AbortSignal.timeout(JOB_TIMEOUT_MS + WAIT_ONLINE_MS + 10_000),
    });
  } catch (err) {
    if (err.name === 'TimeoutError') throw new MabangError('马帮利润助手中转超时没返回');
    return { down: true };
  }
  const d = await res.json().catch(() => ({}));
  if (res.ok) return { data: d.data };
  if (res.status === 403) return { down: true }; // 端口被别的程序占了
  throw d.kind === 'offline' ? new ExtensionOffline(d.error) : new MabangError(d.error ?? `中转出错（HTTP ${res.status}）`);
}
