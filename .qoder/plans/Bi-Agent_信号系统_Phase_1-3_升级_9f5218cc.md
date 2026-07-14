# Bi-Agent 信号系统 Phase 1-3 完整实施方案

---

## Phase 1：修复做空管道 + 参数自适应（本周完成）

### 背景诊断
当前做空候选 10 个全部被拒，根因：
1. `selectSourceSignalForSide("short")` 找不到 actionable 的 sourceSignal（`generateSignalsFromSnapshot` 中 `spot_sell` 阈值 62 太高且 `reviewSignalsForQuality` 总是过滤）
2. `inspectSpotSellRisks` 中 RSI<45 拦截 + 高周期未转弱拦截 直接阻挡所有做空
3. `hasFormalEntryQuality` 要求 actionable sourceSignal 或 strong side consensus，做空两面都不满足
4. `scoreCandidateSide` 做空分支已有 v2 的 regimeBoost（risk_off+short=+10），但被 source_quality 和 timeframe_conflict 覆盖

### 修改清单

#### 1.1 修复 `signalEngine.js` — 做空源信号生成与质量审查

**A. 降低 spot_sell 通过阈值（第 284 行）**
```diff
- if (sellScore >= 62) {
+ if (sellScore >= 54) {
```
理由：与 spot_buy 的 58 保持平衡，做空基础分更低（38 vs 42），阈值对齐后才有公平竞争。

**B. 修正 `scoreSellSetup` 基础分（第 742 行）**
```diff
- let score = 38;
+ let score = 42;
```
理由：与 `scoreLongSetup` 对齐基础起点，消除结构性偏倚。

**C. 修正 `inspectSpotSellRisks` 的 RSI 条件（第 618-619 行）**
```diff
- if (Number.isFinite(rsiValue) && rsiValue < 45) {
-   problems.push(`RSI ${round(rsiValue, 2)} 不够偏弱或偏热，卖出优势不足`);
- }
+ // 移除 RSI<45 硬拦截。risk_off 市场中 RSI 普遍偏低，超卖不代表不能继续跌
+ // 改为：仅当 RSI < 25（极度超卖）时警告，不拦截
+ if (Number.isFinite(rsiValue) && rsiValue < 25) {
+   problems.push(`RSI ${round(rsiValue, 2)} 极度超卖，做空风险偏高`);
+ }
```

**D. 放宽高周期转弱条件（第 606-608 行）**
```diff
- if (!hasHigherBearStructure && priceChangePercent24h > -1.5) {
-   problems.push(`高周期尚未转弱且 24h 跌幅 ${round(priceChangePercent24h, 2)}% 不足，卖出信号过早`);
- }
+ // 改为：只要当前周期趋势已转弱，不必等更高周期确认
+ if (!hasHigherBearStructure && !(snapshot.trend === "down" || snapshot.trend === "weakening")) {
+   problems.push(`高周期尚未转弱且当前周期趋势未确认下行`);
+ }
```

#### 1.2 修复 `formalSignalPaperMonitor.js` — 做空候选生成

**E. 修正 `hasFormalEntryQuality` 做空路径（第 1404-1418 行）**
```diff
function hasFormalEntryQuality(candidate) {
  if (!options.formalRequireEntryQuality) return true;
  if (hasMomentumEntry(candidate)) return true;
  if (hasActionableSourceSignal(candidate)) return true;
  if (hasStrongSideTechnicalConsensus(candidate)) return true;
  const sourceOk = candidate?.sourceSignal?.score >= options.filteredSourceMinScore
    && candidate?.sourceSignal?.qualityStatus === "filtered"
    && (candidate?.edgeAligned || 0) >= options.executionMinEdge
    && candidate?.technicalAligned;
  if (sourceOk) return true;
+ // 做空特殊路径：risk_off 市场中 sourceSignal filtered 但技术面确认 + 趋势明确 → 可放宽
+ if (candidate.side === "short" && !hasActionableSourceSignal(candidate)) {
+   const regimeOk = candidate.marketRegime?.bias === "risk_off";
+   const trendOk = candidate.trend === "down" || candidate.trend === "weakening";
+   const consensusOk = hasStrongSideTechnicalConsensus(candidate);
+   const edgeOk = (candidate?.edgeAligned || 0) >= options.executionMinEdge;
+   if (regimeOk && trendOk && consensusOk && edgeOk) return true;
+ }
  return false;
}
```

#### 1.3 市场环境动态阈值 (`formalSignalPaperMonitor.js` 新增函数)

**F. 新增 `adjustThresholdsByRegime()` 函数**
在 `resolveRiskProfile` 之后调用，根据市场状态动态调整阈值：
```
risk_on (+20~+100):  做多阈值 × 0.85, 做空阈值 × 1.20
neutral (-20~+20):   不变
risk_off (-100~-20): 做多阈值 × 1.25, 做空阈值 × 0.80
```
实现为 `evaluateCandidateWithProfile` 内部根据 `candidate.side` 和 `state.marketRegime.score` 动态调整 profile 的 minEdge/minScore。

