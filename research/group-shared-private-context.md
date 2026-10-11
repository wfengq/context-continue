# 多 Bot 群组：“群组共享上下文 + Bot 私有上下文”方案调研与评估

> 调研日期：2026-10-11
> 问题：Grok Bot 这类多 Bot 群组太费 token。设想：群组维护一份共同上下文，群里每个 Bot 再各自维护私有上下文。这个思路靠不靠谱？
> 说明：资料来自网络搜索摘要（本环境无法打开网页原文）。论文数据大多是作者自报，没有独立复现。

---

## 1. 结论先行

**方向是对的，学界和框架层面也已经验证过；但只把上下文“拆成共享和私有”本身省不了多少 token。** 省钱的关键在另外三件事：

1. **共享上下文装的是什么**：应该是一份压缩后的、结构化的“群组状态”（目标、决定、任务板、已确认事实），而不是原始聊天记录。原始记录照样全塞进去，拆不拆都一样贵。
2. **每条消息唤醒谁**：只唤醒被 @ 的、被分配任务的、订阅了相关话题的 Bot，而不是全员每条都读一遍。
3. **前缀缓存能不能命中**：共享部分放在 prompt 最前面、保持字节级不变，重复读取的成本可以降到约 1/10。

另外，这个方案最站得住的理由**未必是省钱，而是质量**：Bot 不被无关对话干扰、角色不漂移、上下文窗口不会过早塞满。

---

## 2. Grok Bot 群组为什么费 token（已知事实）

- 群组可容纳 2–6 个 Bot，Bot 之间可以互发消息、在线程里共享上下文；每个 Bot 的对话和记忆相互独立。
- Cursor 官方人员在论坛上解释：**每次回复都会重读该 Bot 的完整对话**，所以每条用量记录约等于整段对话的大小（大部分是缓存 token）。只有快到模型上限时才自动摘要，**目前没有手动压缩**。他们给的变通办法是：让 Bot 写一份交接摘要，然后复制出一个新 Bot。
- 同一帖子里，有用户报告一次提示在后台计了 249K+ token。另有一条用户说法：空的多 Bot 群组里，一句短提示首轮就注入了约 149K token，原因是系统把群里所有 Bot 的身份和 skills 都注入进去。这条只有单一用户来源，**未经证实**。
- 用户在提功能请求：同一 Bot 开新会话、归档旧线程、可见的 token 计量表。官方暂无时间表。
- 每周 token 额度没有公开，超出部分按模型原价计费，没有消费上限。

**你的直觉对得上**：成本来自（a）每次回复重读全量历史；（b）可能注入了全体 Bot 的身份和技能；（c）缺少压缩和分层。

---

## 3. 同类思路的先例（你的想法不是孤例）

| 来源 | 做法 | 和你想法的关系 |
|---|---|---|
| **MetaGPT**（ICLR 2024） | 全局消息池 + **订阅机制**：每个 Agent 按角色只订阅相关消息。论文明确指出“所有信息发给所有人”会造成信息过载 | 共享层 + 按需读取 |
| **Letta** shared memory blocks | 同一个记忆块挂到多个 Agent 上，实时同步；块可以设为只读、读写或某个 Agent 私有。协调靠共享块，而不是互发消息 | 几乎就是“共享 + 私有”的工程实现 |
| **CrewAI Memory** | 默认整个 crew 共享记忆，可以给单个 Agent 一个 scoped view 存私有上下文；scope 是类似文件系统的层级路径（`/project/alpha`、`/agent/researcher/findings`），检索只在对应分支里做 | 分层作用域 |
| **Collaborative Memory**（ICML 2025） | 两层记忆：私有 + 共享，读写策略按时间变化的二部图权限控制，每条记忆带来源元数据 | 共享/私有 + 权限 |
| **AIM**（arXiv 2609.12320） | 把信息分成私有和公开，私有记忆只有所有者能检索 | 隐私边界 |
| **Intrinsic Memory Agents**（arXiv 2508.08997） | 每个 Agent 维护自己的结构化记忆，保持角色视角。PDDL 基准上提升 38.6%，**token 效率最高** | 私有上下文提升质量和效率 |
| **LbMAS 黑板系统**（arXiv 2507.01701） | 共享黑板 + 控制单元；去掉控制单元后 token 从约 5.07M 涨到 18.8M | “谁来读/写”的调度才是省钱关键 |
| **Token Coherence**（arXiv 2603.15183） | 借鉴 CPU 缓存一致性协议 MESI：共享文档只在被修改时才让各 Agent 的副本失效，而不是每步全量重发。仿真结果省 84–95% token | 共享状态的同步策略 |
| **Anthropic 多 Agent 研究系统** | 子 Agent 各自独立上下文窗口，结果压缩后交给主 Agent。多 Agent 约耗 15 倍于普通聊天的 token，但效果显著提升 | 私有上下文 + 只回传结论 |

