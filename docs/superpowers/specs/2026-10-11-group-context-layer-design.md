# 多 Bot 群组上下文层 设计文档

- 日期：2026-10-11
- 状态：待审阅
- 语言：TypeScript
- 背景调研：`research/grok-bot-landscape-2026-10.md`、`research/group-shared-private-context.md`

---

## 1. 目标与背景

### 1.1 要解决的问题
Grok Bot 这类多 Bot 群组里，每个 Bot 每次回复都要重读自己的完整对话，群里的消息也可能广播给所有 Bot。结果是 token 消耗随群聊长度和 Bot 数量一起增长，上下文窗口也很快被塞满。

### 1.2 方案一句话
群组维护一份共享的、结构化的**状态板**；每个 Bot 有自己的**私有层**；原始消息存进**日志**，默认不加载；每条消息只**唤醒**相关的 Bot。

### 1.3 用户的目标（已确认）
- 减少多 Bot 群组的 token 消耗。
- 做成开源项目拿 star、引起大厂关注，或成为相关生态里不可缺少的组件。

### 1.4 成功标准
- 同一个群组任务，与"全量广播"相比总输入 token 明显下降（目标 ≥50%，以评测结果为准）。
- 每次唤醒的上下文长度有上限，不随群聊变长而增长。
- 任务质量评分不低于全量广播。
- 以上结果有可复现的评测脚本。

### 1.5 已确认的决定
| 决定 | 结论 |
|---|---|
| 语言 | TypeScript |
| 第一版宿主 | 三类都覆盖：核心库 + MCP 服务适配 + OpenClaw 插件适配 |
| 整体架构 | 方案 A：与宿主无关的核心库，适配层只做薄包装 |
| 状态板更新 | 混合：Bot 提交结构化变更 + 人的消息定期由抽取模型转成变更，书记员统一合并、带版本号 |
| 唤醒策略 | 规则优先，路由模型兜底 |
| 存储 | 可替换的 `Store` 接口，默认 SQLite，另有内存实现 |
| 模型 | 核心库不直接调模型，路由和抽取模型由宿主以函数传入 |
| 所有权 | 第一版每个群只有一个所有者 |

---

## 2. 三层数据模型

### 2.1 L0 群组日志 `Ledger`
只追加、永不修改，是唯一的事实来源。

```ts
interface Message {
  id: string;
  groupId: string;
  seq: number;                       // 群内单调递增
  author: { kind: 'human' | 'bot'; id: string };
  text: string;
  mentions: string[];                // 被 @ 的 botId
  replyTo?: string;
  createdAt: number;                 // 毫秒时间戳
}
```

### 2.2 L1 群组状态板 `Board`
结构化、带版本号，每次合并后版本号加 1。

```ts
interface Board {
  groupId: string;
  version: number;
  updatedAt: number;
  goal: string;
  members: { id: string; kind: 'human' | 'bot'; role: string }[]; // role 只写一行职责
  decisions: Item[];
  tasks: TaskItem[];
  facts: Item[];
  openQuestions: Item[];
}

interface Item {
  id: string;
  text: string;
  source: { msgIds: string[]; by: string };
  supersedes?: string;               // 覆盖的旧条目 id
  authority: 'human' | 'bot';        // 冲突时 human 优先
}

interface TaskItem extends Item {
  owner?: string;
  status: 'open' | 'doing' | 'done' | 'blocked';
}
```

**大小控制**：状态板设上限（默认约 3,000 token，可配置）。超出时，已完成的任务和已被覆盖的条目从状态板移除，写一条归档消息（`author.kind = 'bot'`，`id = 'clerk'`）到日志，之后可以用 `searchLedger` 查到。

### 2.3 L2 Bot 私有层 `BotPrivate`
每个 Bot 一份，其他 Bot 读不到。

```ts
interface BotPrivate {
  botId: string;
  groupId: string;
  persona: string;                   // 角色、偏好，稳定不常变
  notes: string;                     // Bot 自己维护的工作笔记，默认上限约 2,000 token
  subscriptions: string[];           // 订阅的话题关键词
  lastSeenSeq: number;               // 上次处理到的日志位置
  lastSeenBoardVersion: number;      // 上次看到的状态板版本
}
```

### 2.4 状态变更提案 `Proposal`
任何人都不能直接改状态板，只能提交提案，由书记员合并。

```ts
interface Proposal {
  id: string;
  groupId: string;
  baseVersion: number;
  by: string;                        // botId，或 'extractor'
  ops: BoardOp[];
}

type Section = 'decisions' | 'tasks' | 'facts' | 'openQuestions';

type BoardOp =
  | { op: 'add'; section: Section; item: Omit<Item, 'id'> | Omit<TaskItem, 'id'> }
  | { op: 'update'; section: Section; id: string; patch: Partial<TaskItem> }
  | { op: 'supersede'; section: Section; id: string; item: Omit<Item, 'id'> }
  | { op: 'close'; section: 'openQuestions' | 'tasks'; id: string }
  | { op: 'setGoal'; goal: string };
```

`close` 的含义：对 `tasks` 是把 `status` 设为 `done`；对 `openQuestions` 是从状态板移除并写入归档消息。

