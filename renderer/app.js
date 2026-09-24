'use strict';
/* global echarts, ledger */

// ---------- 工具 ----------
const $ = sel => document.querySelector(sel);
const fmt = (n, digits = 2) => n === null || n === undefined ? '--' : Number(n).toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const fmtInt = n => n === null || n === undefined ? '--' : Number(n).toLocaleString('zh-CN');
const fmtPct = (n, digits = 1) => n === null || n === undefined ? '--' : (n * 100).toFixed(digits) + '%';
const pnlClass = n => n > 0 ? 'pos' : n < 0 ? 'neg' : '';
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 4000);
}

// 风险度配色（固定阈值：50% 黄 / 80% 红 / 95% 闪烁）
const RISK_WARN = 0.5, RISK_DANGER = 0.8, RISK_FLASH = 0.95;
function riskClass(r) {
  if (r === null || r === undefined) return '';
  if (r >= RISK_FLASH) return 'risk-flash';
  if (r >= RISK_DANGER) return 'neg';
  if (r >= RISK_WARN) return 'warn-yellow';
  return 'pos';
}

// ---------- 崩溃保护 ----------
window.addEventListener('error', e => {
  const overlay = $('#crashOverlay');
  if (!overlay) return;
  overlay.classList.remove('hidden');
  $('#crashMsg').textContent = String(e.message || e.error || '未知错误');
  try { ledger.logWrite('界面错误: ' + (e.message || '') + ' @ ' + (e.filename || '') + ':' + (e.lineno || '')); } catch { /* ignore */ }
});

// ---------- 状态 ----------
let state = { dataDir: '', index: { statements: [] } };
let ov = null;
let cfg = null;
let currentAccount = null; // null = 全部
const PAGE_SIZE = 200;
let tradePg = 0, closePg = 0;
const charts = {};

// ---------- 通用表格 ----------
function renderTable(el, headers, rows, leftCols = []) {
  const thead = '<tr>' + headers.map((h, i) => `<th class="${leftCols.includes(i) ? 'l' : ''}">${esc(h.label)}</th>`).join('') + '</tr>';
  const tbody = rows.map(r => '<tr>' + headers.map((h, i) => {
    const v = h.render ? h.render(r) : esc(r[h.key]);
    return `<td class="${leftCols.includes(i) ? 'l' : ''}">${v}</td>`;
  }).join('') + '</tr>').join('');
  el.innerHTML = thead + tbody;
}

// ---------- 图表：看门狗（每 800ms 自检，尺寸不一致则销毁重建） ----------
const latestOpts = {};
const watchers = {};

function watchChart(id) {
  if (watchers[id]) return;
  watchers[id] = setInterval(() => {
    const el = document.getElementById(id);
    const c = charts[id];
    if (!el || !c) return;
    const w = Math.round(el.getBoundingClientRect().width);
    const h = Math.round(el.getBoundingClientRect().height);
    if (w <= 0 || h <= 0) return;
    if (Math.abs(c.getZr().getWidth() - w) > 1 || Math.abs(c.getZr().getHeight() - h) > 1) {
      c.dispose();
      charts[id] = echarts.init(el, null, { renderer: 'canvas' });
      charts[id].setOption(latestOpts[id], true);
    }
  }, 800);
}

function fixAllCharts() { Object.keys(charts).forEach(watchChart); }

function mkChart(id, opt) {
  const el = document.getElementById(id);
  if (!el) return;
  latestOpts[id] = opt;
  if (!charts[id]) {
    charts[id] = echarts.init(el, null, { renderer: 'canvas' });
    watchChart(id);
  }
  charts[id].setOption(opt, true);
}

const axisStyle = { axisLine: { lineStyle: { color: '#2a2f3a' } }, axisLabel: { color: '#8b93a3' } };
const baseGrid = { left: 70, right: 20, top: 30, bottom: 25 };
const tip = { trigger: 'axis', backgroundColor: '#1e222c', borderColor: '#2a2f3a', textStyle: { color: '#e6e9ef' } };
const PALETTE = ['#4f8ef7', '#2fbf71', '#e5a44d', '#e5484d', '#9b6ef7', '#41c8d4', '#e56aa0', '#9bc24f'];

// ---------- 数据加载 ----------
async function refresh() {
  const s = await ledger.getState();
  state = s;
  $('#dataDirPath').textContent = s.dataDir;
  if (s.indexRebuilt) toast('检测到索引损坏或导入中断，已自动重建索引');
  ov = await ledger.getOverview(currentAccount);
  cfg = ov.config;
  renderAll();
}

function renderAll() {
  const hasData = ov && !ov.empty;
  $('#emptyState').classList.toggle('hidden', hasData);
  document.querySelector('main').style.display = hasData ? '' : 'none';

  renderManage();
  renderAccountSelect();
  if (!hasData) return;

  const m = ov.meta;
  $('#accountInfo').textContent = `${m.name || ''} · ${m.company} · 已导入 ${m.days} 个交易日` + (currentAccount ? '' : `（账号 ${m.account}）`);

  renderDashboard();
  renderStats(); renderDaily(); renderMonthly(); renderPositionsPage(); renderTrades(); renderCloses(); renderProducts();
  fillCfgForm();
}

