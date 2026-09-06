#!/usr/bin/env node
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const VERSION = '1.1.0';
const ROOT = path.dirname(new URL(import.meta.url).pathname);
const DEFAULT_CONFIG = path.join(ROOT, 'config', 'config.json');
const LOCK = '/run/m3u-editor-updater.lock';
const COMPOSE_FILES = ['compose.yml', 'compose.yaml', 'docker-compose.yml', 'docker-compose.yaml'];

const DEFAULTS = {
  projectDir: '/opt/m3u-editor',
  composeFile: '',
  services: [],
  updateAllServices: true,
  health: { enabled: true, timeoutSeconds: 240, intervalSeconds: 5, requireDockerHealthy: true },
  backup: { enabled: true, directory: '/var/backups/m3u-editor-updater', keep: 7, includeData: false },
  cleanup: { enabled: true, pruneDangling: true },
  notifications: { webhookUrl: '', onSuccess: false, onFailure: true },
  update: { pull: true, recreate: true, removeOrphans: true, dryRun: false },
  discovery: { roots: ['/opt', '/srv', '/var/lib', '/home'], maxDepth: 4 }
};

function log(level, msg) { console.log(`[${new Date().toISOString()}] [${level}] ${msg}`); }
const info = m => log('INFO', m), warn = m => log('WARN', m), error = m => log('ERROR', m);

function merge(a, b) {
  const out = structuredClone(a);
  for (const [k, v] of Object.entries(b || {})) out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(out[k] || {}, v) : v;
  return out;
}

async function loadConfig() {
  const file = process.env.M3U_UPDATER_CONFIG || DEFAULT_CONFIG;
  try { return merge(DEFAULTS, JSON.parse(await fs.readFile(file, 'utf8'))); }
  catch (e) { if (e.code !== 'ENOENT') throw new Error(`Invalid config ${file}: ${e.message}`); return structuredClone(DEFAULTS); }
}

async function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => stdout += d); child.stderr.on('data', d => stderr += d);
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve({ stdout: stdout.trim(), stderr: stderr.trim() }) : reject(new Error(`${command} ${args.join(' ')} failed (${code}): ${stderr || stdout}`)));
  });
}
async function docker(args, options) { return run('docker', args, options); }
async function compose(args, cwd, file) {
  const base = ['compose'];
  if (file) base.push('-f', file);
  return docker([...base, ...args], { cwd });
}

async function discoverCompose(cfg) {
  if (cfg.composeFile) {
    const file = path.isAbsolute(cfg.composeFile) ? cfg.composeFile : path.join(cfg.projectDir, cfg.composeFile);
    if (!fsSync.existsSync(file)) throw new Error(`Compose file not found: ${file}`);
    return { projectDir: path.dirname(file), composeFile: file };
  }
  if (cfg.projectDir) {
    for (const f of COMPOSE_FILES) { const p = path.join(cfg.projectDir, f); if (fsSync.existsSync(p)) return { projectDir: cfg.projectDir, composeFile: p }; }
  }
  for (const root of cfg.discovery.roots) {
    if (!fsSync.existsSync(root)) continue;
    const q = [[root, 0]];
    while (q.length) {
      const [dir, depth] = q.shift();
      for (const f of COMPOSE_FILES) {
        const p = path.join(dir, f);
        if (!fsSync.existsSync(p)) continue;
        try { await compose(['config', '--quiet'], dir, p); return { projectDir: dir, composeFile: p }; } catch {}
      }
      if (depth >= cfg.discovery.maxDepth) continue;
      let entries = [];
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.') && !['node_modules','proc','sys','dev'].includes(e.name)) q.push([path.join(dir, e.name), depth + 1]);
    }
  }
  throw new Error('No usable Docker Compose project found. Set projectDir or composeFile.');
}

async function services(project) {
  const { stdout } = await compose(['config', '--services'], project.projectDir, project.composeFile);
  return stdout.split(/\s+/).filter(Boolean);
}

async function inspectService(service, project) {
  try {
    const { stdout } = await compose(['ps', '-q', service], project.projectDir, project.composeFile);
    const id = stdout.trim().split('\n')[0]; if (!id) return null;
    const data = JSON.parse((await docker(['inspect', id])).stdout)[0];
    return { id, imageId: data.Image, imageRef: data.Config?.Image, health: data.State?.Health?.Status || 'none', running: !!data.State?.Running };
  } catch { return null; }
}

async function createBackup(cfg, project, before) {
  if (!cfg.backup.enabled) return null;
  const dir = path.resolve(cfg.backup.directory), stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(dir, `m3u-editor-${stamp}`);
  await fs.mkdir(backup, { recursive: true });
  await fs.copyFile(project.composeFile, path.join(backup, path.basename(project.composeFile)));
  for (const name of ['.env']) { const src = path.join(project.projectDir, name); if (fsSync.existsSync(src)) await fs.copyFile(src, path.join(backup, name)); }
  await fs.writeFile(path.join(backup, 'metadata.json'), JSON.stringify({ createdAt: new Date().toISOString(), project, services: before, version: VERSION }, null, 2));
  if (cfg.backup.includeData) for (const name of ['data', 'storage']) { const src = path.join(project.projectDir, name); if (fsSync.existsSync(src)) await run('tar', ['-czf', path.join(backup, `${name}.tar.gz`), '-C', project.projectDir, name]); }
  await pruneBackups(dir, cfg.backup.keep);
  info(`Backup created: ${backup}`); return backup;
}
async function pruneBackups(dir, keep) {
  const items = (await fs.readdir(dir, { withFileTypes: true })).filter(x => x.isDirectory()).sort((a,b) => b.name.localeCompare(a.name));
  for (const x of items.slice(Math.max(0, keep))) await fs.rm(path.join(dir, x.name), { recursive: true, force: true });
}

