'use strict';
// 数据存储层：所有用户数据保存在独立的「数据目录」中，与程序本体分离。
// 目录结构：
//   <dataDir>/
//     config.json                  用户配置（初始入金、监控目录等）
//     statements/<账号>_<交易日>.json   每个交易日的规范化结算数据（含 dataVersion）
//     raw/<账号>_<交易日>__<原文件名>.xls   原始文件归档
//     backups/<时间戳>/            自动备份（statements + index + config，滚动保留 10 份）
//     .trash/                      回收站（被删除的结算数据，可恢复）
//     index.json                   已导入清单（含校验和）
//     logs/                        运行日志
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseStatement } = require('./parser');

const DATA_VERSION = 1;
const BACKUP_KEEP = 10;

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function indexPath(dataDir) { return path.join(dataDir, 'index.json'); }
function trashDir(dataDir) { return path.join(dataDir, '.trash'); }
function backupsDir(dataDir) { return path.join(dataDir, 'backups'); }

// ---------- 原子写入：先写临时文件再改名，杜绝半截文件 ----------
function atomicWrite(p, content) {
  ensureDir(path.dirname(p));
  const tmp = p + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, p);
}

function productOf(contract) { return (contract || '').replace(/\d+$/, '').toUpperCase(); }

function checksumOf(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 16);
}

// ---------- 配置 ----------
const DEFAULT_CONFIG = {
  initialDeposit: 0,        // 工具启用前的累计净入金基数（净值 = 权益 − 累计净入金）
  monitorDir: '',           // 监控目录：自动检测并导入新结算单
  backupDir: '',            // 外部备份目录（可选）：导入成功后同步复制一份
};
const CONFIG_KEYS = Object.keys(DEFAULT_CONFIG);

function loadConfig(dataDir) {
  const p = path.join(dataDir, 'config.json');
  let cfg = {};
  if (fs.existsSync(p)) { try { cfg = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* 损坏则用默认 */ } }
  const merged = { ...DEFAULT_CONFIG };
  for (const k of CONFIG_KEYS) {
    if (typeof DEFAULT_CONFIG[k] === 'number' && typeof cfg[k] === 'number' && Number.isFinite(cfg[k])) merged[k] = cfg[k];
    if (typeof DEFAULT_CONFIG[k] === 'string' && typeof cfg[k] === 'string') merged[k] = cfg[k];
  }
  return merged;
}

function saveConfig(dataDir, cfg) {
  const merged = { ...DEFAULT_CONFIG };
  for (const k of CONFIG_KEYS) {
    if (typeof DEFAULT_CONFIG[k] === 'number' && typeof cfg[k] === 'number' && Number.isFinite(cfg[k])) merged[k] = cfg[k];
    if (typeof DEFAULT_CONFIG[k] === 'string' && typeof cfg[k] === 'string') merged[k] = cfg[k];
  }
  atomicWrite(path.join(dataDir, 'config.json'), JSON.stringify(merged, null, 2));
  return merged;
}

