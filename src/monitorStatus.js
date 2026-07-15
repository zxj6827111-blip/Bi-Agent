import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { activeRiskGuard } from "./portfolioRisk.js";

const DATA_SOURCE_CATEGORIES = ["timeout", "dns", "restricted", "other"];

export function buildMonitorStatus(data = {}, { nowMs = Date.now() } = {}) {
  const riskGuard = activeRiskGuard(data.riskGuard || {}, nowMs);
  const operationalGuard = data.entryGuard?.entryBlocked ? data.entryGuard : null;
  const entryReasons = [
    operationalGuard?.reason,
    riskGuard?.reason
  ].filter(Boolean);
  return {
    available: true,
    startedAt: data.startedAt || null,
    finishedAt: data.finishedAt || null,
    status: data.status || "unknown",
    scanCount: data.scanCount || 0,
    entryState: entryReasons.length
      ? {
          mode: "observe_only",
          reason: [...new Set(entryReasons.flatMap((reason) => String(reason).split("+")))].join("+"),
          resumeAt: operationalGuard ? null : riskGuard?.resumeAt || null
        }
      : { mode: "active", reason: null, resumeAt: null },
    dataSource: summarizeMonitorDataSource(data, { nowMs }),
    positions: (data.positions || []).map((position) => ({
      symbol: position.symbol,
      side: position.side,
      entryPrice: position.entryPrice,
      stopLoss: position.stopLoss,
      takeProfit: position.takeProfit,
      openedAt: position.openedAt,
      tradeStyle: position.tradeStyle,
      unrealizedPercent: position.unrealizedPercent ?? null
    })),
    trades: (data.trades || []).slice(-30).map((trade) => ({
      id: trade.id,
      symbol: trade.symbol,
      side: trade.side,
      status: trade.status,
      entryPrice: trade.entryPrice,
      exitPrice: trade.exitPrice,
      netReturnPercent: trade.netReturnPercent ?? trade.estimatedNetReturnPercent ?? trade.grossReturnPercent ?? null,
      grossReturnPercent: trade.grossReturnPercent ?? null,
      openedAt: trade.openedAt,
      closedAt: trade.closedAt,
      secondsHeld: trade.secondsHeld,
      outcome: trade.outcome,
      isPartialClose: Boolean(trade.isPartialClose),
      parentTradeId: trade.parentTradeId ?? null,
      positionSizePercentOfEquity: trade.positionSizePercentOfEquity ?? null
    })),
    summary: data.summary || null,
    errors: (data.errors || []).slice(-10)
  };
}

export function buildMonitorSessionSummary(file, data = {}) {
  const trades = Array.isArray(data.trades) ? data.trades : [];
  const summaryTradeCount = Number(data.summary?.trades);
  const summaryClosedTradeCount = Number(data.summary?.closed);
  const summaryPartialCloseCount = Number(data.summary?.partialCloses);
  return {
    file,
    startedAt: data.startedAt,
    finishedAt: data.finishedAt,
    status: data.status,
    scanCount: data.scanCount,
    tradeCount: Number.isFinite(summaryTradeCount)
      ? summaryTradeCount
      : trades.filter((trade) => !trade?.isPartialClose).length,
    closedTradeCount: Number.isFinite(summaryClosedTradeCount)
      ? summaryClosedTradeCount
      : trades.filter((trade) => trade?.status === "closed" && !trade?.isPartialClose).length,
    partialCloseCount: Number.isFinite(summaryPartialCloseCount)
      ? summaryPartialCloseCount
      : trades.filter((trade) => trade?.isPartialClose).length,
    summary: data.summary || null
  };
}

export function summarizeMonitorDataSource(data = {}, { nowMs = Date.now() } = {}) {
  const structuredHealth = data.dataSourceHealth?.binance ?? data.binanceHealth;
  if (structuredHealth && typeof structuredHealth === "object") {
    return summarizeStructuredHealth(
      structuredHealth,
      data.dataSourceHealth?.updatedAt || structuredHealth.updatedAt || null,
      nowMs
    );
  }

  const errors = (Array.isArray(data.errors) ? data.errors : [])
    .filter(isDataSourceError)
    .filter((error) => {
      const atMs = Date.parse(error?.at || "");
      return !Number.isFinite(atMs) || nowMs - atMs <= 30 * 60_000;
    })
    .slice(-10);
  const counts = emptyCategoryCounts();
  let updatedAt = null;
  for (const error of errors) {
    counts[classifyDataSourceError(error)] += 1;
    if (error?.at) updatedAt = error.at;
  }
  return {
    status: errors.length ? "degraded" : "healthy",
    basis: "recent_errors",
    categories: DATA_SOURCE_CATEGORIES.filter((category) => counts[category] > 0),
    counts,
    updatedAt
  };
}

