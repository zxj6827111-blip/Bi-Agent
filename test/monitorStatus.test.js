import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildMonitorDiagnostics,
  buildMonitorSessionSummary,
  buildMonitorStatus,
  summarizeMonitorDataSource
} from "../src/monitorStatus.js";

test("monitor status exposes entry guard, execution fields, and sanitized structured health", () => {
  const nowMs = Date.parse("2026-07-14T15:00:00.000Z");
  const status = buildMonitorStatus({
    status: "running",
    riskGuard: { consecutiveStopPauseUntil: "2026-07-14T16:00:00.000Z" },
    positions: [],
    trades: [{
      id: "ZECUSDT:long:1:partial",
      symbol: "ZECUSDT",
      side: "long",
      status: "closed",
      isPartialClose: true,
      parentTradeId: "ZECUSDT:long:1",
      outcome: "health_reduce",
      positionSizePercentOfEquity: 4,
      estimatedNetReturnPercent: 0.5
    }],
    dataSourceHealth: {
      updatedAt: "2026-07-14T14:58:00.000Z",
      binance: {
        spot: { status: "unknown" },
        futures: {
          status: "ok",
          activeEndpoint: "https://should-not-leak.example",
          lastFallbackAt: "2026-07-14T14:55:00.000Z",
          lastFallbackErrors: [
            { kind: "timeout" },
            { kind: "dns" },
            { kind: "restricted", statusCode: 451 },
            { kind: "http", statusCode: 503 },
            { kind: "network" }
          ]
        }
      }
    },
    errors: [{ message: "legacy error must not override structured health" }]
  }, { nowMs });

  assert.equal(status.available, true);
  assert.deepEqual(status.positions, []);
  assert.deepEqual(status.entryState, {
    mode: "observe_only",
    reason: "consecutive_net_loss",
    resumeAt: "2026-07-14T16:00:00.000Z"
  });
  assert.deepEqual(status.trades[0], {
    id: "ZECUSDT:long:1:partial",
    symbol: "ZECUSDT",
    side: "long",
    status: "closed",
    entryPrice: undefined,
    exitPrice: undefined,
    netReturnPercent: 0.5,
    grossReturnPercent: null,
    openedAt: undefined,
    closedAt: undefined,
    secondsHeld: undefined,
    outcome: "health_reduce",
    isPartialClose: true,
    parentTradeId: "ZECUSDT:long:1",
    positionSizePercentOfEquity: 4
  });
  assert.equal(status.dataSource.status, "degraded");
  assert.deepEqual(status.dataSource.categories, ["timeout", "dns", "restricted", "other"]);
  assert.deepEqual(status.dataSource.counts, { timeout: 1, dns: 1, restricted: 1, other: 2 });
  assert.doesNotMatch(JSON.stringify(status.dataSource), /should-not-leak/);
});

test("monitor status exposes operational observe-only reasons", () => {
  const status = buildMonitorStatus({
    entryGuard: {
      entryBlocked: true,
      reason: "manual_observe_only+derivatives_unavailable"
    }
  });

  assert.deepEqual(status.entryState, {
    mode: "observe_only",
    reason: "manual_observe_only+derivatives_unavailable",
    resumeAt: null
  });
});

test("structured health returns to healthy after the fallback window expires", () => {
  const summary = summarizeMonitorDataSource({
    binanceHealth: {
      futures: {
        status: "ok",
        lastFallbackAt: "2026-07-14T13:00:00.000Z",
        lastFallbackErrors: [{ kind: "timeout" }]
      }
    }
  }, { nowMs: Date.parse("2026-07-14T15:00:00.000Z") });

  assert.equal(summary.status, "healthy");
  assert.deepEqual(summary.categories, []);
});

test("legacy monitor errors are classified without requiring health fields", () => {
  const summary = summarizeMonitorDataSource({
    errors: [
      { message: "timeout after 8000ms" },
      { message: "getaddrinfo EAI_AGAIN" },
      { message: "HTTP 451 Unavailable For Legal Reasons" },
      { message: "socket closed" }
    ]
  });

  assert.equal(summary.status, "degraded");
  assert.deepEqual(summary.counts, { timeout: 1, dns: 1, restricted: 1, other: 1 });
});

test("session list counts primary trades separately from partial closes", () => {
  const fromSummary = buildMonitorSessionSummary("session-2026-07-14.json", {
    trades: [{ id: "main" }, { id: "partial", isPartialClose: true }],
    summary: { trades: 1, partialCloses: 1 }
  });
  assert.equal(fromSummary.tradeCount, 1);
  assert.equal(fromSummary.closedTradeCount, 0);
  assert.equal(fromSummary.partialCloseCount, 1);

  const legacy = buildMonitorSessionSummary("legacy.json", {
    trades: [{ id: "main" }, { id: "partial", isPartialClose: true }]
  });
  assert.equal(legacy.tradeCount, 1);
  assert.equal(legacy.closedTradeCount, 0);
  assert.equal(legacy.partialCloseCount, 1);
});

test("legacy source summary ignores stale and unrelated monitor errors", () => {
  const summary = summarizeMonitorDataSource({
    errors: [
      { at: "2026-07-14T12:00:00.000Z", scope: "scan", message: "Binance timeout after 8000ms" },
      { at: "2026-07-14T14:59:00.000Z", scope: "ai", message: "OPENAI_API_KEY is not configured" }
    ]
  }, { nowMs: Date.parse("2026-07-14T15:00:00.000Z") });

  assert.equal(summary.status, "healthy");
  assert.deepEqual(summary.categories, []);
});

test("monitor diagnostics returns only file metadata and hashes on demand", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bi-agent-monitor-status-"));
  try {
    await writeFile(join(directory, "latest.json"), "{\"positions\":[]}", "utf8");
    await writeFile(join(directory, "runtime.json"), "{\"positions\":[]}", "utf8");
    const diagnostics = await buildMonitorDiagnostics(directory);

    assert.deepEqual(Object.keys(diagnostics).sort(), [
      "containerOutputDir", "generatedAt", "latest", "runtime", "sameContent"
    ]);
    assert.deepEqual(Object.keys(diagnostics.latest).sort(), [
      "containerPath", "exists", "modifiedAt", "sha256", "sizeBytes"
    ]);
    assert.equal(diagnostics.sameContent, true);
    assert.equal(diagnostics.latest.sha256, diagnostics.runtime.sha256);
    assert.equal(diagnostics.latest.sizeBytes, 16);
    assert.equal("content" in diagnostics.latest, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
