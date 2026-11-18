// 马帮「利润报表(新)」的数据整理：各平台字段对齐、按商品汇总、和上一期比、标出亏损 / 低毛利 / 毛利率下滑；
// 再用马帮的历史单件成本和费用率，给平台的实时销量估利润。全是纯函数，不连网。

/** 用户给的参数不对（日期格式、范围等） */
export class InputError extends Error {}

const n = (v) => {
  const x = Number(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(x) ? x : 0;
};
const rate = (v) => {
  const s = String(v ?? '').trim();
  return /^-?\d+(\.\d+)?%$/.test(s) ? Math.round(Number(s.slice(0, -1)) * 10_000) / 1_000_000 : null;
};
export const round = (x, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

/**
 * 平台：马帮利润报表里的平台 ID、接口名，和「销售额」用哪个字段（毛利率 = 毛利 / 销售额，和马帮页面上的毛利率一致）。
 * items：利润报表有没有「商品」维度（速卖通只有店铺和订单明细）。
 */
export const PLATFORMS = {
  shopee: { label: 'Shopee', id: 17, api: 'shopee', items: true, orders: false, revenue: (r) => n(r.productSellerDiscount), cost: (r) => n(r.itemCost) },
  aliexpress: {
    label: '速卖通', id: 135, api: 'aliexpress', items: false, orders: true,
    revenue: (r) => n(r.tradeGoodsLoan) + n(r.tradeLogisticsLoan) + n(r.tradeGoodsRefund) + n(r.tradeLogisticsRefund),
    cost: (r) => n(r.itemCost),
  },
  ozon: { label: 'Ozon', id: 90, api: 'ozon', items: true, orders: false, revenue: (r) => n(r.salesAndReturns), cost: (r) => n(r.mbItemCost) },
  shein: { label: 'SHEIN 全托管', id: 166, api: 'sheinobm', items: true, orders: false, revenue: (r) => n(r.platformGrantFee), cost: (r) => n(r.itemCost) },
  shein_semi: { label: 'SHEIN 半托管', id: 160, api: 'sheinsemi', items: false, orders: false, revenue: null, cost: (r) => n(r.itemCost) },
  temu: { label: 'Temu 全托管', id: 132, api: 'temufull', items: false, orders: false, revenue: null, cost: (r) => n(r.itemCost) },
};
export const PLATFORM_KEYS = Object.keys(PLATFORMS);

/** 没核对过销售额字段的平台：用马帮自己的毛利率反推（毛利 / 毛利率） */
function revenueOf(p, r) {
  if (p.revenue) return p.revenue(r);
  const k = rate(r.grossMarginRate);
  return k ? n(r.grossMargin) / k : 0;
}

export const DEFAULTS = { lowMargin: 0.1, marginDrop: 0.1, minQty: 3 };
/** 合并阈值：没传（undefined）的用默认值 */
const withDefaults = (opts = {}) => ({ ...DEFAULTS, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined && v !== null)) });

// ---------- 日期 ----------

const DAY = 86_400_000;
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const parseDay = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s))) return null;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d ? dt : null;
};
const addDays = (d, k) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + k);
const span = (a, b) => Math.round((b - a) / DAY) + 1;
export const MAX_DAYS = 92;

/**
 * 统计区间（马帮按「结算日期」）和对比的上一期：
 * - month=YYYY-MM：整月；当月还没过完就到今天，上一期取上个月同样的天数（1 号到同一天）
 * - start/end：上一期是紧挨着的前面同样天数
 * - 都不填：最近 30 天（含今天）
 */
