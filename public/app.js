import { presentDataSource, presentEntryState, presentMonitorTrade } from "./monitorPresentation.js?v=20260714-monitor-clarity";

const state = {
  currentSession: null,
  currentFilter: "all",
  selectedSignalId: null,
  selectedWatchSymbol: null,
  aiConfigured: false,
  aiModel: "本地规则"
};

const els = {
  runtimeStatus: document.querySelector("#runtimeStatus"),
  startBtn: document.querySelector("#startBtn"),
  stopBtn: document.querySelector("#stopBtn"),
  refreshBtn: document.querySelector("#refreshBtn"),
  clearBtn: document.querySelector("#clearBtn"),
  summarySignals: document.querySelector("#summarySignals"),
  summarySpot: document.querySelector("#summarySpot"),
  summaryFutures: document.querySelector("#summaryFutures"),
  summaryAi: document.querySelector("#summaryAi"),
  progressPanel: document.querySelector("#progressPanel"),
  progressPhase: document.querySelector("#progressPhase"),
  progressPercent: document.querySelector("#progressPercent"),
  progressFill: document.querySelector("#progressFill"),
  progressDetail: document.querySelector("#progressDetail"),
  marketErrors: document.querySelector("#marketErrors"),
  watchStatus: document.querySelector("#watchStatus"),
  watchSymbol: document.querySelector("#watchSymbol"),
  watchAllMarket: document.querySelector("#watchAllMarket"),
  watchMarket: document.querySelector("#watchMarket"),
  watchRefresh: document.querySelector("#watchRefresh"),
  watchStartBtn: document.querySelector("#watchStartBtn"),
  watchStopBtn: document.querySelector("#watchStopBtn"),
  watchRefreshBtn: document.querySelector("#watchRefreshBtn"),
  watchGrid: document.querySelector("#watchGrid"),
  signalsList: document.querySelector("#signalsList"),
  emptyState: document.querySelector("#emptyState"),
  signalDetail: document.querySelector("#signalDetail"),
  detailSource: document.querySelector("#detailSource"),
  historyList: document.querySelector("#historyList"),
  evaluationStatus: document.querySelector("#evaluationStatus"),
  evaluationSummary: document.querySelector("#evaluationSummary"),
  filters: document.querySelector("#filters"),
  // Monitor elements
  monitorStatus: document.querySelector("#monitorStatus"),
  monitorEmpty: document.querySelector("#monitorEmpty"),
  monitorRuntimeBanner: document.querySelector("#monitorRuntimeBanner"),
  monitorEntryState: document.querySelector("#monitorEntryState"),
  monitorEntryMode: document.querySelector("#monitorEntryMode"),
  monitorEntryDetail: document.querySelector("#monitorEntryDetail"),
  monitorDataSource: document.querySelector("#monitorDataSource"),
  monitorDataSourceLabel: document.querySelector("#monitorDataSourceLabel"),
  monitorDataSourceDetail: document.querySelector("#monitorDataSourceDetail"),
  monitorOverview: document.querySelector("#monitorOverview"),
  monitorSessionStatus: document.querySelector("#monitorSessionStatus"),
  monitorStartedAt: document.querySelector("#monitorStartedAt"),
  monitorScanCount: document.querySelector("#monitorScanCount"),
  monitorClosedTrades: document.querySelector("#monitorClosedTrades"),
  monitorPartialCloses: document.querySelector("#monitorPartialCloses"),
  monitorWinRate: document.querySelector("#monitorWinRate"),
  monitorTotalReturn: document.querySelector("#monitorTotalReturn"),
  monitorPositions: document.querySelector("#monitorPositions"),
  positionsList: document.querySelector("#positionsList"),
  monitorTrades: document.querySelector("#monitorTrades"),
  tradesList: document.querySelector("#tradesList"),
  monitorSessions: document.querySelector("#monitorSessions"),
  sessionsList: document.querySelector("#sessionsList"),
  monitorSessionDetail: document.querySelector("#monitorSessionDetail"),
  monitorSessionDetailTitle: document.querySelector("#monitorSessionDetailTitle"),
  monitorSessionDetailList: document.querySelector("#monitorSessionDetailList"),
  monitorErrors: document.querySelector("#monitorErrors"),
  errorsList: document.querySelector("#errorsList")
};

let statusPollTimer = null;
let watchPollTimer = null;
let monitorPollTimer = null;
let watchPending = false;
let lastRenderedWatcher = null;
let lastStableWatchItems = [];
let watchInputDirty = false;

els.startBtn.addEventListener("click", startScan);
els.stopBtn.addEventListener("click", stopScan);
els.refreshBtn.addEventListener("click", loadHistory);
els.clearBtn.addEventListener("click", clearCurrent);
els.watchStartBtn.addEventListener("click", startWatch);
els.watchStopBtn.addEventListener("click", stopWatch);
els.watchRefreshBtn.addEventListener("click", refreshWatch);
els.watchSymbol.addEventListener("input", () => {
  watchInputDirty = true;
});
els.watchAllMarket?.addEventListener("change", () => {
  watchInputDirty = true;
  if (els.watchAllMarket.checked && !els.watchSymbol.value.trim()) {
    els.watchSymbol.value = "ALL";
  }
});
els.filters.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-filter]");
  if (!button) return;
  state.currentFilter = button.dataset.filter;
  for (const item of els.filters.querySelectorAll("button")) item.classList.remove("active");
  button.classList.add("active");
  renderSignals();
});

window.addEventListener("beforeunload", () => {
  navigator.sendBeacon?.("/api/scan/stop", new Blob([], { type: "application/json" }));
  navigator.sendBeacon?.("/api/watch/stop", new Blob([], { type: "application/json" }));
});

await refreshStatus();
await loadHistory();
await loadEvaluations();
await loadWatchStatus();

async function startScan() {
  setBusy(true);
  setStatus("扫描中", false);
  renderProgress({ phase: "准备扫描", percent: 1, detail: "正在启动扫描任务" }, true);
  startStatusPolling();
  try {
    const payload = await postJson("/api/scan/start");
    state.currentSession = payload.session;
    state.selectedSignalId = payload.session.signals[0]?.id || null;
    renderSummary(payload.session.summary);
    renderSignals();
    renderDetail();
    await loadHistory();
    setStatus(payload.state.message || "扫描完成", false);
    renderProgress(payload.state.progress, true);
  } catch (error) {
    setStatus(`接口异常：${error.message}`, true);
    renderProgress({ phase: "扫描失败", percent: 0, detail: error.message }, true);
  } finally {
    stopStatusPolling();
    setBusy(false);
  }
}

async function startWatch() {
  if (watchPending) return;
  watchPending = true;
  setWatchButtonsBusy(true);
  els.watchStatus.textContent = "启动中...";
  try {
    const payload = await postJsonBody("/api/watch/start", {
      symbol: els.watchSymbol.value,
      scope: els.watchAllMarket?.checked ? "market" : "symbols",
      marketScope: Boolean(els.watchAllMarket?.checked),
      marketType: els.watchMarket.value,
      refreshSeconds: Number(els.watchRefresh.value)
    });
    watchInputDirty = false;
    renderWatch(payload.watcher);
    startWatchPolling();
  } catch (error) {
    els.watchStatus.textContent = `启动失败：${error.message}`;
  } finally {
    watchPending = false;
    setWatchButtonsBusy(false);
  }
}

async function stopWatch() {
  if (watchPending) return;
  watchPending = true;
  setWatchButtonsBusy(true);
  try {
    const payload = await postJson("/api/watch/stop");
    renderWatch(payload.watcher);
    stopWatchPolling();
  } catch (error) {
    els.watchStatus.textContent = `停止失败：${error.message}`;
  } finally {
    watchPending = false;
    setWatchButtonsBusy(false);
  }
}

async function refreshWatch() {
  if (watchPending) return;
  watchPending = true;
  setWatchButtonsBusy(true);
  try {
    els.watchStatus.textContent = "刷新中...";
    const payload = await postJson("/api/watch/refresh");
    renderWatch(payload.watcher);
  } catch (error) {
    els.watchStatus.textContent = `刷新失败：${error.message}`;
  } finally {
    watchPending = false;
    setWatchButtonsBusy(false);
  }
}

async function loadWatchStatus() {
  try {
    const payload = await getJson("/api/watch/status");
    renderWatch(payload.watcher);
    if (payload.watcher.status === "running") startWatchPolling();
    else stopWatchPolling();
  } catch (error) {
    els.watchStatus.textContent = `状态读取失败：${error.message}`;
  }
}

function startWatchPolling() {
  if (watchPollTimer) return;
  watchPollTimer = window.setInterval(loadWatchStatus, 2000);
}

function stopWatchPolling() {
  if (!watchPollTimer) return;
  window.clearInterval(watchPollTimer);
  watchPollTimer = null;
}

function setWatchButtonsBusy(busy) {
  renderWatchControls(lastRenderedWatcher, busy);
}

async function stopScan() {
  try {
    const payload = await postJson("/api/scan/stop");
    setStatus(payload.state.message || "已暂停", false);
    renderProgress(payload.state.progress, true);
    stopStatusPolling();
  } catch (error) {
    setStatus(`暂停失败：${error.message}`, true);
  }
}

async function refreshStatus() {
  const payload = await getJson("/api/status");
  updateAiRuntime(payload.state);
  setStatus(payload.state.message || "未启动", payload.state.status === "error");
  renderProgress(payload.state.progress, payload.state.status === "running");
  if (payload.state.status === "running") startStatusPolling();
}

async function loadHistory() {
  try {
    const payload = await getJson("/api/sessions?limit=20");
    renderHistory(payload.sessions);
  } catch (error) {
    els.historyList.innerHTML = `<div class="message">复盘记录读取失败：${escapeHtml(error.message)}</div>`;
  }
}

async function loadEvaluations() {
  if (!els.evaluationSummary) return;
  try {
    const payload = await getJson("/api/evaluations?limit=1000");
    renderEvaluationSummary(payload.summary);
  } catch (error) {
    els.evaluationStatus.textContent = "读取失败";
    els.evaluationSummary.innerHTML = `<div class="message">准确率复盘读取失败：${escapeHtml(error.message)}</div>`;
  }
}

function startStatusPolling() {
  if (statusPollTimer) return;
  statusPollTimer = window.setInterval(async () => {
    try {
      const payload = await getJson("/api/status");
      updateAiRuntime(payload.state);
      setStatus(payload.state.message || "扫描中", payload.state.status === "error");
      renderProgress(payload.state.progress, payload.state.status === "running");
      if (payload.state.status !== "running") stopStatusPolling();
    } catch (error) {
      setStatus(`状态读取失败：${error.message}`, true);
    }
  }, 1000);
}

function stopStatusPolling() {
  if (!statusPollTimer) return;
  window.clearInterval(statusPollTimer);
  statusPollTimer = null;
}

function clearCurrent() {
  state.currentSession = null;
  state.selectedSignalId = null;
  renderSummary(null);
  renderSignals();
  renderDetail();
}

function renderSummary(summary) {
  els.summarySignals.textContent = summary?.signals ?? 0;
  els.summarySpot.textContent = summary?.spotScanned ?? 0;
  els.summaryFutures.textContent = summary?.futuresScanned ?? 0;
  renderAiStatus(summary);
  const errors = summary?.marketErrors || [];
  els.marketErrors.hidden = errors.length === 0;
  els.marketErrors.textContent = errors.length
    ? `部分市场接口不可用：${errors.map((item) => `${item.marketType} ${item.message}`).join("；")}`
    : "";
}

