import test from "node:test";
import assert from "node:assert/strict";
import { CrossVenueClient } from "../src/marketData/crossVenueClient.js";

test("CrossVenueClient confirms direction without replacing the Binance execution price", async () => {
  let round = 0;
  const fetchFn = async (url) => {
    const isGate = String(url).includes("gateio");
    const base = isGate ? 10 : 10.02;
    const price = base * (round ? 1.002 : 1);
    const body = isGate
      ? [{ last: String(price), change_percentage: "5" }]
      : { code: "00000", data: [{ lastPr: String(price), change24h: "0.05" }] };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  const client = new CrossVenueClient({ fetchFn, minMovePercent: 0.1 });

  await client.prime("LABUSDT", 1_000);
  round = 1;
  const confirmation = await client.confirm("LABUSDT", { binancePrice: 10.1, now: 5_000 });

  assert.equal(confirmation.availableCount, 2);
  assert.equal(confirmation.confirmedCount, 2);
  assert.ok(confirmation.sources.every((source) => source.price !== 10.1));
});
