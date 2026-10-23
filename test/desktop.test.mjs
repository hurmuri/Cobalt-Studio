import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT = path.join(ROOT, 'windows', 'CobaltStudio.Desktop.csproj');
const pass = [];
const fail = [];

function check(name, condition, extra = '') {
  (condition ? pass : fail).push(name);
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition ? '' : `  ${extra}`}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', ...options });
  return { code: result.status, out: result.stdout || '', err: result.stderr || '' };
}

const build = run('dotnet', ['build', PROJECT, '-c', 'Release', '--nologo']);
check('Windows 客户端编译通过', build.code === 0, `${build.out}\n${build.err}`.slice(-3000));

const project = fs.readFileSync(PROJECT, 'utf8');
const processRunner = fs.readFileSync(path.join(ROOT, 'windows', 'ProcessRunner.cs'), 'utf8');
const mainForm = fs.readFileSync(path.join(ROOT, 'windows', 'MainForm.cs'), 'utf8');
const firewall = fs.readFileSync(path.join(ROOT, 'windows', 'FirewallManager.cs'), 'utf8');
check('客户端不依赖固定 Web 端口', !/127\.0\.0\.1:8787/.test(fs.readFileSync(path.join(ROOT, 'windows', 'MainForm.cs'), 'utf8')));
check('客户端启用 WebView2', project.includes('Microsoft.Web.WebView2'));
check('客户端提供 Job Object 清理', fs.existsSync(path.join(ROOT, 'windows', 'JobObject.cs')));
check('客户端保留单实例唤醒', fs.existsSync(path.join(ROOT, 'windows', 'SingleInstance.cs')));
check('客户端读取下载目录设置', fs.readFileSync(path.join(ROOT, 'windows', 'MainForm.cs'), 'utf8').includes('ReadDownloadDirectory'));
check(
  '桌面文件夹按钮使用 WebView 原生消息',
  mainForm.includes('IsWebMessageEnabled = true') &&
    mainForm.includes('open-downloads') &&
    mainForm.includes('repair-lan') &&
    processRunner.includes('RefreshLanAccessAsync'),
);
check(
  '文件夹使用异步 Windows Shell 并支持选中文件',
  mainForm.includes('ShellFolders.OpenAsync') && mainForm.includes('open-task') &&
    fs.readFileSync(path.join(ROOT, 'windows', 'ShellFolders.cs'), 'utf8').includes('SHOpenFolderAndSelectItems') &&
    fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8').includes('const args = selectFile ? [`/select,${target}`] : [`/e,${target}`];'),
);
check(
  '局域网防火墙只放行 Private 配置',
  firewall.includes('profile=private') &&
    firewall.includes('Verb = "runas"') &&
    firewall.includes('COBALT_UI_TEST_RELEASE') &&
    firewall.includes('HNetCfg.FwPolicy2') &&
    firewall.includes('LocalPorts') &&
    firewall.includes('HasSingleCurrentRule') &&
    firewall.includes('Rules.Remove') &&
    (firewall.match(/Verb = "runas"/g) || []).length === 1 &&
    !firewall.includes('private static void DeleteRules'),
);
check(
  'cobalt 进程继承系统代理',
  processRunner.includes('AddSystemProxy(env)') &&
    processRunner.includes('ProxyEnable') &&
    processRunner.includes('environment["HTTPS_PROXY"]'),
);
check(
  '局域网修复会回写 Web 状态',
  processRunner.includes('/api/lan-access') &&
    processRunner.includes('JsonSerializer.Serialize(new { ready })'),
);

const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
check('测试脚本包含桌面检查', packageJson.scripts.test.includes('desktop.test.mjs'));
check(
  '后台时降低 WebView2 内存',
  mainForm.includes('TrySuspendAsync') && mainForm.includes('CoreWebView2MemoryUsageTargetLevel.Low'),
);

console.log(`\n${pass.length} passed, ${fail.length} failed`);
process.exit(fail.length ? 1 : 0);
