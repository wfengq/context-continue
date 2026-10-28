# 查重：现有产品和项目是否已经在做"项目共享上下文 + Bot 私有上下文"

> 调研日期：2026-10-28
> 对照对象：`docs/superpowers/specs/2026-10-11-group-context-layer-design.md`（项目驱动的多 Bot 上下文层）
> 说明：资料来自网络搜索摘要与 GitHub 仓库检索（星标为 2026-10-28 实时数据），未逐一阅读源码；标注"待核实"的需要读代码确认。

---

## 1. 结论

1. **概念层面已经有人提出，而且是 Grok Bot 自己。** xAI 的设计文章写明：群聊为一个项目或团队提供共享上下文，同时每个 Bot 保留自己的专属记忆。也就是说，"项目共享 + Bot 私有"这个说法本身不是差异点。
2. **差异在实现方式。** 据目前查到的资料，Grok Bot 的"共享上下文"就是群聊记录本身，每次回复重读完整对话；没有结构化的项目板，没有按 Bot 裁出的投影，也没有手动压缩。你在使用中感到"不对"的，正是这一层。
3. **开源里最接近的是 Munder Difflin**（9.2k⭐，TypeScript）：共享黑板 + 每个 Agent 的私有记忆 + 只追加的事件日志 + 单一写入者 + 负责路由和裁决的总控 Agent。架构思路和我们的设计高度重合，**是重复造轮子风险最大的一个，必须先读它的源码**。
4. **DeepSeek Harness 是机会多于威胁。** 26.4 万⭐、MIT 开源，有实验性的 Agent Team 模式（负责人创建队友、共享代码目录、消息信箱），但没有结构化项目板。它有庞大的插件生态（`dsh-plugin`），更适合作为我们的**接入宿主**，而不是竞争对手。
5. **大厂里平台风险最大的是 OpenAI。** ChatGPT Space 已经把"共享页面和文件"做成人和 Agent 共用的上下文，多个 dot 组队也在测试中。

**目前没找到有人做的部分**（即我们的差异点）：
- 做成**与宿主无关的库或协议**，而不是一个独立应用；
- 从结构化的项目（工作块、接口约定、带 `affects` 的决定）**为每个 Bot 计算投影**，使上下文长度有上限；
- 由项目结构**驱动唤醒**，大部分情况不需要模型判断；
- 公开、可复现的**对比数据**：和全量广播、和单 Agent 比 token 与质量。

---

## 2. 大厂产品

| 产品 | 共享上下文 | 私有上下文 | 协调方式 | 和我们的关系 |
|---|---|---|---|---|
| **Grok Bot**（xAI） | 群聊（2–6 个 Bot）即共享上下文；Bot 之间共享同一台云电脑 | 每个 Bot 有自己的记忆和 Routines；Team Bot 有团队记忆 + 每人私有笔记 | Bot 自己决定谁回复；@ 交接；Bot 之间可异步发消息；交接只能传文字 | **概念相同，实现不同**。每次回复重读完整对话、无项目板、无投影、无手动压缩 |
| **Meta Muse** | 无多 Agent 共享功能；"共享 Agent"在 App 里隐藏、未发布；跨用户学习经脱敏后用于改进产品 | 每个 Agent 一台独立 VM | 单个个人 Agent | **不同**。目前是单 Agent 产品 |
| **ChatGPT Dots + Space**（OpenAI） | **Space**：页面和文件作为人、ChatGPT、Codex、dot 共用的上下文，可多人实时编辑，可设定页面的常驻指令 | 每个 dot 有自己的记忆 | 目前每人只有一个 dot；多 dot 团队在测试中 | **部分重合，平台风险最大**。Space 是"文档式"的共享层，不是结构化的工作块和接口约定 |
| **DeepSeek Harness**（开源，2026-08） | Agent Team 模式（实验性）：共享同一个代码目录、持久化的消息信箱 | 每个队友有自己的会话；创建时可选全新开始，或复制一份负责人的历史 | 负责人 Agent 通过 `spawn_teammate` 创建命名的持久队友 | **部分重合，更适合当宿主**。没有结构化项目板；插件生态很大 |
| **Anthropic** | Claude Tag 把 Slack 频道当作共享工作区；Opus 4.6 的 Agent Teams 由一个管理 Agent 统筹 | —（未查到细节） | 管理 Agent 编排 | 未深入核实 |

---

## 3. 开源项目

