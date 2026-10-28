# 核心库 `@context-continue/core` 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现与宿主无关的核心库：项目知识模型、按 Bot 裁剪的简报、由项目结构驱动的唤醒、增量视图、三段式压缩，以及完整的项目生命周期。

**Architecture:** 纯 TypeScript 库，不调用任何模型；模型能力（路由、抽取、压缩）由宿主以函数传入。所有状态经 `Store` 接口持久化（内存实现 + `node:sqlite` 实现）。项目板只由核心库的合并器串行写入；简报由确定性的渲染函数生成，可缓存的分段在同一版本下逐字节一致。

**Tech Stack:** Node.js 22（`node:sqlite`）、TypeScript 6.0.3、pnpm workspace、vitest 5.0.4、zod 4.6.7。

**Spec:** `docs/superpowers/specs/2026-10-11-group-context-layer-design.md`（第三版）。执行者必须同时阅读该文档；本计划引用其中的类型和规则时只写节号。

**本计划范围：** 只做核心库（设计文档第 2–5 节、6.1–6.4、第 7–8 节中与核心库相关的部分）。DeepSeek Harness 插件、MCP 服务、OpenClaw 插件、评测各自另写计划，在本计划完成后开始。

## Global Constraints

- 语言 TypeScript，`"type": "module"`，`strict: true`；运行时 Node.js ≥ 22.5（`node:sqlite`）。
- 依赖版本固定：`typescript@6.0.3`、`vitest@5.0.4`、`zod@4.6.7`、`@types/node@^22`。核心库运行时依赖只有 `zod`。
- 核心库不调用任何模型 API；`models.route`、`models.extract`、`models.condense` 都是可选函数，缺省时按设计文档的退化行为执行。
- 默认参数（6.1）：`extractEvery 10`、`idleMs 60_000`、`recentForRouter 5`、`boardMaxTokens 3_000`、`notesMaxTokens 2_000`、`memoryMaxTokens 1_500`、`maxBotTurnsPerHumanMessage 6`、`maxReviewRounds 3`、`maxPlanRejects 3`、`maxPromotionsPerTurn 3`、`maxHops 4`、`recentKeep 5`。本计划新增 `leadTimeoutMs 600_000`（设计文档第 7 节要求负责人超时转人，但未给数值）。
- 简报分段顺序与可缓存标记严格按 5.2 的表格；分段 `kind` 依次为 `common`、`board`、`memory`、`projection`、`workspace`、`delta`、`trigger`。
- 渲染给模型看的文本使用英文模板（方便开源社区使用）；分段 1–3 中不得出现时间戳、随机 id 生成以外的易变内容。
- 所有时间经注入的 `now(): number` 获取，所有定时器经注入的 `timers`（`setTimeout`/`clearTimeout`）创建，便于测试。
- 命令：在仓库根目录运行 `pnpm -C packages/core test`（测试）与 `pnpm -C packages/core typecheck`（类型检查）。每个任务结束时两者都必须通过。

**本计划对设计文档的补充（实现必需，设计文档未写）：**
- `ProjectBoard` 增加 `owner: string`（项目所有者，即 `start` 的 `by`；需要人确认的操作只接受 `by === owner`）。
- `Store` 增加待处理提案存取（`savePending`/`listPending`/`deletePending`）和项目级键值（`getMeta`/`setMeta`）。
- `resolveProposal` 增加 `by` 参数：待处理项 `needs: 'lead'` 时 `by` 必须是负责人 Bot，`needs: 'human'` 时 `by` 必须是 `owner`。
- 已读判断使用"条目键"：接口约定为 `${id}@${version}`，其余条目为 `id`。接口约定更新后版本变化，键随之变化，等价于"从 `seenItemIds` 中移除"。
- 被覆盖的条目在覆盖时即移出项目板，并写入 `archived` 事件（`what` 为分区名，`ref` 为该条目的 JSON）；关闭的问题同样处理。
- "每回合"的提升次数以两次 `buildBrief` 之间为一回合，`buildBrief` 时清零。
- "一条人类消息引发的 Bot 回合"以"最近一条人类聊天之后的 Bot 聊天条数"计算。
- `buildBrief` 在生成时更新该 Bot 的 `seenItemIds`、`lastSeenSeq`、`lastSeenBoardVersion`（内容已交付给宿主即视为已读）；传 `{ peek: true }` 时不更新。
- "备份后替换"由"校验通过前不写入、单条记录原子写入"保证，不另存备份副本（避免私有内容进入共享日志）。
- 抽取模型产生的 `addDecision` 视为人的决定，直接自动合并。
- `addFact`、`addDecision`、`addFailure` 的 `affects` 一律必须非空。

## Review Focus

1. **非成员调用**：不在项目中的 botId 调用 `buildBrief` 或任何工具时，应抛出 `NOT_A_MEMBER` 错误，而不是返回空简报。→ 测试加在 Task 10、Task 14。
2. **工作块标题误匹配**：标题为 `UI` 的工作块不应因人说 "build it" 而被唤醒；英文按整词匹配（不区分大小写），中文按子串匹配。→ 测试加在 Task 8。
3. **拆分确认前的简报**：还没有任何工作块时，任何成员的 `buildBrief` 都应正常返回（第 4 段为空说明），不报错。→ 测试加在 Task 10。
4. **进程重启**：用同一个 `Store` 重新 `createProject` 后，简报、唤醒判断、抽取进度都应与重启前一致。→ 测试加在 Task 15。
5. **中文与表情符号**：token 估算和截断不得截断代理对（emoji），中文按每字 1 token 估算。→ 测试加在 Task 1、Task 10。

---

## 文件结构

```
package.json                     # pnpm workspace 根
pnpm-workspace.yaml
tsconfig.base.json
packages/core/
  package.json
  tsconfig.json
  vitest.config.ts
  src/
    index.ts                     # 对外导出
    types.ts                     # 设计文档第 2 节全部类型 + 本计划补充类型
    options.ts                   # 默认参数与 resolveOptions
    errors.ts                    # ContextError 及错误码
    tokens.ts                    # 默认 token 估算与安全截断
    clock.ts                     # now / timers 注入
    ids.ts                       # newId(prefix)
    store/store.ts               # Store 接口
    store/memory.ts              # memoryStore
    store/sqlite.ts              # sqliteStore（node:sqlite + FTS5）
    board/schema.ts              # zod：BoardOp、PlanInput、工具参数
    board/apply.ts               # 纯函数：把一条操作应用到项目板
    board/archive.ts             # 项目板大小控制
    board/classify.ts            # 第 3 节三类合并规则
    board/merge.ts               # 串行合并器
    board/diff.ts                # 由 BoardChange 推导结构化唤醒
    plan/validate.ts             # 拆分校验
    workstreams/source.ts        # WorkstreamSource 接口 + 本地实现 + 合并视图
    employees.ts                 # createEmployeeRegistry
    route.ts                     # 聊天唤醒规则
    render.ts                    # 七个分段及规划/检查/复盘上下文的渲染
    brief.ts                     # buildBrief：投影、已读压缩、增量、预算裁剪
    condense.ts                  # 三段式压缩
    extract.ts                   # 人的聊天抽取调度
    tools.ts                     # 工具定义与调度
    markdown.ts                  # exportMarkdown
    events.ts                    # 类型化事件
    project.ts                   # createProject 门面与生命周期
  test/
    helpers.ts                   # makeProject() 等测试夹具
    store.contract.ts            # Store 契约测试（被两个实现复用）
    workstreams.contract.ts      # WorkstreamSource 契约测试
    *.test.ts
```

---

