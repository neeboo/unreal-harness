# Phase 0 验证清单（4 项，按顺序执行）

> 目的：在写任何 RSI-Harness 代码之前，把**四个"错了就要重来"的假设**验掉。
> 环境：`/tmp/req_repos/deepseek-ai_deepseek-harness`（dsh 只读克隆）。`pnpm install` 已完成。
> 铁律：**只加仓外插件 + 只改 profile patch，不碰 dsh 的 `src/`。**

## 总览与决策门

| # | 假设 | 状态 | 否决力 | 失败意味着 |
|---|---|---|---|---|
| **V1** | per-session 状态绑定 | ✅ **已通过** | ~~★★★★~~ 已解除 | —— |
| **V2** | 发现树能纯靠 `SessionEventMap` 扩展从日志派生 | ✅ **已通过** | ~~★★★~~ 已解除 | —— |
| **V3** | 请求可从日志复现（派生 == 真实请求） | ✅ **已通过** | ~~★★★~~ 已解除 | —— |
| **V4** | 能从**任意**已记录节点 fork | ✅ **已通过** | ~~★★★~~ 已解除 | —— |

## ✅ Phase 0 全部完成：V1 / V2 / V3 / V4 四项全部实测通过

**已完成的准备工作**：dsh 已 `pnpm install` + `pnpm run build` 成功（`BUILD_EXIT=0`），`vitest` 可直接按路径跑单包测试。

---

## V1：per-session 状态绑定 —— ✅ 已验证（结论与预期相反，且更好）

**为什么这条否决力最强**：RSI-Harness 需要**每个 session 有自己的** scorer / policy 状态（否则多个发现分支会互相污染）。如果做不到，就得改 dsh。

### 验证方式（已执行）

写了 `verification/v1-preset-isolation.spec.ts`（放在 `packages/preset/agent-preset-registry/tests/` 下用仓库自带的 `harness.ts` 跑），**2/2 通过**：

```bash
cd /tmp/req_repos/deepseek-ai_deepseek-harness
pnpm exec vitest run packages/preset/agent-preset-registry/tests/rsi-v1-isolate.spec.ts
```

### 结论（修正了我原来的假设）

| 我以为 | 实际 |
|---|---|
| preset service + `isolate` realm = 每个 agent 一个实例 | ❌ **不是**。`isolate` 隔离的是**跨 preset**，不是跨 Agent |
| | ✅ 同 preset 的两个 Agent **共享一个挂载 fiber**，`serviceFor()` 返回**同一个实例** |

**机制**：`AgentPresets.retain(id)` 按 preset **缓存 generation**（`packages/preset/agent-preset-registry/src/index.ts:194-210`），同一 preset 的多个 Agent 拿到**同一个 `generation.key`** → 同一 scope key → 同一 fiber。这是**故意的设计**（避免每个 agent 重复挂载），不是 bug。

**但规则是可强制的**（测试 2 证实）：无 `isolate` realm 的 preset service 会落进 root realm，`mountPreset` 调用 `leakedServices()` 后**直接抛 `Preset services require isolate realms`**（`packages/preset/agent-preset-registry/src/mount.ts:263`）。所以**不会静默地跨 session 共享**——这一点是好的。

### 由此得出的正确设计（重要修正）

**per-session 状态不要放在 preset service 里。** 用 dsh 本来的两个机制：

| 放什么 | 放哪 | 证据 |
|---|---|---|
| **session 键控的持久状态**（发现树索引、score、判决记录、policy 版本） | **`ctx.storageDomain`，按 `sessionId` 键控** | `storage-domain` README："workspace records, session sidecar metadata… remains invisible to the model and agent loop" |
| **per-agent 的注册**（工具、事件监听、prompt section） | **`agent.ctx`**（scoped context） | `packages/core/scope/README.md`："a tool registered through `agent.ctx` is visible only to that agent" |

而 preset 的正确用途是**承载"哪些 capability 挂进这个 session"**（即 dsh 自己的用法：creator mode 的 skill、`dsh-tool-subagent` 的模型选择策略），**不是承载状态**。

### 判定

