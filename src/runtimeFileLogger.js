import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync
} from "node:fs";
import { join } from "node:path";

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_ARCHIVES = 14;

export function createRuntimeFileLogger({
  logDir,
  maxBytes = DEFAULT_MAX_BYTES,
  maxArchives = DEFAULT_MAX_ARCHIVES,
  onFailure = () => {}
} = {}) {
  const logPath = join(logDir, "formal-monitor.log");
  const pending = { stdout: "", stderr: "" };
  let enabled = true;
  let warned = false;
  let currentSize = 0;

  try {
    mkdirSync(logDir, { recursive: true });
    currentSize = existsSync(logPath) ? statSync(logPath).size : 0;
  } catch (error) {
    disable(error);
  }

  function write(stream, chunk) {
    if (!enabled) return;
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
    const combined = `${pending[stream] || ""}${text}`;
    const lines = combined.split(/\r?\n/);
    pending[stream] = lines.pop() || "";
    for (const line of lines) appendLine(stream, line);
  }

  function flush() {
    if (!enabled) return;
    for (const stream of ["stdout", "stderr"]) {
      if (!pending[stream]) continue;
      appendLine(stream, pending[stream]);
      pending[stream] = "";
    }
  }

  function appendLine(stream, line) {
    const formatted = `${new Date().toISOString()} [${stream}] ${line}\n`;
    const bytes = Buffer.byteLength(formatted);
    try {
      if (currentSize > 0 && currentSize + bytes > Math.max(1, Number(maxBytes) || DEFAULT_MAX_BYTES)) {
        rotate();
      }
      appendFileSync(logPath, formatted, "utf8");
      currentSize += bytes;
    } catch (error) {
      disable(error);
    }
  }

  function rotate() {
    const keep = Math.max(0, Number.parseInt(maxArchives, 10) || 0);
    if (!existsSync(logPath)) {
      currentSize = 0;
      return;
    }
    if (keep === 0) {
      rmSync(logPath, { force: true });
      currentSize = 0;
      return;
    }
    rmSync(`${logPath}.${keep}`, { force: true });
    for (let index = keep - 1; index >= 1; index -= 1) {
      const source = `${logPath}.${index}`;
      if (!existsSync(source)) continue;
      const destination = `${logPath}.${index + 1}`;
      rmSync(destination, { force: true });
      renameSync(source, destination);
    }
    rmSync(`${logPath}.1`, { force: true });
    renameSync(logPath, `${logPath}.1`);
    currentSize = 0;
  }

  function disable(error) {
    enabled = false;
    if (warned) return;
    warned = true;
    onFailure(error);
  }

  return {
    logPath,
    write,
    flush,
    isEnabled: () => enabled
  };
}

export function installRuntimeFileLogger(env = process.env) {
  if (!readBoolean(env.FORMAL_MONITOR_FILE_LOG_ENABLED)) return null;

  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const logger = createRuntimeFileLogger({
    logDir: env.FORMAL_MONITOR_LOG_DIR || "/app/data/logs/formal-monitor",
    maxBytes: readPositiveInt(env.FORMAL_MONITOR_LOG_MAX_BYTES, DEFAULT_MAX_BYTES),
    maxArchives: readPositiveInt(env.FORMAL_MONITOR_LOG_MAX_ARCHIVES, DEFAULT_MAX_ARCHIVES),
    onFailure: (error) => {
      originalStderrWrite(`[persistent-log] disabled after file error: ${error?.message || error}\n`);
    }
  });

  process.stdout.write = function writeStdout(chunk, encoding, callback) {
    const result = originalStdoutWrite(chunk, encoding, callback);
    logger.write("stdout", chunk);
    return result;
  };
  process.stderr.write = function writeStderr(chunk, encoding, callback) {
    const result = originalStderrWrite(chunk, encoding, callback);
    logger.write("stderr", chunk);
    return result;
  };
  process.once("exit", () => logger.flush());
  return logger;
}

function readBoolean(value) {
  return /^(?:1|true|yes|on)$/i.test(String(value || "").trim());
}

function readPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

installRuntimeFileLogger();