// ---------- 索引（含自愈） ----------
function readIndexFile(dataDir) {
  const p = indexPath(dataDir);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function loadIndex(dataDir) {
  const idx = readIndexFile(dataDir);
  if (idx && Array.isArray(idx.statements)) return idx;
  // 索引缺失/损坏：扫描 statements/ 目录自愈重建（导入中断也能恢复）
  return rebuildIndex(dataDir);
}

function rebuildIndex(dataDir) {
  const statementsDir = path.join(dataDir, 'statements');
  const idx = { statements: [], rebuilt: true };
  if (fs.existsSync(statementsDir)) {
    for (const f of fs.readdirSync(statementsDir).filter(f => f.endsWith('.json'))) {
      const key = f.replace(/\.json$/, '');
      const st = loadStatement(dataDir, key);
      if (!st || !st.meta || !st.meta.tradeDate) continue;
      idx.statements.push(entryFromStatement(st, key, f, null));
    }
  }
  idx.statements.sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
  atomicWrite(indexPath(dataDir), JSON.stringify(idx, null, 2));
  return idx;
}

function entryFromStatement(st, key, rawFile, importedAt) {
  return {
    key,
    account: st.meta.account,
    name: st.meta.name,
    company: st.meta.company,
    tradeDate: st.meta.tradeDate,
    file: rawFile,
    importedAt: importedAt || st.meta.importedAt || null,
    dataVersion: DATA_VERSION,
    checksum: checksumOf(st),
    counts: { trades: st.trades.length, closes: st.closes.length, positions: st.positions.length, lots: st.trades.reduce((a, t) => a + t.lots, 0) },
    fee: st.funds.fee,
    closePnl: st.funds.closePnl,
    equity: st.funds.equity,
    riskRatio: st.funds.riskRatio,
    chainOk: st.checks ? st.checks.chainOk : null,
  };
}

function saveIndex(dataDir, idx) {
  atomicWrite(indexPath(dataDir), JSON.stringify(idx, null, 2));
}

// ---------- 磁盘空间 ----------
function freeSpaceOk(dataDir, neededMB = 100) {
  try {
    const s = fs.statfsSync(dataDir);
    const freeMB = (s.bavail * s.bsize) / (1024 * 1024);
    return { ok: freeMB > neededMB, freeMB: Math.round(freeMB) };
  } catch {
    return { ok: true, freeMB: null }; // 查询失败不阻塞
  }
}

// ---------- 备份 ----------
function createBackup(dataDir, reason) {
  const dir = backupsDir(dataDir);
  ensureDir(dir);
  const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const dest = path.join(dir, `${ts}__${reason}`);
  ensureDir(path.join(dest, 'statements'));
  for (const f of fs.readdirSync(path.join(dataDir, 'statements'))) {
    if (f.endsWith('.json')) fs.copyFileSync(path.join(dataDir, 'statements', f), path.join(dest, 'statements', f));
  }
  if (fs.existsSync(indexPath(dataDir))) fs.copyFileSync(indexPath(dataDir), path.join(dest, 'index.json'));
  if (fs.existsSync(path.join(dataDir, 'config.json'))) fs.copyFileSync(path.join(dataDir, 'config.json'), path.join(dest, 'config.json'));

  // 滚动清理旧备份
  const all = fs.readdirSync(dir).sort();
  while (all.length > BACKUP_KEEP) {
    const old = all.shift();
    fs.rmSync(path.join(dir, old), { recursive: true, force: true });
  }
  return dest;
}

function listBackups(dataDir) {
  const dir = backupsDir(dataDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort().reverse().map(name => {
    const full = path.join(dir, name);
    let count = 0;
    try { count = fs.readdirSync(path.join(full, 'statements')).filter(f => f.endsWith('.json')).length; } catch { /* ignore */ }
    const st = fs.statSync(full);
    return { name, statements: count, createdAt: st.birthtime.toISOString() };
  });
}

// 导出完整备份（含原始 xls）到用户选择的目录
function exportBackup(dataDir, targetDir) {
  const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const dest = path.join(targetDir, `期货结算数据备份-${ts}`);
  ensureDir(dest);
  for (const sub of ['statements', 'raw']) {
    const src = path.join(dataDir, sub);
    if (fs.existsSync(src)) {
      ensureDir(path.join(dest, sub));
      for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(dest, sub, f));
    }
  }
  for (const f of ['index.json', 'config.json']) {
    if (fs.existsSync(path.join(dataDir, f))) fs.copyFileSync(path.join(dataDir, f), path.join(dest, f));
  }
  return dest;
}

// 从备份目录恢复（覆盖当前数据）
function restoreBackup(dataDir, backupPath) {
  const bi = path.join(backupPath, 'index.json');
  if (!fs.existsSync(bi)) throw new Error('所选目录不是有效备份（缺少 index.json）');
  // 先备份当前状态
  createBackup(dataDir, '恢复前自动备份');
  for (const sub of ['statements', 'raw']) {
    const src = path.join(backupPath, sub);
    const dst = path.join(dataDir, sub);
    fs.rmSync(dst, { recursive: true, force: true });
    if (fs.existsSync(src)) {
      ensureDir(dst);
      for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(dst, f));
    }
  }
  fs.copyFileSync(bi, indexPath(dataDir));
  const bc = path.join(backupPath, 'config.json');
  if (fs.existsSync(bc)) fs.copyFileSync(bc, path.join(dataDir, 'config.json'));
  return true;
}