每次合并后，书记员把本次实际生效的操作连同新版本号记入**变更记录**（`BoardChange { version, ops, mergedAt }`），用于生成第 3.2 节中的"状态板变化摘要"。

`authority` 由书记员根据来源决定，不由提交方声明：来自人的消息（经抽取模型）的为 `human`，来自 Bot 提交的为 `bot`。

---

## 3. 消息处理流程

```
① ingest(msg)        写入日志，分配 seq
② route(msg)         返回要唤醒的 Bot 列表及原因
③ buildContext(bot)  为每个被唤醒的 Bot 组装分段上下文
   （宿主用自己的模型运行 Bot）
④ commitTurn(...)    回复写入日志，更新 Bot 的指针，提案入队
⑤ merge()            书记员合并提案，状态板版本 +1
```

### 3.1 唤醒规则（route）
按顺序判断，命中即加入唤醒列表：
1. 消息 `mentions` 包含该 Bot。
2. 消息回复的是该 Bot 的消息。
3. 消息提到某任务，该任务的 `owner` 是该 Bot（提到 = 文本包含任务 id 或任务标题关键词）。
4. 消息文本命中该 Bot 的 `subscriptions`。
5. 以上都没命中、消息作者是人，并且宿主提供了 `models.route` 时，调用路由模型。路由模型只接收状态板和最近 `recentForRouter` 条消息（默认 5），返回 botId 列表。

Bot 发出的消息只按规则 1–4 唤醒其他 Bot，不调用路由模型，避免 Bot 之间无限互相唤醒。另设每个群每条人类消息触发的 Bot 回合上限（默认 6），超过即停止并发出 `wakeLimitReached` 事件。

没命中任何规则时返回空列表，本条消息不消耗任何 Bot 的 token。

### 3.2 上下文组装（buildContext）
返回固定顺序的分段：

| 顺序 | 段 | 可缓存 |
|---|---|---|
| 1 | 群组公共说明（固定模板 + 成员名录） | 是 |
| 2 | 状态板（同一版本输出字节完全一致） | 是 |
| 3 | Bot 角色 `persona` | 是 |
| 4 | 私有笔记 `notes` | 否 |
| 5 | 增量：自 `lastSeenSeq` 以来与该 Bot 相关的消息（@ 它的、回复它的、提到它负责任务的），以及自 `lastSeenBoardVersion` 以来的状态板变化摘要（由变更记录逐条渲染，不调用模型；`lastSeenBoardVersion = 0` 时省略，因为第 2 段已是完整状态板） | 否 |
| 6 | 本次触发消息 | 否 |

附带三个工具：`searchLedger`（查日志）、`proposeBoard`（提交状态变更）、`updateNotes`（改私有笔记）。

**预算裁剪**：调用方传入 `maxTokens`。超出时依次裁剪：先丢增量里最早的消息，再截断私有笔记，第 1–3 段和第 6 段不动。如果第 1–3 段加第 6 段已经超过预算，抛出 `BudgetTooSmallError`。

**新成员入群**：Bot 加入时 `lastSeenSeq` 设为当前最新 seq，`lastSeenBoardVersion` 设为 0。首次唤醒拿到完整状态板和最近几条消息，不拿全部历史。

**Token 估算**：核心库使用可替换的 `countTokens` 函数，默认按字符数近似估算；宿主可以传入精确的分词器。

### 3.3 回合提交（commitTurn）
- 回复写入日志（`author.kind = 'bot'`）。
- 更新该 Bot 的 `lastSeenSeq` 为当前最新 seq，`lastSeenBoardVersion` 为当前状态板版本。
- Bot 在本回合调用 `proposeBoard` 提交的提案进入队列。

### 3.4 合并（merge）
**触发条件**：
- 队列中有 Bot 提案时立即合并。
- 自上次抽取以来累计 `extractEvery` 条人类消息（默认 10），或群组空闲 `idleMs`（默认 60 秒），且宿主提供了 `models.extract` 时，先调用抽取模型把这段消息转成提案，再合并。

**冲突处理**：提案的 `baseVersion` 落后于当前版本时，逐条检查操作：
- 没有修改同一条目：直接应用。
- 修改了同一条目：`human` 优先于 `bot`；同级时后到的生效，旧条目标记为被 `supersedes`。

---

## 4. 对外接口

### 4.1 核心库 `@context-continue/core`
```ts
const group = createGroupContext({
  groupId: 'g1',
  store: sqliteStore('./cc.db'),
  models: {
    route?: (input: RouteInput) => Promise<string[]>,
    extract?: (msgs: Message[], board: Board) => Promise<BoardOp[]>,
  },
  countTokens?: (text: string) => number,
  options?: {
    extractEvery?: number;      // 默认 10
    idleMs?: number;            // 默认 60_000
    recentForRouter?: number;   // 默认 5
    boardMaxTokens?: number;    // 默认 3_000
    notesMaxTokens?: number;    // 默认 2_000
    maxBotTurnsPerHumanMessage?: number; // 默认 6
  },
});

await group.addBot({ botId, persona, subscriptions });
await group.ingest(msg);
const wake = await group.route(msg);          // { botId, reason }[]
const ctx = await group.buildContext(botId, { maxTokens });
// ctx.segments: { kind, text, cacheable }[]
// ctx.tools:    工具定义
// ctx.stats:    各段 token 估算
await group.commitTurn(botId, reply, proposals);
await group.merge();

group.board();
group.exportMarkdown();
group.on('boardChanged' | 'wake' | 'merged' | 'extractFailed' | 'wakeLimitReached', handler);
```

