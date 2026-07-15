# NAS 信号昼夜与多空分布审计提示词

把下面内容完整发送给 NAS 上的 Codex。此任务只做读取和统计，不修改代码、配置、数据、容器或 Git 状态。

```text
你正在 NAS 上检查 /vol1/docker/Bi-Agent 的真实运行状态。目标是回答两个问题：

1. 为什么白天信号少、晚上信号密集？
2. 为什么最近几乎都是多单、空单很少？

严格要求：

- 只读检查，不修改任何文件，不重启容器，不执行 build/up/down，不清理数据。
- 不输出 .env 的完整内容，不输出 webhook、secret、app secret、token、receive id 等凭据。
- 所有 docker compose 命令必须使用：docker compose -f docker-compose.nas.yml
- 区分三类事件：watch 观察通知、formal 正式信号、PAPER ENTRY 实际纸面开仓。不能把飞书消息数直接当作开仓数。
- 时间统计统一换算为 Asia/Shanghai，并明确统计窗口。
- 优先分析最近 48 小时；如果不足 30 个实际开仓，再补充最近 7 天。

请执行并保留必要证据：

1. 运行状态
   - pwd
   - git rev-parse HEAD
   - git status --short
   - docker compose -f docker-compose.nas.yml ps
   - docker compose -f docker-compose.nas.yml logs --since=48h bi-agent-monitor

2. 安全读取当前生效配置，只输出以下键是否存在及脱敏后的值；其他键禁止输出：
   - FORMAL_MONITOR_TIMEZONE
   - FORMAL_MONITOR_SCAN_SECONDS
   - FORMAL_MONITOR_MIN_SCORE
   - FORMAL_MONITOR_MIN_EDGE
   - FORMAL_MONITOR_EXECUTION_MIN_SCORE
   - FORMAL_MONITOR_EXECUTION_MIN_EDGE
   - FORMAL_MONITOR_OBSERVATION_LOG_LIMIT
   - FEISHU_MARKET_SIGNAL_LEVELS
   - FEISHU_HIGH_PRECISION_ONLY
   - FEISHU_HIGH_PRECISION_SCORE
   - FEISHU_HIGH_PRECISION_VOLUME_RATIO
   - FEISHU_HIGH_PRECISION_VOLUME_SCORE
   - FEISHU_NOTIFY_COOLDOWN_MINUTES

3. 从 data/formal-signal-monitor/session-*.json、latest.json、runtime.json 和最近 48 小时 monitor 日志中，按交易 id 去重。不要把 latest/runtime 镜像重复计数，也不要把 partial close 当作独立主交易。

4. 输出 0-23 点逐小时统计表，列至少包括：
   - scan 次数
   - watch 候选数
   - 飞书 watch 通知数（如果日志无法证明，标记 unknown，不能猜）
   - formal 候选数
   - PAPER ENTRY 数
   - long 数
   - short 数
   - risk_on / risk_off / neutral 扫描次数

5. 输出多空漏斗表，分别统计 long 和 short 在以下环节的数量：
   - evaluated
   - accepted
   - confirmation pending
   - opening candidate
   - opened
   - 被 edge、score、technical、volume、source_quality、entry_quality、timeframe_confirmation、chase24h、derivatives_unavailable 拦截的数量

6. 对每次扫描使用当时记录的 marketRegime.bias，不得拿 session 最终 marketRegime 代替整段时间。若历史快照没有逐扫描 regime，明确写证据不足。

7. 检查飞书收到的密集消息是否属于同一 symbol + side + timeframe + signalLevel 在冷却时间内重复出现。列出重复最严重的前 10 组及相邻消息时间差，但不要展示 webhook 或接收人信息。

8. 验证当前容器内运行代码是否仍含以下旧逻辑：
   - marketAlertKey 是否包含 entryRange、stopLoss、takeProfit
   - 是否存在 adjustThresholdsByRegime
   - risk_on/risk_off 是否同时改变 score 和 minScore/minEdge

最终按以下格式回答：

A. 结论：分别判断夜间真实开仓变多还是观察通知重复变多；判断多单偏置来自市场样本、评分、阈值、数据缺失中的哪几项。
B. 证据：48 小时逐小时表、多空漏斗表、重复通知前 10、逐扫描 regime 分布。
C. 当前容器版本：Git HEAD、容器创建时间、上述两段旧逻辑是否仍存在。
D. 建议：只给最小改动建议，禁止直接修改。明确哪些是代码修复，哪些是 NAS .env 调整。
E. 未验证项：列出日志或历史结构无法证明的内容。
```
