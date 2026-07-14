import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export class PumpRadarEventStore {
  constructor({ outputDir, now = () => Date.now() }) {
    this.outputDir = outputDir;
    this.now = now;
    this.writeQueue = Promise.resolve();
  }

  async initialize() {
    await mkdir(this.outputDir, { recursive: true });
  }

  append(type, payload = {}, timestamp = this.now()) {
    const event = {
      version: 1,
      type,
      timestamp: new Date(timestamp).toISOString(),
      ...payload
    };
    const path = join(this.outputDir, `events-${event.timestamp.slice(0, 10)}.ndjson`);
    this.writeQueue = this.writeQueue
      .catch(() => {})
      .then(() => appendFile(path, `${JSON.stringify(event)}\n`, "utf8"));
    return this.writeQueue.then(() => event);
  }

  writeSnapshot(snapshot) {
    const latestPath = join(this.outputDir, "latest.json");
    const runtimePath = join(this.outputDir, "runtime.json");
    this.writeQueue = this.writeQueue.catch(() => {}).then(async () => {
      await atomicWriteJson(latestPath, snapshot);
      await atomicWriteJson(runtimePath, {
        status: snapshot.status,
        updatedAt: snapshot.updatedAt,
        stream: snapshot.health?.stream || null,
        positions: snapshot.positions?.length || 0
      });
    });
    return this.writeQueue;
  }

  flush() {
    return this.writeQueue;
  }
}

async function atomicWriteJson(path, value) {
  const tempPath = `${path}.${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, path);
}
