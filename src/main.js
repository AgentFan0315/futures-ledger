'use strict';
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const store = require('./store');

const isDev = !app.isPackaged;
const DATA_VERSION = store.DATA_VERSION;

// ---------- 日志（写入数据目录 logs/app.log，便于排查） ----------
function logFile() {
  const dir = getDataDir();
  const ld = path.join(dir, 'logs');
  fs.mkdirSync(ld, { recursive: true });
  return path.join(ld, 'app.log');
}
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`;
  try { fs.appendFileSync(logFile(), line, 'utf8'); } catch { /* 日志失败不影响功能 */ }
  if (isDev) console.log(...args);
}

// ---------- 配置（软件层）：记住数据目录位置 ----------
function configPath() { return path.join(app.getPath('userData'), 'config.json'); }
function loadAppConfig() {
  try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch { return {}; }
}
function saveAppConfig(cfg) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), 'utf8');
}

// ---------- 数据目录（数据层，用户可更换） ----------
function defaultDataDir() {
  return path.join(app.getPath('documents'), '期货结算数据');
}
function getDataDir() {
  const cfg = loadAppConfig();
  if (cfg.dataDir && fs.existsSync(cfg.dataDir)) return cfg.dataDir;
  const d = defaultDataDir();
  fs.mkdirSync(path.join(d, 'statements'), { recursive: true });
  fs.mkdirSync(path.join(d, 'raw'), { recursive: true });
  saveAppConfig({ ...cfg, dataDir: d });
  return d;
}

// ---------- 监控目录：轮询检测新结算单并自动导入 ----------
let monitorTimer = null;
let knownFiles = new Set();

function scanMonitorDir(win) {
  const cfg = store.loadConfig(getDataDir());
  if (!cfg.monitorDir || !fs.existsSync(cfg.monitorDir)) return;
  let files;
  try {
    files = fs.readdirSync(cfg.monitorDir).filter(f => /\.xlsx?$/i.test(f)).map(f => path.join(cfg.monitorDir, f));
  } catch { return; }
  const fresh = files.filter(f => !knownFiles.has(f));
  for (const f of files) knownFiles.add(f);
  if (!fresh.length) return;

  // 逐个解析内容判断是否为新交易日（已存在的自动跳过）
  const results = store.importFiles(getDataDir(), fresh, 'skip');
  const imported = results.filter(r => r.ok && !r.skipped);
  if (imported.length) {
    log('监控目录自动导入', imported);
    if (win && !win.isDestroyed()) win.webContents.send('monitor:imported', results);
  }
}

function startMonitor(win) {
  stopMonitor();
  knownFiles = new Set();
  const cfg = store.loadConfig(getDataDir());
  if (cfg.monitorDir) {
    // 启动时先把已有文件标记为已知，只处理之后新出现的文件
    try {
      for (const f of fs.readdirSync(cfg.monitorDir)) {
        if (/\.xlsx?$/i.test(f)) knownFiles.add(path.join(cfg.monitorDir, f));
      }
    } catch { /* ignore */ }
  }
  monitorTimer = setInterval(() => {
    try { scanMonitorDir(win); } catch (e) { log('监控目录扫描失败', e.message); }
  }, 5000);
}
function stopMonitor() {
  if (monitorTimer) { clearInterval(monitorTimer); monitorTimer = null; }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 560,
    title: '期货结算分析',
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  startMonitor(win);
  return win;
}

// ---------- 命令行导入模式：期货结算分析 import <文件...> ----------
function runCliImport() {
  const args = process.argv.slice(1);
  const idx = args.indexOf('import');
  if (idx < 0) return false;
  const files = args.slice(idx + 1).filter(a => !a.startsWith('--'));
  if (!files.length) {
    console.log('用法: 期货结算分析 import <结算单.xls ...> [--数据目录 路径]');
    app.exit(1);
    return true;
  }
  const diIdx = args.indexOf('--数据目录');
  const dataDir = diIdx >= 0 && args[diIdx + 1] ? args[diIdx + 1] : defaultDataDir();
  fs.mkdirSync(path.join(dataDir, 'statements'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'raw'), { recursive: true });
  const results = store.importFiles(dataDir, files, 'skip');
  for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.file}: ${r.message || r.error}`);
  app.exit(results.every(r => r.ok) ? 0 : 1);
  return true;
}