function renderProgress(progress, forceVisible = false) {
  if (!progress) {
    els.progressPanel.hidden = !forceVisible;
    return;
  }

  const percent = Math.max(0, Math.min(100, Number(progress.percent || 0)));
  const hasProgress = forceVisible || percent > 0;
  els.progressPanel.hidden = !hasProgress;
  els.progressPhase.textContent = progress.phase || "扫描中";
  els.progressPercent.textContent = `${percent}%`;
  els.progressFill.style.width = `${percent}%`;
  const countText = progress.current !== null && progress.total !== null
    ? `（${progress.current}/${progress.total}）`
    : "";
  els.progressDetail.textContent = `${progress.detail || ""}${countText}`;
}

function renderSignals() {
  const signals = filteredSignals();
  els.signalsList.innerHTML = "";
  els.emptyState.style.display = signals.length ? "none" : "block";

  for (const signal of signals) {
    const card = document.createElement("article");
    card.className = `signal-card ${signal.id === state.selectedSignalId ? "selected" : ""}`;
    card.tabIndex = 0;
    card.innerHTML = `
      <div class="signal-main">
        <div class="symbol-row">
          <span class="symbol">${escapeHtml(signal.symbol)}</span>
          <span class="tag ${signal.direction}">${escapeHtml(signal.directionLabel)}</span>
          ${signal.statusLabel ? `<span class="tag signal-${escapeHtml(signal.signalLevel || "watch")}">${escapeHtml(signal.statusLabel)}</span>` : ""}
          <span class="tag">${signal.marketType === "spot" ? "现货" : "合约"}</span>
          <span class="tag">${escapeHtml(signal.timeframe)}</span>
          <span class="tag review-${escapeHtml(signal.aiReview?.decision || "watch")}">${reviewLabel(signal.aiReview)}</span>
          <span class="tag">风险 ${escapeHtml(signal.riskLevel)}</span>
        </div>
        <div class="meta">
          <span>入场 ${formatRange(signal.entryRange)}</span>
          <span>止损 ${formatNumber(signal.stopLoss)}</span>
          <span>TP1 ${formatNumber(signal.takeProfit.tp1)}</span>
          <span>Rule ${signal.ruleScore ?? signal.score}</span>
          <span>盈亏比 ${signal.riskReward ?? "-"}</span>
        </div>
      </div>
      <div class="score">${signal.score}<span>评分</span></div>
    `;
    card.addEventListener("click", () => selectSignal(signal.id));
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter") selectSignal(signal.id);
    });
    els.signalsList.appendChild(card);
  }
}

function renderDetail() {
  const signal = selectedSignal();
  if (!signal) {
    els.detailSource.textContent = "未选择";
    els.signalDetail.className = "detail-empty";
    els.signalDetail.textContent = "选择左侧一条信号查看点位、指标和风险。";
    return;
  }

  const s = signal.marketSnapshot;
  els.detailSource.textContent = signal.aiSource || "本地规则";
  els.signalDetail.className = "";
  els.signalDetail.innerHTML = `
    <div class="detail-grid">
      ${metric("当前价格", formatNumber(s.price))}
      ${metric("入场区间", formatRange(signal.entryRange))}
      ${metric("止损", formatNumber(signal.stopLoss))}
      ${metric("TP1 / TP2", `${formatNumber(signal.takeProfit.tp1)} / ${formatNumber(signal.takeProfit.tp2)}`)}
      ${metric("RSI", s.indicators.rsi ?? "-")}
      ${metric("MACD柱", s.indicators.macdHistogram ?? "-")}
      ${metric("成交量倍率", s.indicators.volumeRatio ?? "-")}
      ${metric("资金费率", s.fundingRate === null ? "-" : `${(s.fundingRate * 100).toFixed(4)}%`)}
      ${metric("支撑 / 压力", `${formatNumber(s.supportResistance.support)} / ${formatNumber(s.supportResistance.resistance)}`)}
      ${metric("24h涨跌", `${s.priceChangePercent24h?.toFixed?.(2) ?? "-"}%`)}
      ${metric("AI Review", reviewLabel(signal.aiReview))}
      ${metric("Quality Gate", `Score ${signal.quality?.minScore ?? "-"} / RR ${signal.quality?.minRiskReward ?? "-"}`)}
    </div>

    <div class="section-title">AI / 本地分析</div>
    <p>${escapeHtml(signal.aiSummary || "")}</p>
    ${signal.aiReview ? `<p class="review-note">${escapeHtml(signal.aiReview.reason || "")}</p>` : ""}

    <div class="section-title">确认清单</div>
    ${list(signal.aiChecklist || signal.reasons)}

    <div class="section-title">Quality Confirmation</div>
    ${qualityList(signal.quality)}

    <div class="section-title">触发理由</div>
    ${list(signal.reasons)}

    <div class="section-title">风险提示</div>
    ${list(signal.aiRisk || signal.riskNotes)}

    <div class="section-title">失效条件</div>
    <p>${escapeHtml(signal.invalidCondition)}</p>
  `;
}

