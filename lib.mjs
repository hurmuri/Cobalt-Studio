// cobalt API client core — zero dependencies, Node >= 18
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';

export const DEFAULT_INSTANCE = 'http://localhost:9000';

/** options accepted by cobalt's POST / — see docs/api.md */
export const OPTION_KEYS = [
  'audioBitrate', 'audioFormat', 'downloadMode', 'filenameStyle', 'videoQuality',
  'disableMetadata', 'alwaysProxy', 'localProcessing', 'subtitleLang',
  'youtubeVideoCodec', 'youtubeVideoContainer', 'youtubeDubLang', 'convertGif',
  'allowH265', 'tiktokFullAudio', 'youtubeBetterAudio', 'youtubeHLS',
];

export class CobaltError extends Error {
  constructor(message, { code, context, httpStatus } = {}) {
    super(message);
    this.name = 'CobaltError';
    this.code = code;
    this.context = context;
    this.httpStatus = httpStatus;
  }
}

function normalizeBase(url) {
  const u = (url || DEFAULT_INSTANCE).trim();
  return u.endsWith('/') ? u : u + '/';
}

function authHeaders({ apiKey, bearer }) {
  if (apiKey) return { Authorization: `Api-Key ${apiKey}` };
  if (bearer) return { Authorization: `Bearer ${bearer}` };
  return {};
}

const ERROR_HINTS = {
  'error.api.auth.jwt.missing': '该实例要求 turnstile/JWT 票据（官方 api.cobalt.tools 就是这样），脚本无法直接使用。请自建实例，或向实例主索取 Api-Key。',
  'error.api.auth.key.missing': '该实例开启了 Api-Key 鉴权，请通过 --api-key 或 COBALT_API_KEY 提供。',
  'error.api.auth.key.invalid': 'Api-Key 无效。',
  'error.api.rate_exceeded': '触发限流，等限流窗口结束再试，或调高实例的 RATELIMIT_MAX。',
  'error.api.link.invalid': '链接格式不被识别（可能缺少协议头或不是受支持的站点）。',
  'error.api.fetch.empty': '源站没有返回可下载内容，可能受到登录、地区或上游接口变化影响。',
  'error.api.content.video.unavailable': '源站说该内容不可用（下架/私享/地区限制）。',
  'error.api.content.video.live': '直播流不支持下载。',
  'error.api.content.video.age': '年龄限制内容，实例需要配置 cookies.json。',
  'error.api.content.video.drm': '内容带 DRM 保护，无法下载。',
  'error.api.content.video.length': '视频时长超过实例的 DURATION_LIMIT。',
  'error.api.content.video.region': '地区限制，实例出口 IP 不被允许。',
  'error.api.content.post.unavailable': '该帖子不可见（可能需登录）。',
  'error.api.service.unsupported': '实例不支持该站点。',
  'error.api.service.disabled': '管理员在本实例上关掉了该站点。',
  'error.api.service.not_implemented': '该站点该模式尚未实现。',
  'error.api.service.temporarily_disabled': '该站点因上游变动被临时停用。',
};

const X_HOSTS = new Set([
  'x.com',
  'www.x.com',
  'mobile.x.com',
  'twitter.com',
  'www.twitter.com',
  'mobile.twitter.com',
  'fxtwitter.com',
  'www.fxtwitter.com',
  'vxtwitter.com',
  'www.vxtwitter.com',
  'fixvx.com',
  'www.fixvx.com',
]);

export function parseXStatus(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!X_HOSTS.has(parsed.hostname.toLowerCase())) return null;
  const match = parsed.pathname.match(/\/([^/]+)\/status\/(\d+)/i);
  return match ? { user: match[1], id: match[2] } : null;
}

function xFallbackFilename(tweet, media, index) {
  const author = tweet?.author?.screen_name || 'x';
  const id = media?.id || tweet?.id || 'media';
  const extension = media?.format === 'image/gif' ? 'gif' : 'mp4';
  return safeName(`${author}_${id}${index ? `_${index + 1}` : ''}.${extension}`, `${id}.${extension}`);
}

