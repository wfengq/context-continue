# 项目驱动的多 Bot 上下文层 设计文档

- 初版：2026-10-11；修订：2026-10-28
- 状态：待审阅
- 语言：TypeScript
- 背景调研：`research/grok-bot-landscape-2026-10.md`、`research/group-shared-private-context.md`

---

## 0. 相比上一版改了什么

上一版以**群聊**为主体，状态板是从聊天里抽取出来的副产品。这一版以**项目**为主体：有项目才有群，群聊只是项目的一种交互界面。

| 方面 | 上一版 | 这一版 |
|---|---|---|
| 主体 | 群聊 | 项目 |
| 共享层 | 状态板：目标、决定、任务、事实、待决问题 | 项目板：目标与约束、约定、工作块、接口约定、决定（附理由与被否决方案）、事实、待决问题 |
| 群成员 | 手动加入 | 由拆分决定 |
| 私有层 | 一层 | 拆成项目工作区（随项目归档）和员工长期记忆（跨项目） |
| 唤醒 | @、话题订阅为主 | 项目事件为主（被分配、上游已交付、相关决定或接口变了），@ 为补充 |
| 新操作 | 无 | 拆分提案（负责人 Bot 提议、人确认）、提升（私有 → 公共）、交付检查、复盘 |
| 评测 | 全量广播 vs 本方案 | 增加"单 Agent、完整上下文、不拆分"作为对照组 |

---

## 1. 目标与背景

### 1.1 要解决的问题
Grok Bot 这类多 Bot 群组里，每个 Bot 每次回复都要重读完整对话，群消息也可能广播给所有 Bot。token 消耗随对话长度和 Bot 数量一起增长，上下文窗口也很快被塞满。

### 1.2 核心观点
- 数字员工的工作是**项目驱动**的：先把项目拆成若干部分，再分配给合适的员工执行。不是项目形态的工作（处理邮件、监控等）不需要群组，交给单个 Bot 即可，不在本项目范围内。
- 每个员工需要的不是整个项目，而是项目的**投影**：目标与约束、全局约定、自己的工作块、与相邻工作块的接口约定、影响自己的决定及理由。
- 每个员工还有自己的私有上下文：项目内的工作过程（草稿、试错、工具输出），以及跨项目积累的长期记忆。
- 大部分员工不需要"聊天"：拿到简报、在私有工作区里干活、把交付物和决定交回项目。

### 1.3 设计时必须应对的两个反驳
1. **隐含决定的冲突**（Cognition《Don't Build Multi-Agents》）：并行的 Agent 会各自做出命名、风格、边界情况等隐含决定，拼起来就冲突。对策：项目板包含约定和接口约定；交付时由负责人 Bot 检查是否违反；项目板只由核心库代码串行写入。
2. **拆分会变**：执行中常发现原来的拆分不合理。对策：重新拆分是一等操作，随时可以发起。

### 1.4 用户的目标
- 减少多 Bot 协作的 token 消耗。
- 做成开源项目拿 star、引起大厂关注，或成为相关生态里不可缺少的组件。

### 1.5 成功标准（以评测结果为准）
- 与"多员工 + 全量广播"（B 组）相比，本方案（C 组）总输入 token 至少减少 50%。
- C 组每次唤醒的上下文长度有上限，不随项目进行而增长。
- C 组任务质量不低于 B 组；与"单 Agent 完整上下文"（A 组）的质量差距如实报告。
- C 组的一致性冲突数少于 B 组；总耗时少于 A 组。
- 以上结果有可复现的评测脚本。

### 1.6 已确认的决定
| 决定 | 结论 |
|---|---|
| 语言 | TypeScript |
| 宿主 | 核心库 + MCP 服务适配 + OpenClaw 插件适配 |
| 架构 | 方案 A：与宿主无关的核心库；核心库不调用模型，模型由宿主运行或以函数传入 |
| 谁来拆分 | 负责人 Bot 提议，人确认后生效；重新拆分走同样流程 |
| 项目板写入 | 核心库代码串行写入；需要判断的提案交给负责人 Bot；拆分和目标变更需要人确认 |
| 人的聊天内容 | 每 N 条由抽取模型转成提案（authority 为 human） |
| 存储 | 可替换的 `Store` 接口，默认 SQLite，另有内存实现 |
| 所有权 | 第一版每个项目只有一个所有者 |