export function classifyDataSourceError(error = {}) {
  const text = [error.kind, error.cause, error.message, error.statusCode, error.status]
    .filter((value) => value !== undefined && value !== null)
    .join(" ")
    .toLowerCase();
  if (/\b451\b|restricted|unavailable for legal reasons/.test(text)) return "restricted";
  if (/eai_again|enotfound|dns|name resolution|getaddrinfo/.test(text)) return "dns";
  if (/timeout|timedout|aborterror|etimedout/.test(text)) return "timeout";
  return "other";
}

export async function buildMonitorDiagnostics(outputDir) {
  const containerOutputDir = resolve(outputDir);
  const latest = await inspectMonitorFile(join(containerOutputDir, "latest.json"));
  const runtime = await inspectMonitorFile(join(containerOutputDir, "runtime.json"));
  return {
    generatedAt: new Date().toISOString(),
    containerOutputDir,
    latest,
    runtime,
    sameContent: latest.exists && runtime.exists && latest.sha256 === runtime.sha256
  };
}

function isDataSourceError(error = {}) {
  const text = `${error.scope || ""} ${error.message || ""} ${error.cause || ""}`;
  return /binance|timeout|timedout|eai_again|enotfound|dns|getaddrinfo|fetch failed|socket|\b451\b|legal reasons/i.test(text);
}

async function inspectMonitorFile(containerPath) {
  try {
    const [sha256, fileStat] = await Promise.all([hashFile(containerPath), stat(containerPath)]);
    return {
      exists: true,
      containerPath,
      sizeBytes: fileStat.size,
      modifiedAt: fileStat.mtime.toISOString(),
      sha256
    };
  } catch {
    return {
      exists: false,
      containerPath,
      sizeBytes: null,
      modifiedAt: null,
      sha256: null
    };
  }
}

function hashFile(filePath) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolveHash(hash.digest("hex")));
  });
}

function summarizeStructuredHealth(health, updatedAt, nowMs) {
  const counts = normalizeProvidedCounts(health.counts);
  const healthNodes = [health.spot, health.futures].filter((item) => item && typeof item === "object");
  const nodes = healthNodes.length ? healthNodes : [health];
  const statuses = healthNodes.length
    ? healthNodes.map((item) => String(item.status || "unknown").toLowerCase())
    : [String(health.status || "unknown").toLowerCase()];

  for (const node of nodes) {
    const fallbackAtMs = Date.parse(node.lastFallbackAt || "");
    const hasRecentFallback = Number.isFinite(fallbackAtMs) && nowMs - fallbackAtMs <= 30 * 60_000;
    if (hasRecentFallback) {
      statuses.push("degraded");
      const fallbackErrors = Array.isArray(node.lastFallbackErrors) ? node.lastFallbackErrors : [];
      if (fallbackErrors.length) {
        for (const error of fallbackErrors) counts[classifyDataSourceError(error)] += 1;
      } else {
        counts[classifyDataSourceError(node.lastError || node)] += 1;
      }
      continue;
    }

    const status = String(node.status || "unknown").toLowerCase();
    if (["ok", "healthy", "unknown", "idle"].includes(status) && !node.errorKind) continue;
    counts[classifyDataSourceError(node.lastError || node)] += 1;
  }

  const categories = DATA_SOURCE_CATEGORIES.filter((category) => counts[category] > 0);
  let status = "unknown";
  if (statuses.some((value) => ["degraded", "unavailable", "error", "failed"].includes(value)) || categories.length) {
    status = "degraded";
  } else if (statuses.some((value) => ["ok", "healthy"].includes(value))) {
    status = "healthy";
  }

  return { status, basis: "health", categories, counts, updatedAt };
}

function normalizeProvidedCounts(provided) {
  const counts = emptyCategoryCounts();
  if (!provided || typeof provided !== "object") return counts;
  for (const category of DATA_SOURCE_CATEGORIES) {
    const value = Number(provided[category]);
    counts[category] = Number.isFinite(value) && value > 0 ? value : 0;
  }
  return counts;
}

function emptyCategoryCounts() {
  return { timeout: 0, dns: 0, restricted: 0, other: 0 };
}
