# RSI-Harness: 四体整合可行性研究

> 输入物：①《thoughts on a typesafe coding agent》(下称 **Doc**) ②[unreal-agent](https://github.com/unreallabsai/unreal-agent) ③[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) ④[Dream-RSI](https://github.com/zhengkid/Dream-RSI)
> 日期：2026-09-23 · 结论先行版

---

## 实现地图（2026-09 更新）

设计文档写在前面，实现落在下面这些位置。**每一行标注了"已完成"还是"未建"**，因为它们不是同一件事。

| 层 | 组件 | 位置 | 状态 |
|---|---|---|---|
| **L1** | 无 I/O 的 translator capability | `crates/core/src/translator.rs` | ✅ 16 单测 + 2 文档测试 |
| | 版本化 Operation + 至多一次 Manager | `crates/core/src/operation.rs` | ✅ |
| | 类型化上下文变更报告 | `crates/core/src/context.rs` | ✅ |
| **L2** | dsh 宿主 | 外部依赖 | ✅ 非本项目 |
| **L3** | `JudgmentProvider` seam + heuristic + Jev | `packages/judgment/src/{types,heuristic,jev,wire}.ts` | ✅ 59 测试 |
| | chunk 打分（4 档 + confidence 门控） | `packages/judgment/src/scorer.ts` | ✅ |
| | cache 感知定价 | `packages/judgment/src/cache.ts` | ✅ |
| | 能力目录 | `packages/judgment/src/catalogue.ts` | ✅ |
| | dsh 活 context 上的建议式策略 | `packages/rsi-context/src/index.ts` | ✅ 6 测试（dsh checkout 内） |
| | 自注册 `CompactionEngine` | — | ⬜ **刻意不做**：`ctx.compaction` 是单服务，自注册会与 `compaction-basic` 冲突；本服务改为**建议 + 委托** |
| | **ConditionalPrompt + pinning** | — | ⬜ 未建 |
| | **Router 策略** | — | ⬜ 未建 |
| **L4** | 发现树投影 + replay 引擎 | `packages/rsi-trace/src/` | ✅ 15 测试（在 dsh checkout 内） |
| | replay 保真度（在线一致 + 负向对照） | `packages/rsi-trace/tests/replay-fidelity.spec.ts` | ✅ |
| | workspace 快照 + CoW + 树级 GC | `packages/workspace/src/snapshot.ts` | ✅ 16 测试 |
| | wet fork（成对/多样分叉真实执行 + 结果对比） | `packages/policy/src/wetfork.ts` | ✅ 15 测试 |
| | **wet fork 接到真实 agent+evaluator** | — | ⬜ 未建（编排与对比已完成，提供可执行的 `runAttempt` 是部署工作） |
| **L5** | replay 引擎（独立实现） | `packages/policy/src/replay.ts` | ✅ 30 测试 |
| | dreaming 闭环 + 有界单调性 | `packages/policy/src/dream.ts` | ✅ |
| | β 扫描 + degenerate 检测 | `packages/policy/src/dream.ts` | ✅ |
| | PolicyStore（版本 + 部署指针） | `packages/policy/src/store.ts` | ✅ |
| | **模型自写策略的沙箱执行** | — | ⬜ 未建（`propose` 是 seam） |

**测试总数**：Rust 18（16 单测 + 2 文档）、独立 TS 包 120、dsh 内 21（rsi-trace 15 + rsi-context 6）。

**两处必须说清的边界**：

1. **L3 的 dsh 适配已完成，但形态与最初设想不同。** 原计划注册自定义 `CompactionEngine`；实测发现 `ctx.compaction` 是单服务，自注册会与 `compaction-basic` 冲突（且会接管摘要生成——那是另一个大得多的职责）。现在 `packages/rsi-context` 是**建议式**的：读 surface、打分、定价、返回 span，`apply()` 把 span 交给已挂载的引擎。这样 dsh 自己的压缩语义（工具配对平衡、durable marker 对、token 核算）保持唯一实现，且不改变任何未选择加入的部署。
2. **L4 的 wet fork 编排已完成**（`packages/policy/src/wetfork.ts`），但真正执行 attempt 的 `runAttempt` 是部署提供的——那是接 agent/evaluator/sandbox 的工作。
3. **L5 要跑模型写的策略需要接 `ptc-runtime`**：`propose` 这个 seam 已就绪，接一个会写代码的 proposer 是部署工作。
4. **dry replay 与 wet fork 的区别仍然是最重要的一条**：dry replay 零执行成本，但只能在历史走过的地方做梦；wet fork 能回答因果问题，但要真花算力。**两者现在都实现了**，区别在于谁来付 wet fork 的钱。

---

## 0. 一句话结论

**能整合，但不是"合并代码库"，而是"一个宿主 + 四个正交轴"，而它们的相对位置由时间决定**：

| 轴 | 承担者 | 时间位置 | 不可替代性 |
|---|---|---|---|
| **宿主 / 运行时** | **deepseek-harness (dsh)** | 运行时 | 唯一一个已经把「append-only 事件日志 + 可插拔 seam + 前后端」做成产品的东西 |
| **类型纪律 / 状态契约** | **unreal-agent** | 设计期 | 唯一一个把「无 I/O 的纯翻译」写进接口签名的实现（⚠️ 最亮那点是接口不是实现） |
| **算法内核** | **Dream-RSI** | **后置**（每轮之后，元层） | 唯一一个把 RSI 的目标定在「探索层」而非「生成层」 |
| **判断层** | **TypeSafe / Jev** | **内联**（每次决策） | 唯一一个把"分类与打分"做成**类型化原语**（`Choice`/`Score`/`Noul` + `confidence`）的模型 |
| **产品规范 / 需求清单** | **Doc** | 设计期 | 定义了 feature backlog 与「为什么 KV cache 是万恶之源」的第一性论证 |

一句话架构：**在 dsh 的会话日志之上，建一层"可重放世界"（Dream-RSI 的 simulator），用 unreal-agent 的类型纪律保证这个日志可重放、可审计、可定价，用 Jev 提供内联的类型化判断，从而让 Doc 那套「meta-attention + 路由 + 后台只读任务」有地方落地。**

⚠️ 四个必须先说清的硬约束：
1. **Dream-RSI 目前没有代码**（README 明确 "Code is being prepared for release"），只能按论文重实现；且**它明确不碰上下文层**（把 "history as context" 列为对照并主动放弃）。
2. **RSI 是后置的二阶优化器**：第一轮必须手写策略（论文原话 "manually designed exploration policy"），$\mathcal{H}_0=()$ 没有 world 可 replay。**它不能是起点。**
3. **Doc 的「KV cache 无关设计」与 reality 冲突**：dsh 已有 `systemPromptUpdate: 'in-history'` 这类**明确为 KV cache 复用服务的机制**。必须做「缓存感知」而不是「无视缓存」。
4. **不需要改 dsh**（§4.2 已逐个接缝核验）：全部通过仓外 bundle + `SessionEventMap` 扩展 + `storageDomain` + `spillStore` + waterfall 实现；dsh 也不接受外部 PR。

---

## 1. 五个东西分别在说什么

### 1.1 Doc：一份"反 KV cache 暴政"的需求文档

核心论证链：**如果 LLM 没有 KV cache，你会怎么设计 coding agent？** → 由此推出当前设计的 6 个"畸形"（tyranny）：

| # | 畸形 | Doc 的判词 |
|---|---|---|
| 1 | **路由失效** | Opus→Sonnet→Opus 比纯 Opus 更贵（context 要被大模型重新 prefill）。按 Doc 给的 X/Y/Z 比例算：纯 Opus 只要 2/3 成本 |
| 2 | **tool calling 是坏 tradeoff** | 工具必须前置声明在 system message 里，但并非总是相关 → 吃 context、且模型对 high-cardinality / off-policy 工具调用不擅长 |
| 3 | **compaction 存在** | 它假设"未来所有 turn 共享一份 state"，但**为什么要有这个假设**？query-aware 压缩永远优于盲目压缩 |
| 4 | **subagent 很一般** | 瓶颈不是并行能力，而是"该传哪些 state 进去 / 该 merge 哪些回来" |
| 5 | **restart 存在** | 有状态 agent 的状态终将腐化；但也可能"按需加载相关旧状态" |
| 6 | **batteries 不包含** | 易用性（openclaw 极端）vs 强大（claude code/codex）的取舍 |

Doc 给出的解法（= RSI-Harness 的 feature backlog）：

- **Meta-attention**：context 不该是静态的。对每个 query 重新计算「复用现有 KV cache 是否划算」+「如何构造一个装进所有相关内容的**新** context」。最小形态 = 对每个 chunk（工具调用输入/输出、内部推理、甚至用户往返）打一个分：*别显示 / 短摘要 / 长摘要 / 全显示*。
- **Routing + sub-agent**：有了 first-class 动态 context，才能把简单任务路由给便宜模型；且必须**成本/智力感知**。
- **Skills/MCP/Tool calling 的第一性版本**：应当存在「中间态」——小片段描述"世界上存在这种能力"（类似 skill description），但**不必进 system message**，按需动态加载完整 schema，且**不污染 context**。做好了就能"零成本内置几百个工具 + 几千份文档"。
- **条件化 system message / AGENTS.md**：按条件（前端？在某个子目录？）动态加载片段。注意 Doc 的关键观察：**skill 是"现在就做这个"，而他要的是"让这东西一直在记忆里"**，且要**免疫 compaction**。
- **结构化 skills**（比 claude skill hooks 更强，且不是永久注入 session）。
- **递归语言模型 / 显式状态变量**。
- **更好的 summarization**：给 grep 输出做"相关性 heatmap"，然后按任意粒度裁剪。
- **极端 subagent + 并行化**：共享状态 + 锁，处理写冲突。
- **安全感知路由**：按"可能触碰哪类文件"决定用哪个模型（便宜的中国模型 vs 不能碰特定数据的模型）。
- **后台处理模式**（Appendix 2）：后台任务多是**当前代码库状态的只读函数**（HTML 报告、eval、跨模型 review）。与"显式 state（读 vs 写）"的 synergy 极高——**如果"找相关信息"这个工作能在所有后台任务间共享，就能跑多得多**。

文档里还埋了一个**技术核心**（在 image2 那条推文截图里）：

> 简单的二元消息检查很难 work（即使便宜 100 倍，线性工作量也会累积）。**但如果把历史做成层级结构（每个 task 有嵌套的 label 集合），那"对 context 做树搜索"就是 🔥。当 context 变成 log(n) 搜索，新可能性爆炸：为什么不把历史放进每个 coding agent 的 context？为什么不放进并行 agent / subagent 的 context 里？**

**这就是 Doc 与 Dream-RSI 的接缝**——Doc 直觉上要"层级化历史 + 树搜索"，Dream-RSI 正好是"把历史树当模拟器"的完整形式化。

### 1.2 dsh：一个已经"什么都能插"的宿主

**规模先摆正**（我一开始低估了）：`packages/` 下有 **54 个 group / 307 个 leaf package**（不是"约 60 个包"）；`apps/` 有 cli / web / desktop / desktop-host；另有 `native/system`、`python/`、**11 个 vendored Cordis 系包**（"copied into this monorepo instead of being depended on via npm, so that the harness fully owns its framework layer"）。但**能 boot 起来的产品核心远小于 307**：`dsh-base` 一个 patch 插 **92 行 / 91 个包**，`web-app` 再加 **114 个**，base ∪ web-app 覆盖 38/54 个 group → **不可约的产品约 170 个包**。

- **一切皆插件**（Cordis）：模型适配器、工具注册表、会话日志、**甚至 agent loop 本身**都是插件。"**There is no privileged core to patch**"——挂一个 plugin 在旁边即可，注册是 **reversible effect**，插件卸载时自动回滚。
- **组合方式是 profile / bundle**：`web`、`headless`、`sdk`、`sdk-minimal`、`acp` 五套模板；层叠顺序是 bundle patch（按 `dsh.profile.bundles` 顺序）→ profile 的 `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → `--patch`。⚠️ **patch 替换整行 config，从不深合并。**
- **插件三要素**：`inject`（声明依赖的服务 → 加载顺序由服务可用性驱动，不手排）+ `Config`（schema 校验）+ 注册即 effect。事件有 5 种派发模式，其中 **waterfall 就是"策略"的落点**（listener 拿到 `next()`，不调用即短路）。
- **会话即 append-only 事件日志**：模型历史是从日志**派生**的（`deriveMessages()`），从不单独存储；replay 就是重新派生。存储是 `session-persistence-jsonl`：**逐 session 的逻辑 JSONL，默认按校验和拼接的 Zstandard frame**，崩溃安全原子物化、per-batch fsync、torn-tail 截断；格式 v0→v4 各有相邻迁移包，**已提交的 generation 路径永不改名或删除**。
- **Subagent 是命名注册表，多 provider 共存**：`spawn` / `fork`（子 agent 看到父的所有已完成 turn）/ `acp` / `codex` / `claude-code` / `dsh-sdk`。
- **LLM 层**：`ctx.llm` 只有 `stream()` 是抽象方法。**两个 adapter 覆盖 7 个 provider**：`llm-deepseek` 走 Messages API；`llm-pi-ai` 包 `@earendil-works/pi-ai`，路由 openai / anthropic / openrouter / azure-openai / openai-codex / bedrock + 任何手工声明的 OpenAI 兼容网关。重复路由名直接 `DUPLICATE_ADAPTER` 报错。
- **已有的 batteries**（Doc 想要的很多东西 dsh 已经有）：`spill`、`compaction`（5 包）、`jobs`、`goal`、`todo`、`schedule`、`workflow`、`ralph`、`skill`、`hooks`、`mcp`、`sandbox`、`approval`、`token-meter`、`session-query`、`guard`、`lsp`、`browser-use`、`computer-use`、`agent-team`、`auto-review`、`terminal`、`ssh`。

**关键发现：Doc 想要的拦截点，dsh 已经全部预留好了。**

| Doc 的需求 | dsh 的现成接缝 |
|---|---|
| 权限/审批（可编程） | `tools/pre-execute` waterfall 返回 **allow / deny / cancel / ask**；`ctx.approval`（one-shot，answerer 是 waterfall，首个答案胜出）；`ctx.permissionPresets` 把 `sandbox/mode` + `approval/policy` 打包成命名 preset。**"missing approval support turns `ask` into denial"**（fail-closed）——这就是 Doc 要的"可编程查询" |
| tool-call 路由 | tools 注册到 `ctx.tools`（`register()` 返回 disposer，可按 agent scope 遮蔽全局），`schemas()` 用显式 allowlist 构造模型可见的 `ToolSchema[]` → **`execute`/`output`/`presentCall`/`timeoutMs` 永不泄漏进请求** |
| 动态 context / meta-attention | **`agent/pre-step` waterfall**：可以 rewrite / reject 本轮 claim 的 message；`agent.inject()` 注入 context 落到下一次被批准的请求 |
| 成本/智力感知路由 | **`agent/request` waterfall**：返回替换的 `LlmCallConfig`（provider / model / reasoningEffort）。`packages/core/agent/src/model-selection.ts` 就是现成模板 |
| 条件化 system prompt | `system-prompt/assemble` waterfall + `PromptSection`（文本可以是"每次 assembly 求值的 provider"）+ `getSectionOrder()`；最终渲染成 **`system/message` surface node** |
| 后台只读任务 | `ctx.jobs` + `job_*` 工具 + `agent/turn-stopping` |
| 跨模型 review | `subagent` providers（可挂 codex / claude-code 后端）+ `auto-review` |
| 历史树搜索 | `session-query`：`readSession` / `filterEvents` / `searchEvents` / **`traceSession`（祖先链 + 递归后代树）** |
| 状态可审计 | 日志 + `sessionProjections`（增量 fold 成 typed state）+ `persistence-schema.json` + **`runtime-diagnostics`（包自有的 runtime invariant 注册表）** |
| 定价 | `token-meter`：`TokenMeasurement` 带 `logRevision`、按 route pricing 的 `surfaceTokens`、逐 node 的 `TokenSurfaceNode` |
| 压缩 | `ctx.compaction`：`compactIfNeeded(agent, trigger, signal)`（`pressure` / `context-overflow`）、`compactNow`、`compactRegion`——**在 `agent/pre-step` waterfall 里、请求派生之前运行** |

⚠️ 但 dsh 里**没有**：相关性打分、成本策略驱动的自动路由、把历史当 simulator 的离线评估、策略即代码的自我改进闭环。**这正是 RSI-Harness 要补的那一层。**

**稳定性的真实情况（这条改变了落地方案）**：包版本全是 `0.1.7-alpha.2`，而且 `CONTRIBUTING.md:9` 明说 "we cannot accept external pull requests at the moment"。所以：
- **稳定-ish**：约 **89 个 `ctx` 服务 key** 及其文档化方法、Cordis 的 `Plugin` 契约、`ToolDefinition`、`LlmAdapter`、session 事件词汇、`dsh.bundle` / `dsh.profile` / `dsh.client` 三个 manifest 字段。`docs/subsystems/*` 是从源码生成并由 `verify-cordis-catalog` 强制新鲜的，`ts type-equiv` 代码块会被机械校验——**文档就是权威契约，且防漂移**。
- **私有**：`src/` 下未被 re-export 的东西、Typert 生成产物、Desktop Host。
- **分发方式**：没有 SDK 意义上的"插件 SDK"，只有一个 **GitHub topic `dsh-plugin`**（"Add the `dsh-plugin` topic to your plugin repository for discoverability"）。**`dsh-bundle` 是你编写和分发的，`dsh-profile` 是用户 boot 的。**
- **两个真实摩擦**：(a) 客户端构建 preset `packages/client/tsdown.client.ts` **未发布**，仓外包要自己复现那套构建——**这是第三方 UI 插件的实际门槛**；(b) `dsh.client` 只挂到 specifier 为裸包名的那一行 Loader row 上。

### 1.3 unreal-agent：一份"状态机可以有多干净"的参考实现

Go，手写生产代码 **11,482 LOC**（另有 19,401 行生成代码），**~30,900 行测试**（100 个测试文件 / 705 个测试函数，coordinator 98.4% 覆盖率，还有 5 个 fuzz target）。运行依赖**只有 3 个**（`oapi-codegen/runtime`、`golang.org/x/image`、`golang.org/x/sys`），用了 `encoding/json/v2`、`jsontext`、`testing/synctest`、`sync.WaitGroup.Go`——**Go 1.27 的新东西**。

它的价值 90% 在三段接口签名里：

```go
// tool/tool.go —— 纯函数翻译边界
// Context is turn-local and coordinator-owned. Submit allocates an ID and
// records inert data without performing I/O or handing work to another queue.
type Context interface {
	Submit(operation.Spec) operation.ID
}

type Translator interface {
	ResultTranslator
	Translate(Context, llm.ToolCall) CallStatus   // 同步、无 I/O、不 suspend event loop
}
```

```go
// operation/operation.go —— 操作是可序列化、带版本的值
type Spec struct {
	MaxOutputLength int
	Type            Type
	Version         Version
	State           jsontext.Value
	Idempotency     jsontext.Value
}
type Manager interface {
	// Add starts an operation at most once for each ID during the manager's lifetime.
	Add(Operation) error
	Cancel(ID, string) error
	Updates() <-chan Operation
}
```

```go
// contextbuilder/contextbuilder.go —— 上下文构建是 I/O-pure 的
type ChangeKind string
const (
	ChangeOmitted   ChangeKind = "omitted"
	ChangeTruncated ChangeKind = "truncated"
	ChangeCompacted ChangeKind = "compacted"
)
type Change struct { Kind ChangeKind; Source string; Reason string }
type Result struct { Request llm.Request; Report Report }

// Builder retains model request state without performing I/O.
type Builder interface { /* AddExternalInput / AddModelResponse / AddTool / Build ... */ }
```

⚠️ **但必须纠正一个我一开始的高估**：`Report` / `Change{omitted,truncated,compacted}` 这三个 kind **声明了但从未被填充**——`Build()` 实际只返回 `Result{Request}`（`builder.go:130-137`），`session.TurnCompaction` 也被消费但从未被产生。所以 **"类型化的上下文变更审计"目前是一个空壳接口，是一个设计意图而不是一个已实现的能力。** 它的价值在于**形状是对的**——Doc 要的"对每个 chunk 打分"正需要这个形状——但**你要自己把它填满**。

其他值得抄的：

- **Translator 阶段边界是真的**：`Submit` 只追加一个 `StatusReady` 的惰性 Operation 并返回 UUID；`Translate` 不允许 I/O 或 suspend。于是**模型可见的 `CallStatus{Error, ErrorTruncated, WaitingFor}` 与执行状态被彻底分开**，重放靠"按名字重新解析 translator + 用记录的 snapshot 重新格式化"（`loop.go:523-539, 710-754`）。这是整份代码里最值得学的设计。
- **单 goroutine actor coordinator**（98.4% 覆盖）：所有状态在 `loopState`，只在 `Run` 内 mutate，`Run` 是 single-use。子 actor：Inbox、LocalOperationManager、每个 RemoteJobHandler 一个 goroutine。模型调用是一个由 loop 通过 `cancelModel` 拥有的 goroutine，**被取代的 turn 的迟到响应直接丢弃**。
- **崩溃恢复**：JSONL 按换行提交语义（`decodeLog` 在最后一个 `\n` 处截断 + 校验连续序号 + 拒绝 legacy v1），追加前 truncate 到 committedSize 再 fsync。`Resume` 返回 snapshot + 未完成 operation + 外部 input ID（用来给 Inbox 去重和 coordinator 的 op map 播种）。**"外部输入 ID 跨重投递稳定"是幂等性的根。**
- **Tool translator 与 operation 分离**：翻译（同步、纯）与执行（异步、可远程）在类型层就分开了。`README` 明说：*a proxy operations manager can send serialized operations to a local operations manager inside a remote sandbox* —— 即 **工具在哪执行是部署细节，不是架构差异**。`RemoteJobHandler`（带 plan type/version 路由、状态转移校验、handler 关闭时 fail-fast）已经在树里了。
- **真实的 cache 感知**（这条比 Doc 超前）：`CacheKey = sessionID` → OpenAI 的 `prompt_cache_key`，或 OpenRouter 的 `x-session-id` header + `cache_control {ephemeral, ttl 1h}` 扩展（与标准字段冲突会拒绝）。
- **输出有界化**：`BoundOutput` 做 head+tail + byte marker + 落文件路径，默认 40,000 字节、上限 1,000,000。
- **渐进披露的雏形**：只有 skills——`SkillUse` 把 `SKILL.md` 正文按需加载成一个 operation，元数据始终常驻在 preamble 的 XML 里。

**它没有的东西**（这些正是 RSI-Harness 要补的，也是"别指望它"的部分）：
- **没有任何上下文管理**：无 token 计数、无截断、无压缩、无摘要、无打分、无 preflight；`provider context_length_exceeded` 是不可重试错误。**前缀只增不减。**
- **没有任何模型路由**：一个 session 在启动时固定一个模型；`llm.Usage` 记录了 cached/reasoning tokens 但**没有任何消费者**。
- **没有并行 sub-agent**：一个 coordinator、一个 in-flight turn。`Store.Fork` 存在，但**没有 coordinator/CLI 路径去 spawn 子 session，而且 fork 的重放明确不完整**（`loop.go:552` 有 FIXME，`state.go:401` 有 TODO）。
- **工具集是硬编码的**：Bash / ViewImage / SkillUse 三个，**没有插件加载、没有 MCP client**。
- **没有权限/审批**：只有一个静态 `disallowed_tools` 列表（`extra_allowed_tools` 接受了但被忽略）；Bash 以 workspace cwd 跑任意命令，无 allowlist、无 confinement、无审批（隔离靠外部容器：non-root uid 10001 + tini）。
- **没有流式输出面**：`include_partial_messages` 被忽略，`Respond` 只返回完整响应。
- **它是一个明确的"部分发布"**：CONTRIBUTING.md 说仓库 "contains selected components from a larger internal codebase"，**不接受 PR**，单 commit、无 tag。

**结论**：unreal-agent 该被**当作类型规范的参考**（如果把宿主换成 Rust 则当移植源），**不是当作可依赖的组件**。而且要注意它的核心亮点（typed change report）**是接口而非实现**。

### 1.4 Dream-RSI：把"探索策略"变成可离线优化的对象

**问题**：RSI 的瓶颈在探索。固定策略无法随搜索空间扩展而适应；在线优化策略又太贵（评估一个策略需要观察它如何塑造**整个发现过程**）。

**Insight**：**已完成的发现历史本身就是一个 replay simulator。** 历史里已经存好了一棵结构化的探索决策树 + 每个决策的真实代码执行结果。另一个策略可以以不同方式遍历这棵树（不同子集、不同顺序、不同并行分组、不同停止点）——因为所有结果都已保存，评估它**只需读历史记录，不需要重跑 discovery agent 或 evaluator**。类比 model-based RL / world models：**历史成为 agent 可以"做梦"的世界**。

**形式化**（论文 §3）：

- 发现树 $T$ 以 $r$ 为根（初始 workspace）。每个非根节点 $v$ 恰有一个 primary parent：$v$ 中的尝试从父节点的**已保存 workspace** 恢复，并以累积 observation 为 context 产生新尝试。节点记录：继承历史、文件系统快照、生成产物、评估诊断、分数 $s_v$。
- 可行动节点集 $A(T) = \{r\} \cup \{v \in T : v \text{ 是当前观测树中的叶}\}$。
- $W$ = 并行 worker 数。策略的 action 是一个 batch $C \in A(T;W) = \{C \subseteq A(T) : |C| \le W\}$ —— **batch 同时决定了"从哪里继续"和"多少个尝试并行"**。
- **Online rollout**：策略 $\pi_t$ 驱动 rollout，最多 $K_1$ 轮；每轮选 batch，每个节点分给一个 worker 并行产生一个子节点；transition 是**随机**的（同一 workspace 可能生成不同结果）。结束后的树记为 $\mathcal{T}_t$ 并追加进历史 $H_t = H_{t-1} \cup \{\mathcal{T}_t\}$。
- **Offline replay**：历史 $H_t$ 固定，构造并评估 $M$ 个策略版本。Replay 时策略 per-rollout state 重置，从 $T_i^{m,0}=\{r\}$ 开始，**只**观测被揭示的子树；每个决策从 $\mathcal{T}_i^{m,k}$ 里选 batch，然后系统**确定性地**返回已记录的 children（$v \ne r$ 返回其唯一已记录子节点；$v = r$ 返回最早创建的未揭示子节点，即开一条新分支）。最多 $K_2$ 轮，$C=\emptyset$ / 轮数到顶 / 全树揭示 则终止。
- **Replay 目标**（论文 Eq.1）：

$$V_i^m = \underbrace{\max_{v \in \mathcal{T}_i^{m,\star}} s_v}_{\text{quality}} - \underbrace{\beta_1 N_i^m}_{\text{execution cost}} + \underbrace{\beta_2 \frac{N_i^m}{\max\{1, k_i^{m,\star}\}}}_{\text{parallelism bonus}}$$

其中 $N_i^m = |\mathcal{T}_i^{m,\star}| - 1$ 是揭示的非根节点数（即 trajectory 所代表的 generation–evaluation 请求数），$k_i^{m,\star}$ 是完成轮数。第三项奖励"把有用的 continuation 批起来"而非串行执行。

- **策略改进与选择**：$\pi_t^m$ 的评分是它在**固定历史**上的平均 replay 分 $V^m = \frac{1}{t}\sum_i V_i^m$。从一个 LLM 策略开发 agent 看着 replay trajectory + 分数去**改可执行策略代码**产生 $\pi_t^{m+1}$。$M$ 轮后选 $\pi_{t+1}^\star = \pi_t^{m^\star}, m^\star \in \arg\max_m V^m$。**因为候选集包含当前策略，所以 $V^{m^\star} \ge V^0$：换出的策略在固定历史上不可能比现在更差**（这是个很强的单调性保证）。

**策略到底长什么样**（Appendix B.2，这是最有工程价值的部分）：策略是**一段 Python 代码**，实现

```python
def solve(self, question, budget=None):
    question.reset()
    while not _budget_done(question, budget):
        prefix = question.observed()      # 只给"已揭示前缀"
        ...
        question.probe_batch(batch, on_reveal=lambda _: _record_curve(res, question))
