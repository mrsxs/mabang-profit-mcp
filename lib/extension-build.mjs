// 生成马帮利润助手扩展：extension/ + lib/page-fns.mjs → 输出目录（给 Chrome「加载已解压的扩展程序」用），
// 写 config.json（中转端口 + 随机密钥），同一份写到 ~/.config/mabang-profit/extension.json（600）给 MCP 用。
// 已有 extension.json 就沿用里面的密钥（重新生成后不用重新配）。
import { randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extensionFile, loadExtensionConfig } from './hub.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_PORT = 47321;

export function buildExtension(outDir, { file = extensionFile() } = {}) {
  const out = resolve(outDir);
  const cfg = loadExtensionConfig(file) ?? { port: DEFAULT_PORT, secret: randomBytes(32).toString('hex') };
  mkdirSync(out, { recursive: true });
  for (const f of ['manifest.json', 'background.js', 'popup.html', 'popup.js']) copyFileSync(join(ROOT, 'extension', f), join(out, f));
  copyFileSync(join(ROOT, 'lib', 'page-fns.mjs'), join(out, 'page-fns.js'));
  writeFileSync(join(out, 'config.json'), JSON.stringify(cfg));
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(cfg), { mode: 0o600 });
  chmodSync(file, 0o600);
  const { version } = JSON.parse(readFileSync(join(ROOT, 'extension', 'manifest.json'), 'utf8'));
  return { out, version };
}
