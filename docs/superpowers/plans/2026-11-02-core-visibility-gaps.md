# 核心库信息缺口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补上核心库的三个信息缺口（负责人看不到未 @ 的人类消息；空转请求导致条目被折叠；审查上下文缺失败记录），评测 C 组改用核心库的审查与拆分上下文，并重跑评测报告前后对比。

**Architecture:** 核心库改 `brief.ts`（负责人增量、两阶段已看过）、`project.ts`（工具调用确认已看过）、`contexts.ts`/`render.ts`（审查上下文加失败记录与事实）；评测包只改 C 组策略 `policies/project.ts` 与报告说明。

**Tech Stack:** TypeScript 6.0.3、vitest 5.0.4、Node ≥ 22.5、pnpm workspace（不新增依赖）。

**Spec:** `docs/superpowers/specs/2026-11-02-core-visibility-gaps.md`（上游：`docs/superpowers/specs/2026-10-11-group-context-layer-design.md`、`docs/superpowers/specs/2026-10-31-bench-long-scenarios.md`）

## Global Constraints

- 不新增依赖；核心库公开 API 只做向后兼容的扩展（新增可选字段/参数）。
- `Workspace` 以 JSON 存储；新增字段在读取旧数据时缺省为空数组，内存与 SQLite 两种存储行为一致（`test/store.contract.ts`）。
- 叫醒规则不变：不新增、不减少任何叫醒。
- 评测输出确定：两次运行 `results.json`、`report.md` 逐字节相同；全部剧本六组 ≤ 120 秒。
- 评测规则不变：统一缓存规则 R-B19（可缓存 = 与该 Bot 上一次请求逐段相同的最长前缀，C 组再受核心库标记限制）；不为 C 组修改剧本、标记或其他组。
- 每个提交以如下两行结尾：
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01G3xVb5Sz1dDSz3ha6M4UYJ`
- 不要 `git add` `.superpowers` 或 `results/`。

## Review Focus

1. **负责人自己发的消息或已在增量里看过的人类消息**：负责人增量不重复显示同一条消息，也不显示负责人自己说的话。→ Task 1 测试。
2. **同一次简报后连续两次工具调用、或工具调用失败**：第一次调用即确认已看过；工具抛错（参数不合法）也算 Bot 行动过，同样确认。→ Task 2 测试。
3. **待确认期间项目板变化（条目被删除或更新版本）**：确认时只并入仍存在于项目板上的键，与现有 `seenItemIds` 过滤规则一致。→ Task 2 测试。
4. **审查一个没有失败记录的工作块**：审查上下文显示 "(none)" 之类的空占位，与其他空节一致，不报错。→ Task 3 测试。
5. **C 组审查的交付物在当前拆分中已不存在或尚无交付物**：按评测既有规则记为核心错误并继续（不应出现在正式剧本中）。→ Task 4 测试。

---

### Task 1: 负责人增量包含所有人类聊天消息

**Files:**
- Modify: `packages/core/src/brief.ts`（`relevantEntries`，约第 136–177 行）
- Modify: `docs/superpowers/specs/2026-10-11-group-context-layer-design.md`（简报第 6 段增量规则处加一句）
- Test: `packages/core/test/brief.test.ts`

**Interfaces:**
- Produces: 负责人的 `delta` 段包含其上次已读之后所有 `author.kind === 'human'` 的聊天条目；其他 Bot 规则不变。

- [ ] **Step 1: 写失败的测试**

```ts
test('the lead sees every human chat message in its delta, even unmentioned and unmatched', async () => {
  // 负责人不负责任何工作块；人类发一条未 @、不匹配任何工作块的消息，以及一条只匹配 fin 工作块的消息
  // 负责人的下一次简报 delta 段包含两条消息的原文
});
test('non-lead bots still see only mentioned, replied or matching human messages', async () => { /* … */ });
test('the lead does not see its own messages and does not see a human message twice', async () => { /* 连续两次简报，第二次 delta 不含已读消息 */ });
```

- [ ] **Step 2: 运行确认失败** `pnpm -C packages/core test -- brief` → FAIL
- [ ] **Step 3: 实现**：在 chat 分支加 `if (isLead && e.author.kind === 'human') return true;`（放在作者是自己的判断之后）；设计文档同步。
- [ ] **Step 4: 运行确认通过** `pnpm -C packages/core test && pnpm -C packages/core typecheck` → PASS
- [ ] **Step 5: Commit** `feat(core): the lead's delta includes every human message`

---

### Task 2: 两阶段"已看过"

**Files:**
- Modify: `packages/core/src/types.ts`（`Workspace` 新增 `pendingSeenItemIds?: string[]`）、`packages/core/src/members.ts`（默认值 `[]`）、`packages/core/src/brief.ts`（约第 223–310 行）、`packages/core/src/project.ts`（`callTool`）
- Modify: 设计文档第 5.2 节"已看过"规则
- Test: `packages/core/test/brief.test.ts`、`packages/core/test/e2e.test.ts`

**Interfaces:**
- Produces:
  - `buildBrief`（非 peek）：渲染时以 `seenItemIds` 为准；本次新显示完整内容的键写入 `pendingSeenItemIds`（覆盖旧的待确认），`seenItemIds` 不变。
  - `callTool(botId, …)`：在执行工具之前，把该 Bot 工作区的 `pendingSeenItemIds` 中仍在项目板上的键并入 `seenItemIds` 并清空待确认；工具随后抛错也不回滚。
  - 读取缺少 `pendingSeenItemIds` 的旧工作区时视为 `[]`。

