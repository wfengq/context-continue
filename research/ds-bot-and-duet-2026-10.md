# 补充调研：DS Bot 与 Claude Duet

> 调研日期：2026-10-31
> 起因：用户指出之前的查重漏了"DSH Bot"和 Duet。两者都在之前的调研之后才发布或被报道。
> 方法：网络搜索 + 读 DS Bot 源码（`Fei2411/DS-Bot` 默认分支 `f823773`，只读，未运行）。

## Claude Duet（Anthropic）
- 约 2026-10-23 以研究预览发布，美国 Pro/Max 用户排队使用，iPhone、Android、claude.ai 可用，未公开 API。
- 主动型个人助理：每天早上发简报，检查邮件和日历、起草回复、跟进未完成的工作；沿用 Claude 账号的记忆、技能和连接器。
- 定位：单个个人 Agent，和 Muse、Dots 同类，不是多 Bot 群组。对本项目是参照，不是接入目标。

## DS Bot（社区项目，又名 "DeepSeek Bot"，非 DeepSeek 官方）
- DeepSeek Harness 的插件（包名 `ds-bot`），Apache-2.0；报道称约 4.3k⭐。群聊轮次和 @ 转发借鉴 OpenMausBot，记忆采用 AgentMemoryRepo 的 Markdown 格式。
- **群聊轮次**（`ds-bot/src/host/groups.js`）：群聊是一条有序对话，成员轮流发言；轮到谁，就给谁看"自上次看过以来"其他人的新消息（首次 12 条，之后最多 24 条）。
- **防刷屏**：用户上次发言后，Bot 互相调用的次数上限默认为成员数 × 3，到上限群聊暂停，等用户继续。
- **记忆**（`memory.js`）：Bot 私有、群组共享、团队共享三层；群里说的内容只进群组记忆；每轮回复后自动复查记忆；记忆部分在会话中冻结以保持缓存前缀稳定。
- **交接**（`handoffs.js`）：Bot 之间派活形成树，结果自动沿树往回传。
- **上下文管理**（`steward.js`）：对话达到模型窗口约 80% 时，小模型判断是"开新段"还是"就地压缩旧消息"。
- **没有**：结构化项目板（工作块、接口约定、带理由与被否决方案的决定、失败记录），按 Bot 的相关性投影，由项目结构驱动的唤醒。它以群聊为中心。

## 对本项目的影响
1. 差异点仍然成立（项目知识结构化 + 按 Bot 投影 + 结构驱动唤醒），但在 DeepSeek Harness 上再做一个多 Bot 群聊插件，会和 DS Bot 正面竞争。
2. 用户决定：**先做评测，再定接入方式**。评测应增加一组"DS Bot 式群聊"对照（轮流发言 + 增量消息 + 群组记忆 + 接近上限时压缩），用数据回答"项目板方案是否比现成的群聊方案更省、更好"。
3. 有数据之后再决定：给 DS Bot 做项目层插件或贡献代码，还是做独立插件。

## 来源
- [Fortune – Anthropic joins the personal AI assistant race with Claude Duet](https://fortune.com/2026/10/23/anthropic-joins-meta-and-openais-personal-ai-assistant-race-with-duet/) · [Introducing Claude Duet](https://claude.com/resources/articles/claude-duet) · [DataCamp – Claude Duet](https://www.datacamp.com/blog/claude-duet)
- [Pasquale Pillitteri – DS Bot arrives on DeepSeek Harness](https://pasqualepillitteri.it/en/news/27727/ds-bot-deepseek-harness-plugin-unofficial-bots) · [GitHub – Fei2411/DS-Bot](https://github.com/Fei2411/DS-Bot)
