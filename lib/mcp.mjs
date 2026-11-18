// MCP 工具：马帮利润报表（店铺 / 商品 / 订单）、库存 SKU 成本、用马帮历史单件利润估平台实时销量的利润。全部只读。
import { readFileSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { outputDir, safeName, toCsv, writeNew } from './output.mjs';
import {
  DEFAULTS, InputError, MAX_DAYS, PLATFORMS, PLATFORM_KEYS, aggregateItems, aggregateOrders, compareItems, compareShops, estimate, parseSku, prefixes, resolveRange, round, shopRows, summarizeItems,
} from './profit.mjs';
import { ChromeError } from './chrome.mjs';
import { BridgeClient, BridgeDown } from './bridge.mjs';
import { ExtensionOffline, Hub, callHub, loadExtensionConfig } from './hub.mjs';
import { ORDER_ID } from './page-fns.mjs';
import { Mabang, MabangError } from './session.mjs';

const PAGE_SIZE = 1000;
const MAX_ROWS = 60_000;
const CACHE_MS = 10 * 60_000;
const ITEM_PLATFORMS = PLATFORM_KEYS.filter((k) => PLATFORMS[k].items);
const ORDER_PLATFORMS = PLATFORM_KEYS.filter((k) => PLATFORMS[k].orders);

export class ArgError extends Error {}

const INSTRUCTIONS = '马帮 ERP 的成本和利润（用电脑上 Chrome 里已登录的马帮，只读）。马帮「利润报表(新)」按结算日期统计，已经扣了商品成本和平台各项费用。'
  + '店铺盈亏：mabang_shop_profit（所有平台一次看，和上一期比）。'
  + `商品盈亏：mabang_item_profit（${ITEM_PLATFORMS.map((k) => PLATFORMS[k].label).join(' / ')}，按平台 SKU，标出亏损 / 低毛利 / 毛利率下滑）；速卖通只有订单级：mabang_order_profit。`
  + '和平台数据联动：先用平台的工具拿实时销量（如 SHEIN 的 shein_sales、Ozon 的销量），把 [{sku, qty, revenue}] 交给 mabang_profit_estimate 按马帮历史单件成本和费用率估利润；'
  + '马帮没有结算记录的新品用 mabang_sku_cost 查库存 SKU 成本（平台 SKU「XXX*5」= 5 个库存 SKU XXX；也能按前缀查一批）。'
  + '单个订单：mabang_order_lookup 按交易号 / 订单编号查订单金额、利润、运费、物流单号。金额都是店铺原币种，不要混币种相加。';

const obj = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, ...(required.length ? { required } : {}) });
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
// 不改马帮数据，但会在本机新写 CSV 明细（只新建，不覆盖）
const EXPORT = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const range = {
  month: { type: 'string', description: '整月 YYYY-MM（当月就到今天）；和 start / end 二选一' },
  start: { type: 'string', description: '结算日期起 YYYY-MM-DD' },
  end: { type: 'string', description: '结算日期止 YYYY-MM-DD（默认今天）；都不填 = 最近 30 天' },
};
const thresholds = {
  low_margin: { type: 'number', minimum: -1, maximum: 1, description: `低毛利线（默认 ${DEFAULTS.lowMargin}，即 10%）` },
  margin_drop: { type: 'number', minimum: 0, maximum: 1, description: `毛利率比上一期掉多少算下滑（默认 ${DEFAULTS.marginDrop}，即 10 个百分点）` },
  min_qty: { type: 'integer', minimum: 1, maximum: 1000, description: `两期都卖到几件才比毛利率（默认 ${DEFAULTS.minQty}）` },
};
const shopArg = { type: 'string', description: '只看这家店（马帮里的店铺名，见 mabang_shop_profit）' };

let mabang = null;
const direct = () => (mabang ??= new Mabang({ log: (m) => process.stderr.write(`[mabang] ${m}\n`) }));
const bridge = new BridgeClient();
const log = (m) => process.stderr.write(`[mabang] ${m}\n`);

// 取数顺序：① 马帮利润助手扩展（装了就只用它，永远不弹 Chrome 的确认框）② 马帮桥（常驻的远程调试连接）③ 自己连 Chrome（会弹确认框，只在没装扩展时用）
let hub = null;
let hubBound = false;
export async function ensureHub(cfg = loadExtensionConfig()) {
  if (!cfg) return null;
  if (!hubBound) {
    hub ??= new Hub(cfg, { log });
    hubBound = await hub.start().catch(() => false);
    if (hubBound) log(`扩展中转在 127.0.0.1:${cfg.port}`);
  }
  return cfg;
}

async function viaExtension(cfg, kind, arg, opts) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (hubBound) return hub.submit(kind, arg, opts);
    const r = await callHub(cfg, kind, arg, opts);
    if (!r.down) return r.data;
    await ensureHub(cfg); // 当中转的那个进程不在了：自己接手
  }
  throw new ExtensionOffline('马帮利润助手扩展的中转端口被别的程序占用了');
}

