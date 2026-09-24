'use strict';
// 解析示例期货客户交易结算日报 .xls → 规范化 JSON
const XLSX = require('xlsx');

// ---------- 基础工具 ----------

function cellText(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/ /g, ' ').trim();
}

// 表头归一化：全角/半角括号统一、去除所有空白字符，用于模板兼容匹配
function normHeader(s) {
  return cellText(s).replace(/[（(]/g, '(').replace(/[）)]/g, ')').replace(/\s+/g, '');
}

function toNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v;
  const s = String(v).replace(/,/g, '').replace(/￥/g, '').trim();
  if (s === '' || s === '--') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// 百分比："30.41%" → 0.3041
function toRatio(v) {
  if (typeof v === 'number') return v > 1 ? v / 100 : v;
  const s = cellText(v).replace(/%/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n / 100 : null;
}

// 日期 → 'YYYY-MM-DD'（兼容 Date 对象、Excel 序列号、字符串）
function toDateStr(v) {
  if (v instanceof Date && !isNaN(v)) {
    const y = v.getFullYear(), m = String(v.getMonth() + 1).padStart(2, '0'), d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    const d = XLSX.SSF.parse_date_code(v);
    if (d) return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
  }
  const s = cellText(v);
  const m = s.match(/(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  return s;
}

// 时间 → 'HH:MM:SS'（兼容字符串、Date、Excel 一天的小数）
function toTimeStr(v) {
  if (v instanceof Date && !isNaN(v)) {
    const p = n => String(n).padStart(2, '0');
    return `${p(v.getHours())}:${p(v.getMinutes())}:${p(v.getSeconds())}`;
  }
  if (typeof v === 'number' && v >= 0 && v < 1) {
    const sec = Math.round(v * 86400);
    const p = n => String(n).padStart(2, '0');
    return `${p(Math.floor(sec / 3600))}:${p(Math.floor((sec % 3600) / 60))}:${p(sec % 60)}`;
  }
  return cellText(v);
}

// 把 sheet 读成二维数组（raw 值）
function sheetRows(ws) {
  if (!ws || !ws['!ref']) return [];
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
}

// 在二维数组中查找表头行，返回 { rowIndex, colIndex }（按给定列名顺序匹配）
function findHeader(rows, names) {
  const norms = names.map(normHeader);
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;
    let start = -1, ok = true;
    for (let i = 0; i <= row.length - norms.length && start < 0; i++) {
      ok = true;
      for (let j = 0; j < norms.length; j++) {
        if (normHeader(row[i + j]) !== norms[j]) { ok = false; break; }
      }
      if (ok) start = i;
    }
    if (start >= 0) return { rowIndex: r, colIndex: start };
  }
  return null;
}

// 按表头名读取行数据为对象（同名表头自动加序号）
function rowsToObjects(rows, headerPos, expectedCols) {
  const { rowIndex, colIndex } = headerPos;
  const header = rows[rowIndex];
  const keys = [];
  const seen = {};
  for (let c = colIndex; c < header.length; c++) {
    let k = cellText(header[c]);
    if (expectedCols && !expectedCols.includes(k)) break;
    if (k) { seen[k] = (seen[k] || 0) + 1; keys.push(seen[k] > 1 ? `${k}#${seen[k]}` : k); }
    else keys.push(`__col${c}`);
  }
  const out = [];
  for (let r = rowIndex + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;
    const first = cellText(row[colIndex]);
    if (first === '合计' || first === '') {
      if (first === '') {
        // 允许中间有空行，但连续空行即结束
        if (!row.some(v => cellText(v) !== '')) continue;
      } else {
        continue;
      }
    }
    const obj = {};
    let hasAny = false;
    keys.forEach((k, i) => {
      const v = row[colIndex + i];
      if (cellText(v) !== '') hasAny = true;
      obj[k] = v;
    });
    if (hasAny) out.push(obj);
  }
  return out;
}

// 在整张表中按标签找值：返回标签右侧最近的非空单元格
function findLabeledValue(rows, label) {
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;
    for (let c = 0; c < row.length; c++) {
      if (cellText(row[c]) === label) {
        for (let k = c + 1; k <= c + 3 && k < row.length; k++) {
          if (cellText(row[k]) !== '') return row[k];
        }
      }
    }
  }
  return null;
}

// 定位小节：返回某标题行之后、下一个全空行之前的行范围
function sectionRows(rows, title) {
  let start = -1;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] || [];
    if (row.some(v => cellText(v) === title)) { start = r + 1; break; }
  }
  if (start < 0) return [];
  const out = [];
  for (let r = start; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.every(v => cellText(v) === '')) { if (out.length) break; else continue; }
    // 遇到下一个已知大标题则停止
    const t = cellText(row[0]);
    if (out.length && /(期货期权账户资金状况|期货成交汇总|期货持仓汇总|出入金明细|其它资金明细)/.test(t)) break;
    out.push(row);
  }
  return out;
}

