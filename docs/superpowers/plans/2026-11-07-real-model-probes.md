# 真模型问答评测 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在评测中加入真模型问答：按事实标注的问题在各组的上下文里提问、确定性判分，并记录真实用量与费用；先实现与离线测试，付费运行前用 `--dry-run` 估算费用并取得用户同意。

**Architecture:** `packages/bench` 新增 probe 调度（不改变剧本请求序列）、判分、真模型适配器（Anthropic Messages API，带缓存断点）与费用守卫；剧本加 probe 标注（标准档手写、长档与超长档由生成器加）。

**Tech Stack:** TypeScript 6.0.3、vitest 5.0.4、Node ≥ 22.5；真模型调用用 Node 内置 `fetch`（不新增依赖）。

**Spec:** `docs/superpowers/specs/2026-11-07-real-model-probes.md`

## Global Constraints

- 不新增依赖；不改核心库；不改任何组的请求序列与现有输出（不加 probe 参数时逐字节相同）。
- 密钥只从环境读取（`ANTHROPIC_API_KEY`，或由环境代理注入），不写入仓库、报告或日志。
- 测试不访问网络：适配器用可注入的 `fetch` 测试。
- 正式运行必须给 `--max-cost`；`--dry-run` 不发任何网络请求。
- 判分只用字符串规则（`expect` 任一命中且无 `reject` 命中），不区分大小写。
- 每个提交以如下两行结尾：
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01G3xVb5Sz1dDSz3ha6M4UYJ`
- 不要 `git add` `.superpowers` 或 `results/`。

## Review Focus

1. **probe 改变了剧本请求或缓存计账**：不加 probe 时输出逐字节相同；加 probe 时剧本请求的记录不变，probe 单独记账。
2. **probe 漏掉对某组的上下文**：probe 请求必须是该组在该时刻发给该 Bot 的完整上下文 + 问题。
3. **费用守卫失效**：达到 `--max-cost` 立即停止并写出已完成的结果。
4. **判分误判**：`expect`/`reject` 同时命中、大小写、数字格式（"12x12" vs "12×12"）。
5. **密钥泄露**：报告、results.json、错误信息中不出现密钥。

---

### Task 1: probe 标注、调度与判分（假模型下可测）

**Files:** Modify `packages/bench/src/types.ts`、`src/scenario.ts`（校验 probe 字段）、`src/runner.ts`（在选定的剧本请求后插入 probe 请求，单独记录）；Create `src/probe.ts`（取样规则、判分）；Test `test/probe.test.ts`

- [ ] 写失败的测试（Review Focus 1、2、4；取样规则：第一次 / 中间 / 最后一次机会；每个剧本最多问题数）
- [ ] 实现；用一个返回固定答案的测试模型验证判分与记录
- [ ] Commit `feat(bench): fact probes scheduled into group contexts with string grading`

### Task 2: 真模型适配器与费用守卫

**Files:** Create `packages/bench/src/models/anthropic.ts`、`src/cost.ts`；Modify `src/cli.ts`（`--model`、`--probes`、`--probe-groups`、`--max-probes`、`--dry-run`、`--max-cost`）、`src/report.ts`（probe 结果表、真实用量与费用、R-B19 对照）、`packages/bench/README.md`；Test `test/anthropic.test.ts`、`test/cli.test.ts`

- [ ] 写失败的测试（可注入 `fetch`；缓存断点按段的可缓存标记设置；用量解析；Review Focus 3、5；`--dry-run` 不调用 `fetch`）
- [ ] 实现（实现前读 claude-api 技能，确认 Messages API 字段、缓存控制与用量字段、`claude-haiku-5-5` 的价目）
- [ ] Commit `feat(bench): Anthropic adapter, cost guard and probe report`

### Task 3: 给剧本加 probe

**Files:** Modify 三个标准剧本 JSON、`src/gen/long-app.ts`、`src/gen/long-event.ts`、`src/gen/xlong-product.ts`（重新生成 JSON）；Test `test/scenarios.test.ts`、`test/long-scenarios.test.ts`

- [ ] 为每条事实写问题与 `expect`（必要时 `reject`：改需求类事实给旧值）；问题不泄露答案；`expect` 取事实中可判定的具体值。
- [ ] 测试：每条事实都有 probe；`expect` 出现在引入该事实那一步的文本中；`reject` 不出现在该步之后的正确文本中。
- [ ] Commit `feat(bench): probes for every annotated fact`

### Task 4: 估算与运行（需要用户同意与密钥）

- [ ] `--dry-run` 估算长档（A、C、D、E）与超长档抽样的问题数、token 数与费用，报告给用户，取得同意与密钥后再运行。
- [ ] 运行并把结果写入设计文档第 5 节与 README（答对率、旧答案率、真实费用与 R-B19 对照）。