const viaBridge = async (kind, arg, fallback) => {
  const cfg = await ensureHub();
  if (cfg) {
    try {
      // 马帮桥开着就不等扩展上线（扩展没装 / 没开时直接用桥）
      return await viaExtension(cfg, kind, arg, { wait: !bridge.available() });
    } catch (err) {
      if (!(err instanceof ExtensionOffline) || !bridge.available()) throw err;
    }
  }
  if (bridge.available()) {
    try {
      return await bridge.call(kind, arg);
    } catch (err) {
      if (!(err instanceof BridgeDown)) throw err;
    }
  }
  if (cfg) throw new ExtensionOffline('马帮利润助手扩展没连上：确认 Chrome 开着、扩展已启用、马帮已登录');
  return fallback();
};
const source = {
  finance: (path, body) => viaBridge('finance', { path, body }, () => direct().finance(path, body)),
  stock: (value, rows) => viaBridge('stock', { value, rows }, () => direct().stock(value, rows)),
  order: (values, by) => viaBridge('order', { values, by }, () => direct().order(values, by)),
};
const mb = () => source;
const cache = new Map();

/** 一个接口按页取全；同样的参数 10 分钟内直接用上次的结果 */
async function fetchAll(platform, endpoint, r) {
  const p = PLATFORMS[platform];
  const key = `${platform}|${endpoint}|${r.start}|${r.end}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const extra = endpoint === 'getItem' ? { platformSku: '' }
    : endpoint === 'getOrderDetail' ? { choiceFlagList: [], countryCodeList: [], isEvaluation: '', shippingServiceIdList: [], platformOrderId: '', paymentTimeStart: '', paymentTimeEnd: '' }
      : { isEvaluation: '' };
  const rows = [];
  let total = 0;
  for (let page = 1; ; page++) {
    const d = await mb().finance(`profit/${p.api}/${endpoint}`, {
      shopIdList: [], shopManagerIdList: [], dtStart: r.start, dtEnd: r.end, currencyCode: '', platformId: p.id, pageSize: PAGE_SIZE, pageIndex: page, ...extra,
    });
    if (!Array.isArray(d?.pageData)) throw new MabangError('马帮返回的数据格式不对（没有 pageData）');
    total = Number(d.totalCount);
    rows.push(...d.pageData);
    if (!d.pageData.length || !Number.isFinite(total) || rows.length >= total) break;
    if (rows.length >= MAX_ROWS) throw new MabangError(`数据超过 ${MAX_ROWS} 行，请缩短日期范围或指定店铺`);
  }
  if (Number.isFinite(total) && rows.length < total) throw new MabangError(`马帮只返回了 ${rows.length} / ${total} 行，请重试`);
  const value = { rows, total: rows.length };
  cache.set(key, { at: Date.now(), value });
  return value;
}

const pct = (x) => (x === null || x === undefined ? null : `${round(x * 100, 1)}%`);
const money = (x) => round(x, 2);
const pickShop = (shop) => (x) => !shop || x.shop.toLowerCase() === String(shop).toLowerCase() || String(x.shopId) === String(shop);

function itemView(x) {
  return {
    shop: x.shop, sku: x.sku || '(没关联商品)', name: x.name.slice(0, 60) || undefined, itemId: x.itemId || undefined, skc: x.skc || undefined, skuCode: x.skuCode || undefined,
    currency: x.currency, qty: x.qty, revenue: money(x.revenue), cost: money(x.cost), fees: money(x.fees), profit: money(x.profit), margin: pct(x.margin), unitProfit: money(x.unitProfit),
    prev: x.prev ? { qty: x.prev.qty, profit: money(x.prev.profit), margin: pct(x.prev.margin) } : null, flags: x.flags,
  };
}

const ITEM_COLUMNS = [
  ['shop', '店铺'], ['currency', '币种'], ['sku', '平台SKU'], ['name', '商品名'], ['itemId', '平台商品ID'], ['skc', 'SKC'], ['skuCode', '平台SKU编码'],
  ['qty', '销量'], ['refundQty', '退货量'], ['revenue', '销售额'], ['cost', '商品成本'], ['fees', '平台费用及其他'], ['profit', '毛利'], [(x) => pct(x.margin), '毛利率'],
  ['unitPrice', '单件销售额'], ['unitCost', '单件成本'], ['unitProfit', '单件毛利'],
  [(x) => x.prev?.qty, '上期销量'], [(x) => x.prev?.profit, '上期毛利'], [(x) => pct(x.prev?.margin), '上期毛利率'], [(x) => x.flags.join('、'), '标记'],
];


const MAX_FILE = 20 * 1024 * 1024;
const MAX_FILE_ROWS = 20_000;
/** 平台工具导出的销量文件（JSON：数组，或 { rows: [...] }，如 shein_sales 的「官方_销量_*.json」）→ [{ sku, qty, revenue }]，销量为 0 的跳过 */
export function rowsFromFile(file, qtyField = 'qty') {
  if (!isAbsolute(file) || !file.toLowerCase().endsWith('.json')) throw new ArgError('rows_file 要是本机 .json 文件的绝对路径');
  const full = resolve(file);
  const inside = (dir) => {
    const rel = relative(resolve(dir), full);
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  };
  if (!inside(homedir()) && !inside(tmpdir())) throw new ArgError('rows_file 要在用户目录或临时目录下');
  let st;
  try {
    st = statSync(full);
  } catch {
    throw new ArgError(`rows_file 不存在：${file}`);
  }
  if (!st.isFile() || st.size > MAX_FILE) throw new ArgError('rows_file 不是文件或超过 20MB');
  let d;
  try {
    d = JSON.parse(readFileSync(full, 'utf8'));
  } catch {
    throw new ArgError('rows_file 不是有效的 JSON');
  }
  const list = Array.isArray(d) ? d : Array.isArray(d?.rows) ? d.rows : null;
  if (!list) throw new ArgError('rows_file 里要有数组或 rows 数组');
  if (list.length > MAX_FILE_ROWS) throw new ArgError(`rows_file 超过 ${MAX_FILE_ROWS} 行`);
  const out = [];
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    const sku = String(r.sku ?? r.skuCode ?? r.offer_id ?? r.offerId ?? r.platformSku ?? '').trim();
    const qty = Number(r[qtyField]);
    if (!sku || !Number.isFinite(qty) || qty <= 0) continue;
    const revenue = r.revenue === undefined || r.revenue === null ? undefined : Number(r.revenue);
    out.push({ sku: sku.slice(0, 80), qty, ...(Number.isFinite(revenue) ? { revenue } : {}) });
  }
  return out;
}

// ---------- 工具 ----------

async function status() {
  const platforms = [];
  for (const k of PLATFORM_KEYS) {
    const p = PLATFORMS[k];
    // 连不上 Chrome / 没登录直接报错；单个平台查不到计算状态只记下来
    const d = await mb().finance(`compute/status/${p.id}`, { platformId: p.id, dimension: p.items ? 'item' : 'shop', isNewVersion: true }).catch((err) => {
      if (err instanceof MabangError && !/没登录/.test(err.message)) return { error: err.message };
      throw err;
    });
    platforms.push({ platform: k, label: p.label, item: p.items, orders: p.orders, lastComputed: d?.computeEndingTime ?? null, error: d?.error });
  }
  return { ok: true, note: '马帮已登录，利润报表可用。lastComputed 是马帮最近一次算完利润的时间。', platforms };
}

async function shopProfit(a) {
  const r = resolveRange(a);
  const keys = a.platforms?.length ? a.platforms : PLATFORM_KEYS;
  const out = [];
  const alerts = [];
  for (const k of keys) {
    const [cur, prev] = await Promise.all([fetchAll(k, 'getShop', r), fetchAll(k, 'getShop', { start: r.prevStart, end: r.prevEnd })]);
    const shops = compareShops(shopRows(k, cur.rows), shopRows(k, prev.rows), { lowMargin: a.low_margin, marginDrop: a.margin_drop });
    const view = shops.filter(pickShop(a.shop)).map((x) => ({
      shop: x.shop, currency: x.currency, qty: x.qty, revenue: money(x.revenue), cost: money(x.cost), profit: money(x.profit), margin: pct(x.margin),
      prev: x.prev ? { revenue: money(x.prev.revenue), profit: money(x.prev.profit), margin: pct(x.prev.margin) } : null, flags: x.flags,
    }));
    // 只有费用没有销售的（速卖通每家店的人民币固定费用等）合成一条，不逐店报
    const feeOnly = view.filter((x) => x.flags.includes('只有费用没有销售'));
    for (const x of view) {
      const flags = x.flags.filter((f) => f !== '只有费用没有销售');
      if (flags.length) alerts.push(`${PLATFORMS[k].label} ${x.shop}（${x.currency}）：${flags.join('、')}，毛利 ${x.profit}，毛利率 ${x.margin ?? '-'}${x.prev ? `（上期 ${x.prev.margin ?? '-'}）` : ''}`);
    }
    if (feeOnly.length) {
      const byCur = {};
      for (const x of feeOnly) byCur[x.currency] = round((byCur[x.currency] ?? 0) + x.profit, 2);
      alerts.push(`${PLATFORMS[k].label}：${feeOnly.length} 家店有没对应销售的费用（${Object.entries(byCur).map(([c, v]) => `${c} ${v}`).join('，')}），如${PLATFORMS[k].label === '速卖通' ? '半托管上门揽收、' : ''}平台扣款`);
    }
    out.push({ platform: k, label: PLATFORMS[k].label, shops: view, ...(view.length ? {} : { note: '这段时间马帮里没有这个平台的结算数据' }) });
  }
  return { range: r, basis: '马帮利润报表（新）按结算日期；毛利 = 销售额 − 商品成本 − 平台各项费用；金额为店铺原币种', alerts, platforms: out };
}

async function itemProfit(a) {
  const r = resolveRange(a);
  const [cur, prev] = await Promise.all([fetchAll(a.platform, 'getItem', r), fetchAll(a.platform, 'getItem', { start: r.prevStart, end: r.prevEnd })]);
  let items = compareItems(aggregateItems(a.platform, cur.rows), aggregateItems(a.platform, prev.rows), { lowMargin: a.low_margin, marginDrop: a.margin_drop, minQty: a.min_qty });
  items = items.filter(pickShop(a.shop));
  if (a.sku) items = items.filter((x) => x.sku.toUpperCase().includes(String(a.sku).toUpperCase()));
  const top = a.top ?? 15;
  const label = PLATFORMS[a.platform].label;
  const file = items.length
    ? writeNew(`${safeName(label)}_商品利润_${r.start}_${r.end}${a.shop ? `_${safeName(a.shop)}` : ''}.csv`, toCsv(ITEM_COLUMNS, [...items].sort((x, y) => x.profit - y.profit)))
    : null;
  const flagged = (f) => items.filter((x) => x.flags.includes(f));
  return {
    platform: a.platform, label, range: r, rows: cur.total, skus: items.length, file,
    basis: '马帮利润报表（新）「商品」页，按结算日期；上一期是 prevStart ~ prevEnd',
    summary: summarizeItems(items).map((s) => ({ ...s, revenue: money(s.revenue), profit: money(s.profit), lossAmount: money(s.lossAmount), margin: pct(s.margin) })),
    losses: flagged('亏损').sort((x, y) => x.profit - y.profit).slice(0, top).map(itemView),
    lowMargin: flagged('低毛利').sort((x, y) => y.revenue - x.revenue).slice(0, top).map(itemView),
    marginDropped: flagged('毛利率下滑').sort((x, y) => (x.margin ?? 0) - (x.prev.margin ?? 0) - ((y.margin ?? 0) - (y.prev.margin ?? 0))).slice(0, top).map(itemView),
    refundOnly: flagged('只有退款/费用').sort((x, y) => x.profit - y.profit).slice(0, Math.min(top, 10)).map(itemView),
    bestProfit: items.filter((x) => x.profit > 0).sort((x, y) => y.profit - x.profit).slice(0, 5).map(itemView),
  };
}

async function orderProfit(a) {
  const r = resolveRange(a);
  const cur = await fetchAll(a.platform, 'getOrderDetail', r);
  const orders = aggregateOrders(a.platform, cur.rows).filter(pickShop(a.shop));
  const top = a.top ?? 20;
  const shops = new Map();
  for (const o of orders) {
    const k = `${o.shop}|${o.currency}`;
    let s = shops.get(k);
    if (!s) shops.set(k, (s = { shop: o.shop, currency: o.currency, orders: 0, saleOrders: 0, lossSaleOrders: 0, lossSaleAmount: 0, feeOnlyLoss: 0, revenue: 0, profit: 0 }));
    s.orders += 1;
    s.revenue += o.revenue;
    s.profit += o.profit;
    if (o.goods > 0) s.saleOrders += 1;
    if (o.kind === '销售亏损') {
      s.lossSaleOrders += 1;
      s.lossSaleAmount += o.profit;
    }
    if (o.kind === '只有费用/退款') s.feeOnlyLoss += o.profit;
  }
  const label = PLATFORMS[a.platform].label;
  const file = orders.length
    ? writeNew(`${safeName(label)}_订单利润_${r.start}_${r.end}${a.shop ? `_${safeName(a.shop)}` : ''}.csv`, toCsv([
      ['shop', '店铺'], ['currency', '币种'], ['orderId', '订单号'], ['type', '订单类型'], ['country', '国家'], ['kind', '分类'], ['revenue', '销售额'], ['cost', '商品成本'], ['profit', '毛利'],
      [(x) => pct(x.margin), '毛利率'], [(x) => Object.entries(x.feeParts).map(([k, v]) => `${k}:${round(v)}`).join(' '), '费用明细'],
    ], [...orders].sort((x, y) => x.profit - y.profit)))
    : null;
  const view = (o) => ({
    shop: o.shop, orderId: o.orderId, type: o.type, country: o.country, currency: o.currency, revenue: money(o.revenue), cost: money(o.cost), profit: money(o.profit), margin: pct(o.margin),
    biggestFees: Object.entries(o.feeParts).filter(([, v]) => v < 0).sort((x, y) => x[1] - y[1]).slice(0, 3).map(([k, v]) => `${k} ${round(v)}`),
  });
  return {
    platform: a.platform, label, range: r, rows: cur.total, orders: orders.length, file,
    basis: `马帮利润报表（新）「订单明细」按结算日期；${label}在马帮没有商品维度，要看是哪个商品，拿订单号去平台订单详情查`,
    summary: [...shops.values()].map((s) => ({ ...s, revenue: money(s.revenue), profit: money(s.profit), lossSaleAmount: money(s.lossSaleAmount), feeOnlyLoss: money(s.feeOnlyLoss), margin: pct(s.revenue > 0 ? s.profit / s.revenue : null) })),
    lossOrders: orders.filter((o) => o.kind === '销售亏损').sort((x, y) => x.profit - y.profit).slice(0, top).map(view),
  };
}

async function skuCost(a) {
  const seen = new Map();
  const query = async (value) => {
    if (!seen.has(value)) seen.set(value, await mb().stock(value, 60));
    return seen.get(value);
  };
  const results = [];
  for (const sku of a.skus) {
    const { full, base, multiple } = parseSku(sku);
    let hit = null;
    let used = multiple;
    for (const [value, mult] of base === full ? [[full, 1]] : [[base, multiple], [full, 1]]) {
      hit = (await query(value)).find((x) => x.stockSku.toUpperCase() === value.toUpperCase());
      if (hit) {
        used = mult;
        break;
      }
    }
    if (hit) {
      const cost = Number(hit.cost);
      results.push({
        sku: full, stockSku: hit.stockSku, multiple: used, stockCost: hit.cost, unitCost: Number.isFinite(cost) ? round(cost * used, 4) : null,
        name: hit.name, weight: hit.weight, status: hit.status, available: hit.available,
        note: used > 1 ? `按平台 SKU「*${used}」= ${used} 个库存 SKU 算` : undefined,
      });
      continue;
    }
    // 没有同名的：先列「以它开头」的全部库存 SKU（也就是按前缀查，如 XY-B），没有再按「-」逐段放宽
    let candidates = [];
    let prefix = '';
    for (const p of prefixes(base)) {
      candidates = await query(p);
      prefix = p;
      if (candidates.length) break;
    }
    const exactPrefix = prefix.toUpperCase() === base.toUpperCase();
    results.push({
      sku: full, stockSku: null,
      note: exactPrefix
        ? `没有叫 ${base} 的库存 SKU；下面是以 ${base} 开头的全部 ${candidates.length} 个`
        : `马帮库存 SKU 里没有同名的；下面是以 ${prefix} 开头、名字相近的，确认是哪个再用（平台 SKU 和库存 SKU 的配对以马帮「商品配对」为准）`,
      candidates: candidates.slice(0, exactPrefix ? 60 : 10).map((x) => ({ stockSku: x.stockSku, cost: x.cost, available: x.available, weight: x.weight, name: x.name, status: x.status })),
    });
  }
  return { basis: '马帮库存 SKU 的默认成本（defaultCost，人民币）；只是商品成本，不含平台费用和运费', results };
}

async function profitEstimate(a) {
  if (!a.rows && !a.rows_file) throw new ArgError('rows 和 rows_file 至少填一个');
  const rows = [...(a.rows ?? []), ...(a.rows_file ? rowsFromFile(a.rows_file, a.qty_field ?? 'qty') : [])];
  if (!rows.length) throw new ArgError('没有销量大于 0 的行（rows_file 用的是哪个销量字段？见 qty_field）');
  const days = a.lookback_days ?? 60;
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - days + 1);
  const r = resolveRange({ start: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}` }, today);
  const cur = await fetchAll(a.platform, 'getItem', r);
  const history = aggregateItems(a.platform, cur.rows);
  const results = estimate(history, rows, { shop: a.shop, lowMargin: a.low_margin });
  const totals = new Map();
  for (const x of results) {
    if (x.profit === null) continue;
    const t = totals.get(x.currency) ?? { currency: x.currency, skus: 0, qty: 0, revenue: 0, profit: 0, lossSkus: 0, lossAmount: 0 };
    t.skus += 1;
    t.qty += x.qty;
    t.revenue += x.revenue ?? 0;
    t.profit += x.profit;
    if (x.profit < 0) {
      t.lossSkus += 1;
      t.lossAmount += x.profit;
    }
    totals.set(x.currency, t);
  }
  const top = a.top ?? 20;
  const view = (x) => ({
    ...x, profit: money(x.profit), margin: pct(x.margin),
    history: x.history ? { qty: x.history.qty, unitPrice: money(x.history.unitPrice), unitCost: round(x.history.unitCost, 4), unitProfit: money(x.history.unitProfit), feeRate: pct(x.history.feeRate) } : undefined,
  });
  const label = PLATFORMS[a.platform].label;
  const file = writeNew(`${safeName(label)}_实时利润估算_${ymdNow()}.csv`, toCsv([
    ['sku', 'SKU'], ['matched', '马帮平台SKU'], ['shop', '马帮店铺'], ['currency', '币种'], ['qty', '件数'], ['revenue', '销售额'], ['profit', '估算利润'], [(x) => pct(x.margin), '估算毛利率'],
    [(x) => x.history?.unitPrice, '历史单件销售额'], [(x) => x.history?.unitCost, '历史单件成本'], [(x) => x.history?.unitProfit, '历史单件利润'], [(x) => pct(x.history?.feeRate), '历史费用率'],
    [(x) => x.history?.qty, '历史件数'], ['basis', '算法'], [(x) => x.flags.join('、'), '标记'],
  ], [...results].sort((x, y) => (x.profit ?? Infinity) - (y.profit ?? Infinity))));
  const flagged = (f) => results.filter((x) => x.flags.includes(f));
  const noHistory = flagged('无历史');
  return {
    platform: a.platform, label, inputRows: rows.length, history: { start: r.start, end: r.end, skus: history.length }, file,
    basis: '用马帮利润报表最近 lookback_days 天的结算数据算出每个 SKU 的单件成本和费用率，套到平台的实时销量上；是估算，正式数以马帮结算后的利润报表为准',
    totals: [...totals.values()].map((t) => ({ ...t, revenue: money(t.revenue), profit: money(t.profit), lossAmount: money(t.lossAmount) })),
    losses: flagged('预计亏损').sort((x, y) => x.profit - y.profit).slice(0, top).map(view),
    lowMargin: flagged('预计低毛利').sort((x, y) => (x.margin ?? 0) - (y.margin ?? 0)).slice(0, top).map(view),
    noHistory: { count: noHistory.length, qty: noHistory.reduce((s2, x) => s2 + x.qty, 0), first: noHistory.sort((x, y) => y.qty - x.qty).slice(0, top).map((x) => `${x.sku}×${x.qty}`), hint: '马帮最近没有结算记录的 SKU（新品或长期没卖）：可用 mabang_sku_cost 查商品成本' },
  };
}

