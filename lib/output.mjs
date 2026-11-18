// 明细写到本机 CSV（带 BOM，Excel 直接打开不乱码）；只新建文件，重名加 _2、_3，从不覆盖
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const outputDir = (env = process.env) => env.MABANG_OUTPUT_DIR || join(homedir(), 'Documents', '马帮利润');

const cell = (v) => {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'number' ? String(Math.round(v * 10000) / 10000) : String(v);
  // 以 = + - @ 开头的文字在 Excel 里会被当公式：前面加单引号（数字、负数、负百分比不加）
  const safe = typeof v !== 'number' && /^[=+\-@]/.test(s) && !/^-?\d+(\.\d+)?%?$/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function toCsv(columns, rows) {
  const lines = [columns.map(([, title]) => cell(title)).join(',')];
  for (const r of rows) lines.push(columns.map(([key]) => cell(typeof key === 'function' ? key(r) : r[key])).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}

export function writeNew(name, text, dir = outputDir()) {
  mkdirSync(dir, { recursive: true });
  const dot = name.lastIndexOf('.');
  for (let i = 1; i < 1000; i++) {
    const file = join(dir, i === 1 ? name : `${name.slice(0, dot)}_${i}${name.slice(dot)}`);
    try {
      writeFileSync(file, text, { flag: 'wx' });
      return file;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  throw new Error(`同名文件太多：${name}`);
}

/** 文件名里的店名等只留安全字符 */
export const safeName = (s) => String(s ?? '').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);
