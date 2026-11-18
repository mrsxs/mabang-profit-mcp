# mabang-profit-mcp

MCP server for **Mabang ERP (马帮)** cost & profit data. It reads the Mabang *profit report* (shop / product / order level, settled data), stock-SKU costs and orders **inside your own logged-in Mabang pages** — credentials never leave the browser — and joins them with live platform sales to flag products that sell at a loss. Read-only, zero dependencies, Node ≥ 22.

马帮成本 × 平台数据 → 商品盈亏。

平台后台只有经营和流量数据，成本和利润在马帮 ERP。这个 MCP 读马帮「利润报表(新)」和库存 SKU 成本，再和各平台的实时销量对上，及时找出亏钱、毛利太低、毛利率在变差的店铺和商品。Accio「商品盈亏专家」在用。只读，零依赖，Node ≥ 22。

## 工具

| 工具 | 内容 |
|---|---|
| `mabang_status` | 马帮能不能读、各平台利润报表最近一次算完的时间 |
| `mabang_shop_profit` | 各平台各店铺：销售额、商品成本、毛利、毛利率，和上一期比，标亏损 / 低毛利 / 毛利率下滑 |
| `mabang_item_profit` | 每个平台 SKU 的盈亏（SHEIN 全托管 / Ozon / Shopee），亏损、低毛利、下滑、只有退款的清单；全部明细写 CSV |
| `mabang_order_profit` | 速卖通（马帮只有订单级）：亏本订单和最大的几项费用；全部明细写 CSV |
| `mabang_order_lookup` | 按交易号 / 订单编号查订单（≤50 个）：状态、付款 / 发货时间、订单金额、马帮订单利润和利润率、运费、重量、物流单号、SKU；订单列表里没有的（速卖通半托管）改查利润报表结算明细 |
| `mabang_sku_cost` | 库存 SKU 默认成本、重量、可用库存（平台 SKU「XXX*5」= 5 个库存 SKU XXX；传前缀如 XY-B 列出整个款；对不上就列候选） |
| `mabang_profit_estimate` | **联动**：平台实时销量（rows 或 rows_file，如 shein_sales 的文件 + qty_field=d30）× 马帮最近 N 天的单件成本和费用率 → 估算利润，标预计亏损；明细写 CSV |

马帮利润报表按**结算日期**统计；金额是店铺原币种，不同币种不相加。毛利率 = 毛利 / 销售额，和马帮页面一致（各平台「销售额」字段见 `lib/profit.mjs` 的 `PLATFORMS`，单测里用真实行核对过）。CSV 默认写到 `~/Documents/马帮利润/`（`MABANG_OUTPUT_DIR` 可改）。

## 怎么连马帮（不碰登录凭据）

全部查询都在**马帮自己的页面里**执行（利润报表在 `finance.mabangerp.com`、库存在 `aamz.mabangerp.com`、订单在主站 `www.mabangerp.com` 的 `order.oTc`，用马帮页面存着的登录调它自己的接口），登录信息不离开浏览器。取数顺序：

1. **马帮利润助手扩展**（推荐，永远不用点）：Chrome 扩展常驻，向本机中转（127.0.0.1:47321，带打包时生成的密钥）长轮询取任务，在马帮页面里执行后交回结果。装一次即可：
   ```bash
   npx -y mabang-profit-mcp extension [目录]   # 默认 ~/mabang-extension；同时写 ~/.config/mabang-profit/extension.json（600）
   ```
   Chrome 打开 `chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选生成的目录。
   几个 MCP 进程（Accio、Claude Code）同时开着时，第一个占到端口的当中转，其余的把任务交给它。
   马帮页复用（参考上品素材台扩展）：「常开马帮页」默认开——扩展一启动就在后台开好利润报表页和库存 SKU 页（设成 Chrome 不自动丢弃），每 10 分钟用一次轻查询保温，登录令牌过期自动重开；并发查询只开一个页；用户自己开的马帮页只借用不关。弹窗里能看连接状态、关掉常开（关掉后自己开的页闲置 10 分钟就关）、「现在打开马帮页」。
   改了扩展代码（开发）：`node scripts/build-extension.mjs`（生成到 dist/mabang-extension）后在 chrome://extensions 点「马帮利润助手」的重新加载。
2. **马帮桥**（`mabang-profit-mcp bridge`）：常驻进程，用 Chrome 远程调试连一次（要点一次「允许远程调试」），之后都经它查；Chrome 重启要重新点。
3. 自己连 Chrome 远程调试（每次启动都会弹确认框），只在没装扩展时用。

马帮没登录 / 扩展没连上时工具直接报错说明原因，不会反复重试。

## 安装

1. 生成并装上扩展（一次）：

   ```bash
   npx -y mabang-profit-mcp extension            # 生成到 ~/mabang-extension，同时写 ~/.config/mabang-profit/extension.json
   ```

   Chrome 打开 `chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选 `~/mabang-extension`。Chrome 里登录马帮（www.mabangerp.com）。
2. 接入 MCP 客户端：

   ```json
   { "mcpServers": { "mabang-profit": { "command": "npx", "args": ["-y", "mabang-profit-mcp@latest"] } } }
   ```

   Accio：设置 → MCP → 本地服务，命令 `npx`，参数 `-y mabang-profit-mcp@latest`。
3. 升级：再跑一次 `npx -y mabang-profit-mcp@latest extension`，在 chrome://extensions 的「马帮利润助手」上点重新加载。

命令行调试：

```bash
node bin/mabang-profit-mcp.mjs call mabang_shop_profit '{"month":"2026-11"}'
node bin/mabang-profit-mcp.mjs call mabang_item_profit '{"platform":"shein","month":"2026-10"}'
```

## 开发

```bash
npm test     # 不连网：利润口径、汇总、对比、估算、参数校验、CSV、中转、扩展后台（模拟 chrome.*）
```

在马帮页面里执行的函数在 `lib/page-fns.mjs`（MCP 和扩展共用，打包时复制进扩展）；新增马帮接口要同时改那里的 `FINANCE_PATH` 白名单。
