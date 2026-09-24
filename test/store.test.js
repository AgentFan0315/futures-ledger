'use strict';
// store.js 单元测试：原子写/索引自愈/回收站/备份/月度/手续费拆分/连胜/多账户/健康/磁盘
const path = require('path');
const os = require('os');
const fs = require('fs');
const store = require('../src/store');

const FIX = __dirname + '/fixtures/';
let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`✓ ${name}${detail ? '（' + detail + '）' : ''}`); }
  else { fail++; console.log(`✗ ${name}${detail ? '（' + detail + '）' : ''}`); }
};
function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-store-')); }

// ---------- 导入与原子写 ----------
{
  const dir = tmpDir();
  const r = store.importFiles(dir, [FIX + '123456789_2026-09-21.xls', FIX + '123456789_2026-09-22.xls'], 'skip');
  check('导入成功', r.every(x => x.ok && !x.skipped));
  check('dataVersion 写入', store.loadStatement(dir, '123456789_2026-09-21').dataVersion === 1);
  const idx = store.loadIndex(dir);
  check('索引含校验和', idx.statements.every(e => e.checksum && e.checksum.length === 16));
  check('原子写不留临时文件', !fs.readdirSync(path.join(dir, 'statements')).some(f => f.includes('.tmp-')));

  // 校验和：篡改后 health 能发现
  const sp = path.join(dir, 'statements', '123456789_2026-09-21.json');
  const st = JSON.parse(fs.readFileSync(sp, 'utf8'));
  st.funds.equity = 1; // 篡改
  fs.writeFileSync(sp, JSON.stringify(st, null, 2));
  const h = store.health(dir);
  check('校验和发现篡改', h.checksumBad.includes('2026-09-21'));
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------- 索引自愈 ----------
{
  const dir = tmpDir();
  store.importFiles(dir, [FIX + '123456789_2026-09-21.xls'], 'skip');
  fs.writeFileSync(path.join(dir, 'index.json'), '{broken json!!!');
  const idx = store.loadIndex(dir);
  check('索引损坏后自愈重建', idx.statements.length === 1 && idx.rebuilt === true, `statements=${idx.statements.length}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------- 文件名日期拦截 ----------
{
  const dir = tmpDir();
  fs.copyFileSync(FIX + '123456789_2026-09-21.xls', path.join(dir, '123456789_2026-09-99.xls'));
  const r = store.importFiles(dir, [path.join(dir, '123456789_2026-09-99.xls')], 'skip');
  check('文件名日期不一致被拦截', !r[0].ok && r[0].error.includes('不一致'), r[0].error);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------- 回收站 ----------
{
  const dir = tmpDir();
  store.importFiles(dir, [FIX + '123456789_2026-09-21.xls'], 'skip');
  store.removeStatement(dir, '123456789_2026-09-21');
  check('删除后从索引移除', store.loadIndex(dir).statements.length === 0);
  check('删除后进入回收站', store.listTrash(dir).length === 1);
  check('删除后 statements 无残留', !fs.existsSync(path.join(dir, 'statements', '123456789_2026-09-21.json')));
  store.restoreTrash(dir, '123456789_2026-09-21');
  check('回收站恢复', store.loadIndex(dir).statements.length === 1 && store.listTrash(dir).length === 0);
  store.removeStatement(dir, '123456789_2026-09-21');
  store.purgeTrash(dir);
  check('清空回收站', store.listTrash(dir).length === 0);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------- 备份 ----------
{
  const dir = tmpDir();
  store.importFiles(dir, [FIX + '123456789_2026-09-21.xls'], 'skip');
  const backups = store.listBackups(dir);
  check('导入后自动生成备份', backups.length >= 1 && backups[0].statements === 1);
  // 导出完整备份（含 raw）
  const out = tmpDir();
  const dest = store.exportBackup(dir, out);
  check('导出完整备份含 raw', fs.existsSync(path.join(dest, 'raw')) && fs.readdirSync(path.join(dest, 'raw')).length === 1);
  // 恢复
  store.removeStatement(dir, '123456789_2026-09-21');
  store.purgeTrash(dir);
  check('删除后无数据', store.loadIndex(dir).statements.length === 0);
  store.restoreBackup(dir, dest);
  check('从备份恢复', store.loadIndex(dir).statements.length === 1);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(out, { recursive: true, force: true });
}

// ---------- 汇总：月度/手续费拆分/连胜/多账户 ----------
{
  const dir = tmpDir();
  store.importFiles(dir, [FIX + '123456789_2026-09-21.xls', FIX + '123456789_2026-09-22.xls'], 'skip');
  const ov = store.computeOverview(dir);

  check('月度汇总', ov.monthly.length === 1 && ov.monthly[0].month === '2026-09' && Math.abs(ov.monthly[0].fee - 1998.32) < 0.01, JSON.stringify(ov.monthly[0]));
  // 手续费拆分：开仓费 + 平仓费 = 总手续费 1998.32；日内平仓费 AU 应为 0.05×10=0.5（9/22 平今）
  const fs2 = ov.kpis;
  check('手续费拆分合计', Math.abs(fs2.feeOpen + fs2.feeCloseIntra + fs2.feeCloseOvernight + fs2.feeCloseUnknown - fs2.totalFee) < 0.02,
    `open=${fs2.feeOpen} intra=${fs2.feeCloseIntra} ovn=${fs2.feeCloseOvernight} unk=${fs2.feeCloseUnknown} total=${fs2.totalFee}`);
  check('日胜率', ov.kpis.upDays === 2 && ov.kpis.downDays === 0 && ov.kpis.dayWinRate === 1);
  check('连续盈利 2 天', ov.kpis.maxWinStreak === 2 && ov.kpis.maxLossStreak === 0);

  // 多账户：伪造第二账户数据
  const st = store.loadStatement(dir, '123456789_2026-09-21');
  st.meta.account = '999999999';
  fs.writeFileSync(path.join(dir, 'statements', '999999999_2026-09-21.json'), JSON.stringify(st, null, 2));
  const idx = store.loadIndex(dir);
  idx.statements.push({ key: '999999999_2026-09-21', account: '999999999', name: st.meta.name, company: st.meta.company, tradeDate: st.meta.tradeDate, file: '', counts: { trades: 0, closes: 0, positions: 0, lots: 0 }, fee: 0, closePnl: 0, equity: 0, riskRatio: 0, chainOk: true });
  store.saveIndex ? null : null;
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(idx, null, 2));
  check('账户列表', store.listAccounts(dir).length === 2);
  const ovAcc = store.computeOverview(dir, '123456789');
  check('按账户过滤', ovAcc.meta.account === '123456789' && ovAcc.byDate.length === 2);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------- 健康信息 ----------
{
  const dir = tmpDir();
  store.importFiles(dir, [FIX + '123456789_2026-09-21.xls'], 'skip');
  const h = store.health(dir);
  check('健康信息字段', h.days === 1 && h.dirSizeMB > 0 && h.chainBad.length === 0 && h.checksumBad.length === 0 && h.dirSizeUnit === 'KB');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(fail ? `\n${fail} 项失败` : '\n全部通过 ✓');
process.exit(fail ? 1 : 0);