export function resolveRange({ month, start, end } = {}, today = new Date()) {
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  let s;
  let e;
  let ps;
  let pe;
  if (month) {
    if (start || end) throw new InputError('month 和 start / end 只能填一种');
    const m = /^(\d{4})-(\d{2})$/.exec(String(month));
    if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw new InputError('month 格式是 YYYY-MM，比如 2026-10');
    s = new Date(Number(m[1]), Number(m[2]) - 1, 1);
    if (s > t) throw new InputError('month 不能是将来的月份');
    const last = new Date(s.getFullYear(), s.getMonth() + 1, 0);
    e = last < t ? last : t;
    ps = new Date(s.getFullYear(), s.getMonth() - 1, 1);
    const prevLast = new Date(s.getFullYear(), s.getMonth(), 0);
    pe = e.getTime() === last.getTime() ? prevLast : new Date(Math.min(addDays(ps, e.getDate() - 1).getTime(), prevLast.getTime()));
  } else if (start || end) {
    s = parseDay(start);
    e = parseDay(end ?? ymd(t));
    if (!s || !e) throw new InputError('start / end 格式是 YYYY-MM-DD');
    if (s > e) throw new InputError('start 不能晚于 end');
    pe = addDays(s, -1);
    ps = addDays(pe, -(span(s, e) - 1));
  } else {
    e = t;
    s = addDays(t, -29);
    pe = addDays(s, -1);
    ps = addDays(pe, -29);
  }
  if (span(s, e) > MAX_DAYS) throw new InputError(`一次最多查 ${MAX_DAYS} 天`);
  return { start: ymd(s), end: ymd(e), prevStart: ymd(ps), prevEnd: ymd(pe), days: span(s, e) };
}

// ---------- 店铺 ----------

/** 店铺汇总行：同一家店不同币种分开（速卖通半托管的人民币费用单独一行） */
export function shopRows(platform, rows) {
  const p = PLATFORMS[platform];
  return (rows ?? []).map((r) => {
    const revenue = revenueOf(p, r);
    const profit = n(r.grossMargin);
    return {
      shop: String(r.shopName ?? ''), shopId: r.shopId, currency: String(r.currency ?? ''), manager: r.shopManagerName ?? '',
      qty: n(r.qty), refundQty: n(r.refundQty), revenue, cost: -p.cost(r), profit,
      margin: revenue > 0 ? rate(r.grossMarginRate) ?? profit / revenue : null,
    };
  });
}

const shopKey = (x) => `${x.shopId}|${x.currency}`;

export function compareShops(cur, prev, opts = {}) {
  const o = withDefaults(opts);
  const pm = new Map(prev.map((x) => [shopKey(x), x]));
  return cur.map((x) => {
    const p = pm.get(shopKey(x));
    const flags = [];
    if (x.profit < 0 && x.revenue > 0) flags.push('亏损');
    else if (x.revenue > 0 && x.margin !== null && x.margin < o.lowMargin) flags.push('低毛利');
    if (x.revenue <= 0 && x.profit < 0) flags.push('只有费用没有销售');
    if (p && p.margin !== null && x.margin !== null && p.revenue > 0 && x.revenue > 0 && p.margin - x.margin >= o.marginDrop) flags.push('毛利率下滑');
    return { ...x, prev: p ? { qty: p.qty, revenue: p.revenue, profit: p.profit, margin: p.margin } : null, flags };
  });
}

// ---------- 商品 ----------

const itemKey = (x) => `${x.shopId}|${x.currency}|${x.sku.toUpperCase()}`;

/** 利润报表「商品」页是按 商品 × 结算日 一行：按 店铺 + 币种 + 平台 SKU 汇总 */
export function aggregateItems(platform, rows) {
  const p = PLATFORMS[platform];
  const map = new Map();
  for (const r of rows ?? []) {
    const raw = String(r.platformSku ?? '').trim();
    const sku = raw === '-' ? '' : raw;
    const base = { shopId: r.shopId, currency: String(r.currency ?? ''), sku };
    const key = itemKey(base);
    let a = map.get(key);
    if (!a) {
      a = { shop: String(r.shopName ?? ''), ...base, name: '', itemId: '', skc: '', skuCode: '', qty: 0, refundQty: 0, revenue: 0, cost: 0, profit: 0, rows: 0 };
      map.set(key, a);
    }
    a.name ||= String(r.itemName ?? r.productName ?? '').slice(0, 150);
    a.itemId ||= String(r.platformItemId ?? '');
    a.skc ||= String(r.skcName ?? '');
    a.skuCode ||= r.skuCode && r.skuCode !== '-' ? String(r.skuCode) : '';
    a.qty += n(r.qty);
    a.refundQty += n(r.refundQty);
    a.revenue += revenueOf(p, r);
    a.cost += -p.cost(r);
    a.profit += n(r.grossMargin);
    a.rows += 1;
  }
  return [...map.values()].map(finishItem);
}

