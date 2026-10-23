import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../lib/store.mjs';

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cobalt-config-'));
process.env.APP_DATA_DIR = data;
delete process.env.DEFAULT_DOWNLOAD_DIR;
delete process.env.MAX_CONCURRENT_DOWNLOADS;
const { readSettings, writeSettings } = await import('../lib/config.mjs');
const initial = readSettings();
assert.equal(initial.maxConcurrent, 5);
if (process.platform === 'win32') assert.equal(initial.downloadDir, 'D:\\downloads\\cobalt');
console.log('PASS  默认目录和同时下载 5 个任务');

const downloads = path.join(data, 'downloads');
for (let count = 1; count <= 10; count++) {
  assert.equal(writeSettings({ downloadDir: downloads, maxConcurrent: count }).maxConcurrent, count);
  assert.equal(readSettings().maxConcurrent, count);
}
assert.equal(writeSettings({ maxConcurrent: 20 }).maxConcurrent, 10);
assert.equal(writeSettings({ maxConcurrent: 0 }).maxConcurrent, 5);
assert.equal(writeSettings({ maxConcurrent: 3.9 }).maxConcurrent, 3);
console.log('PASS  1–10 并发可持久化且边界受限');

process.env.APP_PORTABLE = '1';
const futureDirectory = path.join(data, 'future-directory');
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ ...initial, downloadDir: futureDirectory }));
assert.equal(readSettings().downloadDir, futureDirectory);
assert.equal(fs.existsSync(futureDirectory), false);
console.log('PASS  便携版保留尚未创建的用户下载目录');

const store = createStore(path.join(data, 'store'));
for (let i = 0; i < 12; i++) store.add({ url: `https://mock.test/${i}`, options: {} });
assert.equal(store.claimQueued(10).length, 10);
store.close();
console.log('PASS  队列可一次分配 10 个下载名额');
