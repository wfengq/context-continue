# 评测（bench）设计文档

- 日期：2026-10-31
- 状态：待审阅
- 包：`packages/bench`（`@context-continue/bench`），依赖 `@context-continue/core`
- 上游：`docs/superpowers/specs/2026-10-11-group-context-layer-design.md`（第 6.8 节），`research/ds-bot-and-duet-2026-10.md`

---

## 1. 目标

用可复现的数据回答：**项目板方案（C 组）是否比其他做法更省 token、上下文更稳定**。结果用于 README，以及之后决定如何接入 DeepSeek Harness / DS Bot。

已确认的决定：

| 决定 | 结论 |
|---|---|
| 模型 | 第一版用脚本化的假模型；真模型适配器只留接口，日后由用户在自己的机器上配 key 运行 |
| 方案 | 按请求模拟：同一份剧本驱动五组策略，假模型照剧本回复，只比较每次请求放了多少上下文、叫醒了多少次 |
| 对照组 | A 单 Agent、B 全量广播、C 本方案、D DeLM 式、E DS Bot 式（新增） |
| 第一版衡量 | 上下文规模与请求次数；任务质量与一致性冲突需要真模型，第一版不测并在报告中标明 |

## 2. 结构

```
packages/bench/
  src/
    scenario.ts      剧本格式（zod）与加载
    runner.ts        跑一个剧本 × 一组策略，产出调用记录
    model.ts         Model 接口；ScriptedModel
    policies/        single.ts、broadcast.ts、project.ts、delm.ts、dsbot.ts
    metrics.ts       从调用记录算指标
    report.ts        输出 results.json 与 report.md
    cli.ts           bench run --scenario <id|all> --group <A..E|all>
  scenarios/         product-plan.json、flappy-bird.json、event-plan.json
  test/
```

## 3. 剧本格式

```ts
interface Scenario {
  id: string; goal: string; constraints: string[];
  owner: string; lead: string;
  employees: { botId: string; persona: string; skills: string[] }[];
  plan: PlanInput;                 // 核心库的 PlanInput；A 组不使用
  idleReply?: string;              // 额外请求的固定回复，默认 "Noted."
  steps: Step[];
}

type Step =
  | { kind: 'human'; text: string; mentions?: string[] }
  | { kind: 'work'; botId: string; workstreamId: string; reply: string; ops?: ToolCall[] }
  | { kind: 'review'; deliverableOf: string; passed: boolean; notes: string; conventions?: string[] }
  | { kind: 'replan'; plan: PlanInput };

interface ToolCall { name: string; args: unknown }   // 名称与参数同核心库 6.2 的工具
```

- 加载时用 zod 校验；`work.botId` 必须是员工，`workstreamId` 必须在当前拆分中，`ToolCall.name` 必须是核心库工具名。
- 每个剧本 20–40 步，必须覆盖：人中途改需求、交付被打回、新增约定、一次重新拆分、Bot 之间互相询问。Flappy Bird 剧本必须包含一次"两个工作块风格冲突、检查时发现"。

## 4. 运行流程

`runner` 按顺序执行剧本步骤；当前策略决定这一步叫醒谁、每个被叫醒的 Bot 这次请求包含什么。每次请求记一条：

```ts
interface CallRecord {
  group: 'A' | 'B' | 'C' | 'D' | 'E'; scenario: string; step: number;
  botId: string; kind: 'scripted' | 'extra';
  inputTokens: number; cacheableTokens: number;   // cacheable ≤ input
  segments?: { kind: string; tokens: number; cacheable: boolean }[];
}
```

- **剧本请求**：每个 `work` 步骤，执行的 Bot 发一次请求；五组次数相同。
- **额外请求**：策略额外叫醒的 Bot 以 `idleReply` 作答，输入 token 照计。
- **合并规则**：被叫醒的 Bot 如果剧本中它的下一步就是它自己的 `work`，这次唤醒算作那一步的触发，不再另计请求。
- `review` 和 `replan` 由负责人执行，计为负责人的剧本请求（A 组由唯一的 Agent 执行）。
- 假模型 `ScriptedModel` 返回剧本中的 `reply` 和 `ops`；`ops` 的执行结果（成功或错误文字）作为下一次请求可见的工具结果。
- token 一律用 `defaultCountTokens` 计数；所有组使用同一段固定说明模板。