```

`question` 提供 `observed()` / `legal_actions()` / `legal_roots()` / `opened_branches()` / `meta(cell_id)`（`.branch .attempt .parent_id .seq .tags`）/ `probe_batch(cells, on_reveal=...)` / `baseline_score` / `max_parallelism`。`Observation` 提供 `branch, attempt, score, evaluated, valid, fail_class, error, delta_vs_baseline, delta_vs_parent, n_valid, n_total`。

三条硬约束值得刻进 RSI-Harness 的设计：

1. **Prefix-only（前缀可见性）**：决策只能用已揭示的 observation，**绝不能**用未揭示分数、真最优值、硬编码的获胜 cell id、绝对分数阈值。→ 这保证了「在线用同一个策略」是合法的（没有偷看未来）。
2. **单一 `beta` 旋钮，三种角色分离**：一次 replay/live episode 内 `beta` **固定**（所有阈值走同一个 `_schedule(beta)`：高 beta = 更宽、更有耐心、更弱剪枝；低 beta = 更少 probe、更早停滞停止、更强剪枝）；离线评估时扫一个固定 beta 网格（测"是否暴露真实的 attainment/work/parallelism 权衡"）；提出下一版策略时才根据最近 2–3 个 **live** cycle 的证据**烘焙一个新的默认 beta**（±0.1–0.2，clamp 到 [0,1]）。
3. **`plan_grid(context) -> GridPlan(branch_count=W, refine_count=R)`**：策略还要在**新 live grid 建立之前**决定网格形状——**策略控制的不只是"怎么搜"，还有"搜索空间的形状"**。论文明确：超出冻结 trace 的 `context.trace_branch_count` / `trace_refine_count` 的 plan 是 **out of support，拿不到 replay 奖励**。

**改善机制（这个必须说准）**：是 **LLM 驱动的代码改写 + 对单一标量的精英选择** —— *没有 bandit、没有进化种群、没有梯度*。流程是：离线扫固定 beta 网格，按 `pareto.reward = pareto.auc − λ·parallel_penalty` 排序整条 attainment/work/parallelism 曲线（`parallel_penalty` 定义为 `effective_sequential_rounds / total_probes` 的均值；一个 size $k$ 的 batch 在 $W$ 个 worker 下算 1 个决策轮、`ceil(k/W)` 个等效串行轮）；开发 agent 看 replay trajectory 改代码产生下一版；最好的平均分出线。**"0 gradient steps on the coding agent"** 是 README 的原话。

**Replay 能做什么 / 不能做什么**（这个边界决定了整个框架的能力上限）：

| 能做 | 不能做 |
|---|---|
| 换分支**子集** | 到达 $\mathcal{T}_i$ 之外的任何节点（**永远不生成新候选**） |
| 换分支**顺序** | 在同一分支内乱序——"each branch is traversed in its recorded parent–child order" |
| 换**并行分组** | 在已记录 root children 之外凭空造一条分支 |
| 换**停止点** | 在支持集外的 grid 上拿奖励 |
| 决定分支深度 / 何时开新 root | 使用任何未揭示信息 |
| | 捕捉"同一个 cell 上换一个 proposal"的反事实 |

→ **Dream-RSI 优化的是"怎么分配算力"，不是"想什么"。** 这个区分在产品叙事里不能含糊（详见 §6.3）。

**实验结果**（诚实版）：

- **Lasso regularization path**（算法工程，17 个 synthetic 训练实例 + 6 个 held-out 下游数据集）：Gemini-3.1-Pro 下平均下游 runtime **3587.1 ms → 2931.0 ms**，discovery-agent 调用 **550 → 317**。Flash 下 **2516.7 → 2350.6 ms**，调用 **3200 → 1879**。对比 SimpleTES（gpt-oss-120b，**51,200 generations**）用**少两个数量级**的调用达到更低平均 runtime。
  - ⚠️ **但平均值是靠一个数据集撑起来的**：Gemini-3.1-Pro 下，6 个 held-out 数据集中 Dream-RSI 在 **4 个上比 Fixed 更差**（Gisette 1861.8→2841.0、DNA 41.5→49.9、Leukemia 26.1→30.2、Colon 14.5→16.4、Duke 28.4→32.5），靠 RCV1 的 19550.1→14616.0（1.34×）把平均拉回来。Flash 下是 6 个里赢 5 个。作者自己的解释是 Pro 发现的 solver "特别适合大规模矩阵如 RCV1"，Flash 发现的更通用。**这个细节论文没有强调，但对接纳决策至关重要。**
- **数学优化**（Sum–Diff / Autocorrelation / Circle Packing）：Dream-RSI 1.145427 / 1.456375 / 2.635983 vs Recursive Fixed 1.144047 / 1.456001 / 2.635983。**提升极小**（Sum–Diff +0.12%），**Autocorrelation 反而退化**（1.456375 比自己的 fixed baseline 1.456001 差），Circle Packing 完全打平。论文自己说 "2 of 3 tasks at or above the selected baseline"。预算是 <1k generations vs SimpleTES 的 51,200（>50× 节省）。
- **GPU kernel**：4/4 kernel 有改善——VGG16 **2.43× fewer generations**（等性能）、LayerNorm 1.79× fewer generations、ConvDiv **2.09× higher score**（等预算）、ConvMax 1.44× higher score。
- **最重要的消融**（论文 §5.1）：把历史抽象成"高层方向性洞见"塞进 prompt（`+ Guidance`）**在两个范式下都一致地更差**。作者结论：长视野发现中，强加语义归纳偏置会**过度约束搜索空间、损害探索多样性**。
  → **这条支持 Doc 的"不要把东西污染 context"直觉，但反对 Doc 的"conditional AGENTS.md 常驻记忆"的某些用法**（见 §6.4）。
- **另一条**（论文 §5.2）：学到的策略呈**自适应模式**——性能提升时它**省算力**（evaluated attempts 从 110 降到 50）；随后 plateau 时又**加大探索**，并伴随进一步增益。

### 1.5 TypeSafe / Jev：内联的判断层（第五轴）

这一轴是后来才发现的，而且**Doc 里那句 "you could imagine this as a noul on every chunk of context" 用的就是 Jev 的原语名**——不是随手用的术语。

[Jev](https://docs.typesafe.ai/introduction) 是 TypeSafe 的旗舰模型，第一个 **System One model**：**不生成文本、不写代码、不对话**，而是对一段 **state** 求值一组 **typed questions**，直接返回结构化结果。

| 原语 | 问什么 | 返回 |
|---|---|---|
| [`Choice`](https://docs.typesafe.ai/primitives/choice) | 从一组选项里选哪个？ | `choice`, `probabilities`, `confidence` |
| [`Score`](https://docs.typesafe.ai/primitives/score) | 在这条谱系的哪一级？ | `score`, `legend`, `probabilities`, `confidence` |
| [`Noul`](https://docs.typesafe.ai/primitives/noul) | 这个陈述是真的吗？ | `noul` (0–1)，**无 confidence** |

**四条改变架构的事实：**

1. **一次调用判所有问题。** 三种类型可混在一次请求里；每个问题独立、并行地对同一 state 求值，"Adding questions barely changes the response time"，而且 "adding more questions does not create context-rot"。
   → **这直接解掉了 Doc 自己担心的"线性成本病"**：成本从 `O(n) 次调用 × 每次全量 context` 变成 `1 次调用 × O(n) 输入 token`。
   官方模式 [`speculative fan-out`](https://docs.typesafe.ai/patterns/fan-out)：**把所有可能要问的问题一次全问，代码再决定哪些结果相关。**
2. **定价 $42/Btok ≈ $0.042/Mtok，输出免费。** 对比 DeepSeek V4.1-Flash（cache miss $0.15、cache hit $0.003 / Mtok）：**按输入 token 算比最便宜的档位还便宜约 3.6 倍**，比 Opus 级便宜约 360 倍。Doc 那个"便宜 100 倍"的假设，在这里第一次接近成立。
3. **[`confidence`](https://docs.typesafe.ai/confidence) 可阈值化。** Choice/Score 都返回概率分布的集中度（0–1），代码可直接 `if confidence < 0.6` 分流。官方三档：**高→自动执行 / 中→谨慎或确认 / 低→不要行动**。
   → 对 context 降级至关重要：**低置信时偏向保留全文**（宁可多花 token，不要静默丢信息）。
4. **它不是生成模型。** 官方明确：*"does not generate text, write code, or hold a conversation"*，而且 *"There is no `model: "jev-latest"` setting that turns your coding agent into a Jev-powered agent."*
   → **Jev 不能替代 coding agent 的 LLM，也不能生成摘要。** 它只回答"这段值不值得留 / 该给哪一档"。

**必须知道的四个限制**（都在[官方 jaggedness 文档](https://docs.typesafe.ai/model-jaggedness/jev-1.13)里）：

| 限制 | 后果 |
|---|---|
| **"Large state full of irrelevant detail" 是已知失败模式** | 不能把 64k 一股脑丢给它判；要**先做便宜 triage** 再送 |
| **"Adversarial content" 是失败模式之一** | ⚠️ **严重**：chunk 内容是工具输出/文件内容，是**不可信输入**。让一个会被注入攻击翻转的判断去决定丢弃哪些信息 = 新攻击面 |
| **"Generation" 明确列为失败模式**（"Use a generative model"） | 摘要必须另找模型 |
| **只吃文本**（无图像/音频/视频）；**CJK 准确率低于英语** | 图片类 chunk 必须先转文本；中文指令有精度损失 |

**两条硬约束**：64k = **state + 所有 questions**；32k = **state + 单个最长 question**。所以 chunk 正文在 `state`，判断逻辑在 `instructions`（官方："Separate content from questions"）。

**在 RSI-Harness 里的两个落点**：

1. **L3 的 chunk 判决器**（对象层，内联）：一个 `Choice` 判"需要多少信息"，用 `confidence` 门控降级。
2. **替换 Dream-RSI 那套脆弱的 prompt 规则**（元层，后置）：论文 Listing 2 用一大段文字教开发 agent 判断"这个失败是 `hard-unrecoverable` / `repairable implementation failure` / `weak-but-underexplored` / `repeatedly unpromising`"——**这是个典型的 `Choice` 原语**（四个选项、无序、需明确判据）。这类判断恰恰是论文最依赖大模型、最不可靠的部分。

⚠️ **但不要把它做成 coding agent 的 LLM，也不要指望它替 dsh 的主模型。** 而且它**不能**用来做"上下文层的 RSI"——那件事论文没有依据（见 §6.4）。

---

## 2. 能不能整合？—— 逐个接缝的可行性矩阵

| Doc 要的能力 | dsh 现成 | unreal-agent 提供 | Dream-RSI 提供 | 需要新建 | 难度 |
|---|---|---|---|---|---|
| 显式可审计状态 | 事件日志 + projection + invariant | **`Report{Kind,Source,Reason}` 的形状**（⚠️ 声明了但未实现，需自己填） | 节点 = 继承历史 + 快照 + 产物 + 诊断 + score | 把 dsh 的 surface node 映射成 chunk 记录 + 真填 Report + invariant | ★★ |
| Meta-attention（chunk 打分） | `agent/pre-step`（可 rewrite/reject） | `ChangeKind` 的 omitted/truncated/compacted 三档 | replay 里的 prefix-only 观测纪律 | **Scorer seam**（4 档：hide/short/long/full） | ★★★ |
| 成本/智力感知路由 | `agent/request` waterfall + `model-selection.ts` 模板 | `CacheKey`→`prompt_cache_key`/`cache_control` 的**真实 cache 感知代码** | replay 目标里的 $\beta_1$ cost 项 | **Router policy**（按 chunk 敏感度 + 任务难度） | ★★ |
| Skills/工具按需加载 | `ctx.tools` + prompt assembly + scoped 注册 | `Registry.Skills()` / `RegisterSkill` + `SkillUse` 按需加载正文 | `plan_grid` 的"决定搜索空间形状"同构 | **能力目录（catalog）seam**：小片段常驻 + 全文按需 | ★★ |
| 条件化 AGENTS.md | `system-prompt/assemble` + `PromptSection`（动态文本） | — | **§6.4 警告：语义引导会伤探索** | 条件求值器 + **免疫 compaction 的 pinning** | ★★ |
| 后台只读任务 | `ctx.jobs` + `turn-stopping` | Inbox 幂等（跨重投递） | replay = 零执行成本的"后台评估" | **共享 reads 缓存**（Doc 的关键 economics） | ★★★ |
| 并行 subagent + 共享状态 | subagent providers + `agent-team`（实验）+ `workflow` | 单线程 coordinator + actor operations（**fork 重放明确不完整**） | batch $C \in A(T;W)$ 的并行语义 + parallelism bonus | **写冲突仲裁 = lease/锁 on session nodes** | ★★★★ |
| 历史树搜索 | `session-query.traceSession`（祖先链 + 后代树） | Session fork + 版本化 | 发现树 / 可行动集 $A(T)$ | **树上的 relevance 搜索 + nested labels** | ★★★ |
| 自我改进闭环 | `goal`（256 轮续跑）+ `schedule` | 版本化 session（可 resume/迁移） | **完整闭环：explore→simulate→improve→redeploy** | **ReplayWorld seam + PolicyRuntime** | ★★★★ |
| 权限/审批可编程 | `approval` + `sandbox` + `auto-review` | translator 无 I/O（审批可在翻译期同步做！） | — | 策略化的 permission query | ★ |

**读法**：★≤2 的是"照抄 dsh 现成接缝写插件"；★★★ 是"要设计新 seam"；★★★★ 是"研究性问题，第一期可以先用外部编排绕过"。

---

## 3. 我的提议：RSI-Harness 分层架构

```
┌──────────────────────────────────────────────────────────────────────┐
│ L5  Meta-policy Layer          ← Dream-RSI 的算法内核（新写）          │
│     PolicyRuntime · ReplayWorld · DreamingLoop · PolicyStore          │
│     策略 = 可执行程序 + plan_grid(beta) + prefix-only 观测            │
├──────────────────────────────────────────────────────────────────────┤
│ L4  World Model Layer          ← 本方案的核心创新（新写）              │
│     DiscoveryTree (from session log) · ChunkGraph (nested labels)     │
│     ReplayEngine (确定性重放已记录 children) · CostModel (token-meter)│
├──────────────────────────────────────────────────────────────────────┤
│ L3  Context Policy Layer       ← Doc 的 meta-attention（新写）        │
│     ChunkScorer（4 档，载体=自定义 CompactionEngine）                  │
│     CacheAwareRebuilder · CapabilityCatalog（ToolSchema.deferLoading）│
│     JudgmentProvider seam ── judgment-jev（内联判断，TypeSafe）        │
│     Router（成本/敏感度感知）                                          │
├──────────────────────────────────────────────────────────────────────┤
│ L2  Harness Host               ← dsh（现成，只挂插件）                │
│     agent-loop · session log · tools · subagent · jobs · sandbox      │
│     approval · token-meter · session-query · skill · mcp · web UI     │
├──────────────────────────────────────────────────────────────────────┤
│ L1  State Discipline           ← unreal-agent 的契约（Rust；注意其  │
│     Change Report 是空壳，需自己实现）                               │
│     pure translator · serializable versioned operation · idempotent   │
│     input · I/O-pure context builder with typed Change Report         │
└──────────────────────────────────────────────────────────────────────┘
```

**时间维度**（这是整个框架的组织原则，也是理解各层"什么时候起作用"的钥匙）：

```
设计期           内联（每次决策）      运行时          后置（每轮之后）
─────────      ──────────────      ──────────      ──────────────
Doc            Jev                 dsh             Dream-RSI
unreal-agent   (L3 判决)          (L2 宿主)        (L5 元策略)
(L1 契约)                                            ↑ 二阶、离线、便宜
                                                     │
                          在线 rollout 产生历史 ──────┘