---

## 2. 数据模型

### 2.1 L0 项目日志
只追加、永不修改，是唯一的事实来源。包含聊天消息和项目事件。

```ts
interface LedgerEntry {
  id: string;
  projectId: string;
  seq: number;                          // 项目内单调递增
  createdAt: number;
  author: { kind: 'human' | 'bot' | 'system'; id: string };
  body:
    | { type: 'chat'; text: string; mentions: string[]; replyTo?: string }
    | { type: 'event'; event: ProjectEvent };
}

type ProjectEvent =
  | { kind: 'projectStarted' }
  | { kind: 'planProposed'; proposalId: string }
  | { kind: 'planApproved'; proposalId: string }
  | { kind: 'planRejected'; proposalId: string; feedback: string }
  | { kind: 'deliverableSubmitted'; workstreamId: string; deliverableId: string }
  | { kind: 'reviewPassed' | 'reviewFailed'; deliverableId: string; notes: string }
  | { kind: 'blocked'; workstreamId: string; reason: string }
  | { kind: 'boardMerged'; version: number }
  | { kind: 'archived'; what: string; ref: string }
  | { kind: 'projectClosed'; forced: boolean };
```

### 2.2 L1 项目板

```ts
interface ProjectBoard {
  projectId: string;
  version: number;
  updatedAt: number;
  status: 'active' | 'closed';
  lead: string;                         // 负责人 Bot
  goal: string;
  constraints: string[];
  planStatus: 'none' | 'draft' | 'approved';
  conventions: Item[];                  // 命名、风格、格式等全员遵守的规则
  workstreams: Workstream[];
  contracts: Contract[];
  decisions: Decision[];
  facts: Fact[];
  openQuestions: Item[];
}

interface Item {
  id: string;
  text: string;
  source: { entryIds: string[]; by: string };
  supersedes?: string;
  authority: 'human' | 'bot';           // 由核心库根据来源设定，冲突时 human 优先
}

interface Decision extends Item {
  rationale: string;
  rejected: string[];                   // 否决过的方案
  affects: string[];                    // 影响的工作块 id
}

interface Fact extends Item {
  affects: string[];
}

interface Workstream {
  id: string;
  title: string;
  brief: string;
  owner: string;                        // 负责的 Bot（负责人 Bot 也可以负责工作块）
  dependsOn: string[];
  status: 'pending' | 'active' | 'blocked' | 'delivered';
  reviewRounds: number;
  deliverables: { id: string; summary: string; ref: string; version: number }[];
}

interface Contract {
  id: string;
  from: string;                         // 提供方工作块
  to: string;                           // 使用方工作块
  spec: string;                         // 交什么、什么格式
  version: number;
}
```

交付物全文存在 `Store` 里，项目板只放摘要和引用。

**大小控制**：项目板公共部分（目标、约束、约定、工作块列表）默认上限约 3,000 token，可配置。超出时，已关闭的问题和已被覆盖的条目移出项目板，写入一条 `archived` 事件，之后可以用 `searchLedger` 查到。

### 2.3 L2a 项目工作区（每个 Bot × 每个项目一份，私有）

```ts
interface Workspace {
  projectId: string;
  botId: string;
  notes: string;                        // 工作笔记、草稿要点，默认上限约 2,000 token
  lastSeenSeq: number;
  lastSeenBoardVersion: number;
  promotionsThisTurn: number;
}
```
项目收尾时，工作区在复盘后归档，不跟着员工进入下一个项目。

### 2.4 L2b 员工长期记忆（每个 Bot 一份，跨项目）

```ts
interface EmployeeMemory {
  botId: string;
  persona: string;
  skills: string[];
  memories: { id: string; text: string; fromProject: string; createdAt: number }[];
}
```
只能由该员工自己的复盘写入；默认上限约 1,500 token，超出时淘汰最早的记忆；可导出为 Markdown 供人查看和删除。

### 2.5 提案

