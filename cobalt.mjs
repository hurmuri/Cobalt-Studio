#!/usr/bin/env node
// cobalt CLI — node cobalt.mjs <url> [options]
import path from 'node:path';
import { fetchMedia, resolve, serverInfo, CobaltError, OPTION_KEYS } from './lib.mjs';

const HELP = `
cobalt <url> [options]

必填
  <url>                    要下载的媒体链接

输出
  -o, --out <file|dir>     指定输出文件名；给的是目录则按 cobalt 生成的文件名保存
  -O, --out-dir <dir>      输出目录（默认当前目录）
  --no-merge               local-processing 时只下载分片、不合并

下载选项（转发给 cobalt POST /）
  --mode <auto|audio|mute>            downloadMode
  -q, --quality <max|2160|1440|1080|720|480|360|240|144>   videoQuality
  --format <best|mp3|ogg|wav|opus>    audioFormat
  --bitrate <320|256|128|96|64|8>     audioBitrate
  --filename-style <classic|pretty|basic|nerdy>
  --codec <h264|av1|vp9>              youtubeVideoCodec
  --container <auto|mp4|webm|mkv>     youtubeVideoContainer
  --subs <lang>                       subtitleLang (ISO 639-1)
  --no-metadata                       disableMetadata
  --proxy                             alwaysProxy（强制走实例隧道）
  --local-processing <disabled|preferred|forced>
  --picker <first|all|none>           多图/多视频帖子的处理方式

实例
  -i, --instance <url>     实例地址（默认 $COBALT_API_URL 或 http://localhost:9000）
  -k, --api-key <key>      Api-Key 鉴权（或 $COBALT_API_KEY）
  --bearer <token>         Bearer 鉴权（turnstile 票据）
  --info                   仅打印实例信息
  --json                   只输出 JSON（不下载），便于管道处理
  --raw                    下载并输出原始响应 JSON
  -h, --help

示例
  node cobalt.mjs "https://www.youtube.com/watch?v=jNQXAC9IVRw" -q 1080
  node cobalt.mjs "https://x.com/user/status/123" --picker all -O ./dl
  node cobalt.mjs "https://www.bilibili.com/video/BV1xx" --mode audio --format mp3
`;

function parseArgs(argv) {
  const o = { _: [], options: {} };
  const takesValue = new Set([
    '-o', '--out', '-O', '--out-dir', '-i', '--instance', '-k', '--api-key', '--bearer',
    '--mode', '-q', '--quality', '--format', '--bitrate', '--filename-style', '--codec',
    '--container', '--subs', '--local-processing', '--picker',
  ]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!takesValue.has(a)) { o._.push(a); continue; }
    const v = argv[++i];
    if (v === undefined) throw new Error(`${a} 需要一个值`);
    o[a] = v;
  }
  const has = (...keys) => keys.some((k) => o[k] !== undefined);
  const get = (...keys) => keys.map((k) => o[k]).find((v) => v !== undefined);

  if (has('-q', '--quality')) o.options.videoQuality = String(get('-q', '--quality'));
  if (has('--mode')) o.options.downloadMode = get('--mode');
  if (has('--format')) o.options.audioFormat = get('--format');
  if (has('--bitrate')) o.options.audioBitrate = String(get('--bitrate'));
  if (has('--filename-style')) o.options.filenameStyle = get('--filename-style');
  if (has('--codec')) o.options.youtubeVideoCodec = get('--codec');
  if (has('--container')) o.options.youtubeVideoContainer = get('--container');
  if (has('--subs')) o.options.subtitleLang = get('--subs');
  if (has('--local-processing')) o.options.localProcessing = get('--local-processing');
  for (const flag of o._) {
    if (flag === '--no-metadata') o.options.disableMetadata = true;
    if (flag === '--proxy') o.options.alwaysProxy = true;
  }
  return o;
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes('-h') || argv.includes('--help')) {
    console.log(HELP.trim());
    return 0;
  }
  const args = parseArgs(argv);
  const instance = args['-i'] || args['--instance'] || process.env.COBALT_API_URL || undefined;
  const apiKey = args['-k'] || args['--api-key'] || process.env.COBALT_API_KEY || undefined;
  const bearer = args['--bearer'];

  if (args._.includes('--info')) {
    const info = await serverInfo(instance);
    console.log(JSON.stringify(info, null, 2));
    return 0;
  }

  const url = args._.find((a) => !a.startsWith('-'));
  if (!url) {
    console.log(HELP.trim());
    return 0;
  }

  const log = (m) => console.error(m);
  const outDirRaw = args['-O'] || args['--out-dir'] || process.cwd();
  const outArg = args['-o'] || args['--out'];
  let outDir = outDirRaw;
  let outName;

  if (outArg) {
    const looksLikeDir = outArg.endsWith('/') || outArg.endsWith('\\') || path.extname(outArg) === '';
    if (looksLikeDir) outDir = outArg; else { outDir = path.dirname(path.resolve(outArg)); outName = path.basename(outArg); }
  }

  if (args._.includes('--json') || args._.includes('--raw')) {
    const info = await resolve(instance, url, args.options, { apiKey, bearer });
    console.log(JSON.stringify(info, null, 2));
    return 0;
  }

  const result = await fetchMedia(instance, url, args.options, {
    outDir,
    outName,
    apiKey,
    bearer,
    log,
    pickerMode: args['--picker'] || 'first',
    merge: !args._.includes('--no-merge'),
    ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg',
  });

  log('');
  for (const f of result.files) log(`✔ ${f}`);
  if (result.note) log(`  ${result.note}`);
  console.log(JSON.stringify({ ok: true, status: result.status, files: result.files }));
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    const msg = err instanceof CobaltError
      ? `${err.message}${err.code ? `\n  code: ${err.code}` : ''}`
      : err.message;
    console.error(`✖ ${msg}`);
    if (process.env.COBALT_DEBUG) console.error(err.stack);
    process.exitCode = 1;
  });