```

### 3.1 L4 是真正的整合点，也是唯一"非做不可的新东西"

Dream-RSI 的发现树**不需要新存储格式**——它可以从 dsh 的 session log 派生：

| Dream-RSI 概念 | dsh 里的对应物 |
|---|---|
| 节点 $v$ | 一个 turn（或一个 step），`turn/start`…`turn/end` |
| 父节点（workspace 继承） | **session fork**：`ctx.agents.create({ sessionId, seed, meta: { parentSession, seedLength } })`；`subagent-fork-in-process` 已实现"子 agent 看到父的所有已完成 turn" |
| **创建顺序**（`Child(r)` 必须是"最早创建的未揭示子节点"） | **日志的 seq 天然有序** —— `SessionSeq` 连续，这一条在 dsh 里是免费的；但在多数 agent 框架里要额外记 |
| 节点 outcome（快照 + 产物 + 诊断 + score） | `tool/result` 事件 + `assistant/attempt` + `sessionProjections` + spill locator |
| 每个决策的 cost | `token-meter` 的 `TokenMeasurement`（带 `logRevision`）+ `EpochHeader`（完整调用配置 = cache key） |
| 完整历史 $H_t$ | 一次 fork 的祖先链；`session-query.traceSession()` 直接给祖先链 + 递归后代树 |
| prefix-only 观测 | replay 时只暴露 `seedLength` 之前的日志 |
| `W`（并行 worker 数） | 在线：`subagent` + sandbox 并发上限；离线 replay：纯读，可以开很大（这是 Dream-RSI "dreaming 便宜" 的真正来源） |

**关键点：`EpochHeader` 是 cache 感知路由的钥匙。** 它包含 `config`（provider/model/effort/sampling）+ `adapterDefaults` + `tools`（assembled tool schemas）。两次请求 header 完全相同 → 前缀 cache 命中；不同 → 需重新 prefill。Doc 里那个"路由到小模型再回来会更贵"的算式，在 dsh 里**是可计算的**，因为每次 `request/header` 都有 `reason: 'initial'|'resume'|'change'|'series'` —— `startsSeries` 就是"cache 断了"的显式信号。

### 3.2 L3 落地 Doc 的 meta-attention

```ts
// 提议的 seam（示意，非最终 API）
interface ChunkVerdict {
  chunkId: SessionSeq
  tier: 'hide' | 'summary-short' | 'summary-long' | 'full'
  /** 为什么这么判：必须可审计（unreal-agent 的 Change.Reason 精神） */
  reason: string
  /** 分数来源：模型判定 / 启发式 / cache 经济学 */
  source: 'model' | 'heuristic' | 'cache-economics'
  /** 复用当前 cache 的边际成本 vs 重建的边际成本（token 计价） */
  cacheDelta?: { reuseTokens: number; rebuildTokens: number }
}

