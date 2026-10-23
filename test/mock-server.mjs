// 本地假实例，用于离线自测（不依赖真实 cobalt）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(DIR, 'fixtures');
const PORT = Number(process.env.PORT || 9099);
const BASE = `http://127.0.0.1:${PORT}`;

function serve(file, res, mime) {
  const p = path.join(FIX, file);
  if (!fs.existsSync(p)) { res.writeHead(404); res.end('missing fixture'); return; }
  const buf = fs.readFileSync(p);
  res.writeHead(200, { 'Content-Type': mime, 'Content-Length': buf.length });
  res.end(buf);
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      cobalt: { version: '11.7-mock', url: BASE, startTime: String(Date.now()), services: ['youtube', 'bilibili'] },
      git: { commit: 'mock', branch: 'main', remote: 'mock' },
    }));
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/file/')) {
    serve(req.url.slice(6), res, 'application/octet-stream');
    return;
  }
  if (req.method === 'GET' && /^\/mock_user\/status\/\d+$/.test(req.url)) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      code: 200,
      message: 'OK',
      tweet: {
        id: req.url.match(/status\/(\d+)$/)?.[1] || '123',
        author: { screen_name: 'mock_user', name: 'Test Author' },
        text: 'Original post text <script>alert(1)</script>',
        created_at: 'Thu Oct 22 09:00:00 +0000 2026',
        media: {
          all: [{
            id: 'media123',
            type: 'video',
            format: 'video/mp4',
            url: `${BASE}/file/video.mp4`,
            formats: [{
              container: 'mp4',
              bitrate: 1000000,
              url: `${BASE}/file/video.mp4`,
            }],
          }],
        },
      },
    }));
    return;
  }
  if (req.method === 'POST' && req.url === '/') {
    const accept = req.headers.accept || '';
    const ctype = req.headers['content-type'] || '';
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      if (!accept.includes('application/json') || !ctype.includes('application/json')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', error: { code: 'error.api.invalid_headers' } }));
        return;
      }
      const { url } = JSON.parse(body || '{}');
      const key = (url || '').replace('https://mock.test/', '');
      const send = (obj) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

      if (key === 'redirect') {
        send({ status: 'redirect', url: `${BASE}/file/video.mp4`, filename: 'redirect_test.mp4' });
      } else if (key === 'tunnel') {
        send({ status: 'tunnel', url: `${BASE}/file/video.mp4`, filename: 'tunnel test (1).mp4' });
      } else if (key === 'merge') {
        send({
          status: 'local-processing', type: 'merge', service: 'youtube',
          tunnel: [`${BASE}/file/video.mp4`, `${BASE}/file/audio.m4a`],
          output: { type: 'video/mp4', filename: 'merged_out.mp4' },
        });
      } else if (key === 'mute') {
        send({
          status: 'local-processing', type: 'mute', service: 'youtube',
          tunnel: [`${BASE}/file/video.mp4`],
          output: { type: 'video/mp4', filename: 'muted_out.mp4' },
        });
      } else if (key === 'picker') {
        send({
          status: 'picker',
          picker: [
            { type: 'photo', url: `${BASE}/file/video.mp4`, thumb: `${BASE}/file/thumb.png` },
            { type: 'photo', url: `${BASE}/file/video.mp4` },
          ],
        });
      } else if (key === 'error') {
        send({ status: 'error', error: { code: 'error.api.rate_exceeded', context: { limit: 60 } } });
      } else if (key === 'auth') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', error: { code: 'error.api.auth.jwt.missing' } }));
      } else if (key === 'fetch-empty') {
        send({ status: 'error', error: { code: 'error.api.fetch.empty' } });
      } else if (url.startsWith('https://x.com/')) {
        send({ status: 'error', error: { code: 'error.api.fetch.empty' } });
      } else {
        send({ status: 'error', error: { code: 'error.api.link.invalid' } });
      }
    });
    return;
  }
  res.writeHead(404); res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock cobalt on ${BASE}`);
});