function renderAccountSelect() {
  const sel = $('#accountSelect');
  const accounts = ov && ov.accounts ? ov.accounts : [];
  if (accounts.length <= 1) {
    sel.classList.add('hidden');
    currentAccount = null;
    return;
  }
  sel.classList.remove('hidden');
  const cur = currentAccount || '';
  sel.innerHTML = '<option value="">全部账户</option>' + accounts.map(a => `<option value="${a}">账号 ${a}</option>`).join('');
  sel.value = cur;
}

// ---------- 仪表盘 ----------
function kpi(label, value, sub = '', cls = '') {
  return `<div class="kpi"><div class="label">${label}</div><div class="value ${cls}">${value}</div><div class="sub">${sub}</div></div>`;
}

function renderDashboard() {
  const k = ov.kpis;

  const p = k.latestDayPnl;
  $('#dayBanner').innerHTML = p === null ? '' :
    `<span class="banner-date">${k.latestDate}：</span>` +
    (p > 0 ? `<span class="pos banner-big">今天赚了 ${fmt(Math.abs(p))} 元</span>` :
     p < 0 ? `<span class="neg banner-big">今天亏了 ${fmt(Math.abs(p))} 元</span>` :
     `<span class="banner-big">今天不赚不亏</span>`) +
    `<span class="dim">（平仓盈亏 ${fmt(k.latestClosePnl)} + 浮动盈亏 ${fmt(k.latestFloatPnl)} − 手续费 ${fmt(k.latestFee)} = ${fmt(p)}）</span>`;

  const riskCls = riskClass(k.latestRiskRatio);
  $('#kpiCards').innerHTML =
    kpi('当前客户权益', fmt(k.latestEquity), `当日结存 ${fmt(k.latestBalance)}（权益 = 结存 + 浮动）`) +
    kpi('累计净盈亏（净值）', fmt(k.nav), `累计入金 ${fmt(k.cumDeposit)}`, pnlClass(k.nav)) +
    kpi('当前风险度', `<span class="${riskCls}">${fmtPct(k.latestRiskRatio, 2)}</span>`, `保证金占用 ${fmt(k.latestMargin)} · 可用 ${fmt(k.latestAvailable)}`) +
    kpi('当日手续费', fmt(k.latestFee), `${k.latestMonth} 累计手续费 ${fmt(k.monthFee)}`) +
    kpi('手续费占累计盈利比', fmtPct(k.feeToGrossPnl), `累计手续费 ${fmt(k.totalFee)} ÷ 累计平仓盈亏 ${fmt(k.totalClosePnl)}`, k.feeToGrossPnl > 0.5 ? 'neg' : '') +
    kpi('平仓胜率', fmtPct(k.winRate), `平仓 ${k.closeCount} 笔 · 盈亏比 ${k.plRatio ?? '--'}`);

  // 期权/证券等未统计内容提示
  const nb = $('#noticeBar');
  if (ov.notices && ov.notices.length) {
    nb.classList.remove('hidden');
    nb.innerHTML = ov.notices.map(n => `<div class="notice-item">提示：${esc(n.date)} ${esc(n.text)}</div>`).join('');
  } else {
    nb.classList.add('hidden');
  }

  const dates = ov.byDate.map(d => d.date);
  $('#cumDepositLbl').textContent = `已累计入金 ${fmt(k.cumDeposit)}`;

  mkChart('chNav', {
    tooltip: tip, grid: baseGrid,
    xAxis: { type: 'category', data: dates, boundaryGap: false, ...axisStyle },
    yAxis: { type: 'value', scale: true, splitLine: { lineStyle: { color: '#22262f' } }, axisLabel: { color: '#8b93a3' } },
    series: [{ name: '净值', type: 'line', data: ov.byDate.map(d => d.nav), smooth: true, itemStyle: { color: '#4f8ef7' }, areaStyle: { opacity: 0.15 } }],
  });

  mkChart('chRisk', {
    tooltip: { ...tip, valueFormatter: v => fmtPct(v, 2) }, grid: baseGrid,
    xAxis: { type: 'category', data: dates, boundaryGap: false, ...axisStyle },
    yAxis: { type: 'value', axisLabel: { color: '#8b93a3', formatter: v => (v * 100).toFixed(0) + '%' }, splitLine: { lineStyle: { color: '#22262f' } } },
    series: [{
      name: '风险度', type: 'line', data: ov.byDate.map(d => d.riskRatio), smooth: true,
      itemStyle: { color: '#e5a44d' },
      areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'rgba(229,72,77,.35)' }, { offset: 1, color: 'rgba(229,72,77,0)' }] } },
      markLine: {
        silent: true, symbol: 'none',
        data: [
          { yAxis: RISK_WARN, lineStyle: { color: '#e5c04d', type: 'dashed' }, label: { color: '#e5c04d', position: 'insideEndTop', formatter: '黄 50%' } },
          { yAxis: RISK_DANGER, lineStyle: { color: '#e5484d', type: 'dashed' }, label: { color: '#e5484d', position: 'insideEndTop', formatter: '红 80%' } },
        ],
      },
    }],
  });

  const prods = Object.keys(ov.productSeries);
  mkChart('chProduct', {
    tooltip: tip, grid: baseGrid,
    legend: { textStyle: { color: '#8b93a3' }, top: 0 },
    xAxis: { type: 'category', data: dates, boundaryGap: false, ...axisStyle },
    yAxis: { type: 'value', splitLine: { lineStyle: { color: '#22262f' } }, axisLabel: { color: '#8b93a3' } },
    series: prods.map((p, i) => ({ name: p, type: 'line', data: ov.productSeries[p], smooth: true, itemStyle: { color: PALETTE[i % PALETTE.length] } })),
  });

  mkChart('chLots', {
    tooltip: tip, grid: baseGrid,
    xAxis: { type: 'category', data: dates, ...axisStyle },
    yAxis: { type: 'value', splitLine: { lineStyle: { color: '#22262f' } }, axisLabel: { color: '#8b93a3' } },
    series: [{ name: '成交手数', type: 'bar', data: ov.byDate.map(d => d.lots), itemStyle: { color: '#41c8d4' } }],
  });

  // 当前持仓
  $('#posDate').textContent = k.latestDate;
  const hasPos = ov.latestPositions.length > 0;
  $('#posEmpty').classList.toggle('hidden', hasPos);
  if (hasPos) {
    renderTable($('#tblPositions'), [
      { label: '合约', key: 'contract' },
      { label: '方向', key: 'direction' },
      { label: '手数', render: r => fmtInt(r.lots) },
      { label: '开仓价', render: r => fmt(r.openPrice, r.openPrice < 100 ? 2 : 3) },
      { label: '今结算价', render: r => fmt(r.settle, r.settle < 100 ? 2 : 3) },
      { label: '浮动盈亏', render: r => `<span class="${pnlClass(r.floatPnl)}">${fmt(r.floatPnl)}</span>` },
      { label: '交易保证金', render: r => r.margin === null ? '--' : fmt(r.margin) },
    ], ov.latestPositions, [0]);
  } else {
    $('#tblPositions').innerHTML = '';
  }
}