### Task 1: 工程骨架、类型、参数、错误、token 估算

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/vitest.config.ts`
- Create: `packages/core/src/types.ts`, `options.ts`, `errors.ts`, `tokens.ts`, `clock.ts`, `ids.ts`, `index.ts`
- Test: `packages/core/test/tokens.test.ts`, `packages/core/test/options.test.ts`

**Interfaces:**
- Produces（后续所有任务依赖）：
  - `types.ts`：设计文档 2.1–2.5 的全部类型原样定义（`LedgerEntry`、`SpeechAct`、`ProjectEvent`、`ProjectBoard`（加 `owner`）、`Item`、`Decision`、`Fact`、`Failure`、`Workstream`、`Contract`、`Workspace`、`EmployeeMemory`、`PlanProposal`、`Proposal`、`BoardOp`），以及：
    - `BoardChange { version: number; mergedAt: number; ops: AppliedOp[] }`
    - `AppliedOp { op: BoardOp; by: string; authority: 'human' | 'bot'; touched: string[] }`（`touched` 为该操作新增或修改的条目 id，含工作块 id）
    - `PendingProposal { id: string; projectId: string; proposalId: string; by: string; ops: BoardOp[]; needs: 'lead' | 'human'; createdAt: number }`
    - `WakeReason = 'assigned' | 'upstreamDelivered' | 'decisionChanged' | 'contractChanged' | 'reviewFailed' | 'mentioned' | 'needsLead' | 'routed'`
    - `Wake { botId: string; reason: WakeReason; detail?: string }`
    - `SegmentKind = 'common' | 'board' | 'memory' | 'projection' | 'workspace' | 'delta' | 'trigger'`
    - `Segment { kind: SegmentKind; text: string; cacheable: boolean }`
    - `ToolDefinition { name: string; description: string; parameters: Record<string, unknown> }`（JSON Schema）
    - `ContextBundle { segments: Segment[]; tools: ToolDefinition[]; stats: { bySegment: Partial<Record<SegmentKind, number>>; total: number } }`
    - `ChatInput { author: { kind: 'human' | 'bot'; id: string }; text: string; mentions?: string[]; replyTo?: string; act?: SpeechAct }`
  - `options.ts`：`interface Options`（6.1 全部字段 + `leadTimeoutMs`），`DEFAULT_OPTIONS: Required<Options>`，`resolveOptions(o?: Options): Required<Options>`
  - `errors.ts`：`type ErrorCode = 'BUDGET_TOO_SMALL' | 'STALE_VERSION' | 'INVALID_OP' | 'INVALID_PLAN' | 'NOT_A_MEMBER' | 'FORBIDDEN' | 'PROJECT_NOT_COMPLETE' | 'PROJECT_CLOSED' | 'NOT_FOUND'`；`class ContextError extends Error { code: ErrorCode; details?: unknown }`；`class BudgetTooSmallError extends ContextError`（code 固定 `BUDGET_TOO_SMALL`，`details: { required: number; budget: number }`）
  - `tokens.ts`：`defaultCountTokens(text: string): number`；`truncateToTokens(text: string, max: number, count: (s: string) => number): string`
  - `clock.ts`：`interface Clock { now(): number; setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void }`；`systemClock: Clock`
  - `ids.ts`：`newId(prefix: string): string`（`${prefix}-${randomUUID().slice(0, 8)}`）

- [ ] **Step 1: 建立 workspace 与 core 包**

根 `package.json`：`private: true`，`packageManager: "pnpm@10.28.0"`，`scripts.test = "pnpm -r test"`。`pnpm-workspace.yaml` 包含 `packages/*`。`tsconfig.base.json`：`target ES2023`、`module NodeNext`、`moduleResolution NodeNext`、`strict`、`noUncheckedIndexedAccess`、`declaration`。`packages/core/package.json`：名称 `@context-continue/core`，`type: module`，`exports: "./dist/index.js"`，脚本 `test: vitest run`、`typecheck: tsc --noEmit`、`build: tsc`；依赖 `zod@4.6.7`；开发依赖 `typescript@6.0.3`、`vitest@5.0.4`、`@types/node@^22`。运行 `pnpm install`。

- [ ] **Step 2: 写失败的测试**

```ts
// test/tokens.test.ts
import { defaultCountTokens, truncateToTokens } from '../src/tokens.js';
test('CJK counts one token per char, other text ~4 chars per token', () => {
  expect(defaultCountTokens('你好世界')).toBe(4);
  expect(defaultCountTokens('abcdefgh')).toBe(2);
  expect(defaultCountTokens('你好abcd')).toBe(3);
  expect(defaultCountTokens('')).toBe(0);
});
test('truncate never splits a surrogate pair', () => {
  const s = '😀'.repeat(20);
  const t = truncateToTokens(s, 3, defaultCountTokens);
  expect([...t].every(ch => ch === '😀')).toBe(true);
  expect(defaultCountTokens(t)).toBeLessThanOrEqual(3);
});
// test/options.test.ts
import { resolveOptions, DEFAULT_OPTIONS } from '../src/options.js';
test('defaults match spec 6.1', () => {
  expect(DEFAULT_OPTIONS).toMatchObject({ extractEvery: 10, idleMs: 60_000, recentForRouter: 5, boardMaxTokens: 3_000,
    notesMaxTokens: 2_000, memoryMaxTokens: 1_500, maxBotTurnsPerHumanMessage: 6, maxReviewRounds: 3,
    maxPlanRejects: 3, maxPromotionsPerTurn: 3, maxHops: 4, recentKeep: 5, leadTimeoutMs: 600_000 });
  expect(resolveOptions({ maxHops: 2 }).maxHops).toBe(2);
});
```

- [ ] **Step 3: 运行，确认失败**

Run: `pnpm -C packages/core test`
Expected: FAIL（模块不存在）

- [ ] **Step 4: 实现 Interfaces 中列出的全部文件**

`defaultCountTokens`：CJK 统一表意文字、假名、韩文按每字 1 计；其余字符按 `Math.ceil(n / 4)`。`truncateToTokens` 按 `[...text]`（码点）逐个累加，超限即停。`index.ts` 先导出这些模块。

- [ ] **Step 5: 运行测试与类型检查**

Run: `pnpm -C packages/core test && pnpm -C packages/core typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json packages/core
git commit -m "feat(core): scaffold package with spec types, options, errors and token counting"
```

---

### Task 2: Store 接口、内存实现与契约测试

**Files:**
- Create: `packages/core/src/store/store.ts`, `packages/core/src/store/memory.ts`
- Create: `packages/core/test/store.contract.ts`, `packages/core/test/store.memory.test.ts`

**Interfaces:**
- Consumes: Task 1 的类型与 `ContextError`。
- Produces：
  - `interface Store`：设计文档 6.3 的全部方法，外加：
    - `createBoard(board: ProjectBoard): Promise<void>`（已存在则抛 `ContextError('INVALID_OP')`）
    - `savePending(p: PendingProposal): Promise<void>`、`listPending(projectId: string): Promise<PendingProposal[]>`（按 `createdAt` 升序）、`deletePending(id: string): Promise<void>`
    - `getMeta<T>(projectId: string, key: string): Promise<T | null>`、`setMeta(projectId: string, key: string, value: unknown): Promise<void>`
    - `listMemories(): Promise<EmployeeMemory[]>`（员工名录用）
  - 行为约定：`append` 分配从 1 开始连续的 `seq`；`saveBoard` 在 `expectedVersion !== 当前 version` 时抛 `ContextError('STALE_VERSION')`，成功时 board 与 change 一起写入；`getBoard` 不存在时抛 `ContextError('NOT_FOUND')`；`search` 对聊天文本和 `archived` 事件的 `ref` 做不区分大小写的匹配；`drainProposals` 取出并清空；所有读取返回深拷贝。
  - `memoryStore(): Store`
  - `runStoreContract(name: string, make: () => Promise<Store>): void`（在 `store.contract.ts` 中，供 Task 3 复用）

- [ ] **Step 1: 写契约测试**

`runStoreContract` 内的测试（每个都用 `make()` 新建实例）：
```ts
test('append assigns consecutive seq per project', async () => {
  const a = await s.append(chat('p1', 'hi')); const b = await s.append(chat('p1', 'yo')); const c = await s.append(chat('p2', 'x'));
  expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 1]);
  expect((await s.read('p1', 2)).map(e => e.seq)).toEqual([2]);
  expect(await s.latestSeq('p1')).toBe(2);
});
test('saveBoard rejects stale version and stores change atomically', async () => {
  await s.createBoard(board('p1')); // version 0
  await s.saveBoard({ ...board('p1'), version: 1 }, 0, change(1));
  await expect(s.saveBoard({ ...board('p1'), version: 2 }, 0, change(2))).rejects.toMatchObject({ code: 'STALE_VERSION' });
  expect((await s.getBoard('p1')).version).toBe(1);
  expect((await s.getBoardChanges('p1', 0)).map(c => c.version)).toEqual([1]);
});
test('search finds chat text and archived refs, case-insensitive', async () => { /* 断言两类条目都能被 'Pixel' 搜到 */ });
test('drainProposals empties the queue', async () => { /* 入队 2 个，drain 得到 2 个，再 drain 得到 0 个 */ });
test('pending list ordered by createdAt and deletable', async () => { /* … */ });
test('workspace and memory are isolated by key', async () => {
  await s.saveWorkspace(ws('p1', 'art')); expect(await s.getWorkspace('p1', 'logic')).toBeNull(); expect(await s.getWorkspace('p2', 'art')).toBeNull();
});
test('reads return copies', async () => { /* 修改 getBoard 返回值后再读，值不变 */ });
test('deliverables round-trip by ref', async () => { /* put 后 get 得到原文 */ });
test('meta round-trip', async () => { /* setMeta 后 getMeta 相等，未设置的键为 null */ });
```
`store.memory.test.ts`：`runStoreContract('memory', async () => memoryStore())`。

- [ ] **Step 2: 运行，确认失败**

Run: `pnpm -C packages/core test store.memory`
Expected: FAIL

- [ ] **Step 3: 实现 `store.ts` 接口与 `memoryStore`**（用 `structuredClone` 返回副本）

- [ ] **Step 4: 运行，确认通过**

Run: `pnpm -C packages/core test store.memory && pnpm -C packages/core typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/store packages/core/test/store.contract.ts packages/core/test/store.memory.test.ts
git commit -m "feat(core): add Store interface, memory store and store contract tests"
```

---

### Task 3: SQLite 存储

**Files:**
- Create: `packages/core/src/store/sqlite.ts`
- Test: `packages/core/test/store.sqlite.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `Store`、`runStoreContract`。
- Produces: `sqliteStore(path: string): Store`（`':memory:'` 可用）；`close(): void` 作为返回对象的额外方法（`Store & { close(): void }`）。

