// 马帮会话：借用户主 Chrome 里已登录的马帮，在马帮自己的页面里调它的查询接口（只查不改）。
// 利润报表在 finance.mabangerp.com、库存 SKU 在 aamz.mabangerp.com，都是主站 www.mabangerp.com 里的 iframe，地址带登录凭据：
// 先借已经开着的这两个子域名页面 / iframe；没有就自己在后台开一个主站页面，读出 iframe 地址再在这个标签页里直接打开（只开自己的，不动用户的标签页）。
import { attachPage, connectBrowser, devToolsEndpoint, listTargets } from './chrome.mjs';
import { APPS, FINANCE_PATH, ORDER_ID, appReady, financeFetch, findFrame, frameUrl, orderFetch, stockFetch } from './page-fns.mjs';

export { APPS, frameUrl };

export class MabangError extends Error {}

const OPEN_TIMEOUT_MS = 90_000;
const CALL_TIMEOUT_MS = 90_000;
const NOT_LOGGED_IN = '马帮没登录：先在 Chrome 里登录马帮（www.mabangerp.com），再重试';

export function onHost(url, host) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === host;
  } catch {
    return false;
  }
}


// ---- 会话 ----

export class Mabang {
  constructor({ endpoint = () => devToolsEndpoint(), log = () => {} } = {}) {
    this.endpoint = endpoint;
    this.log = log;
    this.browser = null;
    this.pages = {}; // app → { targetId, page, owned }
    this.owned = new Set();
    this.locks = {};
  }

  async #browser() {
    if (!this.browser || !this.browser.isOpen()) {
      this.browser = await connectBrowser(this.endpoint());
      this.pages = {};
    }
    return this.browser;
  }

  /** 同一个子应用的打开 / 重开串行，免得并发调用各开一个标签页 */
  #locked(app, fn) {
    const prev = this.locks[app] ?? Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    this.locks[app] = run;
    return run;
  }

  async #waitReady(page, app) {
    const deadline = Date.now() + OPEN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const s = await page.callInPage(appReady, app.host, 10_000).catch(() => null);
      if (s?.ok && s.token) return;
      await sleep(800);
    }
    throw new MabangError(`马帮${app.name}页打不开（等了 ${OPEN_TIMEOUT_MS / 1000} 秒）：在 Chrome 里打开马帮看看能不能正常显示`);
  }

  /** 自己在后台开一个主站页面 → 读出子域名 iframe 地址 → 在同一个标签页里打开 */
  async #openOwn(app) {
    const browser = await this.#browser();
    const { targetId } = await browser.send('Target.createTarget', { url: app.entry, background: true });
    this.owned.add(targetId);
    const page = await attachPage(browser, targetId);
    const deadline = Date.now() + OPEN_TIMEOUT_MS;
    if (app.direct) {
      // 订单页就在主站，打开就能用
      while (Date.now() < deadline) {
        await sleep(1000);
        const st = await page.callInPage(appReady, app.host, 10_000).catch(() => null);
        if (st?.ok) return { targetId, page, owned: true };
        if (st?.login) {
          await this.#closeTarget(targetId);
          throw new MabangError(NOT_LOGGED_IN);
        }
      }
      await this.#closeTarget(targetId);
      throw new MabangError(`马帮${app.name}页打不开：在 Chrome 里打开马帮看看能不能正常显示`);
    }
    let url = '';
    while (Date.now() < deadline) {
      await sleep(1000);
      const f = await page.callInPage(findFrame, { host: app.host, mark: app.mark }, 10_000).catch(() => null);
      if (!f || f.state === 'loading') continue;
      url = frameUrl(f.src, app);
      if (url) break;
      if (f.login && f.state === 'complete') {
        await this.#closeTarget(targetId);
        throw new MabangError(NOT_LOGGED_IN);
      }
    }
    if (!url) {
      await this.#closeTarget(targetId);
      throw new MabangError(`马帮${app.name}页打不开：在 Chrome 里打开马帮看看能不能正常显示`);
    }
    await browser.send('Page.navigate', { url }, page.sessionId);
    await this.#waitReady(page, app);
    this.log(`已在后台打开马帮${app.name}页`);
    return { targetId, page, owned: true };
  }

  async #closeTarget(targetId) {
    this.owned.delete(targetId);
    await this.browser?.send('Target.closeTarget', { targetId }).catch(() => {});
  }

  /** 拿到能调接口的页面：先用自己开过的，再借已经开着的（标签页或 iframe），都没有才自己开 */
  async #page(appKey, { fresh = false } = {}) {
    const app = APPS[appKey];
    return this.#locked(appKey, async () => {
      const cur = this.pages[appKey];
      if (cur && !fresh && this.browser?.isOpen()) return cur;
      if (cur && fresh) {
        await cur.page.detach();
        if (cur.owned) await this.#closeTarget(cur.targetId);
        delete this.pages[appKey];
      }
      const browser = await this.#browser();
      if (!fresh) {
        const targets = (await listTargets(browser)).filter((t) => (t.type === 'page' || t.type === 'iframe') && onHost(t.url, app.host));
        targets.sort((a, b) => Number(this.owned.has(b.targetId)) - Number(this.owned.has(a.targetId)));
        for (const t of targets) {
          const page = await attachPage(browser, t.targetId).catch(() => null);
          if (!page) continue;
          const s = await page.callInPage(appReady, app.host, 10_000).catch(() => null);
          if (s?.ok && s.token) return (this.pages[appKey] = { targetId: t.targetId, page, owned: this.owned.has(t.targetId) });
          await page.detach();
        }
      }
      return (this.pages[appKey] = await this.#openOwn(app));
    });
  }

  async #call(appKey, fn, arg) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { page } = await this.#page(appKey, { fresh: attempt > 0 });
      const r = await page.callInPage(fn, arg, CALL_TIMEOUT_MS).catch((err) => ({ retry: err.message }));
      if (r?.error) throw new MabangError(`马帮${APPS[appKey].name}：${r.error}`);
      if (!r?.retry) return r;
      this.log(`马帮${APPS[appKey].name}页要重开：${r.retry}`);
    }
    throw new MabangError(`${NOT_LOGGED_IN}（或登录已过期）`);
  }

  /** 利润报表接口；path 只允许本工具用到的只读查询 */
  async finance(path, body) {
    if (!FINANCE_PATH.test(path)) throw new MabangError(`不允许的马帮接口：${path}`);
    return (await this.#call('finance', financeFetch, { path, body })).data;
  }

  /** 订单：按交易号 / 订单编号查（values ≤20 个，by = auto / trade / order） */
  async order(values, by = 'auto') {
    if (!Array.isArray(values) || !values.length || values.length > 20 || !values.every((v) => ORDER_ID.test(String(v)))) throw new MabangError('订单号不对');
    return (await this.#call('order', orderFetch, { values, by: ['trade', 'order'].includes(by) ? by : 'auto' })).rows;
  }

  /** 库存 SKU：库存 SKU 开头是 value 的（最多 rows 条） */
  async stock(value, rows = 50) {
    return (await this.#call('stock', stockFetch, { value, rows })).rows;
  }

  /** 关掉自己开的标签页（借用的不关） */
  async close() {
    for (const id of [...this.owned]) await this.#closeTarget(id);
    this.browser?.close();
    this.browser = null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