// ---------- 交易统计 ----------
function renderStats() {
  const k = ov.kpis;
  $('#statCards').innerHTML =
    kpi('平仓胜率', fmtPct(k.winRate), `共 ${k.closeCount} 笔`) +
    kpi('平均盈利', fmt(k.avgWin), '', 'pos') +
    kpi('平均亏损', fmt(k.avgLoss), '', 'neg') +
    kpi('盈亏比', k.plRatio ?? '--', '平均盈利 ÷ 平均亏损绝对值') +
    kpi('日胜率', fmtPct(k.dayWinRate), `盈利 ${k.upDays} 天 / 亏损 ${k.downDays} 天`) +
    kpi('连续盈利/亏损', `${k.maxWinStreak} / ${k.maxLossStreak}`, '最长连续天数') +
    kpi('单日最大盈利', fmt(k.maxDailyProfit), '', 'pos') +
    kpi('单日最大亏损', fmt(k.maxDailyLoss), '', 'neg') +
    kpi('最大回撤', fmt(k.maxDrawdown), k.maxDDStart ? `${k.maxDDStart} → ${k.maxDDEnd}` : '暂无回撤');

  renderTable($('#tblIntraday'), [
    { label: '类型', key: 'type' },
    { label: '平仓笔数', render: r => fmtInt(r.trades) },
    { label: '胜率', render: r => r.winRate === null ? '--' : fmtPct(r.winRate) },
    { label: '合计盈亏', render: r => `<span class="${pnlClass(r.pnl)}">${fmt(r.pnl)}</span>` },
  ], [
    { type: '日内（今开今平）', ...k.intraday },
    { type: '隔夜（隔日平仓）', ...k.overnight },
  ], [0]);

  const feeRows = [
    { type: '开仓手续费', fee: k.feeOpen, note: '建仓成本' },
    { type: '平仓-日内手续费', fee: k.feeCloseIntra, note: '今开今平的平仓（含平今仓费率）' },
    { type: '平仓-隔夜手续费', fee: k.feeCloseOvernight, note: '隔日平仓' },
  ];
  if (k.feeCloseUnknown > 0) feeRows.push({ type: '平仓-未能识别', fee: k.feeCloseUnknown, note: '无法关联到开仓记录的平仓' });
  renderTable($('#tblFeeSplit'), [
    { label: '类型', key: 'type' },
    { label: '手续费', render: r => fmt(r.fee) },
    { label: '说明', key: 'note' },
  ], feeRows, [0, 2]);

  const byP = new Map();
  for (const c of ov.closes) {
    if (!byP.has(c.product)) byP.set(c.product, { product: c.product, trades: 0, wins: 0, pnl: 0, winSum: 0, lossSum: 0, maxWin: -Infinity, maxLoss: Infinity });
    const o = byP.get(c.product);
    o.trades++; o.pnl += c.closePnl;
    if (c.closePnl > 0) { o.wins++; o.winSum += c.closePnl; o.maxWin = Math.max(o.maxWin, c.closePnl); }
    if (c.closePnl < 0) { o.lossSum += c.closePnl; o.maxLoss = Math.min(o.maxLoss, c.closePnl); }
  }
  const rows = [...byP.values()].map(o => ({
    ...o,
    winRate: o.trades ? o.wins / o.trades : null,
    avgWin: o.wins ? o.winSum / o.wins : null,
    avgLoss: (o.trades - o.wins) ? o.lossSum / (o.trades - o.wins) : null,
    maxWin: o.maxWin === -Infinity ? null : o.maxWin,
    maxLoss: o.maxLoss === Infinity ? null : o.maxLoss,
  })).sort((a, b) => b.pnl - a.pnl);
  renderTable($('#tblProductDetail'), [
    { label: '品种', key: 'product' },
    { label: '平仓笔数', render: r => fmtInt(r.trades) },
    { label: '胜率', render: r => r.winRate === null ? '--' : fmtPct(r.winRate) },
    { label: '平均盈利', render: r => r.avgWin === null ? '--' : `<span class="pos">${fmt(r.avgWin)}</span>` },
    { label: '平均亏损', render: r => r.avgLoss === null ? '--' : `<span class="neg">${fmt(r.avgLoss)}</span>` },
    { label: '最大单笔盈利', render: r => r.maxWin === null ? '--' : `<span class="pos">${fmt(r.maxWin)}</span>` },
    { label: '最大单笔亏损', render: r => r.maxLoss === null ? '--' : `<span class="neg">${fmt(r.maxLoss)}</span>` },
    { label: '累计平仓盈亏', render: r => `<span class="${pnlClass(r.pnl)}">${fmt(r.pnl)}</span>` },
  ], rows, [0]);
}