interface ChunkScorer {
  score(chunks: readonly SessionChunk[], query: UserMessage, budget: TokenBudget): Promise<ChunkVerdict[]>
}
```

实现方式（按顺序做，每步都可独立交付）：

1. **启发式 v0**：用 `token-meter` 的 `TokenSurfaceNode` 逐 node 定价 + 工具类型规则（`bash` 输出给短摘要、`fs_read` 给全文）。
2. **模型 v1**：用一个便宜模型给 chunk 打 tier（Doc 说的 "noul on every chunk"）。**注意 Doc 自己的警告：二元检查会线性累积成本** → 必须批量打分 + 只在 tier 不确定时调模型。
3. **经济学 v2**：把 Doc 的 routing 算式（$25Y + 5Z$ vs $3X + 20Y + 8Z$）变成 `CacheAwareRebuilder` 里的决策函数，输入是 `EpochHeader` 是否变化 + 当前 surface tokens + 目标模型的 prefill 价格。

⚠️ **三个必须知道的时序约束**（这些决定了 scorer 能放在哪）：
- **`agent/pre-step` 在每次请求前同步 await** —— 逐 chunk 打分不能放在热路径上。正确做法：把打分做成**上一次 turn 的后台 job**（`ctx.jobs`），在 `pre-step` 里只读缓存结果。
- **`ctx.compaction` 自己也跑在 `agent/pre-step` waterfall 里、且在请求派生之前**。所以 `ChunkScorer` 与 compaction **是同一个 waterfall 上的邻居**，必须显式约定谁先跑——否则你会同时有两套压缩逻辑在改同一个 surface。建议顺序：**先 scorer（query-aware 降级），再 compaction（兜底的 budget 压缩）**；如果 scorer 已经把 surface 压到阈值以下，compaction 应当不触发（`compactIfNeeded` 的 `trigger: 'pressure'` 会自动跳过）。
- **`tool/result` 到达时就可以打分**（不需要等下一次请求），因为 scoring 的输入是 chunk 本身 + 上一次的 user query。

**Doc 的"按需工具 schema"有一个现成开关**：`ToolSchema` 自带 **`deferLoading?`** 字段。这意味着"小片段常驻 + 全文按需"**不需要新造 catalog seam**——只要把能力目录注册成 `deferLoading` 工具即可。这是 L3 里最容易高估难度的一块，实际上是配置问题。

**"免疫 compaction"**（Doc 明确要的）：dsh 的 `system/message` 是 surface node，靠**替换**来更新（`systemPromptUpdate: 'in-history'` 可在 cached prefix 之后追加）。所以"常驻记忆"应当实现为**一个带 pinning 标记的 surface node + 在 `agent/pre-step` 里阻止它被 compaction 吃掉**（比 Skill 强，Skill 会被 compact 掉——这正是 Doc 的抱怨）。实现上要 hook `ctx.compaction` 的 `compactRegion` 选择范围，把 pinned node 排除在外。

### 3.3 L5 落地 Dream-RSI

```ts
// PolicyRuntime：策略是"可执行程序 + 显式预算"
interface ExplorationPolicy {
  readonly id: PolicyId
  readonly beta: number                       // 单一旋钮，episode 内固定
  planGrid(ctx: GridPlanningContext): GridPlan // branch_count=W, refine_count=R
  solve(q: PrefixQuestion, budget?: Budget): Promise<SimResult>
}

interface PrefixQuestion {
  reset(): void
  observed(): Record<CellId, Observation>      // 只给已揭示前缀
  legalActions(): CellId[]
  legalRoots(): CellId[]
  openedBranches(): BranchId[]
  meta(cell: CellId): CellMeta                 // .branch .attempt .parentId .seq .tags
  probeBatch(cells: CellId[], onReveal?: (o: Observation) => void): Observation[]
  readonly baselineScore: number
  readonly maxParallelism: number              // = W
}

interface ReplayWorld {                        // 从一个已完成的 session 子树的投影
  readonly rootSeq: SessionSeq
  readonly nodes: ReadonlyMap<CellId, DiscoveryNode>
  readonly costModel: CostModel                // token-meter 派生的价格
}
```

**两个实现要点**：

1. **前缀可见性靠类型保证**：`observed()` 只返回已揭示的 cell，`probeBatch` 是唯一的揭示通道。**把"不能偷看未来"做成 API 的形状，而不是靠纪律** —— 这是 Dream-RSI 论文里最容易被实现者做错的地方（也是"Policy 可能是 LLM 写的代码"时唯一可靠的约束方式）。论文本身只能靠 prompt 里的一句 "Never use unrevealed scores, a true optimum, hardcoded winning cell ids, absolute score targets, or internal trace data" —— **我们应当把它升级成类型上不可能**。
2. **`Child(v)` 的两条规则必须在 `ReplayEngine` 里写死**（这是论文里最容易漏的语义）：
   - $v \ne r$：返回 $v$ 的**唯一**已记录子节点（若存在）；否则 $\emptyset$。
   - $v = r$：返回**最早创建的、尚未揭示的**根子节点 —— 即"开一条新分支"，且顺序由**创建序**决定，不是分数序。
   在 dsh 里"创建序"就是日志 seq，免费；**但在线时节点的创建是并行的**，所以 seq 反映的是**完成/提交顺序**而非发起顺序 —— 这一点必须显式定义，否则 replay 的确定性会变成"取决于调度"。
3. **策略执行器**：dsh 已有 `ctx.ptcRuntime`（"run one model-written program against host-provided asynchronous functions"，含 Node 后端和 Python 后端 `ptc-runtime-python`）。**直接用这个跑策略代码**：语言无关、进程隔离、返回值 lossless-JSON、失败在 result 里解决而不是抛异常。这比 Dream-RSI 自己的 `see.policy.api` 更干净。
4. **两处论文内部不一致，实现时必须选一个并记录**：
   - Eq.1 用**并行奖励** $+\beta_2 N/\max(1,k)$；Listing 2 用**并行惩罚**（在 `pareto.reward = auc − λ·parallel_penalty` 里减去）。同一个意图，代数不同。
   - **Listing 2 里的 `beta`（探索强度标量）与 Eq.1 的 $\beta_2$ 无关** —— 两个不同的 beta，不要混。

**"dreaming" 的实现**：一个 `subagent` + `workflow` 编排——把 replay trajectory + 分数喂给策略开发 agent，让它改策略代码；M 个版本在同一批 world 上评估；选 $\arg\max V^m$。**注意 dsh 的 `workflow` 本身就支持 `pipeline()` 和每个 item 独立跑、无 barrier** —— 天然匹配"每个策略版本 × 每个 world 独立 replay"（$M \times t$ 个独立评估）。

**Bootstrap 顺序**（论文的 loop 在 $t=1$ 时 $H_0 = ()$ 是空的，没有 world 可 replay）：所以**第 1 轮必须用一个手写策略跑在线**，这也是为什么论文强调"两个方法 Round 1 完全相同"。实现时要有一个 `FixedParallelRefine` 作为初始策略（论文描述的 "simple parallel refining strategy"：W 个独立 workspace，各自反复精炼自己的当前候选）。

### 3.4 L1 怎么在 TypeScript 里保留

不能 import Go，但可以把契约转成 TS 判别联合 + 运行时校验：

```ts
type ContextChange =
  | { kind: 'omitted';   source: ChunkId; reason: string }
  | { kind: 'truncated'; source: ChunkId; reason: string; keptBytes: number; totalBytes: number }
  | { kind: 'compacted'; source: ChunkId; reason: string; summaryId: SummaryId }
  | { kind: 'reranked';  source: ChunkId; reason: string; tier: Tier }   // Doc 新增档
