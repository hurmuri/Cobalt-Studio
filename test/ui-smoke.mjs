import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const verificationDir = path.join(ROOT, '.build', 'verification');
fs.mkdirSync(verificationDir, { recursive: true });
const RELEASE = process.env.COBALT_UI_TEST_RELEASE === '1';
const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];
const browser = EDGE_CANDIDATES.find((candidate) => fs.existsSync(candidate));
if (!browser) {
  console.error('No Chromium browser found.');
  process.exit(2);
}

let appPort = 8789;
let appPortActual = 8789;
const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'cobalt-ui-downloads-'));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobalt-ui-data-'));
let mock = null;
let app = null;
let launched = null;
let releaseExecutable;
let releaseEnvironment;
let standaloneCopyDir;
let mockPort = null;
if (!RELEASE) {
  mockPort = (() => {
    const probe = spawnSync(process.execPath, ['-e', "const n=require('node:net');const s=n.createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"], { encoding: 'utf8' });
    return Number(probe.stdout.trim());
  })();
  mock = spawn(process.execPath, [path.join(ROOT, 'test', 'mock-server.mjs')], {
    env: { ...process.env, PORT: String(mockPort) },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  app = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    env: {
      ...process.env,
      PORT: String(appPort),
      HOST: '127.0.0.1',
      COBALT_API_URL: `http://127.0.0.1:${mockPort}`,
      FXTWITTER_API_BASE: `http://127.0.0.1:${mockPort}`,
      DEFAULT_DOWNLOAD_DIR: downloads,
      APP_DATA_DIR: dataDir,
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}
if (RELEASE) {
  let executable = path.join(ROOT, 'release', 'Cobalt Studio', 'Cobalt Studio.exe');
  if (process.env.COBALT_UI_TEST_EXECUTABLE) {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'cobalt-single-exe-'));
    standaloneCopyDir = empty;
    executable = path.join(empty, 'Cobalt Studio.exe');
    fs.copyFileSync(process.env.COBALT_UI_TEST_EXECUTABLE, executable);
    if (fs.readdirSync(empty).length !== 1) throw new Error('Standalone test folder must contain only the EXE.');
  }
  releaseExecutable = executable;
  releaseEnvironment = {
    ...process.env, DEFAULT_DOWNLOAD_DIR: downloads,
    COBALT_STUDIO_DATA_DIR: dataDir, COBALT_STANDALONE_HOME: path.join(dataDir, 'standalone'),
  };
  launched = spawn(executable, [], { detached: true, stdio: 'ignore', env: releaseEnvironment });
  await waitForApp();
}

async function waitFor(url) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`Timed out: ${url}`);
}

async function waitForApp() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const children = spawnSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      `$all=@(Get-CimInstance Win32_Process); $parents=@(${launched.pid}); for($i=0;$i -lt 3;$i++){ $parents+=@($all | Where-Object { $_.ParentProcessId -in $parents } | ForEach-Object ProcessId) }; $p=$all | Where-Object { $_.ProcessId -in $parents -and $_.Name -eq 'node.exe' -and $_.CommandLine -like '*server.mjs*' } | Select-Object -First 1; if($p){ $c=Get-NetTCPConnection -State Listen -OwningProcess $p.ProcessId | Select-Object -First 1; if($c){$c.LocalPort}}`,
    ], { encoding: 'utf8' });
    const port = Number(children.stdout.trim());
    if (port) {
      appPortActual = port;
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Release app did not start.');
}

