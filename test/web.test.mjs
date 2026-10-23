import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, '..');
const MOCK_PORT = 9108;
const APP_PORT = 8788;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const APP = `http://127.0.0.1:${APP_PORT}`;
const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'cobalt-web-'));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobalt-data-'));

const pass = [];
const fail = [];
function check(name, condition, extra = '') {
  (condition ? pass : fail).push(name);
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition ? '' : `  ${extra}`}`);
}

function waitFor(url, timeout = 10_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const probe = async () => {
      try {
        const response = await fetch(url);
        if (response.ok) return resolve(response);
      } catch {}
      if (Date.now() - started > timeout) return reject(new Error(`timeout: ${url}`));
      setTimeout(probe, 100);
    };
    probe();
  });
}

async function json(endpoint, options = {}) {
  const response = await fetch(`${APP}${endpoint}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  return { response, body: await response.json() };
}

const mock = spawn(process.execPath, [path.join(DIR, 'mock-server.mjs')], {
  env: { ...process.env, PORT: String(MOCK_PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('mock server timeout')), 8000);
  mock.stdout.on('data', (chunk) => {
    if (String(chunk).includes('mock cobalt')) {
      clearTimeout(timer);
      resolve();
    }
  });
});

const app = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
  env: {
    ...process.env,
    PORT: String(APP_PORT),
    HOST: '127.0.0.1',
    COBALT_API_URL: MOCK,
    FXTWITTER_API_BASE: MOCK,
    DEFAULT_DOWNLOAD_DIR: downloads,
    APP_DATA_DIR: dataDir,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let appOut = '';
app.stdout.on('data', (chunk) => { appOut += chunk; });
app.stderr.on('data', (chunk) => { appOut += chunk; });

try {
  await waitFor(`${APP}/api/health`);
  check('健康检查无需登录', true);
  check('旧的鉴权接口已移除', (await fetch(`${APP}/api/auth/status`)).status === 404);

  const home = await fetch(`${APP}/`);
  const homeText = await home.text();
  check('桌面页面可访问', home.ok && homeText.includes('id="taskList"'), homeText.slice(0, 100));
  check('主界面不展示内部目录和版本', !homeText.includes('id="pathShort"') && !homeText.includes('cobalt 11'));
  check(
    '手机访问弹窗提供局域网诊断',
    homeText.includes('id="copyQrUrl"') && homeText.includes('id="repairLan"'),
  );
  check(
    '桌面导航不重复手机设置与文件夹入口',
    !homeText.includes('id="qrNav"') &&
      !homeText.includes('id="folderNav"') &&
      !homeText.includes('id="settingsButton"') &&
      homeText.includes('id="settingsNav"'),
    homeText.match(/<nav[\s\S]*?<\/nav>/)?.[0]?.slice(0, 500),
  );
  check(
    '桌面功能图标保持原有样式',
    homeText.includes('id="settingsNav"') &&
      homeText.includes('id="qrButton"') &&
      homeText.includes('class="brand-mark"') &&
      homeText.includes('<path d="M3.5 7.5h4M11.5 7.5H20.5M3.5 16.5h7M15 16.5h5.5" />') &&
      homeText.includes('<circle cx="9.5" cy="7.5" r="2" />') &&
      homeText.includes('<rect x="3.5" y="3.5" width="6" height="6" rx="1" />') &&
      homeText.includes('M3 8h7l2 2h9v9H3z'),
  );
  check(
    '品牌和窗口图标使用 Cobalt 标',
    homeText.includes('class="brand-bars" d="M20 15h9v34h-9zM35 15h9v13H35zM35 34h9v15H35z"') &&
      (await (await fetch(`${APP}/favicon.svg`)).text()).includes('fill="#10221d"'),
  );

  const mobile = await fetch(`${APP}/mobile`);
  const mobileText = await mobile.text();
  check('手机页面无需登录', mobile.ok && mobileText.includes('id="mobileTaskList"'), mobileText.slice(0, 100));
  const mobileCss = await (await fetch(`${APP}/mobile.css`)).text();
  check('手机页面使用紧凑样式', mobileCss.includes('.mobile-options') && !mobileCss.includes('radial-gradient'), mobileCss.slice(0, 100));
  const sharedTheme = await (await fetch(`${APP}/theme.css`)).text();
  check('手机与桌面共享字体，中文优先使用本机字体', mobileCss.includes("@import url('/theme.css')") && sharedTheme.indexOf("'Microsoft YaHei UI'") < sharedTheme.indexOf("'Noto Sans SC'"));

  const bootstrap = await json('/api/bootstrap');
  check('启动接口识别 cobalt 实例', bootstrap.body.ok && bootstrap.body.cobalt.online, JSON.stringify(bootstrap.body));
  check('下载目录可持久化', bootstrap.body.settings.downloadDir === downloads, bootstrap.body.settings?.downloadDir);
  check(
    '公共设置不暴露运行目录',
    !bootstrap.body.settings.downloadDirLabel && !bootstrap.body.settings.bindings,
    JSON.stringify(bootstrap.body.settings),
  );
  check('启动接口返回实际端口', bootstrap.body.app.port === APP_PORT, String(bootstrap.body.app?.port));
  check('启动接口报告代理模式', ['system', 'direct'].includes(bootstrap.body.settings.proxyMode), String(bootstrap.body.settings?.proxyMode));

  const qr = await json('/api/qr');
  check(
    '扫码接口生成服务器端二维码',
    qr.body.ok &&
      qr.body.url.endsWith('/mobile') &&
      qr.body.svg?.includes('<svg') &&
      qr.body.svg.includes('shape-rendering="crispEdges"'),
    JSON.stringify(qr.body).slice(0, 200),
  );
  const { preferredLanAddress } = await import('../lib/network.mjs');
  const preferred = await preferredLanAddress();
  check(
    '扫码地址使用默认联网网卡',
    preferred && qr.body.url === `http://${preferred.address}:${APP_PORT}/mobile`,
    JSON.stringify({ url: qr.body.url, preferred }),
  );
  check('扫码接口报告局域网访问状态', typeof qr.body.lanAccessReady === 'boolean', JSON.stringify(qr.body).slice(0, 200));
  check('扫码默认地址和选项一致', qr.body.addresses[0]?.address === qr.body.selectedAddress);
  for (const address of qr.body.addresses) {
    const selected = await json(`/api/qr?address=${encodeURIComponent(address.address)}`);
    check(`二维码可切换 ${address.kind} ${address.address}`, selected.body.selectedAddress === address.address &&
      selected.body.url === `http://${address.address}:${APP_PORT}/mobile` && selected.body.svg?.includes('<svg'));
  }
  check('扫码拒绝任意外部或回环地址', (await json('/api/qr?address=127.0.0.1')).response.status === 400 &&
    (await json('/api/qr?address=https%3A%2F%2Fevil.test')).response.status === 400);
  const lanUnavailable = await json('/api/lan-access', {
    method: 'POST',
    body: JSON.stringify({ ready: false }),
  });
  check(
    '局域网状态可被桌面客户端回写',
    lanUnavailable.response.status === 200 &&
      lanUnavailable.body.lanAccessReady === false &&
      (await json('/api/qr')).body.lanAccessReady === false,
    JSON.stringify(lanUnavailable.body),
  );
  const lanAvailable = await json('/api/lan-access', {
    method: 'POST',
    body: JSON.stringify({ ready: true }),
  });
  check(
    '局域网状态恢复后二维码同步',
    lanAvailable.response.status === 200 &&
      lanAvailable.body.lanAccessReady === true &&
      (await json('/api/bootstrap')).body.lanAccessReady === true,
    JSON.stringify(lanAvailable.body),
  );

  const created = await json('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ url: 'https://mock.test/redirect', mode: 'auto', allowDuplicate: true }),
  });
  check('创建下载任务', created.response.status === 202 && created.body.task.status, JSON.stringify(created.body));
  const id = created.body.task.id;

  let task = null;
  for (let i = 0; i < 60; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    const current = await json(`/api/tasks/${id}`);
    task = current.body.task;
    if (['completed', 'failed'].includes(task?.status)) break;
  }
  check('后台完成下载', task?.status === 'completed', JSON.stringify(task));
  check('下载文件真实存在', task?.files?.[0]?.size > 1000, JSON.stringify(task?.files));
  check('下载文件名称正确', task?.files?.[0]?.name.startsWith('redirect_test') && task?.files?.[0]?.name.endsWith('.mp4'), task?.files?.[0]?.name);
  check(
    '完成态字节数来自最终文件',
    task?.received === task?.files?.[0]?.size && task?.total >= task.received,
    JSON.stringify({ received: task?.received, total: task?.total, size: task?.files?.[0]?.size }),
  );
  check('完成态不会接受空文件', task?.received > 0 && task?.files?.[0]?.size > 0, JSON.stringify(task));
  const thumbnail = await fetch(`${APP}${task.thumbnailUrl}`);
  check('已完成视频生成实际缩略图', thumbnail.ok && thumbnail.headers.get('content-type') === 'image/jpeg' && (await thumbnail.arrayBuffer()).byteLength > 100);
  await json('/api/settings', { method: 'PATCH', body: JSON.stringify({ showThumbnails: false }) });
  check('关闭缩略图后服务不再生成或提供封面', (await fetch(`${APP}${task.thumbnailUrl}`)).status === 404);
  check('缩略图开关持久化', JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')).showThumbnails === false);
  check('缩略图开关拒绝无效类型', (await json('/api/settings', { method: 'PATCH', body: JSON.stringify({ showThumbnails: 'false' }) })).response.status === 400);
  await json('/api/settings', { method: 'PATCH', body: JSON.stringify({ showThumbnails: true }) });
  const xTask = await json('/api/tasks', { method: 'POST', body: JSON.stringify({ url: 'https://x.com/mock_user/status/12345' }) });
  let postTask;
  for (let i = 0; i < 40; i++) {
    postTask = (await json(`/api/tasks/${xTask.body.task.id}`)).body.task;
    if (['completed', 'failed'].includes(postTask.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  check('X 备用下载保存原帖作者正文和源地址', postTask.status === 'completed' && postTask.post?.author === 'Test Author' && postTask.post?.text.includes('<script>') && postTask.post?.sourceUrl === postTask.url);
  const { postView } = await import('../public/post-view.js');
  const postHtml = postView(postTask);
  check('帖子展示转义原文并保留可打开的源链接', postHtml.includes('&lt;script&gt;') && !postHtml.includes('<script>') && postHtml.includes('https://x.com/mock_user/status/12345') && postHtml.includes('rel="noreferrer"'));
  const { remoteThumbnail } = await import('../lib/thumbnails.mjs');
  check('远程封面拒绝内网和非图片源地址', !remoteThumbnail({ post: { thumbnail: 'http://127.0.0.1/admin' } }) && !remoteThumbnail({ post: { thumbnail: 'https://evil.test/image.jpg' } }));

  const file = await fetch(`${APP}${task.files[0].downloadUrl}`);
  check('文件下载接口返回文件', file.ok && Number(file.headers.get('content-length')) > 1000, String(file.status));
  check('文件接口支持分段', file.headers.get('accept-ranges') === 'bytes');

  const range = await fetch(`${APP}${task.files[0].downloadUrl}`, { headers: { Range: 'bytes=0-99' } });
  check('文件范围请求可用', range.status === 206 && Number(range.headers.get('content-length')) === 100, String(range.status));

  const duplicates = await json('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ url: 'https://mock.test/redirect', mode: 'auto', allowDuplicate: true }),
  });
  check('显式允许时重复任务可用', duplicates.response.status === 202 && duplicates.body.duplicate === false, JSON.stringify(duplicates.body));
  const id2 = duplicates.body.task.id;
  await json(`/api/tasks/${id2}`, { method: 'DELETE' });
  const duplicateAllowed = await json('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ url: 'https://mock.test/redirect', mode: 'auto' }),
  });
  check('完成后默认允许再次下载', duplicateAllowed.response.status === 202, JSON.stringify(duplicateAllowed.body));

  const updater = await json('/api/settings', {
    method: 'PATCH',
    body: JSON.stringify({
      downloadDir: downloads,
      maxConcurrent: 3,
      picker: 'all',
      filenameStyle: 'pretty',
      downloadMode: 'audio',
      videoQuality: '1080',
      audioFormat: 'mp3',
    }),
  });
  check(
    '下载设置可保存',
    updater.body.ok &&
      updater.body.settings.maxConcurrent === 3 &&
      updater.body.settings.downloadMode === 'audio' &&
      updater.body.settings.videoQuality === '1080' &&
      updater.body.settings.audioFormat === 'mp3',
    JSON.stringify(updater.body),
  );

  const openDirectory = await json('/api/open-directory', { method: 'POST' });
  check('本机打开目录接口可用', openDirectory.response.status === 200 || openDirectory.response.status === 501, JSON.stringify(openDirectory.body));

  const openFile = await json(`/api/tasks/${id}/open`, { method: 'POST' });
  check('本机打开文件位置接口可用', [200, 404, 501].includes(openFile.response.status), JSON.stringify(openFile.body));

  const event = await new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error('SSE timeout'));
    }, 3000);
    fetch(`${APP}/api/events`, { signal: controller.signal })
      .then(async (response) => {
        const reader = response.body.getReader();
        const text = await reader.read();
        clearTimeout(timer);
        controller.abort();
        resolve(new TextDecoder().decode(text.value));
      })
      .catch(reject);
  });
  check('SSE 实时通道可用', event.includes('event: ready'), event);

  const bad = await json('/api/tasks', { method: 'POST', body: JSON.stringify({ url: 'javascript:alert(1)' }) });
  check('非法链接被拒绝', bad.response.status === 400, JSON.stringify(bad.body));

  const fixedOutput = path.join(downloads, 'should-not-exist');
  const remoteOutput = await json('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ url: 'https://mock.test/redirect', outputDir: fixedOutput }),
  });
  check(
    '提交任务不能覆盖服务端下载目录',
    remoteOutput.response.status === 202 && JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')).downloadDir === downloads &&
      !fs.existsSync(fixedOutput),
    JSON.stringify(remoteOutput.body),
  );
  if (remoteOutput.body.task?.id) {
    await json(`/api/tasks/${remoteOutput.body.task.id}`, { method: 'DELETE' });
  }

  await new Promise((resolve) => setTimeout(resolve, 500));
  const settingsFile = path.join(dataDir, 'settings.json');
  const tasksFile = path.join(dataDir, 'tasks.json');
  check('设置持久化到磁盘', fs.existsSync(settingsFile) && JSON.parse(fs.readFileSync(settingsFile, 'utf8')).maxConcurrent === 3);
  check('任务持久化到磁盘', fs.existsSync(tasksFile) && JSON.parse(fs.readFileSync(tasksFile, 'utf8')).tasks.some((item) => item.id === id));

  app.kill();
  await new Promise((resolve) => setTimeout(resolve, 500));
  const recoverySource = fs.readFileSync(path.join(ROOT, 'lib', 'store.mjs'), 'utf8');
  check('重启时活动任务会自动恢复', recoverySource.includes("task.status = 'queued'") && recoverySource.includes("task.progress = 0"));
} finally {
  app.kill();
  mock.kill();
}

console.log(`\n${pass.length} passed, ${fail.length} failed`);
if (fail.length) console.log(`failed: ${fail.join(' | ')}`);
if (fail.length && appOut) console.log(`server output:\n${appOut.slice(-2000)}`);
process.exit(fail.length ? 1 : 0);