✅ **通过**。既不需要改 dsh，也不需要"每 session 一个服务实例"——因为状态本来就应该走 `storageDomain(sessionId)`。
**且 V1 的否决力解除了**：原来那条"可能逼你改 dsh"的风险不存在。

### 顺带发现的 V1b：preset 的行能力比预想的强

`mount.spec.ts` 的第三个测试证实 preset 的 `plugins` 支持**嵌套 group 行**，`loader-composition` 类测试证实支持 **`disabled: { __jsExpr: 'true' }` 条件行**。这意味着 RSI-Harness 可以把"哪些 RSI capability 进这个 session"做成**条件化 preset**（比如只在特定 workspace 上挂 scorer），这是一个额外的好处。

---

## V2：发现树从日志派生 —— ✅ 已验证

**要证明的**：不新建存储，纯靠 `SessionEventMap` declaration merging + projection，就能从事件流重建出发现树的索引。

### 验证方式（已执行）

`verification/v2-tree-projection.spec.ts`，**2/2 通过**：

```bash
cd /tmp/req_repos/deepseek-ai_deepseek-harness
pnpm exec vitest run packages/core/agent-loop/tests/zz-v2-tree-projection.spec.ts
```

### 断言与结果

| # | 断言 | 结果 |
|---|---|---|
| 1 | 插件能用 `declare module '@deepseek-ai/dsh-session/types'` 扩展 `SessionEventMap` 并 append 自定义事件 | ✅ |
| 2 | `ProjectionDefinition` 能从普通会话事件 fold 出树（`apply` 纯函数、无兴趣事件返回**同一引用**） | ✅ |
| 3 | **谱系从 `init(header, …)` 的 `header.parentSession` 读出**——不来自任何事件 | ✅ |
| 4 | **fold 严格受 `inheritedEventCount` 约束**：父的 `rsi/node` 物理上在子的日志里，但**不在子的树里** | ✅ |
| 5 | 折叠状态**可被重新 fold 原始日志精确复现**（`reduce` 结果 `toEqual` 投影状态） | ✅ |
| 6 | 节点的 `seq` 保持**创建位置**，不被后续更新覆盖（`Child(r)` 的"最早创建"规则需要它） | ✅ |

### 对设计的两处修正

**修正 1（简化）：不需要 `storageDomain`，用 dsh 自己的 `sessionProjections`。**

我原计划把树索引放 `ctx.storageDomain`。实测发现 **`ctx.sessionProjections.register(definition)` 就是 dsh 提供的"可重建折叠"机制**——它是纯函数 `apply`、有 `stateVersion` 做缓存失效、有 `stateSchema` 校验、还有配套的 invariant 模块。**用它比自建 domain 更贴合 dsh，也自动获得持久化缓存。**

所以 §5.2 的三分存储应修正为：

| 存什么 | 放哪 | 改动 |
|---|---|---|
| **真相** | `ctx.sessionPersistence`（不变） | — |
| **可重建索引**（树、score、status） | **`ctx.sessionProjections`（不是 `storageDomain`）** | ⬅ 修正 |
| **字节** | `ctx.spillStore`（不变） | — |

**修正 2（新增约束）：fold 必须区分"创建字段"与"可更新字段"。**

第一次写 fold 时，后来的 `rsi/node` 更新把 `seq` 和 `turns` 重置成新值——于是 `Child(r)` 赖以工作的**创建序丢了**。正确语义是：`seq` / `turns` 是 **create-only**，`status` / `score` 可被后续事件更新。这不是 dsh 的要求，是**树语义自己的要求**，值得写进 L4 的实现契约。

### 判定

✅ **通过**。"发现树是日志的投影、索引可丢弃重建"成立，**不需要改 dsh，也不需要新建存储**。

---

## V3：请求可从日志复现 —— ✅ 已验证

**为什么这条是地基**：dsh 的铁律是 **"Model-visible means logged"**，而 RSI-Harness 的 replay 层**不存请求、只从日志重新派生**。如果派生是有损的，"重放"就悄悄变成了比"模型真正看到的东西"更弱的东西。

### 验证方式（已执行）