async function healthCheck(cfg, project, targetServices) {
  if (!cfg.health.enabled) return true;
  const deadline = Date.now() + cfg.health.timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    let good = true;
    for (const service of targetServices) {
      const c = await inspectService(service, project);
      if (!c?.running) { good = false; continue; }
      if (cfg.health.requireDockerHealthy && c.health !== 'healthy' && c.health !== 'none') good = false;
    }
    if (good) return true;
    await sleep(cfg.health.intervalSeconds * 1000);
  }
  return false;
}

async function rollback(project, before, targetServices, cfg) {
  const overrides = [];
  const overridePath = path.join(project.projectDir, `.m3u-editor-updater-rollback-${process.pid}.yml`);
  for (const service of targetServices) {
    const old = before[service]; if (!old?.imageId) continue;
    const tag = `m3u-editor-updater-rollback/${service}:${process.pid}`;
    await docker(['tag', old.imageId, tag]);
    overrides.push(`services:\n  ${service}:\n    image: ${tag}`);
  }
  if (!overrides.length) throw new Error('No previous image IDs available for rollback.');
  await fs.writeFile(overridePath, overrides.join('\n'));
  try {
    await compose(['up', '-d', ...(cfg.update.removeOrphans ? ['--remove-orphans'] : []), ...targetServices], project.projectDir, overridePath);
    if (!(await healthCheck(cfg, project, targetServices))) throw new Error('Rollback health check failed.');
    info('Rollback successful.');
  } finally { await fs.rm(overridePath, { force: true }); }
}

async function notify(cfg, success, message) {
  const n = cfg.notifications;
  if (!n.webhookUrl || (success ? !n.onSuccess : !n.onFailure)) return;
  try { await fetch(n.webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: message, username: 'm3u-editor-updater' }) }); }
  catch (e) { warn(`Notification failed: ${e.message}`); }
}

async function acquireLock() {
  try { const h = await fs.open(LOCK, 'wx'); await h.writeFile(JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString() })); return h; }
  catch (e) { if (e.code === 'EEXIST') throw new Error(`Another updater instance is running (${LOCK}).`); throw e; }
}

async function main() {
  const cfg = await loadConfig();
  if (process.argv.includes('--version')) return console.log(VERSION);
  if (process.argv.includes('--dry-run')) cfg.update.dryRun = true;
  await docker(['info']);
  const project = await discoverCompose(cfg);
  await compose(['config', '--quiet'], project.projectDir, project.composeFile);
  const all = await services(project);
  const selected = cfg.updateAllServices ? all : (cfg.services?.length ? cfg.services : all);
  if (!selected.length) throw new Error('Compose project contains no services.');
  info(`Services to update: ${selected.join(', ')}`);
  const before = {};
  for (const s of selected) { before[s] = await inspectService(s, project); if (before[s]) info(`${s}: ${before[s].imageRef} (${before[s].imageId.slice(0,12)})`); else warn(`${s}: container is not currently running`); }
  if (cfg.update.dryRun) return info('Dry-run: Compose validated; no changes made.');
  const backup = await createBackup(cfg, project, before);
  try {
    if (cfg.update.pull) { info('Pulling ALL service images...'); await compose(['pull'], project.projectDir, project.composeFile); }
    info('Recreating ALL services...');
    const args = ['up', '-d']; if (cfg.update.recreate) args.push('--force-recreate'); if (cfg.update.removeOrphans) args.push('--remove-orphans'); args.push(...selected);
    await compose(args, project.projectDir, project.composeFile);
    if (!(await healthCheck(cfg, project, selected))) throw new Error('Health check timed out or one or more services are unhealthy.');
  } catch (e) {
    error(`Update failed: ${e.message}`);
    try { await rollback(project, before, selected, cfg); await notify(cfg, false, `⚠️ m3u-editor stack update failed and was rolled back on ${os.hostname()}.`); }
    catch (rb) { error(`CRITICAL: rollback failed: ${rb.message}`); await notify(cfg, false, `🚨 m3u-editor stack update AND rollback failed on ${os.hostname()}: ${rb.message}`); }
    process.exitCode = 1; return;
  }
  if (cfg.cleanup.enabled && cfg.cleanup.pruneDangling) try { await docker(['image', 'prune', '-f']); } catch (e) { warn(`Cleanup failed: ${e.message}`); }
  info(`Update successful: ${selected.join(', ')}. Backup: ${backup || 'disabled'}`);
  await notify(cfg, true, `✅ m3u-editor Docker stack updated successfully on ${os.hostname()}: ${selected.join(', ')}.`);
}

let lockHandle;
try { lockHandle = await acquireLock(); await main(); }
catch (e) { error(e.stack || e.message); process.exitCode = 1; }
finally { try { if (lockHandle) await lockHandle.close(); await fs.unlink(LOCK); } catch {} }