| 项目 | ⭐ | 做法 | 重合度 |
|---|---|---|---|
| [HarnessMD/munder-difflin](https://github.com/HarnessMD/munder-difflin) | 9,153 | 桌面应用，编排 Claude Code / Codex 等 CLI。"hive"：Markdown 记忆、每个 Agent 的记忆文件、原子文件信箱、所有 Agent 可读写的共享黑板、只追加的事件日志；单一提交者；总控 Agent "Michael" 负责路由和日常裁决，只把花钱、破坏性操作交给人；每个 Agent 有 token 预算 | **高**。待核实：黑板是否结构化、是否按 Agent 裁剪后注入 |
| [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | 264,464 | 见上表 | 中 |
| [yuzhenmao/DeLM](https://github.com/yuzhenmao/DeLM)（斯坦福论文 arXiv 2606.10662） | 192 | 去中心化：Agent 自行认领子任务，读取共享的"已验证上下文"，写回精简的已验证更新。SWE-bench Verified 上比最强基线高最多 10.5 个百分点，单任务成本约降一半 | 中。思路相近但**没有负责人**；可作为论据和对照 |
| Tale（MIT） | — | 人和 Agent 共用任务板；管理 Agent 分派任务；每个 Agent 独立沙箱 | 中 |
| MetaGPT / ChatDev | — | 产品经理、项目经理等角色拆分任务；消息池 + 订阅 | 中。框架，一次性任务，不是常驻群组 |
| [markus-global/markus](https://github.com/markus-global/markus) | 209 | TypeScript，Agent 团队：角色、任务委派、持久记忆、Agent 间通信 | 待核实 |
| [zeenie-ai/OpenCompany](https://github.com/zeenie-ai/OpenCompany) | 1,045 | 会自我改进的 AI 员工 | 低（待核实） |
| [h4dex/opc-nexus](https://github.com/h4dex/opc-nexus) | 235 | 中文"数字员工工作台"，含任务编排、专家团协作 | 待核实 |
| [Anil-matcha/open-duet](https://github.com/Anil-matcha/open-duet) | 6,280 | 命名的 AI 同事，各自有记忆、Routines、独立电脑 | 低。偏单 Agent |
| Letta / CrewAI | — | 共享记忆块、作用域，是记忆原语 | 低。可以拿来当底层组件 |

---

## 4. 建议

1. **实施计划之前，先读三个项目的源码**（约 1–2 天）：
   - Munder Difflin：黑板存什么、是否按 Agent 投影、是否控制 token；
   - DeepSeek Harness 的 Agent Team：队友拿到什么上下文、插件能否替换上下文组装；
   - DeLM：已验证上下文的格式和写回规则。
   读完再决定"自己做"还是"给它们做插件"。
2. **把 DeepSeek Harness 加入第一批适配目标**，与 OpenClaw 并列甚至优先：生态大、开源、Agent Team 正好缺结构化项目板。
3. **对外定位**：不说"共享 + 私有上下文"（Grok Bot 已经这么说了），而说"**按项目结构为每个 Bot 计算有上限的上下文，并给出对比数据**"。
4. **在设计文档中增加"相关工作与差异"一节**，写明与上述项目的区别。

---

## 来源

- [ZenML – X AI: Designing Persistent, Multi-Agent Workflows for Grok Bot](https://www.zenml.io/llmops-database/designing-persistent-multi-agent-workflows-for-grok-bot) · [xAI – Designing Grok Bot](https://x.ai/news/designing-grok-bot) · [Superpower Daily](https://superpowerdaily.com/posts/xai-explains-how-grok-bot-is-built-to-keep-agents-working-between-chats) · [Learn Cursor – Grok Bot Group Chats](https://www.learncursor.dev/learn/cursor-agents/grok-bot-group-chats-voice) · [Cursor – Work with Grok Bot](https://cursor.com/docs/grok-bot/work) · [Composio – Grok Bot guide](https://composio.dev/content/guide-to-frok-bot) · [Ando – Running multiple Grok Bots](https://www.ando.so/blog/running-multiple-grok-bots-across-a-team) · [MemoryLake – per-bot memory](https://www.memorylake.ai/en/blogs/grok-bot-per-bot-memory)
- [TestingCatalog – Shared Agents for Muse](https://www.testingcatalog.com/meta-to-announce-shared-agents-for-muse-at-meta-connect/) · [Stark Insider – Meta Muse](https://www.starkinsider.com/2026/09/meta-muse-multi-agent-household-trust.html) · [TIME – Meta Muse privacy](https://time.com/article/2026/10/06/meta-muse-ai-agent-privacy/)
- [OpenAI – Introducing dots](https://openai.com/index/introducing-dots/) · [VentureBeat – Dots and ChatGPT Space](https://venturebeat.com/technology/openai-launches-dots-always-on-ai-agent-coworkers-and-chatgpt-space-where-they-can-collaborate-with-human-teams) · [Android Authority – ChatGPT Space](https://www.androidauthority.com/chatgpt-space-shared-ai-workspace-3717305/) · [ChatGPT Space](https://chatgpt.com/features/space/) · [OpenAI 社区 – Multiple specialized dots with shared context](https://community.openai.com/t/multiple-specialized-dots-with-shared-context-and-clear-task-ownership/1402778)
- [Pandaily – DeepSeek Harness hands-on](https://pandaily.com/deepseek-harness-hands-on-four-modes-model-plus-harness-equals-agent-aug2026) · [Tenten – DeepSeek Harness agent teams](https://developer.tenten.co/deepseek-harness-workflow-agent-teams) · [briefs.co – DeepSeek agent unit](https://www.briefs.co/news/deepseek-forms-an-agent-unit-to-rival-claude-s-turf/) · [libraries.io – dsh-agent-team](https://libraries.io/npm/@limuyang2%2Fdsh-agent-team)
- [creati.ai – Claude Opus 4.6 agent teams](https://creati.ai/ai-news/2026-02-06/anthropic-claude-opus-4-6-multi-agent-teams) · [AI Agent Store – Claude Tag](https://aiagentstore.ai/ai-agent-news/topic/human-ai-synergy/2026-06-30)
- [Munder Difflin – everydev](https://www.everydev.ai/tools/munder-difflin/llms.txt) · [The Menon Lab – Munder Difflin](https://themenonlab.blog/blog/munder-difflin-office-of-coding-agents) · [Munder Difflin Blog – Agent office apps](https://munderdiffl.in/blog/ai-agent-office-github/)
- [DeLM (arXiv 2606.10662)](https://arxiv.org/pdf/2606.10662) · [Stanford Scaling Intelligence – DeLM](https://scalingintelligence.stanford.edu/pubs/delm/)
- [jimmysong landscape – Tale](https://landscape.jimmysong.io/projects/tale/) · [GitHub topic: ai-employees](https://github.com/topics/ai-employees)
