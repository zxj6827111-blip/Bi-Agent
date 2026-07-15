import { round } from "./utils.js";

export function realizedAccountReturnPercent(trade) {
  const explicit = Number(trade?.realizedAccountReturnPercent);
  if (Number.isFinite(explicit)) return explicit;

  const netReturn = Number(trade?.estimatedNetReturnPercent);
  const positionSizePercent = Number(trade?.positionSizePercentOfEquity);
  if ([netReturn, positionSizePercent].every(Number.isFinite)) {
    return round(netReturn * positionSizePercent / 100, 4);
  }
  const stopPercent = Number(trade?.stopPercent);
  const accountRiskPercent = Number(trade?.accountRiskPercent);
  if (![netReturn, stopPercent, accountRiskPercent].every(Number.isFinite) || stopPercent <= 0) return 0;
  return round((netReturn / stopPercent) * accountRiskPercent, 4);
}

export function buildPositionRiskPlan(candidate, {
  accountRiskPerTradePercent,
  maxPositionSizePercentOfEquity
} = {}) {
  const stopPercent = Math.max(0, Number(candidate?.stopPercent) || 0);
  const targetRiskPercent = Math.max(0, Number(accountRiskPerTradePercent) || 0);
  const maxPositionSize = Math.max(0, Number(maxPositionSizePercentOfEquity) || 0);
  const uncappedPositionSize = stopPercent > 0 ? targetRiskPercent / stopPercent * 100 : 0;
  const positionSizePercentOfEquity = Math.min(uncappedPositionSize, maxPositionSize);
  const accountRiskPercent = positionSizePercentOfEquity * stopPercent / 100;

  return {
    targetAccountRiskPercent: round(targetRiskPercent, 4),
    accountRiskPercent: round(accountRiskPercent, 4),
    positionSizePercentOfEquity: round(positionSizePercentOfEquity, 4),
    sizeCapped: positionSizePercentOfEquity + 1e-8 < uncappedPositionSize
  };
}

export function calculatePortfolioRiskMetrics(trades = [], { nowMs = Date.now(), timeZone = "UTC" } = {}) {
  const closed = trades
    .filter((trade) => trade?.status === "closed")
    .sort((a, b) => Date.parse(a.closedAt || "") - Date.parse(b.closedAt || ""));

  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const trade of closed) {
    equity += realizedAccountReturnPercent(trade);
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }

  const currentDay = dateKeyInTimeZone(nowMs, timeZone);
  const dailyReturn = closed
    .filter((trade) => dateKeyInTimeZone(Date.parse(trade.closedAt || ""), timeZone) === currentDay)
    .reduce((sum, trade) => sum + realizedAccountReturnPercent(trade), 0);

  return {
    closedTrades: closed.length,
    totalAccountReturnPercent: round(equity, 4),
    peakAccountReturnPercent: round(peak, 4),
    currentDrawdownPercent: round(Math.max(0, peak - equity), 4),
    maxDrawdownPercent: round(maxDrawdown, 4),
    dailyAccountReturnPercent: round(dailyReturn, 4)
  };
}

function dateKeyInTimeZone(timestamp, timeZone) {
  if (!Number.isFinite(timestamp)) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function portfolioEntryBlockers({
  positions = [],
  candidate,
  candidateRiskPlan,
  accountRiskPerTradePercent,
  maxPortfolioRiskPercent,
  maxSameSideOpen,
  maxPortfolioPositionSizePercentOfEquity
} = {}) {
  const blockers = [];
  const riskPerTrade = Math.max(
    0,
    Number(candidateRiskPlan?.accountRiskPercent) || Number(accountRiskPerTradePercent) || 0
  );
  const totalOpenRisk = positions.reduce(
    (sum, position) => sum + Math.max(0, Number(position?.accountRiskPercent) || riskPerTrade),
    0
  );
  const totalPositionSize = positions.reduce(
    (sum, position) => sum + Math.max(0, Number(position?.positionSizePercentOfEquity) || 0),
    0
  );
  const candidatePositionSize = Math.max(0, Number(candidateRiskPlan?.positionSizePercentOfEquity) || 0);
  const sameSideOpen = positions.filter((position) => position?.side === candidate?.side).length;

  if (sameSideOpen >= Math.max(1, Number(maxSameSideOpen) || 1)) blockers.push("same_side_limit");
  if (totalOpenRisk + riskPerTrade > Math.max(0, Number(maxPortfolioRiskPercent) || 0) + 1e-8) {
    blockers.push("portfolio_risk_limit");
  }
  if (totalPositionSize + candidatePositionSize
    > Math.max(0, Number(maxPortfolioPositionSizePercentOfEquity) || 0) + 1e-8) {
    blockers.push("portfolio_position_size_limit");
  }
  return blockers;
}

export function activeRiskGuard(riskGuard = {}, nowMs = Date.now()) {
  const guards = [];
  if (riskGuard.sessionHaltedAt) {
    guards.push({ reason: "session_max_drawdown", resumeAt: null });
  }
  if (riskGuard.consecutiveStopPauseUntil && Date.parse(riskGuard.consecutiveStopPauseUntil) > nowMs) {
    guards.push({ reason: "consecutive_net_loss", resumeAt: riskGuard.consecutiveStopPauseUntil });
  }
  if (riskGuard.dailyLossPauseUntil && Date.parse(riskGuard.dailyLossPauseUntil) > nowMs) {
    guards.push({ reason: "daily_loss_limit", resumeAt: riskGuard.dailyLossPauseUntil });
  }
  if (!guards.length) return null;

  const timed = guards.map((guard) => Date.parse(guard.resumeAt || "")).filter(Number.isFinite);
  return {
    reason: guards.map((guard) => guard.reason).join("+"),
    resumeAt: timed.length ? new Date(Math.max(...timed)).toISOString() : null
  };
}

export function nextUtcDayIso(nowMs = Date.now()) {
  const next = new Date(nowMs);
  next.setUTCHours(24, 0, 0, 0);
  return next.toISOString();
}
