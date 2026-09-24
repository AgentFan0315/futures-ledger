'use strict';
// 验收测试：node test/acceptance.js
// 数据正确性验收（预警功能已按需求移除）
const path = require('path');
const os = require('os');
const fs = require('fs');
const store = require('../src/store');

const A = __dirname + '/fixtures/';
const files = [A + '123456789_2026-09-21.xls', A + '123456789_2026-09-22.xls'];

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-accept-'));
store.importFiles(dataDir, files, 'skip');
const ov = store.computeOverview(dataDir);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`✓ ${name}${detail ? '（' + detail + '）' : ''}`); }
  else { fail++; console.log(`✗ ${name}${detail ? '（' + detail + '）' : ''}`); }
};

// 验收 1：每日客户权益与结算单原文分毫不差（原文值：9/21 = 900,444.63；9/22 = 903,171.68）
const eq21 = ov.byDate.find(d => d.date === '2026-09-21');
const eq22 = ov.byDate.find(d => d.date === '2026-09-22');
check('权益分毫不差', eq21.equity === 900444.63 && eq22.equity === 903171.68, `${eq21?.equity} / ${eq22?.equity}`);

// 链式验算两日全部通过（上日结存+出入金+平仓盈亏+浮动盈亏−手续费 = 客户权益）
check('链式验算全部通过', ov.byDate.every(d => d.chainOk === true));

// 验收 2：品种累计盈亏（透明口径：品种平仓盈亏 − 该品种全部手续费）
const ag = ov.products.find(p => p.product === 'AG');
const au = ov.products.find(p => p.product === 'AU');
console.log(`  品种累计（平仓盈亏−全部手续费）：AG ${ag.netPnl} / AU ${au.netPnl}`);
console.log(`  品种累计（纯平仓盈亏）：AG ${ag.closePnl} / AU ${au.closePnl}`);
check('品种盈亏方向正确（AG盈/AU亏）', ag.netPnl > 0 && au.netPnl < 0);

// 验收 3：风险度序列 30.41% → 90.47%
check('风险度 30.41%→90.47%',
  Math.abs(eq21.riskRatio - 0.3041) < 0.0001 && Math.abs(eq22.riskRatio - 0.9047) < 0.0001,
  `${eq21.riskRatio} → ${eq22.riskRatio}`);

// 品种汇总 sheet 解析（品种累计序列的数据源）
check('品种汇总解析', Array.isArray(ov.productSeries.AG) && ov.productSeries.AG.length === 2 && ov.productSeries.AG[1] === 4464.83, JSON.stringify(ov.productSeries));

// 日内/隔夜统计
check('日内平仓统计', ov.kpis.intraday.trades === 62 && Math.abs(ov.kpis.intraday.pnl - 3450) < 0.01, JSON.stringify(ov.kpis.intraday));

// 净值 = 权益 − 累计入金
check('净值口径', eq22.nav === 3171.68, `nav=${eq22.nav}`);

// 预警功能已移除：overview 不再包含 warnings，statement 不再记录公告
check('预警数据不记录', !('warnings' in ov), 'overview 无 warnings');
const st22 = store.loadStatement(dataDir, '123456789_2026-09-22');
check('公告不入库', !('announcements' in st22), 'statement 无 announcements');

fs.rmSync(dataDir, { recursive: true, force: true });
console.log(fail ? `\n${fail} 项失败` : '\n全部通过 ✓');
process.exit(fail ? 1 : 0);
