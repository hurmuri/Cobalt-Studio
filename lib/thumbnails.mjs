import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const pending = new Map();
let tail = Promise.resolve();

export function remoteThumbnail(task) {
  try {
    const url = new URL(task.post?.thumbnail);
    return url.protocol === 'https:' && url.hostname === 'pbs.twimg.com' && !url.username && !url.password && !url.port ? url.href : null;
  } catch { return null; }
}

async function saveRemote(url, target) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000) });
  const type = response.headers.get('content-type') || '';
  if (!response.ok || !/^image\/(jpeg|png|webp)(?:;|$)/i.test(type)) throw new Error('invalid thumbnail');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2 * 1024 * 1024) throw new Error('thumbnail too large');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  if (!size) throw new Error('empty thumbnail');
  fs.writeFileSync(target, Buffer.concat(chunks));
  return type.split(';')[0];
}

export async function thumbnailFor(task, dataDir) {
  const directory = path.join(dataDir, 'thumbnails');
  const target = path.join(directory, `${task.id}.jpg`);
  if (fs.existsSync(target)) return target;
  if (pending.has(task.id)) return pending.get(task.id);
  const file = (task.files || []).find((item) => /\.(mp4|mkv|mov|webm|avi|m4v|png|jpe?g|webp|gif)$/i.test(item) && fs.existsSync(item));
  const remote = remoteThumbnail(task);
  if (!file && !remote) return null;
  // Serialize extraction so opening a large history never spawns many ffmpegs.
  const work = tail.catch(() => {}).then(async () => {
    if (fs.existsSync(target)) return target;
    fs.mkdirSync(directory, { recursive: true });
    const temporary = `${target}.tmp.jpg`;
    try {
      if (remote) {
        try {
          const type = await saveRemote(remote, temporary);
          fs.renameSync(temporary, target);
          fs.writeFileSync(`${target}.mime`, type);
          return target;
        } catch { if (!file) return null; }
      }
      await new Promise((resolve, reject) => {
        const child = spawn(process.env.FFMPEG_PATH || 'ffmpeg', [
          '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', file,
          '-frames:v', '1', '-vf', 'scale=320:180:force_original_aspect_ratio=decrease',
          '-threads', '1', '-y', temporary,
        ], { windowsHide: true, stdio: 'ignore' });
        const timer = setTimeout(() => { child.kill(); reject(new Error('thumbnail timeout')); }, 10000);
        child.once('error', (error) => { clearTimeout(timer); reject(error); });
        child.once('exit', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('thumbnail failed')); });
      });
      fs.renameSync(temporary, target);
      return target;
    } catch {
      fs.rmSync(temporary, { force: true });
      return null;
    }
  });
  pending.set(task.id, work);
  tail = work;
  try { return await work; } finally { pending.delete(task.id); }
}