- [ ] **Step 1: 写测试**

```ts
runStoreContract('sqlite', async () => sqliteStore(':memory:'));
test('data survives reopening a file database', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'cc-')), 'db.sqlite');
  const a = sqliteStore(file); await a.append(chat('p1', 'persist me')); a.close();
  const b = sqliteStore(file); expect((await b.read('p1', 1))[0]!.body).toMatchObject({ text: 'persist me' }); b.close();
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `pnpm -C packages/core test store.sqlite`
Expected: FAIL

- [ ] **Step 3: 实现**

用 `node:sqlite` 的 `DatabaseSync`。表：`ledger(project_id, seq, json, PRIMARY KEY(project_id, seq))`、`ledger_fts`（FTS5，列 `project_id UNINDEXED, seq UNINDEXED, text`，写入聊天文本或 `archived.ref`）、`boards(project_id PK, version, json)`、`board_changes(project_id, version, json)`、`proposals`、`pending`、`plan_proposals`、`workspaces(project_id, bot_id, json)`、`memories(bot_id PK, json)`、`deliverables(project_id, ref, content)`、`meta(project_id, key, json)`。`saveBoard` 在一个事务内执行 `UPDATE boards … WHERE version = ?` 并检查影响行数，再插入变更记录。`search` 使用 FTS5 `MATCH`，查询串用双引号包裹并转义，以免特殊字符报错。

- [ ] **Step 4: 运行，确认通过**

Run: `pnpm -C packages/core test store && pnpm -C packages/core typecheck`
Expected: PASS（内存与 SQLite 两套契约测试均通过）

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/store/sqlite.ts packages/core/test/store.sqlite.test.ts
git commit -m "feat(core): add node:sqlite store with FTS5 ledger search"
```

---

### Task 4: 操作校验、应用与项目板大小控制

**Files:**
- Create: `packages/core/src/board/schema.ts`, `packages/core/src/board/apply.ts`, `packages/core/src/board/archive.ts`
- Test: `packages/core/test/board.apply.test.ts`

**Interfaces:**
- Consumes: Task 1 类型、`newId`、`ContextError`。
- Produces：
  - `boardOpSchema: z.ZodType<BoardOp>`（`addFact`/`addDecision`/`addFailure` 的 `affects` 必须非空；字符串字段非空）
  - `parseOps(raw: unknown[]): { ok: BoardOp[]; rejected: { index: number; reason: string }[] }`
  - `applyOp(board: ProjectBoard, op: BoardOp, meta: { by: string; authority: 'human' | 'bot' }): { board: ProjectBoard; touched: string[]; archived: { section: string; item: unknown }[] }` —— 纯函数，不修改入参；目标 id 不存在时抛 `ContextError('INVALID_OP')`
  - `enforceBoardSize(board: ProjectBoard, maxTokens: number, count: (s: string) => number, renderPublic: (b: ProjectBoard) => string): { board: ProjectBoard; archived: { section: string; item: unknown }[] }`

- [ ] **Step 1: 写失败的测试**

```ts
test('add assigns id and authority from meta', () => {
  const { board, touched } = applyOp(empty(), { op: 'add', section: 'conventions', item: { text: '16x16 pixel art', source: src() } }, { by: 'art', authority: 'bot' });
  expect(board.conventions[0]).toMatchObject({ text: '16x16 pixel art', authority: 'bot' });
  expect(touched).toEqual([board.conventions[0]!.id]);
});
test('supersede removes the old item and links the new one', () => {
  const b1 = withDecision('d1');
  const { board, archived } = applyOp(b1, { op: 'supersede', section: 'decisions', id: 'd1', item: { text: 'use 32x32', source: src() } }, bot('art'));
  expect(board.decisions.map(d => d.id)).not.toContain('d1');
  expect(board.decisions[0]!.supersedes).toBe('d1');
  expect(archived[0]).toMatchObject({ section: 'decisions', item: { id: 'd1' } });
});
test('updateContract bumps version', () => { /* version 1 → 2，spec 改变 */ });
test('closeQuestion archives the question', () => { /* openQuestions 移除且 archived 返回该问题 */ });
test('addDeliverable appends with incrementing version', () => { /* 同一工作块两次交付，version 为 1、2 */ });
test('unknown target id throws INVALID_OP', () => {
  expect(() => applyOp(empty(), { op: 'closeQuestion', id: 'nope' }, bot('x'))).toThrow(expect.objectContaining({ code: 'INVALID_OP' }));
});
test('parseOps rejects empty affects but keeps valid ops', () => {
  const r = parseOps([{ op: 'addFact', fact: { text: 'x', affects: [], source: src() } }, { op: 'setGoal', goal: 'g' }]);
  expect(r.ok).toHaveLength(1); expect(r.rejected[0]!.index).toBe(0);
});
test('enforceBoardSize archives closed/superseded first and never drops goal or workstreams', () => { /* 构造超限项目板，断言目标、约束、工作块保留，返回 archived 非空 */ });
test('applyOp does not mutate its input', () => { /* 深比较入参前后一致 */ });
```

- [ ] **Step 2: 运行，确认失败**

Run: `pnpm -C packages/core test board.apply`
Expected: FAIL

- [ ] **Step 3: 实现**

`enforceBoardSize` 的淘汰顺序：最早的约定（`authority: 'bot'`）→ 最早的待决问题。目标、约束和工作块列表永不淘汰；淘汰到 `count(renderPublic(board)) <= maxTokens` 或无可淘汰为止。（被覆盖和关闭的条目已在 `applyOp` 时移出，见本计划补充约定。）

- [ ] **Step 4: 运行，确认通过**

Run: `pnpm -C packages/core test board.apply && pnpm -C packages/core typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/board packages/core/test/board.apply.test.ts
git commit -m "feat(core): validate and apply board ops with size control"
```

---

### Task 5: 合并规则与串行合并器

**Files:**
- Create: `packages/core/src/board/classify.ts`, `packages/core/src/board/merge.ts`
- Test: `packages/core/test/board.merge.test.ts`

**Interfaces:**
- Consumes: Task 2 `Store`，Task 4 `applyOp`、`parseOps`、`enforceBoardSize`。
- Produces：
  - `classifyOp(op: BoardOp, ctx: { by: string; lead: string; isExtractor: boolean; ownWorkstreams: string[]; board: ProjectBoard; touchedByOthersSince: Set<string> }): 'auto' | 'lead' | 'human'`
  - `class Merger { constructor(deps: { store: Store; projectId: string; clock: Clock; options: Required<Options>; count: (s: string) => number; renderPublic: (b: ProjectBoard) => string; ownWorkstreams: (botId: string) => Promise<string[]> }); merge(): Promise<MergeResult>; resolve(pendingId: string, r: { by: string; accept: boolean; edits?: BoardOp[] }): Promise<MergeResult> }`
  - `MergeResult { change: BoardChange | null; pending: PendingProposal[]; rejected: { proposalId: string; index: number; reason: string }[] }`

