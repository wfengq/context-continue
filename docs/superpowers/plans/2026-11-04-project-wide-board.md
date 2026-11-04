# 项目级信息上公共项目板 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在核心库公共项目板上增加三个可开关的项目级小节（指示、契约、失败记录），评测在五种开关设置下运行 C 组并给出费用与可见率对照。

**Architecture:** 核心库：`render.ts` 的公共项目板渲染接受一个"视图"参数（开关 + 指示条目），`brief.ts`、`contexts.ts` 使用同一视图渲染第 4 段；指示条目从账本读取最近的人类聊天；开启时投影、审查正文与增量去掉重复内容。项目板大小限制、路由输入仍用不含新小节的基础渲染，归档行为不变。评测：命令行 `--c-public`，C 组把开关传给 `createProject`，报告记录设置。

**Tech Stack:** TypeScript 6.0.3、vitest 5.0.4、Node ≥ 22.5、pnpm workspace（不新增依赖）。

**Spec:** `docs/superpowers/specs/2026-11-04-project-wide-board.md`

## Global Constraints

- 不新增依赖；公开 API 只做向后兼容扩展。
- 三个开关缺省全部关闭；关闭时核心库所有输出（简报、上下文、项目板文字、工作区状态）与改动前逐字节相同——现有测试不得因默认行为改变而修改。
- 新选项：`createProject` 配置新增 `publicBoard?: { directives?: boolean; contracts?: boolean; failures?: boolean }`（与数值型 `options` 分开，非布尔值抛 `INVALID_OP`）；数值选项新增 `directivesKeep`，默认 `20`。
- 公共项目板各节顺序：Goal、Constraints、Directives、Conventions、Contracts、Failures、Workstreams；未开启的节不出现。
- 审查、规划上下文与同一时刻的简报第 1–4 段仍逐字节相同（含新小节）。
- 叫醒规则不变；"已看过"规则只作用于投影。
- 项目板大小限制（`enforceBoardSize`/归档）与路由输入使用不含新小节的基础渲染。
- 评测规则不变（R-B19 等），不改剧本、标注与其他组；输出确定，两次运行逐字节相同。
- 每个提交以如下两行结尾：
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01G3xVb5Sz1dDSz3ha6M4UYJ`
- 不要 `git add` `.superpowers` 或 `results/`。

## Review Focus

1. **指示超过 `directivesKeep` 条**：只显示最近 N 条，前面一行 `(K earlier directives omitted)`；K 准确。→ Task 1 测试。
2. **开启指示后人类消息不在任何 Bot 的增量里，但仍按原规则叫醒**（含被 @ 的 Bot）。→ Task 1 测试。
3. **开启契约/失败后投影与审查正文不重复，但关闭时与原来逐字节相同**。→ Task 2 测试。
4. **项目板渲染变长后不触发额外归档**：开关不影响 `enforceBoardSize` 的结果。→ Task 2 测试。
5. **`--c-public` 非法值**（未知名称、重复、空）：用法错误退出码 2；`none` 与 `all` 之外的子集按名称排序写入报告参数。→ Task 3 测试。

---

### Task 1: 指示小节（directives）

**Files:**
- Modify: `packages/core/src/project.ts`（配置 `publicBoard` 校验与传递）、`packages/core/src/options.ts`（`directivesKeep`）、`packages/core/src/render.ts`（`renderBoardPublic` 接受视图参数）、`packages/core/src/brief.ts`（第 4 段用视图渲染；开启时增量去掉人类聊天）、`packages/core/src/contexts.ts`（第 4 段用同一视图）
- Modify: `packages/core/README.md`、设计文档 `docs/superpowers/specs/2026-10-11-group-context-layer-design.md`（第 5.2、6.1 节）
- Test: `packages/core/test/brief.test.ts`、`packages/core/test/lifecycle.test.ts`、`packages/core/test/options.test.ts`

**Interfaces:**
- Produces:
  - `type PublicBoardSwitches = { directives?: boolean; contracts?: boolean; failures?: boolean }`（从 `index.ts` 导出）；`createProject({ …, publicBoard?: PublicBoardSwitches })`。
  - `renderBoardPublic(board, workstreams, view?: { switches: Required<PublicBoardSwitches>; directives: LedgerEntry[]; directivesOmitted: number })`；`view` 缺省时输出与现在相同。
  - 指示行格式 `- [#<seq> <作者名>] <原文>`；作者名取 `entry.author.name ?? entry.author.id`（以实际类型为准，报告中说明）。
  - 一个内部辅助函数读取账本中最近 `directivesKeep` 条人类聊天并给出省略数，供 `brief.ts` 与 `contexts.ts` 共用。

- [ ] **Step 1: 写失败的测试**

```ts
test('directives off: board text and briefs are unchanged', async () => { /* 与关闭开关的项目逐字节比较 */ });
test('directives on: every human chat message appears on the board in order', async () => { /* 两条人类消息 → "## Directives" 下两行，含 #seq */ });
test('directives on: only the newest directivesKeep are shown with an omitted count', async () => { /* directivesKeep: 2，三条消息 → "(1 earlier directives omitted)" */ });
test('directives on: human chat is left out of every bot delta but still wakes the same bots', async () => { /* … */ });
test('directives on: review and planning contexts share the brief board segment byte for byte', async () => { /* … */ });
test('publicBoard rejects non-boolean switches', () => { /* INVALID_OP */ });
```

- [ ] **Step 2: 运行确认失败** `pnpm -C packages/core test` → FAIL
- [ ] **Step 3: 实现**；README 与设计文档同步。
- [ ] **Step 4: 运行确认通过** `pnpm -C packages/core test && pnpm -C packages/core typecheck && pnpm -C packages/bench test` → PASS（评测数字不应变化，因为开关缺省关闭）
- [ ] **Step 5: Commit** `feat(core): optional directives section on the public board`

---

### Task 2: 契约与失败记录小节

**Files:**
- Modify: `packages/core/src/render.ts`（Contracts、Failures 小节；投影与审查正文按开关去重）、`packages/core/src/brief.ts`、`packages/core/src/contexts.ts`
- Modify: `packages/core/README.md`、设计文档
- Test: `packages/core/test/brief.test.ts`、`packages/core/test/lifecycle.test.ts`、`packages/core/test/board.merge.test.ts`（或归档测试所在文件）

**Interfaces:**
- Produces: 契约行 `- [<id>@<version>] <from> → <to>: <spec>`；失败行复用现有失败字段布局；开启时投影的契约/失败节与审查正文的失败节不再出现（节标题也不出现）。

- [ ] **Step 1: 写失败的测试**

```ts
test('contracts on: every contract is on the board with its spec, and the projection no longer repeats it', async () => { /* … */ });
test('failures on: every failure is on the board, and projection and review body no longer repeat it', async () => { /* … */ });
test('contracts/failures off: projection and review text are unchanged', async () => { /* 逐字节 */ });
test('switches do not change board-size archiving', async () => { /* 同一组操作在开/关下归档结果相同 */ });
test('board items on the public board are never compacted as seen', async () => { /* … */ });
```

- [ ] **Step 2: 运行确认失败** → FAIL
- [ ] **Step 3: 实现**
- [ ] **Step 4: 运行确认通过** `pnpm -C packages/core test && pnpm -C packages/core typecheck && pnpm -C packages/bench test` → PASS
- [ ] **Step 5: Commit** `feat(core): optional contracts and failures sections on the public board`

---

### Task 3: 评测开关 `--c-public`

**Files:**
- Modify: `packages/bench/src/cli.ts`、`packages/bench/src/policies/index.ts`（把开关传给 C 组）、`packages/bench/src/policies/project.ts`（`createProject({ publicBoard })`）、`packages/bench/src/report.ts`（报告参数中列出 C 组设置）、`packages/bench/README.md`
- Test: `packages/bench/test/cli.test.ts`、`packages/bench/test/policy-project.test.ts`、`packages/bench/test/report.test.ts`

**Interfaces:**
- Produces: `--c-public none|all|<逗号分隔的 directives,contracts,failures 子集>`，缺省 `none`；`results.json` 新增顶层 `cPublic: string`（规范化：`none`、`all` 或按名称排序的子集），报告参数段打印同一字符串；其他组不受影响。

- [ ] **Step 1: 写失败的测试**：缺省等同 `none` 且输出与改动前相同；`all` 时 C 组简报含三个新小节；非法值（未知名、重复、空）退出码 2；`contracts,directives` 规范化为 `contracts,directives`；其他组的记录在任何设置下都相同。
- [ ] **Step 2: 运行确认失败** → FAIL
- [ ] **Step 3: 实现**
- [ ] **Step 4: 运行确认通过** `pnpm -C packages/bench test && pnpm -C packages/bench typecheck` → PASS
- [ ] **Step 5: Commit** `feat(bench): --c-public switches the core public-board sections for group C`

---

### Task 4: 五种设置对照与结果记录

**Files:**
- Modify: `docs/superpowers/specs/2026-11-04-project-wide-board.md`（第 6 节"结果"，状态改为"已实现"）、`packages/bench/README.md`（如何复现对照）

- [ ] **Step 1: 运行**：对 `none`、`directives`、`contracts`、`failures`、`all` 各运行一次 `pnpm -C packages/bench bench run --scenario all --group all --c-public <设置> --out <仓库外临时目录>/<设置> --stamp T`；`all` 再运行一次到另一目录并 `cmp` 确认逐字节相同；确认 A、B、D、E、F 在五种设置下的汇总完全相同；C 组每种设置核心错误 0、全部收尾。
- [ ] **Step 2: 写结果**：第 6 节给出一张表——每种设置的 C 组费用（标准、长）、可见率（标准、长）、按事实类别（change、conv、contract、fail）的可见率，以及与 D、E 的费用比较；写明哪些漏看仍然存在及原因；不写推荐默认值（由用户决定）。
- [ ] **Step 3: Commit** `docs: record the public-board switch comparison`
