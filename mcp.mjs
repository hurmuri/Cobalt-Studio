#!/usr/bin/env node
// cobalt MCP server — 零依赖，stdio JSON-RPC 2.0（换行分隔）
// 用法: node mcp.mjs        环境变量: COBALT_API_URL / COBALT_API_KEY
import { fetchMedia, resolve, serverInfo, CobaltError, OPTION_KEYS } from './lib.mjs';

const SERVER = { name: 'cobalt', version: '1.0.0' };
const PROTOCOL = '2024-11-05';

const OPTION_SCHEMA = {
  type: 'object',
  properties: {
    downloadMode: { type: 'string', enum: ['auto', 'audio', 'mute'], description: 'auto=视频+音频 / audio=仅音频 / mute=无声视频' },
    videoQuality: { type: 'string', enum: ['max', '4320', '2160', '1440', '1080', '720', '480', '360', '240', '144'] },
    audioFormat: { type: 'string', enum: ['best', 'mp3', 'ogg', 'wav', 'opus'] },
    audioBitrate: { type: 'string', enum: ['320', '256', '128', '96', '64', '8'] },
    filenameStyle: { type: 'string', enum: ['classic', 'pretty', 'basic', 'nerdy'] },
    youtubeVideoCodec: { type: 'string', enum: ['h264', 'av1', 'vp9'] },
    youtubeVideoContainer: { type: 'string', enum: ['auto', 'mp4', 'webm', 'mkv'] },
    subtitleLang: { type: 'string', description: 'ISO 639-1 语言码，如 en / zh' },
    disableMetadata: { type: 'boolean' },
    alwaysProxy: { type: 'boolean' },
    localProcessing: { type: 'string', enum: ['disabled', 'preferred', 'forced'] },
    tiktokFullAudio: { type: 'boolean' },
    convertGif: { type: 'boolean' },
  },
};

const TOOLS = [
  {
    name: 'cobalt_resolve',
    description:
      '把媒体链接（YouTube/Bilibili/TikTok/Twitter/Instagram/SoundCloud 等）解析成可下载信息，不落盘。返回 status: redirect | tunnel | local-processing | picker | error。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '媒体链接，必须带 https://' },
        options: OPTION_SCHEMA,
        instance: { type: 'string', description: '覆盖实例地址，默认取 COBALT_API_URL' },
      },
      required: ['url'],
    },
  },
  {
    name: 'cobalt_download',
    description:
      '解析并下载媒体到本地。自动处理 redirect / tunnel / local-processing（用 ffmpeg 合并音视频）/ picker 多文件。返回本地文件绝对路径。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '媒体链接' },
        output_dir: { type: 'string', description: '保存目录的绝对路径，默认当前工作目录' },
        filename: { type: 'string', description: '自定义文件名（含扩展名）' },
        picker: { type: 'string', enum: ['first', 'all', 'none'], description: '多图/多视频帖子的策略，默认 first' },
        options: OPTION_SCHEMA,
        instance: { type: 'string' },
      },
      required: ['url'],
    },
  },
  {
    name: 'cobalt_instance_info',
    description: '查询 cobalt 实例信息：版本、支持的站点列表、是否需要 turnstile。',
    inputSchema: {
      type: 'object',
      properties: { instance: { type: 'string' } },
    },
  },
];

function pickOptions(raw = {}) {
  const out = {};
  for (const k of OPTION_KEYS) if (raw[k] !== undefined) out[k] = raw[k];
  return out;
}

function textResult(obj, isError = false) {
  return { content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }], isError };
}

async function callTool(name, args = {}) {
  const instance = args.instance || process.env.COBALT_API_URL;
  const apiKey = process.env.COBALT_API_KEY;
  const auth = { apiKey, bearer: process.env.COBALT_BEARER };
  const options = pickOptions(args.options);

  if (name === 'cobalt_instance_info') {
    return textResult(await serverInfo(instance));
  }
  if (!args.url) throw new CobaltError('缺少 url 参数', { code: 'client.bad_request' });

  if (name === 'cobalt_resolve') {
    const info = await resolve(instance, args.url, options, auth);
    return textResult(info);
  }
  if (name === 'cobalt_download') {
    const result = await fetchMedia(instance, args.url, options, {
      outDir: args.output_dir || process.cwd(),
      outName: args.filename,
      apiKey,
      bearer: auth.bearer,
      pickerMode: args.picker || 'first',
      log: (m) => process.stderr.write(m + '\n'),
    });
    return textResult({ ok: true, status: result.status, files: result.files, note: result.note });
  }
  throw new CobaltError(`未知工具: ${name}`, { code: 'client.unknown_tool' });
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyError(id, code, message, data) {
  send({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined;

  try {
    switch (method) {
      case 'initialize':
        reply(id, {
          protocolVersion: params?.protocolVersion || PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER,
        });
        return;
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return;
      case 'ping':
        reply(id, {});
        return;
      case 'tools/list':
        reply(id, { tools: TOOLS });
        return;
      case 'tools/call': {
        const r = await callTool(params?.name, params?.arguments || {});
        reply(id, r);
        return;
      }
      case 'resources/list':
        reply(id, { resources: [] });
        return;
      case 'prompts/list':
        reply(id, { prompts: [] });
        return;
      default:
        if (!isNotification) replyError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    const message = err instanceof CobaltError
      ? `${err.message}${err.code ? ` [${err.code}]` : ''}`
      : err.message;
    if (!isNotification) {
      if (method === 'tools/call') reply(id, textResult(`✖ ${message}`, true));
      else replyError(id, -32603, message);
    }
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg);
  }
});
process.stdin.on('end', () => process.exit(0));
process.stderr.write(`[cobalt-mcp] ready (instance=${process.env.COBALT_API_URL || 'http://localhost:9000'})\n`);
