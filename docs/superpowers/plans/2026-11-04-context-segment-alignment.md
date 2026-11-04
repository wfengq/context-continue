# 上下文分段对齐 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 审查与拆分上下文与简报共用前 4 段可缓存前缀，并由核心库渲染触发原因；评测 C 组改用之，重跑对比。

**Architecture:** 核心库 `contexts.ts` 的 `bundle()` 改为输出 `common, memory, workspace, board, projection[, trigger]`，记忆与工作区用 `brief.ts` 相同的渲染；项目门面两个方法增加可选 `{ trigger }`。评测只改 C 组策略。

**Tech Stack:** TypeScript 6.0.3、vitest 5.0.4、Node ≥ 22.5、pnpm workspace（不新增依赖）。

**Spec:** `docs/superpowers/specs/2026-11-04-context-segment-alignment.md`

## Global Constraints

- 不新增依赖；公开 API 只做向后兼容扩展（新增可选参数）。
- 上下文的 `common`、`memory`、`workspace`、`board` 段文字与同一时刻该负责人 `buildBrief`（无预算裁剪时）的对应段逐字节相同。
- 构建上下文不写工作区，除已有的丢弃负责人待确认已看过条目。
- 评测规则不变（统一缓存规则 R-B19，不改剧本与其他组）；输出确定，两次运行逐字节相同。
- 每个提交以如下两行结尾：
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01G3xVb5Sz1dDSz3ha6M4UYJ`
- 不要 `git add` `.superpowers` 或 `results/`。

## Review Focus

1. **负责人没有工作区或员工记忆**：上下文用与 `buildBrief` 相同的默认值渲染，且不因此创建工作区。→ Task 1 测试。
2. **`buildBrief` 因预算裁剪了记忆/工作区**：上下文不裁剪（没有预算参数），两者此时可以不同；测试只在无裁剪时断言逐字节相同。→ Task 1 测试。
3. **触发原因 detail 为空**：与 `renderTrigger` 现有行为一致。→ Task 1 测试。

---

### Task 1: 核心库上下文分段对齐与触发参数

**Files:**
- Modify: `packages/core/src/contexts.ts`（`bundle`、`planningContext`、`reviewContext`）、`packages/core/src/project.ts`（`buildPlanningContext(opts?)`、`buildReviewContext(deliverableId, opts?)` 及接口声明）、必要时 `packages/core/src/brief.ts`/`render.ts`（导出或共用记忆、工作区、触发的渲染）
- Modify: `packages/core/README.md`、设计文档 `docs/superpowers/specs/2026-10-11-group-context-layer-design.md` 第 4 节
- Test: `packages/core/test/lifecycle.test.ts`（或现有上下文测试所在文件）

**Interfaces:**
- Produces: `buildPlanningContext(opts?: { trigger?: { reason: WakeReason | 'manual'; detail: string } }): Promise<ContextBundle>`；`buildReviewContext(deliverableId: string, opts?: 同上): Promise<ContextBundle>`。段种类顺序 `['common','memory','workspace','board','projection']`，传 trigger 时末尾加 `'trigger'`；可缓存标记 `[true,true,true,true,false(,false)]`。

- [ ] **Step 1: 写失败的测试**

```ts
test('review and planning contexts share the brief cacheable prefix byte for byte', async () => {
  const brief = await p.buildBrief(lead, { maxTokens: 1_000_000, peek: true });
  for (const ctx of [await p.buildPlanningContext(), await p.buildReviewContext(dlvId)]) {
    expect(ctx.segments.map(s => s.kind)).toEqual(['common', 'memory', 'workspace', 'board', 'projection']);
    for (const k of ['common', 'memory', 'workspace', 'board']) expect(seg(ctx, k)).toBe(seg(brief, k));
    expect(ctx.segments.map(s => s.cacheable)).toEqual([true, true, true, true, false]);
  }
});
test('a trigger option adds a final non-cacheable trigger segment rendered like the brief trigger', async () => { /* … */ });
test('stats cover every segment', async () => { /* total === sum of bySegment */ });
test('a lead with no workspace gets default memory/workspace text and no workspace is created', async () => { /* … */ });
```

- [ ] **Step 2: 运行确认失败** → FAIL
- [ ] **Step 3: 实现**（复用 `buildBrief` 的渲染函数，不复制格式）；更新 README 与设计文档。
- [ ] **Step 4: 运行确认通过** `pnpm -C packages/core test && pnpm -C packages/core typecheck && pnpm -C packages/bench test && pnpm -C packages/bench typecheck` → PASS（评测中断言旧段数的测试若失败，留给 Task 2 修改，并在报告中列出）
- [ ] **Step 5: Commit** `feat(core): review and planning contexts share the brief's cacheable prefix`

---

### Task 2: 评测 C 组改用核心库触发参数，重跑对比

**Files:**
- Modify: `packages/bench/src/policies/project.ts`（删去 `withTrigger`，把触发原因传给两个上下文方法）、`packages/bench/README.md`、`packages/bench/src/report.ts`（如有描述 C 组上下文段的说明）、`docs/superpowers/specs/2026-11-02-core-visibility-gaps.md` 第 5 节措辞、`packages/core/README.md`（"该 Bot 的待确认条目"→"负责人的待确认条目"）
- Test: `packages/bench/test/policy-project.test.ts`

- [ ] **Step 1: 写失败的测试**：C 组审查/拆分请求的段种类为 `common, memory, workspace, board, projection, trigger`；负责人从简报切换到上下文时，可缓存部分包含 `common`…`board` 中与上一次逐字节相同的前缀（按 R-B19 计算）。
- [ ] **Step 2: 运行确认失败** → FAIL
- [ ] **Step 3: 实现**；改正两处措辞。
- [ ] **Step 4: 运行并重跑**：`pnpm -C packages/core test && pnpm -C packages/bench test && pnpm -C packages/bench typecheck`；`bench run --scenario all --group all` 两次到不同目录，`cmp` 相同；C 组核心错误 0、全部收尾。报告标准与长剧本汇总表前后对比（基线为本计划开始时的提交）。
- [ ] **Step 5: Commit** `feat(bench): group C passes its trigger to the core contexts`