```

配上 dsh 的 **invariant 机制**（每个包可发布 `./invariant` 导出，构建期 gate 强制）→ "model-visible means logged" 这条铁律就从"文档约定"升级成"**编译期/启动期断言**"。**这是 Doc 的"typesafe"愿景在 TS 世界里最接近可行的落法。**

⚠️ **注意这里比"移植"更重**：unreal-agent 的 `Report`/`Change` **是声明了但从未填充的空壳**（`Build()` 只返回 `Result{Request}`）。所以这一层的活不是"抄过来"，而是"**在 dsh 的 surface node 上真正实现它**"——具体来说：

1. 在 dsh 侧定义一个 `surface/assembled` 事件（或用 `sessionProjections` 的一个 fold），记录**每一次请求实际组装了哪些 node、每个 node 被降级/省略/摘要成了什么**。
2. 加一个 invariant：**任何被降级/省略的 node 都必须出现在该记录里**，否则启动期报错。
3. 这样"历史可重放"才从口号变成**可验证的性质**：给定日志 + 一组 `ChunkVerdict`，能重建出完全相同的请求。

**这一步是 L3 和 L4 的共同前提**——L3（meta-attention）需要它来证明"我没丢信息"，L4（replay）需要它来证明"重放的是真发生过的请求"。**它比看起来重要，应当排在 Phase 0 一起做。**

---

## 4. 分期路线图（每期都可独立交付价值）

> 各期与 §4.2「不需要改 dsh」的核验结论一致：**全部通过仓外 bundle + 公开接缝实现。**

### 4.1 落地形态：不能进主仓，只能做外部插件族

这一节是我在拿到 dsh 逐包分析后**新加的**，因为它改变了对"整合"的操作定义：

**硬约束：`CONTRIBUTING.md:9` 明说 dsh 目前不接受外部 PR。** 所以 RSI-Harness **不可能作为 dsh 树内的一部分存在**。能走的路只有一条：**一套外部 bundle（+ 可选 client plugin），通过 `dsh plugin --profile <name> add ./<pkg>` 装进用户的 profile。**

具体机制（都有文档支撑）：

| 要做的事 | 怎么做 |
|---|---|
| 分发 | author 一个 **bundle**：`package.json` 里声明 `dsh.bundle.patch`（一个文件或有序列表）。用户侧建一个 **profile**（`$DSH_HOME/profiles/<name>`）声明 `dsh.profile.bundles` 的有序列表。**"A bundle is what you author and distribute; a profile is what a user boots."** |
| 安装 | `dsh plugin --profile <name> add ./rsi-harness`（在 profile 目录里跑 pnpm 并把包追加进列表） |
| 加工具 | `ctx.tools.register(ToolDefinition)`；`ToolDefinition` 要求 `output.{schema, render}` + `execute`，可选 `projectContent`/`finalizeContent`/`isConcurrencySafe`/`presentCall`/`presentResult` |
| 加**按需加载**的工具（Doc 的 tool-search） | `ToolSchema` **自带 `deferLoading?`** —— 这正是"小片段常驻 + schema 按需"的现成开关 |
| 加 Web UI | 声明 `dsh.client` + 导出 `./client` + 用 `ctx.slots.register({name, children, store, inject}, Component)`。⚠️ 但 `packages/client/tsdown.client.ts` **未发布**，仓外要自己复现 |
| 加持久事件（发现树的节点记录） | **declaration merging 扩展 `SessionEventMap`** —— 这就是 L4 的 DiscoveryTree 记录该待的地方，而不是另建一张表 |
| 加 runtime invariant | `packages/runtime-diagnostics` 提供**包自有的 runtime invariant 注册表** —— §3.4 那条"降级必须被记录"的断言挂这里 |
| 调试 | `pnpm run dev:web`（构建一次然后 watch）；`--patch` 覆盖任意一行做实验 |

**开发/调试的真实成本（别低估）**：
- 完整冷构建是 **267 个 host project reference + 80 个 client**、约 120 个 rolldown bundle、外加 Vite —— **分钟级，是仓库里最重的单个操作**。文档里提到覆盖率 gate "has taken about 27 minutes"。
- ⚠️ **`pnpm --filter <pkg> test` 不工作**（311 个包里 0 个声明 `test` script）。按包跑测试要用 **vitest 路径过滤**：`pnpm exec vitest run packages/core/agent-loop`（不要在 `pnpm run <script>` 后面加裸 `--`，它会传到 vitest 并可能禁用 `-t` 过滤）。
- 测试约定是 **只有 `*.spec.ts`，仓库里零个 `*.test.ts`**（1,745 个 spec）。

**发布时的一个安全注意点（这条值得单独说）**：如果走 git 安装，pnpm 会在安装后跑你包的 `prepare` 脚本，用户还必须把它加进 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds` —— dsh 文档自己把这一步标注为 *"permission to execute the package's code on your machine at install time, outside any sandbox the agent runs under"*。**这是安装期的任意代码执行，绕过了 agent 运行时的所有 sandbox。** 对 RSI-Harness 这种要装进别人 profile 的东西，**优先发 tarball / 走 registry**，避免强迫用户开 `allowBuilds`。
另外：需要与 dsh 共享实例的 dsh 包，必须**同时**声明在 `peerDependencies` 和 `devDependencies` 里（否则会加载出第二份 module singleton）。

**这对路线图的含义**：Phase 0 的 `dsh-rsi-trace` 应当是**一个独立的仓外 package**（bundle），**不 fork dsh、不打补丁**。如果哪天发现某个改动必须进 dsh 树内（例如要改 agent-loop 的 request 派生），那就是一个**必须先解决的阻塞点**，而不是可以绕过去的事——因为 PR 通道是关的。**建议在 Phase 0 就主动验证：L3/L4/L5 三层是否真的都能用 waterfall + 事件 + declaration merging 实现，而不需要改 loop 内部。** 如果验证失败，整个方案的形态需要重新考虑（比如改为 fork dsh 并长期维护）。

**好消息**：至少 Doc 最核心的三件事都不需要动 loop —— meta-attention 走 `agent/pre-step` / `agent/request`，按需工具走 `deferLoading`，发现树记录走 `SessionEventMap` 扩展。

---

### 4.2 接缝核验：确认不需要改 dsh

动手前把每个要用的接缝对着源码核了一遍。**结论：全部是已声明的公开扩展点，没有一个需要碰 dsh 的 `src/`。**

| 要做的 | 用什么 | 证据 |
|---|---|---|
| 发现树节点记录落盘 | `SessionEventMap` declaration merging | `compaction`（`compaction/*`）和 `hook-protocol`（`hook/invoked`、`hook/result`）都是 in-tree 先例 |
| 树谱系（持久的真相） | `meta.parentSession` + `meta.isSeeded` + **`Session.inheritedEventCount`** | `CreateAgentOptions.meta` 是公开字段（`packages/core/agent/src/index.ts:63-95`） |
| 从**任意**祖先节点 fork | `ctx.agents.create({ seed, inheritedEventCount, parentAgent, meta })` | `seed` 是**公开选项**，且"the factory validates and snapshots the seed before publication" |
| 树索引（可重建、不对模型可见） | `ctx.storageDomain` + `defineDomain` | 公开 host-side；"remains invisible to the model and agent loop" |
| 大字节 / 产物 | `ctx.spillStore` | **有 in-tree 先例**：`fs/tool-fs-search/src/search-core.ts:393`、`context/session-reference/src/index.ts:332` 都这样 `ctx.get('spillStore')` |
| 内联判断 | `agent/pre-step` / `agent/request` / `tools/pre-execute` | waterfall，公开 |
| 后台打分 | `ctx.jobs` | 公开 |
| 策略代码执行 | `ctx.ptcRuntime` | 公开 seam |
| 离线批处理 | `ctx.schedule` + 自己的 bundle | 公开 |

**最让人放心的一条**：`subagent/subagent-fork-in-process/src/index.ts` 的 `completedTurnPrefix()` —— **fork 就是"在 provider 里切一段前缀当 seed + 下达 prompt"，完全是 in-tree 的正常写法。** 本方案要做的是这个模式的直接推广：它切"最后一个 `turn/end`"，我们切"任意一个已记录的祖先节点"。

### 三个必须知道的摩擦（都不是阻塞）

1. **`meta` 没有自定义字段位。** 它只接受 `cwd / parentSession / isSeeded / origin / delegationDepth / agentPreset`，**不能把 nodeId 塞进去**。
   → 解法反而更干净：**`sessionId` 本身就是节点身份，父子关系用 `meta.parentSession` 表达（这是持久的真相）**，其余节点属性（创建序、score、status）放自己的 sidecar 索引。**不需改 dsh。**

2. **`ctx.compaction` 是单服务，L3 的 scorer 会撞上 `compaction-basic`**（两者都 `super(ctx, 'compaction')`）。所以 L3 要么在 profile patch 里替换那一行（推荐的 in-tree 做法），要么先不做。**L1/L4/L5 完全不受影响**——这也是把 L3 的优先级排在后面的又一个理由。

3. ~~**未核验**：per-session 的策略绑定可能要走 `agentPreset` + `isolate` realm。~~ → ✅ **已实测，且风险解除**（`PHASE0-VERIFICATION.md` V1 + `phase0/v1-preset-isolation.spec.ts`，2/2 通过）。

   **结论与直觉相反，但更好**：`isolate` 隔离的是**跨 preset**，不是跨 Agent——同 preset 的多个 Agent **共享一个挂载 fiber**，`serviceFor()` 返回**同一个实例**（`AgentPresets.retain(id)` 按 preset 缓存 generation，`packages/preset/agent-preset-registry/src/index.ts:194-210`）。

   **所以 per-session 状态本来就不该放在 preset service 里。** 正确落点是 dsh 本来的两个机制：

   | 放什么 | 放哪 |
   |---|---|
   | session 键控的持久状态（树索引、score、判决、policy 版本） | **`ctx.storageDomain`，按 `sessionId` 键控** |
   | per-agent 注册（工具、事件监听、prompt section） | **`agent.ctx`**（scoped，"a tool registered through `agent.ctx` is visible only to that agent"） |

   preset 的正确用途是承载**"哪些 capability 进这个 session"**，不是承载状态。**这也意味着 §5.2 的三分存储方案得到了直接证据支持，而不是推测。**

   顺带一个额外好处：`mount.spec.ts` + `loader-composition` 类测试证实 preset 的 `plugins` 支持**嵌套 group 行**和 **`disabled: { __jsExpr: 'true' }` 条件行**——所以"哪些 RSI capability 进这个 session"可以是条件化的。

### 4.3 路线图

**Phase 0 是唯一一个"错了就要重来"的阶段**——它同时承担三件事：证明树可从日志派生、把 `surface/assembled` 审计真正做出来、以及验证上面那条未核验的摩擦。

#### Phase 0（1–2 周）：把 dsh 变成可观测的发现器
- 挂一个 `dsh-rsi-trace` 插件（仓外 package + `dsh.bundle.patch`）：订阅 `session/event`，把 turn/step/tool/usage/header 落成发现树索引（`ctx.storageDomain` + SQLite 后端）。
- **树谱系的真相用现成字段**：`meta.parentSession` + `meta.isSeeded` + `Session.inheritedEventCount`；其余属性（创建序、score、status）进 sidecar 索引。**不改 dsh。**
- 不改任何 loop 行为。**目标：证明"发现树可以从日志派生"**。
- 产出：一棵真实的树 + 一份 cost 报告（每个节点的 token 价格来自 `token-meter`）。
- **同时做 §3.4 的 `surface/assembled` 记录 + invariant**（unreal-agent 那里是空壳，这里必须真做）。验收标准：给定日志 + 一组 `ChunkVerdict`，能重建出字节相同的请求。
- ✅ **§4.2 的第 3 条摩擦已验掉**（见 `PHASE0-VERIFICATION.md` V1）：per-session 状态走 `storageDomain(sessionId)` + `agent.ctx` scope，不需要"每 session 一个服务实例"。

#### Phase 1（2–4 周）：ReplayWorld + prefix-only question
- 实现 `ReplayWorld`（从 session 子树投影）+ `PrefixQuestion`（严格前缀可见）。
- **从任意祖先节点 fork**：用 **`ctx.agents.create({ seed, inheritedEventCount, parentAgent, meta })`**（⚠️ **不是** `ctx.agentLoop.create` —— 后者是测试简化入口，**不接受 seed**）。这把 in-tree 的 `completedTurnPrefix()` 模式从"最后一个 `turn/end`"推广到"任意已记录节点"。**已实测通过**（见 §5.3.1）。
- 用**手写的两个策略**（serial vs full-batch）在已记录的树上 replay，复现论文 Eq.1 的 $V$ 打分。**这是 dry replay：零执行成本。**
- **验收标准：replay 的 $N_i^m$ 和 $k_i^{m,\star}$ 与在线记录一致**（这验证了模拟器的保真度）。
- 此时**还没有任何自我改进**，但你已经能"零执行成本地评估一个探索策略"。

#### Phase 2（4–8 周）：Dreaming 闭环（最小版）
- `PolicyRuntime` 跑模型写的策略代码（用 `ptc-runtime`，含 Python 后端）。
- 一个 `workflow`：propose M 个策略版本 → 在同一批 world 上 replay → 选最优 → **在新 session 上在线部署**。
- β 网格扫描 + `plan_grid`；**注意论文内部两处不一致**（Eq.1 的并行奖励 vs Listing 2 的并行惩罚；Listing 2 的 β 与 Eq.1 的 $\beta_2$ 无关），实现时选一个并记录。
- **必做**：`Child(v)` 的两条规则写死在 ReplayEngine 里（$v\ne r$ 取唯一已记录子节点；$v=r$ 取**最早创建的**未揭示子节点），并**对 out-of-support 的 `plan_grid` 请求显式报错**，不要静默变成没梯度的搜索。
- 验收：**在固定历史上，第 t+1 轮的策略评分 ≥ 第 t 轮**（论文的单调性保证应当可观测）。