```ts
interface PlanProposal {
  id: string;
  projectId: string;
  by: string;                           // 负责人 Bot
  workstreams: Omit<Workstream, 'status' | 'reviewRounds' | 'deliverables'>[];
  contracts: Omit<Contract, 'version'>[];
  status: 'pending' | 'approved' | 'rejected';
  rejectCount: number;
}

interface Proposal {
  id: string;
  projectId: string;
  baseVersion: number;
  by: string;                           // botId，或 'extractor'
  ops: BoardOp[];
}

type BoardOp =
  | { op: 'add'; section: 'conventions' | 'openQuestions'; item: Omit<Item, 'id' | 'authority'> }
  | { op: 'addFact'; fact: Omit<Fact, 'id' | 'authority'> }               // 提升操作也落在这里
  | { op: 'addDecision'; decision: Omit<Decision, 'id' | 'authority'> }
  | { op: 'supersede'; section: 'conventions' | 'decisions' | 'facts'; id: string; item: Omit<Item, 'id' | 'authority'> }
  | { op: 'closeQuestion'; id: string }
  | { op: 'setWorkstreamStatus'; id: string; status: Workstream['status'] }
  | { op: 'addDeliverable'; workstreamId: string; summary: string; ref: string }
  | { op: 'updateContract'; id: string; spec: string }
  | { op: 'setGoal'; goal: string }
  | { op: 'setConstraints'; constraints: string[] };
```

**提升**是 `addFact` 或 `addDecision`，必须带非空的 `affects`。

每次合并后，核心库把生效的操作连同新版本号记入变更记录 `BoardChange { version, ops, mergedAt }`，用于生成"项目板变化摘要"。

---

## 3. 合并规则

核心库代码按项目串行处理提案队列。每条操作归入以下三类之一：

| 类别 | 包含的操作 | 处理 |
|---|---|---|
| **自动合并** | `addDeliverable`；`setWorkstreamStatus`；不冲突的 `add`、`addFact`；`closeQuestion`；`affects` 只包含提交者自己工作块的 `addDecision` | 校验后直接应用 |
| **交给负责人 Bot 判断** | 与他人修改同一条目的操作；Bot 试图 `supersede` 一条 human 级别的条目；`updateContract`；`affects` 包含其他人工作块的 `addDecision` | 进入负责人 Bot 的待处理队列，由它调用 `resolveProposal` 接受、修改或拒绝 |
| **需要人确认** | `setGoal`、`setConstraints`、所有拆分提案 | 在群里发出确认请求，人确认后应用 |

`authority`：来自抽取器（即人的聊天）的操作为 `human`，来自 Bot 的为 `bot`。

---

## 4. 项目生命周期

| 阶段 | 谁 | 触发 | 拿到的上下文 |
|---|---|---|---|
| ① 立项 | 人 | 调用 `start`，或在群里描述目标 | — |
| ② 拆分 | 负责人 Bot | 立项完成；拆分被打回；重新拆分请求 | `buildPlanningContext`：目标、约束、人的原始描述、员工名录（每人一行 persona + skills）；若是打回或重拆，附上一版提案、反馈或当前项目板 |
| ③ 确认 | 人 | 拆分提案提交 | 拆分摘要：工作块、负责人、依赖、接口约定 |
| ④ 执行 | 工作块负责人 | 被分配，且所有 `dependsOn` 已交付 | `buildBrief`（见 5.2） |
| ⑤ 交付检查 | 负责人 Bot | `deliverableSubmitted` | `buildReviewContext`：交付物全文、该工作块的接口约定、全局约定、影响它的决定。只检查是否违反约定和接口 |
| ⑥ 重新拆分 | 负责人 Bot 提议，人确认 | `reportBlocked` 指出拆分不合理；人要求调整 | 同 ②。确认后，受影响工作块的负责人被唤醒，拿到变化摘要 |
| ⑦ 收尾 | 人确认，各员工复盘 | 所有工作块已交付 | `buildRetroContext`：自己的工作区、自己工作块的结果和检查记录、现有长期记忆 |

**检查发现冲突**（如两个工作块的命名风格不一致）：负责人 Bot 提交一条新约定，并以 `reviewFailed` 唤醒相关负责人修改。

**负责人 Bot 的预算**：它读的是项目板、提案和交付物，不读其他员工的工作区。

---

## 5. 唤醒与上下文组装

### 5.1 唤醒规则（route）
按以下规则判断，命中即加入唤醒列表并标明原因：