// ---------- 回收站 ----------
function removeStatement(dataDir, key) {
  const idx = loadIndex(dataDir);
  const entry = idx.statements.find(s => s.key === key);
  idx.statements = idx.statements.filter(s => s.key !== key);
  saveIndex(dataDir, idx);
  ensureDir(trashDir(dataDir));
  const sp = path.join(dataDir, 'statements', `${key}.json`);
  if (fs.existsSync(sp)) fs.renameSync(sp, path.join(trashDir(dataDir), `${key}.json`));
  if (entry && entry.file) {
    const rp = path.join(dataDir, 'raw', entry.file);
    if (fs.existsSync(rp)) fs.renameSync(rp, path.join(trashDir(dataDir), entry.file));
  }
  createBackup(dataDir, '删除后自动备份');
}

function listTrash(dataDir) {
  const dir = trashDir(dataDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => {
    const key = f.replace(/\.json$/, '');
    let tradeDate = key, account = '';
    try {
      const st = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      tradeDate = st.meta.tradeDate; account = st.meta.account;
    } catch { /* ignore */ }
    return { key, tradeDate, account };
  }).sort((a, b) => b.tradeDate.localeCompare(a.tradeDate));
}

function restoreTrash(dataDir, key) {
  const dir = trashDir(dataDir);
  const sp = path.join(dir, `${key}.json`);
  if (!fs.existsSync(sp)) throw new Error('回收站中不存在该记录');
  const st = JSON.parse(fs.readFileSync(sp, 'utf8'));
  ensureDir(path.join(dataDir, 'statements'));
  fs.renameSync(sp, path.join(dataDir, 'statements', `${key}.json`));
  // 原始文件如果也在回收站则一并还原
  const rawSrc = fs.readdirSync(dir).find(f => f.startsWith(key + '__'));
  if (rawSrc) fs.renameSync(path.join(dir, rawSrc), path.join(dataDir, 'raw', rawSrc));
  const idx = loadIndex(dataDir);
  if (!idx.statements.some(s => s.key === key)) {
    idx.statements.push(entryFromStatement(st, key, rawSrc || `${key}__recovered.xls`, new Date().toISOString()));
    idx.statements.sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
    saveIndex(dataDir, idx);
  }
  createBackup(dataDir, '恢复后自动备份');
  return true;
}