#### Phase 3（并行/可在 Phase 1 后启动）：L3 的 context 策略
- **载体是自定义 `CompactionEngine`**（不是 `agent/pre-step`——那里明确不能改 message）。用 `surfaceOp: { op:'replace' }` + `sourceEventSeqs` 做降级，用 `confidence` 门控。
- ⚠️ **需要替换 profile patch 里的 `compaction-basic` 行**（`ctx.compaction` 是单服务）——这是 L3 排在后面的又一个理由（见 §4.2 摩擦 2）。
- `ChunkScorer` v0 先做**启发式（零模型成本）**；Jev 只在"不确定的中段"用，且必须在 `tool/result` 时异步算、`pre-step` 只读缓存。
- `CacheAwareRebuilder`：用 `EpochHeader` 变化检测 cache 断裂 + `shadowedTokenCount` 做成本决策。
- `CapabilityCatalog`：**用现成的 `ToolSchema.deferLoading`**，不用新造 seam。
- 验收：**同等任务质量下 prompt tokens 下降**，且 cache 命中率不降。

#### Phase 4（探索性）：后台只读任务共享 read-set
- Doc 的 "reads 缓存在后台任务间共享"：把"找相关信息"的结果做成可复用的 read-set artifact（`ctx.jobs` + session-reference 快照）。
- ⚠️ **不需要写冲突仲裁**——发现树是**树**（每个节点一个父，兄弟是独立探索），水平方向只有**读共享**。早先版本里那个"lease/锁 on session nodes"是过度设计，已降级（见 §5.4）。

#### 贯穿全程：workspace 快照（§5.5）是唯一的"必须新建"
它不属任何单独一期，而是 Phase 1 的**前置依赖**（没有 workspace 快照，node 就不是可恢复的 world）。建议 Phase 0 就先立起 per-node 目录 + 硬链接 CoW 的骨架，Phase 1 再加旁路 git 做 diff 与 GC。

---

## 5. 存储与信息共享

### 5.1 核心矛盾，以及它为什么其实不矛盾

Dream-RSI 要求"world 不可变、可被多个策略反复遍历"，而 dsh 的日志是 append-only、**每个 session 只拥有自己的事件**。看起来冲突，实际上互补：

| Dream-RSI 要的 | dsh 的天性 |
|---|---|
| world 一旦记录就不再改变 | **append-only 天然不可变**：已提交的 generation 路径"永不改名或删除" |
| 多个策略遍历同一棵树 | 用**派生**读，不改原日志 |
| 节点带完整结果 | `assistant/attempt` 内嵌**精确的原始流**，不是摘要 |

> **结论：不要另建一套存储。世界就是 session 日志。**

### 5.2 三个存储，各管一件事

| 存什么 | 用什么 | 为什么 |
|---|---|---|
| **真相**：模型看到的一切、工具结果、决策、用量 | `ctx.sessionPersistence`（JSONL + zstd frame + fsync + v1→v4 迁移链） | 已有、崩溃安全、**"model-visible means logged" 自动生效** |
| **索引**：`(tree, branch, attempt, parent, seq, sibling_order, score, status)` | **`ctx.sessionProjections`**（✅ 已实测；不是 `storageDomain`——见 §5.2.2） | 它是**投影，不是真相**——可以从事件流重建 |
| **字节**：产物、eval 输出、被遮蔽的原文 | `ctx.spillStore` | 按设计不进 context，返回 locator |

**三条由此推出的硬规则：**

1. **不引入"平行的持久化事件类型"**（dsh 的原话）。发现树的节点记录必须是 **`SessionEventMap` 的 declaration-merged 扩展**，不是独立表。
2. **索引坏了永远能重建**——因为真相在只追加的日志里。这让索引可以放心地为查询性能而设计。
3. ⚠️ **`spill` 明确"不提供 retention、replacement、retrieval 或 search"——即没有 GC。** 而 fork 出的子会话**继承父已有的 locator，artifact 不复制也不重新归属**。所以长命发现树里的 artifact 生命周期必须**跨整棵后代树做引用计数**，在**树根级别 GC**。这是要自己写的东西。

### 5.2.1 ✅ 已实测：请求可从日志复现，但**派生是"日志末端"**

`PHASE0-VERIFICATION.md` V3（`phase0/v3-request-reconstruction.spec.ts`，3/3 通过）证实了 §5.2 的赌注：**每个真实请求的 messages 逐条等于 `session.deriveMessages()` 的对应前缀**，tool schema 也能从 `request/header` fold 回来。

**但它同时钉死了一条 L4 必须遵守的约束**（这条以前只是设计意图）：

> **`deriveMessages()` 返回的是日志末端的 surface。** 所以在**某次 `surfaceOp.replace` 之前**发出的请求，**不是**替换后派生的前缀——实测负向对照已确认。

**含义**：

| 错误做法 | 正确做法 |
|---|---|
| 读最终派生 + `slice(0, n)` 得到历史时刻的请求 | **把日志重放到那个 seq 为止**，再取派生 |

也就是说，**replay 引擎不能是"读最终状态 + 截取"，必须是一个按 seq 前进的重放器**。这正是 Dream-RSI 的 `prefix-only` 观测在工程上的对应物，也是为什么 §5.7 的 dry replay 需要按节点 seq 逐个重建。

**附带确认**：替换**只遮蔽、不删除**——被 shadow 的原文仍在 `snapshotEvents()` 里。所以"模型侧精简 + 原始 transcript 完整"是 dsh 的既有性质，L3 不需要自己实现。

### 5.2.2 ✅ 已实测：发现树是日志的投影（并修正了存储方案）

`PHASE0-VERIFICATION.md` V2（`phase0/v2-tree-projection.spec.ts`，2/2 通过）证实了发现树的落脚点，并**修正了本节的方案**：

**修正 1：用 `ctx.sessionProjections`，不是 `ctx.storageDomain`。**

`ctx.sessionProjections.register(definition)` 就是 dsh 提供的"可重建折叠"机制——纯函数 `apply`（无兴趣的事件必须返回**同一引用**）、`stateVersion` 做缓存失效、`stateSchema` 校验、配套 invariant 模块。**它比自建 domain 更贴合 dsh，且自动获得持久化缓存。**

**修正 2（新的实现契约）：fold 必须区分"创建字段"与"可更新字段"。**

第一次写 fold 时，后来对同一节点的 `rsi/node` 更新把 `seq` 和 `turns` 重置了——于是 **`Child(r)` 赖以工作的创建序丢了**。正确语义：

| 字段 | 语义 |
|---|---|
| `seq`（创建位置）、`turns` | **create-only**，后续更新不得覆盖 |
| `status`、`score` | 可被后续事件更新 |

这不是 dsh 的要求，是**树语义自己的要求**，应写进 L4 的实现契约。

**另一个关键实测结果**：**谱系从 `init(header, inheritedEventCount)` 的 `header.parentSession` 读出，不来自任何事件**；且 fold 严格受 `inheritedEventCount` 约束——**父的 `rsi/node` 物理上在子的日志里，但不在子的树里**。这给了垂直共享一个干净的实现：**子树的根边界是免费的**。

### 5.3 树怎么长出来：fork = 借用前缀，不是复制

`buildForkSeed` 的语义是关键：

- 子会话的日志**物理上包含**父的已结算前缀；
- 但只给新增事件打 `{ inherited: true }` 标记；
- `Session.isSeeded` + **`Session.inheritedEventCount`**（注意：后者是 Session 上的**存储元数据**，**不在 header 里**）**精确保留 fork 切点**；
- 所以有 `eventsAfterSeed()` 和"某位置是否在继承前缀之外"的判定。

**含义：模型可见的历史不做深拷贝，"继承的"与"本次新增的"在日志层就能分开。** 这正是论文要的"节点继承父的累积历史"。

两个必须定死的规则：

- **fork 点必须是 turn 边界**（provider 就是这么做的：seed 到最后一个 `turn/end`；"the current tool-call turn is unbalanced and cannot be replayed as a valid child session"）。所以 **"一个节点 = 一个 turn"** 这个映射要定死，否则树会漂移。
- **论文的 `Child(r)` 要求"最早创建的未揭示子节点"** → 即**创建序**。要显式记在索引里（`seq` / `sibling_order`），不要依赖文件系统或 sessionId 的字典序。

### 5.3.1 ✅ 已实测：可从任意祖先节点 fork（含两个必须记住的坑）

`PHASE0-VERIFICATION.md` V4（`phase0/v4-fork-arbitrary-node.spec.ts`，2/2 通过）证实树能从**任意已记录的 turn 边界**分叉，而不只是会话末尾。

**断言与结果**：fork 在第 1 个 `turn/end`（不是末尾）→ `header.parentSession == 'parent'` ✅、`Session.inheritedEventCount` 精确等于切点 ✅、**恰好一个** inherited 标记且在切点上 ✅、**子会话能看到 turn 1 但看不到父的 turn 2** ✅、非连续 seed 与缺失 inherited count 都会被**明确拒绝** ✅。

**两个必须记住的坑**（都踩过）：

1. **入口是 `ctx.agents.create(CreateAgentOptions)`，不是 `ctx.agentLoop.create`。** 后者签名是 `create(id, options: AgentOptions, meta: {cwd})`——**根本不接受 `seed`**。我第一次传错，结果是得到一个 `isSeeded:false`、**零事件**的空会话，而且**不报错**。
2. **`inheritedEventCount` 必须等于 `seed.length - 1`，不是 `seed.length`。** 因为 `buildForkSeed` **已经**在 `boundary + 1` 处追加了 `{ inherited: true }` 标记，所以这个 count 要指向**那个标记本身**。传 `seed.length` 会越过它，构造函数检测不到标记 → **再追加一个**，结果是 markers=2、totalEvents=13（正确应为 markers=1、totalEvents=12）。

**第 2 条尤其危险**，因为它在功能上"看起来能跑"——多一个标记不会立刻报错，但破坏 `inheritedEventCount` 与标记位置的一致性，会让后续按切点做前缀判定/重放的代码悄悄错位。

**另外**：`inheritedEventCount` 是 **`Session` 上的存储元数据**，**不在 `SessionHeader` 里**（header 只有 `isSeeded` / `parentSession` 等）。文档里写成 header 字段是个常见误解。

### 5.4 信息共享：两种机制，别混用

| | **垂直（父→子，沿树）** | **水平（兄弟之间）** |
|---|---|---|
| 机制 | **fork seed**（借用日志前缀 + 继承的 spill locator） | **session-reference**（一次性冻结快照，canonical URI + `inheritedEventCount`） |
| 语义 | 子继承父的全部已结算历史 | **快照，不是活链接**——兄弟互相看不见 |
| 用在哪 | 每个发现节点的创建 | 跨树复用、后台只读任务共享 read-set |
| 需要锁吗 | **不需要**（single-writer per session；第二把 `open(id,'write')` 直接拒） | **不需要** |

**关键设计决定：兄弟分支之间不共享可变状态，不需要写冲突仲裁或 lease。**

发现树是**树**——每个节点一个父，兄弟是独立探索。所以**没有写冲突，只有读共享**，而读共享用 fork seed + 继承 locator 就够了。Doc 要的"共享状态 + 锁"只在**后台只读任务**那个场景才需要，而那里**真的没人写**，所以也不需要锁。

### 5.5 硬缺口：workspace 快照没有归宿

论文的节点是"继承历史 + **文件系统快照** + 生成产物 + 评估诊断 + 分数"，其中前三项里**只有文件系统快照无处安放**：

- 继承历史 → ✅ fork seed
- 生成产物 / 诊断 → ✅ spill
- 分数 → ✅ 索引 + 事件
- **文件系统快照 → ❌ dsh 完全没有**

两条证据说明必须自己解决：
1. dsh 的沙箱是**纯文件效果的 per-call 策略**，`workspaceRoot` 来自"calling session 的**不可变 cwd**"；它**不做 CoW / snapshot / 回滚**。
2. `danger-full-access` 模式下消费者**根本不调用 `ctx.sandbox`**，直接 spawn 原始 argv——不能指望沙箱兜底。

**方案（按优先级）**：

- **首选：per-node 目录 + 增量**。每节点一个独立 cwd（`workspaces/<node_id>/`），父→子用**只读硬链接树**（`cp -al`）+ 写时复制（工具写文件时断开硬链接）。存储量 ∝ 实际改动。这也和 dsh 的模型一致：**沙箱的 cwd 本来就是 per-session 的。**
- **加分项**：每节点把 workspace 状态记成一个 commit，放进一个**独立的 bare 仓库**。好处：parent→child 的**真实 diff 免费**（而论文的策略判断恰恰需要 `delta_vs_parent` / `delta_vs_baseline`），且 GC 交给 git 对象存储。
- ⚠️ **绝不能**在 agent 自己的 workspace 里做这套 bookkeeping commit——那会让 agent 的 `git log` / `git status` 说谎。必须旁路仓库。
- **不要用 overlayfs**：macOS 没有，而 dsh 的沙箱本来就支持 Linux Landlock + macOS Seatbelt + Windows ACL 三平台；锁死在 Linux 会丢掉 dsh 的一半价值。

### 5.6 反直觉的一条：发现树**不该**待在 transcript 里

如果每个节点的摘要都进 agent 的对话上下文，它会撑爆 context、还会撞上 thinking budget——**而 Doc 自己的观察正是"简单二元检查做不到"**。所以：

> **发现树的索引活在 `ctx.storageDomain` 里，不进 transcript；agent 通过工具按需查它。**