// ---------- 按日汇总 ----------
function renderDaily() {
  renderTable($('#tblDaily'), [
    { label: '交易日', key: 'date' },
    { label: '平仓盈亏', render: r => `<span class="${pnlClass(r.closePnl)}">${fmt(r.closePnl)}</span>` },
    { label: '手续费', render: r => fmt(r.fee) },
    { label: '净盈亏', render: r => `<span class="${pnlClass(r.netPnl)}">${fmt(r.netPnl)}</span>` },
    { label: '浮动盈亏', render: r => `<span class="${pnlClass(r.floatPnl)}">${fmt(r.floatPnl)}</span>` },
    { label: '当日总盈亏', render: r => `<span class="${pnlClass(r.dayPnl)}">${fmt(r.dayPnl)}</span>` },
    { label: '客户权益', render: r => fmt(r.equity) },
    { label: '当日结存', render: r => fmt(r.balance) },
    { label: '可用资金', render: r => fmt(r.available) },
    { label: '保证金占用', render: r => fmt(r.margin) },
    { label: '风险度', render: r => `<span class="${riskClass(r.riskRatio)}">${fmtPct(r.riskRatio, 2)}</span>` },
    { label: '成交手数', render: r => fmtInt(r.lots) },
    { label: '验算', render: r => r.chainOk === null ? '<span class="dim">--</span>' : r.chainOk ? '<span class="pos">✓</span>' : '<span class="neg">异常</span>' },
  ], ov.byDate, [0]);
}

// ---------- 月度汇总 ----------
function renderMonthly() {
  renderTable($('#tblMonthly'), [
    { label: '月份', key: 'month' },
    { label: '平仓盈亏', render: r => `<span class="${pnlClass(r.closePnl)}">${fmt(r.closePnl)}</span>` },
    { label: '手续费', render: r => fmt(r.fee) },
    { label: '浮动盈亏', render: r => `<span class="${pnlClass(r.floatPnl)}">${fmt(r.floatPnl)}</span>` },
    { label: '净盈亏', render: r => `<span class="${pnlClass(r.netPnl)}">${fmt(r.netPnl)}</span>` },
    { label: '当月出入金', render: r => r.deposit ? fmt(r.deposit) : '--' },
    { label: '成交手数', render: r => fmtInt(r.lots) },
    { label: '成交笔数', render: r => fmtInt(r.trades) },
    { label: '月末权益', render: r => fmt(r.endEquity) },
    { label: '月末风险度', render: r => `<span class="${riskClass(r.endRiskRatio)}">${fmtPct(r.endRiskRatio, 2)}</span>` },
  ], ov.monthly, [0]);
}

// ---------- 历史持仓 ----------
async function renderPositionsPage() {
  if (!ov || ov.empty) return;
  const sel = $('#posDateSelect');
  const dates = ov.positionsByDate.map(p => p.date).sort().reverse();
  if (!dates.length) {
    sel.innerHTML = '<option value="">（无持仓记录）</option>';
    $('#tblHistoryPositions').innerHTML = '';
    return;
  }
  const cur = sel.value;
  sel.innerHTML = dates.map(d => `<option value="${d}">${d}</option>`).join('');
  if (dates.includes(cur)) sel.value = cur;
  await showHistoryPositions(sel.value);
}

async function showHistoryPositions(date) {
  if (!date) { $('#tblHistoryPositions').innerHTML = ''; return; }
  const data = await ledger.positionsAt({ date, account: currentAccount });
  if (!data || !data.positions.length) {
    $('#tblHistoryPositions').innerHTML = '<tr><td class="l dim" style="padding:12px">该交易日无持仓</td></tr>';
    return;
  }
  renderTable($('#tblHistoryPositions'), [
    { label: '合约', key: 'contract' },
    { label: '方向', render: r => r.buyLots ? '买' : '卖' },
    { label: '手数', render: r => fmtInt(r.buyLots || r.sellLots || 0) },
    { label: '开仓价', render: r => fmt(r.buyLots ? r.buyPrice : r.sellPrice, (r.buyLots ? r.buyPrice : r.sellPrice) < 100 ? 2 : 3) },
    { label: '昨结算价', render: r => fmt(r.prevSettle, r.prevSettle < 100 ? 2 : 3) },
    { label: '今结算价', render: r => fmt(r.settle, r.settle < 100 ? 2 : 3) },
    { label: '浮动盈亏', render: r => `<span class="${pnlClass(r.floatPnl)}">${fmt(r.floatPnl)}</span>` },
    { label: '开仓日期', key: 'date' },
  ], data.positions, [0]);
}

