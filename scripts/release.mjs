// Orchestrator build/phát hành: stamp version (1 lần) → build → electron-builder → publish.
// Chạy trong MỘT tiến trình để version không bị đổi giữa chừng.
//   node scripts/release.mjs --mac              (build mac + publish)
//   node scripts/release.mjs --mac --no-publish (chỉ build, không upload)
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const platformArgs = args.filter((a) => ['--mac', '--win', '--linux'].includes(a));
const doPublish = !args.includes('--no-publish');

// Version theo thời điểm build: YYYY.MMDD.HHMMSS (mỗi segment là số nguyên hợp lệ semver).
const d = new Date();
const p = (n) => String(n).padStart(2, '0');
const version = `${d.getFullYear()}.${Number(`${p(d.getMonth() + 1)}${p(d.getDate())}`)}.${Number(
  `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`,
)}`;
const human = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
  d.getMinutes(),
)}:${p(d.getSeconds())}`;

const pkgUrl = new URL('../package.json', import.meta.url);
const pkg = JSON.parse(readFileSync(pkgUrl, 'utf8'));
pkg.version = version;
writeFileSync(pkgUrl, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`\n▶ Build version ${version}  (${human})\n`);

const run = (cmd) => execSync(cmd, { stdio: 'inherit' });
run('npx electron-vite build');
run(`npx electron-builder ${platformArgs.join(' ')}`.trim());
if (doPublish) run('node scripts/publish.mjs');