这恰好实现了 Doc 想要的"让历史一直在记忆里、但又不占 context"——**结构化索引常驻、transcript 精简**。也和 `ToolSchema.deferLoading` 一脉相承：小片段常驻、完整内容按需。

### 5.7 一个诚实的天花板：dry replay vs wet fork

**Replay 只能重放已记录的结果，永远不能生成新结果。** 这是论文自己承认的最尖锐限制（*"a policy can only be dreamt where history actually went"*）。所以存储架构必须支持两种模式，且要分清：

| 模式 | 成本 | 能回答什么 |
|---|---|---|
| **Dry replay**（只查历史） | **零执行** | 算力分配假设（论文的 $V_i^m$） |
| **Wet fork**（真跑） | 真实算力 | 上下文降级 / 分支策略的**因果**效果 |

**两级结构：先 dry 筛，再 wet 验。** 早先讨论过的"成对 fork 实验"属于 **wet fork**——它贵，所以**只在 dry replay 指出有希望的策略上做**。

---

## 6. 风险与反对意见（这一节比上面都重要）

### 6.1 ⚠️ Dream-RSI 的提升幅度比 headline 小得多，且平均是靠单点撑的
- 数学优化：Sum–Diff 只从 1.144047 提到 1.145427（**+0.12%**）；**Autocorrelation 退化**（1.456375 vs 自己的 fixed baseline 1.456001，且输给 SimpleTES 的 1.453675）；Circle Packing **完全打平**。
- Lasso：平均 1.22× 的改善，在 Gemini-3.1-Pro 上来自 **6 个 held-out 数据集里的 1 个**（RCV1），另外 4 个更差。
- **没有 seeds、没有 repeats、没有 error bars**，全篇单次运行数字。
- 成本核算只有一面：只数了 discovery-agent calls，**replay 的算力、策略开发 agent 的 token、wall-clock 全部没报**。
→ **Dream-RSI 的价值主张是"同等质量下省钱"（1.74× less compute / 2.43× fewer generations），不是"发现更好的东西"。** 如果 RSI-Harness 的卖点是能力提升，它撑不起来；卖点是成本，它有料——但你必须自己补上 replay 那一侧的成本核算，否则"零成本模拟"是个未经检验的假设。

### 6.2 ⚠️ 没有代码，且缺的是最难的工程部分
README 的 Release plan：Paper ✅、Website ✅、arXiv 🔜、**Discovered programs ⏳、Full codebase ⏳、Reproduction scripts ⏳**。**唯一已发布的产物是附录 C 里的一个 Lasso solver**（`COMPILE_FLAGS = ["-fopenmp","-ffast-math"]`，Eigen + OpenMP，stdin/stdout 二进制协议）；kernel 与 math 的产物都没有。

论文**完整**给出的：决策接口、replay 语义（含 `Child(r)` 的非对称规则）、目标函数 Eq.1、选择规则与它的单调性论证、以及**面向 LLM 的真实 prompt 模板（Listing 1–2，读起来就是线上系统的原文）**。

论文**没给**的（你必须自己发明，这是"实现"而非"集成"的原因）：
- **数据结构与存储格式**：没有节点 schema、序列化、索引。只能从 Listing 2 泄漏的目录名反推：`attempt_*/proposal.md`、`$eval_program`、`eval/score.json`、`error.txt`、`history_dir/r####_*/`、`history_dir/baseline/`、`trace_pool/iter*/`、`live_cycle_manifest.json`、`proposal_results/beta_sweep.json`、`policy_execution_traces.jsonl`。
- **编排层本身**（论文只声明它存在）：orchestrator 如何拦截 coding agent、如何物化/恢复每个节点的 workspace 快照、如何强制 `W` 并发上限、如何把 batch 变成 ≤W 个并行调用、如何强制"只许写 `$node_dir/proposal.md` 和 `$node_dir/$eval_program`"。
- **Sandbox / eval 基础设施**：没有容器化、隔离、超时、内存、OOM、GPU 分配策略；`fail_class` 分类法**没有定义**（只给了例子）；kernel 计时协议（warmup / 重复次数 / clock）未说明。
- **所有关键超参**：$M$、$K_2$、$\beta_1$、$\beta_2$、beta 扫描网格、$\lambda$、`hard_max_branch_count`、`hard_max_refine_count` —— **全部缺失**。只有 $K_1$ 和 $W$ 给了（10×11 与 32×20 两种基线配置）。
- **`see.policy.api` / `see.policy.observation_signal`**：被引用但从未定义，"see" 也没展开。
- **统计协议**：无 seeds、无 repeats、无方差、无显著性。
- **dreaming 本身的成本**：replay 的 wall-clock、token 消耗、以及"replay 何时不再可忽略"的交叉点，**全部没报**。论文宣称 replay 是 "negligible execution cost"，但**没有证据**。

→ **"整合 Dream-RSI"实际上是"实现 Dream-RSI"。** 好消息：本方案的 L4 设计正好填它的工程空白，而 Listing 2 的 API 名（`legal_roots` / `opened_branches` / `probe_batch` / `plan_grid` / `GridPlan` + beta schedule）是可直接照抄的契约。

### 6.3 ⚠️ 前缀可见性 / 分布漂移 / 支持集边界

Replay 假设"已记录的 children 就是策略在在线条件下会得到的结果"。但：

1. **覆盖率硬边界（最尖锐的限制）**：replay **永远不能**（a）到达 $\mathcal{T}_i$ 之外的任何节点；（b）在同一分支内乱序——"each branch is traversed in its recorded parent–child order"；（c）凭空造一条已记录 root children 之外的分支；（d）在支持集外的 grid 上拿奖励——论文原话 "a requested plan beyond the frozen trace's `context.trace_branch_count` or `context.trace_refine_count` is out of support and cannot earn replay reward"；（e）看未揭示信息；（f）捕捉"同一个已记录 cell 上换一个 proposal"的反事实。
   → **含义：Dream-RSI 只能优化"怎么分配算力"，永远不能优化"想什么"。** 这与 Doc 的期待（更聪明的探索）之间有真实缺口，必须在产品叙事上说清楚。
2. **在线 transition 是随机的**（论文自己说 same workspace → different outcomes）。Replay 把它变成**确定性**的 → simulator **系统性低估方差**，会偏好"在历史上看起来稳"的激进策略。论文没有这个修正机制（$H_t$ 是无权重累积）。
3. **分布漂移**：策略变了 → 产生的树分布也变 → 历史池的分布不再代表当前策略面对的世界。论文没处理。**而且因为 $V^{m^\star} \ge V^0$ 只在"固定历史"上成立（replay-local 保证），在线是否真的不退步是没有保证的。**
4. **实现时必须守的边界**：out-of-support 的 grid 请求"只是拿不到奖励"——**如果不在代码里显式拦截，它会静默地变成一个没有梯度的搜索**。论文只靠 prompt 里的警告。

**缓解方向（本方案相对论文的可改进点）**：给 world 加时间衰减权重 + 在 $V$ 上用置信下界（UCB 风格）而不是纯平均 + 对 out-of-support 的 `plan_grid` 请求**显式报错**（fail loud，正是 dsh 的 `UNSUPPORTED_CAPABILITY` 风格）。

### 6.4 ⚠️ 与 Doc 的正面冲突：条件化 system prompt vs "历史只能用来 replay"

Doc 想要"conditional system messages / AGENTS.md：常驻记忆、免疫 compaction"。

Dream-RSI 的**唯一一个组件消融**（论文 §5.1, Fig. 5, ConvDiv）恰好打在这上面：把历史抽象成"高层方向性洞见"注入 prompt 作为显式语义指引（`+ Guidance`），在 **Dream-RSI 和 Fixed Exploration 两个范式下都一致地更差**（等预算）。作者结论：*"imposing strong semantic inductive biases regarding future search directions tends to over-constrain the search space and impede diverse exploration."*

**这条消融的含义比论文自己写的更强**：增益来自 **replay（把历史当可交互的模拟器）**，而不是 **history-as-context（把历史当文本读）**。这也和 Fig. 6 的现象一致——学到的策略表现出的行为模式（先省算力、plateau 时再加探索）**不是任何 prompt 能描述出来的**，它是从 replay 反馈里优化出来的。

→ **不是矛盾，是必须做分工**：
- **事实性 / 约束性内容**（style guide、footgun、API 契约、目录结构）→ 适合常驻 pinning。这类内容**不改变搜索方向**，所以不会触发上面的过度约束效应。
- **方向性 / 策略性内容**（"上次这条路走不通，往那边试"、"优先改 hot loop"）→ **绝不能**塞进 prompt。应当做成 replay world 里的一个节点，让策略从 $V_i^m$ 的反馈里自己学出来。

这正好解释了 Doc 自己的困惑："skill 是 do this now，我想要 have this in memory somewhere"——**但"在记忆里"的东西必须是不带方向偏置的**。Doc 的 conditional AGENTS.md 想做两件事（省 token + 传方向），第二件是反效果的。

> 延伸：Doc 说"skill 会被 compaction 吃掉，所以我要 pinning"。正确的结论不是"pin 住 skill"，而是**"pin 住事实，让方向性知识走 replay"**。这也是为什么 rsi-harness 的 L3（context 策略）和 L4（world model）必须是两层而不是一层。

### 6.5 ⚠️ 与 Doc 的另一处冲突：KV cache
Doc 的整个框架建立在"假设没有 KV cache"上。但 dsh 已经有 `systemPromptUpdate: 'in-history'`（**明确为了在 cached prefix 之后追加而存在**）、`EpochHeader`（cache key）、`assistant/attempt`（保留失败/重试流的精确字节，同样是为了 cache 复用）。
→ 无视 cache 会做出**比现有产品更贵**的东西。正确姿势：**cache-aware**（把 cache 复用当作一个被优化的资源），而不是 cache-agnostic。Doc 自己也留了后门："re-using existing KV cache is fine + natural and we should be making educated cost-aware decisions"。

### 6.6 ✅ 语言分裂：已判定，Rust 用在 L1 + L4

dsh = TypeScript；unreal-agent = Go；Dream-RSI 参考实现 = Python；工作目录叫 `unreal-rust`。**这条已经从"风险"变成"决策"了。**

**先把两条错路排除：**

- **把 dsh 移植到 Rust**：dsh 是 **54 group / 307 leaf package**（不可约产品 ≈170 包）、Web/Desktop/ACP/SDK 四端、session 格式 v0→v4 迁移链、Electron 宿主、pnpm 插件事务。**这是"重新实现一个产品"**，不是整合项目的范围。而且**重写它零研究价值**——它是可替代的工程，不是 RSI-Harness 的贡献。
- **把整个 unreal-agent 移植到 Rust**：手写 11,482 LOC + 19,401 行生成的 OpenAI wire types。移植完你得到的是**没有上下文管理、没有路由、没有并行、没有权限、没有 UI** 的 harness——恰好是 dsh 最不缺的那部分。而且最该照抄的 `coordinator/loop.go`（**一个 `select` 管 5 个 channel**）在 Rust 里要重新设计（`tokio::select!` + `&mut` 借用 + cancel-safety 审计），**你会在最该照抄的地方被迫重新发明**。

**Rust 真正值得用的两块：**

**L1 的状态纪律内核**（约 6.5K LOC：`contextbuilder` 226 + `tool` 契约 811 + `inbox` 198 + `session` 26 + `operation` 2250 + `coordinator` 1019）。理由不是性能，是**类型能表达 Go 表达不了的那个核心约束**：

- **"translator 里不许 I/O" 在 Go 里只是注释**（`Translate(Context, llm.ToolCall) CallStatus` 的 `Context` 是个普通 interface，谁都能塞数据库进去）。Rust 里可以做成**不实现任何 I/O trait 的 capability 类型**（私有字段 + 只暴露 `submit()`），**让"翻译期做 I/O"变成编译错误，而不是 code review 项**。这才是 "typesafe" 这个词真正兑现的地方。
- tagged union：Go 用 `any` + 运行时 switch（`sessionstore/itemjson.go`、`llm/itemjson.go` 各写一遍），Rust 一个 `enum` + 穷尽性检查。
- 版本化 wire format：`operation.Spec{Type, Version, State}` → `#[serde(tag="type")] enum` + `deny_unknown_fields`，未知版本在**反序列化**就拒。
- newtype：`operation.ID`/`session.ID`/`TurnID` 在 Go 里都是 `type X string` 可以互换；Rust 私有字段就不可互换。

**L4 的 replay 引擎（真正的靶心）。** 理由**不是性能，是形态匹配**：Dream-RSI 的 replay 是 `M × t` 次独立模拟，且有三个已证明的性质——**零 I/O**（"requires only reading past records"）、**只有读、没有写冲突**（平凡可并行）、**递归树遍历**。纯函数、可大规模并行、无 I/O 的树遍历内核**就是 Rust 的靶心**。

**注意最后一点的重要含义**：**Go 那 10.6K LOC 对 L4 几乎零贡献**——replay 是 unreal-agent 完全没有的东西。所以"Rust 移植"和"做 replay 引擎"是**两件独立的事**，不要混为一谈：前者是买类型安全，后者是买形态匹配。

**分工定案：**

| 层 | 语言 | 理由 |
|---|---|---|
| L1 状态纪律 | **Rust** | 类型能表达 Go 表达不了的"无 I/O 边界" |
| L2 宿主 | **dsh / TS**（已存在） | 重写零收益；且 PR 通道是关的 |
| L3 context 策略 | **TS 插件** | 必须住在 `ctx.compaction` / `agent/pre-step` 里 |
| L4 replay 引擎 | **Rust** | 纯读、可并行、树遍历、无 I/O |
| L5 策略运行时 | **TS 编排**（策略代码交给 `ptc-runtime`） | 策略是模型写的程序 |

