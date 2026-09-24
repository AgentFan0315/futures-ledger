'use strict';
// 开发用验证脚本：node test/verify.js <xls...>
const path = require('path');
const os = require('os');
const fs = require('fs');
const { parseStatement } = require('../src/parser');
const store = require('../src/store');

const files = process.argv.slice(2);
if (!files.length) { console.error('用法: node test/verify.js <结算单.xls...>'); process.exit(1); }

let fail = 0;
for (const f of files) {
  const st = parseStatement(f);
  console.log(`\n=== ${path.basename(f)} ===`);
  console.log('meta:', JSON.stringify(st.meta));
  console.log('funds:', JSON.stringify(st.funds));
  console.log(`trades=${st.trades.length} closes=${st.closes.length} positions=${st.positions.length} cashflows=${st.cashflows.length} otherFunds=${st.otherFunds.length}`);
  console.log('checks:', JSON.stringify(st.checks));
  if (st.errors.length) { console.log('ERRORS:', st.errors); fail++; }
  if (!st.checks.feeMatch) { console.log('!! 手续费对不上'); fail++; }
  if (!st.checks.closePnlMatch) { console.log('!! 平仓盈亏对不上'); fail++; }
  if (st.trades.length && !st.trades.every(t => t.contract && t.side && t.openClose)) { console.log('!! 成交明细字段缺失'); fail++; }
}

// 导入 + 汇总测试
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
console.log(`\n=== 导入到临时数据目录 ${dataDir} ===`);
let r = store.importFiles(dataDir, files, 'skip');
console.log(JSON.stringify(r, null, 1));
r = store.importFiles(dataDir, files, 'skip'); // 重复导入应跳过
if (!r.every(x => x.skipped)) { console.log('!! 重复导入未被跳过'); fail++; } else console.log('重复导入正确跳过');
r = store.importFiles(dataDir, files, 'overwrite'); // 覆盖
if (!r.every(x => !x.skipped)) { console.log('!! 覆盖模式异常'); fail++; } else console.log('覆盖模式正常');

const ov = store.computeOverview(dataDir);
console.log('\n=== 汇总 ===');
console.log('KPIs:', JSON.stringify(ov.kpis, null, 1));
console.log('byDate:', JSON.stringify(ov.byDate.map(d => ({ date: d.date, net: d.netPnl, cum: d.cumNetPnl, equity: d.equity, risk: d.riskRatio })), null, 1));
console.log('products:', JSON.stringify(ov.products, null, 1));
console.log(`总成交记录 ${ov.trades.length} 条，平仓记录 ${ov.closes.length} 条`);

// 期望核对（已知真实值）
const expect = { fee21: 140.37, pnl21: 405, fee22: 1857.95, pnl22: 3045 };
if (Math.abs(ov.kpis.totalFee - (expect.fee21 + expect.fee22)) > 0.01) { console.log('!! 累计手续费错误'); fail++; }
if (Math.abs(ov.kpis.totalClosePnl - (expect.pnl21 + expect.pnl22)) > 0.01) { console.log('!! 累计平仓盈亏错误'); fail++; }

fs.rmSync(dataDir, { recursive: true, force: true });
console.log(fail ? `\n共 ${fail} 项失败` : '\n全部通过 ✓');
process.exit(fail ? 1 : 0);
