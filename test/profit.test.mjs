import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  InputError, PLATFORMS, aggregateItems, aggregateOrders, compareItems, compareShops, estimate, parseSku, prefixes, resolveRange, shopRows, summarizeItems,
} from '../lib/profit.mjs';

const today = new Date(2026, 10, 17); // 2026-11-17

test('resolveRange：整月、当月到今天、自定义、默认 30 天', () => {
  assert.deepEqual(resolveRange({ month: '2026-10' }, today), { start: '2026-10-01', end: '2026-10-31', prevStart: '2026-09-01', prevEnd: '2026-09-30', days: 31 });
  assert.deepEqual(resolveRange({ month: '2026-11' }, today), { start: '2026-11-01', end: '2026-11-17', prevStart: '2026-10-01', prevEnd: '2026-10-17', days: 17 });
  assert.deepEqual(resolveRange({ month: '2026-03' }, today).prevEnd, '2026-02-28');
  assert.deepEqual(resolveRange({ start: '2026-11-01', end: '2026-11-10' }, today), { start: '2026-11-01', end: '2026-11-10', prevStart: '2026-10-22', prevEnd: '2026-10-31', days: 10 });
  assert.deepEqual(resolveRange({}, today), { start: '2026-10-19', end: '2026-11-17', prevStart: '2026-09-19', prevEnd: '2026-10-18', days: 30 });
  // 3 月 31 号查当月：上一期到 2 月底为止
  assert.equal(resolveRange({ month: '2027-03' }, new Date(2027, 2, 31)).prevEnd, '2027-02-28');
  assert.equal(resolveRange({ month: '2027-03' }, new Date(2027, 2, 30)).prevEnd, '2027-02-28');
  assert.equal(resolveRange({ month: '2027-03' }, new Date(2027, 2, 10)).prevEnd, '2027-02-10');
});

test('resolveRange：参数不对报 InputError', () => {
  for (const bad of [{ month: '2026-13' }, { month: '2026-12' }, { start: '2026-02-30' }, { start: '2026-11-10', end: '2026-11-01' }, { start: '2026-01-01', end: '2026-11-01' }, { month: '2026-10', start: '2026-10-01' }]) {
    assert.throws(() => resolveRange(bad, today), InputError, JSON.stringify(bad));
  }
});

// 下面的行是马帮利润报表接口返回的格式（金额改过）；每个平台的「销售额」字段要让 毛利 / 销售额 = 马帮页面上的毛利率
const sheinRows = [
  { shopId: 1, shopName: '店A', currency: 'CNY', qty: 7, refundQty: 0, platformGrantFee: '52.5000', itemCost: '-45.5000', grossMargin: '7.0000', grossMarginRate: '13.33%', skuCode: 'I01a', platformSku: 'TREE-6cm*5', productName: '树 A', skcName: 'sl001', escrowReleaseTime: '2026-10-01' },
  { shopId: 1, shopName: '店A', currency: 'CNY', qty: 3, refundQty: 0, platformGrantFee: '22.5000', itemCost: '-19.5000', grossMargin: '3.0000', grossMarginRate: '13.33%', skuCode: 'I01a', platformSku: 'TREE-6cm*5', productName: '树 A', skcName: 'sl001', escrowReleaseTime: '2026-10-02' },
  { shopId: 1, shopName: '店A', currency: 'CNY', qty: 1, refundQty: 0, platformGrantFee: '1.4500', itemCost: '-8.0000', grossMargin: '-6.5500', grossMarginRate: '-451.72%', skuCode: 'I01b', platformSku: 'TREE-12cm*5', productName: '树 B', skcName: 'sl001', escrowReleaseTime: '2026-10-02' },
  { shopId: 1, shopName: '店A', currency: 'CNY', qty: 0, refundQty: 0, platformGrantFee: '-3.0700', itemCost: '0.0000', grossMargin: '-3.0700', grossMarginRate: '0.00%', skuCode: '-', platformSku: '-', escrowReleaseTime: '2026-10-03' },
];

