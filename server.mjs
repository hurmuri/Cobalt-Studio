#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import QRCode from 'qrcode';
import { resolve as resolveMedia, serverInfo, fetchPostMetadata, CobaltError, explainError } from './lib.mjs';
import { thumbnailFor, remoteThumbnail } from './lib/thumbnails.mjs';
import { loadEnv, appContext, readSettings, writeSettings } from './lib/config.mjs';
import { createStore } from './lib/store.mjs';
import { createDownloadManager, optionsFromSettings } from './lib/downloader.mjs';
import { AppError, errorPayload } from './lib/errors.mjs';
import { formatBytes, ensureDir } from './lib/paths.mjs';
import { mimeFor } from './lib/mime.mjs';
import { preferredLanAddress, lanAddresses, advertisedOrigin, mobileAccessAddresses } from './lib/network.mjs';

loadEnv();
const config = appContext();
const isPortable = Boolean(process.env.APP_PORTABLE);
const appPackage = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const appVersion = appPackage.version;
const store = createStore(config.dataDir);
const manager = createDownloadManager({
  store,
  settings: readSettings,
  cobaltUrl: config.cobaltUrl,
  cobaltKey: config.cobaltKey,
  cobaltBearer: config.cobaltBearer,
});

const clients = new Set();
const MAX_BODY = 64 * 1024;
const RATE_WINDOW = 60_000;
const RATE_LIMIT = 30;
const rateMap = new Map();
let cobaltOnline = false;
let cobaltDetails = null;
let lastHealthCheck = 0;
let lanAccessReady = process.env.LAN_ACCESS_READY !== '0';
let lastMobileVisit = null;

async function openDirectory(target, selectFile = false) {
  return new Promise((resolve, reject) => {
    // Passing a quoted directory directly exits without opening a window on some
    // Windows 11 shells. The /e switch opens a stable Explorer window.
    const args = selectFile ? [`/select,${target}`] : [`/e,${target}`];
    const child = spawn('explorer.exe', args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(new AppError(`无法打开文件夹：${error.message}`, {
        status: 500,
        code: 'directory.open_failed',
      }));
    };
    child.once('error', fail);
    child.once('spawn', () => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve();
    });
  });
}

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new AppError('请求体过大', { status: 413, code: 'request.too_large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}'));
      } catch {
        reject(new AppError('请求 JSON 格式不正确', { code: 'request.invalid_json' }));
      }
    });
    req.on('error', reject);
  });
}

function remoteAddress(req) {
  return req.socket.remoteAddress || 'unknown';
}

function isLocal(req) {
  const address = remoteAddress(req);
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function rateLimit(req) {
  const now = Date.now();
  const key = remoteAddress(req);
  const entry = rateMap.get(key);
  if (!entry || now - entry.start > RATE_WINDOW) {
    rateMap.set(key, { start: now, count: 1 });
    return;
  }
  entry.count += 1;
  if (entry.count > RATE_LIMIT) {
    throw new AppError('操作过于频繁，请稍后再试', { status: 429, code: 'request.rate_limited' });
  }
}

function publicSettings() {
  const settings = readSettings();
  return {
    ...settings,
    proxyMode: process.env.HTTP_PROXY || process.env.HTTPS_PROXY ? 'system' : 'direct',
    lanAccessReady,
  };
}

function taskView(task) {
  return {
    ...task,
    receivedLabel: formatBytes(task.received),
    totalLabel: formatBytes(task.total),
    speedLabel: task.speed ? `${formatBytes(task.speed)}/s` : '',
    thumbnailUrl: remoteThumbnail(task) || (task.status === 'completed' && (task.files || []).some((file) => /\.(mp4|mkv|mov|webm|avi|m4v|png|jpe?g|webp|gif)$/i.test(file)))
      ? `/api/tasks/${task.id}/thumbnail` : null,
    files: (task.files || []).map((file) => ({
      path: file,
      name: path.basename(file),
      size: fs.existsSync(file) ? fs.statSync(file).size : 0,
      downloadUrl: `/api/files/${task.id}/${encodeURIComponent(path.basename(file))}`,
    })),
  };
}

function broadcast(type, task) {
  const data = JSON.stringify({ type, task: task ? taskView(task) : null });
  for (const res of clients) {
    if (!res.writableEnded) res.write(`event: ${type}\ndata: ${data}\n\n`);
  }
}
store.subscribe((type, task) => broadcast(type, task));

async function checkCobalt(force = false) {
  if (!force && Date.now() - lastHealthCheck < 15_000) {
    return { online: cobaltOnline, details: cobaltDetails };
  }
  lastHealthCheck = Date.now();
  try {
    const details = await serverInfo(config.cobaltUrl, { timeoutMs: 5000 });
    cobaltOnline = true;
    cobaltDetails = {
      version: details?.cobalt?.version || '',
      services: details?.cobalt?.services?.length || 0,
    };
  } catch {
    cobaltOnline = false;
    cobaltDetails = null;
  }
  return { online: cobaltOnline, details: cobaltDetails };
}

function mediaOptions(body) {
  const options = optionsFromSettings(readSettings(), {
    downloadMode: body.mode,
    videoQuality: body.quality,
    audioFormat: body.format,
    audioBitrate: body.bitrate,
    filenameStyle: body.filenameStyle,
  });
  if (body.subtitleLang) options.subtitleLang = String(body.subtitleLang);
  if (body.disableMetadata) options.disableMetadata = true;
  if (body.alwaysProxy) options.alwaysProxy = true;
  return options;
}

function validateUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || '').trim());
  } catch {
    throw new AppError('请输入完整的链接，例如 https://www.youtube.com/watch?v=...', { code: 'url.invalid' });
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new AppError('只支持 http / https 链接', { code: 'url.protocol' });
  }
  return url.toString();
}

