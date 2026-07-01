// Đẩy các file build (dmg/zip/blockmap/yml) lên S3 (VNG vStorage) để phân phối qua CDN.
// Tự chọn thư mục build MỚI NHẤT có artifact trong release/ (không phụ thuộc version package.json,
// tránh lệch nếu version bị đổi giữa lúc build và publish). Cấu hình đọc từ .env.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const UPLOADABLE = /\.(dmg|zip|blockmap|yml|exe|AppImage|deb)$/;

/** Parse .env đơn giản (KEY=VALUE). */
function loadEnv() {
  const env = {};
  const text = readFileSync(new URL('../.env', import.meta.url), 'utf8');
  for (const line of text.split('\n')) {
    if (line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

function contentType(f) {
  if (f.endsWith('.dmg')) return 'application/x-apple-diskimage';
  if (f.endsWith('.zip')) return 'application/zip';
  if (f.endsWith('.yml') || f.endsWith('.yaml')) return 'text/yaml';
  if (f.endsWith('.exe')) return 'application/vnd.microsoft.portable-executable';
  if (f.endsWith('.AppImage')) return 'application/x-executable';
  return 'application/octet-stream';
}

/** Tìm thư mục release/<...> mới nhất có chứa artifact. */
function findLatestBuild() {
  const root = new URL('../release/', import.meta.url);
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return null;
  }
  const candidates = entries
    .map((e) => {
      const url = new URL(`${e.name}/`, root);
      const files = readdirSync(url).filter((f) => UPLOADABLE.test(f));
      return { name: e.name, url, files, mtime: statSync(url).mtimeMs };
    })
    .filter((c) => c.files.length);
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0];
}

const env = loadEnv();
const missing = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_URL', 'AWS_BUCKET'].filter((k) => !env[k]);
if (missing.length) {
  console.error(`Thiếu biến trong .env: ${missing.join(', ')}`);
  process.exit(1);
}

const build = findLatestBuild();
if (!build) {
  console.error('Không tìm thấy artifact nào trong release/* — hãy build trước.');
  process.exit(1);
}
const version = build.name;

const client = new S3Client({
  region: env.AWS_DEFAULT_REGION || 'us-east-1',
  endpoint: env.AWS_URL,
  forcePathStyle: true, // bắt buộc cho endpoint S3-compatible (bucket không phải subdomain)
  credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY },
});

const prefix = `${env.AWS_ROOT_FOLDER ? `${env.AWS_ROOT_FOLDER}/` : ''}db-manager/${version}`;
const cdnFor = (key) =>
  env.CDN_URL ? `${env.CDN_URL.replace(/\/$/, '')}/${key}` : `${env.AWS_URL}/${env.AWS_BUCKET}/${key}`;

console.log(`Upload ${build.files.length} file (version ${version}) → bucket "${env.AWS_BUCKET}" / ${prefix}\n`);

const uploaded = [];
for (const f of build.files) {
  const body = await readFile(new URL(f, build.url));
  const key = `${prefix}/${encodeURIComponent(f)}`;
  await client.send(
    new PutObjectCommand({ Bucket: env.AWS_BUCKET, Key: `${prefix}/${f}`, Body: body, ContentType: contentType(f) }),
  );
  uploaded.push({ file: f, url: cdnFor(key) });
  console.log(`  ↑ ${f}`);
}

const isInstaller = (f) => /\.(dmg|exe|AppImage)$/.test(f);
const installers = uploaded.filter((u) => isInstaller(u.file));
const others = uploaded.filter((u) => !isInstaller(u.file));

console.log(`\n${'='.repeat(64)}`);
console.log(`✅ Đã publish version ${version}`);
console.log('='.repeat(64));
console.log('\n📦 Link tải (CDN):');
for (const u of installers.length ? installers : uploaded) console.log(`   ${u.url}`);
if (installers.length && others.length) {
  console.log('\nFile khác:');
  for (const u of others) console.log(`   ${u.url}`);
}
console.log('');
