# 真模型重放 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `--replay`：把每组整个项目的每个请求按顺序发给真模型，记录真实用量、费用与缓存命中，与 R-B19 估算对照；问题请求可随行。

**Architecture:** `ModelRequest` 增加每请求的 `maxTokens` 与 `purpose`；`runScenario` 增加 `replay` 选项，在每个请求（剧本与额外）发出后、问题之前把同样的段发给重放模型，记录 `ReplayRecord`；重放与问题共用一个费用守卫和一个"停止"状态。CLI 解析 `--replay`、离线估算、逐条写 `replay.jsonl`，报告增加重放一节与对照表。

**Tech Stack:** TypeScript 6.0.3、vitest 5.0.4、Node ≥ 22.5；不新增依赖。

**Spec:** `docs/superpowers/specs/2026-11-07-real-model-replay.md`

## Global Constraints

- 不加 `--replay` 时，所有输出与现在逐字节相同；加 `--replay` 时 `CallRecord`（results.json 的 `records`）与不加时相同。
- 不改核心库；不新增依赖；测试不联网（可注入 `fetch` / 模型）。
- 重放请求 `max_tokens` 为 **16**；问题请求仍为 200（`DEFAULT_MAX_TOKENS`）。
- 重放请求的单个失败（400/422、拒答、格式错误）只记为该请求的错误，**不**停止；连续 3 次 400/422 的停止只算问题请求；401/402/403/404、网络重试用尽、费用守卫仍停止**所有**真模型请求（重放与问题）。
- 密钥只从环境读取，不出现在任何输出、报告、jsonl 与错误信息中。
- 每个提交以如下两行结尾：
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01G3xVb5Sz1dDSz3ha6M4UYJ`
- 不要 `git add` `.superpowers` 或 `results/`。

## Review Focus

1. **重放改变了剧本或估算：** 回答不进入项目；`records` 与不加 `--replay` 时相同（Task 2 测试）。
2. **漏发或错序：** 每个剧本与额外请求都恰好重放一次，段与 `CallRecord` 记录的请求相同，且在同一步的问题请求之前（Task 2 测试）。
3. **一个过长请求停掉整个运行：** 连续多个 400 的重放请求不停止重放（Task 1、2 测试）。
4. **费用守卫在中途停止后，报告把未完成的组当成完整的组比较：** 未完成的组不进对照表并标出（Task 3 测试）。
5. **只用 `--replay` 不用 `--probes` 时参数校验出错：** 真模型参数在任一开启时可用，问题参数仍需要 `--probes`（Task 3 测试）。

---

### Task 1: 每请求的输出上限与用途

**Files:** Modify `packages/bench/src/model.ts`、`src/models/anthropic.ts`、`src/models/openai.ts`、`src/cost.ts`；Test `test/anthropic.test.ts`、`test/openai.test.ts`、`test/cost.test.ts`（或现有费用测试所在文件）

**Interfaces:**
- Produces: `ModelRequest.maxTokens?: number`（缺省用适配器的 `maxTokens`）；`ModelRequest.purpose?: 'probe' | 'replay'`（缺省 `'probe'`）。`CostGuardModel` 用 `r.maxTokens ?? opts.maxTokens` 估算下一请求；停止信息改为"requests"（不再只说 probes）。`OpenAIModel` 的连续 400/422 计数只统计 `purpose !== 'replay'` 的请求，`replay` 请求的 400/422 抛普通 `Error`（单个请求失败）且不改变计数。

- [ ] 测试：两个适配器的请求体 `max_tokens` 取 `r.maxTokens`（16）与缺省（200）；`OpenAIModel` 连续 5 个 `purpose: 'replay'` 的 400 都只抛普通错误、不抛 `ProbeStop`，之后一个问题请求的 400 计数从 1 开始；`CostGuardModel` 对 `maxTokens: 16` 的请求估算输出按 16 计；停止信息含 "requests"。
- [ ] 实现；不改现有默认行为（未带新字段的请求与现在相同）。
- [ ] Commit `feat(bench): per-request max_tokens and purpose for real-model requests`

### Task 2: 运行器重放

**Files:** Modify `packages/bench/src/types.ts`、`src/runner.ts`；Test `test/replay.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 的 `ModelRequest.maxTokens` / `purpose`。
- Produces:
  - `export const REPLAY_MAX_TOKENS = 16`（`src/runner.ts` 或 `src/types.ts`）。
  - `interface ReplayRecord { group: Group; scenario: string; step: number; botId: string; kind: 'scripted' | 'extra'; usage?: ModelUsage; error?: string }`（`types.ts`）。
  - `runScenario(s, policy, opts: { model?; probe?; replay?: { model: Model; onReplay?: (r: ReplayRecord) => void | Promise<void> } })` 返回值增加 `replay?: ReplayRecord[]`、`realStopped?: string`（重放或问题任一遇到 `ProbeStop` 时设置；之后两者都不再发送）。不带 `replay` 时返回值与现在完全相同（无新键）。