**验伪实验（写任何 Rust 之前先做）**：把 `contextbuilder`（226 LOC）+ coordinator 的状态机部分，用 Rust 重写一个**只有类型、没有 I/O、跑合成事件**的版本，然后回答一个问题——**那个 `Context` capability 类型，能不能真的让"在 translator 里做 I/O"变成编译失败？** 如果能，L1 的收益是真的；如果发现要绕（比如生命周期逼你泄漏一个 `Arc<dyn Fs>` 进去），**收益是假的，就别为了语言的纯洁性付 6–12 个月的代价**。

### 6.7 ⚠️ 成本经济学：Jev 让"便宜"成立，但 cache 让"划算"仍然不保证

Doc 的核心 claim 是"省 context = 省钱"，同时警告"即使便宜 100 倍，线性工作量也会累积"。Jev 把这两条都改变了一半：

**改变的那一半**：Jev **$0.042/Mtok、输出免费**，比 DeepSeek V4.1-Flash 的 cache-miss（$0.15）便宜 3.6 倍，比 Opus 级便宜约 360 倍；而且**一次调用判所有 chunk**（并行、无 context-rot），所以成本从 `O(n) 次调用` 变成 `1 次调用 × O(n) 输入 token`。**Doc 的"线性成本病"被结构性地化解了。**

**没变的那一半，而且更尖锐**：Jev 按**输入 token** 收费，而 `state` 就是输入；同时**`replace` 会打断 KV cache**。所以真正的判据是：

$$\underbrace{X \cdot \$0.042/\text{Mtok}}_{\text{判决成本}} \quad \text{vs} \quad \underbrace{X \cdot N \cdot \text{主模型单价}}_{\text{省下的 prefill/输入成本}}$$

其中 $N$ 是这段内容本来还会被重发多少次，单价取决于**该替换点是否落在 cached prefix 里**：
- 落在 **cache-hit** 路径（$0.003/Mtok）：**判一次等于省 14 次 → 大概率纯亏。**
- 落在 **cache-miss** 路径（$0.15/Mtok）：**$0.042 < $0.15 → 立刻划算**，且如果那一刀正好打断 cache，收益还要再加。

→ **结论：Jev 判决的经济性完全由 cache 命中率决定，不由 Jev 的价格决定。** 所以：
1. **Phase 3 必须先做启发式（零模型成本）**，Jev 只用于"不确定的中段"；
2. **判决必须在 `tool/result` 时异步算**，`pre-step` 只读缓存（否则延迟不可接受）；
3. 这把三个悬而未决的问题**压缩成一个实验**：同段历史里故意切一次模型 / 做一次降级，实测 provider 侧的 cache 命中率与账单变化。**这个数字同时决定 L3 值不值得做、路由值不值得做、Jev 值不值得接。**

---

## 7. 最终判断

**能整合。五个东西的正交性是真实的，不是硬凑的——而且它们的相对位置由一个共同的组织原则决定：时间。**

| 轴 | 时间位置 | 抽象层级 | 形态 |
|---|---|---|---|
| **Doc** | 设计期 | — | 需求 backlog |
| **TypeSafe / Jev** | **内联**（每次决策） | 对象层 | `JudgmentProvider` seam |
| **dsh** | 运行时 | 宿主 | 仓外 bundle |
| **unreal-agent** | 设计期（契约） | — | 类型纪律参考（Rust 值得用在 L1/L4） |
| **Dream-RSI** | **后置**（每轮之后） | **元层** | 离线批处理作业 |

- Doc 提供了**问题定义**。它的核心直觉（层级化历史 + 显式读写状态）与 Dream-RSI 的结论**指向同一方向**——历史不该是"要压缩的负担"，而该是"可以反复读的资源"。**但两者到达路径不同，而且 Dream-RSI 明确不碰上下文层**（它把 "history as context" 列为对照并主动放弃）。
- dsh 提供了**唯一一个不需要重写就能承载这件事的宿主**，而且它已经把 Doc 想要的拦截点（pre-step / request / assemble）和 batteries（jobs / skill / mcp / subagent / token-meter / session-query）全部预留好了。
- unreal-agent 提供了**让"历史可重放"在工程上真的成立的那套契约形状**（纯翻译器 / 可序列化操作 / I/O-pure 上下文构建 + 类型化变更报告 / 真实的 cache key）。要诚实地说：**它最亮的那一点（typed change report）是接口而不是实现**，而且它自己**没有任何上下文管理、模型路由、并行 sub-agent 或权限层**，`CONTRIBUTING.md` 还明说不接受 PR、只是内部代码库的部分抽取。所以它**不是可依赖的组件，而是"接口应该长这样"的范本**——"不移植它的代码、只借鉴它的契约"是对它设计意图的正确使用。
- Dream-RSI 提供了**闭环的算法骨架**。但它是**后置的二阶优化器**：第 1 轮必须手写策略（论文原话 "manually designed exploration policy"），$\mathcal{H}_0 = ()$ 没有 world 可 replay。**它只优化"算力怎么分配"，永远不优化"想什么"**，且没有代码、没有超参、没有 error bars。
- TypeSafe/Jev 提供了**内联的判断层**，填上了 Doc 的 chunk 打分和 Dream-RSI 那套脆弱的 prompt 规则。它不是 coding agent 的 LLM（官方明确），而是**判断原语**：`Choice` / `Score` / `Noul` + `confidence`，一次调用判所有问题。

**最大的五个真实风险**（按严重度）：
1. Dream-RSI 的工程细节全空 → 你要做的是**实现**它，不是**集成**它。$M$、$K_2$、$\beta_1$、$\beta_2$ 都没有公开值。
2. 它的收益主要是"更便宜"而非"更强"：数学任务上几乎无提升（Autocorrelation 还退化），Lasso 的平均改善靠 6 个数据集里的 1 个，且全篇无 seeds/error bars。
3. **dsh 不接受外部 PR** → RSI-Harness 只能活成仓外 bundle（见 §4.1）。**如果发现必须改 agent-loop 内部，这个方案就要重新考虑形态。**
4. Doc 的 cache-agnostic 前提与 dsh 的 cache-aware 现实冲突 → **必须改成 cache-aware，否则做出来更贵**。
5. **unreal-agent 的亮点是空的**（`Report`/`Change` 从未被填充），而它的 fork 重放也明确不完整（`loop.go:552` FIXME）。L1 不是"拿来就用"，是要**真的写一遍**。

**建议的第一步**：不要动 dsh 的 loop，先写 `dsh-rsi-trace`——把一棵真实的发现树从 session log 里派生出来，并给它定价；同时把 `surface/assembled` 记录 + invariant 真做出来。**并且用这件事来验证风险 3**：如果这一步能纯靠 `SessionEventMap` 扩展 + waterfall 完成，整条路线就通了。如果这一步做不出来，后面整个 L4/L5 都是空谈；如果做出来了，Phase 1（replay）就只是工程量的函数。

---

## 附录 A：五个系统的关键事实速查

| | Doc | unreal-agent | dsh | Dream-RSI | TypeSafe / Jev |
|---|---|---|---|---|---|
| 形态 | 文档（~450 段 + 6 图） | Go 库，11.5K 手写 LOC + 19.4K 生成 + 30.9K 测试 | TS monorepo，**54 group / 307 leaf**（不可约产品 ≈170） | 论文（36 页含附录） | 托管 API（`POST /v1/systemone`）+ Python/JS SDK |
| 状态 | 无代码 | v0，**单 commit、不接受 PR** | v0.1.7-alpha.2，developer preview，**不接受外部 PR** | **无代码**；唯一产物 = 附录 C 的一个 Lasso solver | **生产可用**，`jev-1.13.0` |
| License | — | MIT (© 2026 Unreal Labs) | MIT | 未声明 | 商业 API；数据政策：不用客户请求训练，企业版 ZDR |
| 规模/限制 | — | 3 个直接依赖（极克制） | pnpm workspace + 11 个 vendored Cordis 包 | 全部关键超参未公开 | **64k** = state+所有问题；**32k** = state+最长单个问题；文本 only；CJK 精度较低 |
| 定价 | — | — | — | — | **$42/Btok ≈ $0.042/Mtok，输出免费** |
| 质量信号 | — | 705 测试、98.4% 覆盖、5 fuzz | 1,745 spec、17 gate lane、`ts type-equiv` 机械校验 | 无 seeds/error bars | 官方公开 [jaggedness 文档](https://docs.typesafe.ai/model-jaggedness/jev-1.13)（9 类失败模式） |
| 核心机制 | 6 个 KV-cache 畸形 + meta-attention | 纯翻译器 + 可序列化 operation + I/O-pure context builder | append-only session log（zstd + v0→v4 迁移）+ seam + Cordis | 历史即 replay simulator | `Choice`/`Score`/`Noul` + `confidence`，一次调用判所有问题 |
| 最可复用的契约 | feature backlog | `Translator`（无 I/O）/ `operation.Spec` / `CacheKey` / `Report`（⚠️ 空壳） | `agent/pre-step` · `agent/request` · `session-query.traceSession` · `ToolSchema.deferLoading` · `SessionEventMap` 合并 | `OptimalPolicy.solve` / `probe_batch` / `plan_grid` / `beta` | `state` + `questions{type,instructions,criteria}`；`confidence` 门控 |
| 时间位置 | 设计期 | 设计期（契约） | 运行时不适用 | **后置**（元层） | **内联**（对象层） |
| 最大短板 | 无实现、cache 前提有问题 | 生态全缺；亮点接口是空的 | 缺 context 策略层与 RSI 闭环；client preset 未发布 | **没代码**；只优化算力分配 | **不是 LLM**，不能生成摘要；**对抗性内容是已知失败模式** |

## 附录 B：需要立刻验证的技术假设

1. **日志→树的可派生性**：一个 turn 是否足以定义"一个探索尝试"？还是需要 step 粒度？`tool/result` 里有没有 workspace 快照的引用（spill locator 能不能当产物句柄）？
2. **replay 的确定性边界**：`session-query.readSession()` 给的是"replay-validated raw event log"——但工具输出、文件系统状态、时间戳这些**外部状态**在 replay 时怎么处理？是否需要把 workspace 也做成不可变快照（overlayfs / git tree）？
3. **`agent/pre-step` 能不能承受逐 chunk 打分的延迟**？它 await 后才进入 step，是同步路径。可能需要把打分做成**上一次 turn 的后台 job**，在 pre-step 里只读缓存结果。⚠️ 另外要和 `ctx.compaction` **约定在同一 waterfall 上的先后顺序**（见 §3.2），否则会有两套压缩逻辑改同一个 surface。
4. **`EpochHeader` 相等性能否可靠预测 cache 命中**？需要实测：同一 header 的两条 request，provider 侧的实际 cache 命中率。
5. **`workflow` 的并发上限 vs Dream-RSI 的 $W$**：replay 是纯读，可以开很大；但在线 rollout 的 $W$ 受 API rate limit 和 sandbox 并发限制。`maxParallelism` 应当从实际容量派生，而不是拍一个数。
6. **（新增，最重要）L3/L4/L5 三层是否真的都能不改 agent-loop 内部实现？** 已知可行的是：meta-attention 走 `agent/pre-step` / `agent/request`、按需工具走 `ToolSchema.deferLoading`、发现树记录走 `SessionEventMap` declaration merging、invariant 走 `runtime-diagnostics`。**任何一个环节需要改 request 派生或 tool 管线内部，就会撞上"dsh 不接受外部 PR"这堵墙**，方案的形态就要重新考虑（见 §4.1）。建议 Phase 0 就把这个当作**第一个验收项**。

## 附录 C：dsh 的精确坐标（供实现时直接引用）

| 要用的东西 | 文件 / 位置 |
|---|---|
| Cordis `Plugin` 类型 | `vendor/cordis/src/registry.ts:92` |
| `ToolDefinition` | `packages/core/tools/src/index.ts:223`；`ToolSchema` 在 `schema.ts:482`/`:554` |
| `ToolRuntime`（`ctx.tools`） | `packages/core/tools/src/index.ts:806`（`static inject = ['systemPrompt']`） |
| `LlmAdapter`（`ctx.llm`） | `packages/llm/llm/src/index.ts:204`（registry）/ `:337`（runtime） |
| `StreamChunk` 联合类型 | `packages/llm/llm/src/types.ts:440` |
| `SandboxProvider`（`ctx.sandbox`） | `packages/sandbox/sandbox/src/index.ts:158` |
| `SessionEventMap`（扩展持久事件） | `packages/core/session/src/types.ts` |
| `agent/pre-step` / `agent/request` 签名 | `packages/core/agent/src/runtime-types.ts:320` / `:321` |
| `model-selection.ts`（路由模板） | `packages/core/agent/src/model-selection.ts` |
| Web Chat 节点注册 | `packages/client/ui-conversation/src/client/contract/conversation.ts:196` |
| UI slot 注册 | `packages/client/ui-slots/src/index.ts:116` |
| Remote RPC 装饰器 | `packages/typert/protocol/src/index.ts:198` / `:250` |
| profile 模板定义 | `packages/boot/app-boot/src/profile.ts:156` |
| base bundle 的 92 行 | `packages/bundle/base/cordis.patch.yml` |
| manifest 类型（`dsh.bundle`/`dsh.profile`/`dsh.client`） | `packages/util/package-manifest/src/types.ts:81` |
| 包创建 checklist | `docs/cookbook/adding-a-package.md` |
| 工具创建指南 | `docs/cookbook/adding-a-tool.md` |
| Cordis 入门 | `docs/cordis-primer.md` |
| 单包跑测试 | `pnpm exec vitest run packages/<group>/<pkg>` |
