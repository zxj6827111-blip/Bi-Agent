import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { config } from "./config.js";
import { getRuntimeState, refreshEvaluationsForSession, runScan, stopScan } from "./scanner.js";
import { getWatchStatus, refreshWatch, startWatch, stopWatch } from "./watcher.js";
import { buildMonitorDiagnostics, buildMonitorSessionSummary, buildMonitorStatus } from "./monitorStatus.js";
import {
  getScanSession,
  listPaperTrades,
  listScanSessions,
  listSignalEvaluations,
  summarizePaperTrades,
  summarizeSignalEvaluations
} from "./store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, "..", "public");
const dataDir = join(__dirname, "..", "data");
const monitorOutputDir = process.env.FORMAL_MONITOR_OUTPUT_DIR || join(dataDir, "formal-signal-monitor");
const radarOutputDir = process.env.PUMP_RADAR_OUTPUT_DIR || join(dataDir, "pump-radar");

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (url.pathname === "/api/status" && req.method === "GET") {
      return sendJson(res, { ok: true, state: getRuntimeState() });
    }

    if (url.pathname === "/api/scan/start" && req.method === "POST") {
      const session = await runScan({ mode: "manual" });
      return sendJson(res, { ok: true, session, state: getRuntimeState() });
    }

    if (url.pathname === "/api/scan/stop" && req.method === "POST") {
      const state = stopScan();
      return sendJson(res, { ok: true, state });
    }

    if (url.pathname === "/api/sessions" && req.method === "GET") {
      const limit = Number(url.searchParams.get("limit") || 20);
      return sendJson(res, { ok: true, sessions: listScanSessions(limit) });
    }

    if (url.pathname === "/api/evaluations" && req.method === "GET") {
      const limit = Number(url.searchParams.get("limit") || 200);
      const sessionId = url.searchParams.get("sessionId");
      return sendJson(res, {
        ok: true,
        summary: summarizeSignalEvaluations({ limit }),
        evaluations: listSignalEvaluations({ sessionId, limit })
      });
    }

    if (url.pathname === "/api/paper-trades" && req.method === "GET") {
      const limit = Number(url.searchParams.get("limit") || 200);
      return sendJson(res, {
        ok: true,
        summary: summarizePaperTrades({ limit }),
        trades: listPaperTrades({ limit })
      });
    }

    if (url.pathname === "/api/evaluations/refresh" && req.method === "POST") {
      const limit = Number(url.searchParams.get("limit") || 5);
      const sessions = listScanSessions(Math.max(1, Math.min(limit, 20)));
      const evaluations = [];
      for (const session of sessions) {
        evaluations.push(...await refreshEvaluationsForSession(session));
      }
      return sendJson(res, {
        ok: true,
        refreshed: evaluations.length,
        summary: summarizeSignalEvaluations({ limit: 500 })
      });
    }

    if (url.pathname === "/api/watch/status" && req.method === "GET") {
      return sendJson(res, { ok: true, watcher: getWatchStatus() });
    }

    if (url.pathname === "/api/watch/start" && req.method === "POST") {
      const body = await readJsonBody(req);
      const watcher = await startWatch(body);
      return sendJson(res, { ok: true, watcher });
    }

    if (url.pathname === "/api/watch/stop" && req.method === "POST") {
      const watcher = stopWatch();
      return sendJson(res, { ok: true, watcher });
    }

    if (url.pathname === "/api/watch/refresh" && req.method === "POST") {
      const watcher = await refreshWatch();
      return sendJson(res, { ok: true, watcher });
    }

    if (url.pathname.startsWith("/api/sessions/") && req.method === "GET") {
      const id = decodeURIComponent(url.pathname.replace("/api/sessions/", ""));
      const session = getScanSession(id);
      if (!session) return sendJson(res, { ok: false, error: "Session not found" }, 404);
      return sendJson(res, { ok: true, session });
    }

    if (url.pathname === "/api/monitor/status" && req.method === "GET") {
      return sendJson(res, { ok: true, monitor: await getMonitorStatus() });
    }

    if (url.pathname === "/api/monitor/diagnostics" && req.method === "GET") {
      return sendJson(res, { ok: true, diagnostics: await buildMonitorDiagnostics(monitorOutputDir) });
    }

    if (url.pathname === "/api/monitor/sessions" && req.method === "GET") {
      const limit = Number(url.searchParams.get("limit") || 10);
      return sendJson(res, { ok: true, sessions: await listMonitorSessions(limit) });
    }

    if (url.pathname.startsWith("/api/monitor/sessions/") && req.method === "GET") {
      const file = decodeURIComponent(url.pathname.replace("/api/monitor/sessions/", ""));
      const session = await getMonitorSession(file);
      if (!session) return sendJson(res, { ok: false, error: "Monitor session not found" }, 404);
      return sendJson(res, { ok: true, session });
    }

    if (url.pathname === "/api/radar/status" && req.method === "GET") {
      return sendJson(res, { ok: true, radar: await getRadarStatus() });
    }

    if (url.pathname.startsWith("/api/")) {
      return sendJson(res, { ok: false, error: "Not found" }, 404);
    }

    return serveStatic(url.pathname, res);
  } catch (error) {
    return sendJson(res, { ok: false, error: error.message }, error.statusCode || 500);
  }
});