function finishItem(a) {
  const fees = a.revenue - a.cost - a.profit; // 平台佣金、运费、退款等马帮算进去的其他扣项
  return {
    ...a,
    fees,
    margin: a.revenue > 0 ? a.profit / a.revenue : null,
    unitPrice: a.qty > 0 ? a.revenue / a.qty : null,
    unitCost: a.qty > 0 ? a.cost / a.qty : null,
    unitProfit: a.qty > 0 ? a.profit / a.qty : null,
  };
}

export function compareItems(cur, prev, opts = {}) {
  const o = withDefaults(opts);
  const pm = new Map((prev ?? []).map((x) => [itemKey(x), x]));
  return cur.map((x) => {
    const p = pm.get(itemKey(x));
    const flags = [];
    if (!x.sku) flags.push('没关联商品');
    if (x.qty > 0 && x.profit < 0) flags.push('亏损');
    else if (x.qty > 0 && x.margin !== null && x.margin < o.lowMargin) flags.push('低毛利');
    if (x.qty <= 0 && x.profit < 0) flags.push('只有退款/费用');
    if (p && x.qty >= o.minQty && p.qty >= o.minQty && x.margin !== null && p.margin !== null && p.margin - x.margin >= o.marginDrop) flags.push('毛利率下滑');
    return { ...x, prev: p ? { qty: p.qty, revenue: p.revenue, profit: p.profit, margin: p.margin } : null, flags };
  });
}

/** 按店铺 + 币种汇总商品结果 */
export function summarizeItems(items) {
  const map = new Map();
  for (const x of items) {
    const k = `${x.shop}|${x.currency}`;
    let s = map.get(k);
    if (!s) map.set(k, (s = { shop: x.shop, currency: x.currency, skus: 0, qty: 0, revenue: 0, profit: 0, lossSkus: 0, lossAmount: 0, lowMarginSkus: 0, droppedSkus: 0 }));
    s.skus += x.sku ? 1 : 0;
    s.qty += x.qty;
    s.revenue += x.revenue;
    s.profit += x.profit;
    if (x.flags.includes('亏损')) {
      s.lossSkus += 1;
      s.lossAmount += x.profit;
    }
    if (x.flags.includes('低毛利')) s.lowMarginSkus += 1;
    if (x.flags.includes('毛利率下滑')) s.droppedSkus += 1;
  }
  return [...map.values()].map((s) => ({ ...s, margin: s.revenue > 0 ? s.profit / s.revenue : null }));
}

// ---------- 订单（速卖通） ----------

/** 订单明细是 订单 × 结算单 一行：按 店铺 + 订单号 汇总 */
export function aggregateOrders(platform, rows) {
  const p = PLATFORMS[platform];
  const map = new Map();
  for (const r of rows ?? []) {
    const id = String(r.platformOrderId ?? '').trim();
    const key = `${r.shopId}|${r.currency}|${id || '-'}`;
    let a = map.get(key);
    if (!a) {
      a = { shop: String(r.shopName ?? ''), shopId: r.shopId, currency: String(r.currency ?? ''), orderId: id === '-' ? '' : id, type: String(r.choiceFlagName ?? ''), country: String(r.countryName ?? ''), revenue: 0, goods: 0, cost: 0, profit: 0, feeParts: {} };
      map.set(key, a);
    }
    a.revenue += revenueOf(p, r);
    a.goods += n(r.tradeGoodsLoan);
    a.cost += -p.cost(r);
    a.profit += n(r.grossMargin);
    for (const [k, v] of Object.entries(r)) {
      if (/(Fee|Commission|Refund|Withhold|Duty|Tax|Amount|Loan|Cost|Freight|Income|Expend)$/.test(k) && !['platformGrantFee', 'tradeGoodsLoan', 'itemCost'].includes(k) && n(v) !== 0) a.feeParts[k] = (a.feeParts[k] ?? 0) + n(v);
    }
  }
  return [...map.values()].map((a) => ({ ...a, margin: a.revenue > 0 ? a.profit / a.revenue : null, kind: a.goods > 0 ? (a.profit < 0 ? '销售亏损' : '盈利') : a.profit < 0 ? '只有费用/退款' : '其他' }));
}

// ---------- 用历史单件利润估实时利润 ----------

