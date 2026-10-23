import { postView } from './post-view.js';
import { setupMotion } from './motion.js';
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const ICONS = {
  file: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5h8l4 4V20.5H6z"/><path d="M14 3.5v4h4M9 12h6M9 15h5"/></svg>',
  video: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="6" width="17" height="12" rx="1"/><path d="m10 9 5 3-5 3z"/></svg>',
  audio: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 17.5V6l9-2v11.5"/><circle cx="6.5" cy="17.5" r="2.5"/><circle cx="15.5" cy="15.5" r="2.5"/></svg>',
  folder: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h7l2 2h9v10H3z"/><path d="M3 7V5h7l2 2h7"/></svg>',
  retry: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.5 8.5A8 8 0 1 0 20 14"/><path d="M19.5 4v4.5H15"/></svg>',
  cancel: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>',
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M9 7V4.5h6V7M7 7l1 13h8l1-13M10 10.5v6M14 10.5v6"/></svg>',
};

const state = {
  tasks: [],
  settings: null,
  filter: 'active',
  query: '',
  eventSource: null,
  nodes: new Map(),
  pendingDelete: null,
  renderQueued: false,
  bootstrapPromise: null,
  qrRequest: 0,
  qrAbort: null,
};
const nodeParts = new WeakMap();

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

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

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      'X-Client': 'desktop',
      ...options.headers,
    },
  });
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = { ok: false, error: { message: `响应解析失败 (${response.status})` } };
  }
  if (!response.ok && !data?.duplicate) {
    const error = new Error(data?.error?.message || `请求失败 (${response.status})`);
    error.code = data?.error?.code;
    error.status = response.status;
    throw error;
  }
  return data;
}

function setMessage(message, type = '') {
  const node = $('#formMessage');
  if (!node) return;
  node.textContent = message || '';
  node.className = `form-message${type ? ` ${type}` : ''}`;
}

let toastTimer = 0;
function showToast(message, type = 'error') {
  const node = $('#toast');
  if (!node) return;
  node.textContent = message;
  node.className = `toast visible ${type}`;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    node.className = `toast ${type}`;
  }, 4200);
}

function setPageVisible(visible) {
  document.documentElement.classList.toggle('page-hidden', !visible);
  if (visible) {
    if (!state.eventSource || state.eventSource.readyState === EventSource.CLOSED) connectEvents();
  } else {
    state.eventSource?.close();
    state.eventSource = null;
  }
}

function updateDocumentTitle() {
  const active = state.tasks.filter(isActive).length;
  const running = state.tasks.some((task) => task.status === 'downloading' || task.status === 'processing');
  document.title = running ? `下载中 (${active}) · Cobalt Studio` : 'Cobalt Studio · 下载控制台';
}

