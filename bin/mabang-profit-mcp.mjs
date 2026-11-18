#!/usr/bin/env node
// 不带参数 = MCP 服务（stdio）；call <工具> '<JSON 参数>' = 命令行直接调一个工具（调试 / 没有 MCP 的环境用）
import { readFileSync } from 'node:fs';
import { callTool, closeSession, startServer, TOOLS } from '../lib/mcp.mjs';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const [cmd, name, json] = process.argv.slice(2);

if (!cmd) {
  startServer(version);
} else if (cmd === 'extension') {
  // 生成马帮利润助手扩展（默认放到 ~/mabang-extension），然后在 Chrome 里「加载已解压的扩展程序」
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');
  const { buildExtension } = await import('../lib/extension-build.mjs');
  const { out, version } = buildExtension(name || join(homedir(), 'mabang-extension'));
  console.log(`马帮利润助手 ${version} 已生成到 ${out}\n在 Chrome 打开 chrome://extensions → 打开「开发者模式」→「加载已解压的扩展程序」→ 选这个文件夹；以后升级再跑一次，然后在扩展卡片上点「重新加载」。`);
} else if (cmd === 'bridge') {
  const { startBridge } = await import('../lib/bridge.mjs');
  const port = Number(name) || 0;
  try {
    const r = await startBridge({ port, log: (m) => console.error(`[mabang] ${m}`) });
    console.error(`马帮桥已启动：127.0.0.1:${r.port}（连接信息在 ${r.file}）。保持这个进程开着，各 MCP 会自动经它查马帮。`);
  } catch (err) {
    console.error(`马帮桥没启动：${err.message}`);
    process.exit(1);
  }
} else if (cmd === 'call' && name) {
  let args = {};
  try {
    args = json ? JSON.parse(json) : {};
  } catch {
    console.error('参数要是 JSON，比如 \'{"platform":"shein","month":"2026-10"}\'');
    process.exit(2);
  }
  const r = await callTool(name, args).catch((err) => ({ isError: true, content: [{ text: err.message }] }));
  await closeSession();
  console.log(r.content[0].text);
  process.exit(r.isError ? 1 : 0);
} else {
  console.log(`mabang-profit-mcp ${version}：马帮 ERP 成本 / 利润（用主 Chrome 里已登录的马帮，只读）
用法：
  mabang-profit-mcp                          启动 MCP 服务（stdio）
  mabang-profit-mcp call <工具> '<JSON>'      直接调一个工具，输出 JSON
  mabang-profit-mcp extension [目录]          生成马帮利润助手扩展（默认 ~/mabang-extension），在 Chrome 里加载一次，以后不用点任何确认
  mabang-profit-mcp bridge [端口]             启动马帮桥：常驻、只连一次 Chrome，之后 MCP 都经它查（不用每次点「允许远程调试」）
工具：
${TOOLS.map((t) => `  ${t.name}`).join('\n')}
环境变量：MABANG_OUTPUT_DIR（CSV 输出目录，默认 ~/Documents/马帮利润）、CHROME_DEVTOOLS_ACTIVE_PORT（主 Chrome 的 DevToolsActivePort 文件）`);
  process.exit(cmd === '--help' || cmd === '-h' ? 0 : 2);
}