#### 1.4 收紧核心参数（`.env`）

| 参数 | 当前值 | 新值 | 原因 |
|------|:------:|:---:|------|
| `FORMAL_MONITOR_MIN_EDGE` | 16 | **22** | 提高信号质量门槛 |
| `FORMAL_MONITOR_MIN_SCORE` | 54 | **62** | 对齐到合理区间 |
| `FORMAL_MONITOR_EXECUTION_MIN_EDGE` | 12 | **18** | 恢复默认级别 |
| `FORMAL_MONITOR_EXECUTION_MAX_SOFT_FAILURES` | 3 | **1** | 从 3 降到 1 |
| `FORMAL_MONITOR_MAX_ATR_PERCENT` | 10 | **6** | 过滤极端小币 |
| `FORMAL_MONITOR_CONFIRMATION_SCANS` | 1 | **2** | 4h 级别需更强确认 |
| `CONSECUTIVE_STOP_TRIGGER` | 3 | **2** | 连续 2 笔即暂停 |

#### 1.5 止损位与支撑阻力联动 (`formalSignalPaperMonitor.js`)

**G. 修改 `buildBaseFormalCandidate` 止损计算（第 1272-1276 行）**
```javascript
// 当前：纯 ATR 倍数
const stopPercent = clamp(atrPercent * options.stopAtrFraction, min, max);

// 改为：ATR 倍数作为最大边界，实际止损取 ATR 止损与结构止损的较优值
const atrStop = atrPercent * options.stopAtrFraction;
const structuralStop = side === "long"
  ? (snapshot.supportResistance.support 
      ? ((entryPrice - snapshot.supportResistance.support) / entryPrice) * 100 
      : atrStop)
  : (snapshot.supportResistance.resistance
      ? ((snapshot.supportResistance.resistance - entryPrice) / entryPrice) * 100
      : atrStop);
const stopPercent = clamp(
  Math.min(atrStop * 1.2, Math.max(structuralStop * 0.8, atrStop)),
  options.minStopPercent,
  options.maxStopPercent
);
```

---

## Phase 2：新量化指标引入（1-2 周）

### 2.1 ADX 趋势强度指标 (`src/indicators.js` 新增)

```javascript
export function adx(candles, period = 14) {
  // True Range, +DM, -DM 计算
  // ADX = SMA(DX, period), where DX = |+DI - -DI| / (+DI + -DI) * 100
  // 返回 { adx, plusDI, minusDI }
}
```

**使用位置**：
- `scoreCandidateSide`：ADX > 25 时趋势得分 +5，ADX < 18 时只允许 scalp 入场
- `buildFormalSafetyFailures`：ADX < 15 且 volume < 1.0 时增加 `low_trend_strength` 失败

### 2.2 CVD 累积成交量差 (`src/directionEngine.js` 新增)

```javascript
export function computeCVD(aggressiveTrades = [], lookbackMs = 300_000) {
  // 5 分钟窗口的 CVD
  const cutoff = Date.now() - lookbackMs;
  let cvd = 0;
  for (const trade of aggressiveTrades) {
    if (trade.time < cutoff) continue;
    cvd += trade.side === "buy" ? trade.quoteQuantity : -trade.quoteQuantity;
  }
  return { cvd, cvdPerMinute, divergence };
}
```

**新增 CVD 背离检测**：
- 价格 ↑ + CVD ↓ = 看跌背离（对做空 +10 分）
- 价格 ↓ + CVD ↑ = 看涨背离（对做多 +10 分）
- 集成到 `scoreCandidateSide` 的 side-specific 分支

### 2.3 Open Interest 背离检测 (`src/directionEngine.js` 新增)

```javascript
export function computeOIDivergence(priceChange24h, oiChangePercent) {
  // 价格涨 + OI跌 = 多头减仓，上涨不可持续 → 做多 -8 分
  // 价格跌 + OI涨 = 空头增仓，下跌可持续 → 做空 +8 分
  // 价格跌 + OI跌 = 空头减仓，下跌衰竭 → 做空 -5 分
}
```

**数据来源**：`binanceClient.getFuturesDerivatives()` 已获取 OI 变动，当前未使用。
**修改位置**：`buildFormalCandidatesForSnapshot` → 调用 `getFuturesDerivatives` → 传入 `buildBaseFormalCandidate` → `scoreCandidateSide`。

### 2.4 资金费率完整系统 (`src/marketFusion.js` 扩展)

```javascript
export function fundingRateSignal(fundingRate, side) {
  // 资金费率 > 0.05% → 多头极度拥挤 → 做空加分
  // 资金费率 < -0.05% → 空头极度拥挤 → 做多加分
  // 资金费率从正转负 → 市场情绪切换 → 做多加分
  // 资金费率从负转正 → 市场情绪切换 → 做空加分
}
```

