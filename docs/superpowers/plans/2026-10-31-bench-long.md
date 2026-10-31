# 长剧本、分段重排与信息可见率 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 测出项目变长后 C 组（核心库）相对其他组的 token 成本与信息完整性：核心库简报分段重排，新增两个 150–300 步的长剧本，新增"关键信息可见率"指标。

**Architecture:** 核心库只改 `brief.ts` 的分段顺序与可缓存标记。评测包：剧本格式加 `tier` 与 `facts`；runner 在每次请求时按文字匹配记录事实命中；指标与报告按 tier 分开汇总并加增长表与可见率；长剧本由确定性生成器产出并提交 JSON。

**Tech Stack:** TypeScript 6.0.3、vitest 5.0.4、zod 4.6.7、Node ≥ 22.5、pnpm workspace（与现有包相同）。

**Spec:** `docs/superpowers/specs/2026-10-31-bench-long-scenarios.md`（上游：`docs/superpowers/specs/2026-10-31-bench-design.md`）

## Global Constraints

- 不新增依赖；版本同现有 `package.json`。
- 输出确定：同样输入跑两次，`results.json` 与 `report.md` 逐字节相同；生成器不使用 `Math.random`、`Date`、`randomUUID`。
- 六组统一缓存规则（R-B19）：可缓存 = 与该 Bot 上一次请求逐段相同的最长前缀；C 组再受核心库标记限制。之前的全部裁定（R-B1…R-B25，见 SDD 工作区 `prior-rulings.md`）继续有效。
- 剧本规则：工具名与参数形状同核心库 `packages/core/src/tools.ts`；工作块负责人是员工；审查前已有交付物；重新拆分后不再引用被删除的工作块；C 组跑完每个剧本核心错误为 0、项目收尾。
- 标准剧本 20–40 步；长剧本 `tier: 'long'`，150–300 步。
- 交付物 300–1500 字符；长剧本后续版本可到 3000 字符；英文。
- 可见率：机会为 0 时输出 `n/a`，任何地方不得出现 `NaN` / `Infinity`。
- 每个提交以如下两行结尾：
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01G3xVb5Sz1dDSz3ha6M4UYJ`
- 不要 `git add` `.superpowers` 或 `results/`。

## Review Focus

1. **事实 marker 不在引入它的那一步文本里**（拼写、大小写不同）：加载时报错并指出事实 id 与步骤号。→ Task 2 测试。
2. **某条事实的 audience 在它之后一次剧本请求都没有**：该事实各组可见率为 `n/a`，汇总可见率不受影响、不出现 NaN。→ Task 4 测试。
3. **生成器输出与已提交 JSON 不一致**（有人手改了 JSON 或生成器）：测试失败并指出剧本 id。→ Task 6、Task 7 测试。
4. **长剧本运行时间**：`bench run --scenario all --group all` 在本机 120 秒内完成（B 组请求数最多）。→ Task 7 测试（单剧本单组的 e2e 有超时，整体在验证步骤里计时）。
5. **E 组压缩后事实丢失**：压缩前出现过的 marker 在压缩后的请求中仍可命中（spec §5 的有利假设）。→ Task 3 测试。

---

### Task 1: 核心库简报分段重排

**Files:**
- Modify: `packages/core/src/brief.ts`（`CACHEABLE` 表及其键顺序，约第 56–64 行；`kinds` 由其键顺序决定）
- Modify: `docs/superpowers/specs/2026-10-11-group-context-layer-design.md` 第 5.2 节（段顺序与可缓存段）
- Modify: `packages/bench/src/policies/project.ts`（若有按位置假定前 3 段可缓存之处，改为只看核心库标记）
- Test: `packages/core/test/brief.test.ts`（或现有简报测试文件）、`packages/bench/test/policy-project.test.ts`

**Interfaces:**
- Produces: `buildBrief(...).segments` 顺序为 `common, memory, workspace, board, projection, delta, trigger`；`cacheable` 为 `true` 的是前四段。

- [ ] **Step 1: 写失败的测试**

```ts
test('brief segments are ordered stable-first and the first four are cacheable', async () => {
  const b = await project.buildBrief('dev', { maxTokens: 100_000 });
  expect(b.segments.map(s => s.kind)).toEqual(['common', 'memory', 'workspace', 'board', 'projection', 'delta', 'trigger']);
  expect(b.segments.map(s => s.cacheable)).toEqual([true, true, true, true, false, false, false]);
});
test('budget trimming order is unchanged by the reorder', async () => { /* 用现有裁剪测试的输入，断言被裁掉的段种类与重排前相同 */ });
```
bench 侧：`policy-project.test.ts` 中断言 C 组记录的 `segments` 种类顺序为新顺序；"只有项目板变化"的用例中，`common/memory/workspace` 可缓存，`board` 及之后不可缓存。

- [ ] **Step 2: 运行确认失败** `pnpm -C packages/core test` → FAIL（顺序不符）
- [ ] **Step 3: 实现**：调整 `CACHEABLE` 键顺序与取值；按新顺序更新受影响的核心库测试快照/断言（不改其行为含义）；更新设计文档 5.2 节。
- [ ] **Step 4: 运行确认通过** `pnpm -C packages/core test && pnpm -C packages/bench test && pnpm -C packages/bench typecheck` → PASS
- [ ] **Step 5: Commit** `feat(core): order brief segments stable-first (memory, workspace before board)`

---

### Task 2: 剧本格式：tier 与 facts

**Files:**
- Modify: `packages/bench/src/scenario.ts`、`packages/bench/src/types.ts`
- Test: `packages/bench/test/scenario.test.ts`、`packages/bench/test/scenarios.test.ts`

**Interfaces:**
- Produces（`types.ts`）：
  - `interface Fact { id: string; marker: string; step: number; audience: string[] }`
  - `Scenario` 新增 `tier?: 'standard' | 'long'`（缺省 `'standard'`）与 `facts?: Fact[]`
  - `stepText(step: Step): string`（`scenario.ts` 导出）：human → `text`；work → `reply` + 各 op 的 `JSON.stringify(args)`；review → `notes` + `conventions`；replan → `JSON.stringify(plan)`，以换行连接。
  - `checkCoverage(s)` 按 tier 检查步数：standard 20–40，long 150–300；long 另检查 spec §3 的最低次数（replan ≥ 3、改需求 ≥ 4、未通过审查 ≥ 6、带 `conventions` 的审查新增约定合计 ≥ 8、`sendMessage` 且 `act: 'query'` ≥ 10）；事实数 standard 4–6、long ≥ 15，且四类（改需求、约定、接口约定、失败记录）各至少一条——类别由事实 id 前缀表示：`change-`、`conv-`、`contract-`、`fail-`。

- [ ] **Step 1: 写失败的测试**

```ts
test('fact marker must appear in its step text', () => {
  expect(() => validateScenario(withFact({ id: 'conv-x', marker: 'MAX-5MB', step: 3, audience: ['*'] })))
    .toThrow(/fact conv-x.*step 3.*MAX-5MB/);
});
test('fact audience must be employees or "*"', () => { /* audience: ['ghost'] → 报错含 ghost */ });
test('fact step out of range is rejected', () => { /* step: 999 */ });
test('duplicate fact ids are rejected', () => { /* … */ });
test('stepText covers human text, work reply and op args, review notes and conventions, replan plan', () => { /* 每种步骤各一例 */ });
test('checkCoverage enforces step counts by tier', () => {
  expect(checkCoverage({ ...longFixture, steps: longFixture.steps.slice(0, 120) })).toContain('long scenario needs 150–300 steps');
});
test('checkCoverage requires fact categories', () => { /* 缺 fail- 类 → 报告缺失项 */ });
```

- [ ] **Step 2: 运行确认失败** → FAIL
- [ ] **Step 3: 实现**（zod schema 加字段；校验在 `validateScenario` 中报出全部错误，与现有错误风格一致；`checkCoverage` 返回缺失项字符串数组）。现有三个标准剧本此时还没有 facts：`scenarios.test.ts` 中对它们的事实覆盖断言放到 Task 5 再加，本任务只确保它们仍通过校验。
- [ ] **Step 4: 运行确认通过** `pnpm -C packages/bench test && pnpm -C packages/bench typecheck` → PASS
- [ ] **Step 5: Commit** `feat(bench): scenario tier and annotated facts`

---

### Task 3: runner 记录事实命中；E 组摘要保留 marker

**Files:**
- Modify: `packages/bench/src/runner.ts`、`packages/bench/src/types.ts`、`packages/bench/src/policies/dsbot.ts`
- Test: `packages/bench/test/runner.test.ts`、`packages/bench/test/policy-dsbot.test.ts`

**Interfaces:**
- Consumes: `Fact`、`Scenario.facts`（Task 2）。
- Produces: `CallRecord` 新增 `factsSeen?: string[]`、`factsMissed?: string[]`——只在剧本请求上、只对"机会"填写（`audience` 含该 Bot 或 `*`，且请求所在步骤 `> fact.step`）；按事实在剧本中的顺序排列；没有机会时两个字段都省略。命中 = 本次请求全部段文本拼接后包含 `marker`。

- [ ] **Step 1: 写失败的测试**

```ts
test('a scripted request after a fact step records it seen when the marker is in its context', async () => { /* 3 步剧本 + 一条 audience ['*'] 的事实；用一个把历史原样放进上下文的测试策略 */ });
test('a request whose context lacks the marker records it missed', async () => { /* … */ });
test('extra requests and requests at or before the fact step carry no fact fields', async () => { /* … */ });
test('facts for other audiences are not opportunities', async () => { /* … */ });
test('E keeps markers seen before a compaction in the summary', async () => {
  // 小窗口触发压缩；压缩前出现过 marker；压缩后的剧本请求 factsSeen 包含该事实
});
```

- [ ] **Step 2: 运行确认失败** → FAIL
- [ ] **Step 3: 实现**：runner 在 `call` 中计算；E 组压缩时把被压缩内容中出现过的、属于本剧本事实的 marker 写进摘要行（摘要总长仍精确为 `summaryTokens`：marker 放在开头，再用现有方法填充到目标长度；若 marker 本身超过 `summaryTokens`，按事实顺序截断并在 report caveat 中说明，不报错）。策略从 `RunContext.scenario.facts` 拿到事实列表。
- [ ] **Step 4: 运行确认通过** → PASS（含全部旧测试）
- [ ] **Step 5: Commit** `feat(bench): record fact visibility per request; E summaries keep markers`

---

### Task 4: 指标与报告：可见率、增长表、按 tier 汇总

**Files:**
- Modify: `packages/bench/src/metrics.ts`、`packages/bench/src/report.ts`、`packages/bench/src/cli.ts`（传入 tier）
- Test: `packages/bench/test/metrics.test.ts`、`packages/bench/test/report.test.ts`

**Interfaces:**
- Consumes: `CallRecord.factsSeen/factsMissed`（Task 3）、`Scenario.tier`（Task 2）。
- Produces：
  - `GroupMetrics` 新增 `tier: 'standard' | 'long'`、`factOpportunities: number`、`factHits: number`、`factMisses: number`、`perFact: { id: string; opportunities: number; hits: number }[]`、`growth: { fromStep: number; avgInput: number }[]`（每 25 步一桶：`fromStep` = 0, 25, 50…；桶内全部请求的平均输入 token，四舍五入取整；空桶省略）。
  - `computeMetrics(group, scenario, records, stats, cacheRatio, tier)`（新增最后一个参数）。
  - `renderReport` 的 `meta` 新增 `tiers: Record<string, 'standard' | 'long'>`。

- [ ] **Step 1: 写失败的测试**

```ts
test('fact visibility counts opportunities, hits and misses; zero opportunities → n/a in report', () => { /* … */ });
test('growth buckets every 25 steps with rounded averages; empty buckets omitted', () => {
  expect(computeMetrics('A', 's', recsAtSteps([0, 10, 30, 80]), zero, 0.1, 'long').growth)
    .toEqual([{ fromStep: 0, avgInput: … }, { fromStep: 25, avgInput: … }, { fromStep: 75, avgInput: … }]);
});
test('report has separate summary tables for standard and long scenarios', () => {
  const md = renderReport(mixedTiers(), meta);
  expect(md).toMatch(/## Summary \(standard scenarios\)/); expect(md).toMatch(/## Summary \(long scenarios\)/);
});
test('scenario tables include a "Facts visible %" column (one decimal or n/a)', () => { /* … */ });
test('long scenarios get a growth table (rows A–F, columns per 25-step bucket)', () => { /* … */ });
test('report has a per-fact visibility table per scenario', () => { /* … */ });
test('report caveats state the visibility rule and the E summary assumption', () => { /* … */ });
test('renderReport is byte-identical for identical input and never prints NaN or Infinity', () => { /* … */ });
```

- [ ] **Step 2: 运行确认失败** → FAIL
- [ ] **Step 3: 实现**：可见率 = hits / opportunities × 100，`toFixed(1)`；汇总表合计机会与命中后再算比例。只有一种 tier 的运行只输出那一张汇总表。新增 caveat 两行："Fact visibility is literal text matching of a marker: a group that paraphrases a fact counts as missing it." 与 "Group E's compaction summary is assumed to keep every marker seen before compacting (favourable to E)."
- [ ] **Step 4: 运行确认通过** → PASS
- [ ] **Step 5: Commit** `feat(bench): fact visibility, growth table and per-tier summaries in the report`

---

### Task 5: 给三个标准剧本标注事实

**Files:**
- Modify: `packages/bench/scenarios/product-plan.json`、`flappy-bird.json`、`event-plan.json`
- Test: `packages/bench/test/scenarios.test.ts`

- [ ] **Step 1: 写失败的测试**：三个标准剧本各 4–6 条事实，`checkCoverage` 为空；每条事实至少在一个组的运行中有机会（`factOpportunities > 0`）。
- [ ] **Step 2: 运行确认失败** → FAIL
- [ ] **Step 3: 标注**：从现有剧本文本中选事实，必要时在引入步骤的文本里加入一个独特 marker（如 `CONV-SNAKE-CASE`、`CHANGE-BUDGET-40K`）；四类各至少一条；audience 写真正需要它的 Bot。只加 marker，不改剧情，不改步骤数。
- [ ] **Step 4: 运行确认通过** `pnpm -C packages/bench test`；C 组核心错误仍为 0、项目收尾。
- [ ] **Step 5: Commit** `feat(bench): annotate key facts in the standard scenarios`

---

### Task 6: 长剧本生成器与 long-app

**Files:**
- Create: `packages/bench/src/gen/long.ts`（生成器的共用部分：文本模板、确定性的轮转选择器、步骤构造器）、`packages/bench/src/gen/long-app.ts`、`packages/bench/src/gen/write.ts`（把生成结果写成 2 空格缩进、结尾换行的 JSON）
- Create: `packages/bench/scenarios/long-app.json`（生成结果，提交）
- Modify: `packages/bench/package.json`（脚本 `"gen:scenarios": "tsc -p tsconfig.build.json && node dist/gen/write.js"`）
- Test: `packages/bench/test/long-scenarios.test.ts`

**Interfaces:**
- Produces: `generateLongApp(): Scenario`；`writeScenario(s: Scenario, path: string): void`；`scenarioJson(s: Scenario): string`。

- [ ] **Step 1: 写失败的测试**

```ts
test('long-app regenerates byte-identically to the committed file', () => {
  expect(scenarioJson(generateLongApp())).toBe(readFileSync('scenarios/long-app.json', 'utf8'));
});
test('long-app loads, is tier long with 150–300 steps and full coverage', () => { /* loadScenario + checkCoverage */ });
test('long-app: 8 bots and about 10 workstreams in the initial plan', () => { /* employees.length === 8; plan.workstreams.length 9–11 */ });
test('long-app deliverables are 300–3000 chars and later versions are longer', () => { /* 同一工作块按出现顺序的 submitDeliverable 长度递增 */ });
test('long-app runs through all six groups; C has 0 core errors and finishes', async () => { /* 超时 60s */ }, 60_000);
```

- [ ] **Step 2: 运行确认失败** → FAIL
- [ ] **Step 3: 实现生成器**：剧情为一个应用从需求到上线（需求、设计、后端、前端、移动端、数据、测试、安全、运维、文档等工作块，按阶段推进）；在固定的步骤位置安排改需求、重新拆分、审查打回、约定、Bot 互问、失败记录；所有文本用模板加工作块名、版本号拼出，读起来像真实工作文本，不用无意义填充；事实 ≥ 15 条，四类齐全，marker 由生成器放进引入步骤的文本。
- [ ] **Step 4: 生成并运行** `pnpm -C packages/bench gen:scenarios && pnpm -C packages/bench test && pnpm -C packages/bench typecheck` → PASS
- [ ] **Step 5: Commit** `feat(bench): deterministic long scenario generator and long-app`

---

### Task 7: long-event、CLI 与 README

**Files:**
- Create: `packages/bench/src/gen/long-event.ts`、`packages/bench/scenarios/long-event.json`
- Modify: `packages/bench/src/gen/write.ts`（也写 long-event）、`packages/bench/src/cli.ts`（`SCENARIO_IDS` 加入 `long-app`、`long-event`；新增 `--scenario standard` 与 `--scenario long` 两个别名，`all` 跑全部五个）、`packages/bench/README.md`
- Test: `packages/bench/test/long-scenarios.test.ts`、`packages/bench/test/cli.test.ts`

**Interfaces:**
- Consumes: `long.ts` 共用部分（Task 6）。
- Produces: `generateLongEvent(): Scenario`。

- [ ] **Step 1: 写失败的测试**：long-event 与 Task 6 同样的五条测试（6 个 Bot、7–9 个工作块）；CLI：`--scenario long` 只跑两个长剧本，`--scenario standard` 只跑三个标准剧本，报告分别只有对应的一张汇总表；`--scenario all` 有两张汇总表。
- [ ] **Step 2: 运行确认失败** → FAIL
- [ ] **Step 3: 实现**：剧情为一次大型活动筹备（场地、议程、讲者、赞助、报名、宣传、后勤、直播等），与 long-app 的步骤安排不同（改需求的时机、打回的工作块不同）；README 加：长剧本说明、`gen:scenarios`、可见率指标的含义与局限、标准与长剧本分开汇总；不写结果数字。
- [ ] **Step 4: 运行确认通过**：
  `pnpm -C packages/core test && pnpm -C packages/bench test && pnpm -C packages/bench typecheck`，再运行
  `time pnpm -C packages/bench bench run --scenario all --group all --out /tmp/bench-long --stamp T` 两次（第二次 `--out /tmp/bench-long2`），`cmp` 两份 `report.md` 与 `results.json` 相同，总耗时 ≤ 120 秒。
- [ ] **Step 5: Commit** `feat(bench): long-event scenario, CLI scenario sets and README`