- [ ] **Step 1: 写失败的测试**

```ts
test('an item shown in a brief with no tool call afterwards is shown in full again', async () => { /* brief → brief：第二次仍完整显示契约 */ });
test('after the bot calls any tool, the item is compacted in the next brief', async () => { /* brief → callTool('updateNotes') → brief：显示为已看过 */ });
test('a failing tool call still confirms the pending items', async () => { /* callTool 参数不合法抛错后，下一次简报折叠 */ });
test('pending keys for items removed from the board are dropped on confirm', async () => { /* … */ });
test('peek briefs neither set nor confirm pending items', async () => { /* … */ });
test('a stored workspace without pendingSeenItemIds loads as empty', async () => { /* memory 与 sqlite 存储 */ });
```

- [ ] **Step 2: 运行确认失败** → FAIL
- [ ] **Step 3: 实现**（按 Interfaces；更新受影响的既有测试断言，不改其含义）
- [ ] **Step 4: 运行确认通过** `pnpm -C packages/core test && pnpm -C packages/core typecheck` → PASS
- [ ] **Step 5: Commit** `feat(core): items count as seen only after the bot acts`

---

### Task 3: 审查上下文加入失败记录与事实

**Files:**
- Modify: `packages/core/src/contexts.ts`（`reviewContext`，约第 63–78 行）、`packages/core/src/render.ts`（`renderReview`）
- Modify: 设计文档第 4 节审查上下文的内容清单
- Test: `packages/core/test/lifecycle.test.ts`（或现有审查上下文测试所在文件）、`packages/core/test/render.test.ts`

**Interfaces:**
- Produces: `renderReview` 入参新增 `failures: Failure[]` 与 `facts: Fact[]`（`affects` 包含被审工作块），按现有失败记录、事实的字段布局渲染（与简报投影一致：失败 = 尝试 / 失败原因 / 影响；事实 = 文本），空时显示与其他空节相同的占位。

- [ ] **Step 1: 写失败的测试**

```ts
test('reviewContext shows failures and facts recorded on the reviewed workstream', async () => { /* recordFailure affects w → 审查上下文包含 tried/why 原文 */ });
test('reviewContext omits failures that do not affect the reviewed workstream', async () => { /* … */ });
test('reviewContext with no failures renders the empty placeholder', async () => { /* … */ });
```

- [ ] **Step 2: 运行确认失败** → FAIL
- [ ] **Step 3: 实现**
- [ ] **Step 4: 运行确认通过** `pnpm -C packages/core test && pnpm -C packages/core typecheck` → PASS
- [ ] **Step 5: Commit** `feat(core): review context includes failures and facts on the reviewed workstream`

---

### Task 4: 评测 C 组改用审查与拆分上下文，重跑对比

**Files:**
- Modify: `packages/bench/src/policies/project.ts`（review、replan 步骤）、`packages/bench/src/report.ts`（C 组说明）、`packages/bench/README.md`、`packages/core/README.md`（"Known gaps"：删去已修复的三项，保留抽取模型一项说明）
- Test: `packages/bench/test/policy-project.test.ts`、`packages/bench/test/report.test.ts`

**Interfaces:**
- Consumes: 核心库导出的 `reviewContext`/`planningContext`（若未从 `index.ts` 导出则通过项目门面已有方法调用；若两者都没有，在 `index.ts` 增加导出——属于向后兼容扩展）。
- Produces: C 组 review 步骤 = 负责人一次请求，内容为 `reviewContext(交付物 id)` 的段，之后 `submitReview`；replan 步骤 = 负责人一次请求，内容为 `planningContext` 的段，之后 `proposePlan` + `approvePlan`。可缓存部分按 R-B19 与该负责人上一次请求比较，再受段的 `cacheable` 标记限制。

- [ ] **Step 1: 写失败的测试**

```ts
test('C review step sends the review context (deliverable text and its failures) as the lead request', async () => { /* 记录的段种类为 common, board, projection；projection 含交付物原文与失败记录 */ });
test('C replan step sends the planning context, which includes every human message so far', async () => { /* … */ });
test('C review/replan records use the R-B19 prefix rule against the lead previous request', async () => { /* … */ });
test('report caveats describe C review and replan contexts and no longer list the fixed gaps', () => { /* … */ });
```

- [ ] **Step 2: 运行确认失败** → FAIL
- [ ] **Step 3: 实现**；更新报告说明与两个 README（不写结果数字）。
- [ ] **Step 4: 运行确认通过并重跑**：
  `pnpm -C packages/core test && pnpm -C packages/bench test && pnpm -C packages/bench typecheck`；
  `pnpm -C packages/bench bench run --scenario all --group all --out /tmp/bench-gaps --stamp T` 两次（第二次 `--out /tmp/bench-gaps2`），`cmp` 两份文件相同；C 组核心错误 0、全部收尾。在报告文件中给出标准与长剧本汇总表的前后对比（基线为本计划开始时的 HEAD 的运行结果）以及 C 组每条事实可见率前后对比。
- [ ] **Step 5: Commit** `feat(bench): group C uses the core review and planning contexts`