// ---------- 筛选 ----------
function filteredTrades() {
  if (!ov) return [];
  const from = $('#fTradeFrom').value, to = $('#fTradeTo').value;
  const prod = $('#fTradeProduct').value, side = $('#fTradeSide').value, oc = $('#fTradeOC').value;
  const c = $('#fTradeContract').value.trim().toUpperCase();
  return ov.trades.filter(t =>
    (!from || t.date >= from) && (!to || t.date <= to) &&
    (!prod || t.product === prod) && (!side || t.side === side) &&
    (!oc || t.openClose === oc) && (!c || t.contract.toUpperCase().includes(c)));
}

function filteredCloses() {
  if (!ov) return [];
  const from = $('#fCloseFrom').value, to = $('#fCloseTo').value;
  const prod = $('#fCloseProduct').value, side = $('#fCloseSide').value, w = $('#fCloseWin').value;
  const c = $('#fCloseContract').value.trim().toUpperCase();
  return ov.closes.filter(t =>
    (!from || t.date >= from) && (!to || t.date <= to) &&
    (!prod || t.product === prod) && (!side || t.side === side) &&
    (!w || (w === 'win' ? t.closePnl > 0 : t.closePnl < 0)) &&
    (!c || t.contract.toUpperCase().includes(c)));
}

function fillProductSelects() {
  const prods = ov ? ov.products.map(p => p.product) : [];
  for (const id of ['#fTradeProduct', '#fCloseProduct']) {
    const sel = $(id);
    const cur = sel.value;
    const html = '<option value="">全部</option>' + prods.map(p => `<option>${p}</option>`).join('');
    if (sel.innerHTML !== html) sel.innerHTML = html;
    if ([...sel.options].some(o => o.value === cur)) sel.value = cur;
  }
}

// ---------- 成交/平仓明细 ----------
function renderTrades() {
  fillProductSelects();
  const rows = filteredTrades();
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  tradePg = Math.min(tradePg, pages - 1);
  const slice = rows.slice(tradePg * PAGE_SIZE, (tradePg + 1) * PAGE_SIZE);
  $('#tradeCount').textContent = `共 ${rows.length} 条`;
  $('#pgInfo').textContent = `${tradePg + 1} / ${pages} 页`;
  renderTable($('#tblTrades'), [
    { label: '日期', key: 'date' }, { label: '合约', key: 'contract' },
    { label: '时间', key: 'time' }, { label: '买/卖', key: 'side' },
    { label: '开/平', key: 'openClose' },
    { label: '成交价', render: r => fmt(r.price, r.price < 100 ? 2 : 3) },
    { label: '手数', render: r => fmtInt(r.lots) },
    { label: '成交额', render: r => fmt(r.amount, 0) },
    { label: '手续费', render: r => fmt(r.fee) },
    { label: '平仓盈亏', render: r => r.closePnl === null ? '<span class="dim">--</span>' : `<span class="${pnlClass(r.closePnl)}">${fmt(r.closePnl)}</span>` },
  ], slice, [0, 1]);
}

function renderCloses() {
  fillProductSelects();
  const rows = filteredCloses();
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  closePg = Math.min(closePg, pages - 1);
  const slice = rows.slice(closePg * PAGE_SIZE, (closePg + 1) * PAGE_SIZE);
  $('#closeCount').textContent = `共 ${rows.length} 条`;
  $('#pgCloseInfo').textContent = `${closePg + 1} / ${pages} 页`;
  renderTable($('#tblCloses'), [
    { label: '日期', key: 'date' }, { label: '合约', key: 'contract' }, { label: '买/卖', key: 'side' },
    { label: '平仓价', render: r => fmt(r.price, r.price < 100 ? 2 : 3) },
    { label: '开仓价', render: r => fmt(r.openPrice, r.openPrice < 100 ? 2 : 3) },
    { label: '手数', render: r => fmtInt(r.lots) },
    { label: '平仓盈亏', render: r => `<span class="${pnlClass(r.closePnl)}">${fmt(r.closePnl)}</span>` },
  ], slice, [0, 1]);
}

