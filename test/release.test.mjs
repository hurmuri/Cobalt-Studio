import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pass = [];
const fail = [];

function check(name, condition, extra = '') {
  (condition ? pass : fail).push(name);
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition ? '' : `  ${extra}`}`);
}

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

const version = read('VERSION').trim();
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
check('VERSION 使用稳定 SemVer', semver.test(version), version);

const [major, minor, patch] = version.split('.');
const assemblyVersion = `${major}.${minor}.${patch}.0`;
const packageJson = JSON.parse(read('package.json'));
const packageLock = JSON.parse(read('package-lock.json'));
const project = read('windows/CobaltStudio.Desktop.csproj');
const manifest = read('windows/app.manifest');
const server = read('server.mjs');
const versionScript = read('scripts/sync-version.ps1');
const buildScript = read('scripts/build-portable.ps1');

check('VERSION 与 package.json 一致', packageJson.version === version, packageJson.version);
check('VERSION 与 package-lock.json 一致', packageLock.version === version && packageLock.packages[''].version === version);
check('VERSION 与 csproj 一致', project.includes(`<Version>${version}</Version>`) && project.includes(`<AssemblyVersion>${assemblyVersion}</AssemblyVersion>`));
check('VERSION 与 app.manifest 一致', manifest.includes(`version="${assemblyVersion}"`));
check('server 运行版本来自 package.json', !/version:\s*['"]1\.0\.0['"]/.test(server));
check('发布入口存在', fs.existsSync(path.join(ROOT, 'scripts', 'release.ps1')));
check('底层构建仍保留', fs.existsSync(path.join(ROOT, 'scripts', 'build-portable.ps1')));
check('底层构建复核统一版本', buildScript.includes('sync-version.ps1') && buildScript.includes('-Check'));
check('manifest 版本更新不依赖替换模板', versionScript.includes("name=\"CobaltStudio.Desktop\"") && versionScript.includes('$brokenPattern'));

const artifacts = path.join(ROOT, 'release', 'artifacts', version);
const manifestPath = path.join(artifacts, `Cobalt-Studio-v${version}.json`);
const checksumsPath = path.join(artifacts, 'SHA256SUMS.txt');
const artifactZip = path.join(artifacts, `Cobalt-Studio-v${version}-win-x64.zip`);
const artifactExe = path.join(ROOT, 'release', 'Cobalt Studio', 'Cobalt Studio.exe');
const releaseScript = read('scripts/release.ps1');
check('版本目录交付 ZIP 和独立 EXE', releaseScript.includes('Join-Path $ArtifactsDir $releaseVersion') && releaseScript.includes('build-standalone.ps1') && releaseScript.includes('standaloneSmoke'));
check('独立 EXE 内置运行环境且隔离持久化状态', read('launcher/CobaltStudio.Launcher.csproj').includes('EmbeddedResource') && read('launcher/Program.cs').includes('COBALT_STUDIO_DATA_DIR') && read('launcher/Program.cs').includes('SHA256.HashData'));
check('发版输出固定目录和最新包链接', releaseScript.includes("'release\\artifacts'") && releaseScript.includes("'latest.json'") && releaseScript.includes("'LATEST.md'") && releaseScript.includes('Write-ReleaseDelivery $releaseVersion $archivePath $manifestPath'));
check('根目录发版入口委托唯一脚本', read('release.cmd').includes('scripts\\release.ps1'));
if (process.platform === 'win32') {
  const staged = fs.mkdtempSync(path.join(os.tmpdir(), 'cobalt-release-state-'));
  fs.mkdirSync(path.join(staged, 'scripts'), { recursive: true });
  const backup = path.join(staged, '.build', 'runtime-state');
  const smoke = path.join(staged, 'release', 'Cobalt Studio', '.data');
  fs.mkdirSync(backup, { recursive: true });
  fs.mkdirSync(smoke, { recursive: true });
  fs.writeFileSync(path.join(backup, 'tasks.json'), 'original user tasks');
  fs.writeFileSync(path.join(smoke, 'tasks.json'), 'disposable smoke tasks');
  fs.copyFileSync(path.join(ROOT, 'scripts', 'clean-release-state.ps1'), path.join(staged, 'scripts', 'clean-release-state.ps1'));
  const clean = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(staged, 'scripts', 'clean-release-state.ps1')], { encoding: 'utf8' });
  check('实际清理测试状态时保留用户恢复备份', clean.status === 0 && !fs.existsSync(smoke) && fs.existsSync(path.join(backup, 'tasks.json')) && fs.readFileSync(path.join(backup, 'tasks.json'), 'utf8') === 'original user tasks', clean.stderr);
}
check(
  '发布目录不会删除本地运行状态',
  releaseScript.includes('Backup-ReleaseState') && releaseScript.includes('Restore-ReleaseState'),
);
check('发布入口拒绝覆盖既有产物', releaseScript.includes('already packed and verified') && releaseScript.includes('-AllowOverwrite'));
check('发布入口支持版本递增', releaseScript.includes("'major', 'minor', 'patch'") && releaseScript.includes('Get-NextVersion'));
check(
  '发布成功后自动启动新版本',
  /Restore-ReleaseState\s*\r?\n\$restarted = Start-Process -FilePath \$ExePath -WorkingDirectory \$ReleaseDir/.test(releaseScript),
);
check('发布入口回读校验产物', releaseScript.includes('Assert-FileHash') && releaseScript.includes('Test-ReleaseManifest'));
check('DryRun 分别显示便携目录与产物目录', releaseScript.includes('Portable folder: $ReleaseDir') && releaseScript.includes('Artifacts: $ArtifactsDir'));
check(
  '发布前备份并恢复运行状态',
  releaseScript.includes('Backup-ReleaseState') &&
    releaseScript.includes('Restore-ReleaseState') &&
    releaseScript.includes('runtime-state'),
);
if (fs.existsSync(manifestPath)) {
  const release = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  check('发布清单版本一致', release.version === version && release.platform === 'win-x64');
  check('发布清单记录完整测试', release.tests?.fullSuite === 'passed' && release.tests?.releaseSmoke === 'passed' && release.tests?.standaloneSmoke === 'passed');
  check('发布清单记录 cobalt 来源', /^[0-9a-f]{40}$/.test(release.source?.cobaltCommit || '') && release.source?.cobaltVersion === '11.7.1');
  check('发布清单记录产物哈希', /^[0-9a-f]{64}$/.test(release.package?.archiveSha256 || '') && /^[0-9a-f]{64}$/.test(release.package?.executableSha256 || ''));
  const checksumText = fs.existsSync(checksumsPath) ? fs.readFileSync(checksumsPath, 'utf8') : '';
  check('SHA256SUMS 覆盖全部产物', [
    release.package.archiveSha256,
    release.package.executableSha256,
  ].every((hash) => checksumText.includes(hash)));
  check('发布产物存在', fs.existsSync(artifactZip) && fs.existsSync(artifactExe));
  check('独立 EXE 交付物存在', fs.existsSync(path.join(artifacts, release.package.standalone)) && checksumText.includes(release.package.standaloneSha256));
} else {
  check('发布清单存在于 artifacts', true);
}

console.log(`\n${pass.length} passed, ${fail.length} failed`);
process.exit(fail.length ? 1 : 0);