- [ ] **Step 1: 写失败的测试**

```ts
test.each([
  ['addDeliverable', 'auto'], ['setWorkstreamStatus', 'auto'], ['closeQuestion', 'auto'],
  ['updateContract', 'lead'], ['setGoal', 'human'], ['setConstraints', 'human'],
])('%s classified as %s for a non-lead bot', (kind, expected) => { /* … */ });
test('addDecision affecting only own workstream is auto, otherwise lead', () => { /* … */ });
test('bot superseding a human item goes to lead', () => { /* … */ });
test('op touching an item modified by someone else since baseVersion goes to lead', () => { /* … */ });
test('lead own ops skip the lead class but human class still applies', () => { /* lead 的 updateContract → auto；setGoal → human */ });
test('extractor addDecision is auto with human authority', () => { /* … */ });

test('merge applies auto ops in one change and bumps version once', async () => {
  const { store, merger } = await setup(); // 项目板 version 0
  await store.enqueueProposal(prop('art', [addConvention('a'), addConvention('b')]));
  const r = await merger.merge();
  expect(r.change!.version).toBe(1); expect(r.change!.ops).toHaveLength(2);
  expect((await store.getBoard('p1')).version).toBe(1);
});
test('lead and human ops become pending and emit nothing to the board', async () => { /* pending.needs 分别为 lead/human */ });
test('invalid ops are rejected individually', async () => { /* 一条非法、一条合法：合法的进 change，非法的进 rejected */ });
test('concurrent merge calls are serialized: versions are consecutive, no op lost', async () => {
  // 入队 10 个提案后并发调用 merge() 5 次
  // 断言：所有 change 的版本号连续，且总 op 数为 10
});
test('stale version on save is retried against the fresh board', async () => { /* 用包装 Store 在第一次 saveBoard 前抢先写入，断言最终成功且两边的修改都在 */ });
test('resolve: lead accept applies ops; human pending requires owner', async () => {
  // needs lead：by 不是 lead → FORBIDDEN；needs human：by 不是 owner → FORBIDDEN；accept:false → 删除且不改项目板
});
test('archived items are written to the ledger as archived events', async () => { /* supersede 后日志中有 archived 事件 */ });
```

- [ ] **Step 2: 运行，确认失败**

Run: `pnpm -C packages/core test board.merge`
Expected: FAIL

- [ ] **Step 3: 实现**

`Merger` 内部维护一个 Promise 链作为串行锁。一次 `merge()`：取出全部提案 → 对每个提案计算 `touchedByOthersSince`（`getBoardChanges(baseVersion)` 中 `by` 不同的 `touched` 并集）→ 解析与分类 → 依次应用 `auto` 操作 → `enforceBoardSize` → `saveBoard(newBoard, oldVersion, change)`；遇到 `STALE_VERSION` 时重新读取并对同一批操作重试，最多 3 次，之后抛错。`lead`/`human` 操作按提案分组写成 `PendingProposal`。每个 `archived` 条目追加一条 `archived` 事件；有 change 时再追加一条 `boardMerged` 事件。`resolve` 接受时把 `edits ?? ops` 当作 `auto` 应用（作者仍为原提交者，`authority` 按原提交者）。

- [ ] **Step 4: 运行，确认通过**

Run: `pnpm -C packages/core test board && pnpm -C packages/core typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/board/classify.ts packages/core/src/board/merge.ts packages/core/test/board.merge.test.ts
git commit -m "feat(core): classify ops per spec section 3 and merge serially with version checks"
```

---

### Task 6: 员工名录、拆分校验与工作块来源

**Files:**
- Create: `packages/core/src/employees.ts`, `packages/core/src/plan/validate.ts`, `packages/core/src/workstreams/source.ts`
- Create: `packages/core/test/workstreams.contract.ts`
- Test: `packages/core/test/plan.test.ts`, `packages/core/test/workstreams.local.test.ts`

**Interfaces:**
- Consumes: Task 2 `Store`。
- Produces：
  - `createEmployeeRegistry(deps: { store: Store }): EmployeeRegistry`，其中 `EmployeeRegistry { upsert(e: { botId: string; persona: string; skills: string[] }): Promise<void>; get(botId: string): Promise<EmployeeMemory | null>; roster(): Promise<{ botId: string; persona: string; skills: string[] }[]> }`。`upsert` 只更新 persona/skills，不动 memories；`roster` 基于 `store.listMemories()`。
  - `PlanInput { workstreams: { id: string; title: string; brief: string; owner: string; dependsOn: string[]; writeScopes?: string[] }[]; contracts: { id: string; from: string; to: string; spec: string }[] }`
  - `validatePlan(plan: PlanInput, rosterIds: Set<string>): { ok: true } | { ok: false; reasons: string[] }`
  - `WorkstreamSource`：设计文档 6.4 原样。
  - `localWorkstreamSource(store: Store): WorkstreamSource`（状态存在项目板 `workstreams` 中，`setStatus` 通过 `saveBoard` 写入并带变更记录）
  - `resolveWorkstreams(board: ProjectBoard, source: WorkstreamSource): Promise<Workstream[]>` —— 以 `source.list` 的 id、标题、负责人、依赖、修改范围、状态为准，合并项目板里保存的 `brief`、`deliverables`、`reviewRounds`
  - `runWorkstreamContract(name: string, make: () => Promise<{ source: WorkstreamSource; projectId: string }>): void`

- [ ] **Step 1: 写失败的测试**

```ts
test('rejects dependency cycles with the cycle in the reason', () => {
  const r = validatePlan(plan([['a', ['b']], ['b', ['a']]]), roster('x'));
  expect(r).toEqual({ ok: false, reasons: [expect.stringContaining('a -> b -> a')] });
});
test('rejects owners not in the roster, unknown deps, duplicate ids, contracts on unknown workstreams', () => { /* 每种一个断言 */ });
test('accepts a valid DAG', () => { expect(validatePlan(validPlan(), roster('art', 'logic'))).toEqual({ ok: true }); });
test('registry upsert keeps memories', async () => { /* 先写入记忆，再 upsert persona，记忆仍在 */ });
// workstreams.contract.ts
test('create then list returns the workstreams with status pending', async () => { /* … */ });
test('setStatus is visible in list and fires onChange with the id', async () => { /* … */ });
test('onChange unsubscribe stops notifications', async () => { /* … */ });
```
`workstreams.local.test.ts`：`runWorkstreamContract('local', …)`，另加 `resolveWorkstreams` 合并字段的测试。

- [ ] **Step 2: 运行，确认失败**

Run: `pnpm -C packages/core test plan workstreams`
Expected: FAIL

- [ ] **Step 3: 实现**（环检测用 DFS，报告第一个环的路径 `a -> b -> a`）

- [ ] **Step 4: 运行，确认通过**

Run: `pnpm -C packages/core test && pnpm -C packages/core typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/employees.ts packages/core/src/plan packages/core/src/workstreams packages/core/test
git commit -m "feat(core): add employee registry, plan validation and workstream sources"
```

---

### Task 7: 由项目结构推导唤醒

**Files:**
- Create: `packages/core/src/board/diff.ts`
- Test: `packages/core/test/board.diff.test.ts`

**Interfaces:**
- Consumes: Task 1 `BoardChange`、`Wake`；Task 6 `Workstream`。
- Produces：
  - `structuralWakes(change: BoardChange, before: Workstream[], after: Workstream[], board: ProjectBoard): Wake[]`
  - `newlyReady(before: Workstream[], after: Workstream[]): string[]` —— 状态为 `pending`、依赖全部 `delivered`、且此前未满足条件的工作块 id
  - `writeScopeOverlaps(workstreams: Workstream[]): { a: string; b: string; prefix: string }[]` —— 只比较 `active` 的工作块；路径前缀按 `/` 分段比较（`src/ui` 与 `src/ui/button` 重叠，`src/ui` 与 `src/uix` 不重叠）

- [ ] **Step 1: 写失败的测试**

