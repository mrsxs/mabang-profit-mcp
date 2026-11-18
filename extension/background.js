// 马帮利润助手：常驻在用户 Chrome 里，向本机的马帮利润工具（127.0.0.1 中转）长轮询取查询任务，
// 在马帮页面里用用户已有的登录执行（和马帮页面自己发的请求一样），把结果交回。只读：只允许利润报表的几个查询和库存 SKU 列表。
// 马帮页复用（参考上品素材台扩展）：开过的页留着复用；「常开马帮页」（默认开）时一启动就在后台开好利润报表、库存 SKU、订单三个页（用户自己开着的马帮主站直接借用）、不让 Chrome 自动丢弃，
// 每 10 分钟用一次很轻的查询保温（登录令牌过期就重开）；关掉常开后，自己开的页闲置 10 分钟就关。用户自己开的马帮页只借用、不关。
import { APPS, FINANCE_PATH, ORDER_ID, appReady, financeFetch, findFrame, frameUrl, orderFetch, stockFetch } from './page-fns.js';

const OPEN_TIMEOUT_MS = 90_000;
const WARM_EVERY_MS = 10 * 60_000;
const IDLE_CLOSE_MS = 10 * 60_000;
const WARM_QUERY = { path: 'compute/status/166', body: { platformId: 166, dimension: 'item', isNewVersion: true } };
let cfg = null;
let running = false;
const opening = {}; // app → 正在开的 Promise（并发查询只开一个页）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hostOf = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
};

async function exec(tabId, func, arg) {
  const [r] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func, args: [arg] });
  return r?.result;
}

async function waitComplete(tabId) {
  const deadline = Date.now() + OPEN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error('马帮标签页被关掉了');
    if (tab.status === 'complete') return tab;
    await sleep(500);
  }
  throw new Error('马帮页面打开超时');
}

async function sessionGet(key, fallback) {
  return (await chrome.storage.session.get(key))[key] ?? fallback;
}

async function setOwned(app, tabId) {
  const tabs = await sessionGet('tabs', {});
  if (tabId) tabs[app] = tabId;
  else delete tabs[app];
  await chrome.storage.session.set({ tabs });
}

async function setStatus(patch) {
  await chrome.storage.session.set({ status: { ...(await sessionGet('status', {})), ...patch } });
}

async function alwaysOn() {
  const { alwaysOn: on } = await chrome.storage.local.get('alwaysOn');
  return on !== false; // 默认常开
}

async function ready(tabId, app) {
  const s = await exec(tabId, appReady, app.host).catch(() => null);
  return Boolean(s?.ok && s.token);
}

/** 在后台开一个马帮页：主站页面 → 读出子域名 iframe 地址 → 在同一个标签页里打开 */
async function openOwn(appKey) {
  const app = APPS[appKey];
  const tab = await chrome.tabs.create({ url: app.entry, active: false });
  await setOwned(appKey, tab.id);
  try {
    await waitComplete(tab.id);
    const deadline = Date.now() + OPEN_TIMEOUT_MS;
    if (app.direct) {
      // 订单页就在主站，打开就能用
      await chrome.tabs.update(tab.id, { autoDiscardable: false });
      while (Date.now() < deadline) {
        const st = await exec(tab.id, appReady, app.host).catch(() => null);
        if (st?.ok) return tab.id;
        if (st?.login) throw new Error('马帮没登录：先在 Chrome 里登录马帮（www.mabangerp.com）');
        await sleep(800);
      }
      throw new Error(`马帮${app.name}页打不开`);
    }
    let url = '';
    while (Date.now() < deadline) {
      const f = await exec(tab.id, findFrame, { host: app.host, mark: app.mark }).catch(() => null);
      url = frameUrl(f?.src ?? '', app);
      if (url) break;
      if (f?.login && f.state === 'complete') throw new Error('马帮没登录：先在 Chrome 里登录马帮（www.mabangerp.com）');
      await sleep(1000);
    }
    if (!url) throw new Error(`马帮${app.name}页打不开`);
    await chrome.tabs.update(tab.id, { url, autoDiscardable: false }); // 省内存模式也别把它丢掉
    await waitComplete(tab.id);
    while (Date.now() < deadline) {
      if (await ready(tab.id, app)) return tab.id;
      await sleep(800);
    }
    throw new Error(`马帮${app.name}页打不开`);
  } catch (err) {
    await chrome.tabs.remove(tab.id).catch(() => {});
    await setOwned(appKey, null);
    throw err;
  }
}

