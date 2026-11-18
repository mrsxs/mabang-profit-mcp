import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ArgError, TOOLS, callTool, checkArgs } from '../lib/mcp.mjs';
import { toCsv, writeNew } from '../lib/output.mjs';
import { APPS, frameUrl, onHost } from '../lib/session.mjs';

const tool = (name) => TOOLS.find((t) => t.name === name);

test('工具都有说明、参数结构和只读标记', () => {
  assert.equal(TOOLS.length, 7);
  for (const t of TOOLS) {
    assert.ok(t.description.length > 20, t.name);
    assert.equal(t.inputSchema.type, 'object');
    assert.equal(t.annotations.destructiveHint, false, t.name);
  }
});

test('checkArgs：枚举、必填、多余字段、嵌套数组', () => {
  assert.throws(() => checkArgs(tool('mabang_item_profit'), {}), /platform 必填/);
  assert.throws(() => checkArgs(tool('mabang_item_profit'), { platform: 'aliexpress' }), /只能是/);
  assert.throws(() => checkArgs(tool('mabang_item_profit'), { platform: 'shein', foo: 1 }), /foo 不认识/);
  assert.throws(() => checkArgs(tool('mabang_item_profit'), { platform: 'shein', month: '2026-10', start: '2026-10-01' }), /只能填一种/);
  assert.throws(() => checkArgs(tool('mabang_profit_estimate'), { platform: 'shein', rows: [{ sku: 'A' }] }), /rows\[0\]\.qty 必填/);
  assert.throws(() => checkArgs(tool('mabang_profit_estimate'), { platform: 'shein', rows: [{ sku: 'A', qty: -1 }] }), /不能小于 0/);
  assert.throws(() => checkArgs(tool('mabang_sku_cost'), { skus: [] }), ArgError);
  assert.deepEqual(checkArgs(tool('mabang_shop_profit'), { platforms: ['shein', 'ozon'], month: '2026-10' }), { platforms: ['shein', 'ozon'], month: '2026-10' });
});

test('订单查询：单号格式不对直接报错，不去查马帮', async () => {
  assert.throws(() => checkArgs(tool('mabang_order_lookup'), { ids: [] }), /至少 1 项/);
  assert.throws(() => checkArgs(tool('mabang_order_lookup'), { ids: ['1'], by: 'x' }), /只能是/);
  const r = await callTool('mabang_order_lookup', { ids: ['1234567890123456', 'a b'] });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /订单号格式不对：a b/);
});

test('callTool：参数错误返回 isError，不抛', async () => {
  const r = await callTool('mabang_item_profit', { platform: 'shein', month: '2026-13' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /YYYY-MM/);
  await assert.rejects(callTool('nope', {}), /没有这个工具/);
});

test('frameUrl / onHost：只认对应子域名的 https 地址', () => {
  assert.equal(frameUrl('https://finance.mabangerp.com/profit-report?key=x', APPS.finance), 'https://finance.mabangerp.com/profit-report?key=x');
  assert.equal(frameUrl('https://finance.mabangerp.com.evil.com/profit-report', APPS.finance), '');
  assert.equal(frameUrl('http://finance.mabangerp.com/profit-report', APPS.finance), '');
  assert.equal(frameUrl('https://aamz.mabangerp.com/index.php?mod=stock.list', APPS.stock), 'https://aamz.mabangerp.com/index.php?mod=stock.list');
  assert.equal(frameUrl('javascript:alert(1)', APPS.stock), '');
  assert.equal(onHost('https://aamz.mabangerp.com/x', 'aamz.mabangerp.com'), true);
  assert.equal(onHost('about:blank', 'aamz.mabangerp.com'), false);
});

test('CSV：带 BOM、转义引号逗号、文字开头的 = 不当公式', () => {
  const csv = toCsv([['a', 'A'], [(r) => r.b * 2, 'B']], [{ a: '=HYPERLINK("x")', b: 1.5 }, { a: 'x,"y"', b: -2 }]);
  assert.ok(csv.startsWith('﻿A,B\r\n'));
  assert.ok(csv.includes(`"'=HYPERLINK(""x"")",3`));
  assert.ok(csv.includes('"x,""y""",-4'));
  // 负数、负百分比照常显示，不加引号
  const neg = toCsv([['a', 'A']], [{ a: '-32.5%' }, { a: '-3' }, { a: '-cmd' }]);
  assert.ok(neg.includes("\r\n-32.5%\r\n-3\r\n'-cmd"));
});

test('writeNew：重名不覆盖', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mb-'));
  const a = writeNew('x.csv', '1', dir);
  const b = writeNew('x.csv', '2', dir);
  assert.notEqual(a, b);
  assert.ok(b.endsWith('x_2.csv'));
  assert.equal(readFileSync(a, 'utf8'), '1');
});

test('rowsFromFile：读 shein_sales 的销量文件，按指定字段取件数', async () => {
  const { rowsFromFile } = await import('../lib/mcp.mjs');
  const { homedir } = await import('node:os');
  const { mkdtempSync: mk, writeFileSync: w } = await import('node:fs');
  const d = mk(join(homedir(), '.mb-test-'));
  const f = join(d, 'sales.json');
  w(f, JSON.stringify({ rows: [{ skuCode: 'I1', d30: 5, d7: 0 }, { skuCode: 'I2', d30: 0 }, { offer_id: 'O-1', qty: 2, revenue: 9 }] }));
  assert.deepEqual(rowsFromFile(f, 'd30'), [{ sku: 'I1', qty: 5 }]);
  assert.deepEqual(rowsFromFile(f), [{ sku: 'O-1', qty: 2, revenue: 9 }]);
  assert.throws(() => rowsFromFile('relative.json'), ArgError);
  assert.throws(() => rowsFromFile('/etc/passwd.json'), ArgError);
  const { rmSync } = await import('node:fs');
  rmSync(d, { recursive: true });
});

test('页面里的查询：马帮说「登录信息已超时，请刷新页面」时返回 retry（调用方会重开页面再试），别的失败照常报错', async () => {
  const { stockFetch } = await import('../lib/page-fns.mjs');
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ text: async () => JSON.stringify({ success: false, message: '操作失败，您的登录信息已超时，请刷新页面后重试' }) });
    assert.deepEqual(await stockFetch({ value: 'A', rows: 5 }), { retry: '操作失败，您的登录信息已超时，请刷新页面后重试' });
    globalThis.fetch = async () => ({ text: async () => JSON.stringify({ success: false, message: '参数错误' }) });
    assert.deepEqual(await stockFetch({ value: 'A', rows: 5 }), { error: '参数错误' });
  } finally {
    globalThis.fetch = realFetch;
  }
});