```ts
test('decision affecting a workstream wakes its owner with decisionChanged', () => {
  const w = structuralWakes(changeWith(addDecision({ affects: ['logic'] })), ws, ws, board);
  expect(w).toEqual([{ botId: 'logic-bot', reason: 'decisionChanged', detail: expect.any(String) }]);
});
test('facts and failures also trigger decisionChanged', () => { /* … */ });
test('contract update wakes both from and to owners', () => { /* … */ });
test('delivery of the last dependency wakes the dependent with upstreamDelivered', () => { /* before：b 依赖 a，a active；after：a delivered → 唤醒 b 的负责人 */ });
test('blocked workstream owner is not woken by upstreamDelivered', () => { /* … */ });
test('one wake per bot per reason even if several ops hit it', () => { /* 去重 */ });
test('writeScopeOverlaps compares path segments', () => {
  expect(writeScopeOverlaps([act('a', ['src/ui']), act('b', ['src/ui/button'])])).toEqual([{ a: 'a', b: 'b', prefix: 'src/ui' }]);
  expect(writeScopeOverlaps([act('a', ['src/ui']), act('b', ['src/uix'])])).toEqual([]);
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `pnpm -C packages/core test board.diff`
Expected: FAIL

- [ ] **Step 3: 实现**（被唤醒者一律通过 `workstream.owner` 解析；`blocked` 工作块只接受 `decisionChanged`、`contractChanged`）

- [ ] **Step 4: 运行，确认通过**

Run: `pnpm -C packages/core test board.diff && pnpm -C packages/core typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/board/diff.ts packages/core/test/board.diff.test.ts
git commit -m "feat(core): derive structural wakes and write-scope overlaps from board changes"
```

---

### Task 8: 聊天写入与唤醒规则

**Files:**
- Create: `packages/core/src/route.ts`
- Test: `packages/core/test/route.test.ts`

**Interfaces:**
- Consumes: Task 2 `Store`，Task 6 `resolveWorkstreams`。
- Produces：
  - `toLedgerEntry(input: ChatInput, parent: LedgerEntry | null): Omit<LedgerEntry, 'seq' | 'id' | 'createdAt' | 'projectId'>` —— `hops = parent ? parent.hops + 1 : 0`（忽略调用方传入的值）；Bot 消息缺少 `act` 时记为 `inform`
  - `RouteInput { boardPublic: string; recent: LedgerEntry[]; candidates: { botId: string; workstreams: string[] }[]; message: LedgerEntry }`
  - `routeChat(entry: LedgerEntry, ctx: RouteContext): Promise<{ wakes: Wake[]; limitReached: boolean }>`，其中 `RouteContext { lead: string; members: Set<string>; workstreams: Workstream[]; botTurnsSinceHuman: number; parent: LedgerEntry | null; options: Required<Options>; route?: (i: RouteInput) => Promise<string[]>; routeInput: () => Promise<RouteInput> }`
  - `matchWorkstreams(text: string, workstreams: Workstream[]): string[]` —— 匹配 id 或标题；ASCII 标题整词、不区分大小写；含 CJK 的标题按子串

- [ ] **Step 1: 写失败的测试**

```ts
test('human @mention wakes the mentioned member with mentioned', async () => { /* … */ });
test('bot message wakes the mentioned bot only for request/query/propose', async () => {
  for (const act of ['request', 'query', 'propose'] as const) expect((await route(botMsg({ act, mentions: ['logic'] }))).wakes).toHaveLength(1);
  for (const act of ['inform', 'agree', 'refuse', 'done'] as const) expect((await route(botMsg({ act, mentions: ['logic'] }))).wakes).toEqual([]);
});
test('reply to a bot message counts as mention of that bot', async () => { /* … */ });
test('hops at maxHops wakes lead with needsLead instead of the other bot', async () => {
  const r = await route(botMsg({ act: 'request', mentions: ['logic'], hops: 4 }));
  expect(r.wakes).toEqual([{ botId: 'pm', reason: 'needsLead', detail: expect.stringContaining('hops') }]);
});
test('wake limit: after 6 bot turns since the last human message, nothing wakes', async () => {
  const r = await route(botMsg({ act: 'request', mentions: ['logic'] }), { botTurnsSinceHuman: 6 });
  expect(r).toEqual({ wakes: [], limitReached: true });
});
test('unaddressed human message mentioning a workstream title wakes its owner with routed', async () => { /* … */ });
test('ASCII titles match whole words only; CJK titles match substrings', () => {
  expect(matchWorkstreams('please build it', [ws('ui', 'UI')])).toEqual([]);
  expect(matchWorkstreams('the UI looks off', [ws('ui', 'UI')])).toEqual(['ui']);
  expect(matchWorkstreams('音效再大一点', [ws('sfx', '音效')])).toEqual(['sfx']);
});
test('no match uses models.route, filtered to members; errors fall back to lead', async () => {
  expect((await route(humanMsg('hmm'), { route: async () => ['art', 'ghost'] })).wakes.map(w => w.botId)).toEqual(['art']);
  expect((await route(humanMsg('hmm'), { route: async () => { throw new Error('x'); } })).wakes).toEqual([{ botId: 'pm', reason: 'routed', detail: expect.any(String) }]);
});
test('no match and no model wakes lead', async () => { /* … */ });
test('bot messages never use routed', async () => { /* 未 @ 任何人的 Bot 消息 → [] */ });
test('blocked workstream owner is still woken by mentioned', async () => { /* … */ });
test('toLedgerEntry computes hops from the parent and defaults bot act to inform', () => { /* … */ });
```

- [ ] **Step 2: 运行，确认失败**

Run: `pnpm -C packages/core test route`
Expected: FAIL

- [ ] **Step 3: 实现**（`routeInput` 是惰性函数，只在需要调用路由模型时才构造）

- [ ] **Step 4: 运行，确认通过**

Run: `pnpm -C packages/core test route && pnpm -C packages/core typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/route.ts packages/core/test/route.test.ts
git commit -m "feat(core): route chat with speech acts, hop cap, wake limit and workstream matching"
```

---

### Task 9: 分段渲染

**Files:**
- Create: `packages/core/src/render.ts`
- Test: `packages/core/test/render.test.ts`

**Interfaces:**
- Consumes: Task 1 类型。
- Produces（全部为纯函数，输入相同则输出字节相同）：
  - `renderCommon(members: { id: string; kind: 'human' | 'bot'; role: string }[]): string`
  - `renderBoardPublic(board: ProjectBoard, workstreams: Workstream[]): string`
  - `renderMemory(m: EmployeeMemory, recentKeep: number): string`
  - `renderProjection(p: Projection, seen: Set<string>): { text: string; shownKeys: string[] }`，其中 `Projection { workstream: Workstream | null; contracts: Contract[]; decisions: Decision[]; facts: Fact[]; failures: Failure[]; upstream: { workstream: Workstream; deliverable: Workstream['deliverables'][number] }[]; overlaps: { other: Workstream; prefix: string }[] }`
  - `itemKey(x: Item | Contract): string`（接口约定为 `${id}@${version}`，其余为 `id`）
  - `renderWorkspace(w: Workspace, recentKeep: number): string`
  - `renderDelta(entries: LedgerEntry[], changes: AppliedOp[]): string`
  - `renderTrigger(reason: WakeReason | 'manual', detail: string): string`
  - `renderPlanning(i: { board: ProjectBoard; roster: { botId: string; persona: string; skills: string[] }[]; humanMessages: LedgerEntry[]; previous?: { plan: PlanProposal; feedback?: string } }): string` —— 员工名录每人一行（persona 取第一行）
  - `renderReview(i: { content: string; workstream: Workstream; contracts: Contract[]; conventions: Item[]; decisions: Decision[] }): string` —— 文本以"只检查是否违反约定和接口"的固定说明开头
  - `renderRetro(i: { workspace: Workspace; workstream: Workstream | null; reviews: LedgerEntry[]; memory: EmployeeMemory }): string`

- [ ] **Step 1: 写失败的测试**

```ts
test('board public section is byte-identical for the same board regardless of input array identity', () => {
  expect(renderBoardPublic(structuredClone(b), structuredClone(ws))).toBe(renderBoardPublic(b, ws));
});
test('board public section contains goal, constraints, conventions and the workstream list only', () => {
  const t = renderBoardPublic(b, ws);
  expect(t).toContain(b.goal); expect(t).toContain('art | Art | art-bot | active');
  expect(t).not.toContain(b.decisions[0]!.rationale);
});
test('projection shows unseen items in full and seen items compactly', () => {
  const { text, shownKeys } = renderProjection(proj, new Set(['d1']));
  expect(text).toMatch(/\[d1\] .{1,40} \(seen\)/);
  expect(text).toContain(proj.decisions[1]!.rationale);
  expect(shownKeys).toContain(proj.decisions[1]!.id); expect(shownKeys).not.toContain('d1');
});
test('contract key changes when version changes', () => { expect(itemKey({ ...c, version: 2 })).not.toBe(itemKey(c)); });
test('upstream deliverables appear as summary + ref, never full content', () => { /* 文本含 ref 与 summary */ });
test('memory renders pinned, condensed, then the last recentKeep memories', () => { /* 顺序断言 */ });
test('no timestamps in common, board or memory sections', () => { /* 正则 \d{10,} 不出现 */ });
test('planning context lists every roster member and the previous plan feedback', () => { /* … */ });
test('review context starts with the conventions-and-contracts-only instruction and includes the full content', () => { /* … */ });
```

- [ ] **Step 2: 运行，确认失败**

Run: `pnpm -C packages/core test render`
Expected: FAIL

- [ ] **Step 3: 实现**

固定英文标题：`# Team`、`# Project`、`# Your memory`、`# Your part`、`# Your notes`、`# Since you last looked`、`# Why you are awake`。列表按数组原有顺序输出，工作块行格式为 `id | title | owner | status`。紧凑行格式为 `- [id] <标题前 40 个码点> (seen)`。