/** 能执行查询的马帮页：先用自己开的，再借已经开着的，都没有才在后台开；fresh = 关掉自己的重开（登录令牌过期时） */
async function appTab(appKey, fresh = false) {
  const app = APPS[appKey];
  if (opening[appKey]) {
    const id = await opening[appKey].catch(() => null);
    if (id && !fresh && (await ready(id, app))) return id;
  }
  opening[appKey] = (async () => {
    const owned = (await sessionGet('tabs', {}))[appKey];
    if (owned && fresh) {
      await chrome.tabs.remove(owned).catch(() => {});
      await setOwned(appKey, null);
    } else if (owned) {
      const tab = await chrome.tabs.get(owned).catch(() => null);
      if (tab && hostOf(tab.url) === app.host && (await ready(owned, app))) return owned;
      await setOwned(appKey, null);
    }
    if (!fresh) {
      for (const tab of await chrome.tabs.query({ url: `https://${app.host}/*` })) if (await ready(tab.id, app)) return tab.id;
    }
    return openOwn(appKey);
  })();
  try {
    const id = await opening[appKey];
    await setStatus({ [appKey]: { ok: true, at: Date.now() } });
    return id;
  } catch (err) {
    opening[appKey] = null;
    await setStatus({ [appKey]: { ok: false, at: Date.now(), error: String(err?.message ?? err) } });
    throw err;
  }
}

async function query(appKey, fn, arg) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const tabId = await appTab(appKey, attempt > 0);
    const r = await exec(tabId, fn, arg).catch((err) => ({ retry: err.message }));
    if (r?.error) return { error: `马帮${APPS[appKey].name}：${r.error}` };
    if (!r?.retry) {
      await chrome.storage.session.set({ [`used_${appKey}`]: Date.now() });
      return { data: appKey === 'finance' ? r.data : r.rows };
    }
  }
  return { error: '马帮没登录或登录已过期：先在 Chrome 里登录马帮再重试' };
}

async function runJob({ kind, arg }) {
  if (kind === 'finance' && FINANCE_PATH.test(String(arg?.path ?? ''))) return query('finance', financeFetch, { path: arg.path, body: arg.body ?? {} });
  if (kind === 'stock' && typeof arg?.value === 'string' && arg.value.length <= 80) return query('stock', stockFetch, { value: arg.value, rows: Math.min(Number(arg.rows) || 50, 200) });
  if (kind === 'order' && Array.isArray(arg?.values) && arg.values.length && arg.values.length <= 20 && arg.values.every((v) => ORDER_ID.test(String(v)))) {
    return query('order', orderFetch, { values: arg.values.map(String), by: ['trade', 'order'].includes(arg.by) ? arg.by : 'auto' });
  }
  return { error: '不允许的查询' };
}

/** 常开：两个马帮页都开好并保温；不常开：自己开的页闲置久了就关 */
async function maintain() {
  if (await alwaysOn()) {
    for (const appKey of Object.keys(APPS)) await appTab(appKey).catch(() => {});
    if (Date.now() - (await sessionGet('warmAt', 0)) > WARM_EVERY_MS) {
      await chrome.storage.session.set({ warmAt: Date.now() });
      await query('finance', financeFetch, WARM_QUERY).catch(() => {});
    }
    return;
  }
  const tabs = await sessionGet('tabs', {});
  for (const [appKey, id] of Object.entries(tabs)) {
    if (Date.now() - (await sessionGet(`used_${appKey}`, 0)) < IDLE_CLOSE_MS) continue;
    await chrome.tabs.remove(id).catch(() => {});
    await setOwned(appKey, null);
  }
}

async function loop() {
  if (running) return;
  running = true;
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20_000); // 有中转时别让后台被回收
  try {
    cfg ??= await (await fetch(chrome.runtime.getURL('config.json'))).json();
    const base = `http://127.0.0.1:${cfg.port}`;
    const headers = { 'x-ext-secret': cfg.secret };
    for (;;) {
      let res;
      try {
        res = await fetch(`${base}/ext/next`, { headers, cache: 'no-store' });
      } catch {
        await setStatus({ hub: { ok: false, at: Date.now() } });
        break; // 马帮利润工具没开：等下次闹钟再看
      }
      await setStatus({ hub: { ok: res.ok, at: Date.now() } });
      if (res.status === 204) continue;
      if (!res.ok) break;
      const job = await res.json();
      const result = await runJob(job).catch((err) => ({ error: String(err?.message ?? err) }));
      await fetch(`${base}/ext/result`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ id: job.id, ...result }) }).catch(() => {});
    }
  } finally {
    clearInterval(keepAlive);
    running = false;
  }
}

function tick() {
  loop();
  maintain().catch(() => {});
}

chrome.alarms.create('poll', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'poll') tick();
});
chrome.runtime.onStartup.addListener(tick);
chrome.runtime.onInstalled.addListener(tick);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.alwaysOn) maintain().catch(() => {});
});
chrome.tabs.onRemoved.addListener(async (tabId) => {
  for (const [k, id] of Object.entries(await sessionGet('tabs', {}))) if (id === tabId) await setOwned(k, null);
});
// 弹窗里点「现在打开」
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type !== 'openNow') return false;
  Promise.all(Object.keys(APPS).map((k) => appTab(k).then(() => null, (e) => String(e?.message ?? e)))).then((errs) => reply({ errors: errs.filter(Boolean) }));
  return true;
});
tick();
