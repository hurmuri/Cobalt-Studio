import fs from 'node:fs';
import path from 'node:path';
import { fetchMedia, fetchPostMetadata, CobaltError, explainError, OPTION_KEYS } from '../lib.mjs';
import { ensureDir, uniquePath } from './paths.mjs';

const OPTION_MAP = {
  downloadMode: 'downloadMode',
  videoQuality: 'videoQuality',
  audioFormat: 'audioFormat',
  audioBitrate: 'audioBitrate',
  filenameStyle: 'filenameStyle',
};

function friendlyError(error) {
  if (error instanceof CobaltError) {
    const hint = explainError(error.code);
    return hint && !error.message.includes(hint) ? `${error.message}\n${hint}` : error.message;
  }
  if (error?.name === 'AbortError') return '下载已取消';
  return error?.message || String(error);
}

export function optionsFromSettings(settings, overrides = {}) {
  const options = {};
  const source = { ...settings, ...overrides };
  for (const [key, cobaltKey] of Object.entries(OPTION_MAP)) {
    if (source[key] !== undefined && source[key] !== '') options[cobaltKey] = String(source[key]);
  }
  for (const key of OPTION_KEYS) {
    if (overrides[key] !== undefined && overrides[key] !== '') options[key] = overrides[key];
  }
  return options;
}