| 原因 | 条件 | 被唤醒者 |
|---|---|---|
| `assigned` | 拆分确认后，工作块没有依赖或依赖已全部交付 | 工作块负责人 |
| `upstreamDelivered` | 某工作块的所有依赖刚刚全部交付 | 该工作块负责人 |
| `decisionChanged` | 新增或覆盖的决定、事实的 `affects` 包含该工作块 | 该工作块负责人 |
| `contractChanged` | 接口约定的 `from` 或 `to` 是该工作块 | 该工作块负责人 |
| `reviewFailed` | 自己的交付物检查不通过 | 工作块负责人 |
| `mentioned` | 聊天消息 @ 了该 Bot，或回复了它的消息 | 被 @ 或被回复的 Bot |
| `needsLead` | 拆分被打回、阻塞报告、交付物待检查、有需要判断的提案 | 负责人 Bot |
| `routed` | 人的消息没命中以上规则：若文本包含某工作块的 id 或标题，唤醒其负责人；否则若宿主提供了 `models.route`，由路由模型（只读项目板公共部分 + 最近 5 条消息）选择；都没有就唤醒负责人 Bot | 视情况 |

`upstreamDelivered`、`decisionChanged`、`contractChanged` 不是独立的日志事件，而是在每次 `boardMerged` 后，由核心库对比该次的 `BoardChange` 计算得出。

限制：
- Bot 发出的聊天消息只按 `mentioned` 唤醒别人，不走 `routed`。
- 一条人类消息引发的 Bot 回合总数有上限（默认 6），超过时停止并发出 `wakeLimitReached` 事件。
- 状态为 `blocked` 的工作块，除 `decisionChanged`、`contractChanged`、`mentioned` 外不被唤醒。

### 5.2 简报组装（buildBrief）
返回固定顺序的分段：

| 顺序 | 内容 | 可缓存 |
|---|---|---|
| 1 | 公共说明模板 + 成员名录 | 是（全员相同） |
| 2 | 项目板公共部分：目标、约束、约定、工作块列表（id、标题、负责人、状态） | 是（同一版本全员相同、字节一致） |
| 3 | 员工长期记忆：persona、skills、memories | 是（该员工固定） |
| 4 | 自己的投影：自己的工作块、涉及自己的接口约定、`affects` 包含自己的决定和事实（含理由和被否决方案）、上游交付物的摘要和引用 | 否 |
| 5 | 项目工作区笔记 | 否 |
| 6 | 增量：自 `lastSeenSeq` 以来与自己相关的事件和消息，以及自 `lastSeenBoardVersion` 以来与自己相关的变化摘要（由变更记录渲染，不调用模型；`lastSeenBoardVersion = 0` 时省略） | 否 |
| 7 | 本次触发原因与触发内容 | 否 |

**预算裁剪**：调用方传入 `maxTokens`。超出时依次裁剪：增量中最早的条目 → 工作区笔记 → 长期记忆中最早的记忆。第 1、2、4、7 段不裁剪；这几段已超预算时抛出 `BudgetTooSmallError`。

**新加入的员工**：`lastSeenSeq` 设为当前最新 seq，`lastSeenBoardVersion` 设为 0，第一次唤醒时拿到完整投影，不拿历史。

**Token 估算**：使用可替换的 `countTokens`，默认按字符数近似。

### 5.3 人的聊天内容抽取
累计 `extractEvery` 条人类聊天消息（默认 10），或项目空闲 `idleMs`（默认 60 秒），且宿主提供了 `models.extract` 时，把这段消息交给抽取模型，生成 `by: 'extractor'` 的提案，按第 3 节规则合并。

---

## 6. 对外接口

### 6.1 核心库 `@context-continue/core`