集成到 `scoreCandidateSide` 的评分中，±5 分调整。

### 2.5 波动率自适应头寸 (`formalSignalPaperMonitor.js`)

修改 `buildPositionRiskPlan` 调用处，增加 ATR 倍数：
```javascript
// positionSize = baseSize × (基准ATR / 实际ATR)
const baseAtr = 3; // 基准 4h ATR 约 3%
const atrMultiplier = clamp(baseAtr / Math.max(candidate.atrPercent, 0.5), 0.4, 2.0);
const riskPlan = buildPositionRiskPlan(candidate, {
  ...options,
  accountRiskPerTradePercent: options.accountRiskPerTradePercent * atrMultiplier
});
```

---

## Phase 3：系统化改进（2-4 周）

### 3.1 VWAP 锚定入场 (`src/indicators.js` 新增)

```javascript
export function vwap(candles) {
  // VWAP = Σ(price × volume) / Σ(volume)
  // 返回 { vwap, upperBand (+1σ), lowerBand (-1σ), upperBand2 (+2σ) }
}
```

**使用**：
- `buildBaseFormalCandidate` 中：入场价取 VWAP ± 1σ 与当前价的较优值
- 做多：`entryPrice = Math.min(snapshot.price, vwap.upperBand)`
- 做空：`entryPrice = Math.max(snapshot.price, vwap.lowerBand)`

### 3.2 多时间框架分歧评分

新增 `timeframeDivergenceScore`（在 `buildTimeframeAlignment` 中计算）：
- 4h MACD 看涨 + 1d MACD 看跌 → 短期反弹受阻 → 做多 -8 分
- 4h MACD 看跌 + 1d MACD 看涨 → 短期回调可能企稳 → 做空 -8 分
- 各周期 RSI 方向不一致 → 震荡市 → 降低信号优先级

### 3.3 持仓健康评估 (`pollOpenPositions` 增强)

每次 `checkPosition` 时新增：
```javascript
function assessPositionHealth(position, currentSnapshot) {
  // 重新计算入场时的信号评分
  const originalScore = position.score;
  const currentScore = scoreCandidateSide(currentSnapshot, ...);
  const decayRatio = currentScore / originalScore;
  
  if (decayRatio < 0.5) return "signal_collapsed";    // 信号崩塌，立即平仓
  if (decayRatio < 0.7) return "signal_weakening";    // 信号衰减，减仓 50%
  if (decayRatio < 0.85) return "signal_fading";      // 信号消退，移至保本止损
  return "healthy";
}
```

### 3.4 动态止盈追踪（Trailing Stop）

在 `checkPosition` 中增加：
```javascript
// 当盈利达到 targetPercent 的 60% 时，启用 trailing stop
const trailingThreshold = position.targetPercent * 0.6;
if (gross >= trailingThreshold) {
  const trailPercent = position.stopPercent * 0.5; // 追踪止损 = 原止损的 50%
  const trailStop = position.side === "long"
    ? exitPrice * (1 - trailPercent / 100)
    : exitPrice * (1 + trailPercent / 100);
  // 更新止损位为 trailing stop（只能朝有利方向移动）
  position.stopLoss = position.side === "long"
    ? Math.max(position.stopLoss, trailStop)
    : Math.min(position.stopLoss, trailStop);
}
```

### 3.5 时段效应自适应参数

```javascript
function getHourBias(nowMs = Date.now()) {
  const hour = new Date(nowMs).getUTCHours();
  if (hour >= 13 && hour <= 21) return "high_volatility"; // 欧美重叠
  if (hour >= 0 && hour <= 7) return "low_liquidity";     // 亚洲凌晨
  return "normal";
}
```

- `high_volatility`：confirmationScans 自动 +1，executionMaxSoftFailures 额外 -1
- `low_liquidity`：maxSpreadPercent 减半，maxPositionSizePercentOfEquity 减半

### 3.6 交易后统计反馈回路

在 `summarizeTrades` 中新增按失败原因分类：
- 统计各 `filterFailures` 对应的胜率
- 如果某类过滤器的通过信号胜率持续偏低 → 自动提高对应阈值
- 反馈到 `options` 中（通过 runtime.json 热更新）

---

## 实施顺序建议

```
Week 1: Phase 1.1~1.5（做空修复 + 参数收紧）
        → 验证：运行 48h 观察做空信号是否出现，胜率是否有改善
Week 2: Phase 2.1~2.3（ADX + CVD + OI背离）
        → 验证：对比开启/关闭新指标时的信号质量和数量
Week 3: Phase 2.4~2.5 + Phase 3.1（资金费率 + 自适应头寸 + VWAP）
        → 验证：回测 VWAP 入场相比市价入场的滑点改善
Week 4: Phase 3.2~3.6（分歧评分 + 持仓健康 + Trailing Stop + 反馈回路）
        → 验证：完整 72h 连续运行，对比升级前后的综合表现
```