// ---------- 品种统计 ----------
function renderProducts() {
  renderTable($('#tblProducts'), [
    { label: '品种', key: 'product' },
    { label: '成交笔数', render: r => fmtInt(r.trades) },
    { label: '手数', render: r => fmtInt(r.lots) },
    { label: '成交额', render: r => fmt(r.amount, 0) },
    { label: '手续费', render: r => fmt(r.fee) },
    { label: '平仓盈亏', render: r => `<span class="${pnlClass(r.closePnl)}">${fmt(r.closePnl)}</span>` },
    { label: '净盈亏', render: r => `<span class="${pnlClass(r.netPnl)}">${fmt(r.netPnl)}</span>` },
    { label: '胜率', render: r => r.winRate === null ? '--' : fmtPct(r.winRate) },
  ], ov.products, [0]);

  const prods = [...ov.products].sort((a, b) => a.netPnl - b.netPnl);
  mkChart('chProduct2', {
    tooltip: tip, grid: { left: 60, right: 40, top: 20, bottom: 25 },
    xAxis: { type: 'value', splitLine: { lineStyle: { color: '#22262f' } }, axisLabel: { color: '#8b93a3' } },
    yAxis: { type: 'category', data: prods.map(p => p.product), axisLine: { lineStyle: { color: '#2a2f3a' } }, axisLabel: { color: '#8b93a3' } },
    series: [{ name: '净盈亏', type: 'bar', data: prods.map(p => p.netPnl), itemStyle: { color: p => p.value >= 0 ? '#2fbf71' : '#e5484d' }, label: { show: true, position: 'right', color: '#8b93a3', formatter: p => fmt(p.value) } }],
  });
}

// ---------- 数据管理 ----------
function fillCfgForm() {
  if (!cfg) return;
  $('#cfgInitialDeposit').value = cfg.initialDeposit;
  $('#cfgMonitorDir').value = cfg.monitorDir || '';
  $('#cfgBackupDir').value = cfg.backupDir || '';
}

async function renderManage() {
  // 健康面板
  const h = await ledger.getHealth();
  $('#healthGrid').innerHTML =
    healthCard('已导入天数', h.days + ' 天') +
    healthCard('数据目录大小', h.dirSizeMB + ' ' + (h.dirSizeUnit || 'MB')) +
    healthCard('原始文件归档', h.rawCount + ' 个') +
    healthCard('自动备份', h.backupCount + ' 份') +
    healthCard('回收站', h.trashCount + ' 天') +
    healthCard('链式验算异常', h.chainBad.length ? `<span class="neg">${h.chainBad.join('、')}</span>` : '<span class="pos">无</span>') +
    healthCard('文件校验异常', h.checksumBad.length ? `<span class="neg">${h.checksumBad.join('、')}</span>` : '<span class="pos">无</span>') +
    healthCard('最近导入', h.lastImport ? h.lastImport.replace('T', ' ').slice(0, 19) : '--');

  // 备份列表
  renderTable($('#tblBackups'), [
    { label: '备份时间', render: r => r.name.split('__')[0].replace(/-/g, ':').slice(0, 19) },
    { label: '触发原因', render: r => esc(r.name.split('__')[1] || '') },
    { label: '结算单数', render: r => fmtInt(r.statements) },
  ], h.backups, [0, 1]);

  // 已导入清单
  const list = state.index.statements || [];
  $('#stmtCount').textContent = list.length;
  renderTable($('#tblStmts'), [
    { label: '交易日', key: 'tradeDate' },
    { label: '账号', key: 'account' },
    { label: '客户', key: 'name' },
    { label: '成交笔数', render: r => fmtInt(r.counts.trades) },
    { label: '手数', render: r => fmtInt(r.counts.lots) },
    { label: '手续费', render: r => fmt(r.fee) },
    { label: '平仓盈亏', render: r => `<span class="${pnlClass(r.closePnl)}">${fmt(r.closePnl)}</span>` },
    { label: '客户权益', render: r => fmt(r.equity) },
    { label: '风险度', render: r => fmtPct(r.riskRatio, 2) },
    { label: '验算', render: r => r.chainOk === false ? '<span class="neg">异常</span>' : '<span class="pos">✓</span>' },
    { label: '导入时间', render: r => (r.importedAt || '').replace('T', ' ').slice(0, 19) },
    { label: '操作', render: r => `<button class="btn small danger" data-del="${r.key}">删除</button>` },
  ], list.slice().reverse(), [0, 1, 2, 10, 11]);
  $('#tblStmts').querySelectorAll('[data-del]').forEach(btn => {
    btn.onclick = async () => {
      const key = btn.getAttribute('data-del');
      const e = (state.index.statements || []).find(s => s.key === key);
      if (!confirm(`确定删除 ${e.tradeDate} 的结算数据？\n（会移入回收站，可恢复）`)) return;
      state.index = await ledger.removeStatement(key);
      ov = await ledger.getOverview(currentAccount);
      cfg = ov.config;
      renderAll();
      toast(`已删除 ${e.tradeDate}（可在回收站恢复）`);
    };
  });

  // 回收站
  const trash = await ledger.trashList();
  $('#trashCount').textContent = trash.length;
  renderTable($('#tblTrash'), [
    { label: '交易日', key: 'tradeDate' },
    { label: '账号', key: 'account' },
    { label: '操作', render: r => `<button class="btn small" data-restore="${r.key}">恢复</button>` },
  ], trash, [0, 1, 2]);
  $('#tblTrash').querySelectorAll('[data-restore]').forEach(btn => {
    btn.onclick = async () => {
      await ledger.trashRestore(btn.getAttribute('data-restore'));
      state.index = (await ledger.getState()).index;
      ov = await ledger.getOverview(currentAccount);
      renderAll();
      toast('已恢复');
    };
  });
}

