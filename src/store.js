import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";
import { netResultPercent, resultPercent as calculateResultPercent, summarizePerformance } from "./tradeMetrics.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "..", "data", "bi-agent.sqlite");

mkdirSync(dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS scan_sessions (
    id TEXT PRIMARY KEY,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    mode TEXT NOT NULL,
    status TEXT NOT NULL,
    summary_json TEXT NOT NULL,
    signals_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS signal_evaluations (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    signal_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    market_type TEXT NOT NULL,
    direction TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    horizon_hours INTEGER NOT NULL,
    status TEXT NOT NULL,
    outcome TEXT NOT NULL,
    entry_touched INTEGER NOT NULL,
    entry_time TEXT,
    exit_time TEXT,
    exit_price REAL,
    max_favorable_percent REAL,
    max_adverse_percent REAL,
    result_percent REAL,
    gross_result_percent REAL,
    net_result_percent REAL,
    fee_percent REAL,
    slippage_percent REAL,
    details_json TEXT NOT NULL,
    evaluated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS paper_trades (
    id TEXT PRIMARY KEY,
    symbol TEXT NOT NULL,
    market_type TEXT NOT NULL,
    direction TEXT NOT NULL,
    action TEXT,
    status TEXT NOT NULL,
    signaled_at TEXT NOT NULL,
    entry_touched_at TEXT,
    closed_at TEXT,
    entry_price REAL,
    close_price REAL,
    close_reason TEXT,
    close_label TEXT,
    entry_range_json TEXT NOT NULL,
    stop_loss REAL,
    take_profit_json TEXT NOT NULL,
    score REAL,
    timeframe TEXT,
    risk_reward REAL,
    gross_result_percent REAL,
    net_result_percent REAL,
    fee_percent REAL,
    slippage_percent REAL,
    details_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

ensureColumn("signal_evaluations", "gross_result_percent", "REAL");
ensureColumn("signal_evaluations", "net_result_percent", "REAL");
ensureColumn("signal_evaluations", "fee_percent", "REAL");
ensureColumn("signal_evaluations", "slippage_percent", "REAL");

export function saveScanSession(session) {
  const statement = db.prepare(`
    INSERT OR REPLACE INTO scan_sessions
      (id, start_time, end_time, mode, status, summary_json, signals_json, created_at)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  statement.run(
    session.id,
    session.startTime,
    session.endTime,
    session.mode,
    session.status,
    JSON.stringify(session.summary),
    JSON.stringify(session.signals),
    new Date().toISOString()
  );
}

export function listScanSessions(limit = 20) {
  const statement = db.prepare(`
    SELECT id, start_time, end_time, mode, status, summary_json, signals_json, created_at
    FROM scan_sessions
    ORDER BY created_at DESC
    LIMIT ?
  `);

  return statement.all(limit).map(rowToSession);
}

export function getScanSession(id) {
  const statement = db.prepare(`
    SELECT id, start_time, end_time, mode, status, summary_json, signals_json, created_at
    FROM scan_sessions
    WHERE id = ?
  `);
  const row = statement.get(id);
  return row ? rowToSession(row) : null;
}

export function saveSignalEvaluations(sessionId, evaluations) {
  if (!evaluations.length) return;
  const statement = db.prepare(`
    INSERT OR REPLACE INTO signal_evaluations
      (
        id, session_id, signal_id, symbol, market_type, direction, timeframe, horizon_hours,
        status, outcome, entry_touched, entry_time, exit_time, exit_price,
        max_favorable_percent, max_adverse_percent, result_percent,
        gross_result_percent, net_result_percent, fee_percent, slippage_percent,
        details_json, evaluated_at
      )
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const evaluatedAt = new Date().toISOString();
  for (const item of evaluations) {
    statement.run(
      item.id,
      sessionId,
      item.signalId,
      item.symbol,
      item.marketType,
      item.direction,
      item.timeframe,
      item.horizonHours,
      item.status,
      item.outcome,
      item.entryTouched ? 1 : 0,
      item.entryTime,
      item.exitTime,
      item.exitPrice,
      item.maxFavorablePercent,
      item.maxAdversePercent,
      item.resultPercent,
      item.grossResultPercent ?? item.resultPercent,
      item.netResultPercent ?? item.resultPercent,
      item.feePercent ?? 0,
      item.slippagePercent ?? 0,
      JSON.stringify(item.details || {}),
      evaluatedAt
    );
  }
}

export function upsertPaperTradeFromPosition(position, { marketType = "spot", details = {} } = {}) {
  if (!position?.symbol || !position?.direction || !position?.signaledAt) return null;
  const id = position.id || `${position.symbol}:${position.direction}:${position.signaledAt}`;
  const metrics = paperTradeMetrics({ ...position, marketType });
  const statement = db.prepare(`
    INSERT OR REPLACE INTO paper_trades
      (
        id, symbol, market_type, direction, action, status, signaled_at, entry_touched_at,
        closed_at, entry_price, close_price, close_reason, close_label, entry_range_json,
        stop_loss, take_profit_json, score, timeframe, risk_reward, gross_result_percent,
        net_result_percent, fee_percent, slippage_percent, details_json, updated_at
      )
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const row = {
    id,
    symbol: position.symbol,
    marketType,
    direction: position.direction,
    action: position.action || null,
    status: position.status,
    signaledAt: position.signaledAt,
    entryTouchedAt: position.entryTouchedAt || null,
    closedAt: position.closedAt || null,
    entryPrice: position.entryPrice ?? null,
    closePrice: position.closePrice ?? null,
    closeReason: position.closeReason || null,
    closeLabel: position.closeLabel || null,
    entryRange: position.entryRange || null,
    stopLoss: position.stopLoss ?? null,
    takeProfit: position.takeProfit || null,
    score: position.score ?? null,
    timeframe: position.timeframe || null,
    riskReward: position.riskReward ?? null,
    grossResultPercent: metrics.grossResultPercent,
    netResultPercent: metrics.netResultPercent,
    feePercent: metrics.feePercent,
    slippagePercent: metrics.slippagePercent,
    details
  };

  statement.run(
    row.id,
    row.symbol,
    row.marketType,
    row.direction,
    row.action,
    row.status,
    row.signaledAt,
    row.entryTouchedAt,
    row.closedAt,
    row.entryPrice,
    row.closePrice,
    row.closeReason,
    row.closeLabel,
    JSON.stringify(row.entryRange),
    row.stopLoss,
    JSON.stringify(row.takeProfit),
    row.score,
    row.timeframe,
    row.riskReward,
    row.grossResultPercent,
    row.netResultPercent,
    row.feePercent,
    row.slippagePercent,
    JSON.stringify(row.details || {}),
    new Date().toISOString()
  );
  return row;
}

export function listPaperTrades({ limit = 200, status = null } = {}) {
  const rows = status
    ? db.prepare(`
        SELECT *
        FROM paper_trades
        WHERE status = ?
        ORDER BY updated_at DESC
        LIMIT ?
      `).all(status, limit)
    : db.prepare(`
        SELECT *
        FROM paper_trades
        ORDER BY updated_at DESC
        LIMIT ?
      `).all(limit);

  return rows.map(rowToPaperTrade);
}

export function summarizePaperTrades({ limit = 500 } = {}) {
  const rows = listPaperTrades({ limit });
  return summarizeTradeRows(rows);
}

export function listSignalEvaluations({ sessionId = null, limit = 200 } = {}) {
  const rows = sessionId
    ? db.prepare(`
        SELECT *
        FROM signal_evaluations
        WHERE session_id = ?
        ORDER BY evaluated_at DESC
        LIMIT ?
      `).all(sessionId, limit)
    : db.prepare(`
        SELECT *
        FROM signal_evaluations
        ORDER BY evaluated_at DESC
        LIMIT ?
      `).all(limit);

  return rows.map(rowToSignalEvaluation);
}

export function summarizeSignalEvaluations({ limit = 500 } = {}) {
  const rows = listSignalEvaluations({ limit });
  return summarizeEvaluationRows(rows);
}

export function summarizeEvaluationRows(rows) {
  const completed = rows.filter((item) => item.status === "completed");
  const pending = rows.filter((item) => item.status !== "completed");
  const byHorizon = summarizeBy(completed, (item) => `${item.horizonHours}h`);
  const byMarketType = summarizeBy(completed, (item) => item.marketType);
  const byDirection = summarizeBy(completed, (item) => item.direction);
  const byTimeframe = summarizeBy(completed, (item) => item.timeframe);
  const bySignalGroup = summarizeBy(completed, (item) => [
    item.marketType,
    item.direction,
    item.timeframe,
    `${item.horizonHours}h`
  ].join(":"));

  return {
    total: rows.length,
    completed: completed.length,
    pending: pending.length,
    performance: summarizePerformance(completed),
    pendingByReason: summarizePendingByReason(pending),
    byHorizon,
    byMarketType,
    byDirection,
    byTimeframe,
    bySignalGroup,
    recent: rows.slice(0, 20)
  };
}

function rowToSession(row) {
  return {
    id: row.id,
    startTime: row.start_time,
    endTime: row.end_time,
    mode: row.mode,
    status: row.status,
    summary: JSON.parse(row.summary_json),
    signals: JSON.parse(row.signals_json),
    createdAt: row.created_at
  };
}

function rowToSignalEvaluation(row) {
  return {
    id: row.id,
    sessionId: row.session_id,
    signalId: row.signal_id,
    symbol: row.symbol,
    marketType: row.market_type,
    direction: row.direction,
    timeframe: row.timeframe,
    horizonHours: row.horizon_hours,
    status: row.status,
    outcome: row.outcome,
    entryTouched: Boolean(row.entry_touched),
    entryTime: row.entry_time,
    exitTime: row.exit_time,
    exitPrice: row.exit_price,
    maxFavorablePercent: row.max_favorable_percent,
    maxAdversePercent: row.max_adverse_percent,
    resultPercent: row.result_percent,
    grossResultPercent: row.gross_result_percent,
    netResultPercent: row.net_result_percent,
    feePercent: row.fee_percent,
    slippagePercent: row.slippage_percent,
    details: JSON.parse(row.details_json),
    evaluatedAt: row.evaluated_at
  };
}

function summarizeBy(items, keyFn) {
  const groups = new Map();
  for (const item of items) {
    const key = keyFn(item);
    const current = groups.get(key) || {
      total: 0,
      tp1: 0,
      tp2: 0,
      stop: 0,
      expired: 0,
      noEntry: 0,
      avgResultPercent: 0,
      avgNetResultPercent: 0,
      items: []
    };
    current.total += 1;
    if (item.outcome === "tp1") current.tp1 += 1;
    else if (item.outcome === "tp2") current.tp2 += 1;
    else if (item.outcome === "stop") current.stop += 1;
    else if (item.outcome === "no_entry") current.noEntry += 1;
    else current.expired += 1;
    current.avgResultPercent += Number(item.resultPercent || 0);
    current.avgNetResultPercent += resultValue(item);
    current.items.push(item);
    groups.set(key, current);
  }

  return Object.fromEntries(
    [...groups.entries()].map(([key, value]) => [
      key,
      {
        total: value.total,
        tp1: value.tp1,
        tp2: value.tp2,
        stop: value.stop,
        expired: value.expired,
        noEntry: value.noEntry,
        winRate: value.total ? (value.tp1 + value.tp2) / value.total : 0,
        entryRate: value.total ? (value.total - value.noEntry) / value.total : 0,
        avgResultPercent: value.total ? value.avgResultPercent / value.total : 0,
        avgNetResultPercent: value.total ? value.avgNetResultPercent / value.total : 0,
        ...summarizePerformance(value.items)
      }
    ])
  );
}

function summarizePendingByReason(items) {
  const groups = new Map();
  for (const item of items) {
    const reason = item.details?.reason || "unknown";
    groups.set(reason, (groups.get(reason) || 0) + 1);
  }
  return Object.fromEntries([...groups.entries()].sort((a, b) => b[1] - a[1]));
}

function ensureColumn(tableName, columnName, definition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  if (columns.some((column) => column.name === columnName)) return;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}

function paperTradeMetrics(position) {
  if (position.status !== "closed") {
    return {
      grossResultPercent: null,
      netResultPercent: null,
      feePercent: null,
      slippagePercent: null
    };
  }

  const gross = calculateResultPercent({
    direction: position.direction,
    entryPrice: position.entryPrice,
    exitPrice: position.closePrice
  });
  const net = netResultPercent({
    grossResultPercent: gross,
    marketType: position.marketType,
    entryTouched: Boolean(position.entryPrice && position.closePrice),
    costs: config.tradingCosts
  });

  return {
    grossResultPercent: net?.grossResultPercent ?? null,
    netResultPercent: net?.netResultPercent ?? null,
    feePercent: net?.feePercent ?? null,
    slippagePercent: net?.slippagePercent ?? null
  };
}

function rowToPaperTrade(row) {
  return {
    id: row.id,
    symbol: row.symbol,
    marketType: row.market_type,
    direction: row.direction,
    action: row.action,
    status: row.status,
    signaledAt: row.signaled_at,
    entryTouchedAt: row.entry_touched_at,
    closedAt: row.closed_at,
    entryPrice: row.entry_price,
    closePrice: row.close_price,
    closeReason: row.close_reason,
    closeLabel: row.close_label,
    entryRange: JSON.parse(row.entry_range_json || "null"),
    stopLoss: row.stop_loss,
    takeProfit: JSON.parse(row.take_profit_json || "null"),
    score: row.score,
    timeframe: row.timeframe,
    riskReward: row.risk_reward,
    grossResultPercent: row.gross_result_percent,
    netResultPercent: row.net_result_percent,
    feePercent: row.fee_percent,
    slippagePercent: row.slippage_percent,
    details: JSON.parse(row.details_json || "{}"),
    updatedAt: row.updated_at
  };
}

function summarizeTradeRows(rows) {
  const closed = rows.filter((item) => item.status === "closed");
  return {
    total: rows.length,
    waiting: rows.filter((item) => item.status === "waiting_entry").length,
    open: rows.filter((item) => item.status === "open").length,
    closed: closed.length,
    validation: validationStatus(closed),
    performance: summarizePerformance(closed),
    byDirection: summarizeTradesBy(closed, (item) => item.direction),
    recent: rows.slice(0, 20)
  };
}

function summarizeTradesBy(items, keyFn) {
  const groups = new Map();
  for (const item of items) {
    const key = keyFn(item);
    const current = groups.get(key) || {
      total: 0,
      wins: 0,
      losses: 0,
      neutral: 0,
      items: []
    };
    const result = resultValue(item);
    current.total += 1;
    if (result > 0) current.wins += 1;
    else if (result < 0) current.losses += 1;
    else current.neutral += 1;
    current.items.push(item);
    groups.set(key, current);
  }

  return Object.fromEntries(
    [...groups.entries()].map(([key, value]) => [
      key,
      {
        total: value.total,
        wins: value.wins,
        losses: value.losses,
        neutral: value.neutral,
        winRate: value.total ? value.wins / value.total : 0,
        ...summarizePerformance(value.items)
      }
    ])
  );
}

function validationStatus(rows) {
  const performance = summarizePerformance(rows);
  const wins = rows.filter((item) => resultValue(item) > 0).length;
  const winRate = rows.length ? wins / rows.length : 0;
  const passed = rows.length >= config.validation.minCompletedTrades
    && winRate >= config.validation.minWinRate
    && performance.expectancyPercent >= config.validation.minExpectancyPercent
    && performance.maxDrawdownPercent <= config.validation.maxDrawdownPercent;

  return {
    status: passed ? "passed" : "insufficient_or_failed",
    completedTrades: rows.length,
    minCompletedTrades: config.validation.minCompletedTrades,
    winRate,
    minWinRate: config.validation.minWinRate,
    expectancyPercent: performance.expectancyPercent,
    minExpectancyPercent: config.validation.minExpectancyPercent,
    maxDrawdownPercent: performance.maxDrawdownPercent,
    allowedMaxDrawdownPercent: config.validation.maxDrawdownPercent
  };
}

function resultValue(item) {
  const net = item.netResultPercent !== null && item.netResultPercent !== undefined
    ? Number(item.netResultPercent)
    : null;
  if (Number.isFinite(net)) return net;
  return Number(item.resultPercent || 0);
}