function formatDate(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatEta(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '';
  if (seconds < 60) return `约 ${Math.max(1, Math.ceil(seconds))} 秒`;
  if (seconds < 3600) return `约 ${Math.ceil(seconds / 60)} 分钟`;
  return `约 ${Math.floor(seconds / 3600)} 小时 ${Math.ceil((seconds % 3600) / 60)} 分`;
}

function isActive(task) {
  return ['queued', 'resolving', 'downloading', 'processing'].includes(task.status);
}

function matchesFilter(task) {
  if (state.filter === 'active') return isActive(task);
  if (state.filter === 'done') return !isActive(task);
  return true;
}

function matchesSearch(task) {
  const query = state.query.trim().toLocaleLowerCase();
  if (!query || looksLikeUrl(query)) return true;
  return `${task.title || ''}\n${task.url || ''}\n${task.post?.text || ''}\n${task.post?.author || ''}\n${(task.files || []).map((file) => file.name).join('\n')}`
    .toLocaleLowerCase()
    .includes(query);
}

function visibleTasks() {
  return [...state.tasks]
    .filter((task) => matchesFilter(task) && matchesSearch(task))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function taskIcon(task) {
  const first = task.files?.[0];
  const extension = String(first?.name || task.title || '').split('.').pop()?.toLowerCase();
  if (/(mp3|m4a|aac|ogg|opus|wav|flac)$/.test(extension || '')) return ICONS.audio;
  if (/(mp4|mkv|webm|mov|avi|m4v)$/.test(extension || '')) return ICONS.video;
  return ICONS.file;
}

function primaryFile(task) {
  return task.files?.[0] || null;
}

function fileSizeLabel(task) {
  const file = primaryFile(task);
  if (file?.size) return formatBytes(file.size);
  return task.totalLabel || (task.total ? formatBytes(task.total) : '');
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let amount = value;
  let index = -1;
  do {
    amount /= 1024;
    index += 1;
  } while (amount >= 1024 && index < units.length - 1);
  return `${amount.toFixed(amount >= 100 ? 0 : 1)} ${units[index]}`;
}

function taskDetail(task) {
  if (task.status === 'completed') {
    const fileCount = task.files?.length || 0;
    const filePart = fileCount > 1 ? `${fileCount} 个文件` : fileSizeLabel(task);
    return [formatDate(task.finishedAt || task.createdAt), filePart].filter(Boolean).join('    ');
  }
  if (task.status === 'failed') return task.error || task.message || '下载失败';
  if (task.status === 'canceled') return task.message || '已取消';
  if (task.total) {
    return [
      `${task.receivedLabel || formatBytes(task.received)} / ${task.totalLabel || formatBytes(task.total)}`,
      task.speedLabel,
      task.eta ? formatEta(task.eta) : '',
    ].filter(Boolean).join('  ·  ');
  }
  return task.message || (task.status === 'queued' ? '等待开始' : '正在获取信息');
}

function actionsFor(task) {
  const actions = [];
  if (isActive(task)) actions.push(['cancel', '取消', ICONS.cancel]);
  if (['failed', 'canceled'].includes(task.status)) actions.push(['retry', '重试', ICONS.retry]);
  if (task.status === 'completed' && task.files?.length) actions.push(['open', '打开位置', ICONS.folder]);
  actions.push(['delete', '删除', ICONS.trash]);
  return actions
    .map(([action, label, icon]) =>
      `<button class="task-action" data-action="${action}" data-id="${escapeHtml(task.id)}" type="button" title="${label}" aria-label="${label}">${icon}</button>`)
    .join('');
}

function taskRow(task) {
  const progress = task.status === 'completed' ? 100 : Math.max(0, Math.min(99, Number(task.progress) || 0));
  const file = primaryFile(task);
  const title = task.title || (file?.name || '正在获取标题…');
  const thumbnail = state.settings?.showThumbnails !== false && task.thumbnailUrl;
  const titleNode = task.status === 'completed' && file
    ? `<a href="${escapeHtml(file.downloadUrl)}" download="${escapeHtml(file.name)}" title="${escapeHtml(file.path)}">${escapeHtml(title)}</a>`
    : escapeHtml(title);
  const error = task.status === 'failed' && task.error
    ? `<div class="task-error" title="${escapeHtml(task.error)}">${escapeHtml(task.error)}</div>`
    : '';
  return `
    <article class="task-row ${escapeHtml(task.status)}" data-task-id="${escapeHtml(task.id)}" data-status="${escapeHtml(task.status)}">
      <span class="file-icon ${thumbnail ? 'media-preview' : ''} ${escapeHtml(task.status)}" aria-hidden="true">${taskIcon(task)}${thumbnail ? `<img src="${escapeHtml(task.thumbnailUrl)}" alt="" loading="lazy" decoding="async" />` : ''}</span>
      <div class="task-body">
        ${postView(task)}
        <div class="task-fileline"><p class="task-name" title="${escapeHtml(title)}">${titleNode}</p>
        <div class="task-detail" title="${escapeHtml(taskDetail(task))}">${escapeHtml(taskDetail(task))}</div>
        </div>
        ${isActive(task) ? `
          <div class="task-progress" aria-label="下载进度 ${progress}%">
            <div class="progress-track"><div class="progress-fill" style="width:${progress}%"></div></div>
            <span class="progress-label">${progress ? `${progress}%` : ''}</span>
          </div>` : ''}
        ${error}
      </div>
      <div class="task-actions">${actionsFor(task)}</div>
    </article>`;
}

function createTaskNode(task) {
  const template = document.createElement('template');
  template.innerHTML = taskRow(task).trim();
  const node = template.content.firstElementChild;
  if (!node) return null;
  node.dataset.content = JSON.stringify([task.post, task.thumbnailUrl, state.settings?.showThumbnails]);
  nodeParts.set(node, {
    name: $('.task-name', node),
    detail: $('.task-detail', node),
    fill: $('.progress-fill', node),
    label: $('.progress-label', node),
  });
  return node;
}

function updateTaskNode(node, task) {
  if (node.dataset.status !== task.status) return false;
  if (node.dataset.content !== JSON.stringify([task.post, task.thumbnailUrl, state.settings?.showThumbnails])) return false;
  const parts = nodeParts.get(node);
  if (!parts?.name || !parts.detail) return false;
  const title = task.title || (primaryFile(task)?.name || '正在获取标题…');
  const titleNode = parts.name.firstElementChild;
  if (titleNode) titleNode.textContent = title;
  else parts.name.textContent = title;
  parts.name.title = title;
  const detail = taskDetail(task);
  parts.detail.textContent = detail;
  parts.detail.title = detail;
  if (parts.fill) {
    const progress = task.status === 'completed' ? 100 : Math.max(0, Math.min(99, Number(task.progress) || 0));
    parts.fill.style.width = `${progress}%`;
    if (parts.label) parts.label.textContent = progress ? `${progress}%` : '';
  }
  return true;
}

function updateCounts() {
  $('#countActive').textContent = state.tasks.filter(isActive).length;
  $('#countDone').textContent = state.tasks.filter((task) => !isActive(task)).length;
  updateDocumentTitle();
}

function updateEmptyState(visibleCount) {
  const empty = $('#taskEmpty');
  if (!empty) return;
  empty.hidden = visibleCount > 0 || Boolean(state.query && looksLikeUrl(state.query));
  if (empty.hidden) return;
  const label = $('.task-empty-label', empty);
  if (label) {
    label.textContent =
      state.query && !looksLikeUrl(state.query)
        ? '没有匹配的任务'
        : state.filter === 'done'
          ? '暂无已完成任务'
          : '暂无下载任务';
  }
}

function renderNow() {
  state.renderQueued = false;
  const list = $('#taskList');
  const visible = visibleTasks();
  const visibleIds = new Set(visible.map((task) => task.id));
  const empty = $('#taskEmpty');
  if (empty) empty.hidden = true;

  for (const [id, node] of state.nodes) {
    if (!visibleIds.has(id)) {
      node.remove();
      state.nodes.delete(id);
    }
  }

  for (const task of visible) {
    let node = state.nodes.get(task.id);
    if (!node || !node.isConnected) {
      node = createTaskNode(task);
      if (node) {
        list.append(node);
        state.nodes.set(task.id, node);
      }
    } else if (!updateTaskNode(node, task)) {
      const next = createTaskNode(task);
      if (next) {
        node.replaceWith(next);
        state.nodes.set(task.id, next);
      }
    }
  }

  for (let index = 0; index < visible.length; index += 1) {
    const node = state.nodes.get(visible[index].id);
    if (!node) continue;
    const current = list.children[index];
    if (current !== node) list.insertBefore(node, current || empty || null);
  }

  updateEmptyState(visible.length);
  updateSummary(visible.length);
  updateCounts();
}

function render() {
  if (state.renderQueued) return;
  state.renderQueued = true;
  queueMicrotask(renderNow);
}

function updateSummary(visibleCount) {
  const active = state.tasks.filter(isActive).length;
  const done = state.tasks.filter((task) => !isActive(task)).length;
  const matching = state.query && !looksLikeUrl(state.query);
  const summary = matching
    ? `${visibleCount} 个匹配任务`
    : active
      ? `${active} 个任务进行中${done ? `，${done} 个已完成` : ''}`
      : done ? `${done} 个已完成任务` : '队列空闲';
  $('#queueSummary').textContent = summary;
}

function setFilter(filter) {
  state.filter = filter;
  $$('.tab').forEach((button) => {
    const active = button.dataset.filter === filter;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  render();
}

function setQuickInput(value = '') {
  const input = $('#quickInput');
  if (input) input.value = value;
}

function sortTasks() {
  state.tasks.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function upsertTask(task, options = {}) {
  if (!task) return;
  const index = state.tasks.findIndex((item) => item.id === task.id);
  const previous = index >= 0 ? state.tasks[index] : null;
  if (index >= 0) state.tasks[index] = task;
  else state.tasks.push(task);
  sortTasks();
  if (!options.silent && previous?.status !== 'completed' && task.status === 'completed') {
    showToast(`「${task.title || '文件'}」下载完成`, 'success');
  }
  render();
}

function removeTask(id) {
  state.tasks = state.tasks.filter((task) => task.id !== id);
  const node = state.nodes.get(id);
  node?.remove();
  state.nodes.delete(id);
  render();
}

async function syncTasks() {
  const data = await api('/api/tasks');
  state.tasks = data.tasks || [];
  state.nodes.forEach((node) => node.remove());
  state.nodes.clear();
  sortTasks();
  render();
}

function connectEvents() {
  if (state.eventSource && state.eventSource.readyState !== EventSource.CLOSED) return;
  const source = new EventSource('/api/events');
  state.eventSource = source;
  source.addEventListener('ready', () => {
    updateHealth({ online: true });
    api('/api/bootstrap')
      .then((data) => {
        state.settings = data.settings;
        applySettings();
        updateHealth(data.cobalt);
        return syncTasks();
      })
      .catch(() => {});
  });
  for (const type of ['added', 'updated', 'progress', 'queued', 'completed', 'failed', 'canceled']) {
    source.addEventListener(type, (event) => {
      try {
        upsertTask(JSON.parse(event.data).task);
      } catch (error) {
        console.warn('event parse failed', error);
      }
    });
  }
  source.addEventListener('removed', (event) => {
    try {
      removeTask(JSON.parse(event.data).task?.id);
    } catch {}
  });
  source.addEventListener('bulk_removed', () => {
    syncTasks().catch(() => {});
  });
  source.onerror = () => {
    updateHealth({ online: false });
    if (source.readyState === EventSource.CLOSED) {
      state.eventSource = null;
      window.setTimeout(() => {
        if (!document.hidden && !state.eventSource) connectEvents();
      }, 2500);
    }
  };
}

async function loadBootstrap() {
  if (state.bootstrapPromise) return state.bootstrapPromise;
  state.bootstrapPromise = (async () => {
    try {
      const data = await api('/api/bootstrap');
      state.tasks = data.tasks || [];
      state.settings = data.settings;
      sortTasks();
      render();
      applySettings();
      updateHealth(data.cobalt);
      if (!document.hidden) connectEvents();
    } catch (error) {
      updateHealth({ online: false });
      showToast(`无法连接本地服务：${error.message}`);
    } finally {
      state.bootstrapPromise = null;
    }
  })();
  return state.bootstrapPromise;
}

function updateHealth(info) {
  const node = $('#health');
  if (!node) return;
  const online = Boolean(info?.online);
  node.classList.toggle('online', online);
  node.classList.toggle('offline', !online);
  $('span', node).textContent = online ? '服务正常' : '服务未连接';
}

function applySettings() {
  if (!state.settings) return;
  document.body.dataset.proxy = state.settings.proxyMode || 'direct';
  $('#modeSelect').value = state.settings.downloadMode || 'auto';
  $('#qualitySelect').value = state.settings.videoQuality || 'max';
  $('#formatSelect').value = state.settings.audioFormat || 'best';
  updateMode();
}

function updateMode() {
  const mode = $('#modeSelect').value;
  document.body.dataset.mode = mode;
  $('#submitButton').textContent = mode === 'audio' ? '下载音频' : '立即下载';
}

async function loadQr() {
  const frame = $('#qrFrame');
  if (!frame) return;
  const request = ++state.qrRequest;
  state.qrAbort?.abort();
  const controller = new AbortController();
  state.qrAbort = controller;
  const selector = $('#qrAddress');
  const address = selector.value;
  frame.textContent = '正在生成二维码';
  frame.setAttribute('aria-busy', 'true');
  $('#qrUrl').textContent = '';
  $('#copyQrUrl').disabled = true;
  $('#openMobileLink').removeAttribute('href');
  try {
    let data;
    try {
      data = await api(`/api/qr${address ? `?address=${encodeURIComponent(address)}` : ''}`, { signal: controller.signal });
    } catch (error) {
      if (error.code !== 'network.address_unavailable') throw error;
      data = await api('/api/qr', { signal: controller.signal });
      if (request === state.qrRequest) showToast('原地址已不可用，已刷新地址列表');
    }
    if (request !== state.qrRequest) return;
    selector.replaceChildren(...data.addresses.map((item, index) => {
      const option = document.createElement('option');
      option.value = item.address;
      option.textContent = `${item.kind === 'tailscale' ? 'Tailscale' : '局域网'} · ${item.address} · ${item.name}${index === 0 ? '（默认）' : ''}`;
      return option;
    }));
    selector.disabled = !data.addresses.length;
    selector.value = data.selectedAddress || '';
    const selected = data.addresses.find((item) => item.address === data.selectedAddress);
    $('#qrAddressHint').textContent = selected?.kind === 'tailscale'
      ? '手机和电脑均需连接同一 Tailscale 网络，并允许设备间访问。'
      : '手机与电脑连接同一 Wi-Fi 或局域网后扫码。';
    $('#repairLan').hidden = selected?.kind === 'tailscale';
    frame.replaceChildren();
    if (!data.url) {
      selector.append(new Option('没有可用的 IPv4 地址', ''));
      frame.textContent = '未找到可供手机访问的 IPv4 地址';
      $('#qrAddressHint').textContent = '请连接局域网或启用 Tailscale，然后刷新。';
      $('#qrNetworkLabel').textContent = '暂无可用地址';
      $('#lanDiagnostics').textContent = '';
      return;
    }
    if (data.svg) {
      const image = new Image(data.size, data.size);
      image.alt = '扫码打开手机页面';
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(data.svg)}`;
      frame.append(image);
      await image.decode();
      if (request !== state.qrRequest) return;
    }
    if (!data.svg) {
      const link = document.createElement('a');
      link.href = data.url;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.textContent = '在浏览器打开手机页面';
      frame.append(link);
    }
    $('#qrUrl').textContent = data.url;
    $('#openMobileLink').href = data.url;
    $('#copyQrUrl').disabled = false;
    if (state.settings) state.settings.lanAccessReady = data.lanAccessReady !== false;
    updateQrNetwork(data);
  } catch (error) {
    if (request !== state.qrRequest || error.name === 'AbortError') return;
    frame.textContent = error.message;
    $('#qrNetworkLabel').textContent = '无法读取局域网状态';
  } finally {
    if (request === state.qrRequest) frame.setAttribute('aria-busy', 'false');
  }
}

function updateQrNetwork(data) {
  const label = $('#qrNetworkLabel');
  if (!label) return;
  const ready = data.lanAccessReady !== false;
  label.textContent = ready
    ? '防火墙规则已配置，等待手机实际连接验证'
    : 'Windows 防火墙尚未允许局域网访问';
  label.dataset.ready = ready ? '1' : '0';
  $('#lanDiagnostics').textContent = data.lastMobileVisit
    ? `最近手机请求：${data.lastMobileVisit.address} · ${formatDate(data.lastMobileVisit.at)}`
    : '尚未收到手机的页面请求；扫码后点刷新可检查。';
}

function openNewTask(value = '') {
  const dialog = $('#newTaskDialog');
  if (!dialog) return;
  if (!state.settings) loadBootstrap();
  setMessage('');
  if (value) {
    setQuickInput('');
    $('#urlInput').value = value;
  }
  dialog.showModal();
  if (!value) window.setTimeout(() => $('#urlInput').focus(), 40);
}

function closeDialog(id) {
  const dialog = $(`#${id}`);
  if (dialog?.open) dialog.close();
}

async function submitDownload(event) {
  event.preventDefault();
  const input = $('#urlInput');
  const button = $('#submitButton');
  if (button.disabled) return;
  const urls = [...new Set(input.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
  const invalid = urls.filter((url) => !looksLikeUrl(url));
  if (!urls.length) {
    setMessage('请粘贴至少一个下载链接');
    return;
  }
  if (urls.length > 20) {
    setMessage('一次最多添加 20 个链接');
    return;
  }
  if (invalid.length) {
    setMessage(`有 ${invalid.length} 个链接格式不正确，请每行输入一个完整链接`);
    return;
  }
  setMessage('');
  button.disabled = true;
  button.textContent = '添加中…';
  let added = 0;
  let duplicates = 0;
  const failures = [];
  for (const url of urls) {
    try {
      const data = await api('/api/tasks', {
        method: 'POST',
        body: JSON.stringify({
          url,
          mode: $('#modeSelect').value,
          quality: $('#qualitySelect').value,
          format: $('#formatSelect').value,
          picker: state.settings?.picker || 'first',
        }),
      });
      if (data.duplicate) duplicates += 1;
      else added += 1;
      upsertTask(data.task, { silent: true });
    } catch (error) {
      failures.push(error.message);
    }
  }
  button.disabled = false;
  updateMode();
  if (!failures.length) {
    input.value = '';
    setMessage([added ? `已添加 ${added} 个任务` : '', duplicates ? `${duplicates} 个已在队列中` : ''].filter(Boolean).join('，'), 'success');
    window.setTimeout(() => {
      if ($('#newTaskDialog').open) closeDialog('newTaskDialog');
      setMessage('');
    }, 700);
  } else {
    setMessage(failures.slice(0, 2).join('\n') + (failures.length > 2 ? `\n另有 ${failures.length - 2} 个失败` : ''));
  }
}

function askDelete(id) {
  const task = state.tasks.find((item) => item.id === id);
  state.pendingDelete = id;
  $('#confirmTitle').textContent = `删除「${task?.title || '这个任务'}」？`;
  $('#confirmText').textContent = '只会从列表移除，不会删除已经下载的文件。';
  $('#confirmDialog').showModal();
}

async function taskAction(action, id) {
  if (!id) return;
  if (action === 'delete') {
    askDelete(id);
    return;
  }
  try {
    if (action === 'open' && window.chrome?.webview?.postMessage) {
      const button = state.nodes.get(id)?.querySelector('[data-action="open"]');
      await withOpening(button, () => nativeRequest('open-task', { id }));
      return;
    }
    await api(`/api/tasks/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
    const data = await api(`/api/tasks/${encodeURIComponent(id)}`);
    upsertTask(data.task, { silent: true });
  } catch (error) {
    showToast(error.message);
  }
}

function openSettings() {
  if (!state.settings) return;
  $('#settingsDir').value = state.settings.downloadDir;
  $('#settingsDir').removeAttribute('aria-invalid');
  $('#settingsConcurrent').value = String(state.settings.maxConcurrent);
  $('#settingsPicker').value = state.settings.picker;
  $('#settingsThumbnails').checked = state.settings.showThumbnails !== false;
  $('#settingsStyle').value = state.settings.filenameStyle;
  $('#settingsMode').value = state.settings.downloadMode || 'auto';
  $('#settingsQuality').value = state.settings.videoQuality || 'max';
  $('#settingsFormat').value = state.settings.audioFormat || 'best';
  const proxied = state.settings.proxyMode === 'system';
  $('#settingsProxy').textContent = proxied ? '系统代理' : '直接连接';
  $('#settingsProxyHint').textContent = proxied
    ? '下载会自动沿用系统 HTTP/HTTPS 代理'
    : '未检测到系统 HTTP/HTTPS 代理，下载将直接连接';
  $('#settingsMessage').textContent = '';
  $('#settingsDialog').showModal();
}

async function saveSettings(event) {
  event.preventDefault();
  const message = $('#settingsMessage');
  const button = $('#settingsForm .primary-button');
  if (button.disabled) return;
  if (!$('#settingsDir').value.trim()) {
    message.textContent = '请输入保存位置';
    $('#settingsDir').setAttribute('aria-invalid', 'true');
    $('#settingsDir').focus();
    return;
  }
  $('#settingsDir').removeAttribute('aria-invalid');
  message.textContent = '正在保存…';
  message.className = 'form-message';
  button.disabled = true;
  try {
    const data = await api('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify({
        downloadDir: $('#settingsDir').value.trim(),
        maxConcurrent: Number($('#settingsConcurrent').value),
        picker: $('#settingsPicker').value,
        showThumbnails: $('#settingsThumbnails').checked,
        filenameStyle: $('#settingsStyle').value,
        downloadMode: $('#settingsMode').value,
        videoQuality: $('#settingsQuality').value,
        audioFormat: $('#settingsFormat').value,
      }),
    });
    state.settings = data.settings;
    applySettings();
    render();
    updateSummary(visibleTasks().length);
    message.textContent = '设置已保存';
    message.className = 'form-message success';
    window.setTimeout(() => {
      if ($('#settingsDialog').open) closeDialog('settingsDialog');
      message.textContent = '';
      message.className = 'form-message';
    }, 450);
  } catch (error) {
    message.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function confirmDelete() {
  const id = state.pendingDelete;
  state.pendingDelete = null;
  closeDialog('confirmDialog');
  if (!id) return;
  try {
    await api(`/api/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' });
    removeTask(id);
  } catch (error) {
    showToast(error.message);
  }
}

async function clearFinished() {
  try {
    const data = await api('/api/tasks/clear-finished', { method: 'POST' });
    const removed = new Set(data.removed || []);
    state.tasks = state.tasks.filter((task) => !removed.has(task.id));
    for (const id of removed) {
      state.nodes.get(id)?.remove();
      state.nodes.delete(id);
    }
    render();
  } catch (error) {
    showToast(error.message);
  }
}

const nativePending = new Map();
window.chrome?.webview?.addEventListener('message', (event) => {
  const pending = nativePending.get(event.data?.requestId);
  if (!pending) return;
  nativePending.delete(event.data.requestId);
  clearTimeout(pending.timer);
  event.data.ok ? pending.resolve() : pending.reject(new Error(event.data.error || '打开失败'));
});

function nativeRequest(type, payload = {}) {
  const requestId = `${Date.now()}-${Math.random()}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { nativePending.delete(requestId); reject(new Error('打开文件夹超时，请重试')); }, 12000);
    nativePending.set(requestId, { resolve, reject, timer });
    window.chrome.webview.postMessage({ type, requestId, ...payload });
  });
}

async function withOpening(button, open) {
  if (button?.disabled) return;
  if (button) { button.disabled = true; button.setAttribute('aria-busy', 'true'); }
  showToast('正在打开文件夹…', 'success');
  try { await open(); }
  finally { if (button) { button.disabled = false; button.removeAttribute('aria-busy'); } }
}

async function openDownloadDirectory(event) {
  if (!state.settings?.downloadDir) return;
  try {
    await withOpening(event?.currentTarget, () => window.chrome?.webview?.postMessage
      ? nativeRequest('open-downloads') : api('/api/open-directory', { method: 'POST' }));
  } catch (error) {
    showToast(error.message);
  }
}

async function quickDownload() {
  const input = $('#quickInput');
  const url = input.value.trim();
  if (!looksLikeUrl(url)) { showToast('请先输入完整的下载链接'); input.focus(); return; }
  const button = $('#quickDownloadButton');
  if (button.disabled) return;
  button.disabled = true;
  button.textContent = '添加中…';
  try {
    const data = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ url }) });
    upsertTask(data.task, { silent: true });
    input.value = '';
    state.query = '';
    setFilter(isActive(data.task) ? 'active' : 'done');
    showToast(data.duplicate ? '该链接已在任务列表中' : '已加入下载队列', 'success');
  } catch (error) { showToast(error.message); }
  finally { button.disabled = false; button.textContent = '下载'; }
}

function bind() {
  $('#downloadNav').addEventListener('click', () => setFilter('active'));
  $('#quickDownloadButton').addEventListener('click', quickDownload);
  document.addEventListener('error', (event) => { if (event.target.matches?.('.media-preview img')) event.target.hidden = true; }, true);
  document.addEventListener('visibilitychange', () => setPageVisible(!document.hidden));
  $('#downloadForm').addEventListener('submit', submitDownload);
  $('#modeSelect').addEventListener('change', updateMode);
  $('#settingsNav').addEventListener('click', openSettings);
  $('#settingsForm').addEventListener('submit', saveSettings);
  $('#refreshQr').addEventListener('click', loadQr);
  $('#qrAddress').addEventListener('change', loadQr);
  $('#copyQrUrl').addEventListener('click', async () => {
    const url = $('#qrUrl').textContent;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      showToast('手机地址已复制', 'success');
    } catch {
      showToast('无法写入剪贴板，请手动选择地址复制');
    }
  });
  $('#repairLan').addEventListener('click', () => {
    if (window.chrome?.webview?.postMessage) {
      window.chrome.webview.postMessage({ type: 'repair-lan' });
      showToast('正在检查局域网防火墙', 'success');
      window.setTimeout(() => loadQr(), 2500);
    } else {
      showToast('请在 Windows 客户端中执行此操作');
    }
  });
  $('#settingsOpenDir').addEventListener('click', openDownloadDirectory);
  $('#clearFinished').addEventListener('click', clearFinished);
  $('#newTaskButton').addEventListener('click', () => openNewTask());
  $('#qrButton').addEventListener('click', async () => {
    $('#qrDialog').showModal();
    await loadQr();
  });
  $('#openDirTop').addEventListener('click', openDownloadDirectory);
  $('#confirmButton').addEventListener('click', confirmDelete);
  $$('[data-close]').forEach((button) => {
    button.addEventListener('click', () => closeDialog(button.dataset.close));
  });
  $$('.modal').forEach((dialog) => {
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
  });
  $$('.tab').forEach((button) => {
    button.addEventListener('click', () => {
      setFilter(button.dataset.filter);
    });
  });
  $('#quickInput').addEventListener('input', (event) => {
    const value = event.target.value;
    state.query = looksLikeUrl(value) ? '' : value;
    render();
  });
  $('#quickInput').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing) return;
    const value = event.target.value.trim();
    if (!looksLikeUrl(value)) return;
    event.preventDefault();
    quickDownload();
  });
  $('#taskList').addEventListener('click', (event) => {
    const emptyButton = event.target.closest('#emptyNewTask');
    if (emptyButton) {
      openNewTask();
      return;
    }
    const button = event.target.closest('[data-action]');
    if (button) taskAction(button.dataset.action, button.dataset.id);
  });
}

bind();
setupMotion();
document.documentElement.dataset.ready = '1';
loadBootstrap();
