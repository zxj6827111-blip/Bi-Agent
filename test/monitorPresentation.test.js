import test from "node:test";
import assert from "node:assert/strict";
import {
  monitorAccountReturn,
  presentDataSource,
  presentEntryState,
  presentMonitorTrade
} from "../public/monitorPresentation.js";

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
    trailing_stop: "追踪止损",
    breakeven_stop: "保本止损",
    scalp_timeout: "超短线超时",
    timeout: "持仓超时"
  };
  for (const [outcome, outcomeLabel] of Object.entries(expected)) {
    assert.equal(presentMonitorTrade({ status: "closed", outcome }).outcomeLabel, outcomeLabel);
  }
});

test("monitor return prefers simulated account impact over summed trade returns", () => {
  assert.equal(monitorAccountReturn({
    portfolioRisk: { totalAccountReturnPercent: -0.8904 },
    totalEstimatedNetReturnPercent: -4.2439
  }), -0.8904);
  assert.equal(monitorAccountReturn({ totalEstimatedNetReturnPercent: -4.2439 }), -4.2439);
  assert.equal(monitorAccountReturn({}), null);
});

test("entry state explains timed pauses and session-level halts", () => {
  assert.deepEqual(presentEntryState({ mode: "active" }), {
    modeLabel: "ACTIVE",
    detail: "允许新开仓",
    tone: "active"
  });
  assert.match(
    presentEntryState({ mode: "observe_only", reason: "consecutive_net_loss", resumeAt: "later" }).detail,
    /连续净亏损保护，等待恢复/
  );
  assert.match(
    presentEntryState({ mode: "observe_only", reason: "session_max_drawdown", resumeAt: null }).detail,
    /本 Session 不再开仓/
  );
  assert.match(
    presentEntryState({ mode: "observe_only", reason: "manual_observe_only+derivatives_unavailable", resumeAt: null }).detail,
    /人工观察模式、合约衍生数据不可用/
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
