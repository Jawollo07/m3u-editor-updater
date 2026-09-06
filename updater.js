#!/usr/bin/env node
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const VERSION = '1.0.0';
const ROOT = path.dirname(new URL(import.meta.url).pathname);
const DEFAULT_CONFIG = path.join(ROOT, 'config', 'config.json');
const LOCK = '/run/m3u-editor-updater.lock';

const DEFAULTS = {
  projectDir: '',
  composeFile: '',
  service: 'm3u-editor',
  image: 'sparkison/m3u-editor:${IMAGE_TAG:-latest}',
  health: { enabled: true, timeoutSeconds: 180, intervalSeconds: 5, requireDockerHealthy: false },
  backup: { enabled: true, directory: '/var/backups/m3u-editor-updater', keep: 7, includeData: false },
  cleanup: { enabled: true, pruneDangling: true },
  notifications: { webhookUrl: '', onSuccess: false, onFailure: true },
  update: { pull: true, recreate: true, removeOrphans: true, dryRun: false },
  discovery: { roots: ['/opt', '/srv', '/var/lib', '/home'], maxDepth: 4 }
};

function log(level, msg) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
  console.log(line);
  return line;
}
const info = m => log('INFO', m);
const warn = m => log('WARN', m);
const error = m => log('ERROR', m);

async function loadConfig() {
  let file = process.env.M3U_UPDATER_CONFIG || DEFAULT_CONFIG;
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    return merge(DEFAULTS, parsed);
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`Invalid config ${file}: ${e.message}`);
    return structuredClone(DEFAULTS);
  }
}
function merge(a, b) {
  const out = structuredClone(a);
  for (const [k, v] of Object.entries(b || {})) out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(out[k] || {}, v) : v;
  return out;
}

async function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve({ stdout: stdout.trim(), stderr: stderr.trim() }) : reject(new Error(`${command} ${args.join(' ')} failed (${code}): ${stderr || stdout}`)));
  });
}
async function commandExists(command) { try { await run('sh', ['-c', `command -v ${command}`]); return true; } catch { return false; } }
async function docker(args, options) { return run('docker', args, options); }
async function compose(args, projectDir, composeFile) {
  const base = ['compose'];
  if (composeFile) base.push('-f', composeFile);
  return docker([...base, ...args], { cwd: projectDir });
}

async function discoverCompose(cfg) {
  if (cfg.projectDir) {
    const files = cfg.composeFile ? [cfg.composeFile] : ['compose.yml', 'compose.yaml', 'docker-compose.yml', 'docker-compose.yaml'];
    for (const f of files) {
      const p = path.isAbsolute(f) ? f : path.join(cfg.projectDir, f);
      if (fsSync.existsSync(p)) return { projectDir: cfg.projectDir, composeFile: p };
    }
    throw new Error(`No Compose file found in ${cfg.projectDir}`);
  }
  const candidates = [];
  for (const root of cfg.discovery.roots) {
    if (!fsSync.existsSync(root)) continue;
    const q = [[root, 0]];
    while (q.length) {
      const [dir, depth] = q.shift();
      for (const f of ['compose.yml','compose.yaml','docker-compose.yml','docker-compose.yaml']) {
        const p = path.join(dir, f);
        if (fsSync.existsSync(p)) candidates.push(p);
      }
      if (depth >= cfg.discovery.maxDepth) continue;
      let entries = [];
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.') || ['node_modules','proc','sys','dev'].includes(e.name)) continue;
        q.push([path.join(dir, e.name), depth + 1]);
      }
    }
  }
  const matches = [];
  for (const p of [...new Set(candidates)]) {
    try {
      const c = await compose(['config', '--services'], path.dirname(p), p);
      if (c.stdout.split(/\s+/).includes(cfg.service)) matches.push(p);
    } catch {}
  }
  if (!matches.length) throw new Error(`Could not discover a Compose project containing service '${cfg.service}'. Set projectDir in config.json.`);
  if (matches.length > 1) warn(`Multiple matching Compose projects found; using ${matches[0]}`);
  return { projectDir: path.dirname(matches[0]), composeFile: matches[0] };
}

async function inspectContainer(service, projectDir, composeFile) {
  try {
    const { stdout } = await compose(['ps', '-q', service], projectDir, composeFile);
    const id = stdout.trim().split('\n')[0];
    if (!id) return null;
    const inspect = await docker(['inspect', id]);
    const data = JSON.parse(inspect.stdout)[0];
    return { id, imageId: data.Image, imageRef: data.Config?.Image, health: data.State?.Health?.Status || 'none', running: !!data.State?.Running };
  } catch { return null; }
}

async function createBackup(cfg, project) {
  if (!cfg.backup.enabled) return null;
  const dir = path.resolve(cfg.backup.directory);
  await fs.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(dir, `m3u-editor-${stamp}`);
  await fs.mkdir(backup, { recursive: true });
  await fs.copyFile(project.composeFile, path.join(backup, path.basename(project.composeFile)));
  for (const name of ['.env']) {
    const src = path.join(project.projectDir, name);
    if (fsSync.existsSync(src)) await fs.copyFile(src, path.join(backup, name));
  }
  if (cfg.backup.includeData) {
    for (const name of ['data', 'storage']) {
      const src = path.join(project.projectDir, name);
      if (fsSync.existsSync(src)) await run('tar', ['-czf', path.join(backup, `${name}.tar.gz`), '-C', project.projectDir, name]);
    }
  }
  await fs.writeFile(path.join(backup, 'metadata.json'), JSON.stringify({ createdAt: new Date().toISOString(), project, version: VERSION }, null, 2));
  await pruneBackups(dir, cfg.backup.keep);
  info(`Backup created: ${backup}`);
  return backup;
}
async function pruneBackups(dir, keep) {
  const items = (await fs.readdir(dir, { withFileTypes: true })).filter(x => x.isDirectory()).sort((a,b) => b.name.localeCompare(a.name));
  for (const x of items.slice(Math.max(0, keep))) await fs.rm(path.join(dir, x.name), { recursive: true, force: true });
}