function normalizeXMedia(tweet, statusUrl) {
  const post = xPostMetadata(tweet, statusUrl);
  const media = Array.isArray(tweet?.media?.all) ? tweet.media.all : [];
  const videos = media.filter((item) => item?.type === 'video' || item?.format === 'video/mp4');
  if (videos.length) {
    const item = videos[0];
    const formats = (item.formats || [])
      .filter((format) => format?.container === 'mp4' && format.url)
      .sort((a, b) => Number(b.bitrate || 0) - Number(a.bitrate || 0));
    if (formats[0]?.url) {
      return {
        status: 'redirect',
        url: formats[0].url,
        filename: xFallbackFilename(tweet, item, 0),
        post,
      };
    }
  }

  const picker = media
    .map((item, index) => ({
      type: item.type || 'photo',
      url: item.url || item.formats?.find((format) => format?.container === 'mp4')?.url,
      thumb: item.thumbnail_url,
      filename: xFallbackFilename(tweet, item, index),
    }))
    .filter((item) => item.url);
  if (picker.length) {
    return {
      status: 'picker',
      picker,
      filename: `${tweet?.author?.screen_name || 'x'}_${tweet?.id || 'thread'}`,
      post,
    };
  }

  const original = tweet?.url || statusUrl;
  throw new CobaltError(`没有从 X 帖子中找到可下载媒体${original ? `：${original}` : ''}`, {
    code: 'error.api.fetch.empty',
  });
}

function xPostMetadata(tweet, url) {
  const media = tweet?.media?.all || [];
  return {
    sourceUrl: url,
    platform: 'X',
    author: String(tweet?.author?.name || tweet?.author?.screen_name || ''),
    handle: String(tweet?.author?.screen_name || ''),
    text: String(tweet?.text || '').slice(0, 16000),
    publishedAt: tweet?.created_at || '',
    thumbnail: media.find((item) => item.thumbnail_url)?.thumbnail_url ||
      media.find((item) => item.type === 'photo')?.url || '',
  };
}

export async function fetchXPost(url, { timeoutMs = 5000, signal, fallbackBase } = {}) {
  const status = parseXStatus(url);
  if (!status) return null;
  const base = (fallbackBase || 'https://api.fxtwitter.com').replace(/\/+$/, '');
  const endpoint = `${base}/${encodeURIComponent(status.user)}/status/${status.id}`;
  let res;
  try {
    res = await fetch(endpoint, {
      headers: { Accept: 'application/json' },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (signal?.aborted || error.name === 'AbortError') {
      throw new CobaltError('下载已取消', { code: 'client.aborted' });
    }
    return null;
  }
  if (!res.ok) return null;
  let data;
  try {
    data = await res.json();
  } catch {
    return null;
  }
  return data?.tweet || null;
}

export async function fetchPostMetadata(url, options) {
  if (!parseXStatus(url)) return null;
  const tweet = await fetchXPost(url, options);
  return tweet ? xPostMetadata(tweet, url) : null;
}

async function resolveXFallback(url, options) {
  const tweet = await fetchXPost(url, options);
  return tweet ? normalizeXMedia(tweet, url) : null;
}

export function explainError(code) {
  if (!code) return undefined;
  if (ERROR_HINTS[code]) return ERROR_HINTS[code];
  if (code.startsWith('error.api.auth.')) return '鉴权相关错误，检查实例是否要求 Api-Key / Bearer。';
  if (code.startsWith('error.api.rate')) return '限流相关错误。';
  return undefined;
}

/** POST / — resolve a media url into download instructions */
export async function resolve(instanceUrl, url, options = {}, {
  apiKey,
  bearer,
  timeoutMs = 60000,
  signal,
  fallbackBase = process.env.FXTWITTER_API_BASE,
} = {}) {
  const base = normalizeBase(instanceUrl);
  const body = { url };
  for (const k of OPTION_KEYS) {
    if (options[k] !== undefined && options[k] !== null) body[k] = options[k];
  }

  let res;
  try {
    res = await fetch(base, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...authHeaders({ apiKey, bearer }),
      },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (signal?.aborted || err.name === 'AbortError') {
      throw new CobaltError('下载已取消', { code: 'client.aborted' });
    }
    throw new CobaltError(
      `无法连接实例 ${base}：${err.cause?.code || err.message}。实例没启动 / 地址写错 / 被墙。`,
      { code: 'client.network' },
    );
  }

  const rateLimit = {
    limit: res.headers.get('ratelimit-limit'),
    remaining: res.headers.get('ratelimit-remaining'),
    reset: res.headers.get('ratelimit-reset'),
  };

  // tunnel 端点在某些配置下会直接回文件流；正常情况 / 一定回 JSON
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new CobaltError(`实例返回了非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`, {
      httpStatus: res.status,
    });
  }

  if (json.status === 'error') {
    const code = json.error?.code;
    if (typeof code === 'string' && code.startsWith('error.api.fetch.') && parseXStatus(url)) {
      try {
        const fallback = await resolveXFallback(url, { timeoutMs, signal, fallbackBase });
        if (fallback) return { ...fallback, _rateLimit: rateLimit, _fallback: 'fxtwitter' };
      } catch (fallbackError) {
        if (fallbackError instanceof CobaltError && fallbackError.code !== 'error.api.fetch.empty') throw fallbackError;
      }
    }
    throw new CobaltError(`cobalt 拒绝：${code}${explainError(code) ? ` — ${explainError(code)}` : ''}`, {
      code,
      context: json.error?.context,
      httpStatus: res.status,
    });
  }

  json._rateLimit = rateLimit;
  return json;
}

/** GET / — instance info */
export async function serverInfo(instanceUrl, { timeoutMs = 15000 } = {}) {
  const base = normalizeBase(instanceUrl);
  const res = await fetch(base, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new CobaltError(`serverInfo failed: HTTP ${res.status}`, { httpStatus: res.status });
  return res.json();
}

function safeName(name, fallback) {
  const base = path.basename(name || fallback || 'download');
  // eslint-disable-next-line no-control-regex
  return base.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 180) || 'download';
}

function extFromMime(mime = '') {
  const map = {
    'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
    'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/ogg': '.ogg',
    'audio/wav': '.wav', 'audio/opus': '.opus', 'image/jpeg': '.jpg',
    'image/png': '.png', 'image/gif': '.gif', 'video/x-matroska': '.mkv',
  };
  return map[mime.split(';')[0].trim()] || '';
}

export async function downloadTo(url, destPath, { headers = {}, onProgress, signal } = {}) {
  let res;
  try {
    res = await fetch(url, { headers, redirect: 'follow', signal });
  } catch (err) {
    if (signal?.aborted || err.name === 'AbortError') throw new CobaltError('下载已取消', { code: 'client.aborted' });
    throw err;
  }
  if (!res.ok || !res.body) {
    throw new CobaltError(`下载失败 HTTP ${res.status}（${url.slice(0, 80)}…）`, { httpStatus: res.status });
  }
  const total =
    Number(res.headers.get('content-length')) ||
    Number(res.headers.get('estimated-content-length')) ||
    0;
  let received = 0;

  const stream = Readable.fromWeb(res.body);
  if (onProgress) {
    stream.on('data', (chunk) => {
      received += chunk.length;
      onProgress({ received, total });
    });
  }
  await pipeline(stream, fs.createWriteStream(destPath), { signal });
  const written = fs.statSync(destPath).size;
  if (written <= 0) {
    throw new CobaltError(`下载结果为空（HTTP ${res.status}，${url.slice(0, 80)}…）`, {
      code: 'client.empty_download',
      httpStatus: res.status,
    });
  }
  return { path: destPath, bytes: written };
}

function run(cmd, args, { label } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => reject(new CobaltError(`${label || cmd} 启动失败：${err.message}`)));
    child.on('close', (codeNum) => {
      if (codeNum === 0) resolvePromise();
      else reject(new CobaltError(`${label || cmd} 退出码 ${codeNum}\n${stderr.slice(-1200)}`));
    });
  });
}