test('SHEIN：销售额 = 平台拨款，毛利率和马帮一致', () => {
  const p = PLATFORMS.shein;
  assert.equal(Math.round((7 / p.revenue(sheinRows[0])) * 10000) / 100, 13.33);
});

test('Shopee / Ozon / 速卖通：销售额字段和马帮毛利率一致', () => {
  const shopee = { productSellerDiscount: '18.5900', itemCost: '-2.1341', grossMargin: '7.9559', grossMarginRate: '42.80%' };
  assert.equal(Math.round((7.9559 / PLATFORMS.shopee.revenue(shopee)) * 10000) / 100, 42.8);
  const ozon = { salesAndReturns: '19556.4800', mbItemCost: '-4059.1824', grossMargin: '5774.8043', grossMarginRate: '29.53%' };
  assert.equal(Math.round((5774.8043 / PLATFORMS.ozon.revenue(ozon)) * 10000) / 100, 29.53);
  const ae = { tradeGoodsLoan: '4368.9100', tradeLogisticsLoan: '-358.0600', tradeGoodsRefund: '-12.6600', tradeLogisticsRefund: '-7.4700', itemCost: '-1786.4157', grossMargin: '1447.6043', grossMarginRate: '36.27%' };
  assert.equal(Math.round((1447.6043 / PLATFORMS.aliexpress.revenue(ae)) * 10000) / 100, 36.27);
});

test('aggregateItems：同店同 SKU 跨结算日合并，算单件和费用', () => {
  const items = aggregateItems('shein', sheinRows);
  assert.equal(items.length, 3);
  const a = items.find((x) => x.sku === 'TREE-6cm*5');
  assert.equal(a.qty, 10);
  assert.equal(a.revenue, 75);
  assert.equal(a.cost, 65);
  assert.equal(a.profit, 10);
  assert.equal(a.fees, 0);
  assert.equal(a.unitCost, 6.5);
  assert.equal(a.rows, 2);
  assert.equal(a.skc, 'sl001');
  assert.equal(a.skuCode, 'I01a');
  const fee = items.find((x) => x.sku === '');
  assert.equal(fee.profit, -3.07);
  assert.equal(fee.skuCode, '');
});

test('compareItems：亏损、低毛利、只有费用、毛利率下滑', () => {
  const cur = aggregateItems('shein', sheinRows);
  const prev = aggregateItems('shein', [
    { shopId: 1, shopName: '店A', currency: 'CNY', qty: 10, platformGrantFee: '100', itemCost: '-65', grossMargin: '35', platformSku: 'tree-6cm*5' },
  ]);
  const out = compareItems(cur, prev);
  const a = out.find((x) => x.sku === 'TREE-6cm*5');
  assert.deepEqual(a.flags, ['毛利率下滑']); // 13.3%（不低于 10%）；上期 35% → 下滑 21.7 个百分点；SKU 大小写不同也算同一个
  assert.equal(a.prev.qty, 10);
  assert.deepEqual(out.find((x) => x.sku === 'TREE-12cm*5').flags, ['亏损']);
  assert.deepEqual(out.find((x) => x.sku === '').flags, ['没关联商品', '只有退款/费用']);
  const low = compareItems(cur, prev, { lowMargin: 0.2 }).find((x) => x.sku === 'TREE-6cm*5');
  assert.deepEqual(low.flags, ['低毛利', '毛利率下滑']);
  // 件数太少不比毛利率
  assert.deepEqual(compareItems(cur, prev, { minQty: 11 }).find((x) => x.sku === 'TREE-6cm*5').flags, []);
});

test('summarizeItems：按店铺汇总亏损', () => {
  const s = summarizeItems(compareItems(aggregateItems('shein', sheinRows), []));
  assert.equal(s.length, 1);
  assert.equal(s[0].skus, 2);
  assert.equal(s[0].lossSkus, 1);
  assert.equal(Math.round(s[0].lossAmount * 100) / 100, -6.55);
});

