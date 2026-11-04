# 超长剧本 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `xlong` 档与约 1,000–1,300 步的 `xlong-product` 剧本，使 E 组在默认窗口下触发压缩；报告与记录格式支持超长档；运行并记录结果。

**Architecture:** 评测包内：`types.ts`/`scenario.ts`/`metrics.ts`/`report.ts`/`cli.ts` 增加第三档 `xlong`；`runner.ts` 合并相邻同类段以控制 `results.json` 体积；`src/gen/` 新增 `xlong-product.ts`，复用 `long.ts` 的构建器。核心库不改。

**Tech Stack:** TypeScript 6.0.3、vitest 5.0.4、Node ≥ 22.5、pnpm workspace（不新增依赖）。

**Spec:** `docs/superpowers/specs/2026-11-04-xlong-scenario.md`

## Global Constraints

- 不新增依赖；不改核心库；不改任何组的规则与参数默认值；不为任何组调整剧本。
- 档名 `xlong`；步数 1,000–1,500；覆盖下限：重新拆分 ≥ 6、改需求 ≥ 8、审查未通过 ≥ 15、新增约定合计 ≥ 20、Bot 间询问 ≥ 30、事实 ≥ 40（四类齐全），且至少 10 条事实在引入后 300 步以上仍有机会。
- 增长表每桶步数：standard 与 long 为 25，xlong 为 100。
- 记录格式：`CallRecord.segments` 合并相邻且种类与可缓存标记都相同的段（token 相加）；所有指标不变；对所有剧本生效。
- 输出确定：两次运行逐字节相同；`--scenario all --group all` 本机 ≤ 300 秒。
- 剧本规则：工具名与参数形状同核心库；负责人是员工；审查前已有交付物；不引用已删除的工作块；标记放在事实被告知团队的地方（R-L11），标记字符 `/^[A-Za-z0-9_-]+$/`；C 组核心错误 0、项目收尾；交付物首版 300–1500 字符、后续版本 ≤ 3000 字符。
- 每个提交以如下两行结尾：
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01G3xVb5Sz1dDSz3ha6M4UYJ`
- 不要 `git add` `.superpowers` 或 `results/`。

## Review Focus

1. **段合并改变了指标**：合并前后所有 `inputTokens`、`cacheableTokens`、可见率、报告文字（除说明行外）完全相同。→ Task 1 测试（对现有五个剧本跑前后对比）。
2. **只含一个档的运行**：`--scenario xlong` 只有一张超长档汇总表，标题写明档名（R-L3）。→ Task 1 测试。
3. **长期事实的"300 步以上仍有机会"被关键词或标注凑数**：检查由 `checkCoverage` 基于 `facts` 与实际后续剧本请求计算，而不是标注字段。→ Task 1 测试。
4. **E 组在默认参数下压缩 ≥ 1**：由测试断言，不依赖手动运行。→ Task 2 测试。
5. **生成文本跨周期重复**：相同的交付段落或回复原文在剧本中重复出现的比例受限（测试：任意非空交付段落原文重复出现不超过 2 次）。→ Task 2 测试。

---

### Task 1: `xlong` 档、段合并与报告

**Files:**
- Modify: `packages/bench/src/types.ts`、`src/scenario.ts`（`checkCoverage` 的 xlong 规则）、`src/metrics.ts`（按档的桶大小）、`src/report.ts`（xlong 汇总表与增长表）、`src/cli.ts`（`SCENARIO_SETS` 增加 `xlong`，`all` 包含 xlong 剧本——剧本文件在 Task 2 才存在，本任务里 `xlong` 集合可以先为空并在 Task 2 加入 id）、`src/runner.ts`（段合并）、`packages/bench/README.md`
- Test: `test/scenario.test.ts`、`test/metrics.test.ts`、`test/report.test.ts`、`test/runner.test.ts`、`test/cli.test.ts`

**Interfaces:**
- Produces: `Scenario.tier?: 'standard' | 'long' | 'xlong'`；`GroupMetrics.tier` 同；`growthBucket(tier): number`（25 或 100）；`checkCoverage` 对 xlong 返回缺失项，含 `'xlong scenario needs at least 10 facts needed 300+ steps after they are introduced'`（"需要"= 该事实 audience 中的 Bot 在 `fact.step + 300` 之后有剧本请求的步骤，按剧本步骤的执行者计算）。

- [ ] **Step 1: 写失败的测试**

```ts
test('records merge adjacent segments with the same kind and cacheable flag, metrics unchanged', async () => { /* … */ });
test('the five existing scenarios give identical metrics and report text before and after merging', async () => { /* 用固定的期望或在测试中对比合并前后的计算 */ });
test('xlong growth uses 100-step buckets', () => { /* … */ });
test('checkCoverage enforces xlong minimums including long-lived facts', () => { /* … */ });
test('an xlong-only report has one summary table titled for xlong', () => { /* … */ });
```

- [ ] **Step 2: 运行确认失败** → FAIL
- [ ] **Step 3: 实现**
- [ ] **Step 4: 运行确认通过** `pnpm -C packages/bench test && pnpm -C packages/bench typecheck`；并对现有剧本 `bench run --scenario all --group all` 与改动前对比：`report.md` 相同，`results.json` 只有 `segments` 合并的差异 → PASS
- [ ] **Step 5: Commit** `feat(bench): xlong tier, merged record segments, per-tier growth buckets`

---

### Task 2: `xlong-product` 生成器与剧本

**Files:**
- Create: `packages/bench/src/gen/xlong-product.ts`、`packages/bench/scenarios/xlong-product.json`
- Modify: `packages/bench/src/gen/write.ts`、`packages/bench/src/cli.ts`（加入 xlong id）
- Test: `packages/bench/test/long-scenarios.test.ts`（或新建 `test/xlong-scenario.test.ts`）

**Interfaces:**
- Consumes: `long.ts` 的构建器（Task 1 之前已有）；`checkCoverage` 的 xlong 规则（Task 1）。
- Produces: `generateXlongProduct(): Scenario`。

- [ ] **Step 1: 写失败的测试**：重新生成与已提交文件逐字节相同；加载、tier xlong、步数 1,000–1,500、`checkCoverage` 为空；8 个 Bot；交付物长度规则；六组都能跑完、C 组核心错误 0 且收尾；E 组在默认参数下 `compactions ≥ 1`；每个事实在每组都有机会；任意非空交付段落原文在剧本中出现不超过 2 次（Review Focus 5）。
- [ ] **Step 2: 运行确认失败** → FAIL
- [ ] **Step 3: 实现**：6 个发布周期（账号、计费、协作、离线、导出、合规），每周期的工作块、改需求、打回、约定、询问、失败各不相同；跨周期延续的约定与接口约定在后续周期被引用并带标记；周期末重新拆分。
- [ ] **Step 4: 生成并运行** `pnpm -C packages/bench gen:scenarios && pnpm -C packages/bench test && pnpm -C packages/bench typecheck` → PASS
- [ ] **Step 5: Commit** `feat(bench): xlong-product scenario across six release cycles`

---

### Task 3: 运行与记录结果

**Files:**
- Modify: `docs/superpowers/specs/2026-11-04-xlong-scenario.md`（第 6 节，状态改为"已实现"）、`README.md` 与 `README.zh-CN.md`（加入超长档结果与说明，改写"长剧本没达到 E 组压缩阈值"一条）、`packages/bench/README.md`

- [ ] **Step 1: 运行** `time pnpm -C packages/bench bench run --scenario all --group all --out <仓库外目录>/a --stamp T` 与再次运行到 `/b`，`cmp` 相同；总时间 ≤ 300 秒；C 组核心错误 0、全部收尾。
- [ ] **Step 2: 写结果**：超长档六组汇总（费用、可见率、上下文中位数/P90/最大、E 压缩次数与暂停次数）、每 100 步增长表的要点、E 压缩前后可见率的变化与"摘要保留标记"假定的影响、C 组在 `directivesKeep` 截断下的表现；与长档结论对比，指出哪些结论变了；不写推荐。
- [ ] **Step 3: Commit** `docs: record xlong results`