```ts
const employees = createEmployeeRegistry({ store });
await employees.upsert({ botId, persona, skills });

const project = createProject({
  projectId,
  store,
  employees,
  models: {
    route?: (input: RouteInput) => Promise<string[]>,
    extract?: (entries: LedgerEntry[], board: ProjectBoard) => Promise<BoardOp[]>,
  },
  countTokens?: (text: string) => number,
  options?: {
    extractEvery?: number;              // 默认 10
    idleMs?: number;                    // 默认 60_000
    recentForRouter?: number;           // 默认 5
    boardMaxTokens?: number;            // 默认 3_000
    notesMaxTokens?: number;            // 默认 2_000
    memoryMaxTokens?: number;           // 默认 1_500
    maxBotTurnsPerHumanMessage?: number;// 默认 6
    maxReviewRounds?: number;           // 默认 3
    maxPlanRejects?: number;            // 默认 3
    maxPromotionsPerTurn?: number;      // 默认 3
  },
});

// 生命周期
await project.start({ goal, constraints, lead, by });
const planCtx   = await project.buildPlanningContext();
await project.proposePlan(plan, { by: lead });
await project.approvePlan(proposalId, { by, edits? });
await project.rejectPlan(proposalId, { by, feedback });
const brief     = await project.buildBrief(botId, { maxTokens });
await project.submit(botId, submission);
//   submission: { type: 'deliverable', workstreamId, summary, content }
//             | { type: 'proposal', ops }
//             | { type: 'blocked', workstreamId, reason }
//             | { type: 'notes', notes }
const reviewCtx = await project.buildReviewContext(deliverableId);
await project.submitReview(deliverableId, { passed, notes, conventions? });
await project.resolveProposal(proposalId, { accept, edits? });
await project.close({ by, force? });
const retroCtx  = await project.buildRetroContext(botId);
await project.commitRetro(botId, memories);

// 聊天与唤醒
await project.ingest(chatMessage);
const wake = await project.route(entry);        // { botId, reason }[]

// 查询与事件
project.board();
project.exportMarkdown();
project.on('boardChanged' | 'wake' | 'merged' | 'needsHuman' | 'extractFailed' | 'wakeLimitReached', handler);
```

所有 `build*Context` / `buildBrief` 返回 `{ segments: { kind, text, cacheable }[], tools, stats }`，由宿主转换成各家模型 API 的格式和缓存标记。

### 6.2 Bot 可用的工具
- 所有 Bot：`searchLedger`、`getDeliverable`、`submitDeliverable`、`proposeDecision`、`promote`、`reportBlocked`、`updateNotes`
- 负责人 Bot 额外：`proposePlan`、`resolveProposal`、`submitReview`

### 6.3 存储接口 `Store`

```ts
interface Store {
  // 日志
  append(entry: Omit<LedgerEntry, 'seq'>): Promise<LedgerEntry>;
  read(projectId: string, fromSeq: number, limit?: number): Promise<LedgerEntry[]>;
  search(projectId: string, query: string, limit?: number): Promise<LedgerEntry[]>;
  latestSeq(projectId: string): Promise<number>;
  // 项目板
  getBoard(projectId: string): Promise<ProjectBoard>;
  saveBoard(board: ProjectBoard, expectedVersion: number, change: BoardChange): Promise<void>; // 版本不符时抛错；与变更记录原子写入
  getBoardChanges(projectId: string, sinceVersion: number): Promise<BoardChange[]>;
  // 提案
  enqueueProposal(p: Proposal): Promise<void>;
  drainProposals(projectId: string): Promise<Proposal[]>;
  savePlanProposal(p: PlanProposal): Promise<void>;
  getPlanProposal(id: string): Promise<PlanProposal | null>;
  // 私有层
  getWorkspace(projectId: string, botId: string): Promise<Workspace | null>;
  saveWorkspace(w: Workspace): Promise<void>;
  getMemory(botId: string): Promise<EmployeeMemory | null>;
  saveMemory(m: EmployeeMemory): Promise<void>;
  // 交付物
  putDeliverable(projectId: string, content: string): Promise<string>;   // 返回 ref
  getDeliverable(projectId: string, ref: string): Promise<string>;
}
```
默认实现 `sqliteStore`（日志检索用 SQLite FTS5），测试用 `memoryStore`。

### 6.4 适配层：MCP 服务 `@context-continue/mcp`
把 6.2 的工具按 MCP 格式暴露，另加 `get_brief`、`get_updates_since`。
- 能做到：多个 Bot 共享同一份项目板，拿到各自的投影和增量。
- 做不到：减少闭源产品自己的全量重读。README 必须写明。

### 6.5 适配层：OpenClaw 插件 `@context-continue/openclaw`
在 OpenClaw 的消息处理环节调用核心库，用 `buildBrief` 替换默认的历史拼装。
**待核实**：OpenClaw 插件和钩子 API 的具体形式，在实施计划第一步核实。若 OpenClaw 不允许替换历史拼装，退回为"MCP 服务 + OpenClaw skill"，并更新本节。

### 6.6 评测 `@context-continue/bench`
三组对照，同一模型：