test('shopRows / compareShops：用马帮毛利率，标亏损和下滑', () => {
  const cur = shopRows('aliexpress', [
    { shopId: 9, shopName: '店C 半', currency: 'USD', qty: 702, tradeGoodsLoan: '3000', tradeLogisticsLoan: '-70', itemCost: '-625.69', grossMargin: '-1026.37', grossMarginRate: '-35.03%' },
    { shopId: 9, shopName: '店C 半', currency: 'CNY', qty: 0, itemCost: '0', grossMargin: '-27.71', grossMarginRate: '0.00%' },
    { shopId: 8, shopName: '店D', currency: 'USD', qty: 105, tradeGoodsLoan: '450', tradeLogisticsLoan: '-32.5', itemCost: '-160.66', grossMargin: '260.31', grossMarginRate: '62.35%' },
  ]);
  const prev = shopRows('aliexpress', [{ shopId: 8, shopName: '店D', currency: 'USD', qty: 35, tradeGoodsLoan: '500', itemCost: '-188.40', grossMargin: '35.94', grossMarginRate: '8.71%' }]);
  const out = compareShops(cur, prev);
  assert.deepEqual(out[0].flags, ['亏损']);
  assert.equal(out[0].margin, -0.3503);
  assert.deepEqual(out[1].flags, ['只有费用没有销售']);
  assert.deepEqual(out[2].flags, []);
  assert.equal(out[2].prev.margin, 0.0871);
});

test('aggregateOrders：同订单多张结算单合并，区分销售亏损和只有费用', () => {
  const orders = aggregateOrders('aliexpress', [
    { shopId: 1, shopName: '店E', currency: 'USD', platformOrderId: 'A1', tradeGoodsLoan: '10', tradeLogisticsLoan: '-2', itemCost: '-9', grossMargin: '-3', affiliateCommission: '-2', choiceFlagName: 'POP订单' },
    { shopId: 1, shopName: '店E', currency: 'USD', platformOrderId: 'A1', tradeGoodsLoan: '0', itemCost: '0', grossMargin: '-1', coinsMarketingFee: '-1' },
    { shopId: 1, shopName: '店E', currency: 'USD', platformOrderId: 'A2', tradeLogisticsLoan: '-1.48', itemCost: '0', grossMargin: '-1.48' },
    { shopId: 1, shopName: '店E', currency: 'USD', platformOrderId: 'A3', tradeGoodsLoan: '20', itemCost: '-5', grossMargin: '12' },
  ]);
  const a1 = orders.find((o) => o.orderId === 'A1');
  assert.equal(a1.profit, -4);
  assert.equal(a1.kind, '销售亏损');
  assert.deepEqual(a1.feeParts, { tradeLogisticsLoan: -2, affiliateCommission: -2, coinsMarketingFee: -1 });
  assert.equal(orders.find((o) => o.orderId === 'A2').kind, '只有费用/退款');
  assert.equal(orders.find((o) => o.orderId === 'A3').kind, '盈利');
});

test('parseSku / prefixes', () => {
  assert.deepEqual(parseSku('TREE-6cm*5'), { full: 'TREE-6cm*5', base: 'TREE-6cm', multiple: 5 });
  assert.deepEqual(parseSku(' GRV-2 '), { full: 'GRV-2', base: 'GRV-2', multiple: 1 });
  assert.deepEqual(parseSku('LP-231-10CM-3 light-white*1'), { full: 'LP-231-10CM-3 light-white*1', base: 'LP-231-10CM-3 light-white', multiple: 1 });
  assert.deepEqual(prefixes('TREE-6cm'), ['TREE-6cm', 'TREE']);
  assert.deepEqual(prefixes('LP-227-0603-G'), ['LP-227-0603-G', 'LP-227-0603', 'LP-227', 'LP']);
  assert.deepEqual(prefixes('A'), []);
});