`buildContext` 返回分段而不是拼好的字符串，由宿主转换成各家模型 API 的格式和缓存标记。

### 4.2 存储接口 `Store`
```ts
interface Store {
  appendMessage(msg: Omit<Message, 'seq'>): Promise<Message>;
  getMessages(groupId: string, fromSeq: number, limit?: number): Promise<Message[]>;
  searchMessages(groupId: string, query: string, limit?: number): Promise<Message[]>;
  getBoard(groupId: string): Promise<Board>;
  saveBoard(board: Board, expectedVersion: number, change: BoardChange): Promise<void>; // 版本不符时抛错；与变更记录一起原子写入
  getBoardChanges(groupId: string, sinceVersion: number): Promise<BoardChange[]>;
  getBotPrivate(groupId: string, botId: string): Promise<BotPrivate | null>;
  saveBotPrivate(p: BotPrivate): Promise<void>;
  enqueueProposal(p: Proposal): Promise<void>;
  drainProposals(groupId: string): Promise<Proposal[]>;
  latestSeq(groupId: string): Promise<number>;
}
```
默认实现：`sqliteStore`（日志检索使用 SQLite FTS5）；测试用 `memoryStore`。

### 4.3 适配层：MCP 服务 `@context-continue/mcp`
面向无法修改 prompt 拼装的闭源产品。暴露工具：`get_board`、`get_updates_since`、`search_ledger`、`propose_board`、`post_message`。

- **能做到**：多个 Bot 共享同一份状态板；入群和增量更新可用。
- **做不到**：减少宿主产品自己的全量重读。README 中必须写明这一点。

### 4.4 适配层：OpenClaw 插件 `@context-continue/openclaw`
在 OpenClaw 群聊消息处理环节调用 ①–⑤，用 `buildContext` 替换默认的历史拼装。
**待核实**：OpenClaw 插件和钩子 API 的具体形式，在实施计划第一步核实；如果 OpenClaw 不允许替换历史拼装，退回为"MCP 服务 + OpenClaw skill"形式，并在本文档中更新。

### 4.5 评测工具 `@context-continue/bench`
- 输入：群聊剧本（JSON：人类消息序列 + Bot 角色 + 任务的评分标准）。
- 对同一剧本、同一模型分别运行"全量广播"和"本方案"。
- 输出：总输入 token、缓存读取 token、每次唤醒的上下文长度分布、任务质量评分（模型按评分标准打分）。
- 第一版提供 3 个剧本：写产品方案、排查 bug、策划活动。

---

## 5. 错误处理

| 情况 | 处理 |
|---|---|
| 路由模型失败（超时、格式错误） | 退回只用规则唤醒，发 `wake` 事件时标注原因 |
| 抽取模型失败 | 该段消息留在待抽取队列，下次触发时重试；连续 3 次失败发 `extractFailed` 事件 |
| 提案中有不合法操作 | 用 schema 校验，丢弃不合法的单条操作并记录；其余操作照常合并 |
| 并发合并 | 每个群一个串行队列；`saveBoard` 校验版本号，不符时重新读取后重试 |
| `ingest` 写入失败 | 直接抛错给宿主，不重试（日志是唯一事实来源，不能悄悄丢失） |
| 其他写入失败 | 重试最多 3 次后抛错 |
| 越权读取私有层 | `buildContext` 和所有工具只能读调用者自己的私有层；`searchLedger` 只查日志 |
| 预算不足 | 抛出 `BudgetTooSmallError` |

---

## 6. 测试

- **单元测试**（内存存储，不调真实模型）：唤醒规则 1–5、Bot 互相唤醒上限、上下文裁剪顺序、增量计算、新成员入群、合并冲突（human 优先、`supersedes`）、不合法操作丢弃、私有层隔离。
- **一致性测试**：并发提交多个提案，检查版本号连续、操作不丢失也不重复。
- **快照测试**：同一状态板版本下，第 1–3 段输出逐字节一致。
- **SQLite 存储测试**：与内存存储跑同一套 `Store` 契约测试。
- **评测**：`bench` 需要 API key，单独运行，不放进常规测试；结果写进 README。

---

## 7. 第一版不做

- 跨所有者的权限控制与加密。
- 图形界面（只提供 Markdown 导出和事件）。
- 向量检索（日志回查使用 SQLite 全文检索）。
- 透明代理形式的接入。
- OpenClaw 之外的运行时适配（Hermes 等放到第二版）。

---

## 8. 仓库结构（monorepo）

```
packages/
  core/       @context-continue/core
  mcp/        @context-continue/mcp
  openclaw/   @context-continue/openclaw
  bench/      @context-continue/bench
docs/
research/
```