async function healthCheck(cfg, project) {
  if (!cfg.health.enabled) return true;
  const deadline = Date.now() + cfg.health.timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const c = await inspectContainer(cfg.service, project.projectDir, project.composeFile);
    if (c?.running) {
      if (!cfg.health.requireDockerHealthy || c.health === 'healthy') return true;
      if (c.health === 'unhealthy') warn('Docker reports the service as unhealthy; waiting...');
    }
    await sleep(cfg.health.intervalSeconds * 1000);
  }
  return false;
}

async function rollback(cfg, project, old) {
  if (!old?.imageId) throw new Error('Rollback unavailable: no previous image ID was captured.');
  info(`Rolling back to image ${old.imageId}`);
  const inspect = await docker(['image', 'inspect', old.imageId]);
  const oldRepoTags = JSON.parse(inspect.stdout)[0]?.RepoTags || [];
  const target = oldRepoTags.find(x => x.startsWith('sparkison/m3u-editor:')) || old.imageRef;
  if (!target) throw new Error('Could not determine previous image reference for rollback.');
  await docker(['tag', old.imageId, target]);
  await compose(['up', '-d', ...(cfg.update.removeOrphans ? ['--remove-orphans'] : [])], project.projectDir, project.composeFile);
  if (!(await healthCheck(cfg, project))) throw new Error('Rollback completed but health check failed.');
  info('Rollback successful.');
}

async function notify(cfg, success, message) {
  const n = cfg.notifications;
  if (!n.webhookUrl || (!success && !n.onFailure) || (success && !n.onSuccess)) return;
  try {
    await fetch(n.webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: message, username: 'm3u-editor-updater' }) });
  } catch (e) { warn(`Notification failed: ${e.message}`); }
}

async function acquireLock() {
  try {
    const handle = await fs.open(LOCK, 'wx');
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return handle;
  } catch (e) { if (e.code === 'EEXIST') throw new Error(`Another updater instance is running (${LOCK}).`); throw e; }
}

async function main() {
  const cfg = await loadConfig();
  if (process.argv.includes('--version')) return console.log(VERSION);
  if (process.argv.includes('--dry-run')) cfg.update.dryRun = true;
  if (!(await commandExists('docker'))) throw new Error('Docker is not installed or not in PATH.');
  await docker(['info']);
  const project = await discoverCompose(cfg);
  info(`Compose project: ${project.projectDir}`);
  info(`Compose file: ${project.composeFile}`);
  await compose(['config', '--quiet'], project.projectDir, project.composeFile);
  const before = await inspectContainer(cfg.service, project.projectDir, project.composeFile);
  if (!before) warn(`Service '${cfg.service}' is not currently running.`);
  else info(`Current image: ${before.imageRef} (${before.imageId.slice(0, 12)})`);
  if (cfg.update.dryRun) return info('Dry-run: configuration validated; no changes made.');
  const backup = await createBackup(cfg, project);
  if (cfg.update.pull) {
    info('Pulling latest image(s)...');
    await compose(['pull', cfg.service], project.projectDir, project.composeFile);
  }
  info('Recreating service...');
  const upArgs = ['up', '-d'];
  if (cfg.update.recreate) upArgs.push('--force-recreate');
  if (cfg.update.removeOrphans) upArgs.push('--remove-orphans');
  upArgs.push(cfg.service);
  try {
    await compose(upArgs, project.projectDir, project.composeFile);
    if (!(await healthCheck(cfg, project))) throw new Error('Health check timed out.');
  } catch (e) {
    error(`Update failed: ${e.message}`);
    try { await rollback(cfg, project, before); await notify(cfg, false, `⚠️ m3u-editor update failed and was rolled back. ${e.message}`); } catch (rb) { error(`CRITICAL: rollback failed: ${rb.message}`); await notify(cfg, false, `🚨 m3u-editor update AND rollback failed: ${rb.message}`); }
    process.exitCode = 1;
    return;
  }
  if (cfg.cleanup.enabled) {
    try { if (cfg.cleanup.pruneDangling) await docker(['image', 'prune', '-f']); } catch (e) { warn(`Cleanup failed: ${e.message}`); }
  }
  info(`Update successful. Backup: ${backup || 'disabled'}`);
  await notify(cfg, true, `✅ m3u-editor update successful on ${os.hostname()}.`);
}

let lockHandle;
try {
  lockHandle = await acquireLock();
  await main();
} catch (e) {
  error(e.stack || e.message);
  await notify(await loadConfig().catch(() => DEFAULTS), false, `🚨 m3u-editor updater failed: ${e.message}`).catch(() => {});
  process.exitCode = 1;
} finally {
  try { if (lockHandle) await lockHandle.close(); await fs.unlink(LOCK); } catch {}
}