- [ ] **Step 4: 运行，确认通过**

Run: `pnpm -C packages/core test render && pnpm -C packages/core typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/render.ts packages/core/test/render.test.ts
git commit -m "feat(core): deterministic renderers for brief segments"
```

---

### Task 10: 简报组装（buildBrief）

**Files:**
- Create: `packages/core/src/brief.ts`
- Test: `packages/core/test/brief.test.ts`
- Create: `packages/core/test/helpers.ts`（`makeProject()` 夹具：内存存储、固定时钟、员工 `pm`（负责人）`art` `logic` `audio`、所有者 `alice`，可选择预先确认一份三个工作块的拆分）

**Interfaces:**
- Consumes: Task 2、6、7、9。
- Produces：
  - `buildBrief(deps: BriefDeps, botId: string, opts: { maxTokens: number; peek?: boolean; trigger?: { reason: WakeReason | 'manual'; detail: string } }): Promise<ContextBundle>`
  - `BriefDeps { store: Store; projectId: string; source: WorkstreamSource; employees: EmployeeRegistry; count: (s: string) => number; options: Required<Options>; tools: (botId: string) => ToolDefinition[] }`
  - `selectProjection(board: ProjectBoard, workstreams: Workstream[], botId: string, overlaps: ReturnType<typeof writeScopeOverlaps>): Projection`

- [ ] **Step 1: 写失败的测试**

```ts
test('segments come in spec order with spec cacheability', async () => {
  const b = await brief('art');
  expect(b.segments.map(s => [s.kind, s.cacheable])).toEqual([
    ['common', true], ['board', true], ['memory', true], ['projection', false], ['workspace', false], ['delta', false], ['trigger', false]]);
});
test('common and board segments are byte-identical across bots at the same version', async () => {
  const [a, l] = [await brief('art', { peek: true }), await brief('logic', { peek: true })];
  expect(a.segments[0]!.text).toBe(l.segments[0]!.text); expect(a.segments[1]!.text).toBe(l.segments[1]!.text);
});
test('projection only includes decisions affecting own workstreams', async () => {
  await decide({ affects: ['logic'], text: 'gravity 9.8' });
  expect(seg(await brief('logic'), 'projection')).toContain('gravity 9.8');
  expect(seg(await brief('audio'), 'projection')).not.toContain('gravity 9.8');
});
test('second brief shows a seen decision compactly; superseding it shows the new one in full', async () => { /* … */ });
test('peek does not mark anything as seen or advance pointers', async () => { /* … */ });
test('delta lists only relevant entries since the last brief', async () => { /* @art 的消息出现在 art 的增量中，不出现在 audio 的增量中；第二次 brief 不再出现 */ });
test('budget trimming order: oldest delta, then recent notes, then recent memories', async () => { /* 逐步缩小 maxTokens，断言被裁的顺序 */ });
test('throws BudgetTooSmallError when fixed segments alone exceed the budget', async () => {
  await expect(brief('art', { maxTokens: 10 })).rejects.toMatchObject({ code: 'BUDGET_TOO_SMALL', details: { budget: 10 } });
});
test('brief before any plan is approved works and says no part assigned yet', async () => { /* Review Focus 3 */ });
test('non-member gets NOT_A_MEMBER', async () => { await expect(brief('ghost')).rejects.toMatchObject({ code: 'NOT_A_MEMBER' }); }); // Review Focus 1
test('write-scope overlap is mentioned in both projections', async () => { /* … */ });
test('promotionsThisTurn resets on brief', async () => { /* … */ });
test('CJK and emoji content in notes is trimmed without broken characters', async () => { /* Review Focus 5 */ });
```

- [ ] **Step 2: 运行，确认失败**

Run: `pnpm -C packages/core test brief`
Expected: FAIL

- [ ] **Step 3: 实现**

成员 = 项目板的 `lead` 加所有工作块负责人；不是成员则抛 `NOT_A_MEMBER`。工作区不存在时，以 `lastSeenSeq = latestSeq`、`lastSeenBoardVersion = 0` 新建（即新加入的员工）。增量的相关性判断：聊天 @ 了本人、回复了本人的消息、文本匹配本人的工作块（复用 `matchWorkstreams`）；事件涉及本人的工作块；变更记录中 `touched` 含本人工作块、或所涉条目的 `affects` 或接口约定的两端包含本人工作块。各段先渲染，再按 5.2 的顺序裁剪；最后一次性保存工作区。

- [ ] **Step 4: 运行，确认通过**

Run: `pnpm -C packages/core test brief && pnpm -C packages/core typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/brief.ts packages/core/test/brief.test.ts packages/core/test/helpers.ts
git commit -m "feat(core): build per-bot briefs with projection, seen compaction, delta and budget trimming"
```

---

### Task 11: 三段式压缩

**Files:**
- Create: `packages/core/src/condense.ts`
- Test: `packages/core/test/condense.test.ts`

**Interfaces:**
- Consumes: Task 1 `Options`、token 函数。
- Produces：
  - `CondenseFn = (input: { pinned: string[]; condensed: string; evicted: string[] }) => Promise<string>`
  - `condenseSegments(state: { pinned: string[]; condensed: string; recent: string[] }, deps: { maxTokens: number; recentKeep: number; count: (s: string) => number; condense?: CondenseFn }): Promise<{ ok: true; state: { pinned: string[]; condensed: string; recent: string[] } } | { ok: false; reason: string }>`
  - `CONDENSE_INSTRUCTION: string` —— 固定的压缩指令文本（导出供宿主放在提示词最前面，内容不含任何变量）
  - 约定：工作区笔记的"段"= `notes` 按空行（`\n\n`）分隔的段落；长期记忆的"段"= 每条非置顶记忆。

- [ ] **Step 1: 写失败的测试**

```ts
test('under budget returns state unchanged', async () => { /* … */ });
test('over budget: evicts all but the last recentKeep recent segments into the summary', async () => {
  const calls: unknown[] = [];
  const r = await condenseSegments(big(10), { maxTokens: 50, recentKeep: 5, count, condense: async i => { calls.push(i); return 'sum'; } });
  expect(r).toMatchObject({ ok: true, state: { condensed: 'sum', recent: big(10).recent.slice(5) } });
  expect(calls[0]).toMatchObject({ evicted: big(10).recent.slice(0, 5) });
});
test('pinned items are never passed for rewriting and always kept', async () => { /* … */ });
test('still over budget shrinks recentKeep down to 1 before failing', async () => { /* … */ });
test('condense throwing or returning empty → ok:false and caller keeps the original', async () => { /* … */ });
test('no condense function: evicted segments are dropped and the old summary kept', async () => { /* … */ });
test('pinned alone over budget → ok:false', async () => { /* … */ });
```

- [ ] **Step 2: 运行，确认失败**

Run: `pnpm -C packages/core test condense`
Expected: FAIL

- [ ] **Step 3: 实现**（校验条件：摘要为非空字符串、置顶内容逐项相等、`count(全部内容) <= maxTokens`）