## 5. 五组策略

所有"对话历史只往后追加"的组，可缓存部分 = 该 Bot 上一次请求的全部内容（前缀不变）。

**A 单 Agent**：只有一个 Agent 依次完成所有 `work`、`review`、`replan`；每次请求带完整历史（所有人类消息、自己的回复、工具结果）。

**B 全量广播（Grok Bot 式）**：每个 Bot 的请求带整个群从头到尾的全部消息；人的消息未 @ 任何人时叫醒所有 Bot，@ 了只叫醒被 @ 的；每个 Bot 的对话历史只往后追加。

**C 本方案**：真实调用核心库。用剧本的员工、拆分建立项目（`start` → `proposePlan` → `approvePlan`），剧本步骤映射到门面方法和 `callTool`；叫醒谁完全由核心库决定；每次请求的内容即 `buildBrief` 的 7 段，不另存 Bot 对话历史；可缓存部分按核心库标记（第 1–3 段）。核心库的 `models.route/extract/condense` 不提供（使用退化行为），以免引入模型调用。

**D DeLM 式**：不设负责人。共享日志按读者给增量（已读条目只显示 id 与状态，交付物只给引用），不按相关性过滤；人的消息 @ 了只叫醒被 @ 的，未 @ 叫醒所有人；每个 Bot 对话历史只往后追加。

**E DS Bot 式群聊**（按 DS Bot `f823773` 源码近似复刻，报告中注明）：
- 被叫醒的成员看到自上次以来其他人的新消息：首次 12 条，之后最多 24 条；另带群组记忆（上限 8,000 字符，会话内冻结、可缓存）。
- 人的消息未 @ 时按名册顺序叫醒所有成员（负责人在前），@ 了只叫醒被 @ 的；Bot 回复中 @ 谁就叫醒谁。
- 自用户上次发言起，Bot 互相调用超过"成员数 × 3"次即暂停，直到下一条人类消息。
- 每个成员对话历史只往后追加；超过假定窗口（默认 128,000 token）的 80% 时，把旧历史换成 1,500 token 的摘要，该次请求的可缓存部分记为 0。
- 窗口、比例、摘要大小可通过命令行参数修改。

## 6. 指标

每个剧本 × 每组：
- 总输入 token；其中可缓存与不可缓存部分。
- 估算费用（单位：原价 token）：可缓存部分 × 0.1 + 其余 × 1；比例可配置。
- 请求次数：剧本请求、额外请求分列。
- 单次请求上下文长度：中位数、P90、最大值，以及按步骤的序列。
- E 组：压缩次数、因调用上限暂停的次数。
- 质量与一致性冲突：标注"需要真模型，未测"。

## 7. 报告

- `bench run` 输出 `results/<时间戳>/results.json`（全部 CallRecord 与指标）和 `report.md`。
- `report.md`：开头固定说明"结果来自脚本化假模型，只衡量上下文规模，不衡量任务质量"；每个剧本一张表（行 A–E，列为第 6 节指标），一张三剧本汇总表；每组相对 B 和相对 E 的节省百分比。
- 输出格式确定：同一剧本运行两次，`results.json` 与 `report.md` 逐字节相同（时间戳只出现在目录名中）。

## 8. 错误处理

- 剧本校验失败：列出所有错误后退出，不运行。
- C 组中核心库抛错（如工具参数不合法）：作为工具结果记录在该 Bot 下一次请求中，不中断运行；运行结束时在报告中列出出现的错误次数。若剧本导致项目无法收尾，报告标明。
- 其他组的策略错误视为 bug，直接失败。

## 9. 测试

- 每种策略：用 3 步的小剧本，手算期望的请求次数与 token 数，逐项断言。
- 合并规则、E 组压缩触发、E 组调用上限、A 组完整历史各有专门测试。
- 可复现：同一剧本运行两次输出逐字节相同。
- C 组：确认调用的是核心库，工具调用成功，项目可正常收尾。
- 三个正式剧本都能通过校验并跑完五组。
- 命令行冒烟测试：生成两个文件，表格包含五组。

## 10. 第一版不做

- 真模型适配器与质量打分（只留 `Model` 接口）。
- 录制回放。
- 图表。