export function createDownloadManager({ store, settings, cobaltUrl, cobaltKey, cobaltBearer }) {
  const controllers = new Map();
  const running = new Set();
  let scheduler = null;

  function emitUpdate(id, patch, event) {
    store.update(id, patch, event);
  }

  function queueTick() {
    if (scheduler) return;
    scheduler = setImmediate(() => {
      scheduler = null;
      const slots = store.claimQueued(settings().maxConcurrent);
      for (const task of slots) run(task);
    });
  }

  async function run(task) {
    if (running.has(task.id)) return;
    running.add(task.id);
    const controller = new AbortController();
    controllers.set(task.id, controller);
    const started = Date.now();
    let lastPersistAt = 0;
    let lastEmit = 0;
    let lastBytes = 0;
    let lastTime = started;
    let total = 0;

    try {
      const current = store.get(task.id);
      if (!current || current.status !== 'queued') return;
      const taskOptions = optionsFromSettings(settings(), current.options);
      const outDir = ensureDir(current.outputDir || settings().downloadDir);

      emitUpdate(task.id, {
        status: 'resolving',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        error: null,
        progress: 0,
        received: 0,
        total: 0,
        speed: 0,
        eta: null,
        attempts: (current.attempts || 0) + 1,
        message: '正在解析链接',
      });

      const result = await fetchMedia(
        cobaltUrl,
        current.url,
        taskOptions,
        {
          outDir,
          pickerMode: current.options.picker || settings().picker,
          merge: true,
          ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg',
          apiKey: cobaltKey,
          bearer: cobaltBearer,
          signal: controller.signal,
          fallbackBase: process.env.FXTWITTER_API_BASE,
          log: (line) => {
            const message = line.trim();
            if (message) emitUpdate(task.id, { message: message.slice(0, 240) });
          },
          onResolved: (info) => {
            if (info.post) emitUpdate(task.id, { post: info.post });
            else {
              // Metadata is optional and must never delay or fail a download.
              fetchPostMetadata(current.url, { signal: controller.signal })
                .then((post) => {
                  if (post && store.get(task.id) && !controller.signal.aborted) emitUpdate(task.id, { post });
                }).catch(() => {});
            }
            const title =
              info.filename ||
              info.output?.filename ||
              path.basename(new URL(current.url).pathname) ||
              '媒体下载';
            emitUpdate(task.id, {
              title,
              picker: info.status === 'picker' ? (info.picker?.length || 0) : null,
              message: info.status === 'picker' ? `帖子包含 ${info.picker?.length || 0} 项` : '已解析，准备下载',
            });
          },
          onStage: ({ stage, name, parts }) => {
            if (stage === 'processing') {
              emitUpdate(task.id, {
                status: 'processing',
                progress: 95,
                message: parts > 1 ? '正在合并音视频' : '正在整理文件',
              });
            } else if (name) {
              emitUpdate(task.id, {
                status: 'downloading',
                title: name,
                message: parts > 1 ? `正在下载 ${parts} 个分片` : '正在下载',
              });
            }
          },
          onProgress: ({ received, total: incomingTotal }) => {
            if (incomingTotal > 0) total = incomingTotal;
            const now = Date.now();
            if (now - lastEmit < 350 && received !== total) return;
            const elapsed = (now - lastTime) / 1000;
            const speed = elapsed > 0 ? Math.max(0, (received - lastBytes) / elapsed) : 0;
            lastEmit = now;
            lastBytes = received;
            lastTime = now;
            const progress = total > 0 ? Math.min(99, Math.round((received / total) * 100)) : 0;
            const persist = now - lastPersistAt >= 2000;
            if (persist) lastPersistAt = now;
            emitUpdate(task.id, {
              status: 'downloading',
              received,
              total,
              progress,
              speed,
              eta: speed > 0 && total > received ? (total - received) / speed : null,
            }, persist ? 'updated' : 'progress');
          },
        },
      );

      const files = result.files || [];
      const latest = store.get(task.id);
      const alreadyAborted = controller.signal.aborted;
      if (alreadyAborted) throw new CobaltError('下载已取消', { code: 'client.aborted' });

      let finalBytes = 0;
      const finalFiles = files.map((file) => {
        const resolved = path.resolve(file);
        const final = uniquePath(resolved);
        if (resolved !== final && latest?.status !== 'canceled') {
          try {
            fs.renameSync(resolved, final);
          } catch {
            return resolved;
          }
        }
        return final;
      });
      const emptyFiles = [];
      for (const file of finalFiles) {
        try {
          const size = fs.statSync(file).size;
          if (size <= 0) emptyFiles.push(path.basename(file));
          else finalBytes += size;
        } catch {
          emptyFiles.push(path.basename(file));
        }
      }
      if (!finalFiles.length || emptyFiles.length) {
        throw new CobaltError(
          emptyFiles.length ? `下载结果不完整：${emptyFiles.join('、')}` : '下载没有生成文件',
          { code: 'client.empty_download' },
        );
      }
      const latestAfterRename = store.get(task.id);

      emitUpdate(task.id, {
        status: 'completed',
        progress: 100,
        received: finalBytes || latestAfterRename?.received || total || 0,
        total: Math.max(finalBytes, latestAfterRename?.total || 0, total || 0),
        speed: 0,
        eta: 0,
        files: finalFiles,
        message: `已完成 · ${finalFiles.length} 个文件`,
        finishedAt: new Date().toISOString(),
      }, 'completed');
      if (latest?.allowDuplicate) {
        store.update(task.id, { allowDuplicate: false });
      }
    } catch (error) {
      const latest = store.get(task.id);
      const canceled = controller.signal.aborted || latest?.status === 'canceled';
      if (!canceled) {
        const message = friendlyError(error);
        console.error(`[task] ${task.id} failed url=${task.url} code=${error?.code || 'unknown'} error=${message}`);
        emitUpdate(task.id, {
          status: 'failed',
          speed: 0,
          eta: null,
          error: message,
          message: '下载失败',
          finishedAt: new Date().toISOString(),
        }, 'failed');
      }
    } finally {
      controllers.delete(task.id);
      running.delete(task.id);
      queueTick();
    }
  }

  function enqueue(input) {
    const result = store.add(input);
    if (!result.duplicate) queueTick();
    return result;
  }

  function kickWorking() {
    queueTick();
  }

  function cancel(id) {
    const task = store.get(id);
    if (!task) return false;
    if (['queued'].includes(task.status)) {
      store.update(id, {
        status: 'canceled',
        speed: 0,
        eta: null,
        message: '已取消',
        finishedAt: new Date().toISOString(),
      }, 'canceled');
      return true;
    }
    if (['resolving', 'downloading', 'processing'].includes(task.status)) {
      store.update(id, { status: 'canceled', speed: 0, eta: null, message: '正在取消' }, 'canceled');
      controllers.get(id)?.abort();
      return true;
    }
    return false;
  }

  function retry(id) {
    const task = store.get(id);
    if (!task) return false;
    if (!['failed', 'canceled'].includes(task.status)) return false;
    store.update(id, {
      status: 'queued',
      progress: 0,
      received: 0,
      total: 0,
      speed: 0,
      eta: null,
      error: null,
      files: [],
      message: '等待重试',
      finishedAt: null,
    }, 'queued');
    queueTick();
    return true;
  }

  function kick() {
    queueTick();
  }

  function queueState() {
    const tasks = store.snapshot();
    return {
      active: tasks.filter((task) => ['resolving', 'downloading', 'processing'].includes(task.status)).length,
      queued: tasks.filter((task) => task.status === 'queued').length,
    };
  }

  function close() {
    for (const controller of controllers.values()) controller.abort();
    controllers.clear();
  }

  return { enqueue, cancel, retry, kick, kickWorking, queueState, close, isRunning: (id) => running.has(id) };
}