// ---------- 各表解析 ----------

function parseMeta(rows) {
  return {
    account: cellText(findLabeledValue(rows, '客户期货期权内部资金账户')),
    name: cellText(findLabeledValue(rows, '客户名称')),
    company: cellText(findLabeledValue(rows, '期货公司名称')),
    tradeDate: toDateStr(findLabeledValue(rows, '交易日期')),
    queriedAt: cellText(findLabeledValue(rows, '查询时间')),
  };
}

// "盈亏计算方式：逐笔对冲" 位于各分表顶部（单元格内联），扫描提取
function parseHedgeType(rows) {
  for (const row of rows) {
    if (!row) continue;
    for (const v of row) {
      const t = cellText(v);
      const m = t.match(/^盈亏计算方式[:：]\s*(.+)$/);
      if (m) return m[1].trim();
    }
  }
  return cellText(findLabeledValue(rows, '盈亏计算方式')).replace(/^盈亏计算方式[:：]?\s*/, '');
}

function parseFunds(rows) {
  const g = (label, conv) => { const v = findLabeledValue(rows, label); return conv ? conv(v) : toNumber(v); };
  return {
    prevBalance: g('上日结存'),
    depositWithdraw: g('当日存取合计'),
    closePnl: g('平仓盈亏'),
    premium: g('当日总权利金'),
    fee: g('当日手续费'),
    balance: g('当日结存'),
    floatPnl: g('浮动盈亏'),
    equity: g('客户权益'),
    cash: g('实有货币资金'),
    nonCashPledge: g('非货币充抵金额'),
    cashPledge: g('货币充抵金额'),
    frozen: g('冻结资金'),
    margin: g('保证金占用'),
    available: g('可用资金'),
    riskRatio: g('风险度', toRatio),
    additionalMargin: g('追加保证金'),
  };
}

function parseCashflows(rows) {
  const sec = sectionRows(rows, '期货期权账户出入金明细（单位：人民币）');
  const out = [];
  for (const row of sec) {
    const date = toDateStr(row[0]);
    if (!date || date === '发生日期' || date === '合计') continue;
    out.push({
      date,
      deposit: toNumber(row[2]),
      withdraw: toNumber(row[4]),
      method: cellText(row[6]),
      summary: cellText(row[8]),
    });
  }
  return out;
}

function parseOtherFunds(rows) {
  const sec = sectionRows(rows, '其它资金明细（单位：人民币）');
  const out = [];
  for (const row of sec) {
    const date = toDateStr(row[0]);
    if (!date || date === '发生日期' || date === '合计') continue;
    out.push({
      date,
      exchange: cellText(row[2]),
      type: cellText(row[4]),
      amount: toNumber(row[6]),
      remark: cellText(row[8]),
    });
  }
  return out;
}

// 合法合约代码：1-2 个字母 + 3-4 位数字（AG2610、CF611、au2611）
function isContract(s) { return /^[A-Za-z]{1,2}\d{3,4}$/.test(s || ''); }

function parseTrades(rows) {
  const pos = findHeader(rows, ['合约', '成交序号', '成交时间', '买/卖', '投机（一般）/套保/套利', '成交价', '手数', '成交额', '开/平', '手续费', '平仓盈亏', '实际成交日期']);
  if (!pos) return [];
  return rowsToObjects(rows, pos, ['合约', '成交序号', '成交时间', '买/卖', '投机（一般）/套保/套利', '成交价', '手数', '成交额', '开/平', '手续费', '平仓盈亏', '实际成交日期'])
    .filter(o => isContract(cellText(o['合约'])))
    .map(o => ({
      contract: cellText(o['合约']),
      seq: cellText(o['成交序号']),
      time: toTimeStr(o['成交时间']),
      side: cellText(o['买/卖']),
      hedge: cellText(o['投机（一般）/套保/套利']),
      price: toNumber(o['成交价']),
      lots: toNumber(o['手数']) || 0,
      amount: toNumber(o['成交额']),
      openClose: cellText(o['开/平']),
      fee: toNumber(o['手续费']) || 0,
      closePnl: toNumber(o['平仓盈亏']),
      date: toDateStr(o['实际成交日期']),
    }));
}