反面数据：
- AutoGen 默认群聊把每条消息广播给所有人，每个发言者的输入随记录增长。有人实测 3 个 Agent、30 轮约 139.5K token，改成只保留最近 5 条消息后约 42K。
- 另一篇黑板论文（arXiv 2510.01285）的单题成本反而是 RAG 的 2.3 倍——**黑板本身不保证省钱，要配合调度和压缩**。

---

## 4. 评估：优点、盲点、风险

### 优点
- **省 token 有依据**：限制历史、按订阅读取、只在变更时同步，多篇资料报告了明显下降（3–4 倍到 80% 以上不等，场景不同，不能直接比）。
- **质量更好**：减少无关信息干扰，角色更稳定（Intrinsic Memory、MetaGPT 都提到信息过载问题）。
- **可解释、可控**：共享状态是一份可以查看、可以编辑的“群组白板”，用户能直接纠正。

### 盲点（需要补上，否则效果有限）
1. **共享层必须是压缩后的“状态”，不是“日志”**。原始记录应该存档、按需检索，默认不加载。
2. **唤醒策略比分层更重要**。如果每条消息仍然唤醒所有 Bot，省下的很有限。
3. **要算上缓存**。Grok Bot 的用量里“大部分是缓存 token”，按 Anthropic 的价格缓存读取只要原价 10%，所以朴素广播的**账单**可能没看上去那么夸张；但**上下文窗口被塞满、注意力被稀释**的问题，缓存解决不了。这反而是你这个方案更强的论据。
4. **系统提示里不要注入全体 Bot 的完整资料**。只放一份简短的成员名录（名字 + 一句职责），需要时再查。

### 风险
- **一致性**：多个 Bot 同时写共享状态会冲突，需要单一写入者或带版本号的写入（Token Coherence 用的就是单写者 + 版本递增）。
- **摘要丢信息**：压缩会丢细节，所以必须保留原始日志可以回查。
- **错误扩散**：一个 Bot 写进共享层的错误或被注入的内容会传染给全组。2026 年的综述（arXiv 2606.30306）把撤销和传播控制列为尚未解决的问题。
- **隐私边界要真实存在**：Grok Bot 的 Bot 共享同一台电脑、Cookie 和凭据，私有上下文在那里只是逻辑隔离。

---

## 5. 推荐架构：三层上下文 + 选择性唤醒

```
┌────────────────────────── 群组 ──────────────────────────┐
│ L0 群组日志（Ledger）  append-only 原始消息，默认不加载，     │
│                        提供 search/read 工具按需回查        │
│ L1 群组状态（Board）   结构化、有版本：目标 / 已做决定 /      │
│                        任务板（负责人、状态）/ 已确认事实 /   │
│                        待决问题 / 成员名录（一行一个）       │
│                        → 固定放在 prompt 最前面，吃缓存       │
└──────────────────────────────────────────────────────────┘
        │ 订阅 / @ / 任务分配 触发唤醒
        ▼
┌──────── Bot A 私有 ────────┐  ┌──────── Bot B 私有 ────────┐
│ 角色与偏好（稳定）          │  │ ...                        │
│ 自己的工作笔记 / 中间结果    │  │                            │
│ 自己的工具调用输出（不外泄） │  │                            │
│ 与本 Bot 相关的近期消息窗口  │  │                            │
└────────────────────────────┘  └────────────────────────────┘
```

**每次唤醒时的 prompt 组装顺序**（为了缓存命中）：
1. 系统提示（全组相同）
2. L1 群组状态（全组相同，版本不变时字节完全一致）
3. Bot 自己的角色（每个 Bot 固定）
4. Bot 的私有笔记 + 与它相关的最近 N 条消息
5. 本次触发消息

**规则**：
- **唤醒**：只有被 @、被分配任务、或命中订阅话题时才唤醒；不确定时由一个便宜的路由模型判断（并且路由模型也只读最近几条，参考 AG2 的做法）。
- **发布**：Bot 的工具输出、长推理留在私有层，只把**结论 / 决定 / 交付物链接**写进群组。
- **写 L1**：由一个“书记员”角色（或规则）统一合并，带版本号；Bot 提交变更请求，不直接覆盖。
- **压缩**：L0 超过阈值时自动生成摘要更新 L1；提供手动“压缩/交接”按钮（这正是 Grok Bot 用户在要的功能）。
- **回查**：Bot 觉得信息不够时，用工具检索 L0，而不是默认全量加载。