function healthCard(label, value) {
  return `<div class="kpi"><div class="label">${label}</div><div class="value" style="font-size:17px">${value}</div></div>`;
}

// ---------- 事件 ----------
function activateTab(tabName) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  $('#page-' + tabName).classList.add('active');
  requestAnimationFrame(fixAllCharts);
}

$('#tabs').addEventListener('click', e => {
  const btn = e.target.closest('[data-tab]');
  if (!btn) return;
  activateTab(btn.dataset.tab);
});

$('#accountSelect').addEventListener('change', async e => {
  currentAccount = e.target.value || null;
  ov = await ledger.getOverview(currentAccount);
  renderAll();
});

$('#posDateSelect').addEventListener('change', e => showHistoryPositions(e.target.value));

async function doImport(payload) {
  state.index = payload.index;
  const msgs = payload.results.map(x => `${x.file}：${x.message || x.error}`);
  ov = await ledger.getOverview(currentAccount);
  cfg = ov.config;
  renderAll();
  toast(msgs.join('；'));
}

$('#btnImport').onclick = async () => {
  const mode = $('#chkOverwrite').checked ? 'overwrite' : 'skip';
  const r = await ledger.importFiles(mode);
  if (r) await doImport(r);
};

// 监控目录自动导入回调
ledger.onMonitorImported(async results => {
  toast('监控目录自动导入：' + results.map(x => `${x.file}：${x.message || x.error}`).join('；'));
  ov = await ledger.getOverview(currentAccount);
  renderAll();
});

// 拖拽导入
const dropMask = $('#dropMask');
let dragDepth = 0;
document.addEventListener('dragenter', e => {
  if (![...e.dataTransfer.types].includes('Files')) return;
  dragDepth++;
  dropMask.classList.remove('hidden');
});
document.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) dropMask.classList.add('hidden');
});
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', async e => {
  e.preventDefault();
  dragDepth = 0;
  dropMask.classList.add('hidden');
  const paths = [...(e.dataTransfer.files || [])].map(f => f.path).filter(Boolean).filter(p => /\.xlsx?$/i.test(p));
  if (!paths.length) return toast('请拖入 .xls 结算单文件');
  const mode = $('#chkOverwrite').checked ? 'overwrite' : 'skip';
  const r = await ledger.importPaths({ paths, mode });
  await doImport(r);
});

$('#btnDataDir').onclick = async () => {
  const r = await ledger.chooseDataDir();
  if (!r) return;
  state.index = r.index;
  $('#dataDirPath').textContent = r.dataDir;
  ov = await ledger.getOverview(currentAccount);
  cfg = ov.config;
  renderAll();
  toast('数据目录已切换：' + r.dataDir);
};

$('#btnOpenDir').onclick = () => ledger.showDataDir();

$('#btnSaveCfg').onclick = async () => {
  cfg = await ledger.setConfig({
    initialDeposit: Number($('#cfgInitialDeposit').value) || 0,
    monitorDir: $('#cfgMonitorDir').value || '',
    backupDir: $('#cfgBackupDir').value || '',
  });
  ov = await ledger.getOverview(currentAccount);
  renderAll();
  $('#cfgMsg').textContent = '已保存 ' + new Date().toLocaleTimeString();
  toast('配置已保存');
};

$('#btnMonitorDir').onclick = async () => {
  const d = await ledger.chooseMonitorDir();
  if (d) $('#cfgMonitorDir').value = d;
};
$('#btnMonitorDirClear').onclick = () => { $('#cfgMonitorDir').value = ''; };
$('#btnBackupDir').onclick = async () => {
  const d = await ledger.chooseMonitorDir();
  if (d) $('#cfgBackupDir').value = d;
};
$('#btnBackupDirClear').onclick = () => { $('#cfgBackupDir').value = ''; };

$('#btnBackupExport').onclick = async () => {
  const dest = await ledger.backupExport();
  if (dest) toast('已导出完整备份：' + dest);
};
$('#btnBackupRestore').onclick = async () => {
  if (!confirm('从备份恢复将覆盖当前数据目录中的全部数据（恢复前会自动再备份一次当前状态）。继续？')) return;
  const r = await ledger.backupRestore();
  if (!r) return;
  if (r.ok) {
    state.index = r.index;
    ov = await ledger.getOverview(currentAccount);
    renderAll();
    toast('已从备份恢复');
  } else {
    toast('恢复失败：' + r.error);
  }
};
$('#btnTrashPurge').onclick = async () => {
  if (!confirm('确定清空回收站？清空后数据将无法恢复。')) return;
  await ledger.trashPurge();
  renderManage();
  toast('回收站已清空');
};

for (const id of ['#fTradeFrom', '#fTradeTo', '#fTradeProduct', '#fTradeSide', '#fTradeOC', '#fTradeContract']) {
  $(id).addEventListener('input', () => { tradePg = 0; renderTrades(); });
}
for (const id of ['#fCloseFrom', '#fCloseTo', '#fCloseProduct', '#fCloseSide', '#fCloseWin', '#fCloseContract']) {
  $(id).addEventListener('input', () => { closePg = 0; renderCloses(); });
}
$('#btnTradeReset').onclick = () => { ['#fTradeFrom', '#fTradeTo', '#fTradeProduct', '#fTradeSide', '#fTradeOC', '#fTradeContract'].forEach(id => { $(id).value = ''; }); tradePg = 0; renderTrades(); };
$('#btnCloseReset').onclick = () => { ['#fCloseFrom', '#fCloseTo', '#fCloseProduct', '#fCloseSide', '#fCloseWin', '#fCloseContract'].forEach(id => { $(id).value = ''; }); closePg = 0; renderCloses(); };

