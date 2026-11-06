# 核心库长项目模式 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把只追加的每 Bot 简报流做进核心库（`stream.mode: off | on | auto`），撤下的契约保留可见；评测 C 组改用核心库的流并选定自动开启阈值。

**Architecture:** 核心库新增 `src/stream/`（流状态、快照、追加、条目级差异），项目板增加 `retiredContracts`，门面增加 `buildStream` 与 `recordOwnOutput`；数据全部来自结构化的项目板、账本、记忆、工作区与投影条目，不解析渲染文字。评测 C 组新增 `--c-stream core`。

**Tech Stack:** TypeScript 6.0.3、vitest 5.0.4、Node ≥ 22.5（不新增依赖）。

**Spec:** `docs/superpowers/specs/2026-11-06-core-stream-mode.md`（上游原型：`packages/bench/src/policies/stream.ts` 与 `docs/superpowers/specs/2026-11-05-stream-brief-estimate.md`）

## Global Constraints

- 不新增依赖；公开 API 只做向后兼容扩展。
- `stream.mode` 缺省 `off`：核心库现有方法与全部输出逐字节不变；现有测试不改含义。
- 流的段全部标记可缓存；未重新快照时，同一 Bot 相邻两次 `buildStream` 返回的前一次段列表是后一次的逐字节前缀。
- 渲染沿用核心库现有的条目格式（契约行、失败块、决定字段、条目行），保证标记文字不变。
- 流状态持久化在存储中，内存与 SQLite 行为一致（`test/store.contract.ts`）。
- `restreamTokens` 缺省 8,000；`snapshotHumanKeep` 缺省 40、截断 160 字符；`autoAfterEntries` 缺省值由 Task 5 评测决定。
- 叫醒规则、已看过确认、审查/拆分上下文的状态行为不变。
- 每个提交以如下两行结尾：
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01G3xVb5Sz1dDSz3ha6M4UYJ`
- 不要 `git add` `.superpowers` 或 `results/`。

## Review Focus

1. **前缀被改写**：任何一次非重新快照的 `buildStream` 改动了此前已返回的段。→ Task 2 测试（随机化的长序列也要测）。
2. **条目级差异漏掉内容**：多行条目中间被改、同一小节两个相同条目、条目重排、多个工作块、已读压缩——不得丢内容，也不得把压缩当成变化。→ Task 3 测试。
3. **重新启动后流状态丢失**：用 SQLite 存储关闭再打开项目后，下一次请求仍是正确的追加而不是错乱的前缀。→ Task 2 测试。
4. **自动开启在中途切换**：`auto` 达到阈值的那次请求必须是快照，之后为追加；阈值之前与 `off` 输出相同。→ Task 4 测试。
5. **撤下的契约**：重新拆分撤下后进入 `retiredContracts`，再次加入新计划时从中移除；关闭流时任何输出不变。→ Task 1 测试。

---

### Task 1: 项目板保留撤下的契约

**Files:** Modify `packages/core/src/types.ts`、计划批准处（`src/plan/` 或 `project.ts` 中应用新计划的代码）、`src/store/*`（读取缺省）；Test `packages/core/test/plan.test.ts`、`test/store.contract.ts`

- [ ] 写失败的测试（撤下 → 进入列表并保留最后版本；同 id 重新加入 → 移出列表；旧数据读取为空；关闭流时简报与公共项目板输出不变）
- [ ] 运行确认失败 → 实现 → `pnpm -C packages/core test && pnpm -C packages/core typecheck` 通过
- [ ] Commit `feat(core): keep contracts retired by a replan in board.retiredContracts`

### Task 2: 流状态、快照与全项目追加

**Files:** Create `packages/core/src/stream/state.ts`、`src/stream/build.ts`；Modify `src/project.ts`（`stream` 选项、`buildStream`、`recordOwnOutput`）、`src/options.ts`、`src/index.ts`；Test `packages/core/test/stream.test.ts`

**Interfaces:** `buildStream(botId, { maxTokens, trigger, request? })`、`recordOwnOutput(botId, text)`；`StreamOptions { mode, restreamTokens, autoAfterEntries, snapshotHumanKeep }`。

- [ ] 写失败的测试：Review Focus 1、3；快照内容（含全部全项目信息、已撤下契约、人类消息折叠规则）；全项目变更事件只追加一次（新增 / 改版 / 撤下）；增量去掉已追加的人类消息；触发说明在末尾；`recordOwnOutput` 追加并计入预算；超过预算的下一次请求为快照；`mode: 'off'` 时 `buildStream` 等于现有方法。
- [ ] 运行确认失败 → 实现（本任务的记忆、笔记、投影在追加时整段比较、有变化就整段追加，Task 3 再改为条目级）→ 测试通过
- [ ] Commit `feat(core): append-only per-bot stream (snapshot, project-wide appends, restream)`

### Task 3: 记忆、笔记、投影的条目级更新

**Files:** Create `packages/core/src/stream/diff.ts`；Modify `src/stream/build.ts`、必要时 `src/render.ts`（导出单条目渲染）；Test `packages/core/test/stream.test.ts`

- [ ] 写失败的测试：Review Focus 2（逐项）；新上游交付只追加新内容；"no longer" 只用于真正删除的置顶笔记与列表条目，不用于滚出 Recent 的笔记；按工作块归组的标题。
- [ ] 运行确认失败 → 实现（输入为结构化条目：投影的契约 / 决定 / 事实 / 失败 / 上游交付 / 工作块字段，记忆与笔记的条目；不解析渲染文字）→ 测试通过
- [ ] Commit `feat(core): item-level stream updates for memory, notes and projection`

### Task 4: 自动开启与文档

**Files:** Modify `packages/core/src/stream/*`、`packages/core/README.md`、设计文档 `docs/superpowers/specs/2026-10-11-group-context-layer-design.md`；Test `packages/core/test/stream.test.ts`

- [ ] 写失败的测试：Review Focus 4；`autoAfterEntries` 校验（正整数）。
- [ ] 实现；README 说明长项目模式、何时开启、宿主如何调用 `recordOwnOutput`、与缓存的关系、真实服务商缓存过期等局限。
- [ ] Commit `feat(core): auto stream mode after a ledger-size threshold`

### Task 5: 评测 C 组改用核心库的流并选定阈值

**Files:** Modify `packages/bench/src/policies/project.ts`、`src/cli.ts`、`src/report.ts`、`packages/bench/README.md`、`docs/superpowers/specs/2026-11-06-core-stream-mode.md`（第 5 节）、根 `README.md` 与 `README.zh-CN.md`

- [ ] 写失败的测试：`--c-stream core` 调用 `buildStream` 与 `recordOwnOutput`（作者格式同 E）；其他组不变；`off` 输出不变。
- [ ] 实现并运行：`core` 与原型 `on --c-stream-own on` 在 8k 下三档对比（费用、可见率，解释差异）；`auto` 取若干阈值（例如 200 / 400 / 800 条账本条目）运行三档，选出"标准档不开启、长与超长开启"的阈值，写为 `autoAfterEntries` 缺省值（回到核心库 `options` 改缺省值，单独提交）。
- [ ] 结果写入设计文档第 5 节与两个 README（三档对比表、阈值选择依据、撤下契约保留后的可见率）。
- [ ] Commit `feat(bench): group C on the core stream; choose the auto threshold`