| 组 | 做法 |
|---|---|
| A | 单个 Agent、完整上下文、不拆分 |
| B | 多员工 + 全量广播 |
| C | 本方案 |

三个项目剧本（JSON：项目描述、人的中途消息序列、员工名录、评分标准）：
1. 写一份产品方案
2. 做一个类似 Flappy Bird 的网页小游戏（针对 Cognition 提出的风格冲突反例）
3. 策划一场活动

指标：总输入 token、缓存读取 token、每次唤醒的上下文长度分布、任务质量评分（模型按评分标准打分，另加人工抽查）、一致性冲突数（检查阶段发现的违反约定或接口的次数）、总耗时。

---

## 7. 错误处理

| 情况 | 处理 |
|---|---|
| 拆分被打回 | 反馈写成 `planRejected` 事件，唤醒负责人 Bot 重拆；连续 `maxPlanRejects` 次后发 `needsHuman`，提示人手动拆分 |
| 拆分有环形依赖，或工作块的负责人不在员工名录中 | `proposePlan` 时校验并拒绝，返回具体原因 |
| 工作块被阻塞 | `reportBlocked` → 工作块状态设为 `blocked`，唤醒负责人 Bot 决定改接口、重拆或转人 |
| 检查反复不通过 | 同一工作块超过 `maxReviewRounds` 轮后发 `needsHuman`，由人裁决 |
| 负责人 Bot 超时或无响应 | 待处理提案保留在队列中不丢失；超时后发 `needsHuman` |
| 提升过多 | 每回合超过 `maxPromotionsPerTurn` 或 `affects` 为空的提升直接拒绝 |
| 复盘写入错误记忆 | 记忆有上限并标明来源项目；可导出供人查看和删除 |
| 有未交付工作块时收尾 | 拒绝并列出未完成工作块；`force: true` 时强制收尾，未完成的工作块标记后归档 |
| 路由或抽取模型失败 | 路由退回为唤醒负责人 Bot；抽取失败的消息留在队列中重试，连续 3 次失败发 `extractFailed` |
| 提案中有不合法操作 | schema 校验，丢弃该条操作并记录，其余照常处理 |
| 并发写入 | 每个项目一个串行队列；`saveBoard` 校验版本号，不符时重读后重试 |
| `append` 写入失败 | 直接抛错给宿主，不重试 |
| 其他写入失败 | 最多重试 3 次后抛错 |
| 越权读取私有层 | 工作区只能被本人在本项目内读取；长期记忆只能被本人读取、只能由本人复盘写入；`searchLedger` 只查日志 |
| 预算不足 | 抛出 `BudgetTooSmallError` |

---

## 8. 测试

- **单元测试**（内存存储，不调真实模型）：拆分校验、第 5.1 节每条唤醒规则及限制、简报只包含与本人相关的投影、预算裁剪顺序、提升校验、第 3 节三类合并规则、human 优先、检查轮次上限、收尾校验。
- **隔离测试**：A 的工作区对 B 不可见；一个项目的工作区对另一个项目不可见；长期记忆只能由本人复盘写入。
- **快照测试**：同一项目板版本下，第 1、2 段对所有员工逐字节一致；第 3 段对同一员工逐字节一致。
- **一致性测试**：并发提交多个提案，检查版本号连续、操作不丢失不重复。
- **存储契约测试**：`memoryStore` 与 `sqliteStore` 跑同一套测试。
- **生命周期集成测试**：用脚本模拟负责人 Bot 和执行者，走完立项 → 拆分 → 打回 → 确认 → 执行 → 检查失败 → 修改 → 交付 → 收尾 → 复盘。
- **评测**：A/B/C × 三个剧本，需要 API key，单独运行，不进常规测试；结果写入 README。

---

## 9. 第一版不做

- 跨所有者的权限控制与加密
- 图形界面（只提供 Markdown 导出和事件）
- 向量检索（日志检索用 SQLite 全文检索）
- 透明代理形式的接入
- OpenClaw 以外的运行时适配
- 嵌套项目（工作块下再拆子项目）
- 同一 Bot 参与多个项目时的调度和排队（各项目独立运行）
- 非项目形态的工作（交给单个 Bot）

---

## 10. 仓库结构

```
packages/
  core/       @context-continue/core
  mcp/        @context-continue/mcp
  openclaw/   @context-continue/openclaw
  bench/      @context-continue/bench
docs/
research/
```
