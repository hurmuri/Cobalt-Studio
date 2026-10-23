import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError } from './errors.mjs';

export const ROOT = process.env.APP_ROOT
  ? path.resolve(process.env.APP_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.APP_DATA_DIR
  ? path.resolve(process.env.APP_DATA_DIR)
  : path.join(ROOT, '.data');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const CONFIG_FILE = path.join(DATA_DIR, 'settings.json');

const BASE_SETTINGS = {
  maxConcurrent: 5,
  picker: 'first',
  filenameStyle: 'pretty',
  videoQuality: 'max',
  downloadMode: 'auto',
  audioFormat: 'best',
  audioBitrate: '320',
  showThumbnails: true,
};

const SETTING_RULES = {
  picker: ['first', 'all'],
  filenameStyle: ['pretty', 'classic', 'basic', 'nerdy'],
  videoQuality: ['max', '2160', '1440', '1080', '720', '480', '360', '240', '144'],
  downloadMode: ['auto', 'audio', 'mute'],
  audioFormat: ['best', 'mp3', 'ogg', 'wav', 'opus'],
  audioBitrate: ['320', '256', '128', '96', '64', '8'],
};

function defaultDownloadDir() {
  return process.env.DEFAULT_DOWNLOAD_DIR
    ? path.resolve(ROOT, process.env.DEFAULT_DOWNLOAD_DIR)
    : process.platform === 'win32' ? 'D:\\downloads\\cobalt' : path.join(ROOT, 'downloads');
}

function defaultSettings() {
  return {
    ...BASE_SETTINGS,
    downloadDir: defaultDownloadDir(),
    maxConcurrent: clampConcurrent(process.env.MAX_CONCURRENT_DOWNLOADS),
  };
}

function clampConcurrent(value) {
  const concurrent = Number(value);
  return Math.max(1, Math.min(10, Number.isFinite(concurrent) && concurrent > 0 ? Math.floor(concurrent) : BASE_SETTINGS.maxConcurrent));
}

function ensureAllowedSettings(settings) {
  if (typeof settings.showThumbnails !== 'boolean') {
    throw new AppError('缩略图设置必须为开启或关闭', { code: 'config.invalid_value' });
  }
  for (const [key, values] of Object.entries(SETTING_RULES)) {
    if (!values.includes(String(settings[key]))) {
      throw new AppError(`设置项 ${key} 的值无效`, { code: 'config.invalid_value' });
    }
  }
}

export function loadEnv(file = path.join(ROOT, '.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (!match || match[1].startsWith('#')) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}

export function bootstrapConfig() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaultSettings(), null, 2) + '\n');
  }
}

export function readSettings() {
  bootstrapConfig();
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    throw new AppError('设置文件损坏，请检查 .data/settings.json', { status: 500, code: 'config.invalid' });
  }
  const settings = { ...defaultSettings(), ...saved };
  settings.downloadDir = path.resolve(settings.downloadDir);
  settings.maxConcurrent = clampConcurrent(settings.maxConcurrent);
  ensureAllowedSettings(settings);
  return settings;
}

export function writeSettings(next) {
  const current = readSettings();
  const merged = { ...current, ...next };
  merged.downloadDir = path.resolve(String(merged.downloadDir || defaultDownloadDir()));
  merged.maxConcurrent = clampConcurrent(merged.maxConcurrent);
  ensureAllowedSettings(merged);
  fs.mkdirSync(merged.downloadDir, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2) + '\n');
  return merged;
}

export function appContext() {
  bootstrapConfig();
  return {
    root: ROOT,
    dataDir: DATA_DIR,
    publicDir: PUBLIC_DIR,
    port: Number(process.env.PORT) || 8787,
    host: process.env.HOST || '0.0.0.0',
    publicOrigin: process.env.PUBLIC_ORIGIN || '',
    cobaltUrl: process.env.COBALT_API_URL || 'http://127.0.0.1:9000/',
    cobaltKey: process.env.COBALT_API_KEY || '',
    cobaltBearer: process.env.COBALT_BEARER || '',
  };
}