- [ ] **Step 4: 运行，确认通过**

Run: `pnpm -C packages/core test condense && pnpm -C packages/core typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/condense.ts packages/core/test/condense.test.ts
git commit -m "feat(core): three-region condensing with verify-before-write"
```

---

### Task 12: 项目门面与生命周期

**Files:**
- Create: `packages/core/src/events.ts`, `packages/core/src/project.ts`
- Modify: `packages/core/src/index.ts`（导出 `createProject`、`createEmployeeRegistry`、`memoryStore`、`sqliteStore`、类型）
- Test: `packages/core/test/lifecycle.test.ts`

**Interfaces:**
- Consumes: Task 2–11 的全部产出。
- Produces：
  - `CoreEvents`：`boardChanged { version }`、`wake { wakes: Wake[] }`、`merged { change: BoardChange }`、`needsHuman { reason: string; ref: string }`、`extractFailed { attempts: number }`、`wakeLimitReached { afterSeq: number }`、`writeScopeOverlap { a: string; b: string; prefix: string }`、`condenseAborted { target: 'notes' | 'memory'; botId: string; reason: string }`
  - `createEventBus(): EventBus`，`EventBus { on<K extends keyof CoreEvents>(k: K, h: (e: CoreEvents[K]) => void): () => void; emit<K extends keyof CoreEvents>(k: K, e: CoreEvents[K]): void }`
  - `Submission = { type: 'deliverable'; workstreamId: string; summary: string; content: string } | { type: 'proposal'; ops: BoardOp[] } | { type: 'blocked'; workstreamId: string; reason: string } | { type: 'notes'; text: string; pinned?: boolean }`
  - `withRetry<T>(fn: () => Promise<T>, times = 3): Promise<T>`（在 `project.ts` 内）：除 `append` 外的所有 Store 写入都经过它（第 7 节"其他写入失败最多重试 3 次"）；`append` 失败直接抛出
  - `createProject(cfg: { projectId: string; store: Store; employees: EmployeeRegistry; models?: { route?; extract?; condense? }; workstreams?: WorkstreamSource; countTokens?: (s: string) => number; clock?: Clock; options?: Options }): Project`
  - `Project` 方法（签名按设计文档 6.1，另含本计划补充）：
    - `start(i: { goal: string; constraints: string[]; lead: string; by: string }): Promise<Wake[]>` —— 创建项目板（`owner = by`），写 `projectStarted`，返回 `[{ botId: lead, reason: 'needsLead' }]`
    - `buildPlanningContext(): Promise<ContextBundle>`
    - `proposePlan(plan: PlanInput, o: { by: string }): Promise<{ proposalId: string }>` —— `by` 必须是负责人；校验失败抛 `INVALID_PLAN`（`details.reasons`）；写 `planProposed`，发 `needsHuman`
    - `approvePlan(id: string, o: { by: string; edits?: PlanInput }): Promise<Wake[]>` —— `by` 必须是 `owner`；`source.create` 新工作块；接口约定写入项目板；`planStatus = 'approved'`；可开工的工作块设为 `active` 并返回 `assigned` 唤醒；重新拆分时保留已存在工作块的状态和交付物，`brief`、依赖或接口约定变化的工作块负责人以 `contractChanged` 唤醒；检测修改范围重叠并发事件
    - `rejectPlan(id: string, o: { by: string; feedback: string }): Promise<Wake[]>` —— 计数加一，写 `planRejected`，唤醒负责人；达到 `maxPlanRejects` 时发 `needsHuman`
    - `buildBrief(botId, o)`：委托 Task 10
    - `submit(botId: string, s: Submission): Promise<Wake[]>`，`Submission` 按 6.1；`deliverable` → `putDeliverable` + `addDeliverable` 自动合并 + `deliverableSubmitted` 事件 + 唤醒负责人；`proposal` → 入队并 `merge()`；`blocked` → 状态设为 `blocked` + `blocked` 事件 + 唤醒负责人；`notes` → 追加为新段落并按需压缩
    - `buildReviewContext(deliverableId: string): Promise<ContextBundle>`
    - `submitReview(deliverableId: string, r: { by: string; passed: boolean; notes: string; conventions?: string[] }): Promise<Wake[]>` —— 只允许负责人；通过 → 工作块设为 `delivered` 并返回结构化唤醒；不通过 → `reviewRounds + 1`，`reviewFailed` 事件，唤醒负责人；超过 `maxReviewRounds` 发 `needsHuman`；`conventions` 作为负责人的 `add` 操作合并
    - `resolveProposal(pendingId: string, r: { by: string; accept: boolean; edits?: BoardOp[] }): Promise<Wake[]>`
    - `close(o: { by: string; force?: boolean }): Promise<void>` —— 有未交付工作块且不强制时抛 `PROJECT_NOT_COMPLETE`（`details.pending`）；写 `projectClosed`
    - `buildRetroContext(botId: string): Promise<ContextBundle>`；`commitRetro(botId: string, memories: { text: string; pinned?: boolean }[]): Promise<void>` —— 只能写本人的记忆，按需压缩
    - `ingest(c: ChatInput): Promise<LedgerEntry>`；`route(e: LedgerEntry): Promise<Wake[]>`
    - `merge(): Promise<Wake[]>`；`board(): Promise<ProjectBoard>`；`on`（来自事件总线）
  - 项目关闭后，除 `buildRetroContext`、`commitRetro`、读取类方法外的所有写操作抛 `PROJECT_CLOSED`
  - 每次产生唤醒都额外发出 `wake` 事件
  - 负责人超时：每个 `needs: 'lead'` 的待处理项创建时设置 `leadTimeoutMs` 定时器，到期仍未处理则发 `needsHuman`

- [ ] **Step 1: 写失败的测试**

```ts
test('start wakes the lead and creates the board with owner', async () => { /* … */ });
test('proposePlan by non-lead is FORBIDDEN; invalid plan is INVALID_PLAN with reasons', async () => { /* … */ });
test('approvePlan by non-owner is FORBIDDEN', async () => { /* … */ });
test('approvePlan activates ready workstreams and wakes their owners with assigned', async () => {
  const w = await p.approvePlan(id, { by: 'alice' }); // art、audio 无依赖；logic 依赖 art
  expect(w.map(x => [x.botId, x.reason]).sort()).toEqual([['art', 'assigned'], ['audio', 'assigned']]);
});
test('rejectPlan wakes lead; third rejection emits needsHuman', async () => { /* … */ });
test('deliverable → lead woken → review pass → dependent woken with upstreamDelivered', async () => { /* … */ });
test('review fail increments rounds; exceeding maxReviewRounds emits needsHuman', async () => { /* … */ });
test('review conventions are merged onto the board', async () => { /* … */ });
test('blocked sets status and wakes lead', async () => { /* … */ });
test('replan keeps delivered workstreams and wakes owners whose contracts changed', async () => { /* … */ });
test('setGoal from a bot becomes human-pending; owner resolves it', async () => { /* … */ });
test('lead pending times out into needsHuman', async () => { /* 推进假时钟 600_000 ms */ });
test('close refuses with pending workstreams unless forced; writes after close are PROJECT_CLOSED', async () => { /* … */ });
test('commitRetro writes only own memory and condenses when over budget', async () => { /* … */ });
test('wake events are emitted for every returned wake', async () => { /* … */ });
test('external WorkstreamSource is used when provided', async () => { /* 传入记录调用的假实现，断言 create/setStatus 被调用且核心库项目板不保存状态 */ });
test('WorkstreamSource.list failure makes buildBrief and route throw; setStatus failing 3 times emits needsHuman', async () => { /* … */ });
test('store writes other than append are retried up to 3 times; append failure is thrown immediately', async () => { /* 用会失败 N 次的包装 Store */ });
```

- [ ] **Step 2: 运行，确认失败**

Run: `pnpm -C packages/core test lifecycle`
Expected: FAIL

- [ ] **Step 3: 实现 `events.ts` 与 `project.ts`**（`project.ts` 只做编排，规则逻辑全部调用前面各任务的函数）

- [ ] **Step 4: 运行，确认通过**

Run: `pnpm -C packages/core test && pnpm -C packages/core typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/events.ts packages/core/src/project.ts packages/core/src/index.ts packages/core/test/lifecycle.test.ts
git commit -m "feat(core): project facade with full lifecycle, events and lead timeout"
```

---

