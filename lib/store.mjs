import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensureDir } from './paths.mjs';

export const ACTIVE = new Set(['queued', 'resolving', 'downloading', 'processing']);

export function newId() {
  return crypto.randomUUID();
}

export function createStore(dataDir) {
  ensureDir(dataDir);
  const file = path.join(dataDir, 'tasks.json');
  let tasks = new Map();
  let saveTimer = null;
  const listeners = new Set();

  function load() {
    if (!fs.existsSync(file)) return;
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const task of saved.tasks || []) {
        if (ACTIVE.has(task.status)) {
          task.status = 'queued';
          task.error = null;
          task.speed = 0;
          task.progress = 0;
          task.received = 0;
          task.total = 0;
          task.eta = null;
          task.message = '服务重启，等待继续';
        }
        tasks.set(task.id, task);
      }
    } catch {
      const backup = `${file}.corrupt-${Date.now()}`;
      fs.copyFileSync(file, backup);
    }
  }

  function snapshot() {
    return [...tasks.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((task) => ({ ...task, files: [...(task.files || [])] }));
  }

  function persistNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, tasks: snapshot() }, null, 2));
    fs.renameSync(tmp, file);
  }

  function schedulePersist() {
    if (saveTimer) return;
    saveTimer = setTimeout(persistNow, 250);
  }

  function emit(type, task) {
    for (const listener of listeners) listener(type, task ? { ...task } : null);
    if (type !== 'progress') schedulePersist();
  }

  function add(input) {
    const now = new Date().toISOString();
    const task = {
      id: newId(),
      url: input.url,
      title: input.title || '',
      status: 'queued',
      progress: 0,
      received: 0,
      total: 0,
      speed: 0,
      eta: null,
      message: '等待开始',
      error: null,
      files: [],
      source: input.source || 'desktop',
      options: input.options || {},
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      outputDir: input.outputDir || null,
      allowDuplicate: Boolean(input.allowDuplicate),
      attempts: 0,
      picker: null,
    };
    if (!task.allowDuplicate) {
      const duplicate = [...tasks.values()].find(
        (item) => item.url === task.url && ACTIVE.has(item.status) && item.id !== task.id,
      );
      if (duplicate) return { task: duplicate, duplicate: true };
    }
    tasks.set(task.id, task);
    emit('added', task);
    return { task, duplicate: false };
  }

  function update(id, patch, event = 'updated') {
    const current = tasks.get(id);
    if (!current) return null;
    Object.assign(current, patch);
    emit(event, current);
    return { ...current };
  }

  function get(id) {
    const task = tasks.get(id);
    return task ? { ...task } : null;
  }

  function remove(id) {
    const task = tasks.get(id);
    if (!task) return null;
    tasks.delete(id);
    emit('removed', task);
    return task;
  }

  function removeFinished() {
    const removeIds = [...tasks.values()]
      .filter((task) => !ACTIVE.has(task.status) && task.status !== 'paused')
      .map((task) => task.id);
    for (const id of removeIds) tasks.delete(id);
    if (removeIds.length) emit('bulk_removed', null);
    return removeIds;
  }

  function claimQueued(limit) {
    const active = [...tasks.values()].filter((task) =>
      ['resolving', 'downloading', 'processing'].includes(task.status),
    ).length;
    const slots = Math.max(0, limit - active);
    return [...tasks.values()]
      .filter((task) => task.status === 'queued')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, slots);
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function close() {
    if (saveTimer) persistNow();
  }

  load();
  return { add, update, get, remove, removeFinished, snapshot, claimQueued, subscribe, close };
}
