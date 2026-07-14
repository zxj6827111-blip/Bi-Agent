import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("NAS monitor keeps data and bounded file logs on the bind-mounted data directory", async () => {
  const compose = await readFile(join(repoRoot, "docker-compose.nas.yml"), "utf8");

  assert.match(compose, /bi-agent-monitor:[\s\S]*?- \.\/data:\/app\/data/);
  assert.match(compose, /FORMAL_MONITOR_FILE_LOG_ENABLED:\s*"true"/);
  assert.match(compose, /FORMAL_MONITOR_LOG_DIR:\s*\/app\/data\/logs\/formal-monitor/);
  assert.match(compose, /FORMAL_MONITOR_LOG_MAX_BYTES:\s*"10485760"/);
  assert.match(compose, /FORMAL_MONITOR_LOG_MAX_ARCHIVES:\s*"14"/);
  assert.match(compose, /logging:[\s\S]*?driver:\s*json-file[\s\S]*?max-size:\s*"10m"[\s\S]*?max-file:\s*"5"/);
});

test("NAS entrypoint preserves the real monitor Node PID for checkpoint shutdown", async () => {
  const entrypoint = await readFile(join(repoRoot, "deploy", "entrypoint.sh"), "utf8");

  assert.match(entrypoint, /node --import \.\/src\/runtimeFileLogger\.js scripts\/formalSignalPaperMonitor\.js &/);
  assert.match(entrypoint, /MONITOR_PID=\$!/);
  assert.doesNotMatch(entrypoint, /formalSignalPaperMonitor\.js[^\n]*\|\s*tee/);
  assert.match(entrypoint, /kill -TERM "\$MONITOR_PID"/);
});

test("NAS Web server reads the same explicit monitor output directory", async () => {
  const compose = await readFile(join(repoRoot, "docker-compose.nas.yml"), "utf8");
  const serverBlock = compose.split("bi-agent-server:")[1] || "";

  assert.match(serverBlock, /FORMAL_MONITOR_OUTPUT_DIR:\s*\/app\/data\/formal-signal-monitor/);
  assert.match(serverBlock, /- \.\/data:\/app\/data/);
});
