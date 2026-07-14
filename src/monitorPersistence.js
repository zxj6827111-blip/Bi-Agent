import { renameSync, writeFileSync } from "node:fs";

export function sessionDateKey(date = new Date(), timeZone = "Asia/Shanghai") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function sessionFileName(dateKey) {
  return `session-${dateKey}.json`;
}

export function nextSessionDayIso(nowMs = Date.now(), timeZone = "Asia/Shanghai") {
  const currentKey = sessionDateKey(new Date(nowMs), timeZone);
  let low = Math.floor(nowMs);
  let high = low + 36 * 60 * 60 * 1000;
  if (sessionDateKey(new Date(high), timeZone) === currentKey) {
    throw new RangeError(`Unable to find next session boundary for ${timeZone}`);
  }

  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (sessionDateKey(new Date(middle), timeZone) === currentKey) low = middle;
    else high = middle;
  }
  return new Date(high).toISOString();
}

export function atomicWriteJson(path, value) {
  const tempPath = `${path}.tmp`;
  writeFileSync(tempPath, JSON.stringify(value, null, 2), "utf8");
  renameSync(tempPath, path);
}