### Task 13: 人的聊天抽取调度

**Files:**
- Create: `packages/core/src/extract.ts`
- Modify: `packages/core/src/project.ts`（`ingest` 在人的消息后调用调度器；`createProject` 启动时恢复进度）
- Test: `packages/core/test/extract.test.ts`

**Interfaces:**
- Consumes: Task 2 `Store`（`getMeta`/`setMeta`），Task 5 `Merger`，Task 12 事件总线。
- Produces: `createExtractor(deps: { store: Store; projectId: string; clock: Clock; options: Required<Options>; extract?: (e: LedgerEntry[], b: ProjectBoard) => Promise<BoardOp[]>; enqueue: (ops: BoardOp[], baseVersion: number) => Promise<void>; emit: EventBus['emit'] }): { onHumanMessage(entry: LedgerEntry): Promise<void>; dispose(): void }`。进度存在 `meta` 键 `extract`：`{ fromSeq: number; failures: number }`。

- [ ] **Step 1: 写失败的测试**

```ts
test('runs after extractEvery human messages with only those messages', async () => { /* 10 条人类消息后 extract 被调用一次，入参 10 条 */ });
test('runs after idleMs of silence with pending messages', async () => { /* 3 条消息 + 推进 60_000 ms → 调用一次 */ });
test('bot messages do not count', async () => { /* … */ });
test('extracted ops enter the queue as extractor with human authority', async () => { /* 合并后条目 authority 为 human */ });
test('failure keeps the range for retry; third consecutive failure emits extractFailed', async () => { /* … */ });
test('no extract function: nothing scheduled', async () => { /* … */ });
test('progress survives a new createProject on the same store', async () => { /* … */ });
```

- [ ] **Step 2: 运行，确认失败**

Run: `pnpm -C packages/core test extract`
Expected: FAIL

- [ ] **Step 3: 实现**（同一时刻只允许一个抽取在执行；执行中新到的消息留给下一次）

- [ ] **Step 4: 运行，确认通过**

Run: `pnpm -C packages/core test && pnpm -C packages/core typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/extract.ts packages/core/src/project.ts packages/core/test/extract.test.ts
git commit -m "feat(core): schedule extraction of human chat into board proposals"
```

---

### Task 14: Bot 工具定义与调度

**Files:**
- Create: `packages/core/src/tools.ts`
- Modify: `packages/core/src/project.ts`（增加 `callTool(botId: string, name: string, args: unknown): Promise<unknown>`；`buildBrief` 等返回的 `tools` 使用本模块）
- Test: `packages/core/test/tools.test.ts`

**Interfaces:**
- Consumes: Task 4 `boardOpSchema`，Task 12 `Project`。
- Produces：
  - `toolDefinitions(role: 'lead' | 'member'): ToolDefinition[]` —— 设计文档 6.2 的工具，参数 JSON Schema 由 zod 的 `z.toJSONSchema` 生成。名称固定：`searchLedger`、`getBoardItem`、`getDeliverable`、`submitDeliverable`、`proposeDecision`、`recordFailure`、`promote`、`reportBlocked`、`updateNotes`、`sendMessage`；负责人额外 `proposePlan`、`resolveProposal`、`submitReview`
  - `Project.callTool(botId, name, args)`：参数校验失败抛 `INVALID_OP`；非负责人调用负责人工具抛 `FORBIDDEN`；非成员抛 `NOT_A_MEMBER`；`sendMessage` 的 `act` 必填；`promote` 的 `affects` 必须非空，且每回合超过 `maxPromotionsPerTurn` 次时拒绝；`searchLedger` 只查日志；`getBoardItem` 返回条目完整内容

- [ ] **Step 1: 写失败的测试**

```ts
test('member and lead tool lists match spec 6.2', () => {
  expect(toolDefinitions('member').map(t => t.name).sort()).toEqual(['getBoardItem', 'getDeliverable', 'promote', 'proposeDecision', 'recordFailure', 'reportBlocked', 'searchLedger', 'sendMessage', 'submitDeliverable', 'updateNotes']);
  expect(toolDefinitions('lead').map(t => t.name)).toEqual(expect.arrayContaining(['proposePlan', 'resolveProposal', 'submitReview']));
});
test('sendMessage without act is INVALID_OP', async () => { /* … */ });
test('promote with empty affects is rejected; fourth promotion in a turn is rejected', async () => { /* … */ });
test('member calling submitReview is FORBIDDEN; non-member is NOT_A_MEMBER', async () => { /* Review Focus 1 */ });
test('searchLedger never returns workspace notes or memories', async () => {
  await p.callTool('art', 'updateNotes', { text: 'secret sauce' });
  expect(await p.callTool('logic', 'searchLedger', { query: 'secret sauce' })).toEqual([]);
});
test('one bot cannot read another bot workspace through any tool', async () => { /* 遍历所有工具，断言结果中不含对方笔记 */ });
test('updateNotes pinned:true adds a pinned note', async () => { /* … */ });
```

- [ ] **Step 2: 运行，确认失败**

Run: `pnpm -C packages/core test tools`
Expected: FAIL

- [ ] **Step 3: 实现**

- [ ] **Step 4: 运行，确认通过**

Run: `pnpm -C packages/core test && pnpm -C packages/core typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tools.ts packages/core/src/project.ts packages/core/test/tools.test.ts
git commit -m "feat(core): bot tool definitions and dispatcher with permission checks"
```

---

### Task 15: Markdown 导出、重启恢复与端到端生命周期

**Files:**
- Create: `packages/core/src/markdown.ts`
- Modify: `packages/core/src/project.ts`（增加 `exportMarkdown(): Promise<string>`）、`packages/core/src/index.ts`
- Create: `packages/core/README.md`（安装、最小示例、`buildBrief` 分段如何映射到缓存、MCP 适配无法减少闭源产品全量重读的说明）
- Test: `packages/core/test/e2e.test.ts`

**Interfaces:**
- Consumes: 全部前序任务。
- Produces:
  - `exportMarkdown(board: ProjectBoard, workstreams: Workstream[]): string`（包含所有分区，按项目板顺序；决定含理由与被否决方案）
  - `exportMemoryMarkdown(m: EmployeeMemory): string`，并在 `EmployeeRegistry` 上增加 `exportMarkdown(botId: string): Promise<string>`（2.4"可导出为 Markdown 供人查看和删除"）

- [ ] **Step 1: 写失败的测试**

```ts
test('full lifecycle with sqlite store', async () => {
  // 立项 → 拆分 → 打回 → 重拆 → 确认 → art 交付 → 检查失败（新增约定）→ art 修改再交付 → 通过
  // → logic 被 upstreamDelivered 唤醒 → logic、audio 交付并通过 → 收尾 → 三人复盘
  // 断言：每一步返回的唤醒与原因；最终项目板 status 为 closed；三人的记忆各新增一条
});
test('restart: a new createProject on the same sqlite file produces identical briefs and routing', async () => {
  // Review Focus 4：同一文件、两个实例，peek 简报逐段相同；同一条消息的 route 结果相同
});
test('exportMarkdown contains decisions with rationale and rejected options', async () => { /* … */ });
test('memory markdown lists pinned memories, the summary and each memory with its source project', async () => { /* … */ });
test('across bots at one board version, the cached segments are identical (cache-friendliness)', async () => { /* … */ });
```

- [ ] **Step 2: 运行，确认失败**

Run: `pnpm -C packages/core test e2e`
Expected: FAIL

- [ ] **Step 3: 实现 `markdown.ts`、`exportMarkdown`、`index.ts` 导出，写 README**

- [ ] **Step 4: 运行全部测试、类型检查与构建**

Run: `pnpm -C packages/core test && pnpm -C packages/core typecheck && pnpm -C packages/core build`
Expected: 全部 PASS，`packages/core/dist/index.js` 生成

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): markdown export, restart recovery and end-to-end lifecycle test"
```

---

## 后续计划（本计划完成后分别编写）

1. **DeepSeek Harness 插件**：第一步先做核实（`ctx.systemPrompt` 的 Agent 级片段能否用于队友；私信投递前能否被插件拦截），再实现 `WorkstreamSource` 到 `ctx.agentTeams` 的映射、简报注入和工具注册。
2. **评测**：A/B/C/D 四组 × 三个剧本，输出设计文档 6.8 的全部指标。
3. **MCP 服务**。
4. **OpenClaw 插件**。
