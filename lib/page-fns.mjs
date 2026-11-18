// 在马帮页面里执行的函数（CDP 的 Runtime.evaluate 或扩展的 chrome.scripting.executeScript），必须自包含、不引用外面的变量。
// MCP（lib/session.mjs）和马帮利润助手扩展（extension/，打包时复制这个文件）共用。

// ---- 共用的常量和校验（不在页面里执行） ----

const MAIN = 'https://www.mabangerp.com/index.php?mod=';
export const APPS = {
  finance: { name: '利润报表', host: 'finance.mabangerp.com', path: '/profit-report', mark: 'multiplatformfinance.profit-report', entry: `${MAIN}multiplatformfinance.profit-report` },
  stock: { name: '库存 SKU', host: 'aamz.mabangerp.com', path: '/index.php', mark: 'stock.list', entry: `${MAIN}stock.list&searchStatus=3` },
  // 订单列表就在主站页面里（没有子域名 iframe），开这个页直接用
  order: { name: '订单', host: 'www.mabangerp.com', path: '/index.php', mark: 'mod=order', entry: `${MAIN}order.list`, direct: true },
};
/** 订单号 / 交易号：字母数字和 - _ . 组成，最长 64 */
export const ORDER_ID = /^[A-Za-z0-9][\w.-]{0,63}$/;

/** 只允许这几个只读查询（利润报表：店铺 / 商品 / 订单明细、计算状态） */
export const FINANCE_PATH = /^(profit\/[a-z]+\/(getShop|getItem|getOrderDetail)|compute\/status\/\d+)$/;

/** 页面上读来的 iframe 地址只认对应子域名的 https 地址和路径（页面上的地址不直接用） */
export function frameUrl(src, app) {
  try {
    const u = new URL(src);
    return u.protocol === 'https:' && u.hostname === app.host && u.pathname === app.path ? u.href : '';
  } catch {
    return '';
  }
}

// ---- 下面的函数在马帮页面里执行 ----

/** 主站页面：找子域名 iframe；没登录时主站会跳到登录页或官网首页 */
export function findFrame({ host, mark }) {
  const f = Array.from(document.querySelectorAll('iframe')).find((x) => String(x.src || '').startsWith(`https://${host}/`));
  const login = !location.href.includes(mark) || /mod=main\.login/.test(location.href) || Boolean(document.querySelector('input[type="password"]'));
  return { src: f ? f.src : '', login, state: document.readyState };
}

export function appReady(host) {
  const loginPage = /mod=main\.login|\/index\.htm/.test(location.href) || Boolean(document.querySelector('input[type="password"]'));
  const ok = location.hostname === host && document.readyState === 'complete' && !loginPage;
  return { ok, login: loginPage, token: host !== 'finance.mabangerp.com' || Boolean(localStorage.getItem('freeToken') && localStorage.getItem('key')) };
}

