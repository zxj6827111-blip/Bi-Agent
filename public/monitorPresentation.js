const OUTCOME_LABELS = {
  health_reduce: "健康度减仓",
  signal_collapse: "信号衰减",
  tp: "止盈",
  stop: "止损",
  scalp_timeout: "超短线超时",
  timeout: "持仓超时"
};

const ENTRY_REASON_LABELS = {
  consecutive_stop_loss: "连续止损保护",
  daily_loss_limit: "单日亏损上限",
  session_max_drawdown: "Session 最大回撤保护"
};

const DATA_SOURCE_LABELS = {
  timeout: "请求超时",
  dns: "DNS 解析失败",
  restricted: "地区限制（451）",
  other: "其他请求错误"
};

export function presentMonitorTrade(trade = {}) {
  let statusLabel = trade.status || "未知状态";
  if (trade.isPartialClose) statusLabel = "部分减仓";
  else if (trade.status === "closed") statusLabel = "最终平仓";
  else if (trade.status === "open") statusLabel = "持仓中";

  return {
    statusLabel,
    outcomeLabel: trade.outcome ? OUTCOME_LABELS[trade.outcome] || trade.outcome : "-"
  };
}

export function presentEntryState(entryState = {}) {
  if (entryState.mode !== "observe_only") {
    return {
      modeLabel: "ACTIVE",
      detail: "允许新开仓",
      tone: "active"
    };
  }

  const reasons = String(entryState.reason || "risk_guard")
    .split("+")
    .map((reason) => ENTRY_REASON_LABELS[reason] || reason)
    .join("、");
  return {
    modeLabel: "OBSERVE_ONLY",
    detail: entryState.resumeAt
      ? `${reasons}，等待恢复`
      : `${reasons}，本 Session 不再开仓`,
    tone: "observe-only"
  };
}

export function presentDataSource(dataSource = {}) {
  if (dataSource.status === "healthy") {
    return { label: "Binance 数据正常", detail: "数据源健康", tone: "healthy" };
  }
  if (dataSource.status === "degraded") {
    const categories = Array.isArray(dataSource.categories) ? dataSource.categories : [];
    const detail = categories.length
      ? categories.map((category) => DATA_SOURCE_LABELS[category] || category).join("、")
      : "数据请求出现降级";
    return { label: "Binance 数据降级", detail, tone: "degraded" };
  }
  return { label: "Binance 状态未知", detail: "等待数据源健康信息", tone: "unknown" };
}