`verification/v3-request-reconstruction.spec.ts`，用 in-tree 的 `MockAdapter`（记录每个 `GenerateOptions`）+ `agentLoop` 驱动真实 turn，**3/3 通过**：

```bash
cd /tmp/req_repos/deepseek-ai_deepseek-harness
pnpm exec vitest run packages/core/agent-loop/tests/zz-v3-reconstruct.spec.ts
```

**先说明为什么这不是重复劳动**：in-tree 的 `request-reconstruction.spec.ts` 断言的是"相邻请求互相前缀扩展"（它的注释写着 "every request the loop sends is a pure function of the session log"，但断言的是 `requests[i]` vs `requests[i+1]`）。**没有人断言"派生结果 == 真实请求"。** 我的测试补的就是这一条。

### 断言与结果

| # | 断言 | 结果 |
|---|---|---|
| 1 | 每个真实请求的 messages **逐条等于** `deriveMessages()` 的对应前缀 | ✅ |
| 2 | 派生历史恰好比最后一个请求多 1 条（最后一条 assistant），不多不少 | ✅ |
| 3 | tool schema 能从日志的 `request/header` fold 回来（`header.tools.length == request.tools.length`） | ✅ |
| 4 | loop 构造的请求 `system` 为 `undefined`，prompt 作为**首条 system-role 消息**在 messages 里 | ✅ |
| 5 | 注入 context（`agent.inject`）之后，两个请求仍各自是派生的精确前缀 | ✅ |
| 6 | **surface 替换之后**，替换后的请求仍被当前派生精确复现 | ✅ |
| 7 | **负向对照**：替换**之前**的请求**不是**当前派生的前缀 | ✅ |

### ⚠️ 第 6/7 条带出的 L4 硬约束（重要）

第 7 条不是凑数——它是**灵敏度对照**，证明第 6 条不是空洞成立。而它同时钉死了一个 L4 必须实现的性质：

> **`deriveMessages()` 是"日志末端"的 surface。** 所以：
> - **在替换之前发出的请求，不是替换后派生的前缀。**
> - 要复现**任意历史时刻**的请求，必须**把日志重放到那个 seq 为止**，而不是拿末端派生去截取。

这正是 Dream-RSI 的 `prefix-only` 观测在工程上的对应物，**也解释了为什么 replay 引擎不能只是"读最终状态 + slice"**——它必须是一个**按 seq 前进的重放器**。这条以前只是设计意图，现在是实测约束。

### 附带确认的两个事实

- **替换只遮蔽、不删除**：被 shadow 掉的原文仍在 `snapshotEvents()` 里（断言 4）。所以"模型侧精简 + 原始 transcript 完整"是 dsh 的既有性质，L3 不用自己实现。
- **不需要（也无法）用 `llm/stream` 抓请求**：`MockAdapter.requests` 已经证明请求是可观测的；而真实 adapter 的 `GenerateOptions` 同样带着派生的 messages。**所以 V3 的实际实现路径比计划的更简单**——不需要写抓取插件，只需要在 replay 时按 seq 重放。

### 判定

✅ **通过**。"可重放"成立，L4 的地基是实的。且**不需要 API key、不需要仓外插件**——用 in-tree testkit 就能验。

---

## V4：从任意已记录节点 fork —— ✅ 已验证

**为什么重要**：Dream-RSI 的发现树要"恢复父节点的 workspace + 累积历史"来产生新尝试，而 in-tree 的 fork subagent **只切最后一个 `turn/end`**（`subagent-fork-in-process` 的 `completedTurnPrefix()`）。树需要在**任意**已记录节点分叉。

### 验证方式（已执行）

`verification/v4-fork-arbitrary-node.spec.ts`，**2/2 通过**（in-tree `MockAdapter` + `buildForkSeed`）：

```bash
cd /tmp/req_repos/deepseek-ai_deepseek-harness
pnpm exec vitest run packages/core/agent-loop/tests/zz-v4-fork-arbitrary.spec.ts
```

### 断言与结果

