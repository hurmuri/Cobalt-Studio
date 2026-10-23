// 端到端自测：起假实例 → 跑 CLI → 校验产出
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, '..');
const PORT = 9099;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'cobalt-test-'));

const pass = [];
const fail = [];
function check(name, cond, extra = '') {
  (cond ? pass : fail).push(name);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  ${extra}`}`);
}

function cli(args, { env = {} } = {}) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'cobalt.mjs'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

function probe(file) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-i', file], { encoding: 'utf8' });
  const txt = (r.stderr || '') + (r.stdout || '');
  return {
    hasVideo: /Stream #\d+:\d+.*Video:/.test(txt),
    hasAudio: /Stream #\d+:\d+.*Audio:/.test(txt),
    text: txt,
  };
}

const server = spawn(process.execPath, [path.join(DIR, 'mock-server.mjs')], {
  env: { ...process.env, PORT: String(PORT), FXTWITTER_API_BASE: BASE },
  stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('mock server 启动超时')), 8000);
  server.stdout.on('data', (d) => { if (String(d).includes('mock cobalt')) { clearTimeout(t); res(); } });
});

try {
  // 1. 实例信息
  const info = cli(['--info', '-i', BASE]);
  const infoJson = JSON.parse(info.out || '{}');
  check('serverInfo 返回版本与站点', infoJson?.cobalt?.version === '11.7-mock' && infoJson.cobalt.services.length === 2, info.err);

  // 2. redirect
  const r1 = cli(['https://mock.test/redirect', '-O', OUT, '-i', BASE]);
  const f1 = path.join(OUT, 'redirect_test.mp4');
  check('redirect 落盘', fs.existsSync(f1) && fs.statSync(f1).size > 1000, r1.err);

  // 3. tunnel + 文件名净化（"tunnel test (1).mp4"）
  const r2 = cli(['https://mock.test/tunnel', '-O', OUT, '-i', BASE]);
  check('tunnel 落盘 + 文件名清洗', fs.existsSync(path.join(OUT, 'tunnel test (1).mp4')), r2.err);

  // 4. local-processing merge → 必须真的合出音视频
  const r3 = cli(['https://mock.test/merge', '-O', OUT, '-i', BASE]);
  const f3 = path.join(OUT, 'merged_out.mp4');
  const p3 = fs.existsSync(f3) ? probe(f3) : { hasVideo: false, hasAudio: false };
  check('local-processing/merge 产出音视频双流', p3.hasVideo && p3.hasAudio, r3.err || p3.text.slice(-400));

  // 5. mute
  const r4 = cli(['https://mock.test/mute', '-O', OUT, '-i', BASE]);
  const f4 = path.join(OUT, 'muted_out.mp4');
  const p4 = fs.existsSync(f4) ? probe(f4) : { hasVideo: false, hasAudio: true };
  check('local-processing/mute 只有视频流', p4.hasVideo && !p4.hasAudio, r4.err);

  // 6. picker all
  const r5 = cli(['https://mock.test/picker', '--picker', 'all', '-O', OUT, '-i', BASE]);
  const picked = fs.readdirSync(OUT).filter((f) => /^media(?:_\d+)?\.mp4$/.test(f));
  check('picker all 下载全部条目', r5.code === 0 && picked.length === 2, `${r5.err}\nfiles=${fs.readdirSync(OUT).join('|')}\npicked=${picked.join('|')}\ncode=${r5.code}\nout=${r5.out}`);

  // 7. --json 不落盘
  const before = fs.readdirSync(OUT).length;
  const r6 = cli(['https://mock.test/merge', '--json', '-O', OUT, '-i', BASE]);
  const j6 = JSON.parse(r6.out || '{}');
  check('--json 只输出响应不下载', j6.status === 'local-processing' && fs.readdirSync(OUT).length === before, r6.err);

  // 8. error 带可读提示
  const r7 = cli(['https://mock.test/error', '-i', BASE]);
  check('错误码 → 中文提示 + 非零退出', r7.code === 1 && /限流/.test(r7.err) && /rate_exceeded/.test(r7.err), r7.err);

  // 9. 官方实例的 jwt 场景
  const r8 = cli(['https://mock.test/auth', '-i', BASE]);
  check('jwt.missing → 提示需自建实例', r8.code === 1 && /自建实例/.test(r8.err), r8.err);

  // 10. X fetch.empty 兼容降级
  const rFx = cli([
    'https://x.com/mock_user/status/1234567890',
    '-O', OUT,
    '-i', BASE,
  ], { env: { FXTWITTER_API_BASE: BASE } });
  check(
    'X fetch.empty 自动降级并落盘',
    rFx.code === 0 && fs.existsSync(path.join(OUT, 'mock_user_media123.mp4')),
    rFx.err,
  );

  // 11. 实例不存在
  const r9 = cli(['https://mock.test/redirect', '-i', 'http://127.0.0.1:1/'], {});
  check('实例不可达给出明确报错', r9.code === 1 && /无法连接实例/.test(r9.err), r9.err);

  // 12. 缺少 url
  const r10 = cli(['-i', BASE]);
  check('缺参数走 help', r10.out.includes('cobalt <url>'), r10.err);

  // 13. --no-merge 保留分片
  const OUT2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cobalt-raw-'));
  const r11 = cli(['https://mock.test/merge', '--no-merge', '-O', OUT2, '-i', BASE]);
  check('--no-merge 保留 2 个分片', fs.readdirSync(OUT2).filter((f) => f.includes('_part')).length === 2, r11.err);

  // 14. MCP 握手 + tools/list + tools/call
  const mcp = spawn(process.execPath, [path.join(ROOT, 'mcp.mjs')], {
    env: { ...process.env, COBALT_API_URL: BASE, FXTWITTER_API_BASE: BASE },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let mcpOut = '';
  mcp.stdout.on('data', (d) => { mcpOut += d; });
  const sendLine = (o) => mcp.stdin.write(JSON.stringify(o) + '\n');
  sendLine({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
  sendLine({ jsonrpc: '2.0', method: 'notifications/initialized' });
  sendLine({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  sendLine({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'cobalt_resolve', arguments: { url: 'https://mock.test/redirect' } } });
  sendLine({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'cobalt_download', arguments: { url: 'https://mock.test/merge', output_dir: OUT2 } } });
  await new Promise((r) => setTimeout(r, 2500));
  mcp.stdin.end();

  const msgs = mcpOut.trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const byId = (id) => msgs.find((m) => m.id === id);
  check('MCP initialize 返回 serverInfo', byId(1)?.result?.serverInfo?.name === 'cobalt', mcpOut.slice(0, 300));
  check('MCP tools/list 返回 3 个工具', byId(2)?.result?.tools?.length === 3, mcpOut.slice(0, 300));
  const resolveText = byId(3)?.result?.content?.[0]?.text || '';
  check('MCP cobalt_resolve 可用', /"status": "redirect"/.test(resolveText), resolveText.slice(0, 200));
  const dlText = byId(4)?.result?.content?.[0]?.text || '';
  const dlJson = (() => { try { return JSON.parse(dlText); } catch { return {}; } })();
  check('MCP cobalt_download 落盘', dlJson.ok === true && fs.existsSync(dlJson.files?.[0] || ''), dlText.slice(0, 300));
} finally {
  server.kill();
}

console.log(`\n${pass.length} passed, ${fail.length} failed`);
if (fail.length) console.log('failed: ' + fail.join(' | '));
process.exit(fail.length ? 1 : 0);