function parseCloses(rows) {
  const pos = findHeader(rows, ['合约', '成交序号', '买/卖', '成交价', '开仓价', '手数', '昨结算价', '平仓盈亏', '原成交序号', '实际成交日期']);
  if (!pos) return [];
  return rowsToObjects(rows, pos, ['合约', '成交序号', '买/卖', '成交价', '开仓价', '手数', '昨结算价', '平仓盈亏', '原成交序号', '实际成交日期'])
    .filter(o => isContract(cellText(o['合约'])))
    .map(o => ({
      contract: cellText(o['合约']),
      seq: cellText(o['成交序号']),
      side: cellText(o['买/卖']),
      price: toNumber(o['成交价']),
      openPrice: toNumber(o['开仓价']),
      lots: toNumber(o['手数']) || 0,
      settle: toNumber(o['昨结算价']),
      closePnl: toNumber(o['平仓盈亏']),
      origSeq: cellText(o['原成交序号']),
      date: toDateStr(o['实际成交日期']),
    }));
}

function parsePositions(rows) {
  const pos = findHeader(rows, ['合约', '成交序号', '买持仓', '买入价', '卖持仓', '卖出价', '昨结算价', '今结算价', '浮动盈亏', '投机（一般）/套保/套利', '交易编码', '实际成交日期']);
  if (!pos) return [];
  return rowsToObjects(rows, pos, ['合约', '成交序号', '买持仓', '买入价', '卖持仓', '卖出价', '昨结算价', '今结算价', '浮动盈亏', '投机（一般）/套保/套利', '交易编码', '实际成交日期'])
    .filter(o => isContract(cellText(o['合约'])))
    .map(o => ({
      contract: cellText(o['合约']),
      seq: cellText(o['成交序号']),
      buyLots: toNumber(o['买持仓']),
      buyPrice: toNumber(o['买入价']),
      sellLots: toNumber(o['卖持仓']),
      sellPrice: toNumber(o['卖出价']),
      prevSettle: toNumber(o['昨结算价']),
      settle: toNumber(o['今结算价']),
      floatPnl: toNumber(o['浮动盈亏']),
      hedge: cellText(o['投机（一般）/套保/套利']),
      code: cellText(o['交易编码']),
      date: toDateStr(o['实际成交日期']),
    }));
}

// 宽松表头定位：允许列之间有空白间隔列（如 品种汇总 的 成交额 与 手续费 之间有空列）
function findHeaderLoose(rows, names) {
  names = names.map(normHeader);
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;
    const colMap = {};
    for (let c = 0; c < row.length; c++) {
      const t = normHeader(row[c]);
      if (names.includes(t) && !(t in colMap)) colMap[t] = c;
    }
    if (names.every(n => n in colMap)) return { rowIndex: r, colMap };
  }
  return null;
}

function parseProductSummary(rows) {
  const pos = findHeaderLoose(rows, ['品种', '手数', '成交额', '手续费', '平仓盈亏']);
  if (!pos) return [];
  const out = [];
  for (let r = pos.rowIndex + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;
    const product = cellText(row[pos.colMap['品种']]);
    if (!product || product === '合计') continue;
    out.push({
      product,
      lots: toNumber(row[pos.colMap['手数']]) || 0,
      amount: toNumber(row[pos.colMap['成交额']]),
      fee: toNumber(row[pos.colMap['手续费']]) || 0,
      closePnl: toNumber(row[pos.colMap['平仓盈亏']]) || 0,
    });
  }
  return out;
}

// 期货持仓汇总（在"客户交易结算日报"内）：合约级的交易保证金，用于保证金突变检测
function parsePositionSummary(rows) {
  const pos = findHeader(rows, ['合约', '买持仓', '买均价', '卖持仓', '卖均价', '昨结算价', '今结算价', '浮动盈亏', '交易保证金']);
  if (!pos) return [];
  return rowsToObjects(rows, pos, ['合约', '买持仓', '买均价', '卖持仓', '卖均价', '昨结算价', '今结算价', '浮动盈亏', '交易保证金', '投机（一般）/套保/套利'])
    .filter(o => isContract(cellText(o['合约'])))
    .map(o => ({
      contract: cellText(o['合约']),
      buyLots: toNumber(o['买持仓']),
      buyAvg: toNumber(o['买均价']),
      sellLots: toNumber(o['卖持仓']),
      sellAvg: toNumber(o['卖均价']),
      prevSettle: toNumber(o['昨结算价']),
      settle: toNumber(o['今结算价']),
      floatPnl: toNumber(o['浮动盈亏']) || 0,
      margin: toNumber(o['交易保证金']) || 0,
      hedge: cellText(o['投机（一般）/套保/套利']),
    }));
}

// ---------- 主入口 ----------