**粗略估算（示意，不是实测）**：4 个 Bot、50 条消息、每条约 500 token。
- 朴素广播：每条消息唤醒 4 个 Bot，各读全量历史 ≈ 4 × 500 × (1+2+…+50) ≈ **2.55M** 输入 token。
- 三层 + 选择性唤醒：每次唤醒约 10K（L1 3K + 近期窗口 2K + 私有 5K），平均每条唤醒 1.5 个 Bot ≈ 50 × 1.5 × 10K ≈ **0.75M**，约降 70%；而且单次上下文长度恒定，不随群聊变长而增长。
- 两边都能吃缓存，实际账单差距会比这个小；但“上下文长度随群聊增长 vs 保持恒定”的差别不会被缓存抹平。

---

## 6. 建议的验证步骤

1. **先测量**：用同一组任务，对比“全量广播”和“三层 + 选择性唤醒”，记录输入 token、缓存命中率、任务成功率、单次上下文长度。
2. **优先做唤醒策略和 L1 状态板**——这两项贡献最大、实现最简单。
3. **质量回归**：重点看摘要丢信息导致的错误；保留 L0 回查工具作为兜底。
4. **复用现有组件**：Letta 的共享块 / CrewAI 的作用域都可以直接拿来做原型，不必从零写记忆系统。

---

## 来源

- [Cursor 论坛 – Grok Bot context window size and token accumulation logic in Pro+](https://forum.cursor.com/t/grok-bot-context-window-size-and-token-accumulation-logic-in-pro/171540)
- [Cursor 论坛 – Grok Bot: prune/compact an agent's context](https://forum.cursor.com/t/grok-bot-prune-compact-an-agent-s-context-without-creating-a-new-bot/168333)
- [xAI – Introducing Grok Bot](https://x.ai/news/introducing-grok-bot) · [xAI Docs – Grok Bot](https://docs.x.ai/grok-bot/overview) · [tokenminning – Bots and context](https://tokenminning.ai/ides/grok-bot/bots) · [continuumcode – Grok Bot limits](https://continuumcode.ai/guides/grok-bot-limits/) · [4Geeks – Team Bots](https://4geeks.com/en/blog/ai-tools/grok-bot-team-bots) · [Composio – Grok Bot guide](https://composio.dev/content/guide-to-frok-bot)
- [MetaGPT (arXiv 2308.00352)](https://arxiv.org/pdf/2308.00352)
- [Letta – Shared memory blocks](https://docs.letta.com/guides/agents/shared-memory-blocks) · [Letta – Multi-agent shared memory](https://docs.letta.com/guides/agents/multi-agent-shared-memory)
- [CrewAI – Memory](https://docs.crewai.com/v1.15.19/en/concepts/memory)
- [Collaborative Memory (arXiv 2505.18279)](https://arxiv.org/html/2505.18279v1) · [AIM (arXiv 2609.12320)](https://arxiv.org/html/2609.12320) · [Always-On Agents survey (arXiv 2606.30306)](https://arxiv.org/pdf/2606.30306)
- [Intrinsic Memory Agents (arXiv 2508.08997)](https://arxiv.org/html/2508.08997v2)
- [LbMAS 黑板系统 (arXiv 2507.01701)](https://arxiv.org/pdf/2507.01701) · [Blackboard for data discovery (arXiv 2510.01285)](https://arxiv.org/html/2510.01285v1)
- [Token Coherence (arXiv 2603.15183)](https://arxiv.org/html/2603.15183v1)
- [Anthropic – How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
- [dev.to – AutoGen's hidden token tax](https://dev.to/wartzarbee/autogens-hidden-token-tax-why-a-3-agent-chat-costs-15x-what-you-expect-21o5) · [AG2 – speaker selection transform messages](https://docs.ag2.ai/docs/topics/groupchat/transform_messages_speaker_selection) · [Microsoft ISE – Multi-agent systems at scale](https://devblogs.microsoft.com/ise/multi-agent-systems-at-scale/) · [Fast.io – Agents SDK vs AutoGen](https://fast.io/resources/openai-agents-sdk-vs-autogen-agent-rooms.md)
- [Agent Capsules (arXiv 2605.00410)](https://arxiv.org/pdf/2605.00410) · [Mistral – Prompt caching](https://docs.mistral.ai/studio/conversations/advanced/prompt-caching) · [PromptLayer – Prompt caching discount](https://www.promptlayer.com/glossary/prompt-caching-discount)
- [MindStudio – Shared vs private agent memory](https://www.mindstudio.ai/blog/shared-vs-private-ai-agent-memory-team-access-control)