/**
 * Resolve + fetch a single url end-to-end.
 * Returns { files: string[], status, filename, note }
 */
export async function fetchMedia(instanceUrl, url, options = {}, opts = {}) {
  const {
    outDir = process.cwd(),
    outName,
    apiKey,
    bearer,
    log = () => {},
    pickerMode = 'first', // first | all | none
    merge = true,
    ffmpeg = 'ffmpeg',
    timeoutMs,
    signal,
    onResolved,
    onProgress,
    onStage,
    fallbackBase,
  } = opts;

  const info = await resolve(instanceUrl, url, options, { apiKey, bearer, timeoutMs, signal, fallbackBase });
  if (signal?.aborted) throw new CobaltError('下载已取消', { code: 'client.aborted' });
  onResolved?.(info);
  const dlOpts = { headers: authHeaders({ apiKey, bearer }) };
  const progress = (tag, offset = 0, partTotal = 0, partIndex = 0, partCount = 1) => ({ received, total }) => {
    if (total) log(`  ${tag} ${Math.floor((received / total) * 100)}% (${(received / 1048576).toFixed(1)}MB)`);
    else log(`  ${tag} ${(received / 1048576).toFixed(1)}MB`);
    const aggregate = offset + received;
    onProgress?.({
      received: aggregate,
      total: partTotal || total || 0,
      partReceived: received,
      partTotal: total,
      partIndex,
      partCount,
      tag,
    });
  };

  if (info.status === 'redirect' || info.status === 'tunnel') {
    const dest = path.join(outDir, safeName(outName || info.filename, 'download'));
    log(`[${info.status}] ${info.filename}`);
    onStage?.({ stage: 'downloading', name: info.filename, parts: 1 });
    const r = await downloadTo(info.url, dest, { ...dlOpts, signal, onProgress: progress('↓') });
    return { status: info.status, files: [r.path], filename: path.basename(r.path), info };
  }

  if (info.status === 'picker') {
    const items = info.picker || [];
    log(`[picker] 共 ${items.length} 项：${items.map((i) => i.type).join(', ')}`);
    if (pickerMode === 'none') return { status: 'picker', files: [], picker: items, info };
    const picked = pickerMode === 'all' ? items : items.slice(0, 1);
    const files = [];
    for (let i = 0; i < picked.length; i++) {
      const item = picked[i];
      onStage?.({ stage: 'downloading', name: `第 ${i + 1}/${picked.length} 项`, parts: picked.length });
      const stem = safeName(outName || path.parse(info.filename || 'media').name, 'media');
      const ext = path.extname(new URL(item.url).pathname) || extFromMime('image/jpeg');
      const dest = path.join(outDir, `${stem}${picked.length > 1 ? `_${i + 1}` : ''}${ext}`);
      log(`  (${i + 1}/${picked.length}) ${item.type} → ${path.basename(dest)}`);
      await downloadTo(item.url, dest, { ...dlOpts, signal, onProgress: progress('  ↓') });
      files.push(dest);
    }
    return { status: 'picker', files, picker: items, info };
  }

  if (info.status === 'local-processing') {
    const tunnels = info.tunnel || [];
    const finalName = safeName(outName || info.output?.filename, 'output' + extFromMime(info.output?.type));
    log(`[local-processing] type=${info.type} 分片=${tunnels.length} → ${finalName}`);
    const tmpDir = fs.mkdtempSync(path.join(outDir, '.cobalt-'));
    try {
      const parts = [];
      const partTotals = new Array(tunnels.length).fill(0);
      for (let i = 0; i < tunnels.length; i++) {
        const p = path.join(tmpDir, `part${i}`);
        log(`  ↓ 分片 ${i + 1}/${tunnels.length}`);
        onStage?.({ stage: 'downloading', name: finalName, parts: tunnels.length, part: i + 1 });
        const baseOffset = partTotals.slice(0, i).reduce((sum, value) => sum + value, 0);
        const r = await downloadTo(tunnels[i], p, {
          ...dlOpts,
          signal,
          onProgress: progress('  ↓', baseOffset, 0, i, tunnels.length),
        });
        partTotals[i] = r.bytes;
        parts.push(p);
      }
      const dest = path.join(outDir, finalName);

      if (!merge) {
        const files = [];
        for (let i = 0; i < parts.length; i++) {
          const keep = path.join(outDir, `${path.parse(finalName).name}_part${i}${path.extname(finalName)}`);
          fs.copyFileSync(parts[i], keep);
          files.push(keep);
        }
        return { status: info.status, files, info, note: '未合并，已保留分片' };
      }

      onStage?.({ stage: 'processing', name: finalName, parts: tunnels.length });
      const a = info.audio || {};
      const fmt = (a.format || '').toLowerCase();
      switch (info.type) {
        case 'merge':
          // cobalt 约定：tunnel[0] = 视频流，tunnel[1] = 音频流
          if (parts.length < 2) throw new CobaltError('merge 需要 2 个分片，实际只拿到 ' + parts.length);
          await run(ffmpeg, ['-y', '-i', parts[0], '-i', parts[1], '-c', 'copy', '-map', '0:v:0?', '-map', '1:a:0?', dest], { label: 'ffmpeg merge' });
          break;
        case 'mute':
          await run(ffmpeg, ['-y', '-i', parts[0], '-c', 'copy', '-an', dest], { label: 'ffmpeg mute' });
          break;
        case 'remux':
          await run(ffmpeg, ['-y', '-i', parts[0], '-c', 'copy', dest], { label: 'ffmpeg remux' });
          break;
        case 'audio':
          if (parts.length > 1) {
            await run(ffmpeg, ['-y', '-i', parts[0], '-i', parts[1], '-c', 'copy', dest], { label: 'ffmpeg audio merge' });
          } else if (a.copy === false && fmt) {
            const codec = { mp3: 'libmp3lame', ogg: 'libvorbis', opus: 'libopus', wav: 'pcm_s16le', best: 'copy' }[fmt] || 'copy';
            const args = ['-y', '-i', parts[0], '-vn'];
            if (codec === 'copy') args.push('-c:a', 'copy');
            else args.push('-c:a', codec);
            if (a.bitrate) args.push('-b:a', `${a.bitrate}k`);
            args.push(dest);
            await run(ffmpeg, args, { label: `ffmpeg transcode ${fmt}` });
          } else {
            fs.copyFileSync(parts[0], dest);
          }
          break;
        case 'gif': {
          const filter = 'fps=15,scale=480:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse';
          await run(ffmpeg, ['-y', '-i', parts[0], '-filter_complex', filter, dest], { label: 'ffmpeg gif' });
          break;
        }
        default:
          fs.copyFileSync(parts[0], dest);
      }
      return { status: info.status, files: [dest], filename: finalName, info };
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  throw new CobaltError(`未知的响应状态：${info.status}`, { code: 'client.unknown_status' });
}