/** 利润报表页面：用页面自己存的登录令牌调利润报表的查询接口 */
export async function financeFetch({ path, body }) {
  const token = localStorage.getItem('freeToken');
  const key = localStorage.getItem('key');
  if (!token || !key) return { retry: '页面里还没有登录令牌' };
  let res;
  let text;
  try {
    res = await fetch(`https://mas-oapi.mabangerp.com/mas-report-profit-service/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, key, projectid: 'erp', language: 'cn', timezone: 'UTC+8', 'cluster-id': '1' },
      body: JSON.stringify(body),
    });
    text = await res.text();
  } catch (e) {
    // 令牌过期时接口不带跨域头，浏览器只报 Failed to fetch
    return { retry: `请求失败：${String(e && e.message ? e.message : e)}` };
  }
  let d;
  try {
    d = JSON.parse(text);
  } catch {
    return { error: `马帮返回的不是 JSON（HTTP ${res.status}）` };
  }
  if (res.status === 401 || d.code === 401) return { retry: '登录令牌过期' };
  if (!d.success) {
    const msg = String(d.message || `code ${d.code}`);
    return /登录信息已(过期|超时)|请刷新页面|请先登录|未登录|token/i.test(msg) ? { retry: msg } : { error: msg };
  }
  return { data: d.data };
}

/** 库存 SKU 页面（aamz）：库存 SKU 列表页自己用的查询（库存 SKU 开头是…），只留要用的字段 */
export async function stockFetch({ value, rows }) {
  const body = new URLSearchParams({ searchKey: 'Stock_stockSku', operate: 'likeStart', 'search-content': '库存SKU', searchValue: value, status: '', showstart: '1', page: '1', rowsPerPage: String(rows) });
  let d;
  try {
    const res = await fetch('/index.php?mod=stock.getStockList', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
      body,
      credentials: 'same-origin',
    });
    d = JSON.parse(await res.text());
  } catch {
    return { retry: '马帮库存页没返回数据' };
  }
  if (!d || d.success === false) {
    // 页面是旧登录时打开的：马帮提示「登录信息已超时，请刷新页面」→ 让调用方重开页面再试
    const msg = String((d && d.message) || '马帮库存查询失败');
    return /登录信息已(过期|超时)|请刷新页面|请先登录|未登录/.test(msg) ? { retry: msg } : { error: msg };
  }
  const t = (v, max) => String(v ?? '').trim().slice(0, max);
  return {
    rows: (Array.isArray(d.stockData) ? d.stockData : []).map((r) => ({
      stockSku: t(r.stockSku, 80), name: t(r.nameCN, 120), cost: t(r.defaultCost, 20), purchasePrice: t(r.purchasePrice, 20),
      weight: t(r.weight, 20), status: t(r.statusText, 20), available: t(r.stockSkuAvailableInventory, 20), mainSku: t(r.salesSkuNew, 80),
    })),
  };
}

/**
 * 主站订单页：按交易号 / 订单编号查订单（订单列表页自己用的 order.oTc）。马帮按标签页分开存订单，
 * 依次在 已完成 / 已发货 / 全部（待处理、配货中）/ 已作废 里找，找到就停；by=auto 先按交易号、再按订单编号。
 * 只留要用的字段（不带买家姓名、地址）。
 */
export async function orderFetch({ values, by }) {
  if (location.hostname !== 'www.mabangerp.com') return { retry: '不在马帮主站页面' };
  const TABS = [['5', '4'], ['4', '3'], ['222', ''], ['6', '5']];
  const KEYS = by === 'order' ? ['a.platformOrderId'] : by === 'trade' ? ['a.salesRecordNumber'] : ['a.salesRecordNumber', 'a.platformOrderId'];
  const t = (v, max = 80) => {
    const s = String(v ?? '').trim();
    return s === '--' || s === 'null' ? '' : s.slice(0, max);
  };
  const pick = (o) => ({
    orderId: t(o.platformOrderId), tradeId: t(o.salesRecordNumber), shop: t(o.shopIdText, 40), platform: t(o.platformIdText, 20), status: t(o.showOrderStatusText, 20),
    paidTime: t(o.paidTime, 20), shipTime: t(o.expressTime, 20), amount: t(o.orderFee, 20), amountOriginal: t(o.orderFee_original, 20), currency: t(o.currencyId, 8),
    profit: t(o.profit, 20), profitRate: t(o.profit_rate, 12), shippingCost: t(o.shippingCost, 24), weight: t(o.orderWeight, 12),
    trackNumber: t(o.trackNumber, 60), shippingService: t(o.shippingService, 60), country: t(o.countryCodeCn, 20), skus: t(o.order_combosku_data, 300),
  });
  const rows = [];
  for (const value of values) {
    let hits = [];
    let matchedBy = '';
    search: for (const key of KEYS) {
      for (const [tabId, status] of TABS) {
        const body = new URLSearchParams({
          'OrderPlus.isNewOrder': '1', isshowordercombosku: '1', 'Order.orderStatus': status, 'OrderSearch.fuzzySearchKey': 'Order.platformOrderId', OrderSearchFuSKey: key,
          'OrderSearch.fuzzySearchValue': value, page: '1', rowsPerPage: '20', Order_isCloud: '2', m: 'order', a: 'list', isNewOrderPage: '1', post_tableBase: '1', tabId,
        });
        let d;
        try {
          const res = await fetch('/index.php?mod=order.oTc', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' }, body, credentials: 'same-origin' });
          d = JSON.parse(await res.text());
        } catch {
          return { retry: '马帮订单页没返回数据' };
        }
        if (!d || d.success === false) {
          const msg = String((d && d.message) || '马帮订单查询失败');
          return /登录信息已(过期|超时)|请刷新页面|请先登录|未登录/.test(msg) ? { retry: msg } : { error: msg };
        }
        const list = Array.isArray(d.orderDataList) ? d.orderDataList : [];
        if (list.length) {
          hits = list.slice(0, 10).map(pick);
          matchedBy = key === 'a.salesRecordNumber' ? '交易号' : '订单编号';
          break search;
        }
      }
    }
    rows.push({ value, matchedBy, hits });
  }
  return { rows };
}