$('#pgPrev').onclick = () => { if (tradePg > 0) { tradePg--; renderTrades(); } };
$('#pgNext').onclick = () => { tradePg++; renderTrades(); };
$('#pgClosePrev').onclick = () => { if (closePg > 0) { closePg--; renderCloses(); } };
$('#pgCloseNext').onclick = () => { closePg++; renderCloses(); };

// ---------- 导出 ----------
$('#btnTradeExport').onclick = async () => {
  const rows = filteredTrades().map(t => ({ 日期: t.date, 合约: t.contract, 时间: t.time, 买卖: t.side, 开平: t.openClose, 成交价: t.price, 手数: t.lots, 成交额: t.amount, 手续费: t.fee, 平仓盈亏: t.closePnl }));
  if (!rows.length) return toast('没有可导出的数据');
  const p = await ledger.exportCsv({ filename: '成交明细.csv', rows });
  if (p) toast('已导出：' + p);
};
$('#btnCloseExport').onclick = async () => {
  const rows = filteredCloses().map(t => ({ 日期: t.date, 合约: t.contract, 买卖: t.side, 平仓价: t.price, 开仓价: t.openPrice, 手数: t.lots, 平仓盈亏: t.closePnl }));
  if (!rows.length) return toast('没有可导出的数据');
  const p = await ledger.exportCsv({ filename: '平仓明细.csv', rows });
  if (p) toast('已导出：' + p);
};
// ---------- 明细页：成交/平仓切换 ----------
let detailsMode = 'trades';
function setDetailsMode(mode) {
  detailsMode = mode;
  $('#segTrades').classList.toggle('active', mode === 'trades');
  $('#segCloses').classList.toggle('active', mode === 'closes');
  $('#detailsTradesPanel').classList.toggle('hidden', mode !== 'trades');
  $('#detailsClosesPanel').classList.toggle('hidden', mode !== 'closes');
}
$('#segTrades').onclick = () => setDetailsMode('trades');
$('#segCloses').onclick = () => setDetailsMode('closes');

// ---------- 汇总页：按日/按月切换与导出 ----------
let summaryMode = 'daily';
function setSummaryMode(mode) {
  summaryMode = mode;
  $('#segDaily').classList.toggle('active', mode === 'daily');
  $('#segMonthly').classList.toggle('active', mode === 'monthly');
  $('#summaryDailyPanel').classList.toggle('hidden', mode !== 'daily');
  $('#summaryMonthlyPanel').classList.toggle('hidden', mode !== 'monthly');
  $('#btnSummaryPrint').classList.toggle('hidden', mode !== 'monthly');
  $('#summaryHint').textContent = mode === 'daily'
    ? '净盈亏 = 平仓盈亏 − 手续费；当日总盈亏 = 平仓盈亏 + 浮动盈亏 − 手续费；验算 = 链式验算（上日结存+出入金+平仓盈亏+浮动盈亏−手续费 = 客户权益）'
    : '按自然月聚合；打印视图已优化为 A4 一页';
}
$('#segDaily').onclick = () => setSummaryMode('daily');
$('#segMonthly').onclick = () => setSummaryMode('monthly');

function summaryRows() {
  if (summaryMode === 'monthly') {
    return ov.monthly.map(m => ({ 月份: m.month, 平仓盈亏: m.closePnl, 手续费: m.fee, 浮动盈亏: m.floatPnl, 净盈亏: m.netPnl, 当月出入金: m.deposit, 成交手数: m.lots, 成交笔数: m.trades, 月末权益: m.endEquity, 月末风险度: m.endRiskRatio }));
  }
  return ov.byDate.map(d => ({ 交易日: d.date, 平仓盈亏: d.closePnl, 手续费: d.fee, 净盈亏: d.netPnl, 浮动盈亏: d.floatPnl, 当日总盈亏: d.dayPnl, 客户权益: d.equity, 当日结存: d.balance, 可用资金: d.available, 保证金占用: d.margin, 风险度: d.riskRatio, 成交手数: d.lots, 链式验算: d.chainOk ? '通过' : '异常' }));
}

$('#btnSummaryCsv').onclick = async () => {
  if (!ov || ov.empty) return;
  const name = summaryMode === 'monthly' ? '月度汇总.csv' : '按日汇总.csv';
  const p = await ledger.exportCsv({ filename: name, rows: summaryRows() });
  if (p) toast('已导出：' + p);
};
$('#btnSummaryXlsx').onclick = async () => {
  if (!ov || ov.empty) return;
  const name = summaryMode === 'monthly' ? '月度汇总' : '按日汇总';
  const p = await ledger.exportXlsx({ filename: name + '.xlsx', sheets: [{ name, rows: summaryRows() }] });
  if (p) toast('已导出：' + p);
};
$('#btnSummaryPrint').onclick = () => window.print();

refresh();