let cdp = null;
async function verifyMobile() {
  const debugPort = 9334;
  const chrome = spawn(browser, [
    '--headless=new',
    '--no-first-run',
    '--disable-extensions',
    '--disable-sync',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${path.join(os.tmpdir(), `cobalt-mobile-profile-${Date.now()}`)}`,
    `http://127.0.0.1:${appPortActual}/mobile`,
  ], { stdio: ['ignore', 'ignore', 'inherit'] });
  try {
    let page = null;
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
        page = list.find((item) => item.type === 'page' && item.url.includes('/mobile'));
        if (page) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (!page) throw new Error('Mobile page not found.');
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    let nextId = 0;
    const pending = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    });
    const command = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
    await command('Runtime.enable');
    await command('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
      screenWidth: 390,
      screenHeight: 844,
    });
    await command('Page.reload');
    const evaluate = async (expression) => {
      const result = await command('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (await evaluate(`document.documentElement?.dataset.ready === '1' && !!document.querySelector('#mobileTaskList')`)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!(await evaluate(`document.documentElement.dataset.ready === '1'`))) {
      throw new Error('Mobile UI did not finish initializing.');
    }
    const mobileLayout = await evaluate(`(() => {
      const width = document.documentElement.clientWidth;
      const elements = ['.mobile-shell', '.url-box', '.url-box textarea', '#pasteButton', '.mobile-options', '#mobileQuality', '.send-button']
        .map((selector) => {
          const rect = document.querySelector(selector).getBoundingClientRect();
          return { selector, left: rect.left, right: rect.right, width: rect.width };
        });
      return {
        clientWidth: width,
        scrollWidth: document.documentElement.scrollWidth,
        elements,
      };
    })()`);
    if (
      mobileLayout.scrollWidth > mobileLayout.clientWidth ||
      mobileLayout.elements.some((item) => item.left < 0 || item.right > mobileLayout.clientWidth + 0.5)
    ) {
      throw new Error(`Mobile layout overflows horizontally: ${JSON.stringify(mobileLayout)}`);
    }
    const testUrl = RELEASE ? 'https://streamable.com/p9cln4' : 'https://x.com/mock_user/status/12345';
    await evaluate(`document.querySelector('#mobileUrl').value = ${JSON.stringify(testUrl)}`);
    await evaluate(`document.querySelector('#mobileForm').requestSubmit()`);
    for (let attempt = 0; attempt < 160; attempt += 1) {
      if (await evaluate(`document.querySelectorAll('.mobile-task.completed').length > 0`)) break;
      if (attempt === 79 && await evaluate(`document.querySelector('.mobile-task.failed') !== null`)) break;
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    if (!(await evaluate(`document.querySelectorAll('.mobile-task.completed, .mobile-task.failed').length > 0`))) {
      const diagnostic = await evaluate(`({
        form: document.querySelector('#mobileMessage').textContent,
        list: document.querySelector('#mobileTaskList').innerText,
        scripts: [...document.scripts].map(script => script.src),
        html: document.querySelector('#mobileTaskList').innerHTML.slice(0, 500)
      })`);
      throw new Error(`Mobile task row was not rendered: ${JSON.stringify(diagnostic)}`);
    }
    const failed = await evaluate(`document.querySelector('.mobile-task.failed')?.innerText || ''`);
    if (!RELEASE && !(await evaluate(`document.querySelector('.post-source')?.href === 'https://x.com/mock_user/status/12345' && document.querySelector('.post-text')?.textContent.includes('Original post text')`))) {
      throw new Error('Mobile original post data is missing.');
    }
    const mobileShot = await command('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(verificationDir, RELEASE ? 'verified-release-mobile.png' : 'verified-mobile.png'), Buffer.from(mobileShot.data, 'base64'));
    socket.close();
    if (failed) throw new Error(`Mobile task failed: ${failed}`);
    console.log('PASS  mobile UI submits and renders completed tasks');
  } finally {
    chrome.kill();
  }
  await fetch(`http://127.0.0.1:${appPortActual}/api/tasks/clear-finished`, { method: 'POST' });
}

try {
  await waitFor(`http://127.0.0.1:${appPortActual}/api/health`);
  await verifyMobile();
  const debugPort = 9333;
  const chrome = spawn(browser, [
    '--headless=new',
    '--no-first-run',
    '--disable-extensions',
    '--disable-sync',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${path.join(os.tmpdir(), `cobalt-ui-profile-${Date.now()}`)}`,
    `http://127.0.0.1:${appPortActual}/`,
  ], { stdio: ['ignore', 'ignore', 'inherit'] });
  try {
    let page = null;
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
        page = list.find((item) => item.type === 'page' && item.url.includes(`127.0.0.1:${appPortActual}`));
        if (page) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (!page) throw new Error('Chromium page not found.');
    cdp = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      cdp.addEventListener('open', resolve, { once: true });
      cdp.addEventListener('error', reject, { once: true });
    });
    let nextId = 0;
    const pending = new Map();
    cdp.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    });
    const command = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      cdp.send(JSON.stringify({ id, method, params }));
    });
    await command('Runtime.enable');
    const evaluate = async (expression) => {
      // The packaged app can navigate from its loading URL to the final URL
      // shortly after startup. Briefly retry if the execution context changes.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          const result = await command('Runtime.evaluate', {
            expression,
            awaitPromise: true,
            returnByValue: true,
          });
          if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
          return result.result.value;
        } catch (error) {
          if (attempt === 4 || !/context|navigat|destroyed|cannot find/i.test(String(error.message))) {
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
    };
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (await evaluate(`document.documentElement?.dataset.ready === '1' && document.querySelector('#health span')?.textContent === '服务正常'`)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!(await evaluate(`document.documentElement.dataset.ready === '1'`))) {
      throw new Error('Desktop UI did not finish initializing.');
    }
    const initial = await evaluate(`[...document.querySelectorAll('.task-empty')].length === 1 && document.querySelector('#countActive').textContent === '0' && document.querySelector('#countDone').textContent === '0' && !document.querySelector('#qrNav') && !document.querySelector('#folderNav') && !document.querySelector('#settingsButton') && !!document.querySelector('#settingsNav')`);
    if (!initial) throw new Error('Initial desktop state is incorrect.');
    for (const width of [1280, 900]) {
      await command('Emulation.setDeviceMetricsOverride', { width, height: 720, deviceScaleFactor: 1, mobile: false });
      const geometry = await evaluate(`(() => {
        const selectors = ['#quickInput', '#quickDownloadButton', '#newTaskButton', '#qrButton', '#openDirTop'];
        return selectors.map(selector => {
          const n = document.querySelector(selector), r = n.getBoundingClientRect();
          return { selector, center: r.y + r.height / 2, height: r.height, right: r.right };
        });
      })()`);
      if (geometry.some(item => Math.abs(item.center - geometry[0].center) > 0.5 || item.height !== 40 || item.right > width)) throw new Error('Toolbar alignment failed: ' + JSON.stringify(geometry));
      if (await evaluate(`!!document.querySelector('.workspace-heading') || document.querySelector('.content h1') !== null`)) throw new Error('Decorative list heading reappeared');
    }
    const browserErrors = [];
    await command('Runtime.addBinding', { name: '__browserError' });
    cdp.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.bindingCalled' && message.params?.name === '__browserError') {
        browserErrors.push(String(message.params.payload || ''));
      }
    });
    await evaluate(`window.addEventListener('error', (event) => window.__browserError(String(event.error?.stack || event.message)))`);
    await evaluate(`document.querySelector('#settingsNav').click()`);
    const choices = await evaluate(`[...document.querySelector('#settingsConcurrent').options].map(option => Number(option.value))`);
    if (choices.join(',') !== '1,2,3,4,5,6,7,8,9,10') throw new Error('Concurrency choices are incomplete');
    if (!(await evaluate(`document.querySelector('#settingsDialog').open && !!document.querySelector('#settingsProxy') && !!document.querySelector('#settingsMode') && document.querySelector('#settingsDialog .settings-row') !== null`))) {
      throw new Error('Settings dialog is incomplete.');
    }
    if (await evaluate(`document.querySelector('#settingsDialog .field-grid') !== null`)) {
      throw new Error('Settings dialog still uses the old grid layout.');
    }
    const settingsLayout = await evaluate(`(() => {
      const dialog = document.querySelector('#settingsDialog');
      const dialogRect = dialog.getBoundingClientRect();
      const input = document.querySelector('#settingsDir').getBoundingClientRect();
      const open = document.querySelector('#settingsOpenDir').getBoundingClientRect();
      return {
        dialog: dialogRect,
        input,
        open,
        scrollHeight: dialog.scrollHeight,
        clientHeight: dialog.clientHeight,
      };
    })()`);
    if (
      settingsLayout.input.right > settingsLayout.dialog.right ||
      settingsLayout.open.right > settingsLayout.dialog.right ||
      settingsLayout.input.width < 160 ||
      settingsLayout.scrollHeight > settingsLayout.clientHeight + 1
    ) {
      throw new Error(`Settings controls are clipped: ${JSON.stringify(settingsLayout)}`);
    }
    await evaluate(`document.querySelector('#settingsDialog').close()`);
    const folderClicked = await evaluate(`(async () => {
      const calls = [];
      const original = window.fetch;
      window.fetch = (input, options) => {
        calls.push(String(input));
        return original(input, options);
      };
      const originalPostMessage = window.chrome?.webview?.postMessage;
      if (window.chrome?.webview) {
        window.chrome.webview.postMessage = (message) => calls.push(JSON.stringify(message));
      }
      document.querySelector('#openDirTop').click();
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (window.chrome?.webview) window.chrome.webview.postMessage = originalPostMessage;
      window.fetch = original;
      return calls;
    })()`);
    if (!folderClicked.some((value) => value.includes('/api/open-directory') || value.includes('open-downloads')) || folderClicked.some((value) => value.includes('/api/settings'))) {
      throw new Error(`Top folder button did not open the download directory: ${JSON.stringify(folderClicked)}`);
    }
    await evaluate(`document.querySelector('#qrButton').click()`);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (await evaluate(`document.querySelector('#qrFrame img')?.complete && !!document.querySelector('#qrUrl').textContent`)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const qrUrl = await evaluate(`document.querySelector('#qrUrl').textContent`);
    if (!qrUrl.startsWith('http://') || !qrUrl.endsWith('/mobile') || qrUrl.includes('127.0.0.1')) {
      throw new Error(`QR URL is not LAN reachable: ${qrUrl}`);
    }
    if (await evaluate(`!!document.querySelector('#pathShort')`)) {
      throw new Error('Internal download path is still displayed.');
    }
    const visibleSummary = await evaluate(`document.querySelector('.list-summary').innerText.trim()`);
    if (!visibleSummary || visibleSummary.includes('downloads')) {
      throw new Error(`Task summary exposes internal storage details: ${visibleSummary}`);
    }
    const qrRendering = await evaluate(`(() => {
      const image = document.querySelector('#qrFrame img');
      const source = decodeURIComponent(image.src.split(',').slice(1).join(','));
      const svg = new DOMParser().parseFromString(source, 'image/svg+xml').documentElement;
      const cells = Number(svg.getAttribute('viewBox').split(' ')[2]);
      return {
        isolated: !document.querySelector('#qrFrame svg'),
        width: image.getBoundingClientRect().width,
        modulePixels: image.getBoundingClientRect().width / cells,
        square: image.width === image.height,
        crisp: svg.getAttribute('shape-rendering'),
      };
    })()`);
    if (!qrRendering.isolated || !qrRendering.square || qrRendering.width < 180 || !Number.isInteger(qrRendering.modulePixels) || qrRendering.crisp !== 'crispEdges') {
      throw new Error(`QR rendering is invalid: ${JSON.stringify(qrRendering)}`);
    }
    const qrOptions = await evaluate(`Array.from(document.querySelector('#qrAddress').options, o => o.value)`);
    const qrEvidence = [];
    for (const address of qrOptions) {
      await evaluate(`document.querySelector('#qrAddress').value = ${JSON.stringify(address)}; document.querySelector('#qrAddress').dispatchEvent(new Event('change'))`);
      const expected = `http://${address}:${appPortActual}/mobile`;
      for (let attempt = 0; attempt < 50; attempt++) {
        if (await evaluate(`document.querySelector('#qrUrl').textContent === ${JSON.stringify(expected)} && document.querySelector('#qrFrame img')?.complete`)) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!(await evaluate(`document.querySelector('#openMobileLink').href === ${JSON.stringify(expected)} && !document.querySelector('#copyQrUrl').disabled`))) throw new Error(`QR address did not update: ${address}`);
      const rect = await evaluate(`(() => {const r=document.querySelector('#qrFrame img').getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1}})()`);
      const shot = await command('Page.captureScreenshot', {format:'png', clip:rect});
      const filename = `qr-${RELEASE ? 'release' : 'source'}-${address}.png`;
      fs.writeFileSync(path.join(verificationDir, filename), Buffer.from(shot.data, 'base64'));
      qrEvidence.push({filename, url:expected});
    }
    fs.writeFileSync(path.join(verificationDir, `qr-${RELEASE ? 'release' : 'source'}-evidence.json`), JSON.stringify(qrEvidence, null, 2));
    console.log('PASS  QR images isolate icon styles and address selection updates QR, source URL and browser link');
    await evaluate(`document.querySelector('#qrDialog').close()`);
    await evaluate(`document.querySelector('#newTaskButton').click()`);
    if (!(await evaluate(`document.querySelector('#newTaskDialog').open`))) throw new Error('New task dialog did not open.');
    await evaluate(`document.querySelector('#urlInput').value = ${JSON.stringify(RELEASE ? 'https://streamable.com/p9cln4' : 'https://mock.test/redirect')}`);
    const urlFieldBeforeSubmit = await evaluate(`document.querySelector('#urlInput').value`);
    await evaluate(`document.querySelector('#downloadForm').requestSubmit()`);
    let diagnostic = {};
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await evaluate(`document.querySelector('#countActive').textContent === '1' || document.querySelector('#countDone').textContent === '1'`)) break;
      if (attempt % 20 === 19) {
        diagnostic = await evaluate(`({
          formMessage: document.querySelector('#formMessage').textContent,
          activeCount: document.querySelector('#countActive').textContent,
          doneCount: document.querySelector('#countDone').textContent,
          taskList: document.querySelector('#taskList').innerText,
          dialogOpen: document.querySelector('#newTaskDialog').open,
        urlValue: document.querySelector('#urlInput').value,
          scriptUrl: [...document.scripts].map(script => script.src)
        })`);
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    if (!(await evaluate(`document.querySelector('#countActive').textContent === '1' || document.querySelector('#countDone').textContent === '1'`))) {
      throw new Error(`Task row was not rendered: ${urlFieldBeforeSubmit} ${JSON.stringify(diagnostic)}`);
    }
    await evaluate(`document.querySelector('[data-filter="done"]').click()`);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await evaluate(`document.querySelectorAll('.task-row.completed').length > 0`)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const completed = await evaluate(`document.querySelector('.task-row.completed .task-name')?.textContent || ''`);
    if (!completed) {
      const diagnostic = await evaluate(`({status:document.querySelector('.task-row')?.className,text:document.querySelector('#taskList').innerText})`);
      throw new Error(`Completed task was not rendered: ${JSON.stringify(diagnostic)}`);
    }
    if (!RELEASE) {
      await evaluate(`document.querySelector('#quickInput').value = 'https://x.com/mock_user/status/54321'; document.querySelector('#quickDownloadButton').click()`);
      for (let attempt = 0; attempt < 80; attempt++) {
        if (await evaluate(`document.querySelectorAll('.task-row.completed').length >= 2 && document.querySelector('.post-text')?.textContent.includes('Original post text')`)) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await evaluate(`document.querySelector('[data-filter="done"]').click()`);
      if (!(await evaluate(`!document.querySelector('#newTaskDialog').open && document.querySelectorAll('.task-row.completed').length >= 2 && !!document.querySelector('.post-text') && !document.querySelector('.post-info script')`))) {
        const details = await evaluate(`({dialog:document.querySelector('#newTaskDialog').open,completed:document.querySelectorAll('.task-row.completed').length,list:document.querySelector('#taskList').innerText,toast:document.querySelector('#toast')?.innerText})`);
        throw new Error(`Quick download or original post rendering failed: ${JSON.stringify(details)}`);
      }
      await evaluate(`document.querySelector('#quickInput').value = 'https://mock.test/tunnel'; document.querySelector('#quickInput').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',bubbles:true}))`);
      for (let attempt = 0; attempt < 60; attempt++) {
        if (await evaluate(`document.querySelector('#countDone').textContent === '3'`)) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!(await evaluate(`!document.querySelector('#newTaskDialog').open && document.querySelector('#countDone').textContent === '3'`))) throw new Error('Enter did not download directly.');
      await evaluate(`document.querySelector('[data-filter="done"]').click(); document.querySelector('#settingsNav').click(); document.querySelector('#settingsThumbnails').checked = false; document.querySelector('#settingsForm').requestSubmit()`);
      for (let attempt = 0; attempt < 30; attempt++) {
        if (await evaluate(`!document.querySelector('#settingsDialog').open && document.querySelectorAll('.media-preview img').length === 0`)) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!(await evaluate(`document.querySelectorAll('.media-preview img').length === 0`))) throw new Error('Thumbnail setting did not remove images.');
      await evaluate(`document.querySelector('#settingsNav').click(); document.querySelector('#settingsThumbnails').checked = true; document.querySelector('#settingsForm').requestSubmit()`);
      await new Promise((resolve) => setTimeout(resolve, 650));
      console.log('PASS  direct download, Enter, original post, safe source links and thumbnail toggle');
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    const shot = await command('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(verificationDir, RELEASE ? 'verified-release-desktop.png' : 'verified-desktop.png'), Buffer.from(shot.data, 'base64'));
    if (browserErrors.length) throw new Error(`Browser errors: ${browserErrors.join(' | ')}`);
    console.log('PASS  desktop UI loads and submits');
    console.log('PASS  task list renders active and completed states');
    console.log('PASS  empty state is singular');
    console.log('PASS  settings and folder actions are distinct');
  } finally {
    chrome?.kill();
  }
  if (process.env.COBALT_UI_TEST_EXECUTABLE) {
    const before = await (await fetch(`http://127.0.0.1:${appPortActual}/api/bootstrap`)).json();
    const runtimes = path.join(dataDir, 'standalone', 'runtimes');
    const runtime = path.join(runtimes, fs.readdirSync(runtimes).find((name) => !name.includes('.tmp-')));
    const complete = path.join(runtime, '.complete.json');
    const stamp = fs.statSync(complete).mtimeMs;
    const media = before.tasks.flatMap((task) => task.files || [])[0]?.path;
    if (!media || fs.statSync(media).size === 0) throw new Error('Standalone media output is missing.');
    const decode = spawnSync(path.join(runtime, 'runtime', 'ffmpeg.exe'), ['-v', 'error', '-i', media, '-f', 'null', '-'], { encoding: 'utf8', timeout: 30_000 });
    if (decode.status !== 0) throw new Error(`Standalone media decode failed: ${decode.stderr}`);
    spawnSync('taskkill.exe', ['/PID', String(launched.pid), '/T', '/F'], { stdio: 'ignore' });
    launched = spawn(releaseExecutable, [], { detached: true, stdio: 'ignore', env: releaseEnvironment });
    await waitForApp();
    const after = await (await fetch(`http://127.0.0.1:${appPortActual}/api/bootstrap`)).json();
    const taskIds = (value) => (value.tasks || []).map((task) => task.id).sort().join(',');
    if (!before.tasks?.length || taskIds(before) !== taskIds(after)) throw new Error('Standalone restart lost task state.');
    if (fs.statSync(complete).mtimeMs !== stamp) throw new Error('Valid standalone cache was unnecessarily replaced.');
    if (JSON.stringify(before.settings) !== JSON.stringify(after.settings)) throw new Error('Standalone restart lost settings.');
    console.log('PASS  standalone EXE launches alone, downloads media, reuses cache and preserves tasks on restart');
    spawnSync('taskkill.exe', ['/PID', String(launched.pid), '/T', '/F'], { stdio: 'ignore' });
    const missing = path.join(runtime, 'public', 'index.html');
    fs.unlinkSync(missing);
    launched = spawn(releaseExecutable, [], { detached: true, stdio: 'ignore', env: releaseEnvironment });
    await waitForApp();
    const recovered = await (await fetch(`http://127.0.0.1:${appPortActual}/api/bootstrap`)).json();
    if (!fs.existsSync(missing) || taskIds(before) !== taskIds(recovered)) throw new Error('Standalone cache recovery failed or lost tasks.');
    console.log('PASS  missing standalone resources are restored without losing user data');
  }
} finally {
  cdp?.close();
  app?.kill();
  mock?.kill();
  if (launched) {
    spawnSync('taskkill.exe', ['/PID', String(launched.pid), '/T', '/F'], { stdio: 'ignore' });
  }
  if (standaloneCopyDir) {
    const launcherLog = path.join(dataDir, 'standalone', 'launcher.log');
    if (fs.existsSync(launcherLog)) fs.copyFileSync(launcherLog, path.join(verificationDir, 'standalone-launcher.log'));
    for (const directory of [standaloneCopyDir, dataDir, downloads]) {
      try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
      catch (error) { console.warn(`Test cleanup: ${directory}: ${error.message}`); }
    }
  }
}