function parseOptionTrades(rows) {
  const pos = findHeaderLoose(rows, ['品种合约', '流水号', '成交时间', '买/卖', '权利金单价', '成交量', '权利金', '是否备兑', '手续费']);
  if (!pos) return [];
  const out = [];
  for (let r = pos.rowIndex + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;
    const contract = cellText(row[pos.colMap['品种合约']]);
    if (!contract || contract === '合计') continue;
    out.push({
      contract,
      seq: cellText(row[pos.colMap['流水号']]),
      time: toTimeStr(row[pos.colMap['成交时间']]),
      side: cellText(row[pos.colMap['买/卖']]),
      premiumPrice: toNumber(row[pos.colMap['权利金单价']]),
      lots: toNumber(row[pos.colMap['成交量']]) || 0,
      premium: toNumber(row[pos.colMap['权利金']]),
      covered: cellText(row[pos.colMap['是否备兑']]),
      fee: toNumber(row[pos.colMap['手续费']]),
    });
  }
  return out;
}

function parseSecuritiesTrades(rows) {
  const pos = findHeaderLoose(rows, ['证券代码', '证券简称', '变动类型', '买卖标志', '成交流水号', '成交时间', '成交价格', '成交数量', '成交金额', '手续费']);
  if (!pos) return [];
  const out = [];
  for (let r = pos.rowIndex + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;
    const code = cellText(row[pos.colMap['证券代码']]);
    if (!code || code === '合计') continue;
    out.push({
      code,
      name: cellText(row[pos.colMap['证券简称']]),
      changeType: cellText(row[pos.colMap['变动类型']]),
      side: cellText(row[pos.colMap['买卖标志']]),
      seq: cellText(row[pos.colMap['成交流水号']]),
      time: toTimeStr(row[pos.colMap['成交时间']]),
      price: toNumber(row[pos.colMap['成交价格']]),
      qty: toNumber(row[pos.colMap['成交数量']]),
      amount: toNumber(row[pos.colMap['成交金额']]),
      fee: toNumber(row[pos.colMap['手续费']]),
    });
  }
  return out;
}

function parseStatement(filePath) {
  const wb = XLSX.readFile(filePath, { cellDates: true });
  const get = name => sheetRows(wb.Sheets[name]);
  const daily = get('客户交易结算日报');

  const meta = parseMeta(daily);
  meta.hedgeType = parseHedgeType(get('品种汇总')) || parseHedgeType(daily);
  const statement = {
    meta,
    funds: parseFunds(daily),
    cashflows: parseCashflows(daily),
    otherFunds: parseOtherFunds(daily),
    productSummary: parseProductSummary(get('品种汇总')),
    trades: parseTrades(get('成交明细')),
    closes: parseCloses(get('平仓明细')),
    positions: parsePositions(get('持仓明细')),
    positionSummary: parsePositionSummary(daily),
    optionTrades: parseOptionTrades(get('期权成交明细')),
    securitiesTrades: parseSecuritiesTrades(get('证券成交明细')),
  };

  // 数据校验
  const errs = [];
  if (!meta.tradeDate) errs.push('无法识别交易日期');
  if (!meta.account) errs.push('无法识别资金账号');
  const sum = (arr, k) => arr.reduce((a, x) => a + (x[k] || 0), 0);

  // 链式验算：上日结存 + 出入金 + 平仓盈亏 + 浮动盈亏 − 手续费(+权利金) = 客户权益
  const f = statement.funds;
  const chainCalc = (f.prevBalance || 0) + (f.depositWithdraw || 0) + (f.closePnl || 0) + (f.floatPnl || 0) - (f.fee || 0) + (f.premium || 0);
  const chainDiff = f.equity === null ? null : +(chainCalc - f.equity).toFixed(2);
  // 容差：固定 0.02 或权益的百万分之一（大金额账户浮点累计），取大者
  const chainTolerance = f.equity === null ? 0.02 : Math.max(0.02, Math.abs(f.equity) * 1e-6);

  statement.checks = {
    tradeLots: sum(statement.trades, 'lots'),
    tradeFee: +sum(statement.trades, 'fee').toFixed(2),
    tradeClosePnl: +sum(statement.trades, 'closePnl').toFixed(2),
    fundFee: f.fee,
    fundClosePnl: f.closePnl,
    feeMatch: Math.abs(sum(statement.trades, 'fee') - (f.fee || 0)) < 0.02,
    closePnlMatch: Math.abs(sum(statement.trades, 'closePnl') - (f.closePnl || 0)) < 0.02,
    // 链式验算
    chainCalc: +chainCalc.toFixed(2),
    chainDiff,
    chainOk: chainDiff === null ? null : Math.abs(chainDiff) < chainTolerance,
    // 权益 = 当日结存 + 浮动盈亏
    equityOk: f.equity === null || f.balance === null ? null : Math.abs(f.equity - (f.balance + (f.floatPnl || 0))) < chainTolerance,
  };
  statement.errors = errs;
  return statement;
}

module.exports = { parseStatement };
