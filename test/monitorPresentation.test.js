import test from "node:test";
import assert from "node:assert/strict";
import { presentDataSource, presentEntryState, presentMonitorTrade } from "../public/monitorPresentation.js";

test("trade presentation distinguishes partial, final, and open records", () => {
  assert.deepEqual(
    presentMonitorTrade({ status: "closed", isPartialClose: true, outcome: "health_reduce" }),
    { statusLabel: "部分减仓", outcomeLabel: "健康度减仓" }
  );
  assert.deepEqual(
    presentMonitorTrade({ status: "closed", outcome: "signal_collapse" }),
    { statusLabel: "最终平仓", outcomeLabel: "信号衰减" }
  );
  assert.deepEqual(
    presentMonitorTrade({ status: "open" }),
    { statusLabel: "持仓中", outcomeLabel: "-" }
  );
});

test("all supported close outcomes have Chinese labels", () => {
  const expected = {
    tp: "止盈",
    stop: "止损",
    scalp_timeout: "超短线超时",
    timeout: "持仓超时"
  };
  for (const [outcome, outcomeLabel] of Object.entries(expected)) {
    assert.equal(presentMonitorTrade({ status: "closed", outcome }).outcomeLabel, outcomeLabel);
  }
});

test("entry state explains timed pauses and session-level halts", () => {
  assert.deepEqual(presentEntryState({ mode: "active" }), {
    modeLabel: "ACTIVE",
    detail: "允许新开仓",
    tone: "active"
  });
  assert.match(
    presentEntryState({ mode: "observe_only", reason: "consecutive_stop_loss", resumeAt: "later" }).detail,
    /连续止损保护，等待恢复/
  );
  assert.match(
    presentEntryState({ mode: "observe_only", reason: "session_max_drawdown", resumeAt: null }).detail,
    /本 Session 不再开仓/
  );
});

test("data source presentation distinguishes timeout, DNS, 451, and other failures", () => {
  assert.deepEqual(presentDataSource({ status: "healthy" }), {
    label: "Binance 数据正常",
    detail: "数据源健康",
    tone: "healthy"
  });
  const degraded = presentDataSource({
    status: "degraded",
    categories: ["timeout", "dns", "restricted", "other"]
  });
  assert.equal(degraded.label, "Binance 数据降级");
  assert.match(degraded.detail, /请求超时/);
  assert.match(degraded.detail, /DNS 解析失败/);
  assert.match(degraded.detail, /451/);
  assert.match(degraded.detail, /其他请求错误/);
});
