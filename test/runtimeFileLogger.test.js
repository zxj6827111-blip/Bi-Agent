import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { createRuntimeFileLogger } from "../src/runtimeFileLogger.js";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("runtime file logger appends timestamped stream lines across restarts", async (t) => {
  const logDir = await mkdtemp(join(tmpdir(), "bi-agent-log-"));
  t.after(() => rm(logDir, { recursive: true, force: true }));

  const first = createRuntimeFileLogger({ logDir, maxBytes: 10_000, maxArchives: 2 });
  first.write("stdout", "first line\n");
  first.flush();

  const second = createRuntimeFileLogger({ logDir, maxBytes: 10_000, maxArchives: 2 });
  second.write("stderr", "second line\n");
  second.flush();

  const content = await readFile(second.logPath, "utf8");
  assert.match(content, /\d{4}-\d{2}-\d{2}T.*\[stdout\] first line/);
  assert.match(content, /\d{4}-\d{2}-\d{2}T.*\[stderr\] second line/);
});

test("runtime file logger rotates within the configured archive bound", async (t) => {
  const logDir = await mkdtemp(join(tmpdir(), "bi-agent-log-"));
  t.after(() => rm(logDir, { recursive: true, force: true }));
  const logger = createRuntimeFileLogger({ logDir, maxBytes: 90, maxArchives: 2 });

  for (let index = 0; index < 8; index += 1) {
    logger.write("stdout", `line-${index}-xxxxxxxxxxxxxxxxxxxxxxxx\n`);
  }
  logger.flush();

  await access(logger.logPath);
  await access(`${logger.logPath}.1`);
  await access(`${logger.logPath}.2`);
  await assert.rejects(access(`${logger.logPath}.3`));
});

test("runtime file logger disables its file copy without throwing when the directory is unavailable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bi-agent-log-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const blockedPath = join(root, "not-a-directory");
  await writeFile(blockedPath, "blocked", "utf8");
  const failures = [];

  const logger = createRuntimeFileLogger({
    logDir: blockedPath,
    onFailure: (error) => failures.push(error)
  });

  assert.equal(logger.isEnabled(), false);
  assert.equal(failures.length, 1);
  assert.doesNotThrow(() => logger.write("stdout", "monitor must continue\n"));
});

test("runtime preloader preserves stdout and stderr while copying both to the persistent file", async (t) => {
  const logDir = await mkdtemp(join(tmpdir(), "bi-agent-log-"));
  t.after(() => rm(logDir, { recursive: true, force: true }));
  const modulePath = pathToFileURL(join(repoRoot, "src", "runtimeFileLogger.js")).href;
  const child = spawn(process.execPath, ["--import", modulePath, "-e", "console.log('visible-out'); console.error('visible-error')"], {
    cwd: repoRoot,
    windowsHide: true,
    env: {
      ...process.env,
      FORMAL_MONITOR_FILE_LOG_ENABLED: "true",
      FORMAL_MONITOR_LOG_DIR: logDir
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });

  assert.equal(exitCode, 0);
  assert.match(Buffer.concat(stdout).toString("utf8"), /visible-out/);
  assert.match(Buffer.concat(stderr).toString("utf8"), /visible-error/);
  const persisted = await readFile(join(logDir, "formal-monitor.log"), "utf8");
  assert.match(persisted, /\[stdout\] visible-out/);
  assert.match(persisted, /\[stderr\] visible-error/);
});
