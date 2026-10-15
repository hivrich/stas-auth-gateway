#!/usr/bin/env node
'use strict';

// prune_old_log_dumps из scripts/deploy-prod-gateway.sh: хранит 10 самых новых каталогов
// logs-<UTC>-gateway; дампы сайта, чужие logs-* и обычные файлы не трогает.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const script = path.resolve(__dirname, 'deploy-prod-gateway.sh');

// Функцию берём из самого скрипта, чтобы тест не расходился с боевым кодом.
const extracted = spawnSync('sed', ['-n', '/^prune_old_log_dumps() {/,/^}/p', script], { encoding: 'utf8' });
assert.equal(extracted.status, 0, 'sed failed');
assert.ok(extracted.stdout.startsWith('prune_old_log_dumps() {'), 'function not found in deploy script');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-log-prune-'));
try {
  const gatewayDirs = [];
  for (let d = 1; d <= 13; d += 1) {
    gatewayDirs.push(`logs-202601${String(d).padStart(2, '0')}T000000Z-gateway`);
  }
  const decoyDirs = ['logs-20260101T000000Z-abc123', 'logs-notes'];
  const decoyFiles = ['logs-20250101T000000Z-gateway.txt'];

  for (const name of [...gatewayDirs, ...decoyDirs]) {
    fs.mkdirSync(path.join(root, name));
    fs.writeFileSync(path.join(root, name, 'app.log'), 'x');
  }
  for (const name of decoyFiles) fs.writeFileSync(path.join(root, name), 'x');

  const run = spawnSync('bash', ['-c', `set -euo pipefail\n${extracted.stdout}\nprune_old_log_dumps`], {
    env: { ...process.env, STAS_DEPLOY_BACKUP_DIR: root },
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, `prune failed: ${run.stderr}`);

  const left = new Set(fs.readdirSync(root));
  const newest = gatewayDirs.slice(3); // 13 штук, самые старые три - первые
  const oldest = gatewayDirs.slice(0, 3);

  for (const name of newest) assert.ok(left.has(name), `newest dump removed: ${name}`);
  assert.equal(newest.length, 10);
  for (const name of oldest) assert.ok(!left.has(name), `old dump kept: ${name}`);
  for (const name of [...decoyDirs, ...decoyFiles]) assert.ok(left.has(name), `decoy removed: ${name}`);
  assert.equal(left.size, 10 + decoyDirs.length + decoyFiles.length);
  console.log('ok - prune keeps the 10 newest logs-<UTC>-gateway directories and leaves site dumps and other logs-* alone');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
