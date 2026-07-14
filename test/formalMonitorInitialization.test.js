import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:http";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const monitorScript = join(repoRoot, "scripts", "formalSignalPaperMonitor.js");

test("formal monitor initializes risk guard constants before starting the monitor", async () => {
  const source = await readFile(monitorScript, "utf8");
  const monitorStart = source.indexOf("await runMonitor();");

  assert.notEqual(monitorStart, -1, "monitor startup statement is missing");
  for (const declaration of [
    "const CONSECUTIVE_STOP_PAUSE_MS",
    "const consecutiveStopTrigger"
  ]) {
    const declarationIndex = source.indexOf(declaration);
    assert.notEqual(declarationIndex, -1, `${declaration} is missing`);
    assert.ok(declarationIndex < monitorStart, `${declaration} must be initialized before the top-level monitor await`);
  }

  assert.match(source, /netReturnPercent:\s*round\(estimatedNet, 4\)/, "closed trades must persist a UI-compatible net return");
  assert.match(source, /installShutdownCheckpoint\(\)/, "monitor must checkpoint when its container stops");
  assert.match(source, /existsSync\(latestPath\)/, "first persistent deployment must recover the legacy latest checkpoint");
});

test("formal monitor restores an old checkpoint and applies feedback only once", async (t) => {
  const trades = Array.from({ length: 3 }, (_, index) => ({
    id: `closed-${index}`,
    symbol: "BTCUSDT",
    side: "long",
    status: "closed",
    openedAt: `2026-07-13T00:0${index}:00.000Z`,
    closedAt: `2026-07-13T00:1${index}:00.000Z`,
    outcome: "stop",
    filterFailures: ["edge"],
    grossReturnPercent: -1,
    estimatedNetReturnPercent: -1,
    positionSizePercentOfEquity: 10,
    realizedAccountReturnPercent: -0.1,
    netWin: false
  }));
  const result = await runMonitorWithCheckpoint(t, { positions: [], trades });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /before initialization/);
  assert.equal(result.runtime.options.minEdge, 27);
  assert.equal(result.runtime.feedbackAdjustments.currentOptions.minEdge, 27);
});

test("formal monitor preserves open positions when final close prices are unavailable", async (t) => {
  const position = {
    id: "open-1",
    symbol: "BTCUSDT",
    side: "long",
    status: "open",
    openedAt: "2026-07-13T00:00:00.000Z",
    entryPrice: 100,
    takeProfit: 110,
    stopLoss: 90,
    targetPercent: 10,
    stopPercent: 10,
    positionSizePercentOfEquity: 10,
    accountRiskPercent: 1,
    targetAccountRiskPercent: 1,
    bestPrice: 100,
    worstPrice: 100,
    polls: []
  };
  const result = await runMonitorWithCheckpoint(t, { positions: [position], trades: [position] }, {
    BINANCE_SPOT_BASE_URL: "http://127.0.0.1:1",
    BINANCE_SPOT_BASE_URLS: "http://127.0.0.1:1",
    BINANCE_FUTURES_BASE_URL: "http://127.0.0.1:1",
    BINANCE_FUTURES_BASE_URLS: "http://127.0.0.1:1",
    BINANCE_REQUEST_TIMEOUT_MS: "100"
  });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.runtime.status, "close_failed");
  assert.equal(result.runtime.positions.length, 1);
  assert.ok(result.runtime.errors.some((error) => error.scope === "position_close"));
});

test("formal monitor treats an empty order book as close_failed", async (t) => {
  const baseUrl = await startBinanceStub(t, { bids: [], asks: [] });
  const position = openPositionFixture();
  const result = await runMonitorWithCheckpoint(t, { positions: [position], trades: [position] }, binanceEnv(baseUrl));

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.runtime.status, "close_failed");
  assert.equal(result.runtime.positions.length, 1);
  assert.match(result.runtime.errors.at(-1).message, /No executable close price/);
});

test("formal monitor records a hard stop before an expired-position timeout", async (t) => {
  const baseUrl = await startBinanceStub(t, { bids: [["89", "1"]], asks: [["90", "1"]] });
  const position = {
    ...openPositionFixture(),
    expiresAt: "2026-07-13T00:01:00.000Z"
  };
  const result = await runMonitorWithCheckpoint(t, { positions: [position], trades: [position] }, binanceEnv(baseUrl));

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.runtime.status, "completed");
  assert.equal(result.runtime.positions.length, 0);
  assert.equal(result.runtime.trades.find((trade) => trade.id === position.id).outcome, "stop");
});

async function runMonitorWithCheckpoint(t, checkpoint, extraEnv = {}) {
  const outputDir = await mkdtemp(join(tmpdir(), "bi-agent-monitor-test-"));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  await writeFile(join(outputDir, "runtime.json"), JSON.stringify({
    sessionDate: "2026-07-13",
    positions: checkpoint.positions,
    trades: checkpoint.trades
  }), "utf8");

  const child = spawn(process.execPath, [monitorScript], {
    cwd: repoRoot,
    windowsHide: true,
    env: {
      ...process.env,
      FORMAL_MONITOR_OUTPUT_DIR: outputDir,
      FORMAL_MONITOR_DURATION_SECONDS: "1",
      FORMAL_MONITOR_MAX_TRADES: "0",
      FORMAL_MONITOR_MIN_EDGE: "25",
      FORMAL_MONITOR_AI_ENABLED: "false",
      FORMAL_MONITOR_AI_REQUIRED: "false",
      ...extraEnv
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const exitCode = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("formal monitor child process timed out"));
    }, 15_000);
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
  const runtime = JSON.parse(await readFile(join(outputDir, "runtime.json"), "utf8"));
  return {
    exitCode,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
    runtime
  };
}

function openPositionFixture() {
  return {
    id: "open-1",
    symbol: "BTCUSDT",
    side: "long",
    status: "open",
    openedAt: "2026-07-13T00:00:00.000Z",
    entryPrice: 100,
    takeProfit: 110,
    stopLoss: 90,
    targetPercent: 10,
    stopPercent: 10,
    positionSizePercentOfEquity: 10,
    accountRiskPercent: 1,
    targetAccountRiskPercent: 1,
    bestPrice: 100,
    worstPrice: 100,
    polls: []
  };
}

async function startBinanceStub(t, depth) {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(depth));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

function binanceEnv(baseUrl) {
  return {
    BINANCE_SPOT_BASE_URL: baseUrl,
    BINANCE_SPOT_BASE_URLS: baseUrl,
    BINANCE_FUTURES_BASE_URL: baseUrl,
    BINANCE_FUTURES_BASE_URLS: baseUrl
  };
}
