import { postView } from './post-view.js';
const $ = (selector, root = document) => root.querySelector(selector);

const STATUS = {
  queued: '排队中',
  resolving: '解析中',
  downloading: '下载中',
  processing: '处理中',
  completed: '已完成',
  failed: '失败',
  canceled: '已取消',
  paused: '已暂停',
};

let tasks = [];
let source = null;
let renderFrame = 0;
let lastCobaltOnline = false;
let rendered = new Map();
let showThumbnails = true;
let pollTimer = null;
let reconnectTimer = null;

function looksLikeUrl(value) {
  const text = String(value || '').trim();
  if (!text || /[\r\n]/.test(text)) return false;
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      'X-Client': 'mobile',
      ...options.headers,
    },
  });
  const data = await response.json().catch(() => ({ ok: false, error: { message: `请求失败 (${response.status})` } }));
  if (!response.ok && !data?.duplicate) {
    const error = new Error(data?.error?.message || `请求失败 (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function message(text, type = '') {
  const node = $('#mobileMessage');
  node.textContent = text;
  node.className = `form-message ${type}`;
}

function isActive(task) {
  return ['queued', 'resolving', 'downloading', 'processing'].includes(task.status);
}

function formatEta(seconds) {
  if (!Number.isFinite(seconds)) return '';
  return seconds < 60 ? `${Math.max(1, Math.ceil(seconds))} 秒` : `${Math.ceil(seconds / 60)} 分钟`;
}

function template(task) {
  const progress = task.status === 'completed' ? 100 : task.progress || 0;
  const active = isActive(task);
  const meta =
    task.status === 'completed'
      ? `${task.files?.length || 0} 个文件 · 保存在电脑`
      : task.status === 'failed'
        ? task.error || '下载失败'
        : task.total
          ? `${task.receivedLabel} / ${task.totalLabel}${task.speedLabel ? ` · ${task.speedLabel}` : ''}${task.eta ? ` · ${formatEta(task.eta)}` : ''}`
          : task.message || '等待开始';
  const download = (task.files || [])
    .map((file) => `<a href="${escapeHtml(file.downloadUrl)}" download="${escapeHtml(file.name)}">保存到手机</a>`)
    .join('');
  const actions = [
    active ? `<button data-action="cancel" data-id="${task.id}">取消</button>` : '',
    ['failed', 'canceled'].includes(task.status)
      ? `<button data-action="retry" data-id="${task.id}">重试</button>`
      : '',
    download,
  ].filter(Boolean);

  return `
    <article class="mobile-task ${escapeHtml(task.status)}">
      <div class="mobile-task-top">
        <h3 class="mobile-task-title">${escapeHtml(task.title || '正在获取标题…')}</h3>
        <span class="mobile-task-status ${escapeHtml(task.status)}">${escapeHtml(STATUS[task.status] || task.status)}</span>
      </div>
      <div class="mobile-track"><div class="mobile-fill" style="width:${progress}%"></div></div>
      ${showThumbnails && task.thumbnailUrl ? `<span class="mobile-preview media-preview"><img src="${escapeHtml(task.thumbnailUrl)}" alt="媒体封面" loading="lazy" decoding="async" /></span>` : ''}
      ${postView(task)}
      <div class="mobile-meta">
        <span class="mobile-message">${escapeHtml(meta)}</span>
        <span>${progress ? `${Math.round(progress)}%` : ''}</span>
      </div>
      ${actions.length ? `<div class="mobile-task-actions">${actions.join('')}</div>` : ''}
    </article>`;
}

function render() {
  if (renderFrame) return;
  renderFrame = requestAnimationFrame(() => {
    renderFrame = 0;
    renderNow();
  });
}

function renderNow() {
  const list = $('#mobileTaskList');
  const visible = tasks.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30);
  if (!visible.length) {
    list.innerHTML = `
      <div class="mobile-empty">
        暂无任务
      </div>`;
    rendered.clear();
    rendered = new Map();
    return;
  }
  if ($('.mobile-empty', list)) list.replaceChildren();
  const fragment = document.createDocumentFragment();
  for (const task of visible) {
    const signature = JSON.stringify([task, showThumbnails]);
    let node = rendered.get(task.id);
    if (!node || node.dataset.signature !== signature) {
      const holder = document.createElement('template');
      holder.innerHTML = template(task).trim();
      const next = holder.content.firstElementChild;
      if (!next) continue;
      if (node) node.replaceWith(next);
      node = next;
      node.dataset.signature = signature;
      rendered.set(task.id, node);
    }
    fragment.append(node);
  }
  const visibleIds = new Set(visible.map((task) => task.id));
  for (const [key, node] of rendered) {
    if (visibleIds.has(key)) continue;
    node.remove();
    rendered.delete(key);
  }
  list.replaceChildren(fragment);
}

function upsert(task) {
  if (!task) return;
  const index = tasks.findIndex((item) => item.id === task.id);
  if (index >= 0) {
    const previous = tasks[index];
    if (previous.status !== 'completed' && task.status === 'completed' && navigator.vibrate) navigator.vibrate(35);
    tasks[index] = task;
  } else {
    tasks.push(task);
  }
  render();
}

function setConnection(online, label) {
  const node = $('#connection');
  node.classList.toggle('online', online);
  node.classList.toggle('offline', !online);
  $('span:last-child', node).textContent = label;
  const live = $('#liveLabel');
  live.textContent = online ? '实时同步中' : '连接已断开';
  live.classList.toggle('live', online);
}

function updateConnection() {
  setConnection(lastCobaltOnline, lastCobaltOnline ? '电脑在线' : '服务未连接');
}

async function load() {
  try {
    const data = await api('/api/bootstrap');
    tasks = data.tasks || [];
    showThumbnails = data.settings?.showThumbnails !== false;
    document.documentElement.dataset.connected = '1';
    $('#mobileBootStatus').hidden = true;
    render();
    lastCobaltOnline = Boolean(data.cobalt?.online);
    updateConnection();
    connect();
  } catch (error) {
    setConnection(false, '连接失败');
    message(`无法连接电脑：${error.message}。请确认同一 Wi-Fi，并在系统浏览器打开 http 地址。`);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (document.hidden) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    if (!source) load();
  }, 2500);
}

function connect() {
  source?.close();
  clearInterval(pollTimer);
  if (!window.EventSource) {
    pollTimer = setInterval(() => loadSnapshot().catch(() => setConnection(false, '连接失败')), 3000);
    return;
  }
  source = new EventSource('/api/events');
  source.addEventListener('open', () => {
    lastCobaltOnline = true;
    setConnection(true, '电脑在线');
  });
  source.addEventListener('ready', async () => {
    try {
      const data = await api('/api/bootstrap');
      tasks = data.tasks || [];
      showThumbnails = data.settings?.showThumbnails !== false;
      render();
      lastCobaltOnline = Boolean(data.cobalt?.online);
      updateConnection();
    } catch {}
  });
  const events = ['added', 'updated', 'progress', 'queued', 'completed', 'failed', 'canceled', 'removed'];
  for (const name of events) {
    source.addEventListener(name, (event) => {
      try {
        const data = JSON.parse(event.data);
        if (name === 'removed') {
          tasks = tasks.filter((task) => task.id !== data.task?.id);
          render();
        } else {
          upsert(data.task);
        }
      } catch (error) {
        console.warn(error);
      }
    });
  }
  source.onerror = () => {
    setConnection(false, '正在重连');
    if (source.readyState === EventSource.CLOSED) {
      source = null;
      scheduleReconnect();
    }
  };
}

async function loadSnapshot() {
  const data = await api('/api/tasks');
  tasks = data.tasks || [];
  render();
}

function setLive(online) {
  if (document.hidden) {
    clearInterval(pollTimer);
    clearTimeout(reconnectTimer);
    source?.close();
    source = null;
    setConnection(false, '已暂停');
  } else if (online && !source) {
    connect();
    loadSnapshot().catch(() => {});
    updateConnection();
  }
}

async function submit(event) {
  event.preventDefault();
  const button = $('#sendButton');
  const input = $('#mobileUrl');
  const urls = [...new Set(input.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
  if (!urls.length) {
    message('请粘贴至少一个下载链接');
    return;
  }
  if (urls.length > 20) {
    message('一次最多添加 20 个链接');
    return;
  }
  if (urls.some((url) => !looksLikeUrl(url))) {
    message('有链接格式不正确，请每行输入一个完整链接');
    return;
  }
  message('');
  button.disabled = true;
  button.textContent = '正在发送…';
  let added = 0;
  let duplicates = 0;
  const failures = [];
  for (const url of urls) {
    try {
      const data = await api('/api/tasks', {
        method: 'POST',
        body: JSON.stringify({
          url,
          mode: $('#mobileMode').value,
          quality: $('#mobileQuality').value,
        }),
      });
      if (data.duplicate) duplicates += 1;
      else added += 1;
      upsert(data.task);
    } catch (error) {
      failures.push(error.message);
    }
  }
  button.disabled = false;
  button.textContent = '下载';
  if (failures.length) {
    message(failures.slice(0, 2).join('\n'));
    return;
  }
  input.value = '';
  message([added ? `已发送 ${added} 个任务` : '', duplicates ? `${duplicates} 个已在电脑上` : ''].filter(Boolean).join('，'), 'success');
  setTimeout(() => message(''), 4500);
}

async function action(name, id) {
  try {
    await api(`/api/tasks/${encodeURIComponent(id)}/${name}`, { method: 'POST' });
    const data = await api(`/api/tasks/${encodeURIComponent(id)}`);
    upsert(data.task);
  } catch (error) {
    message(error.message);
  }
}

$('#mobileForm').addEventListener('submit', submit);
$('#pasteButton').addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    $('#mobileUrl').value = text.trim();
    $('#mobileUrl').focus();
  } catch {
    $('#mobileUrl').focus();
    message('无法读取剪贴板，请手动长按粘贴');
  }
});
$('#mobileTaskList').addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (button) action(button.dataset.action, button.dataset.id);
});

document.addEventListener('visibilitychange', () => setLive(true));
document.addEventListener('error', (event) => { if (event.target.matches?.('.media-preview img')) event.target.hidden = true; }, true);
document.documentElement.dataset.ready = '1';
load();
