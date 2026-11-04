# 只追加简报流估算 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在评测中加一个 C 组原型模式 `--c-stream on`，把每个 Bot 的请求文字组织成只追加的流并按影响范围分发全项目信息，运行三档剧本估算费用与可见率。

**Architecture:** 只改 `packages/bench`：新文件 `src/policies/stream.ts` 维护每个 Bot 的流与已追加的全项目条目；`src/policies/project.ts` 在 `stream` 模式下用流替代简报文字（核心库调用不变）；`src/cli.ts` 增加两个参数。核心库不改。

**Tech Stack:** TypeScript 6.0.3、vitest 5.0.4、Node ≥ 22.5（不新增依赖）。

**Spec:** `docs/superpowers/specs/2026-11-05-stream-brief-estimate.md`

## Global Constraints

- 不改核心库；不改其他组；`--c-stream off`（默认）时所有输出与改动前逐字节相同（`results.json` 可多一个记录设置的字段，报告参数多一行——同 R-P4）。
- 全项目信息：人类聊天消息、约定、接口约定（含规格）、失败记录、决定（含理由）、工作块状态变化；每条按 id + 版本只追加一次。
- `restreamTokens` 默认 8,000；`--restream-tokens` 为正整数。
- 可缓存部分仍按 R-B19 计算（与该 Bot 上一次请求逐段相同的最长前缀，C 组再受核心库标记限制——流模式下流内各段都标记为可缓存）。
- 输出确定；全部剧本六组 ≤ 300 秒。
- 每个提交以如下两行结尾：
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01G3xVb5Sz1dDSz3ha6M4UYJ`
- 不要 `git add` `.superpowers` 或 `results/`。

## Review Focus

1. **流不是真正只追加**（某段文字在后续请求中被改写）：测试断言同一 Bot 相邻两次请求（未重新快照时）前一次的全部段是后一次的前缀。
2. **全项目条目重复追加或漏追加**（版本更新、条目删除）：测试覆盖新增、更新版本、删除。
3. **重新快照后丢失信息**：快照必须包含当时项目板上的全部全项目信息与全部人类消息（不受 20 条限制）。
4. **审查/拆分请求打断流**：它们的正文作为追加内容，不改变前缀。
5. **off 模式字节相同**：对现有六个剧本跑前后对比。

---

### Task 1: 流策略原型

**Files:**
- Create: `packages/bench/src/policies/stream.ts`
- Modify: `packages/bench/src/policies/project.ts`、`packages/bench/src/policies/index.ts`、`packages/bench/src/cli.ts`、`packages/bench/src/report.ts`（参数行与一条说明）、`packages/bench/README.md`
- Test: `packages/bench/test/policy-stream.test.ts`、`packages/bench/test/cli.test.ts`

- [ ] **Step 1: 写失败的测试**（覆盖 Review Focus 1–5；外加：全项目条目对所有 Bot 可见；只与某 Bot 有关的内容只给它；`restreamTokens` 超限后下一请求为新快照）
- [ ] **Step 2: 运行确认失败** → FAIL
- [ ] **Step 3: 实现**：数据来自 `project.board()`、账本（评测持有的 store）与核心库简报的增量段、触发段；只在评测内拼文字。
- [ ] **Step 4: 运行确认通过** `pnpm -C packages/bench test && pnpm -C packages/bench typecheck`；`off` 模式对现有剧本前后对比相同 → PASS
- [ ] **Step 5: Commit** `feat(bench): --c-stream prototype of append-only, scope-routed briefs for group C`

---

### Task 2: 运行估算并记录

**Files:**
- Modify: `docs/superpowers/specs/2026-11-05-stream-brief-estimate.md`（第 5 节，状态改为"已估算"）

- [ ] **Step 1: 运行**：`--c-stream off` 与 `on` × `--restream-tokens 4000|8000|16000`，`--scenario all --group all`；确认其他组在各设置下完全相同，C 组核心错误 0、全部收尾；`on --restream-tokens 8000` 运行两次逐字节相同。
- [ ] **Step 2: 写结果**：三档剧本 C 组费用、可见率（含按类别）、单次请求中位数与最大值，与 D、E 对比；回答第 1 节的问题（是 / 否 / 部分，在哪些档）；仍然漏看的事实及原因；对"正式实现"的影响（格式、需要核心库提供的接口）。
- [ ] **Step 3: Commit** `docs: record the stream-brief estimate`