| # | 断言 | 结果 |
|---|---|---|
| 1 | 在第 **1** 个 `turn/end` 分叉（非末尾） | ✅ |
| 2 | `header.parentSession == 'parent'`（fork 谱系是持久元数据） | ✅ |
| 3 | `Session.inheritedEventCount` 精确等于切点 | ✅ |
| 4 | **恰好一个** inherited 标记，且位置就在切点 | ✅ |
| 5 | 子会话**能看到 turn 1，看不到父的 turn 2**（`PARENT_TWO` 未泄漏） | ✅ |
| 6 | 非连续 seed（砍掉头部）**明确拒绝** | ✅ |
| 7 | seeded header 缺少 inherited count **明确拒绝**（dsh 不猜切点） | ✅ |

### ⚠️ 两个必须记住的坑（都踩过，第二个尤其危险）

**坑 1：入口是 `ctx.agents.create(CreateAgentOptions)`，不是 `ctx.agentLoop.create`。**

`ctx.agentLoop.create` 的签名是 `create(id, options: AgentOptions, meta: {cwd})` —— **根本不接受 `seed`**。第一次传错时，得到的是一个 `isSeeded:false`、**零事件**的空会话，**而且不报错**。

**坑 2：`inheritedEventCount` 必须等于 `seed.length - 1`，不是 `seed.length`。**

因为 `buildForkSeed` **已经**在 `boundary + 1` 处追加了 `{ inherited: true }` 标记，所以这个 count 要指向**那个标记本身**。传 `seed.length` 会越过它，构造函数检测不到标记 → **再追加一个**。实测对比：

| `inheritedEventCount` | markers | totalEvents |
|---|---|---|
| `seed.length - 1` ✅ | **1** | **12** |
| `seed.length` ❌ | 2 | 13 |

**这条危险在于它"看起来能跑"**——多一个标记不立刻报错，但破坏 `inheritedEventCount` 与标记位置的一致性，会让后续按切点做前缀判定/重放的代码**悄悄错位**。对 RSI-Harness 而言，这正好打在"树节点可重放"的地基上。

### 附带纠正一个常见误解

**`inheritedEventCount` 是 `Session` 上的存储元数据，不在 `SessionHeader` 里。** header 只有 `version` / `id` / `createdAt` / `cwd` / `parentSession` / `isSeeded` / `origin` / `delegationDepth` / `agentPreset`。我最初写成 `header.inheritedEventCount`，实测是 `undefined`。

### 判定

✅ **通过**。树可以从任意祖先节点长出来，且非法 seed 会被明确拒绝（fail loud，符合 dsh 的风格）。**不需要改 dsh。**

---

## 执行记录模板

每验完一项，把结论填这里（也方便下次接着做）：

```
V1 per-session 状态绑定  : [x] 通过              证据：verification/v1-preset-isolation.spec.ts（2/2 passed）
   结论：preset service 是 per-preset 而非 per-agent；状态走 storageDomain(sessionId)
V2 树可从日志派生        : [x] 通过              证据：verification/v2-tree-projection.spec.ts（2/2 passed）
   修正：用 ctx.sessionProjections（不是 storageDomain）；fold 需区分 create-only 字段
V3 请求可从日志复现     : [x] 通过              证据：verification/v3-request-reconstruction.spec.ts（3/3 passed）
   结论：派生 == 真实请求（前缀式）；但派生是"日志末端"，历史请求必须按 seq 重放
V4 任意节点 fork         : [x] 通过              证据：verification/v4-fork-arbitrary-node.spec.ts（2/2 passed）
   关键坑：入口是 ctx.agents.create（不是 agentLoop.create）；inheritedEventCount = seed.length - 1
```

**四项全部通过。** 可以动 Phase 1（`ReplayWorld` + `PrefixQuestion`）了。

---

## 附 2：`@deepseek-ai/dsh-rsi-trace` 包（Phase 0 的产出物）

验证用的临时 spec 已经**转成一个真正的包**，在 `packages/rsi-trace/`：

