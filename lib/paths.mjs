import fs from 'node:fs';
import path from 'node:path';

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function resolveInside(root, candidate) {
  const rootPath = path.resolve(root);
  const full = path.resolve(rootPath, candidate || '.');
  const rel = path.relative(rootPath, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('路径超出允许范围');
  }
  return full;
}

export function uniquePath(dest) {
  if (!fs.existsSync(dest)) return dest;
  const parsed = path.parse(dest);
  for (let i = 2; i < 10000; i += 1) {
    const next = path.join(parsed.dir, `${parsed.name} (${i})${parsed.ext}`);
    if (!fs.existsSync(next)) return next;
  }
  throw new Error('无法生成唯一文件名');
}

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let amount = value;
  let index = -1;
  do {
    amount /= 1024;
    index += 1;
  } while (amount >= 1024 && index < units.length - 1);
  return `${amount.toFixed(amount >= 100 ? 0 : 1)} ${units[index]}`;
}
