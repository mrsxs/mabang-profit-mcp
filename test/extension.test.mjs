// 用模拟的 chrome.* 跑打包后的扩展后台：取任务 → 开马帮页（主站 → 读 iframe 地址 → 打开）→ 页面里执行 → 交结果；
// 常开时一启动就预开两个马帮页、并发查询只开一个页、复用不重开；关掉常开后闲置页会被关掉
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { Hub } from '../lib/hub.mjs';
import { MabangError } from '../lib/session.mjs';

const PATHS = { 'finance.mabangerp.com': '/profit-report', 'aamz.mabangerp.com': '/index.php' };
const ORDER = { orderId: 'A1', tradeId: 'A1', shop: '店F', profit: '-2.03' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mockChrome(cfg) {
  const tabs = new Map();
  const listeners = { alarm: [], changed: [], message: [] };
  const state = { nextId: 1, calls: [], session: {}, local: {} };
  globalThis.chrome = {
    runtime: {
      getURL: () => `data:application/json,${encodeURIComponent(JSON.stringify(cfg))}`, getPlatformInfo: () => {},
      onStartup: { addListener() {} }, onInstalled: { addListener() {} }, onMessage: { addListener: (f) => listeners.message.push(f) },
    },
    alarms: { create() {}, onAlarm: { addListener: (f) => listeners.alarm.push(f) } },
    storage: {
      session: { get: async (k) => ({ [k]: state.session[k] }), set: async (o) => Object.assign(state.session, o) },
      local: {
        get: async (k) => ({ [k]: state.local[k] }),
        set: async (o) => {
          Object.assign(state.local, o);
          for (const f of listeners.changed) f(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { newValue: v }])), 'local');
        },
      },
      onChanged: { addListener: (f) => listeners.changed.push(f) },
    },
    tabs: {
      onRemoved: { addListener() {} },
      query: async () => [],
      create: async ({ url }) => {
        const tab = { id: state.nextId++, url, status: 'complete' };
        tabs.set(tab.id, tab);
        return tab;
      },
      get: async (id) => tabs.get(id) ?? Promise.reject(new Error('no tab')),
      update: async (id, props) => Object.assign(tabs.get(id), props),
      remove: async (id) => tabs.delete(id),
    },
    scripting: {
      executeScript: async ({ target, func, args }) => {
        const tab = tabs.get(target.tabId);
        const host = new URL(tab.url).hostname;
        state.calls.push(`${func.name}@${host}`);
        await sleep(5);
        const result = {
          findFrame: () => ({ src: host === 'www.mabangerp.com' ? `https://${args[0].host}${PATHS[args[0].host]}?key=k` : '', login: false, state: 'complete' }),
          appReady: () => ({ ok: host === args[0], login: false, token: true }),
          financeFetch: () => ({ data: { echo: args[0] } }),
          stockFetch: () => ({ rows: [{ stockSku: args[0].value }] }),
          orderFetch: () => ({ rows: args[0].values.map((value) => ({ value, matchedBy: '交易号', hits: [ORDER] })) }),
        }[func.name]();
        return [{ result }];
      },
    },
  };
  return { tabs, listeners, state };
}

test('扩展后台：常开预开两个页、并发只开一个、复用、白名单；关常开后闲置页关掉', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbx-'));
  const cfgFile = join(dir, 'extension.json');
  execFileSync(process.execPath, ['scripts/build-extension.mjs', join(dir, 'ext')], { env: { ...process.env, MABANG_EXTENSION_FILE: cfgFile } });
  const cfg = JSON.parse(readFileSync(join(dir, 'ext', 'config.json'), 'utf8'));
  assert.deepEqual(JSON.parse(readFileSync(cfgFile, 'utf8')), cfg);
  for (const f of ['manifest.json', 'background.js', 'popup.html', 'popup.js', 'page-fns.js', 'config.json']) readFileSync(join(dir, 'ext', f));
  assert.equal(JSON.parse(readFileSync(join(dir, 'ext', 'manifest.json'), 'utf8')).version, '0.3.1');
  cfg.port = 47000 + Math.floor(Math.random() * 900);
  const hub = new Hub(cfg, { pollHoldMs: 300 });
  assert.equal(await hub.start(), true);
  const { tabs, listeners, state } = mockChrome(cfg);

  await import(`${pathToFileURL(join(dir, 'ext', 'background.js')).href}?t=${Date.now()}`);
  // 常开（默认）：一启动就在后台开好利润报表、库存、订单三个页，并设成不自动丢弃
  for (let i = 0; i < 150 && [...tabs.values()].filter((t) => t.autoDiscardable === false).length < 3; i++) await sleep(20);
  const opened = [...tabs.values()];
  assert.deepEqual(opened.map((t) => new URL(t.url).hostname).sort(), ['aamz.mabangerp.com', 'finance.mabangerp.com', 'www.mabangerp.com']);
  assert.ok(opened.every((t) => t.autoDiscardable === false));
  assert.equal(state.calls[0], 'findFrame@www.mabangerp.com');

  // 几个查询同时来：复用已开的页，不新开
  const body = { platformId: 166 };
  const results = await Promise.all([
    hub.submit('finance', { path: 'profit/sheinobm/getShop', body }),
    hub.submit('finance', { path: 'profit/ozon/getItem', body }),
    hub.submit('stock', { value: 'TREE' }),
  ]);
  assert.deepEqual(results[0], { echo: { path: 'profit/sheinobm/getShop', body } });
  assert.deepEqual(results[2], [{ stockSku: 'TREE' }]);
  assert.equal(tabs.size, 3);
  // 订单：按交易号查，在订单页（主站）里执行；单号格式不对的拒绝
  assert.deepEqual(await hub.submit('order', { values: ['A1'], by: 'auto' }), [{ value: 'A1', matchedBy: '交易号', hits: [ORDER] }]);
  assert.ok(state.calls.includes('orderFetch@www.mabangerp.com'));
  await assert.rejects(hub.submit('order', { values: ['a b'] }), /不允许/);
  assert.equal(tabs.size, 3);
  assert.ok(state.calls.includes('financeFetch@finance.mabangerp.com'));

  // 白名单外的接口一律拒绝
  await assert.rejects(hub.submit('finance', { path: 'profit/sheinobm/deleteAll', body: {} }), (e) => e instanceof MabangError && /不允许/.test(e.message));

  // 弹窗「现在打开」：页都在，直接就绪
  const reply = await new Promise((resolve) => listeners.message[0]({ type: 'openNow' }, null, resolve));
  assert.deepEqual(reply, { errors: [] });
  assert.equal(tabs.size, 3);

  // 关掉常开：闲置超过 10 分钟的自己开的页被关掉
  state.session.used_finance = Date.now() - 11 * 60_000;
  state.session.used_order = Date.now() - 11 * 60_000;
  state.session.used_stock = Date.now();
  await chrome.storage.local.set({ alwaysOn: false });
  for (let i = 0; i < 50 && tabs.size > 1; i++) await sleep(20);
  assert.deepEqual([...tabs.values()].map((t) => new URL(t.url).hostname), ['aamz.mabangerp.com']);
  hub.stop();
});