```
packages/rsi-trace/
  package.json          # @deepseek-ai/dsh-rsi-trace + dsh.bundle.patch
  cordis.patch.yml      # bundle patch：insert 一行 'rsi-trace'
  tsconfig.json         # 标准 composite 项目，references 指向 cordis/session/session-projection
  locale/{en,zh}.json   # 展示元数据
  README.md             # 含 Known Limitations 段
  src/types.ts          # rsi/node 事件 + DiscoveryTreeState + 纯 fold
  src/projection.ts     # rsi/discoveryTree 投影单元（zod 校验 + stateVersion）
  src/index.ts          # ctx.rsiTrace 服务 + apply()
  tests/                # harness + 本地 mock adapter + 3 个用例
```

**状态**：`pnpm run build` **通过**（无 `error TS`），`pnpm exec vitest run packages/rsi/rsi-trace` **3/3 通过**。

### 建包过程中暴露的四个真实约束

这些都是"只有真编译/真挂载才会发现"的问题，写在实现契约里：

1. **declaration merging 必须挂 `@deepseek-ai/dsh-session-projection/types`**，然后把 `ProjectionDefinition` 从**根**导出引入。挂错路径 → `keyof SessionProjectionStateMap` 退化成 `never`，报一堆 "not assignable to parameter of type 'never'"。
2. **`buildForkSeed(events, cut)` 的第二参是 `SessionSeq`，不是 `SessionLogOffset`。** 两者是不同的 branded type。我之前在临时 spec 里用 `as SessionLogOffset` 强转，**把编译错误盖住了**；写进真包后构建立刻报出来。
3. **投影注册要放在 service 的构造函数里**，不能放在兄弟 `ctx.inject` 回调里。`apply()` 里 `ctx.inject(...)` 返回的子 fiber 会在这个插件加载结束时被回收，回调可能根本不执行——而且**不报错**，表现是 `stateOf()` 一直返回 `undefined`。放在构造函数里，注册的 fiber 就是 service 自己的。
4. **`tsconfig.host.json` 会把 `packages/*/*/tests/**` 全部纳入类型检查。** 所以临时塞进别的包的 spec 会**破坏整个仓库的构建**——这也是把验证代码做成独立包的另一个理由。

### 包的设计要点（为什么这样切）

- **service 是 stateless 的**：每个方法都显式接受 `session`。因为 dsh 的投影注册表本来就按 session 折叠，不需要 per-session 实例化（这正是 V1 的结论）。
- **`apply()` 只挂 service，注册在构造函数里**：一次加载同时得到 fold 和 reader，**两者不可能只出现一个**。
- **`rebuildDiscoveryTree` 是导出的**：这就是"索引可丢弃"这条性质的公开入口。

---

## Phase 1（已开始）：ReplayWorld + PrefixQuestion

`packages/rsi-trace/src/replay.ts` + `replay-types.ts`：**14/14 测试通过，构建通过**。

### 落地的语义（每条都有测试钉住）

| 规则 | 说明 |
|---|---|
| **选择只揭示、不生成** | 非 root 节点产出其唯一已记录子节点；`IMPLICIT_ROOT` 产出最早创建且未被触碰的分支头 |
| **`legalActions()` = "选中它会揭示某个节点"** | 这个定义保证非空 batch **必有进展**，因此策略一定会终止 |
| **batch 按轮次开始时的状态校验** | 同一轮内不能依赖本轮揭示的结果 |
| **隐式 root 是保留 handle，不是节点** | 延续初始 workspace 的尝试就是分支头、没有 parent；世界会拒绝占用该 handle 的节点 |
| **每个节点至多一个已记录子节点** | 有分叉的内部节点没有确定后继 → 直接拒绝，而不是重放一棵与日志不符的树 |

### 在写这层时踩到并修正的概念错误（值得记下来）