// ---------- IPC ----------
ipcMain.handle('app:getState', () => {
  const dataDir = getDataDir();
  const idx = store.loadIndex(dataDir);
  return { dataDir, index: idx, isDev, dataVersion: DATA_VERSION, indexRebuilt: !!idx.rebuilt };
});

ipcMain.handle('dialog:chooseDataDir', async () => {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  const dir = r.filePaths[0];
  fs.mkdirSync(path.join(dir, 'statements'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'raw'), { recursive: true });
  saveAppConfig({ ...loadAppConfig(), dataDir: dir });
  startMonitor(BrowserWindow.getAllWindows()[0]);
  return { dataDir: dir, index: store.loadIndex(dir) };
});

ipcMain.handle('dialog:import', async (evt, mode) => {
  const r = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '结算单', extensions: ['xls', 'xlsx'] }],
  });
  if (r.canceled || !r.filePaths.length) return null;
  const results = store.importFiles(getDataDir(), r.filePaths, mode);
  log('手动导入', results);
  return { results, index: store.loadIndex(getDataDir()) };
});

// 拖拽导入（渲染层传文件路径）
ipcMain.handle('import:paths', (evt, { paths, mode }) => {
  const results = store.importFiles(getDataDir(), paths, mode);
  log('拖拽导入', results);
  return { results, index: store.loadIndex(getDataDir()) };
});

ipcMain.handle('data:remove', (evt, key) => {
  store.removeStatement(getDataDir(), key);
  return store.loadIndex(getDataDir());
});

ipcMain.handle('data:overview', (evt, account) => store.computeOverview(getDataDir(), account || null));

ipcMain.handle('data:positionsAt', (evt, { date, account }) => store.positionsAt(getDataDir(), date, account || null));

ipcMain.handle('data:health', () => store.health(getDataDir()));

// 回收站
ipcMain.handle('trash:list', () => store.listTrash(getDataDir()));
ipcMain.handle('trash:restore', (evt, key) => { store.restoreTrash(getDataDir(), key); return store.loadIndex(getDataDir()); });
ipcMain.handle('trash:purge', () => { store.purgeTrash(getDataDir()); return true; });

// 备份
ipcMain.handle('backup:list', () => store.listBackups(getDataDir()));
ipcMain.handle('backup:export', async () => {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  const dest = store.exportBackup(getDataDir(), r.filePaths[0]);
  log('导出完整备份', dest);
  return dest;
});
ipcMain.handle('backup:restore', async () => {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  try {
    store.restoreBackup(getDataDir(), r.filePaths[0]);
    log('从备份恢复', r.filePaths[0]);
    return { ok: true, index: store.loadIndex(getDataDir()) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('config:get', () => store.loadConfig(getDataDir()));
ipcMain.handle('config:set', (evt, cfg) => {
  const merged = store.saveConfig(getDataDir(), cfg);
  startMonitor(BrowserWindow.getAllWindows()[0]);
  return merged;
});

// 监控目录选择
ipcMain.handle('dialog:chooseMonitorDir', async () => {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  return r.filePaths[0];
});

// 日志上报（渲染层错误等）
ipcMain.handle('log:write', (evt, msg) => { log('[renderer]', msg); return true; });

ipcMain.handle('data:exportCsv', async (evt, { filename, rows }) => {
  const r = await dialog.showSaveDialog({ defaultPath: filename, filters: [{ name: 'CSV', extensions: ['csv'] }] });
  if (r.canceled || !r.filePath) return null;
  const header = Object.keys(rows[0] || { 空: '' });
  const esc = v => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = '﻿' + [header.join(','), ...rows.map(row => header.map(h => esc(row[h])).join(','))].join('\n');
  fs.writeFileSync(r.filePath, csv, 'utf8');
  return r.filePath;
});

// xlsx 导出（SheetJS 写文件）
ipcMain.handle('data:exportXlsx', async (evt, { filename, sheets }) => {
  const XLSX = require('xlsx');
  const r = await dialog.showSaveDialog({ defaultPath: filename, filters: [{ name: 'Excel', extensions: ['xlsx'] }] });
  if (r.canceled || !r.filePath) return null;
  const wb = XLSX.utils.book_new();
  for (const { name, rows } of sheets) {
    if (!rows.length) continue;
    const ws = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31));
  }
  XLSX.writeFile(wb, r.filePath);
  return r.filePath;
});

ipcMain.handle('shell:showDataDir', () => shell.openPath(getDataDir()));

process.on('uncaughtException', e => log('[uncaughtException]', e.stack || e.message));

app.whenReady().then(() => {
  if (runCliImport()) return;
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