/** 平台 SKU「XXX*5」= 5 个库存 SKU「XXX」（马帮配对的写法）；返回 { base, multiple } */
export function parseSku(sku) {
  const s = String(sku ?? '').trim();
  const m = /^(.+?)\*(\d{1,5})$/.exec(s);
  return m ? { full: s, base: m[1].trim(), multiple: Number(m[2]) } : { full: s, base: s, multiple: 1 };
}

/** 库存 SKU 找不到时的候选前缀：按「-」逐段截短（TREE-6cm → TREE），不短于 2 个字符 */
export function prefixes(base) {
  const out = [];
  let s = String(base ?? '').trim();
  while (s.length >= 2 && !out.includes(s)) {
    out.push(s);
    const i = s.lastIndexOf('-');
    if (i < 2) break;
    s = s.slice(0, i);
  }
  return out;
}

/**
 * 估利润：rows 是平台的实时销量 [{ sku, qty, revenue? }]（revenue 要和马帮店铺同币种）。
 * 有马帮历史的：给了 revenue 用「revenue × (1 − 历史费用率) − 件数 × 历史单件成本」，没给用「件数 × 历史单件利润」；
 * 没有历史的标出来，让调用方用 mabang_sku_cost 查成本。
 */
export function estimate(history, rows, { shop, lowMargin } = {}) {
  if (lowMargin === undefined || lowMargin === null) lowMargin = DEFAULTS.lowMargin;
  // 平台 SKU、SHEIN 的 skuCode（I 开头，shein_sales 返回的就是它）、平台商品 ID 都能对上
  const bySku = new Map();
  for (const h of history) {
    if (h.qty <= 0) continue;
    for (const id of new Set([h.sku, h.skuCode, h.itemId].filter(Boolean).map((x) => x.toUpperCase()))) {
      if (!bySku.has(id)) bySku.set(id, []);
      bySku.get(id).push(h);
    }
  }
  const want = shop ? String(shop).toLowerCase() : '';
  const results = rows.map((row) => {
    const sku = String(row.sku ?? '').trim();
    const qty = n(row.qty);
    const revenue = row.revenue === undefined || row.revenue === null ? null : n(row.revenue);
    let cands = bySku.get(sku.toUpperCase()) ?? [];
    if (want) {
      const same = cands.filter((h) => h.shop.toLowerCase() === want || String(h.shopId) === want);
      if (same.length) cands = same;
    }
    const currencies = [...new Set(cands.map((h) => h.currency))];
    if (!cands.length || currencies.length > 1) {
      return { sku, qty, revenue, basis: cands.length ? `马帮里这个 SKU 在多个币种的店铺都有（${currencies.join('、')}），请用 shop 指定店铺` : '马帮没有这个 SKU 的结算记录（用 mabang_sku_cost 查商品成本）', profit: null, flags: ['无历史'] };
    }
    const h = cands.reduce((a, b) => ({ qty: a.qty + b.qty, revenue: a.revenue + b.revenue, cost: a.cost + b.cost, profit: a.profit + b.profit }), { qty: 0, revenue: 0, cost: 0, profit: 0 });
    const unitCost = h.cost / h.qty;
    const feeRate = h.revenue > 0 ? (h.revenue - h.cost - h.profit) / h.revenue : null;
    let profit;
    let basis;
    if (revenue !== null && feeRate !== null) {
      profit = revenue * (1 - feeRate) - qty * unitCost;
      basis = '销售额 × (1 − 马帮历史费用率) − 件数 × 马帮历史单件成本';
    } else {
      profit = qty * (h.profit / h.qty);
      basis = '件数 × 马帮历史单件利润';
    }
    const margin = revenue ? profit / revenue : h.revenue > 0 ? h.profit / h.revenue : null;
    const flags = [];
    if (profit < 0) flags.push('预计亏损');
    else if (margin !== null && margin < lowMargin) flags.push('预计低毛利');
    return {
      sku, matched: [...new Set(cands.map((c) => c.sku))].join('、'), qty, revenue, currency: cands[0].currency, shop: cands.map((c) => c.shop).join('、'),
      history: { qty: h.qty, unitPrice: h.revenue / h.qty, unitCost, unitProfit: h.profit / h.qty, feeRate },
      profit, margin, basis, flags,
    };
  });
  return results;
}