1. **把 root 当成一个节点。** 第一版我在树里放了一个 `root` DiscoveryNode，导致 `Child(r)` 指向它而不是分支头。纠正：**root 是隐式的初始 workspace**，分支头才是 root 的子节点——这也是 dsh 里 fork 语义的原样（`parentSession` 指向的是会话，不是"节点"）。
2. **`A(T) = {r} ∪ leaves(T)` 要按"观测到的树"算。** 展开中的分支头**是叶子**，所以它可以被直接选（深挖）；而已经完全展开的分支头不再是叶子，就不合法。我一开始把 root 一律排除在选集合外，是错的。
3. **"打开一条分支"只揭示那一条分支头**，不是全部未开分支。我第一版在 `childFor` 里对任何 root 都去"开下一条分支"，导致探 b0 会揭示 b1——完全错位。
4. **`legalActions()` 必须是纯查询。** 我曾把"handle 已用掉"的状态更新写在这个方法里，结果第一次调用就自我失效。
5. **需要一个终止保证。** 最初没有它，一个 `() => ['root']` 这样的策略会**死循环**（测试直接挂死）。加了两条：合法动作必须会揭示某节点；一轮没揭示任何节点即终止。

### ✅ Phase 1 验收通过：在线记录与 replay 一致

`tests/replay-fidelity.spec.ts`（**15/15 全套通过**）跑了一条**真实在线运行**来验收：

- 用真实 `AgentLoop` + fork 建出会话树：root 会话 + 三个 fork 子会话（`b0`/`b1`/`b0/a0`），每个子会话自己 append 一个 `rsi/node`；
- 记录**在线实际走过的决策序列**：`[[IMPLICIT_ROOT], [IMPLICIT_ROOT, 'b0']]`，两轮；
- 从日志收集节点建 `ReplayWorld`；
- **用同一决策序列 replay**。

| 验收项 | 结果 |
|---|---|
| 每轮揭示的节点与在线**逐轮一致** | ✅ |
| 揭示集合一致、轮数一致（2 轮） | ✅ |
| 质量信号 = 该子树的最好记录分数（0.9） | ✅ |
| **负向对照**：换一个策略（贪心按分数深挖 b1）**产生不同轨迹** | ✅ |

**负向对照是必须的**：如果 replay 对任何策略都复现同一轨迹，那正向断言就是空洞的。这条证明引擎真的对策略敏感。

### 在写这个测试时确定的建模约定

**"父节点是承载本次运行的会话" ⟹ 该节点是分支头（树根）。** 因为 `rsi/node` 的 `parent` 记的是**哪个节点产生了它**，而第一个尝试的 parent 是初始 workspace——它在 dsh 里就是承载运行的会话。所以从日志建 world 时要丢掉承载会话自己的标记节点，并把其直接子节点当成分支头（`parent` 置空）。

**这条约定已固化为 `replayWorldFromTree(hostSessionId, nodes)`**（不再由调用方手做）。它放在包里而不是各调用方，是因为这个映射是**关于"记录下来的树意味着什么"的建模决定**——调用方弄错了照样能构造出一个形状合法的 world，然后**无声地重放一棵错的树**。

### 关键 API

```ts
const world = new ReplayWorld(ctx.rsiTrace.nodes(session))
const result = replay(world, question => question.legalRoots().length > 0 ? [IMPLICIT_ROOT] : [])
result.revealedNodeCount   // cost 代理：轨迹代表的 generation-evaluation 次数
result.bestScore           // 已揭示子树中的最好分数
replayScore(result, { cost, parallelism })   // 论文的 V = quality − β₁N + β₂N/rounds
```

---

## 附：本次已完成的准备工作

- ✅ dsh 只读克隆 + `pnpm install`（13.9s，缓存命中）
- ✅ 逐接缝核验：**确认不需要改 dsh**（`RSI-HARNESS.md` §4.2）
- ✅ **V1 已实测通过**（`verification/v1-preset-isolation.spec.ts`，2/2）——并修正了原假设：`isolate` 隔离跨 preset 而非跨 agent，同 preset 多 agent 共享挂载；状态应走 `storageDomain(sessionId)` + `agent.ctx` scope
- ✅ 发现 `llm/stream(options, next)` 能抓真实请求入参 —— **V3 有干净的实现路径**
- ✅ dsh 已 install + build 成功（构建 2.40s 收尾，`BUILD_EXIT=0`）
- ✅ **V3 已实测通过**（`verification/v3-request-reconstruction.spec.ts`，3/3）——并钉死一条 L4 硬约束：**派生是"日志末端"，复现历史请求必须按 seq 重放**
- ⏳ 未做：**V2**（树从日志派生，Phase 0 最后一块）