const ymdNow = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
};

const num = (v) => {
  const x = Number(String(v ?? '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(x) ? x : null;
};

/** 速卖通半托管等不在马帮订单列表里的：去利润报表的订单明细按订单号找（最近 92 天结算的） */
async function profitByOrderId(id) {
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (MAX_DAYS - 1));
  const r = resolveRange({ start: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}` }, today);
  const p = PLATFORMS.aliexpress;
  const d = await mb().finance(`profit/${p.api}/getOrderDetail`, {
    shopIdList: [], shopManagerIdList: [], dtStart: r.start, dtEnd: r.end, currencyCode: '', platformId: p.id, pageSize: 50, pageIndex: 1,
    choiceFlagList: [], countryCodeList: [], isEvaluation: '', shippingServiceIdList: [], platformOrderId: id, paymentTimeStart: '', paymentTimeEnd: '',
  });
  const rows = (d?.pageData ?? []).filter((x) => String(x.platformOrderId) === id);
  if (!rows.length) return null;
  const [o] = aggregateOrders('aliexpress', rows);
  return {
    source: `马帮利润报表（速卖通订单明细，结算日期 ${r.start} ~ ${r.end}）`, shop: o.shop, type: o.type, country: o.country, currency: o.currency,
    revenue: money(o.revenue), cost: money(o.cost), profit: money(o.profit), margin: pct(o.margin), kind: o.kind,
    biggestFees: Object.entries(o.feeParts).filter(([, v]) => v < 0).sort((x, y) => x[1] - y[1]).slice(0, 3).map(([k, v]) => `${k} ${round(v)}`),
  };
}

async function orderLookup(a) {
  const ids = [...new Set(a.ids.map((x) => x.trim()).filter(Boolean))];
  const bad = ids.filter((x) => !ORDER_ID.test(x));
  if (bad.length) throw new ArgError(`订单号格式不对：${bad.slice(0, 5).join('、')}（只能是字母、数字和 - _ .）`);
  const found = [];
  for (let i = 0; i < ids.length; i += 20) found.push(...(await mb().order(ids.slice(i, i + 20), a.by ?? 'auto')));
  const results = [];
  for (const row of found) {
    const orders = row.hits.map((o) => {
      const profit = num(o.profit);
      return {
        ...o, amount: num(o.amount), amountOriginal: num(o.amountOriginal), profit, profitRate: o.profitRate ? `${o.profitRate}%` : null,
        flags: profit !== null && profit < 0 ? ['亏损'] : [],
      };
    });
    const r = { id: row.value, matchedBy: row.matchedBy || null, orders };
    if (!orders.length && a.profit_fallback !== false) r.profitReport = await profitByOrderId(row.value).catch(() => null);
    r.found = orders.length ? 'orders' : r.profitReport ? 'profitReport' : 'none';
    results.push(r);
  }
  const loss = results.flatMap((r) => r.orders.filter((o) => o.flags.includes('亏损')).map((o) => `${o.orderId}（${o.shop}）利润 ${o.profit} 元`));
  return {
    basis: '马帮订单列表（已完成 / 已发货 / 待处理配货中 / 已作废）按交易号或订单编号查；amount、profit 是马帮按人民币算的订单金额和订单利润（扣了商品成本、运费等），amountOriginal 是平台原币种金额。'
      + '订单列表里没有的（如速卖通半托管）再查利润报表的结算明细。',
    summary: { total: ids.length, inOrders: results.filter((r) => r.found === 'orders').length, inProfitReport: results.filter((r) => r.found === 'profitReport').length, notFound: results.filter((r) => r.found === 'none').map((r) => r.id) },
    lossOrders: loss,
    results,
  };
}

export const TOOLS = [
  {
    name: 'mabang_status',
    description: '检查能不能读马帮：Chrome 连得上、马帮已登录，以及各平台利润报表最近一次计算完成的时间。',
    annotations: RO,
    inputSchema: obj({}),
    run: status,
  },
  {
    name: 'mabang_shop_profit',
    description: '各平台各店铺的盈亏（马帮利润报表，按结算日期）：销量、销售额、商品成本、毛利、毛利率，和上一期对比，标出亏损 / 低毛利 / 毛利率下滑的店铺。'
      + `平台：${PLATFORM_KEYS.map((k) => `${k}=${PLATFORMS[k].label}`).join('，')}。`,
    annotations: RO,
    inputSchema: obj({ platforms: { type: 'array', items: { type: 'string', enum: PLATFORM_KEYS }, description: '不填 = 全部平台' }, shop: shopArg, ...range, low_margin: thresholds.low_margin, margin_drop: thresholds.margin_drop }),
    run: shopProfit,
  },
  {
    name: 'mabang_item_profit',
    description: `每个商品（平台 SKU）的盈亏（马帮利润报表「商品」页，按结算日期）：销量、销售额、商品成本、平台费用、毛利、毛利率、单件毛利，和上一期比；`
      + '列出亏损最多的、低毛利的、毛利率下滑的、只有退款/费用的商品，全部明细写到本机 CSV。'
      + `支持 ${ITEM_PLATFORMS.map((k) => `${k}=${PLATFORMS[k].label}`).join('，')}；速卖通用 mabang_order_profit。`,
    annotations: EXPORT,
    inputSchema: obj({
      platform: { type: 'string', enum: ITEM_PLATFORMS }, shop: shopArg, sku: { type: 'string', description: '只看平台 SKU 包含这段文字的' }, ...range,
      top: { type: 'integer', minimum: 1, maximum: 50, description: '每类列几个（默认 15）' }, ...thresholds,
    }, ['platform']),
    run: itemProfit,
  },
  {
    name: 'mabang_order_profit',
    description: '订单级盈亏（马帮利润报表「订单明细」，按结算日期）：每家店订单数、亏本销售的订单数和金额、只有费用/退款的扣款，列出亏得最多的订单（含最大的几项费用），全部明细写到本机 CSV。'
      + '速卖通在马帮没有商品维度，用这个；要知道是哪个商品，拿订单号去平台订单详情查。',
    annotations: EXPORT,
    inputSchema: obj({ platform: { type: 'string', enum: ORDER_PLATFORMS }, shop: shopArg, ...range, top: { type: 'integer', minimum: 1, maximum: 50, description: '列几个亏损订单（默认 20）' } }, ['platform']),
    run: orderProfit,
  },
  {
    name: 'mabang_order_lookup',
    description: '按交易号 / 订单编号查马帮订单（一次最多 50 个）：店铺、平台、状态、付款 / 发货时间、订单金额（人民币和原币种）、马帮算的订单利润和利润率、运费、重量、物流单号、对应 SKU；利润为负的标「亏损」。'
      + '马帮订单列表里没有的（如速卖通半托管订单）再到利润报表按订单号查结算明细。不返回买家姓名和地址。',
    annotations: RO,
    inputSchema: obj({
      ids: { type: 'array', items: { type: 'string', maxLength: 64 }, minItems: 1, maxItems: 50, description: '交易号或订单编号' },
      by: { type: 'string', enum: ['auto', 'trade', 'order'], description: 'auto = 先按交易号再按订单编号（默认）；trade = 只按交易号；order = 只按订单编号' },
      profit_fallback: { type: 'boolean', description: '订单列表查不到时是否再查利润报表（默认 true）' },
    }, ['ids']),
    run: orderLookup,
  },
  {
    name: 'mabang_sku_cost',
    description: '查马帮库存 SKU 的商品成本（默认成本，人民币）、重量、状态、可用库存。平台 SKU 写成「XXX*5」的按 5 个库存 SKU XXX 算；'
      + '没有同名的就列出以它开头的全部库存 SKU（所以也能按前缀查一批，如 XY-B 查这个款的所有规格和库存），再没有就列名字相近的候选，不会自己猜。'
      + '用于马帮还没有结算记录的新品估利润（只含商品成本，不含平台费用和运费）。',
    annotations: RO,
    inputSchema: obj({ skus: { type: 'array', items: { type: 'string', maxLength: 80 }, minItems: 1, maxItems: 50, description: '平台 SKU 或库存 SKU' } }, ['skus']),
    run: skuCost,
  },
  {
    name: 'mabang_profit_estimate',
    description: '马帮成本和平台实时数据联动：把平台工具拿到的实时销量（rows：每行 sku、qty，最好带 revenue 销售额，和马帮店铺同币种；或 rows_file：平台工具导出的销量 JSON，如 shein_sales 的 file + qty_field=d30）交进来，'
      + '用马帮最近 lookback_days 天结算数据里每个 SKU 的单件成本和费用率估利润，标出预计亏损 / 低毛利；马帮里没有记录的列在 noHistory（可再用 mabang_sku_cost 查成本）。'
      + `支持 ${ITEM_PLATFORMS.join(' / ')}。`,
    annotations: EXPORT,
    inputSchema: obj({
      platform: { type: 'string', enum: ITEM_PLATFORMS }, shop: shopArg,
      rows_file: { type: 'string', description: '平台工具导出的销量 JSON 文件（绝对路径；数组或 { rows: [...] }，比如 shein_sales 返回的 file）；每行取 sku / skuCode / offer_id 和 qty_field 指定的销量' },
      qty_field: { type: 'string', maxLength: 40, description: 'rows_file 里用哪个字段当件数（默认 qty；shein_sales 文件用 d7 或 d30）' },
      top: { type: 'integer', minimum: 1, maximum: 50, description: '每类列几个（默认 20）' },
      rows: {
        type: 'array', minItems: 1, maxItems: 500, description: '平台的实时销量（和 rows_file 二选一或都给）',
        items: obj({ sku: { type: 'string', maxLength: 80, description: '平台 SKU（卖家 SKU）；SHEIN 也可以是 shein_sales 返回的 skuCode（I 开头）；Shopee 也可以是商品 ID' }, qty: { type: 'number', minimum: 0 }, revenue: { type: 'number', description: '销售额（可不填）' } }, ['sku', 'qty']),
      },
      lookback_days: { type: 'integer', minimum: 7, maximum: MAX_DAYS, description: '用最近多少天的马帮结算数据算单件成本（默认 60）' },
      low_margin: thresholds.low_margin,
    }, ['platform']),
    run: profitEstimate,
  },
];

// ---------- 参数校验 ----------

function checkValue(schema, v, path) {
  const fail = (msg) => {
    throw new ArgError(`${path}${msg}`);
  };
  switch (schema.type) {
    case 'string':
      if (typeof v !== 'string') fail(' 要是文字');
      if (schema.enum && !schema.enum.includes(v)) fail(` 只能是 ${schema.enum.join(' / ')}`);
      if (schema.maxLength && v.length > schema.maxLength) fail(` 太长（最多 ${schema.maxLength} 个字符）`);
      return;
    case 'integer':
    case 'number':
      if (typeof v !== 'number' || !Number.isFinite(v) || (schema.type === 'integer' && !Number.isInteger(v))) fail(schema.type === 'integer' ? ' 要是整数' : ' 要是数字');
      if (schema.minimum !== undefined && v < schema.minimum) fail(` 不能小于 ${schema.minimum}`);
      if (schema.maximum !== undefined && v > schema.maximum) fail(` 不能大于 ${schema.maximum}`);
      return;
    case 'boolean':
      if (typeof v !== 'boolean') fail(' 要是 true / false');
      return;
    case 'array':
      if (!Array.isArray(v)) fail(' 要是数组');
      if (schema.minItems && v.length < schema.minItems) fail(` 至少 ${schema.minItems} 项`);
      if (schema.maxItems && v.length > schema.maxItems) fail(` 最多 ${schema.maxItems} 项`);
      v.forEach((x, i) => checkValue(schema.items, x, `${path}[${i}]`));
      return;
    case 'object': {
      if (!v || typeof v !== 'object' || Array.isArray(v)) fail(' 要是对象');
      for (const k of Object.keys(v)) if (!Object.hasOwn(schema.properties, k)) fail(`${path ? '.' : ''}${k} 不认识`);
      for (const k of schema.required ?? []) if (v[k] === undefined) fail(`${path ? '.' : ''}${k} 必填`);
      for (const [k, s] of Object.entries(schema.properties)) if (v[k] !== undefined) checkValue(s, v[k], path ? `${path}.${k}` : k);
      return;
    }
    default:
  }
}

export function checkArgs(tool, args) {
  const a = args ?? {};
  checkValue(tool.inputSchema, a, '');
  if (a.month && (a.start || a.end)) throw new ArgError('month 和 start / end 只能填一种');
  return a;
}

export async function callTool(name, args) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw Object.assign(new Error(`没有这个工具：${name}`), { code: -32602 });
  try {
    const result = await tool.run(checkArgs(tool, args));
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 1) }] };
  } catch (err) {
    const known = err instanceof ArgError || err instanceof InputError || err instanceof MabangError || err instanceof ChromeError || err instanceof ExtensionOffline;
    return { isError: true, content: [{ type: 'text', text: known ? err.message : `出错了：${err.message}` }] };
  }
}

export function closeSession() {
  hub?.stop();
  return mabang?.close();
}

export function startServer(version) {
  // 装了扩展：一启动就开中转，扩展能马上连上
  ensureHub().catch(() => {});
  const send = (m) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
  const handle = async ({ id, method, params }) => {
    switch (method) {
      case 'initialize':
        return { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'mabang-profit-mcp', version }, instructions: INSTRUCTIONS };
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: TOOLS.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })) };
      case 'tools/call':
        return callTool(params?.name, params?.arguments);
      default:
        if (id === undefined) return undefined; // 通知不回复
        throw Object.assign(new Error(`不支持的方法：${method}`), { code: -32601 });
    }
  };
  const rl = createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      send({ id: null, error: { code: -32700, message: 'JSON 解析失败' } });
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      send({ id: null, error: { code: -32600, message: '请求必须是 JSON 对象' } });
      return;
    }
    try {
      const result = await handle(message);
      if (message.id !== undefined && result !== undefined) send({ id: message.id, result });
    } catch (err) {
      if (message.id !== undefined) send({ id: message.id, error: { code: err.code ?? -32603, message: String(err.message ?? err) } });
    }
  });
  // 客户端断开：关掉自己在 Chrome 里开的马帮标签页再退出
  rl.on('close', async () => {
    await Promise.race([closeSession(), new Promise((r) => setTimeout(r, 3000))]).catch(() => {});
    process.exit(0);
  });
}

export { outputDir };