function renderHistory(sessions) {
  if (!sessions.length) {
    els.historyList.innerHTML = `<div class="message">暂无复盘记录。</div>`;
    return;
  }

  els.historyList.innerHTML = "";
  for (const session of sessions) {
    const item = document.createElement("div");
    item.className = "history-item";
    item.innerHTML = `
      <div>
        <strong>${new Date(session.startTime).toLocaleString()}</strong>
        <div class="message">${session.summary.signals} 条信号，现货 ${session.summary.spotScanned}，合约 ${session.summary.futuresScanned}</div>
      </div>
      <button type="button">查看</button>
    `;
    item.querySelector("button").addEventListener("click", () => {
      state.currentSession = session;
      state.selectedSignalId = session.signals[0]?.id || null;
      renderSummary(session.summary);
      renderSignals();
      renderDetail();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
    els.historyList.appendChild(item);
  }
}

function renderEvaluationSummary(summary = {}) {
  const completed = Number(summary.completed || 0);
  els.evaluationStatus.textContent = completed
    ? `${completed} 条已完成`
    : "暂无完成复盘";

  const directionRows = topEvaluationRows(summary.byDirection, 6);
  const groupRows = topEvaluationRows(summary.bySignalGroup, 8);
  const pendingRows = Object.entries(summary.pendingByReason || {}).slice(0, 4);

  els.evaluationSummary.innerHTML = `
    <div class="evaluation-cards">
      ${evaluationCard("完成复盘", completed)}
      ${evaluationCard("待完成", Number(summary.pending || 0))}
      ${evaluationCard("4h胜率", percentText(summary.byHorizon?.["4h"]?.winRate))}
      ${evaluationCard("24h胜率", percentText(summary.byHorizon?.["24h"]?.winRate))}
      ${evaluationCard("净期望", formatPercentValue(summary.performance?.expectancyPercent))}
      ${evaluationCard("收益因子", formatNumber(summary.performance?.profitFactor))}
    </div>
    <div class="evaluation-columns">
      ${evaluationTable("按方向", directionRows)}
      ${evaluationTable("按市场/方向/周期", groupRows)}
    </div>
    ${pendingRows.length ? `
      <div class="evaluation-pending">
        <strong>待复盘原因</strong>
        ${pendingRows.map(([reason, count]) => `<span>${escapeHtml(reason)}：${escapeHtml(count)}</span>`).join("")}
      </div>
    ` : ""}
  `;
}

function topEvaluationRows(groups = {}, limit = 6) {
  return Object.entries(groups)
    .map(([name, value]) => ({ name, ...value }))
    .sort((a, b) => Number(b.total || 0) - Number(a.total || 0))
    .slice(0, limit);
}

function evaluationCard(label, value) {
  return `
    <article>
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </article>
  `;
}

function evaluationTable(title, rows) {
  if (!rows.length) return `<div class="evaluation-table"><strong>${escapeHtml(title)}</strong><div class="message">暂无数据。</div></div>`;
  return `
    <div class="evaluation-table">
      <strong>${escapeHtml(title)}</strong>
      <table>
        <thead>
          <tr>
            <th>分组</th>
            <th>样本</th>
            <th>胜率</th>
            <th>入场</th>
            <th>净均值</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((row) => `
            <tr>
              <td>${escapeHtml(formatEvaluationName(row.name))}</td>
              <td>${escapeHtml(row.total || 0)}</td>
              <td>${escapeHtml(percentText(row.winRate))}</td>
              <td>${escapeHtml(percentText(row.entryRate))}</td>
              <td>${escapeHtml(formatPercentValue(row.avgNetResultPercent ?? row.avgResultPercent))}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function selectSignal(id) {
  state.selectedSignalId = id;
  renderSignals();
  renderDetail();
}

function filteredSignals() {
  const signals = state.currentSession?.signals || [];
  if (state.currentFilter === "all") return signals;
  if (state.currentFilter === "spot") return signals.filter((signal) => signal.marketType === "spot");
  if (state.currentFilter === "futures") return signals.filter((signal) => signal.marketType === "futures");
  if (state.currentFilter === "long") return signals.filter((signal) => signal.direction === "long" || signal.direction === "spot_buy");
  if (state.currentFilter === "short") return signals.filter((signal) => signal.direction === "short" || signal.direction === "spot_sell");
  return signals;
}

function selectedSignal() {
  const signals = state.currentSession?.signals || [];
  return signals.find((signal) => signal.id === state.selectedSignalId) || null;
}

function setBusy(busy) {
  els.startBtn.disabled = busy;
  els.startBtn.textContent = busy ? "扫描中..." : "开始扫描";
}

function setStatus(text, isError) {
  els.runtimeStatus.textContent = text;
  els.runtimeStatus.classList.toggle("error", isError);
}

async function getJson(url) {
  const response = await fetch(url);
  const payload = await response.json();
  if (!response.ok || payload.ok === false) throw new Error(payload.error || response.statusText);
  return payload;
}

async function postJson(url) {
  const response = await fetch(url, { method: "POST" });
  const payload = await response.json();
  if (!response.ok || payload.ok === false) throw new Error(payload.error || response.statusText);
  return payload;
}

async function postJsonBody(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  if (!response.ok || payload.ok === false) throw new Error(payload.error || response.statusText);
  return payload;
}

function renderWatch(watcher) {
  lastRenderedWatcher = watcher;
  els.watchStatus.textContent = formatWatchStatus(watcher);
  if (els.watchAllMarket) els.watchAllMarket.checked = watcher.scope === "market";
  if (!watchInputDirty) {
    if (watcher.scope === "market") {
      els.watchSymbol.value = "ALL";
    } else if (watcher.symbol) {
      els.watchSymbol.value = (watcher.symbols || []).join("\n") || watcher.symbol;
    }
  }
  if (watcher.marketType) els.watchMarket.value = watcher.marketType;
  if (watcher.refreshSeconds) els.watchRefresh.value = String(watcher.refreshSeconds);
  renderWatchControls(watcher, watchPending);
  const rawItems = watcher.items || (watcher.current ? [{ symbol: watcher.current.symbol, current: watcher.current, error: null }] : []);
  const items = mergeWatchItems(rawItems);
  renderWatchGrid(items, watcher.history || [], watcher);
}

function formatWatchStatus(watcher = {}) {
  const base = watcher.message || watcher.status || "未启动";
  if (watcher.status === "starting") return `监控启动中：${base}`;
  if (watcher.status === "paused") return `监控已暂停：${base}`;
  if (watcher.status !== "running") return base;

  const parts = [`监控运行中：${base}`];
  if (watcher.lastRefreshedAt) {
    parts.push(`上次行情 ${new Date(watcher.lastRefreshedAt).toLocaleTimeString()}`);
  }
  if (Number.isFinite(Number(watcher.lastRefreshDurationMs))) {
    parts.push(`耗时 ${(Number(watcher.lastRefreshDurationMs) / 1000).toFixed(1)} 秒`);
  }
  if (watcher.isRefreshing) {
    parts.push("本次行情刷新中");
  } else if (watcher.nextRefreshAt) {
    const nextInSeconds = Math.max(0, Math.ceil((new Date(watcher.nextRefreshAt).getTime() - Date.now()) / 1000));
    parts.push(`下次行情约 ${nextInSeconds} 秒后`);
  }
  return parts.join(" · ");
}

function renderWatchControls(watcher = {}, busy = false) {
  const status = watcher?.status || "idle";
  const running = status === "running" || status === "starting";
  const canRefresh = status === "running" && !watcher?.isRefreshing;

  els.watchStartBtn.disabled = busy || running;
  els.watchStartBtn.textContent = busy ? "处理中..." : running ? "监控中" : "开始监控";
  els.watchStartBtn.classList.toggle("running", running);
  els.watchStopBtn.disabled = busy || !running;
  els.watchRefreshBtn.disabled = busy || !canRefresh;
}

function mergeWatchItems(items) {
  const previousBySymbol = new Map(lastStableWatchItems.map((item) => [item.symbol, item]));
  const merged = items.map((item) => {
    if (item.current) return item;
    const previous = previousBySymbol.get(item.symbol);
    if (!previous?.current) return item;
    return {
      ...previous,
      error: item.error || "正在刷新，本卡片暂时沿用上一轮结果。",
      pending: item.pending || !item.error,
      stale: Boolean(item.error),
      alerts: item.alerts?.length ? item.alerts : previous.alerts || []
    };
  });
  lastStableWatchItems = merged
    .filter((item) => item.current)
    .map((item) => ({ ...item, alerts: item.alerts || [] }));
  return merged;
}

function renderWatchGrid(items, events, watcher = {}) {
  const globalAlerts = renderGlobalWatchAlerts(items, watcher);
  if (!items.length) {
    const emptyText = watcher.scope === "market"
      ? "全市场发现模式运行中：没有单币种图表卡片，发现的多/空信号会集中显示在上方。"
      : "输入币种后开始监控，AI 会结合分时状态给出提示。";
    els.watchGrid.innerHTML = `${globalAlerts}<div class="detail-empty">${escapeHtml(emptyText)}</div>`;
    return;
  }

  els.watchGrid.innerHTML = `${globalAlerts}${items.map((item) => {
    const current = item.current;
    const alert = current?.alert || {};
    const ai = current?.ai || {};
    const signalAlerts = item.alerts || [];
    const recentEvents = events
      .filter((event) => event.symbol === item.symbol)
      .slice(0, 2);

    if (!current) {
      return `
        <article class="watch-tile error-tile" data-watch-symbol="${escapeHtml(item.symbol)}">
          <div class="watch-tile-head">
            <strong>${escapeHtml(item.symbol)}</strong>
            <span class="tag ${item.pending ? "wait" : "short"}">${item.pending ? "刷新中" : "异常"}</span>
          </div>
          <div class="detail-empty">${escapeHtml(item.error || "暂时没有分时数据。")}</div>
        </article>
      `;
    }

    const statusNote = item.pending
      ? `<div class="watch-refreshing">正在刷新行情，本卡片暂时显示上一轮成功结果。</div>`
      : item.stale
        ? `<div class="watch-stale">本轮接口异常，下面仍是上一次成功行情：${escapeHtml(item.error)}</div>`
      : "";
    const marketNotice = current.marketNotice
      ? `<div class="watch-market-notice">${escapeHtml(current.marketNotice)}</div>`
      : "";

    return `
      <article class="watch-tile" data-watch-symbol="${escapeHtml(item.symbol)}">
        <div class="watch-tile-head">
          <div>
            <span class="tag ${escapeHtml(alert.direction || "wait")}">${escapeHtml(alert.action || "等待")}</span>
            <strong>${escapeHtml(current.symbol)}</strong>
          </div>
          <span class="watch-source">${escapeHtml(ai.source || "pending-ai")}</span>
        </div>
        <div class="watch-action-hint">${escapeHtml(alert.actionHint || explainAction(alert, current))}</div>
        ${statusNote}
        ${marketNotice}
        ${renderCurrentDecision(current)}
        ${renderSwingPanel(current.swing)}
        <div class="watch-tile-body">
          <div class="watch-chart">
            <canvas class="watch-chart-canvas" width="760" height="340" data-watch-chart="${escapeHtml(item.symbol)}"></canvas>
          </div>
          <div class="watch-side">
            ${renderTradePlan(current.tradePlan)}
            ${renderDecisionBoard(current, item)}
            ${renderSignalAlerts(signalAlerts, current)}
            <div class="watch-metrics">
              ${metric("当前价格", formatNumber(current.price))}
              ${metric("市场", formatWatchMarket(current))}
              ${metric("行情来源", formatMarketSource(current))}
              ${metric("动作含义", explainActionShort(alert, current))}
              ${metric("评分", alert.score ?? "-")}
              ${metric("风险", alert.riskLevel || "-")}
              ${metric("入场区间", alert.entryRange ? formatRange(alert.entryRange) : "-")}
              ${metric("止损", formatNumber(alert.stopLoss))}
              ${metric("TP1", alert.takeProfit ? formatNumber(alert.takeProfit.tp1) : "-")}
              ${metric("TP2", alert.takeProfit ? formatNumber(alert.takeProfit.tp2) : "-")}
              ${current.marketType === "futures" ? metric("资金费率", formatFundingRate(current)) : ""}
              ${current.marketType === "futures" ? metric("强平提示", "按杠杆自行确认") : ""}
            </div>
            <div class="watch-ai">
              <strong>AI提示</strong>
              <p>${escapeHtml(ai.summary || "AI 正在分析当前分时状态。")}</p>
            </div>
            <div class="watch-ai compact">
              <strong>确认重点</strong>
              ${list((ai.checklist || alert.reasons || []).slice(0, 3))}
            </div>
            ${renderWatchEvents(recentEvents)}
          </div>
        </div>
      </article>
    `;
  }).join("")}`;

  for (const item of items) {
    const canvas = els.watchGrid.querySelector(`[data-watch-chart="${cssEscape(item.symbol)}"]`);
    if (canvas && item.current) {
      drawWatchChart(
        canvas,
        item.current.line || [],
        item.current.alert,
        item.alerts || [],
        item.current.swing || null,
        item.current.signalReviews || [],
        item.current.tradePlan || null
      );
    }
  }
}

function renderGlobalWatchAlerts(items = [], watcher = {}) {
  const alerts = buildGlobalWatchAlerts(items, watcher).slice(0, 10);
  const scan = watcher.marketScan || null;
  const scanText = scan
    ? `全市场覆盖 ${scan.scannedMarkets}/${scan.eligibleMarkets} 个标的，正式 ${scan.formalSignals ?? scan.signals ?? 0} 个，观察 ${scan.watchSignals ?? 0} 个`
    : null;
  if (!alerts.length) {
    return `
      <section class="watch-global-alerts">
        <div class="watch-alert-head">
          <strong>全局买卖提醒</strong>
          <span>${escapeHtml(scanText || "暂无买卖点")}</span>
        </div>
        <div class="watch-alert-note">${escapeHtml(globalEmptyAlertText(watcher, scan))}</div>
      </section>
    `;
  }

  return `
    <section class="watch-global-alerts">
      <div class="watch-alert-head">
        <strong>全局买卖提醒</strong>
        <span>${escapeHtml(scanText || `${alerts.length} 条最近提醒`)}</span>
      </div>
      ${scan?.notice ? `<div class="watch-alert-note">${escapeHtml(scan.notice)}</div>` : ""}
      <div class="watch-global-alert-list">
        ${alerts.map((alert) => `
          <div class="watch-global-alert-row ${escapeHtml(globalAlertClass(alert))}">
            <div>
              <b>${escapeHtml(alert.symbol)}</b>
              <span>${escapeHtml(alert.label)}</span>
            </div>
            <strong>${formatNumber(alert.price)}</strong>
            <em>${escapeHtml(alert.tag)}</em>
            <small>${escapeHtml(formatGlobalAlertMeta(alert))}</small>
          </div>
        `).join("")}
      </div>
    </section>
  `;
}

function globalEmptyAlertText(watcher = {}, scan = null) {
  if (watcher.scope === "market") {
    if (watcher.isRefreshing) return "正在扫描全市场，出现正式短线点或观察候选后会显示在这里。";
    if (scan) return "本轮全市场扫描没有发现正式短线点或观察候选；这表示通过质量筛选的机会为空，不代表市场没有波动。";
    return "全市场发现模式启动后，这里会集中显示正式短线点和观察候选。";
  }
  return "当前监控币种还没有形成买点或卖点；出现后会在这里集中显示，不需要只盯着单个币种。";
}

function buildGlobalWatchAlerts(items = [], watcher = {}) {
  const rows = [];

  for (const alert of watcher.marketAlerts || []) {
    rows.push({
      key: `market:${alert.id || `${alert.symbol}:${alert.direction}:${alert.timeframe}`}`,
      symbol: alert.symbol,
      time: alert.time,
      price: alert.price,
      direction: alert.direction || "wait",
      label: alert.action || alert.directionLabel || shortAlertLabel(alert),
      message: alert.classificationReason || alert.message || alert.actionHint || "",
      tag: alert.statusLabel || "全市场信号",
      timeframe: alert.timeframe,
      entryRange: alert.entryRange,
      riskReward: alert.riskReward,
      score: alert.score,
      signalLevel: alert.signalLevel,
      statusLabel: alert.statusLabel,
      classificationReason: alert.classificationReason,
      needsConfirmation: alert.needsConfirmation || [],
      aiReview: alert.aiReview || null,
      priority: alert.signalLevel === "formal" ? 8 : 5
    });
  }

  for (const item of items) {
    const current = item.current || {};
    const symbol = current.symbol || item.symbol || "-";

    for (const alert of item.alerts || []) {
      rows.push({
        key: `alert:${symbol}:${alert.id || alert.time || alert.action || alert.message}`,
        symbol,
        time: alert.time,
        price: alert.price,
        direction: alert.direction || "wait",
        label: shortAlertLabel(alert),
        message: alert.message || alert.actionHint || "",
        tag: alert.lifecycleType === "swing" ? "波段提醒" : "固定提醒",
        priority: alert.lifecycleType === "swing" ? 2 : 4
      });
    }

    const plan = current.tradePlan || {};
    for (const side of [plan.buy, plan.sell]) {
      if (!side || side.status === "wait") continue;
      const direction = tradePlanSideDirection(side);
      rows.push({
        key: `plan:${symbol}:${direction}:${side.status}:${formatRange(side.zoneRange)}`,
        symbol,
        time: current.updatedAt || Date.now(),
        price: current.price,
        direction,
        label: `${side.title || tradePlanChartLabel({ direction, status: side.status })} ${side.statusLabel || ""}`.trim(),
        message: side.trigger || "",
        tag: side.status === "ready" || plan.validation === "actionable" ? "正式信号" : "观察提醒",
        zoneRange: side.zoneRange,
        priority: side.status === "ready" || plan.validation === "actionable" ? 3 : 1
      });
    }
  }

  const seen = new Set();
  return rows
    .filter((row) => {
      if (seen.has(row.key)) return false;
      seen.add(row.key);
      return true;
    })
    .sort((a, b) => {
      const priorityDiff = Number(b.priority || 0) - Number(a.priority || 0);
      if (priorityDiff) return priorityDiff;
      return new Date(b.time).getTime() - new Date(a.time).getTime();
    });
}

function globalAlertClass(alert = {}) {
  const side = alert.direction === "short" || alert.direction === "spot_sell"
    ? "short"
    : alert.direction === "long" || alert.direction === "spot_buy"
      ? "long"
      : "wait";
  return [side, alert.signalLevel || ""].filter(Boolean).join(" ");
}

function formatGlobalAlertMeta(alert = {}) {
  const time = new Date(alert.time);
  const timeText = Number.isFinite(time.getTime()) ? time.toLocaleTimeString() : "刚刚";
  const range = Array.isArray(alert.zoneRange) ? alert.zoneRange : alert.entryRange;
  const zoneText = Array.isArray(range) ? `区间 ${formatRange(range)}` : "";
  const scoreText = Number.isFinite(Number(alert.score)) ? `评分 ${Math.round(Number(alert.score))}` : "";
  const rrText = Number.isFinite(Number(alert.riskReward)) ? `RR ${formatNumber(alert.riskReward)}` : "";
  const confirmText = (alert.needsConfirmation || [])
    .filter((item) => item && item !== alert.message)
    .slice(0, 2)
    .join("；");
  const aiText = alert.aiReview?.decision ? `AI ${reviewLabel(alert.aiReview)}：${alert.aiReview.reason || ""}` : "";
  return [timeText, alert.timeframe, zoneText, scoreText, rrText, alert.message, confirmText, aiText].filter(Boolean).join(" · ");
}

function renderTradePlan(plan = {}) {
  if (!plan || (!plan.buy && !plan.sell)) return "";
  return `
    <div class="watch-trade-plan ${escapeHtml(plan.validation || "watch_only")}">
      <div class="watch-alert-head">
        <strong>买卖点计划</strong>
        <span>${escapeHtml(plan.validation === "actionable" ? "正式信号" : "观察区")}</span>
      </div>
      <div class="trade-plan-conclusion">${escapeHtml(plan.conclusion || "当前只显示观察区，未形成正式交易信号。")}</div>
      <div class="trade-plan-grid">
        ${tradePlanCard(plan.buy, "long")}
        ${tradePlanCard(plan.sell, "short")}
      </div>
      ${plan.note ? `<div class="trade-plan-note">${escapeHtml(plan.note)}</div>` : ""}
    </div>
  `;
}

function tradePlanCard(side = {}, className = "wait") {
  const blockers = side.blockers || [];
  const reasons = side.reasons || [];
  return `
    <div class="trade-plan-card ${escapeHtml(className)} ${escapeHtml(side.status || "wait")}">
      <div class="decision-title">
        <b>${escapeHtml(side.title || "-")}</b>
        <span class="tag ${escapeHtml(side.status === "ready" ? className : side.status === "watch" ? "review-watch" : "wait")}">${escapeHtml(side.statusLabel || "等待")}</span>
      </div>
      <div class="decision-meta">
        <span>区间 ${side.zoneRange ? formatRange(side.zoneRange) : "-"}</span>
        <span>评分 ${formatScore(side.score)}</span>
        <span>RR ${formatNumber(side.riskReward)}</span>
      </div>
      <p>${escapeHtml(side.trigger || "等待价格接近关键区间。")}</p>
      ${side.stopLoss || side.takeProfit ? `
        <small>止损 ${formatNumber(side.stopLoss)} / TP1 ${formatNumber(side.takeProfit?.tp1)}</small>
      ` : ""}
      ${blockers.length ? `<small>未固定提醒：${escapeHtml(blockers.join("；"))}</small>` : ""}
      ${!blockers.length && reasons.length ? `<small>${escapeHtml(reasons.slice(0, 2).join("；"))}</small>` : ""}
    </div>
  `;
}

function renderSwingPanel(swing = {}) {
  if (!swing || swing.mode !== "swing") return "";
  const actionClass = swingActionClass(swing.action);
  const summary = swing.summary || "波段数据不足，继续观察。";

  return `
    <div class="watch-swing-panel ${escapeHtml(actionClass)}">
      <div class="watch-alert-head">
        <strong>波段捕捉</strong>
        <span>${escapeHtml(swingActionLabel(swing.action))}</span>
      </div>
      <div class="swing-summary">${escapeHtml(summary)}</div>
      <div class="swing-meta">
        <span>周期 ${escapeHtml(swing.interval || "-")}</span>
        <span>趋势 ${escapeHtml(swing.trendLabel || "-")}</span>
        <span>波动 ${escapeHtml(swing.volatilityLabel || "-")}</span>
        <span>成交量 ${escapeHtml(swing.volumeState || "-")}</span>
        <span>区间位置 ${swing.rangePosition ?? "-"}%</span>
      </div>
      <div class="swing-grid">
        ${swingLegCard("低点买进区", swing.bottom, "long")}
        ${swingLegCard("高点卖出/开空区", swing.top, "short")}
      </div>
      <div class="swing-risk">提示是区域确认，不保证最低点买入或最高点卖出；正式下单仍以止损、仓位和交易所盘口为准。</div>
    </div>
  `;
}

function swingLegCard(title, leg = {}, side = "wait") {
  const statusClass = leg.confirmed ? side : leg.action === "wait" ? "wait" : "review-watch";
  const primaryReason = (leg.reasons || [])[0] || "继续等待价格进入关键区间。";
  const secondaryReason = (leg.reasons || [])[1] || "";

  return `
    <div class="swing-card ${escapeHtml(side)} ${leg.confirmed ? "active" : ""}">
      <div class="decision-title">
        <b>${escapeHtml(title)}</b>
        <span class="tag ${escapeHtml(statusClass)}">${escapeHtml(leg.label || "等待")}</span>
      </div>
      <div class="decision-meta">
        <span>评分 ${formatScore(leg.score)}</span>
        <span>区间 ${leg.zoneRange ? formatRange(leg.zoneRange) : "-"}</span>
      </div>
      <p>${escapeHtml(primaryReason)}</p>
      ${secondaryReason ? `<small>${escapeHtml(secondaryReason)}</small>` : ""}
    </div>
  `;
}

function swingActionLabel(action) {
  if (action === "buy_confirm") return "低点买入确认";
  if (action === "sell_confirm") return "高点卖出确认";
  if (action === "short_confirm") return "高点开空确认";
  if (action === "low_watch") return "低点观察";
  if (action === "high_watch") return "高点观察";
  return "等待";
}

function swingActionClass(action) {
  if (action === "buy_confirm" || action === "low_watch") return "long";
  if (action === "sell_confirm" || action === "short_confirm" || action === "high_watch") return "short";
  return "wait";
}

function renderSignalAlerts(alerts, current = null) {
  const touchMarkers = buildHistoricalTradeMarkers(current?.line || [], current?.alert || {}, alerts).slice(-6).reverse();
  const title = current?.marketType === "futures" ? "历史多空点" : "历史买卖点";
  if (!alerts.length && !touchMarkers.length) {
    return `
      <div class="watch-alert-history">
        <strong>${title}</strong>
        <div class="message">本轮监控还没有固定提醒；当前分时也暂未触碰入场、止盈或止损位。</div>
      </div>
    `;
  }

  return `
    <div class="watch-alert-history">
      <div class="watch-alert-head">
        <strong>${title}</strong>
        <span>提醒 ${alerts.length} · 触价 ${touchMarkers.length}</span>
      </div>
      <div class="watch-alert-note">图上只显示最近少量关键点，完整记录在这里按时间保留；所有提示都不代表系统已经下单。</div>
      ${alerts.length ? `
        <div class="watch-alert-group-title">固定提醒</div>
        ${alerts.slice(0, 5).map((alert) => `
          <div class="watch-alert-row ${escapeHtml(alert.direction || "wait")}">
            <span>${new Date(alert.time).toLocaleTimeString()}</span>
            <b>${escapeHtml(shortAlertLabel(alert))}</b>
            <span>${formatNumber(alert.price)}</span>
            <small>${escapeHtml(alert.message || "")}</small>
          </div>
        `).join("")}
      ` : ""}
      ${touchMarkers.length ? `
        <div class="watch-alert-group-title">历史触价</div>
        ${touchMarkers.map((marker) => `
          <div class="watch-alert-row ${escapeHtml(marker.direction || marker.type || "wait")}">
            <span>${new Date(marker.time).toLocaleTimeString()}</span>
            <b>${escapeHtml(marker.label)}</b>
            <span>${formatNumber(marker.price)}</span>
            <small>${escapeHtml(marker.message)}</small>
          </div>
        `).join("")}
      ` : ""}
    </div>
  `;
}

function renderSignalReviews(reviews = [], alert = {}) {
  const filtered = reviews.filter((signal) => signal.quality?.status !== "actionable").slice(0, 4);
  const actionable = reviews.filter((signal) => signal.quality?.status === "actionable").slice(0, 3);
  const items = actionable.length ? actionable : filtered;

  if (!items.length) {
    return `
      <div class="watch-signal-review">
        <strong>候选观察</strong>
        <div class="message">${escapeHtml((alert.reasons || [])[0] || "当前没有生成多空候选，继续等待价格接近关键支撑或压力。")}</div>
      </div>
    `;
  }

  return `
    <div class="watch-signal-review">
      <div class="watch-alert-head">
        <strong>候选观察</strong>
        <span>${actionable.length ? "已达标候选" : "未达标候选"}</span>
      </div>
      ${items.map((signal) => {
        const problems = signal.quality?.problems || [];
        const notes = signal.quality?.notes || [];
        const detail = problems.length
          ? problems.slice(0, 2).join("；")
          : notes.slice(0, 2).join("；") || (signal.reasons || []).slice(0, 1).join("；");
        return `
          <div class="watch-review-row ${escapeHtml(signal.direction || "wait")}">
            <b>${escapeHtml(signal.directionLabel || signal.direction || "-")}</b>
            <span>${escapeHtml(signal.timeframe || "-")} · ${formatNumber(signal.score)}分 · RR ${formatNumber(signal.riskReward)}</span>
            <small>${escapeHtml(detail || "候选仍需等待价格、量能和周期确认。")}</small>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function renderCurrentDecision(current = {}) {
  const alert = current.alert || {};
  const longSignal = pickDirectionReview(current.signalReviews || [], "long");
  const shortSignal = pickDirectionReview(current.signalReviews || [], "short");
  const sideClass = current.position?.direction || alert.direction || "wait";
  const title = currentDecisionTitle(current);
  const detail = [
    `开多：${sideStateText(longSignal, alert.direction === "long")}`,
    `开空：${sideStateText(shortSignal, alert.direction === "short")}`
  ].join("　");

  return `
    <div class="watch-current-decision ${escapeHtml(sideClass)}">
      <strong>${escapeHtml(title)}</strong>
      <span>${escapeHtml(detail)}</span>
    </div>
  `;
}

function currentDecisionTitle(current = {}) {
  const position = current.position;
  const alert = current.alert || {};
  if (position?.status === "open") return `当前结论：已有虚拟${positionLabel(position.direction)}持仓，等待平仓`;
  if (position?.status === "waiting_entry") return `当前结论：${positionLabel(position.direction)}等待入场`;
  if (position?.status === "closed") return "当前结论：上一轮观察已结束，等待新方向";
  if (alert.direction === "long") return "当前结论：开多候选已达标";
  if (alert.direction === "short") return "当前结论：开空候选已达标";
  return "当前结论：暂无正式开多/开空信号";
}

function sideStateText(signal, active) {
  if (active) return "当前采用";
  if (!signal) return "无候选";
  if (signal.quality?.status === "actionable") return `${formatScore(signal.score)}分达标`;
  const firstProblem = signal.quality?.problems?.[0];
  return `${formatScore(signal.score)}分未达标${firstProblem ? `（${firstProblem}）` : ""}`;
}

function renderDecisionBoard(current = {}, item = {}) {
  const reviews = current.signalReviews || [];
  const longSignal = pickDirectionReview(reviews, "long");
  const shortSignal = pickDirectionReview(reviews, "short");
  const position = current.position || null;

  return `
    <div class="watch-decision-board">
      <div class="watch-alert-head">
        <strong>开多 / 开空判断</strong>
        <span>${escapeHtml(decisionSummary(current))}</span>
      </div>
      <div class="decision-grid">
        ${decisionCard("开多", longSignal, current.alert?.direction === "long", "long")}
        ${decisionCard("开空", shortSignal, current.alert?.direction === "short", "short")}
      </div>
      ${position ? renderPositionFlow(position, item.alerts || []) : `
        <div class="position-flow empty-flow">
          <strong>持仓流程</strong>
          <span>当前没有虚拟持仓，只有候选达到门槛后才会生成固定提醒。</span>
        </div>
      `}
    </div>
  `;
}

function pickDirectionReview(reviews, side) {
  const directions = side === "long" ? ["long", "spot_buy"] : ["short", "spot_sell"];
  return reviews
    .filter((signal) => directions.includes(signal.direction))
    .sort((a, b) => {
      const actionable = Number(b.quality?.status === "actionable") - Number(a.quality?.status === "actionable");
      if (actionable !== 0) return actionable;
      return Number(b.score || 0) - Number(a.score || 0);
    })[0] || null;
}

function decisionCard(title, signal, active, side) {
  if (!signal) {
    return `
      <div class="decision-card ${side}">
        <div class="decision-title">
          <b>${title}</b>
          <span class="tag wait">无候选</span>
        </div>
        <p>当前没有形成${title}候选。</p>
      </div>
    `;
  }

  const actionable = signal.quality?.status === "actionable";
  const tagText = active ? "当前采用" : actionable ? "达标" : "未达标";
  const detail = actionable
    ? (signal.quality?.notes || []).slice(0, 2).join("；") || (signal.reasons || []).slice(0, 1).join("；")
    : (signal.quality?.problems || []).slice(0, 2).join("；");

  return `
    <div class="decision-card ${side} ${active ? "active" : ""}">
      <div class="decision-title">
        <b>${escapeHtml(signal.directionLabel || title)}</b>
        <span class="tag ${active || actionable ? side : "wait"}">${tagText}</span>
      </div>
      <div class="decision-meta">
        <span>${escapeHtml(signal.timeframe || "-")}</span>
        <span>${formatScore(signal.score)}分</span>
        <span>RR ${formatNumber(signal.riskReward)}</span>
      </div>
      <p>${escapeHtml(detail || "等待价格、量能和周期确认。")}</p>
    </div>
  `;
}

function renderPositionFlow(position = {}, alerts = []) {
  const latestClose = alerts.find((alert) => alert.lifecycleType === "close");
  const latestOpen = alerts.find((alert) => alert.lifecycleType === "open_signal");
  const status = position.status === "open"
    ? "等待平仓"
    : position.status === "waiting_entry"
      ? "等待入场"
      : position.status === "closed"
        ? "已结束"
        : "观察中";
  const statusDetail = position.status === "open"
    ? `入场 ${formatNumber(position.entryPrice)}，TP1 ${formatNumber(position.takeProfit?.tp1)}，止损 ${formatNumber(position.stopLoss)}`
    : position.status === "waiting_entry"
      ? `入场区间 ${formatRange(position.entryRange)}，过期前未入场会取消`
      : latestClose?.message || "本轮观察已结束。";

  return `
    <div class="position-flow">
      <strong>持仓流程：${escapeHtml(positionLabel(position.direction))}${status}</strong>
      <span>${escapeHtml(statusDetail)}</span>
      ${latestOpen ? `<small>开仓提醒：${new Date(latestOpen.time).toLocaleTimeString()} ${formatNumber(latestOpen.price)}</small>` : ""}
      ${latestClose ? `<small>最近结束：${new Date(latestClose.time).toLocaleTimeString()} ${escapeHtml(latestClose.action)}</small>` : ""}
    </div>
  `;
}

function decisionSummary(current = {}) {
  if (current.position?.status === "open") return "已有虚拟持仓";
  if (current.position?.status === "waiting_entry") return "等待入场确认";
  if (current.alert?.direction === "long") return "当前偏多";
  if (current.alert?.direction === "short") return "当前偏空";
  return "当前等待";
}

function renderWatchEvents(events) {
  if (!events.length) return "";
  return `
    <div class="watch-mini-events">
      ${events.map((event) => `
    <div class="watch-event">
      <strong>${new Date(event.time).toLocaleTimeString()} ${escapeHtml(event.action)}</strong>
      <div class="message">${escapeHtml(event.symbol)}：${escapeHtml(event.message)}，价格 ${formatNumber(event.price)}</div>
    </div>
      `).join("")}
    </div>
  `;
}

function updateAiRuntime(runtimeState = {}) {
  state.aiConfigured = Boolean(runtimeState.aiConfigured);
  state.aiModel = runtimeState.aiModel || state.aiModel || "OpenAI";
  renderAiStatus(state.currentSession?.summary || null);
}

function renderAiStatus(summary = null) {
  if (summary?.aiEnabled) {
    els.summaryAi.textContent = summary.aiModel || state.aiModel || "OpenAI";
    return;
  }

  if (state.aiConfigured) {
    els.summaryAi.textContent = state.aiModel || "OpenAI";
    return;
  }

  els.summaryAi.textContent = "本地规则";
}

function drawWatchChart(canvas, points, alert = null, signalAlerts = [], swing = null, signalReviews = [], tradePlan = null) {
  const ctx = canvas.getContext("2d");
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const cssWidth = Math.max(520, Math.round(rect.width || 760));
  const cssHeight = Math.max(320, Math.round(rect.height || 340));
  const backingWidth = Math.round(cssWidth * dpr);
  const backingHeight = Math.round(cssHeight * dpr);

  if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
    canvas.width = backingWidth;
    canvas.height = backingHeight;
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const width = cssWidth;
  const height = cssHeight;
  const plotLeft = 26;
  const plotRight = width - 24;
  const plotTop = 34;
  const plotBottom = height - 30;
  const plotWidth = plotRight - plotLeft;
  const plotHeight = plotBottom - plotTop;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "#d8dee8";
  ctx.lineWidth = 1.2;
  for (let i = 1; i < 5; i += 1) {
    const y = (height / 5) * i;
    ctx.beginPath();
    ctx.moveTo(plotLeft, y);
    ctx.lineTo(plotRight, y);
    ctx.stroke();
  }
  if (!points.length) {
    ctx.fillStyle = "#6b7280";
    ctx.font = "18px sans-serif";
    ctx.fillText("暂无分时数据", 24, 44);
    return;
  }
  const markerPrices = [];
  if (Array.isArray(alert?.entryRange)) markerPrices.push(...alert.entryRange.filter(isFiniteValue).map(Number));
  if (isFiniteValue(alert?.stopLoss)) markerPrices.push(Number(alert.stopLoss));
  if (isFiniteValue(alert?.takeProfit?.tp1)) markerPrices.push(Number(alert.takeProfit.tp1));
  if (isFiniteValue(alert?.takeProfit?.tp2)) markerPrices.push(Number(alert.takeProfit.tp2));
  if (Array.isArray(swing?.lowZone)) markerPrices.push(...swing.lowZone.filter(isFiniteValue).map(Number));
  if (Array.isArray(swing?.highZone)) markerPrices.push(...swing.highZone.filter(isFiniteValue).map(Number));
  const chartCandidates = chartSignalCandidates(signalReviews, alert);
  const tradePlanCandidates = chartTradePlanCandidates(tradePlan);
  for (const candidate of chartCandidates) {
    if (Array.isArray(candidate.entryRange)) markerPrices.push(...candidate.entryRange.filter(isFiniteValue).map(Number));
    if (isFiniteValue(candidate.stopLoss)) markerPrices.push(Number(candidate.stopLoss));
    if (isFiniteValue(candidate.takeProfit?.tp1)) markerPrices.push(Number(candidate.takeProfit.tp1));
    if (isFiniteValue(candidate.takeProfit?.tp2)) markerPrices.push(Number(candidate.takeProfit.tp2));
  }
  for (const candidate of tradePlanCandidates) {
    if (Array.isArray(candidate.entryRange)) markerPrices.push(...candidate.entryRange.filter(isFiniteValue).map(Number));
    if (isFiniteValue(candidate.stopLoss)) markerPrices.push(Number(candidate.stopLoss));
    if (isFiniteValue(candidate.takeProfit?.tp1)) markerPrices.push(Number(candidate.takeProfit.tp1));
    if (isFiniteValue(candidate.takeProfit?.tp2)) markerPrices.push(Number(candidate.takeProfit.tp2));
  }
  const chartPoints = points.filter((item) => isFiniteValue(item.price));
  const historicalMarkers = buildHistoricalTradeMarkers(chartPoints, alert, signalAlerts);
  const chartMarkers = buildChartMarkers(historicalMarkers, signalAlerts);

  const prices = [
    ...chartPoints.map((item) => Number(item.price)),
    ...markerPrices.map(Number)
  ].filter(Number.isFinite);
  if (!prices.length) {
    ctx.fillStyle = "#6b7280";
    ctx.font = "18px sans-serif";
    ctx.fillText("暂无有效价格数据", 24, 44);
    return;
  }
  const rawMin = Math.min(...prices);
  const rawMax = Math.max(...prices);
  const padding = Math.max((rawMax - rawMin) * 0.08, Math.abs(rawMax) * 0.002, 0.000001);
  const min = rawMin - padding;
  const max = rawMax + padding;
  const range = max - min || 1;
  const yFor = (price) => plotBottom - ((Number(price) - min) / range) * plotHeight;
  const xFor = (index) => (index / Math.max(chartPoints.length - 1, 1)) * plotWidth + plotLeft;

  if (Array.isArray(swing?.lowZone)) {
    drawZoneBand(ctx, plotLeft, plotRight, yFor, swing.lowZone, "#0f766e", "低点区");
  }

  if (Array.isArray(swing?.highZone)) {
    drawZoneBand(ctx, plotLeft, plotRight, yFor, swing.highZone, "#dc2626", "高点区");
  }

  drawTradePlanGuides(ctx, width, plotLeft, plotRight, yFor, tradePlanCandidates);
  drawCandidateGuides(ctx, width, plotLeft, plotRight, yFor, chartCandidates, alert);

  if (alert?.entryRange?.length === 2) {
    const [entryLow, entryHigh] = alert.entryRange.map(Number).sort((a, b) => a - b);
    const yTop = yFor(entryHigh);
    const yBottom = yFor(entryLow);
    const entryColor = alert.direction === "short" || alert.direction === "spot_sell" ? "#dc2626" : "#0f766e";
    ctx.fillStyle = alert.direction === "short" || alert.direction === "spot_sell"
      ? "rgba(220, 38, 38, 0.08)"
      : "rgba(15, 118, 110, 0.08)";
    ctx.fillRect(plotLeft, yTop, plotWidth, Math.max(2, yBottom - yTop));
    drawGuideLine(ctx, width, plotLeft, plotRight, yTop, entryColor, "入上", formatNumber(entryHigh));
    drawGuideLine(ctx, width, plotLeft, plotRight, yBottom, entryColor, "入下", formatNumber(entryLow));
  }

  if (isFiniteValue(alert?.stopLoss)) {
    drawGuideLine(ctx, width, plotLeft, plotRight, yFor(alert.stopLoss), "#dc2626", "止损", formatNumber(alert.stopLoss));
  }

  if (isFiniteValue(alert?.takeProfit?.tp1)) {
    drawGuideLine(ctx, width, plotLeft, plotRight, yFor(alert.takeProfit.tp1), "#16a34a", "TP1", formatNumber(alert.takeProfit.tp1));
  }

  if (isFiniteValue(alert?.takeProfit?.tp2)) {
    drawGuideLine(ctx, width, plotLeft, plotRight, yFor(alert.takeProfit.tp2), "#2563eb", "TP2", formatNumber(alert.takeProfit.tp2));
  }

  ctx.strokeStyle = "#0f766e";
  ctx.lineWidth = 3;
  ctx.setLineDash([]);
  ctx.beginPath();
  chartPoints.forEach((point, index) => {
    const x = (index / Math.max(chartPoints.length - 1, 1)) * plotWidth + plotLeft;
    const y = yFor(point.price);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  drawSignalMarkers(ctx, {
    chartPoints,
    signalAlerts: chartMarkers,
    plotLeft,
    plotRight,
    plotBottom,
    yFor,
    xFor
  });
  drawTradePlanPointMarkers(ctx, {
    chartPoints,
    candidates: tradePlanCandidates,
    plotLeft,
    plotRight,
    plotBottom,
    yFor,
    xFor
  });

  ctx.fillStyle = "#1c2430";
  ctx.font = "15px sans-serif";
  ctx.fillText(`高 ${formatNumber(rawMax)}  低 ${formatNumber(rawMin)}`, 16, 20);
}

function chartTradePlanCandidates(plan = null) {
  if (!plan) return [];
  return [plan.buy, plan.sell]
    .filter((side) => side && Array.isArray(side.zoneRange) && side.zoneRange.length === 2)
    .map((side) => {
      const direction = tradePlanSideDirection(side);
      return {
        direction,
        status: side.status || "watch",
        entryRange: side.zoneRange,
        stopLoss: side.stopLoss,
        takeProfit: side.takeProfit,
        label: tradePlanChartLabel({ direction, status: side.status })
      };
    });
}

function tradePlanSideDirection(side = {}) {
  if (side.side === "short" || side.direction === "short") return "short";
  if (side.side === "spot_sell" || side.direction === "spot_sell") return "spot_sell";
  const title = String(side.title || "");
  if (title.includes("卖") || title.includes("空")) return "short";
  return "long";
}

function tradePlanChartLabel(candidate = {}) {
  const isShort = candidate.direction === "short" || candidate.direction === "spot_sell";
  if (candidate.status === "ready") return isShort ? "卖/空点" : "买点";
  return isShort ? "卖/空观察" : "买点观察";
}

function chartSignalCandidates(reviews = [], alert = {}) {
  if (!Array.isArray(reviews) || !reviews.length) return [];
  const activeDirection = alert?.direction || "wait";
  const groups = {
    long: ["long", "spot_buy"],
    short: ["short", "spot_sell"]
  };

  return Object.values(groups)
    .map((directions) => reviews
      .filter((signal) => directions.includes(signal.direction))
      .filter((signal) => Array.isArray(signal.entryRange) || isFiniteValue(signal.stopLoss) || signal.takeProfit)
      .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))[0])
    .filter(Boolean)
    .filter((signal) => signal.direction !== activeDirection);
}

function drawTradePlanGuides(ctx, width, plotLeft, plotRight, yFor, candidates = []) {
  for (const candidate of candidates) {
    const isShort = candidate.direction === "short" || candidate.direction === "spot_sell";
    const color = isShort ? "#dc2626" : "#0f766e";
    const label = tradePlanChartLabel(candidate);

    if (Array.isArray(candidate.entryRange) && candidate.entryRange.length === 2) {
      const [entryLow, entryHigh] = candidate.entryRange.map(Number).sort((a, b) => a - b);
      const yTop = yFor(entryHigh);
      const yBottom = yFor(entryLow);
      ctx.save();
      ctx.fillStyle = isShort ? "rgba(220, 38, 38, 0.1)" : "rgba(15, 118, 110, 0.1)";
      ctx.fillRect(plotLeft, yTop, plotRight - plotLeft, Math.max(3, yBottom - yTop));
      ctx.restore();
      drawGuideLine(ctx, width, plotLeft, plotRight, yTop, color, `${label}上`, formatNumber(entryHigh));
      drawGuideLine(ctx, width, plotLeft, plotRight, yBottom, color, `${label}下`, formatNumber(entryLow));
    }

    if (isFiniteValue(candidate.stopLoss)) {
      drawGuideLine(ctx, width, plotLeft, plotRight, yFor(candidate.stopLoss), "#dc2626", `${label}止损`, formatNumber(candidate.stopLoss), true);
    }

    if (isFiniteValue(candidate.takeProfit?.tp1)) {
      drawGuideLine(ctx, width, plotLeft, plotRight, yFor(candidate.takeProfit.tp1), "#16a34a", `${label}TP1`, formatNumber(candidate.takeProfit.tp1), true);
    }
  }
}

function drawTradePlanPointMarkers(ctx, { chartPoints, candidates, plotLeft, plotRight, plotBottom, yFor, xFor }) {
  if (!chartPoints.length || !candidates.length) return;
  const index = chartPoints.length - 1;
  const point = chartPoints[index];
  const price = Number(point.price);
  if (!Number.isFinite(price)) return;

  const activeCandidates = candidates.filter((candidate) => priceInRange(price, candidate.entryRange));
  activeCandidates.forEach((candidate, offsetIndex) => {
    const isShort = candidate.direction === "short" || candidate.direction === "spot_sell";
    const color = isShort ? "#dc2626" : "#0f766e";
    const x = Math.max(plotLeft, Math.min(plotRight, xFor(index)));
    const y = yFor(price);

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.setLineDash([4, 6]);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, plotBottom);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(x, y, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.4;
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
    drawTag(ctx, tradePlanChartLabel(candidate), x - 72, y - 48 + (offsetIndex % 4) * 24, color, 12);
    ctx.restore();
  });
}

function drawCandidateGuides(ctx, width, plotLeft, plotRight, yFor, candidates = []) {
  for (const signal of candidates) {
    const isShort = signal.direction === "short" || signal.direction === "spot_sell";
    const color = isShort ? "#dc2626" : "#0f766e";

    if (Array.isArray(signal.entryRange) && signal.entryRange.length === 2) {
      const [entryLow, entryHigh] = signal.entryRange.map(Number).sort((a, b) => a - b);
      const yTop = yFor(entryHigh);
      const yBottom = yFor(entryLow);
      ctx.save();
      ctx.fillStyle = isShort ? "rgba(220, 38, 38, 0.045)" : "rgba(15, 118, 110, 0.045)";
      ctx.fillRect(plotLeft, yTop, plotRight - plotLeft, Math.max(2, yBottom - yTop));
      ctx.restore();
      drawGuideLine(ctx, width, plotLeft, plotRight, yTop, color, isShort ? "空候选上" : "多候选上", formatNumber(entryHigh), true);
      drawGuideLine(ctx, width, plotLeft, plotRight, yBottom, color, isShort ? "空候选下" : "多候选下", formatNumber(entryLow), true);
    }

    if (isFiniteValue(signal.stopLoss)) {
      drawGuideLine(ctx, width, plotLeft, plotRight, yFor(signal.stopLoss), "#dc2626", isShort ? "空候选止损" : "多候选止损", formatNumber(signal.stopLoss), true);
    }

    if (isFiniteValue(signal.takeProfit?.tp1)) {
      drawGuideLine(ctx, width, plotLeft, plotRight, yFor(signal.takeProfit.tp1), "#16a34a", isShort ? "空候选TP1" : "多候选TP1", formatNumber(signal.takeProfit.tp1), true);
    }

    if (isFiniteValue(signal.takeProfit?.tp2)) {
      drawGuideLine(ctx, width, plotLeft, plotRight, yFor(signal.takeProfit.tp2), "#2563eb", isShort ? "空候选TP2" : "多候选TP2", formatNumber(signal.takeProfit.tp2), true);
    }
  }
}

function drawSignalMarkers(ctx, { chartPoints, signalAlerts, plotLeft, plotRight, plotBottom, yFor, xFor }) {
  const sortedAlerts = spreadNearbyMarkers(signalAlerts);
  for (const signal of sortedAlerts) {
    const index = nearestPointIndex(chartPoints, signal.time);
    if (index < 0) continue;
    const point = chartPoints[index];
    const markerPrice = isFiniteValue(signal.price) ? Number(signal.price) : point.price;
    const markerColor = markerColorForSignal(signal);
    const x = Math.max(plotLeft, Math.min(plotRight, xFor(index)));
    const y = yFor(markerPrice);

    ctx.save();
    ctx.strokeStyle = markerColor;
    ctx.lineWidth = signal.kind === "fixed-alert" ? 1.4 : 1;
    ctx.setLineDash(signal.kind === "fixed-alert" ? [4, 6] : [2, 7]);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, plotBottom);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = markerColor;
    ctx.beginPath();
    ctx.arc(x, y, signal.kind === "fixed-alert" ? 6 : 4.5, 0, Math.PI * 2);
    ctx.fill();
    const tagText = signal.chartLabel || compactMarkerLabel(signal);
    const tagX = Math.max(plotLeft + 4, Math.min(plotRight - 118, x - 58));
    const tagY = y - 34 + (signal.labelOffset || 0);
    drawTag(ctx, tagText, tagX, tagY, markerColor, signal.kind === "fixed-alert" ? 12 : 11);
    ctx.restore();
  }
}

function markerColorForSignal(signal = {}) {
  if (signal.lifecycleType === "swing") {
    if (signal.swingSide === "high") return "#dc2626";
    if (signal.swingSide === "low") return "#0f766e";
    return "#64748b";
  }
  if (signal.type === "stop") return "#dc2626";
  if (signal.type === "tp") return "#2563eb";
  if (signal.direction === "short" || signal.direction === "spot_sell") return "#dc2626";
  if (signal.direction === "wait") return "#64748b";
  return "#0f766e";
}

function drawZoneBand(ctx, plotLeft, plotRight, yFor, zone, color, label) {
  if (!Array.isArray(zone) || zone.length !== 2 || !zone.every(isFiniteValue)) return;
  const [low, high] = zone.map(Number).sort((a, b) => a - b);
  const yTop = yFor(high);
  const yBottom = yFor(low);
  const bandHeight = Math.max(3, yBottom - yTop);

  ctx.save();
  ctx.fillStyle = color === "#dc2626" ? "rgba(220, 38, 38, 0.07)" : "rgba(15, 118, 110, 0.07)";
  ctx.fillRect(plotLeft, yTop, plotRight - plotLeft, bandHeight);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.2;
  ctx.setLineDash([6, 6]);
  ctx.beginPath();
  ctx.moveTo(plotLeft, yTop);
  ctx.lineTo(plotRight, yTop);
  ctx.moveTo(plotLeft, yBottom);
  ctx.lineTo(plotRight, yBottom);
  ctx.stroke();
  ctx.setLineDash([]);
  drawTag(ctx, `${label} ${formatRange(zone)}`, plotLeft + 10, yTop + 6, color, 11);
  ctx.restore();
}

function buildChartMarkers(historicalMarkers, fixedAlerts) {
  const fixed = fixedAlerts
    .slice(0, 2)
    .map((signal) => ({
      ...signal,
      kind: "fixed-alert",
      chartLabel: fixedChartLabel(signal)
    }));
  const touches = historicalMarkers
    .slice(-3)
    .map((signal) => ({
      ...signal,
      chartLabel: compactMarkerLabel(signal)
    }));
  return [...touches, ...fixed]
    .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
}

function spreadNearbyMarkers(markers) {
  const sorted = markers.slice().sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
  const buckets = new Map();

  return sorted.map((marker) => {
    const bucket = Math.floor(new Date(marker.time).getTime() / 180000);
    const count = buckets.get(bucket) || 0;
    buckets.set(bucket, count + 1);
    return {
      ...marker,
      labelOffset: [0, -18, 18, -34, 34][count % 5]
    };
  });
}

function buildHistoricalTradeMarkers(points, alert = {}, existingAlerts = []) {
  if (!Array.isArray(points) || !points.length || !alert || alert.direction === "wait") return [];
  const fixedTimes = new Set(existingAlerts.map((item) => minuteBucket(item.time)));
  const rules = [];
  const entryLabel = entryPointLabel(alert.direction);
  const tpDirection = exitDirectionFor(alert.direction);
  const stopDirection = stopDirectionFor(alert.direction);

  if (Array.isArray(alert.entryRange) && alert.entryRange.length === 2) {
    const [low, high] = alert.entryRange.map(Number).sort((a, b) => a - b);
    rules.push({
      type: "entry",
      direction: alert.direction,
      label: entryLabel,
      message: `价格进入当前策略入场区 ${formatNumber(low)} - ${formatNumber(high)}`,
      matches: (price, previousPrice) => {
        const insideNow = price >= low && price <= high;
        const wasInside = previousPrice >= low && previousPrice <= high;
        return insideNow && !wasInside;
      }
    });
  }

  if (isFiniteValue(alert.takeProfit?.tp1)) {
    const tp1 = Number(alert.takeProfit.tp1);
    rules.push({
      type: "tp",
      direction: tpDirection,
      label: takeProfitLabel(alert.direction, "TP1"),
      message: `价格触碰 TP1 ${formatNumber(tp1)}`,
      matches: (price, previousPrice) => crossedLevel(price, previousPrice, tp1)
    });
  }

  if (isFiniteValue(alert.takeProfit?.tp2)) {
    const tp2 = Number(alert.takeProfit.tp2);
    rules.push({
      type: "tp",
      direction: tpDirection,
      label: takeProfitLabel(alert.direction, "TP2"),
      message: `价格触碰 TP2 ${formatNumber(tp2)}`,
      matches: (price, previousPrice) => crossedLevel(price, previousPrice, tp2)
    });
  }

  if (isFiniteValue(alert.stopLoss)) {
    const stopLoss = Number(alert.stopLoss);
    rules.push({
      type: "stop",
      direction: stopDirection,
      label: stopLabel(alert.direction),
      message: `价格触碰止损 ${formatNumber(stopLoss)}`,
      matches: (price, previousPrice) => crossedLevel(price, previousPrice, stopLoss)
    });
  }

  const markers = [];
  const used = new Set();
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const price = Number(point.price);
    const previousPrice = index > 0 ? Number(points[index - 1].price) : price;
    if (!Number.isFinite(price)) continue;
    const bucket = minuteBucket(point.time);
    if (fixedTimes.has(bucket)) continue;

    for (const rule of rules) {
      const key = `${rule.type}:${bucket}`;
      if (used.has(key)) continue;
      if (!rule.matches(price, previousPrice)) continue;
      used.add(key);
      markers.push({
        kind: "touch",
        id: key,
        time: new Date(point.time).toISOString(),
        price,
        type: rule.type,
        direction: rule.direction,
        label: rule.label,
        action: rule.label,
        message: rule.message
      });
      break;
    }
  }
  return markers;
}

function entryPointLabel(direction) {
  if (direction === "long") return "开多点";
  if (direction === "short") return "开空点";
  if (direction === "spot_sell") return "卖出点";
  return "买点";
}

function takeProfitLabel(direction, label) {
  if (direction === "long") return `平多${label}`;
  if (direction === "short") return `平空${label}`;
  return label;
}

function stopLabel(direction) {
  if (direction === "long") return "多单止损";
  if (direction === "short") return "空单止损";
  return "止损";
}

function exitDirectionFor(direction) {
  if (direction === "short") return "long";
  if (direction === "spot_buy" || direction === "long") return "spot_sell";
  return "spot_buy";
}

function stopDirectionFor(direction) {
  if (direction === "short") return "long";
  return "spot_sell";
}

function shortAlertLabel(alert = {}) {
  if (alert.lifecycleType === "swing") return alert.action || "波段提醒";
  if (alert.direction === "long") return "合约开多";
  if (alert.direction === "short") return "合约开空";
  if (alert.direction === "spot_buy") return "现货买入";
  if (alert.direction === "spot_sell") return "现货卖出";
  return alert.action || "提醒";
}

function fixedChartLabel(alert = {}) {
  if (alert.lifecycleType === "swing") {
    if (alert.swingSide === "low") return "波段低点";
    if (alert.swingSide === "high") return "波段高点";
    return "波段";
  }
  if (alert.direction === "long") return "开多提醒";
  if (alert.direction === "short") return "开空提醒";
  if (alert.direction === "spot_buy") return "买入提醒";
  if (alert.direction === "spot_sell") return "卖出提醒";
  return "提醒";
}

function compactMarkerLabel(marker = {}) {
  if (marker.lifecycleType === "swing") {
    if (marker.swingSide === "low") return "波段低点";
    if (marker.swingSide === "high") return "波段高点";
    return "波段";
  }
  if (marker.type === "tp") return marker.label?.replace("平多", "多").replace("平空", "空") || "TP";
  if (marker.type === "stop") return marker.label?.replace("多单", "").replace("空单", "") || "止损";
  if (marker.direction === "long") return "开多";
  if (marker.direction === "short") return "开空";
  if (marker.direction === "spot_buy") return "买入";
  if (marker.direction === "spot_sell") return "卖出";
  return marker.label || "点位";
}

function crossedLevel(price, previousPrice, level) {
  if (!Number.isFinite(price) || !Number.isFinite(previousPrice) || !Number.isFinite(level)) return false;
  return (previousPrice <= level && price >= level) || (previousPrice >= level && price <= level);
}

function priceInRange(price, range) {
  if (!Number.isFinite(price) || !Array.isArray(range) || range.length !== 2) return false;
  const [low, high] = range.map(Number).sort((a, b) => a - b);
  if (!Number.isFinite(low) || !Number.isFinite(high)) return false;
  return price >= low && price <= high;
}

function minuteBucket(time) {
  const value = new Date(time).getTime();
  if (!Number.isFinite(value)) return "";
  return String(Math.floor(value / 60000));
}

function nearestPointIndex(points, time) {
  const target = new Date(time).getTime();
  if (!Number.isFinite(target) || !points.length) return -1;
  const firstTime = Number(points[0]?.time);
  const lastTime = Number(points.at(-1)?.time);
  if (Number.isFinite(firstTime) && Number.isFinite(lastTime) && (target < firstTime || target > lastTime)) {
    return -1;
  }
  let bestIndex = 0;
  let bestDistance = Infinity;
  points.forEach((point, index) => {
    const pointTime = Number(point.time);
    if (!Number.isFinite(pointTime)) return;
    const distance = Math.abs(pointTime - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function drawGuideLine(ctx, width, plotLeft, plotRight, y, color, label, value, subtle = false) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.globalAlpha = subtle ? 0.62 : 1;
  ctx.lineWidth = subtle ? 1.1 : 1.6;
  ctx.setLineDash(subtle ? [4, 8] : [7, 6]);
  ctx.beginPath();
  ctx.moveTo(plotLeft, y);
  ctx.lineTo(plotRight, y);
  ctx.stroke();
  drawTag(ctx, `${label} ${value}`, Math.min(width - 190, plotLeft + 8), y - 14, color, subtle ? 11 : 15);
  ctx.restore();
}

function drawTag(ctx, text, x, y, color, fontSize = 14) {
  ctx.save();
  ctx.font = `700 ${fontSize}px sans-serif`;
  const paddingX = 10;
  const paddingY = 6;
  const width = ctx.measureText(text).width + paddingX * 2;
  const height = fontSize + paddingY * 2;
  const rect = ctx.canvas.getBoundingClientRect();
  const canvasWidth = rect.width || ctx.canvas.width;
  const canvasHeight = rect.height || ctx.canvas.height;
  const safeX = Math.max(8, Math.min(x, canvasWidth - width - 8));
  const safeY = Math.max(8, Math.min(y, canvasHeight - height - 8));
  ctx.fillStyle = color;
  ctx.fillRect(safeX, safeY, width, height);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(text, safeX + paddingX, safeY + height - paddingY - 1);
  ctx.restore();
}

function metric(label, value) {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function list(items) {
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function reviewLabel(review = {}) {
  if (review.decision === "pass") return "Pass";
  if (review.decision === "reject") return "Reject";
  return "Watch";
}

function qualityList(quality = {}) {
  const items = [];
  for (const item of quality.timeframeConfirmation?.supporting || []) {
    items.push(`${item.interval} supports: ${item.trend}`);
  }
  for (const item of quality.timeframeConfirmation?.opposing || []) {
    items.push(`${item.interval} conflicts: ${item.trend}`);
  }
  for (const note of quality.notes || []) items.push(note);
  for (const problem of quality.problems || []) items.push(problem);
  return list(items.length ? items : ["No higher-timeframe conflict after quality screening."]);
}

function percentText(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "-";
  return `${(num * 100).toFixed(1)}%`;
}

function formatPercentValue(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "-";
  const sign = num > 0 ? "+" : "";
  return `${sign}${num.toFixed(2)}%`;
}

function formatEvaluationName(name) {
  return String(name || "-").replaceAll(":", " / ");
}

function formatRange(range) {
  return `${formatNumber(range[0])} - ${formatNumber(range[1])}`;
}

function formatNumber(value) {
  if (value === null || value === undefined) return "-";
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value);
  if (num >= 1000) return num.toFixed(2);
  if (num >= 1) return num.toFixed(4);
  return num.toPrecision(6);
}

function formatScore(value) {
  const num = Number(value);
  return Number.isFinite(num) ? String(Math.round(num)) : "-";
}

function positionLabel(direction) {
  if (direction === "long") return "开多";
  if (direction === "short") return "开空";
  if (direction === "spot_buy") return "买入";
  if (direction === "spot_sell") return "卖出";
  return "信号";
}

function isFiniteValue(value) {
  if (value === null || value === undefined || value === "") return false;
  return Number.isFinite(Number(value));
}

function formatWatchMarket(current = {}) {
  if (current.marketType === "futures") return current.isFuturesProxy ? "合约（现货代理）" : "合约";
  return "现货";
}

function formatMarketSource(current = {}) {
  if (current.isFuturesProxy) return "现货K线代理";
  if (current.dataSourceMarketType === "futures") return "合约行情";
  if (current.dataSourceMarketType === "spot") return "现货行情";
  return current.marketType === "futures" ? "合约行情" : "现货行情";
}

function formatFundingRate(current = {}) {
  if (current.isFuturesProxy) return "需交易所确认";
  if (current.fundingRate === null || current.fundingRate === undefined) return "-";
  return `${(Number(current.fundingRate) * 100).toFixed(4)}%`;
}

function explainActionShort(alert = {}, current = {}) {
  if (alert.direction === "spot_buy") return "现货买入候选";
  if (alert.direction === "spot_sell") return "现货减仓/卖出";
  if (alert.direction === "long") return "合约开多候选";
  if (alert.direction === "short") return "合约开空候选";
  if (current.marketType === "spot") return "现货继续观察";
  if (current.marketType === "futures") return "合约继续观察";
  return "继续观察";
}

function explainAction(alert = {}, current = {}) {
  if (alert.direction === "spot_buy") return "偏看多：等待价格进入入场区并企稳后，才考虑现货买入。";
  if (alert.direction === "spot_sell") return "偏看弱：如果已有现货仓位，重点观察减仓/卖出；没有持仓时通常是不要追买。";
  if (alert.direction === "long") return "合约偏多：只表示开多候选，必须确认止损、仓位和强平距离，不是立即开仓。";
  if (alert.direction === "short") return "合约偏空：只表示开空候选，必须确认止损、仓位和强平距离，不是立即开仓。";
  if (current.marketType === "spot") return "现货没有明确买卖条件，继续等待。";
  if (current.marketType === "futures") return "合约没有明确多空条件，继续等待。";
  return "没有明确买卖条件，继续等待。";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function cssEscape(value) {
  if (window.CSS?.escape) return window.CSS.escape(String(value));
  return String(value).replaceAll('"', '\\"').replaceAll("\\", "\\\\");
}

// ---- Monitor 纸面交易监控 ----

async function loadMonitorStatus() {
  try {
    const res = await fetch("/api/monitor/status");
    const data = await res.json();
    if (!data.ok || !data.monitor?.available) {
      showMonitorUnavailable(data.monitor?.message || data.error || "Monitor 数据尚未生成");
      return;
    }
    renderMonitorStatus(data.monitor);
  } catch (err) {
    showMonitorUnavailable(err.message || "Monitor 接口请求失败");
  }
}

async function loadMonitorSessions() {
  try {
    const res = await fetch("/api/monitor/sessions?limit=10");
    const data = await res.json();
    if (data.ok && data.sessions?.length) {
      renderMonitorSessions(data.sessions);
    }
  } catch {
    // ignore
  }
}

function renderMonitorStatus(m) {
  els.monitorEmpty.hidden = true;
  els.monitorOverview.hidden = false;
  els.monitorRuntimeBanner.hidden = false;
  els.monitorStatus.textContent = m.status === "running" ? "运行中" : m.status;

  const statusColors = { running: "#22c55e", completed: "#94a3b8", timeout: "#f59e0b" };
  els.monitorStatus.style.color = statusColors[m.status] || "#94a3b8";

  els.monitorSessionStatus.textContent = m.status || "-";
  els.monitorStartedAt.textContent = m.startedAt ? formatTime(m.startedAt) : "-";
  els.monitorScanCount.textContent = m.scanCount || 0;

  const closedTradeCount = m.summary?.closed
    ?? (m.trades || []).filter((trade) => trade.status === "closed" && !trade.isPartialClose).length;
  const partialCloseCount = m.summary?.partialCloses
    ?? (m.trades || []).filter((trade) => trade.isPartialClose).length;
  els.monitorClosedTrades.textContent = closedTradeCount;
  els.monitorPartialCloses.textContent = partialCloseCount;

  if (m.summary) {
    const wr = m.summary.netWinRate ?? m.summary.winRate;
    els.monitorWinRate.textContent = typeof wr === "number" ? `${(wr * 100).toFixed(1)}%` : "-";
    const tr = m.summary.totalEstimatedNetReturnPercent ?? m.summary.totalNetReturnPercent ?? m.summary.totalReturnPercent;
    els.monitorTotalReturn.textContent = typeof tr === "number" ? `${tr > 0 ? "+" : ""}${tr.toFixed(2)}%` : "-";
    els.monitorTotalReturn.style.color = tr > 0 ? "#22c55e" : tr < 0 ? "#ef4444" : "#94a3b8";
  } else {
    els.monitorWinRate.textContent = "-";
    els.monitorTotalReturn.textContent = "-";
    els.monitorTotalReturn.style.color = "#94a3b8";
  }

  renderMonitorRuntimeState(m.entryState, m.dataSource);

  // Positions
  els.monitorPositions.hidden = false;
  if (m.positions?.length) {
    els.positionsList.innerHTML = m.positions.map((p) => `
      <div class="monitor-row">
        <span class="monitor-symbol">${escapeHtml(p.symbol)}</span>
        <span class="monitor-side ${p.side}">${p.side === "long" ? "做多" : "做空"}</span>
        <span>入场 ${p.entryPrice}</span>
        <span>止损 ${p.stopLoss}</span>
        <span>止盈 ${p.takeProfit}</span>
        <span class="monitor-time">${formatTime(p.openedAt)}</span>
        ${p.unrealizedPercent != null ? `<span style="color:${p.unrealizedPercent >= 0 ? "#22c55e" : "#ef4444"}">${p.unrealizedPercent > 0 ? "+" : ""}${p.unrealizedPercent.toFixed(2)}%</span>` : ""}
      </div>
    `).join("");
  } else {
    els.positionsList.innerHTML = `<div class="monitor-inline-state">当前暂无持仓</div>`;
  }

  // Trades
  if (m.trades?.length) {
    els.monitorTrades.hidden = false;
    els.tradesList.innerHTML = m.trades.map((t) => {
      const pnl = t.netReturnPercent;
      const color = pnl > 0 ? "#22c55e" : pnl < 0 ? "#ef4444" : "#94a3b8";
      const presentation = presentMonitorTrade(t);
      return `
        <div class="monitor-row">
          <span class="monitor-symbol">${escapeHtml(t.symbol)}</span>
          <span class="monitor-side ${t.side}">${t.side === "long" ? "做多" : "做空"}</span>
          <span class="monitor-trade-status ${t.isPartialClose ? "partial" : t.status === "open" ? "open" : "final"}">${escapeHtml(presentation.statusLabel)}</span>
          <span>原因 ${escapeHtml(presentation.outcomeLabel)}</span>
          <span>入场 ${t.entryPrice}</span>
          <span>出场 ${t.exitPrice ?? "-"}</span>
          <span style="color:${color};font-weight:600">${typeof pnl === "number" ? `${pnl > 0 ? "+" : ""}${pnl.toFixed(2)}%` : "-"}</span>
          <span>${t.secondsHeld ? `${Math.round(t.secondsHeld / 60)}分钟` : "-"}</span>
          <span class="monitor-time">${formatTime(t.closedAt || t.openedAt)}</span>
        </div>
      `;
    }).join("");
  } else {
    els.monitorTrades.hidden = true;
  }

  // Errors
  if (m.errors?.length) {
    els.monitorErrors.hidden = false;
    els.errorsList.innerHTML = m.errors.map((e) => `
      <div class="monitor-error-row">
        <span class="monitor-time">${formatTime(e.at)}</span>
        <span>[${escapeHtml(e.scope || "")}]</span>
        <span>${escapeHtml(e.message || "")}</span>
      </div>
    `).join("");
  } else {
    els.monitorErrors.hidden = true;
  }
}

function showMonitorUnavailable(message) {
  els.monitorStatus.textContent = "读取失败";
  els.monitorStatus.style.color = "#ef4444";
  els.monitorEmpty.hidden = false;
  els.monitorEmpty.textContent = `Monitor 数据读取失败：${message}`;
  els.monitorOverview.hidden = true;
  els.monitorRuntimeBanner.hidden = true;
  els.monitorPositions.hidden = false;
  els.positionsList.innerHTML = `<div class="monitor-inline-state error">持仓数据读取失败，无法确认当前是否有持仓。</div>`;
  els.monitorTrades.hidden = true;
  els.monitorErrors.hidden = true;
}

function renderMonitorRuntimeState(entryState, dataSource) {
  const entry = presentEntryState(entryState);
  els.monitorEntryState.className = `monitor-runtime-item ${entry.tone}`;
  els.monitorEntryMode.textContent = entry.modeLabel;
  els.monitorEntryDetail.textContent = entryState?.resumeAt
    ? `${entry.detail}：${formatTime(entryState.resumeAt)}`
    : entry.detail;

  const source = presentDataSource(dataSource);
  els.monitorDataSource.className = `monitor-runtime-item ${source.tone}`;
  els.monitorDataSourceLabel.textContent = source.label;
  els.monitorDataSourceDetail.textContent = source.detail;
}

function renderMonitorSessions(sessions) {
  els.monitorSessions.hidden = false;
  els.sessionsList.innerHTML = sessions.map((s) => `
    <div class="monitor-row">
      <span class="monitor-symbol">${escapeHtml(s.file.replace(".json", ""))}</span>
      <span>${s.status}</span>
      <span>扫描 ${s.scanCount} 轮</span>
      <span>主交易 ${s.tradeCount} 笔</span>
      <span>已平仓 ${s.closedTradeCount ?? s.tradeCount} 笔</span>
      <span>部分减仓 ${s.partialCloseCount || 0} 次</span>
      <span class="monitor-time">${formatTime(s.startedAt)}</span>
      ${s.summary ? (() => { const value = s.summary.totalEstimatedNetReturnPercent ?? s.summary.totalNetReturnPercent ?? s.summary.totalReturnPercent ?? 0; return `<span style="color:${value >= 0 ? "#22c55e" : "#ef4444"}">${value > 0 ? "+" : ""}${value.toFixed(2)}%</span>`; })() : ""}
      <button type="button" class="monitor-session-detail" data-file="${escapeHtml(s.file)}">详情</button>
    </div>
  `).join("");
  els.sessionsList.querySelectorAll(".monitor-session-detail").forEach((button) => {
    button.addEventListener("click", () => loadMonitorSessionDetail(button.dataset.file));
  });
}

async function loadMonitorSessionDetail(file) {
  try {
    const res = await fetch(`/api/monitor/sessions/${encodeURIComponent(file)}`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "读取失败");
    const trades = data.session.trades || [];
    els.monitorSessionDetail.hidden = false;
    els.monitorSessionDetailTitle.textContent = `${file.replace(".json", "")} 交易详情`;
    els.monitorSessionDetailList.innerHTML = trades.length ? trades.map((t) => {
      const pnl = t.netReturnPercent ?? t.estimatedNetReturnPercent ?? t.grossReturnPercent;
      const presentation = presentMonitorTrade(t);
      return `
      <div class="monitor-row">
        <span class="monitor-symbol">${escapeHtml(t.symbol)}</span>
        <span class="monitor-side ${t.side}">${t.side === "long" ? "做多" : "做空"}</span>
        <span class="monitor-trade-status ${t.isPartialClose ? "partial" : t.status === "open" ? "open" : "final"}">${escapeHtml(presentation.statusLabel)}${t.carriedOver ? "（隔夜）" : ""}</span>
        <span>原因 ${escapeHtml(presentation.outcomeLabel)}</span>
        <span>入场 ${t.entryPrice}</span>
        <span>出场 ${t.exitPrice ?? "-"}</span>
        <span>止损 ${t.stopLoss ?? "-"}</span>
        <span>止盈 ${t.takeProfit ?? "-"}</span>
        <span>${typeof pnl === "number" ? `净收益 ${pnl > 0 ? "+" : ""}${pnl.toFixed(2)}%` : "净收益 -"}</span>
        <span class="monitor-time">${formatTime(t.closedAt || t.openedAt)}</span>
      </div>
      `;
    }).join("") : `<div class="message">该自然日没有交易记录。</div>`;
  } catch (error) {
    els.monitorSessionDetail.hidden = false;
    els.monitorSessionDetailList.innerHTML = `<div class="message">详情读取失败：${escapeHtml(error.message)}</div>`;
  }
}

function formatTime(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function startMonitorPoll() {
  loadMonitorStatus();
  loadMonitorSessions();
  monitorPollTimer = setInterval(() => {
    loadMonitorStatus();
  }, 30000); // 30 秒刷新
}

// 启动 Monitor 轮询
startMonitorPoll();