function purgeTrash(dataDir) {
  const dir = trashDir(dataDir);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

// ---------- 导入 ----------
function importFiles(dataDir, filePaths, mode = 'skip', opts = {}) {
  const disk = freeSpaceOk(dataDir);
  if (!disk.ok) {
    return filePaths.map(fp => ({ file: path.basename(fp), ok: false, error: `磁盘剩余空间不足（${disk.freeMB} MB），请先清理` }));
  }
  ensureDir(path.join(dataDir, 'statements'));
  ensureDir(path.join(dataDir, 'raw'));
  const idx = loadIndex(dataDir);
  const results = [];
  let anySuccess = false;

  for (const fp of filePaths) {
    let st;
    try {
      st = parseStatement(fp);
    } catch (e) {
      results.push({ file: path.basename(fp), ok: false, error: '解析失败：' + e.message });
      continue;
    }
    if (st.errors && st.errors.length) {
      results.push({ file: path.basename(fp), ok: false, error: st.errors.join('；') });
      continue;
    }

    // 文件名日期与内容交易日一致性校验（文件名形如 123456789_2026-09-21.xls）
    const m = path.basename(fp).match(/(\d{4}-\d{2}-\d{2})/);
    if (m && m[1] !== st.meta.tradeDate) {
      results.push({ file: path.basename(fp), ok: false, error: `文件名日期 ${m[1]} 与内容交易日 ${st.meta.tradeDate} 不一致，已拦截` });
      continue;
    }

    const key = `${st.meta.account}_${st.meta.tradeDate}`;
    const existing = idx.statements.find(s => s.key === key);
    if (existing && mode === 'skip') {
      results.push({ file: path.basename(fp), ok: true, skipped: true, key, tradeDate: st.meta.tradeDate, message: '该交易日已存在，已跳过' });
      continue;
    }

    st.meta.importedAt = new Date().toISOString();
    st.dataVersion = DATA_VERSION;
    const rawName = `${key}__${path.basename(fp)}`;
    try {
      // 先归档原始文件，成功后再写解析结果，避免两处不一致
      fs.copyFileSync(fp, path.join(dataDir, 'raw', rawName));
      atomicWrite(path.join(dataDir, 'statements', `${key}.json`), JSON.stringify(st, null, 2));
    } catch (e) {
      results.push({ file: path.basename(fp), ok: false, error: '写入数据目录失败：' + e.message });
      continue;
    }

    const entry = entryFromStatement(st, key, rawName, st.meta.importedAt);
    if (existing) idx.statements = idx.statements.map(s => (s.key === key ? entry : s));
    else idx.statements.push(entry);
    anySuccess = true;
    results.push({ file: path.basename(fp), ok: true, skipped: false, key, tradeDate: st.meta.tradeDate, message: existing ? '已覆盖原数据' : '导入成功' });
  }

  idx.statements.sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
  saveIndex(dataDir, idx);
  if (anySuccess) {
    try { createBackup(dataDir, '导入后自动备份'); } catch { /* 备份失败不影响导入 */ }
    const cfg = loadConfig(dataDir);
    if (cfg.backupDir && cfg.backupDir !== dataDir) {
      try { syncExternalBackup(dataDir, cfg.backupDir); } catch { /* 外部备份失败不阻塞 */ }
    }
  }
  return results;
}

// 外部备份目录同步（增量复制 statements + index + config）
function syncExternalBackup(dataDir, targetDir) {
  ensureDir(targetDir);
  const destSt = path.join(targetDir, 'statements');
  ensureDir(destSt);
  for (const f of fs.readdirSync(path.join(dataDir, 'statements'))) {
    if (f.endsWith('.json')) fs.copyFileSync(path.join(dataDir, 'statements', f), path.join(destSt, f));
  }
  for (const f of ['index.json', 'config.json']) {
    if (fs.existsSync(path.join(dataDir, f))) fs.copyFileSync(path.join(dataDir, f), path.join(targetDir, f));
  }
}

// ---------- 读取 ----------
function loadStatement(dataDir, key) {
  const p = path.join(dataDir, 'statements', `${key}.json`);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function loadAll(dataDir, account = null) {
  const idx = loadIndex(dataDir);
  return idx.statements
    .filter(e => !account || e.account === account)
    .map(e => loadStatement(dataDir, e.key))
    .filter(Boolean);
}

// ---------- 汇总计算 ----------
function computeOverview(dataDir, account = null) {
  const cfg = loadConfig(dataDir);
  const all = loadAll(dataDir, account);
  if (!all.length) return { empty: true, config: cfg, accounts: listAccounts(dataDir) };

  const sorted = all.slice().sort((a, b) => a.meta.tradeDate.localeCompare(b.meta.tradeDate));
  let cumDeposit = cfg.initialDeposit || 0;
  const byDate = sorted.map(st => {
    const f = st.funds;
    const netDeposit = (st.cashflows || []).reduce((a, c) => a + (c.deposit || 0) - (c.withdraw || 0), 0);
    cumDeposit += netDeposit;
    return {
      key: `${st.meta.account}_${st.meta.tradeDate}`,
      account: st.meta.account,
      date: st.meta.tradeDate,
      closePnl: f.closePnl || 0,
      fee: f.fee || 0,
      netPnl: (f.closePnl || 0) - (f.fee || 0),
      floatPnl: f.floatPnl || 0,
      dayPnl: (f.closePnl || 0) + (f.floatPnl || 0) - (f.fee || 0),
      deposit: netDeposit,
      cumDeposit: +cumDeposit.toFixed(2),
      equity: f.equity,
      balance: f.balance,
      available: f.available,
      margin: f.margin,
      riskRatio: f.riskRatio,
      lots: st.trades.reduce((a, t) => a + t.lots, 0),
      trades: st.trades.length,
      chainOk: st.checks ? st.checks.chainOk : null,
    };
  });

  for (const d of byDate) d.nav = d.equity === null ? null : +(d.equity - d.cumDeposit).toFixed(2);

  // 最大回撤
  let peak = -Infinity, maxDD = 0, ddStart = null, ddEnd = null, curPeakDate = null;
  for (const d of byDate) {
    if (d.nav === null) continue;
    if (d.nav > peak) { peak = d.nav; curPeakDate = d.date; }
    const dd = peak - d.nav;
    if (dd > maxDD) { maxDD = dd; ddStart = curPeakDate; ddEnd = d.date; }
  }

  // 日胜率 / 连续盈亏天数
  let upDays = 0, downDays = 0, curStreak = 0, maxWinStreak = 0, maxLossStreak = 0;
  for (const d of byDate) {
    if (d.dayPnl > 0) upDays++; else if (d.dayPnl < 0) downDays++;
    const sign = d.dayPnl > 0 ? 1 : d.dayPnl < 0 ? -1 : 0;
    if (sign === 0) { curStreak = 0; continue; }
    if (curStreak === 0 || Math.sign(curStreak) === sign) curStreak += sign;
    else curStreak = sign;
    if (curStreak > maxWinStreak) maxWinStreak = curStreak;
    if (-curStreak > maxLossStreak) maxLossStreak = -curStreak;
  }

  // 月度汇总
  const monthMap = new Map();
  for (const d of byDate) {
    const m = d.date.slice(0, 7);
    if (!monthMap.has(m)) monthMap.set(m, { month: m, closePnl: 0, fee: 0, floatPnl: 0, netPnl: 0, dayPnl: 0, deposit: 0, lots: 0, trades: 0, endEquity: null, endRiskRatio: null });
    const o = monthMap.get(m);
    o.closePnl += d.closePnl; o.fee += d.fee; o.floatPnl += d.floatPnl;
    o.netPnl += d.netPnl; o.dayPnl += d.dayPnl; o.deposit += d.deposit;
    o.lots += d.lots; o.trades += d.trades;
    o.endEquity = d.equity; o.endRiskRatio = d.riskRatio;
  }
  const monthly = [...monthMap.values()].map(o => ({
    ...o,
    closePnl: +o.closePnl.toFixed(2), fee: +o.fee.toFixed(2), floatPnl: +o.floatPnl.toFixed(2),
    netPnl: +o.netPnl.toFixed(2), dayPnl: +o.dayPnl.toFixed(2), deposit: +o.deposit.toFixed(2),
  }));

  // 品种累计序列
  const productSet = new Set();
  for (const st of sorted) for (const p of st.productSummary) productSet.add(p.product);
  const productSeries = {};
  for (const p of productSet) productSeries[p] = [];
  {
    let acc = {};
    for (const st of sorted) {
      for (const p of productSet) {
        const row = (st.productSummary || []).find(x => x.product === p);
        acc[p] = +((acc[p] || 0) + (row ? row.closePnl - row.fee : 0)).toFixed(2);
        productSeries[p].push(acc[p]);
      }
    }
  }

  // 成交/平仓扁平化（平仓明细"原成交序号"为截断短号，取末 12 位关联）
  const normSeq = s => (s || '').replace(/\D/g, '').slice(-12);
  const flatTrades = [];
  const tradeBySeq = new Map();
  for (const st of sorted) {
    for (const t of st.trades) {
      const row = { ...t, key: `${st.meta.account}_${st.meta.tradeDate}`, account: st.meta.account, date: t.date || st.meta.tradeDate, product: productOf(t.contract) };
      flatTrades.push(row);
      if (t.seq) tradeBySeq.set(normSeq(t.seq), row);
    }
  }
  flatTrades.sort((a, b) => (a.date + a.time + a.seq).localeCompare(b.date + b.time + b.seq));

  const flatCloses = [];
  for (const st of sorted) {
    for (const c of st.closes) {
      flatCloses.push({ ...c, key: `${st.meta.account}_${st.meta.tradeDate}`, account: st.meta.account, date: c.date || st.meta.tradeDate, product: productOf(c.contract) });
    }
  }

  // 手续费拆分：开仓 / 平仓-日内 / 平仓-隔夜 / 平仓-未知
  let feeOpen = 0, feeCloseIntra = 0, feeCloseOvernight = 0, feeCloseUnknown = 0;
  for (const t of flatTrades) {
    if (t.openClose === '开') { feeOpen += t.fee || 0; continue; }
    const open = tradeBySeq.get(normSeq(t.seq));
    if (!open) feeCloseUnknown += t.fee || 0;
    else if (open.date === t.date) feeCloseIntra += t.fee || 0;
    else feeCloseOvernight += t.fee || 0;
  }

  // 品种统计
  const byProduct = new Map();
  for (const t of flatTrades) {
    if (!byProduct.has(t.product)) byProduct.set(t.product, { product: t.product, lots: 0, amount: 0, fee: 0, closePnl: 0, netPnl: 0, trades: 0, wins: 0, losses: 0 });
    const o = byProduct.get(t.product);
    o.lots += t.lots; o.amount += t.amount || 0; o.fee += t.fee || 0; o.trades += 1;
    if (t.closePnl !== null) { o.closePnl += t.closePnl; if (t.closePnl > 0) o.wins++; else if (t.closePnl < 0) o.losses++; }
  }
  const products = [...byProduct.values()].map(o => ({ ...o, netPnl: +(o.closePnl - o.fee).toFixed(2), closePnl: +o.closePnl.toFixed(2), fee: +o.fee.toFixed(2), amount: +o.amount.toFixed(2), winRate: (o.wins + o.losses) ? o.wins / (o.wins + o.losses) : null })).sort((a, b) => b.netPnl - a.netPnl);

  // 交易行为统计
  let wins = 0, losses = 0, winSum = 0, lossSum = 0;
  let intraWins = 0, intraLosses = 0, intraPnl = 0, ovnWins = 0, ovnLosses = 0, ovnPnl = 0;
  for (const c of flatCloses) {
    if (c.closePnl > 0) { wins++; winSum += c.closePnl; } else if (c.closePnl < 0) { losses++; lossSum += c.closePnl; }
    const open = tradeBySeq.get(normSeq(c.origSeq));
    const isIntraday = open ? open.date === c.date : null;
    if (isIntraday === true) { intraPnl += c.closePnl; if (c.closePnl > 0) intraWins++; else if (c.closePnl < 0) intraLosses++; }
    else if (isIntraday === false) { ovnPnl += c.closePnl; if (c.closePnl > 0) ovnWins++; else if (c.closePnl < 0) ovnLosses++; }
  }
  const avgWin = wins ? winSum / wins : null;
  const avgLoss = losses ? lossSum / losses : null;
  const maxDailyProfit = Math.max(...byDate.map(d => d.dayPnl));
  const maxDailyLoss = Math.min(...byDate.map(d => d.dayPnl));

  const totalFee = byDate.reduce((a, d) => a + d.fee, 0);
  const totalClosePnl = byDate.reduce((a, d) => a + d.closePnl, 0);
  const totalFloatPnl = byDate.reduce((a, d) => a + d.floatPnl, 0);
  const last = byDate[byDate.length - 1];
  const latestMonth = last.date.slice(0, 7);
  const monthFee = byDate.filter(d => d.date.startsWith(latestMonth)).reduce((a, d) => a + d.fee, 0);

  // 最新持仓（逐笔 + 合约级保证金按手数分摊）
  const latestStmt = sorted[sorted.length - 1];
  const marginByContract = new Map();
  for (const ps of latestStmt.positionSummary || []) marginByContract.set(ps.contract, ps);
  const latestPositions = (latestStmt.positions || []).map(p => {
    const summary = marginByContract.get(p.contract) || {};
    const lots = p.buyLots || p.sellLots || 0;
    const contractLots = (summary.buyLots || 0) + (summary.sellLots || 0);
    return {
      ...p,
      margin: summary.margin != null && contractLots ? +((summary.margin * lots) / contractLots).toFixed(2) : null,
      lots,
      direction: p.buyLots ? '买' : '卖',
      openPrice: p.buyLots ? p.buyPrice : p.sellPrice,
    };
  });

  // 历史持仓索引：日期 → 持仓行
  const positionsByDate = sorted
    .filter(st => (st.positions || []).length > 0)
    .map(st => ({ date: st.meta.tradeDate, positions: st.positions, positionSummary: st.positionSummary || [] }));

  // 提示：期权/证券/其他未统计内容
  const notices = [];
  for (const st of sorted) {
    const d = st.meta.tradeDate;
    if ((st.optionTrades || []).length) notices.push({ date: d, text: `含期权成交 ${st.optionTrades.length} 笔，暂未纳入统计` });
    if ((st.securitiesTrades || []).length) notices.push({ date: d, text: `含证券成交 ${st.securitiesTrades.length} 笔，暂未纳入统计` });
  }

  return {
    empty: false,
    config: cfg,
    accounts: listAccounts(dataDir),
    account,
    meta: { account: latestStmt.meta.account, name: latestStmt.meta.name, company: latestStmt.meta.company, days: all.length },
    kpis: {
      latestEquity: last.equity,
      latestBalance: last.balance,
      latestDate: last.date,
      latestDayPnl: last.dayPnl,
      latestClosePnl: last.closePnl,
      latestNetPnl: last.netPnl,
      latestFloatPnl: last.floatPnl,
      latestFee: last.fee,
      latestMonth, monthFee,
      cumDeposit: last.cumDeposit,
      nav: last.nav,
      totalClosePnl: +totalClosePnl.toFixed(2),
      totalFloatPnl: +totalFloatPnl.toFixed(2),
      totalFee: +totalFee.toFixed(2),
      feeToGrossPnl: totalClosePnl > 0 ? totalFee / totalClosePnl : null,
      latestRiskRatio: last.riskRatio,
      latestAvailable: last.available,
      latestMargin: last.margin,
      winRate: (wins + losses) ? wins / (wins + losses) : null,
      closeCount: wins + losses,
      avgWin: avgWin === null ? null : +avgWin.toFixed(2),
      avgLoss: avgLoss === null ? null : +avgLoss.toFixed(2),
      plRatio: avgWin !== null && avgLoss !== null && avgLoss !== 0 ? +(avgWin / Math.abs(avgLoss)).toFixed(2) : null,
      maxDailyProfit: +maxDailyProfit.toFixed(2),
      maxDailyLoss: +maxDailyLoss.toFixed(2),
      maxDrawdown: +maxDD.toFixed(2),
      maxDDStart: ddStart, maxDDEnd: ddEnd,
      dayWinRate: (upDays + downDays) ? upDays / (upDays + downDays) : null,
      upDays, downDays,
      maxWinStreak, maxLossStreak,
      feeOpen: +feeOpen.toFixed(2),
      feeCloseIntra: +feeCloseIntra.toFixed(2),
      feeCloseOvernight: +feeCloseOvernight.toFixed(2),
      feeCloseUnknown: +feeCloseUnknown.toFixed(2),
      intraday: { trades: intraWins + intraLosses, wins: intraWins, pnl: +intraPnl.toFixed(2), winRate: (intraWins + intraLosses) ? intraWins / (intraWins + intraLosses) : null },
      overnight: { trades: ovnWins + ovnLosses, wins: ovnWins, pnl: +ovnPnl.toFixed(2), winRate: (ovnWins + ovnLosses) ? ovnWins / (ovnWins + ovnLosses) : null },
    },
    byDate,
    monthly,
    productSeries,
    products,
    trades: flatTrades,
    closes: flatCloses,
    latestPositions,
    positionsByDate,
    notices,
  };
}

// 历史持仓查询：返回指定日期的持仓（含合约级保证金）
function positionsAt(dataDir, date, account = null) {
  const all = loadAll(dataDir, account);
  const st = all.find(s => s.meta.tradeDate === date);
  if (!st) return null;
  const marginByContract = new Map();
  for (const ps of st.positionSummary || []) marginByContract.set(ps.contract, ps);
  return {
    date,
    positions: (st.positions || []).map(p => {
      const summary = marginByContract.get(p.contract) || {};
      const lots = p.buyLots || p.sellLots || 0;
      const contractLots = (summary.buyLots || 0) + (summary.sellLots || 0);
      return {
        ...p,
        margin: summary.margin != null && contractLots ? +((summary.margin * lots) / contractLots).toFixed(2) : null,
        lots,
        direction: p.buyLots ? '买' : '卖',
        openPrice: p.buyLots ? p.buyPrice : p.sellPrice,
      };
    }),
  };
}

function listAccounts(dataDir) {
  const idx = loadIndex(dataDir);
  const set = new Set(idx.statements.map(s => s.account));
  return [...set].filter(Boolean).sort();
}

// ---------- 健康信息 ----------
function dirSize(p) {
  let total = 0;
  try {
    for (const f of fs.readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, f.name);
      if (f.isDirectory()) total += dirSize(full);
      else total += fs.statSync(full).size;
    }
  } catch { /* ignore */ }
  return total;
}

function health(dataDir) {
  const idx = loadIndex(dataDir);
  const statements = idx.statements || [];
  let checksumBad = [];
  for (const e of statements) {
    if (!e.checksum) continue;
    const st = loadStatement(dataDir, e.key);
    if (!st || checksumOf(st) !== e.checksum) checksumBad.push(e.tradeDate);
  }
  const chainBad = statements.filter(e => e.chainOk === false).map(e => e.tradeDate);
  const lastImport = statements.length ? statements.reduce((a, b) => (a.importedAt > b.importedAt ? a : b)).importedAt : null;
  const bytes = dirSize(dataDir);
  return {
    days: statements.length,
    dirSizeMB: bytes >= 1024 * 1024 ? +(bytes / (1024 * 1024)).toFixed(1) : +(bytes / 1024).toFixed(0),
    dirSizeUnit: bytes >= 1024 * 1024 ? 'MB' : 'KB',
    rawCount: fs.existsSync(path.join(dataDir, 'raw')) ? fs.readdirSync(path.join(dataDir, 'raw')).length : 0,
    backups: listBackups(dataDir),
    backupCount: listBackups(dataDir).length,
    trashCount: listTrash(dataDir).length,
    checksumBad,
    chainBad,
    lastImport,
    indexRebuilt: !!idx.rebuilt,
    accounts: listAccounts(dataDir),
  };
}

module.exports = {
  DATA_VERSION,
  importFiles, loadIndex, rebuildIndex, loadAll, loadStatement, removeStatement,
  computeOverview, positionsAt, listAccounts, health,
  loadConfig, saveConfig,
  createBackup, listBackups, exportBackup, restoreBackup,
  listTrash, restoreTrash, purgeTrash,
  freeSpaceOk,
};