server.listen(config.port, config.host, () => {
  console.log(`Bi-Agent is running at http://${config.host}:${config.port}`);
});

async function serveStatic(pathname, res) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const safePath = normalize(decodeURIComponent(requested)).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(publicDir, safePath);

  if (!filePath.startsWith(publicDir)) {
    return sendJson(res, { ok: false, error: "Forbidden" }, 403);
  }

  try {
    const content = await readFile(filePath);
    res.writeHead(200, {
      "content-type": mime[extname(filePath)] || "application/octet-stream",
      "cache-control": "no-store"
    });
    res.end(content);
  } catch {
    const content = await readFile(join(publicDir, "index.html"));
    res.writeHead(200, { "content-type": mime[".html"], "cache-control": "no-store" });
    res.end(content);
  }
}

function sendJson(res, payload, status = 200) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) chunks.push(chunk);
  for (const chunk of chunks) {
    size += chunk.length;
    if (size > 64 * 1024) {
      const error = new Error("Request body too large");
      error.statusCode = 413;
      throw error;
    }
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Invalid JSON body");
    error.statusCode = 400;
    throw error;
  }
}

// ---- Monitor helpers ----

async function getMonitorStatus() {
  const latestPath = join(monitorOutputDir, "latest.json");
  if (!existsSync(latestPath)) {
    return { available: false, message: "Monitor data not found" };
  }
  try {
    const raw = await readFile(latestPath, "utf8");
    const data = JSON.parse(raw);
    return buildMonitorStatus(data);
  } catch {
    return { available: false, message: "Failed to read monitor data" };
  }
}

async function listMonitorSessions(limit = 10) {
  if (!existsSync(monitorOutputDir)) return [];
  try {
    const files = await readdir(monitorOutputDir);
    const jsonFiles = files
      .filter((f) => f.endsWith(".json") && f !== "latest.json" && f !== "runtime.json")
      .sort()
      .reverse()
      .slice(0, limit);
    const sessions = [];
    for (const file of jsonFiles) {
      try {
        const raw = await readFile(join(monitorOutputDir, file), "utf8");
        const data = JSON.parse(raw);
        sessions.push(buildMonitorSessionSummary(file, data));
      } catch {
        // skip corrupt files
      }
    }
    return sessions;
  } catch {
    return [];
  }
}

async function getMonitorSession(file) {
  // Accept the new natural-day files and the legacy timestamped session files, but never arbitrary paths.
  if (!/^(?:session-\d{4}-\d{2}-\d{2}|\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.json$/.test(file)) return null;
  const path = join(monitorOutputDir, file);
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function getRadarStatus() {
  const latestPath = join(radarOutputDir, "latest.json");
  if (!existsSync(latestPath)) {
    return { available: false, message: "Pump radar data not found" };
  }
  try {
    const data = JSON.parse(await readFile(latestPath, "utf8"));
    const updatedAtMs = Date.parse(data.updatedAt || "");
    return {
      available: true,
      stale: !Number.isFinite(updatedAtMs) || Date.now() - updatedAtMs > 90_000,
      mode: data.mode || "unknown",
      status: data.status || "unknown",
      startedAt: data.startedAt || null,
      updatedAt: data.updatedAt || null,
      finishedAt: data.finishedAt || null,
      policy: data.policy || null,
      health: data.health || null,
      metrics: data.metrics || null,
      universe: {
        totalPerpetualUsdt: data.universe?.totalPerpetualUsdt || 0,
        streamDiscoveredSymbols: data.universe?.streamDiscoveredSymbols || 0,
        liquidSymbols: data.universe?.liquidSymbols || 0,
        metadataSource: data.universe?.metadataSource || null,
        lastMetadataRefreshAt: data.universe?.lastMetadataRefreshAt || null,
        lastCandidateRefreshAt: data.universe?.lastCandidateRefreshAt || null
      },
      candidates: (data.candidates || []).slice(0, 20),
      positions: (data.positions || []).slice(0, 20),
      trades: (data.trades || []).slice(-50),
      summary: data.summary || null,
      recentEvents: (data.recentEvents || []).slice(-30),
      errors: (data.errors || []).slice(-10)
    };
  } catch (error) {
    return { available: false, message: "Failed to read pump radar data", error: error.message };
  }
}