function taskById(id) {
  const task = store.get(id);
  if (!task) throw new AppError('任务不存在', { status: 404, code: 'task.not_found' });
  return task;
}

async function handleApi(req, res, pathname) {
  const thumbnailMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/thumbnail$/);
  if (thumbnailMatch && req.method === 'GET') {
    if (!readSettings().showThumbnails) throw new AppError('缩略图已关闭', { status: 404 });
    const file = await thumbnailFor(taskById(thumbnailMatch[1]), config.dataDir);
    if (!file) { res.writeHead(204); res.end(); return; }
    const mime = fs.existsSync(`${file}.mime`) ? fs.readFileSync(`${file}.mime`, 'utf8') : 'image/jpeg';
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': fs.statSync(file).size, 'Cache-Control': 'private, max-age=86400' });
    fs.createReadStream(file).pipe(res);
    return;
  }
  if (pathname === '/api/health' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/bootstrap' && req.method === 'GET') {
    const health = await checkCobalt();
    return sendJson(res, 200, {
      ok: true,
      app: {
        version: appVersion,
        port: config.port,
        local: isLocal(req),
        origin: await advertisedOrigin(req, config),
        addresses: lanAddresses(),
      },
      cobalt: {
        url: config.cobaltUrl,
        online: health.online,
        ...(health.details || {}),
      },
      settings: publicSettings(),
      lanAccessReady,
      tasks: store.snapshot().map(taskView),
    });
  }

  if (pathname === '/api/settings' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, settings: publicSettings() });
  }
  if (pathname === '/api/settings' && req.method === 'PATCH') {
    if (!isLocal(req)) {
      throw new AppError('只能在电脑上修改下载设置', { status: 403, code: 'settings.local_only' });
    }
    const body = await readJson(req);
    if (body.downloadDir) {
      const candidate = path.resolve(String(body.downloadDir));
      ensureDir(candidate);
    }
    const settings = writeSettings(body);
    manager.kickWorking();
    return sendJson(res, 200, { ok: true, settings: publicSettings(), savedDir: settings.downloadDir });
  }

  if (pathname === '/api/lan-access' && req.method === 'POST') {
    if (!isLocal(req)) {
      throw new AppError('只能在电脑上修改局域网访问状态', { status: 403, code: 'lan.local_only' });
    }
    const body = await readJson(req);
    if (typeof body.ready !== 'boolean') {
      throw new AppError('局域网访问状态格式不正确', { status: 400, code: 'lan.invalid' });
    }
    lanAccessReady = body.ready;
    return sendJson(res, 200, { ok: true, lanAccessReady });
  }

  if (pathname === '/api/open-directory' && req.method === 'POST') {
    if (!isLocal(req)) {
      throw new AppError('只能在电脑上打开下载目录', { status: 403, code: 'directory.local_only' });
    }
    if (process.platform !== 'win32') {
      throw new AppError('当前系统不支持此操作', { status: 501, code: 'directory.unsupported' });
    }
    const directory = readSettings().downloadDir;
    ensureDir(directory);
    await openDirectory(directory);
    return sendJson(res, 200, { ok: true });
  }

  const openMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/open$/);
  if (openMatch && req.method === 'POST') {
    if (!isLocal(req)) {
      throw new AppError('只能在电脑上打开文件位置', { status: 403, code: 'file.local_only' });
    }
    if (process.platform !== 'win32') {
      throw new AppError('当前系统不支持此操作', { status: 501, code: 'file.unsupported' });
    }
    const task = taskById(decodeURIComponent(openMatch[1]));
    const file = (task.files || []).find((candidate) => fs.existsSync(candidate));
    if (!file) {
      throw new AppError('下载文件不存在', { status: 404, code: 'file.not_found' });
    }
    // `explorer /select,file` opens the containing folder and selects the file.
    await openDirectory(path.resolve(file), true);
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/qr' && req.method === 'GET') {
    const addresses = await mobileAccessAddresses();
    const requested = new URL(req.url, 'http://localhost').searchParams.get('address');
    const selected = requested ? addresses.find((item) => item.address === requested) : addresses[0];
    if (requested && !selected) throw new AppError('该 IPv4 地址已不可用，请刷新地址列表。', { status: 400, code: 'network.address_unavailable' });
    const mobileUrl = selected ? `http://${selected.address}:${config.port}/mobile` : null;
    const details = { addresses, selectedAddress: selected?.address || null, lanAccessReady, lastMobileVisit };
    if (!mobileUrl) return sendJson(res, 200, { ok: true, url: null, svg: null, size: 240, ...details });
    try {
      const margin = 4;
      const size = (QRCode.create(mobileUrl, { errorCorrectionLevel: 'M' }).modules.size + margin * 2) * 6;
      const svg = await QRCode.toString(mobileUrl, {
        type: 'svg',
        margin,
        width: size,
        errorCorrectionLevel: 'M',
        color: { dark: '#111418', light: '#ffffff' },
      });
      return sendJson(res, 200, {
        ok: true,
        url: mobileUrl,
        svg,
        size,
        ...details,
      });
    } catch {
      return sendJson(res, 200, {
        ok: true,
        url: mobileUrl,
        svg: null,
        ...details,
      });
    }
  }

  if (pathname === '/api/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`);
    clients.add(res);
    const timer = setInterval(() => {
      if (!res.writableEnded) res.write(': keepalive\n\n');
    }, 20_000);
    req.on('close', () => {
      clearInterval(timer);
      clients.delete(res);
    });
    return;
  }

  if (pathname === '/api/tasks' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, tasks: store.snapshot().map(taskView) });
  }

  if (pathname === '/api/tasks/clear-finished' && req.method === 'POST') {
    const removed = store.removeFinished();
    return sendJson(res, 200, { ok: true, removed });
  }

  if (pathname === '/api/tasks' && req.method === 'POST') {
    const body = await readJson(req);
    const url = validateUrl(body.url);
    const settings = readSettings();
    const outputDir = settings.downloadDir;
    ensureDir(outputDir);
    const result = manager.enqueue({
      url,
      source: String(req.headers['x-client'] || (isLocal(req) ? 'desktop' : 'mobile')).slice(0, 20),
      options: {
        ...mediaOptions(body),
        picker: body.picker || settings.picker,
        subtitleLang: body.subtitleLang || undefined,
      },
      outputDir,
      allowDuplicate: Boolean(body.allowDuplicate),
    });
    const status = result.duplicate ? 409 : 202;
    return sendJson(res, status, {
      ok: true,
      duplicate: result.duplicate,
      task: taskView(result.task),
      queue: manager.queueState(),
    });
  }

  if (pathname === '/api/resolve' && req.method === 'POST') {
    const body = await readJson(req);
    const url = validateUrl(body.url);
    try {
      const info = await resolveMedia(config.cobaltUrl, url, mediaOptions(body), {
        apiKey: config.cobaltKey,
        bearer: config.cobaltBearer,
        fallbackBase: process.env.FXTWITTER_API_BASE,
      });
      return sendJson(res, 200, { ok: true, info });
    } catch (error) {
      if (error instanceof CobaltError) {
        const hint = explainError(error.code);
        throw new AppError(hint && !error.message.includes(hint) ? `${error.message}\n${hint}` : error.message, {
          code: error.code || 'cobalt.error',
        });
      }
      throw error;
    }
  }

  const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (taskMatch) {
    const id = decodeURIComponent(taskMatch[1]);
    if (req.method === 'GET') return sendJson(res, 200, { ok: true, task: taskView(taskById(id)) });
    if (req.method === 'DELETE') {
      const task = taskById(id);
      manager.cancel(id);
      store.remove(id);
      return sendJson(res, 200, { ok: true, removed: task.id });
    }
  }

  const actionMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/(cancel|retry)$/);
  if (actionMatch && req.method === 'POST') {
    const id = decodeURIComponent(actionMatch[1]);
    taskById(id);
    const acted = actionMatch[2] === 'cancel' ? manager.cancel(id) : manager.retry(id);
    if (!acted) throw new AppError('当前状态不能执行该操作', { status: 409, code: 'task.invalid_state' });
    return sendJson(res, 200, { ok: true, task: taskView(taskById(id)) });
  }

  const fileMatch = pathname.match(/^\/api\/files\/([^/]+)\/(.+)$/);
  if (fileMatch && (req.method === 'GET' || req.method === 'HEAD')) {
    const id = decodeURIComponent(fileMatch[1]);
    const filename = decodeURIComponent(fileMatch[2]);
    const task = taskById(id);
    const file = (task.files || []).find((candidate) => path.basename(candidate) === filename);
    if (!file || !fs.existsSync(file)) throw new AppError('文件不存在', { status: 404, code: 'file.not_found' });
    const stat = fs.statSync(file);
    const range = req.headers.range;
    let start = 0;
    let end = stat.size - 1;
    let status = 200;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (match) {
        start = match[1] ? Number(match[1]) : 0;
        end = match[2] ? Number(match[2]) : stat.size - 1;
        if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end || start >= stat.size) {
          res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
          res.end();
          return;
        }
        status = 206;
      }
    }
    const headers = {
      'Content-Type': mimeFor(file),
      'Content-Length': end - start + 1,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`,
      'Cache-Control': 'private, max-age=3600',
      'Accept-Ranges': 'bytes',
    };
    if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
    res.writeHead(status, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }

  throw new AppError('接口不存在', { status: 404, code: 'api.not_found' });
}

function wantsJson(req) {
  const pathname = new URL(req.url || '/', 'http://localhost').pathname;
  return pathname.startsWith('/api/') || String(req.headers.accept || '').includes('application/json');
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
};

function serveStatic(req, res, pathname) {
  let target = pathname;
  if (target === '/' || target === '') target = '/index.html';
  if (!path.extname(target)) target = `${target}.html`;
  const safe = path.normalize(target).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(config.publicDir, safe);
  const relative = path.relative(config.publicDir, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  const stat = fs.statSync(file);
  const headers = {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
  };
  if (target.endsWith('.html')) {
    headers['Content-Security-Policy'] =
      "default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; script-src 'self'; connect-src 'self'; media-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
  }
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; script-src 'self'; connect-src 'self'; media-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);
  try {
    if ((pathname === '/mobile' || pathname === '/mobile.html') && !isLocal(req)) {
      const address = remoteAddress(req).replace(/^::ffff:/, '');
      if (!lanAddresses().some((item) => item.address === address)) {
        lastMobileVisit = { address, at: new Date().toISOString() };
        console.log(`[LAN] mobile page requested from ${address}`);
      }
    }
    if (pathname.startsWith('/api/')) {
      // Cheap reads (bootstrap/tasks/SSE) must not starve a busy desktop UI.
      // The limiter remains active for mutating API calls.
      if (req.method !== 'GET' && req.method !== 'HEAD') rateLimit(req);
      await handleApi(req, res, pathname);
      return;
    }
    serveStatic(req, res, pathname);
  } catch (error) {
    if (res.headersSent) {
      res.end();
      return;
    }
    const status = error instanceof AppError ? error.status : error.httpStatus || 500;
    if (!(error instanceof AppError) && !(error instanceof CobaltError)) {
      console.error('[server]', error);
    }
    if (wantsJson(req)) sendJson(res, status, errorPayload(error));
    else {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>请求失败</h1>');
    }
  }
});

server.listen(config.port, config.host, async () => {
  manager.kickWorking();
  const lan = await preferredLanAddress();
  const shownHost = config.host === '0.0.0.0' || config.host === '::' ? lan?.address || '127.0.0.1' : config.host;
  console.log('');
  console.log('  Cobalt Studio');
  console.log(`  电脑端  http://127.0.0.1:${config.port}`);
  console.log(`  手机端  http://${shownHost}:${config.port}/mobile`);
  console.log(`  cobalt  ${config.cobaltUrl}`);
  console.log(`  下载目录 ${readSettings().downloadDir}`);
  console.log('');
  // Backfill old history without re-downloading media or delaying startup.
  for (const task of store.snapshot()) {
    if (task.post || !/https?:\/\/(?:www\.|mobile\.)?(?:x|twitter|fxtwitter|vxtwitter)\.com\//i.test(task.url)) continue;
    try {
      const post = await fetchPostMetadata(task.url);
      if (post && store.get(task.id)) store.update(task.id, { post });
    } catch {}
  }
});

let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`\n收到 ${signal}，正在保存任务…`);
  manager.close();
  store.close();
  for (const res of clients) res.end();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2500).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