test('estimate：有历史按费用率和单件成本估，没历史标出来', () => {
  const history = aggregateItems('shein', [
    ...sheinRows,
    { shopId: 2, shopName: '店B', currency: 'CNY', qty: 2, platformGrantFee: '20', itemCost: '-13', grossMargin: '7', platformSku: 'TREE-6cm*5' },
  ]);
  const out = estimate(history, [
    { sku: 'tree-6cm*5', qty: 4, revenue: 30 },
    { sku: 'TREE-12cm*5', qty: 2 },
    { sku: 'NEW-1', qty: 5, revenue: 50 },
  ], { shop: '店A' });
  const a = out[0];
  assert.equal(a.shop, '店A'); // 指定店铺只用这家店的历史
  assert.equal(a.history.unitCost, 6.5);
  assert.equal(a.history.feeRate, 0);
  assert.equal(a.profit, 30 - 4 * 6.5);
  assert.deepEqual(out[1].flags, ['预计亏损']);
  assert.equal(out[1].profit, -13.1);
  assert.equal(out[2].profit, null);
  assert.deepEqual(out[2].flags, ['无历史']);
  // 不指定店：两家店同币种合并
  const pooled = estimate(history, [{ sku: 'TREE-6cm*5', qty: 1 }])[0];
  assert.equal(pooled.history.qty, 12);
  assert.equal(pooled.shop, '店A、店B');
});

test('estimate：同 SKU 在不同币种的店要求指定店铺', () => {
  const history = aggregateItems('shopee', [
    { shopId: 1, shopName: '店M', currency: 'MYR', qty: 2, productSellerDiscount: '20', itemCost: '-5', grossMargin: '8', platformSku: 'X' },
    { shopId: 2, shopName: '店T', currency: 'TWD', qty: 1, productSellerDiscount: '200', itemCost: '-50', grossMargin: '90', platformSku: 'X' },
  ]);
  const [r] = estimate(history, [{ sku: 'X', qty: 1 }]);
  assert.equal(r.profit, null);
  assert.match(r.basis, /多个币种/);
  assert.equal(estimate(history, [{ sku: 'X', qty: 1 }], { shop: '店T' })[0].profit, 90);
});

test('阈值没传（undefined）时用默认值', () => {
  const items = aggregateItems('shein', [{ shopId: 1, shopName: 'a', currency: 'CNY', qty: 5, platformGrantFee: '100', itemCost: '-95', grossMargin: '5', platformSku: 'LOW' }]);
  assert.deepEqual(compareItems(items, [], { lowMargin: undefined, marginDrop: undefined, minQty: undefined })[0].flags, ['低毛利']);
  const shops = shopRows('shein', [{ shopId: 1, shopName: 'a', currency: 'CNY', qty: 5, platformGrantFee: '100', itemCost: '-95', grossMargin: '5', grossMarginRate: '5.00%' }]);
  assert.deepEqual(compareShops(shops, [], { lowMargin: undefined })[0].flags, ['低毛利']);
  assert.deepEqual(estimate(items, [{ sku: 'LOW', qty: 1 }], { lowMargin: undefined })[0].flags, ['预计低毛利']);
});

test('没有销售额时毛利率为空（马帮给的 0.00% 不用）', () => {
  const [x] = shopRows('aliexpress', [{ shopId: 1, shopName: 'a', currency: 'CNY', qty: 0, itemCost: '0', grossMargin: '-77.97', grossMarginRate: '0.00%' }]);
  assert.equal(x.margin, null);
});

test('estimate：SHEIN 用 skuCode 也能对上', () => {
  const history = aggregateItems('shein', sheinRows);
  const [r] = estimate(history, [{ sku: 'i01b', qty: 2 }]);
  assert.equal(r.matched, 'TREE-12cm*5');
  assert.equal(r.profit, -13.1);
});
