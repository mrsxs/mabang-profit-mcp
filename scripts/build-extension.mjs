#!/usr/bin/env node
// 开发用：生成马帮利润助手扩展到 dist/mabang-extension（或指定目录）。装了包的人用 `npx mabang-profit-mcp extension <目录>`。
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildExtension } from '../lib/extension-build.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { out, version } = buildExtension(process.argv[2] ?? join(ROOT, 'dist', 'mabang-extension'));
console.log(`马帮利润助手 ${version} 已打包到 ${out}\n在 Chrome 打开 chrome://extensions → 打开「开发者模式」→「加载已解压的扩展程序」→ 选这个文件夹。`);
