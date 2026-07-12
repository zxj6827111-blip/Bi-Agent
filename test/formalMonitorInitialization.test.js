import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("formal monitor initializes risk guard constants before starting the monitor", async () => {
  const source = await readFile(new URL("../scripts/formalSignalPaperMonitor.js", import.meta.url), "utf8");
  const monitorStart = source.indexOf("await runMonitor();");

  assert.notEqual(monitorStart, -1, "monitor startup statement is missing");
  for (const declaration of [
    "const CONSECUTIVE_STOP_PAUSE_MS",
    "const CONSECUTIVE_STOP_TRIGGER"
  ]) {
    const declarationIndex = source.indexOf(declaration);
    assert.notEqual(declarationIndex, -1, `${declaration} is missing`);
    assert.ok(
      declarationIndex < monitorStart,
      `${declaration} must be initialized before the top-level monitor await`
    );
  }

  assert.match(source, /netReturnPercent:\s*round\(estimatedNet, 4\)/, "closed trades must persist a UI-compatible net return");
  assert.match(source, /installShutdownCheckpoint\(\)/, "monitor must checkpoint when its container stops");
  assert.match(source, /existsSync\(latestPath\)/, "first persistent deployment must recover the legacy latest checkpoint");
});