- [ ] 测试（用记录调用的假模型）：
  - 每个 `CallRecord` 对应恰好一个重放调用，顺序相同，`segments` 与该请求发给剧本模型的相同，`maxTokens === 16`、`purpose === 'replay'`、`scripted === null`。
  - 同一步有问题时，重放调用在问题调用之前。
  - 重放模型返回任意回答时 `records` 与不带 `replay` 时 `toEqual`。
  - 重放模型对某些请求抛普通错误：记录 `error`（经 `probeErrorMessage` 屏蔽），运行继续，后续请求照常重放。
  - 重放模型抛 `ProbeStop`：设置 `realStopped`，之后不再有重放与问题调用，剧本跑完；未发出的问题按现有规则记录。
  - `onReplay` 每条调用一次；它抛 `ProbeStop` 时同样停止。
- [ ] 实现：重放失败带 `usage`（`ProbeModelError`）时记录到 `ReplayRecord.usage`。
- [ ] Commit `feat(bench): replay every group request on a real model`

### Task 3: 命令行、估算与报告

**Files:** Modify `packages/bench/src/cli.ts`、`src/cost.ts`、`src/report.ts`、`packages/bench/README.md`；Test `test/cli.test.ts`、`test/report.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `runScenario` 选项与 `ReplayRecord`、Task 1 的守卫。
- Produces:
  - `--replay`（布尔）。真模型参数（`--provider`、`--model`、`--base-url`、`--api-key-env`、`--price`、`--thinking`、`--dry-run`、`--max-cost`）在 `--probes` 或 `--replay` 任一开启时可用；问题参数（`--probe-groups`、`--probe-samples`、`--max-probes`、`--no-probe-control`）仍需要 `--probes`。正式运行必须有 `--max-cost`。重放的组为 `--group` 选中的全部组。
  - `estimateReplay(records: CallRecord[], price: ModelPrice, maxTokens: number)`（`cost.ts`）：按剧本 × 组返回请求数、输入、可缓存、低 / 高费用（与 `estimateProbeCost` 同一规则）与合计。
  - 重放与问题共用一个 `CostGuardModel`；`--dry-run --replay` 不建适配器、不调用 `fetch`，写 `replay-estimate.json` / `replay-estimate.md` 并打印。
  - 每条 `ReplayRecord` 立即追加到 `<out>/<stamp>/replay.jsonl`；results.json 增加 `replay: { model, provider?, baseUrlHost?, maxTokens: 16, price, maxCost, cost, usage, stopped?, groups: [{ scenario, group, requests, errors, usage, cost, realCacheReadPct, estCacheablePct, estCostUnits, complete }] }`（不含逐条记录）。`complete` 为该剧本该组的每个请求都已重放且未被停止。
  - 报告增加 "Replay on a real model" 一节：说明（spec §5 四条局限，一句一条）；每剧本 × 组一行（spec §3 的字段）；每档一张对照表：C 相对 D、E 的真实费用差 % 与估算费用单位差 %（只用 `complete` 的行，跳过的写明原因）。报告开头的真模型说明行在只有 `--replay` 时也出现。

- [ ] 测试：
  - `--replay` 不带 `--max-cost`（非 dry-run）退出码 2、不创建输出目录；`--replay` 配 `--probe-groups` 不带 `--probes` 退出码 2；`--replay --provider openai --base-url … --model … --price …` 合法。
  - `--dry-run --replay`：注入的 `fetch` 未被调用；估算行数 = 剧本 × 组；请求数等于 `records` 中该组请求数。
  - 注入 `fetch` 的正式运行：`replay.jsonl` 行数等于请求总数；results.json 的 `records` 与不带 `--replay` 时相同；`replay.groups` 的用量之和等于 `replay.usage`；密钥字符串不出现在任何输出文件、stdout、stderr。
  - 守卫中途停止：被停的组 `complete: false`，对照表不含它并写明。
  - 不带 `--replay` 与 `--probes`：输出逐字节相同（沿用现有测试方式）。
- [ ] 实现；README 增加 "Replaying a whole project on a real model" 小节（参数、估算、DeepSeek 示例：长档 `--group all` 中的 A、C、D、E，超长档 `--group C`、`D`、`E` 各一个命令可并行，`--max-cost 8`）。
- [ ] Commit `feat(bench): --replay CLI, estimate and report`

### Task 4: 估算与运行（用户本地）

- [ ] `--dry-run --replay` 估算长档（A、C、D、E）与超长档（C、D、E）的请求数、token 与费用，连同命令一起交给用户；用户在本地用 DeepSeek 运行。
- [ ] 把用户提交的报告结果写入设计文档第 8 节与两个 README（真实费用、真实缓存命中、C 相对 D、E 的真实与估算对照、随行问答的答对率）。
