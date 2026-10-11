# Grok Bot 类产品调研（产品 + GitHub 开源生态）

> 调研日期：2026-10-11
> 方法：网络搜索（新闻、官方文档摘要、第三方评测）+ GitHub 仓库检索（星标数为 2026-10-11 GitHub API 实时数据）。
> 局限：本次环境无法直接打开网页原文，产品细节来自搜索摘要；**价格在多个来源间互相矛盾，下单前请以官网为准**。

---

## 0. 先澄清：“Grok bot” 指两种东西

| | **@grok（X 上的回复机器人）** | **Grok Bot（2026-08-11 发布的 Agent 产品）** |
|---|---|---|
| 形态 | 在 X 帖子下 @grok 提问，它在串里公开回复 | 常驻的 AI “同事”，有自己的云端电脑，登录你的工具，替你跑多步任务 |
| 典型用法 | “@grok is this true?” 事实核查、解释帖子 | 处理邮件、写草稿、定时调研、操作网页/文件 |
| 竞品 | @AskPerplexity、群聊里的 Meta AI 等 | ChatGPT Dots、Meta Muse、Gemini Spark、OpenClaw 等 |

本报告以 **Grok Bot（Agent 产品）** 为主，第 6 节单独覆盖 @grok 回复机器人赛道。

---

## 1. Grok Bot 产品拆解

- **发布**：2026-08-11，xAI（现以 SpaceXAI 名义发布）推出，仍标注 early beta。企业管控 9-03 上线，Team Bots 约 9-28 上线。
- **核心设计**：
  - **持久云电脑**：每个用户一台持久 Linux 云电脑，带浏览器、文件、登录态；你关电脑后任务继续跑。
  - **多 Bot、共享机器**：同一用户的所有 Bot **共享同一台电脑**——各自有独立“屏幕”可并行操作 GUI，但文件、Cookie、登录会话、CLI 凭据全部共享。官方 FAQ 明确：*不要把不同 Bot 当作安全边界*。每个 Bot 同一时刻只能跑一个 computer-use 任务。
  - **记忆**：每个 Bot 记住稳定偏好、角色上下文、过往工作摘要；不同 Bot 的对话和记忆相互隔离。
  - **Skills / Routines**：Skill = 可复用的任务指令（消息里用 `/` 调用）；Routine = 按时间或事件触发的工作流。官方建议路径：先手动跑通 → 存为 Skill → 最后再自动化。
  - **X 上触发**：在帖子或回复里 @bot，主 Bot 把该帖当成任务接走，@bot 公开回一句确认（需绑定 X 账号，部分地区未开放）。这是把“@grok 回复机器人”的入口嫁接到了 Agent 上。
  - **Connectors**：连接外部应用（邮件、CRM、账单等），以“你”的身份登录。
- **定价（存在矛盾）**：没有独立套餐，包含在 xAI 或 **Cursor** 的订阅里。最常见说法：SuperGrok $30/月起（另有 $100 Plus、$300 Heavy），Cursor Pro $20/月起；Bot 用量与普通 Grok 用量**单独计量**。Reddit 上也有 $120/席位、$200–300 档的说法，beta 期间文档与定价页曾不一致。
- **安全**：
  - 发送 / 购买 / 删除等“终态动作”需确认，但**读数据和中间步骤不需要确认** → 网页或文件里藏的 prompt injection 可以劫持 Bot。
  - 有 Auto-review、“Ask first” 规则、私网白名单、审计日志、集中管理；第三方指南称 Auto-review 不覆盖记忆写入和多数设置变更，且不支持 Legacy Privacy Mode（必须云存储）。
  - 底座模型风险：SplxAI 红队测试称 Grok 4 未加固时对 prompt injection 的服从率 >99%（经系统提示加固后显著改善）。

**一句话定位**：Grok Bot = “常驻云电脑 + 多个有记忆的 Bot + Skills/Routines + X 社交入口”，强项是入口和速度，弱项是 Bot 间无隔离、beta 定价混乱、安全口碑差。

---

## 2. 海外大厂竞品（托管型）

| 产品 | 发布 | 底座/算力 | 入口渠道 | 价格（报道） | 差异点 |
|---|---|---|---|---|---|
| **Grok Bot**（xAI） | 2026-08-11 | 每用户一台共享云电脑 | Grok App、X（@bot）、Cursor | SuperGrok $30 起；Cursor Pro $20 起 | X 社交入口；多 Bot 共享机器 |
| **ChatGPT Dots**（OpenAI） | 2026-09-29（DevDay） | GPT-6 Astra，每个 dot 有自己的云电脑+浏览器 | ChatGPT、Slack、Teams（短信计划中） | Pro $100/月 起；Business Premium $125/席；新增 $500 档 | 4000+ 应用连接；后台“主动调研”只读；计量规则未公开 |
| **Meta Muse** | 2026-09-08 | Muse Spark 模型，**每个 agent 一台独立 VM** | Muse App、Web、**WhatsApp** | 免费基础版；$20 / $100（据报道） | 订票、填表、购物、代为谈判；免费层；曾登顶美区免费榜；隐私担忧 |
| **Gemini Spark**（Google） | 2026-05-19（I/O） | Google Cloud 上 24/7 运行 | Gmail/Calendar/Docs 等 Google 全家桶 | 已下放到 AI Pro $20/月（美国）；Ultra 价格各报道不一 | Google 生态深度集成；EEA/英国/瑞士暂不提供 |
| **Claude Cowork**（Anthropic） | — | 本地选定文件/文件夹 | 桌面端 | Pro ~$20/月 | 偏本地文件工作，额度消耗快 |

**观察**：2026 年 5–9 月，四大厂在 4 个月内先后推出“常驻 + 自带电脑 + 连接器 + 审批”的同构产品，差异主要在**入口**（X / ChatGPT / WhatsApp / Google 全家桶）和**隔离模型**（共享机器 vs 每 agent 独立 VM）。

---

## 3. 国内对标

国内主流形态是“桌面 Agent + 定时任务 + Skills”，**云电脑常驻型**的直接对标在搜索中较少：

| 厂商 | 产品 | 时间 | 要点 |
|---|---|---|---|
| 字节 | 豆包专业版 | 2026-06-24 | 本地电脑操作、浏览器调用、Skills、定时任务 |
| 月之暗面 | Kimi Work（Beta） | 2026-06-03 | 挂载本地文件夹、WebBridge 浏览、跑 Python、定时任务 |
| 阿里 | 千问办公（整合 QoderWork、悟空、MuleRun） | 2026-07 | Agent 产品线整合 |
| 腾讯 | WorkBuddy | — | 某统计称桌面端月活约 1115 万，居首 |
| 其他 | 网易 LobsterAI、字节 TRAE Work、百度 DuMate | — | 未展开 |

开源侧，国内团队也很活跃：`zhayujie/CowAgent`（原 chatgpt-on-wechat，主打微信/多渠道）、`agentscope-ai/QwenPaw`（阿里 AgentScope）。

---

## 4. GitHub 开源生态

### 4.1 第一梯队：通用个人 Agent 底座（Grok Bot 的“开源原型”）

| 仓库 | ⭐ Stars | 语言 | 创建 | 说明 |
|---|---|---|---|---|
| [openclaw/openclaw](https://github.com/openclaw/openclaw) | **391,667** | TypeScript | 2025-11 | 现象级。自托管，接入 WhatsApp/Telegram/Slack/Discord/iMessage 等 20+ 渠道；作者 Peter Steinberger（PSPDFKit），2026-02 加入 OpenAI，项目转基金会治理 |
| [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) | **252,686** | Python | 2025-07 | “The agent that grows with you”，强调成长/记忆 |
| [zhayujie/CowAgent](https://github.com/zhayujie/CowAgent) | 47,342 | Python | 2022-08 | 多模型、多渠道（微信等），自进化记忆 |
| [agentscope-ai/QwenPaw](https://github.com/agentscope-ai/QwenPaw) | 35,592 | TypeScript | 2026-02 | 阿里 AgentScope 出品，多聊天应用接入 |
| [zeroclaw-labs/zeroclaw](https://github.com/zeroclaw-labs/zeroclaw) | 32,955 | Rust | 2026-02 | 轻量、可替换组件的 OpenClaw 式基础设施 |
| [nullclaw/nullclaw](https://github.com/nullclaw/nullclaw) | 8,110 | Zig | 2026-02 | 极小体积版本 |

OpenClaw 周边已经形成生态：[awesome-openclaw-skills](https://github.com/VoltAgent/awesome-openclaw-skills)（53k⭐，5400+ skills）、[awesome-openclaw-usecases](https://github.com/hesamsheikh/awesome-openclaw-usecases)（31.7k⭐）、官方技能注册表 [openclaw/clawhub](https://github.com/openclaw/clawhub)（9.5k⭐）、中文教程 [awesome-openclaw-tutorial](https://github.com/xianyu110/awesome-openclaw-tutorial)（4.6k⭐，含飞书接入）。

### 4.2 第二梯队：明确对标 Grok Bot / Dots / Muse 的开源替代品

| 仓库 | ⭐ Stars | 语言 | 创建 | 说明 |
|---|---|---|---|---|
| [feder-cr/invisible_dots](https://github.com/feder-cr/invisible_dots) | 31,947 | TypeScript | （老仓库改造） | 自托管 Dots/Grok Bot 替代，主打**反检测浏览器**（灰色地带，注意合规） |
| [Anil-matcha/open-dots](https://github.com/Anil-matcha/open-dots) | 5,700 | Python | （老仓库改造） | MIT；聊天、连接器、审批、可选 computer use；自称早期原型 |
| [milind-soni/OpenMausBot](https://github.com/milind-soni/OpenMausBot) | 4,453 | TypeScript | **2026-08-11**（与 Grok Bot 同日） | 桌面应用，复用你本机的 Claude/Codex/Grok CLI；本地 harness server 统一事件流；数据存 `~/.openmausbot`；带 VM；378 个 open issues，迭代极快 |
| [elie222/rakazo](https://github.com/elie222/rakazo) | 3,686 | TypeScript | 2026-08-13 | 被认为架构上最接近 Grok Bot：持久命名 agent、各自记忆/routines/历史、浏览器+终端、**可插拔模型与沙箱**、Web/桌面/移动端；作者是 inbox-zero（12k⭐）作者 |
| [rome-os/rome](https://github.com/rome-os/rome) | 751 | TypeScript | 2026-08-23 | “可复利的 agent OS”，递归 agent |
| [egoist/lorca](https://github.com/egoist/lorca) | 288 | Rust | 2026-09 | “单人版 Telegram + agents”，端到端加密 |
| [leepokai/Codync](https://github.com/leepokai/Codync) | 272 | Rust | 2026-03 | 通过 ACP 把 Claude Code / Codex / Cursor / Gemini 等 40+ agent 当作 bot 在手机上发消息 |
| [Anil-matcha/open-grok-bot](https://github.com/Anil-matcha/open-grok-bot) | 12 | Python | 2026-08 | FastAPI + Next.js，受控 computer use、审批、Docker/远程运行时 |
| [Z4YT0N/OpenGrokBot](https://github.com/Z4YT0N/OpenGrokBot) | 5 | TypeScript | 2026-09 | “群聊里的 AI 公司”，多人格员工互相对话，复用订阅或任意 API |
| [ZeroPointRepo/awesome-grok-bot](https://github.com/ZeroPointRepo/awesome-grok-bot) | 59 | — | 2026-08 | Grok Bot 的 skills/插件/MCP 清单 + 自托管替代品 |

### 4.3 第三梯队：Grok 相关的周边工具
- Telegram 桥接 Grok Build CLI：`artickc/grok-telegram-bot`、`kidrauhl123/grok-telegram-bot`（一聊天一进程、定时任务、会话恢复）。
- 基于 Grok API 的 Telegram 聊天机器人：`artastakenaka/grok-ai-telegram-bot`（多为 API key 的薄封装）。
- 支撑组件：[claude-mem](https://github.com/thedotmack/claude-mem)（99.5k⭐，跨会话记忆）、[Agent-Reach](https://github.com/Panniantong/Agent-Reach)（95.7k⭐，读 Twitter/Reddit/小红书等）、[cc-switch](https://github.com/farion1231/cc-switch)（142.7k⭐，多 Agent CLI 管理）。

### 4.4 开源生态的几个规律
1. **“同日开源平替”成惯例**：OpenMausBot 与 Grok Bot 同一天创建，rakazo 晚两天；Dots/Muse 发布后也有大量仓库改描述蹭关键词（`grok-bot-alternative` 话题）。
2. **主流架构 = 复用现成 CLI Agent**：不自己写 agent loop，而是编排 Claude Code / Codex / Grok CLI / Gemini CLI，通过 ACP 或本地 harness 统一事件流。
3. **BYO 模型 + BYO 沙箱**是开源方的核心卖点，正好对着闭源方的“锁定模型 + 单独计量”。
4. **渠道即护城河**：OpenClaw 赢在 20+ 消息渠道，CowAgent 赢在微信。
5. 星标数极度膨胀（OpenClaw 不同文章引用 68k~386k），**判断项目健康度要看 issue 处理、提交频率和真实部署案例，而不是星标**。

---

## 5. 竞争格局总结

```
            托管 / 云端常驻
                  ▲
   ChatGPT Dots   │   Grok Bot
   Gemini Spark   │   Meta Muse
                  │
 生态内 ◄─────────┼─────────► 跨渠道/社交入口
                  │
   Claude Cowork  │   OpenClaw / Hermes / CowAgent
   豆包/Kimi Work │   rakazo / OpenMausBot
                  ▼
            本地 / 自托管
```

| 维度 | 闭源大厂 | 开源 |
|---|---|---|
| 上手 | 开箱即用 | 需部署，门槛高 |
| 模型 | 锁定自家 | 任选，可用现有订阅 |
| 隔离 | Grok 共享机器；Muse 每 agent 独立 VM | 取决于自建沙箱 |
| 成本 | $20–$500/月 + 不透明用量计费 | 自付 API/算力 |
| 入口 | 绑定自家超级入口（X/ChatGPT/WhatsApp/Gmail） | 多渠道接入 |

---

## 6. 附：@grok 式“社交回复机器人”赛道

- **@grok**：X 上被 @ 后用被引用的帖子作上下文公开回复；“@grok is this true?” 已成平台梗。也可以把 @Grok 拉进 X Chat 群。
- **@AskPerplexity**：同样被 @ 后给出带引用的公开回答；2025-06 起支持 @ 后生成 8 秒 AI 视频（带音频），防止生成名人相似形象。
- **问题**：多项研究指出事实核查不可靠——DFRLab 分析以伊冲突期间约 13 万条帖子发现 Grok 判断前后不一、把 AI 生成视频判为真；NewsGuard 发现 Grok 和 Perplexity 都错误证实了“中国向德黑兰派军机”的假消息；印巴冲突中错认旧视频；2026-01 曾引用未通过审核的 Community Note。Renault、Mosleh、Rand 的预印本研究了 LLM 事实核查对 Community Notes 的分流效应。Indicator 发现“@grok is this true”回复密度本身可以作为疑似谣言/热点信号。
- **趋势**：Grok Bot 的 `@bot` 把“社交回复”入口升级为“社交触发任务”——公开 @ 是入口，真正工作在后台 Agent 完成。

---

## 7. 机会与建议（如果要做同类产品）

1. **差异化不要拼“又一个常驻 Agent”**，四大厂 + OpenClaw 已占满。可选切口：
   - **隔离做对**：Grok Bot 的共享机器是公认短板，“每 Bot 独立沙箱 + 按 Bot 授权凭据”是清晰卖点（Muse 已这么做）。
   - **垂直场景**：如 `anomalia`（营销）、inbox-zero（邮件）——垂直 Agent 更容易做出可靠性。
   - **渠道**：国内微信/飞书/钉钉 + 云端常驻，是大厂国际产品覆盖不到的区域。
   - **社交入口 + 可信度**：@ 触发 + 带出处、带置信度的回答，直接回应 @grok 的事实核查口碑问题。
2. **技术选型**：优先复用 OpenClaw / Hermes 生态或编排现成 CLI Agent（参考 rakazo、OpenMausBot 的 harness 设计），把精力放在沙箱、凭据管理、审批流、记忆。
3. **安全默认值**：读操作也要纳入审计；对外部内容（网页、邮件、帖子）做 prompt injection 隔离；Skill/插件市场需签名与审核（OpenClaw 5400+ skills 的供应链风险）。
4. **定价**：闭源方都在“席位价 + 不透明用量”，透明计量本身就是卖点。

---

## 来源

**Grok Bot / @grok**
- [xAI Docs – Grok Bot overview](https://docs.x.ai/grok-bot/overview) · [Skills & routines](https://docs.x.ai/grok-bot/skills-routines-and-automations) · [Computer & apps](https://docs.x.ai/grok-bot/computer-and-apps) · [FAQ](https://docs.x.ai/grok-bot/faq) · [Cursor docs – Grok Bot](https://cursor.com/docs/grok-bot)
- [Flavio Copes – A deep dive into Grok Bot](https://flaviocopes.com/grok-bot/)
- [Layer3 Labs – What is Grok Bot](https://www.layer3labs.io/guides/what-is-grok-bot) · [Grok Bot Review](https://www.layer3labs.io/guides/grok-bot-review)
- [Toolradar – Grok Bot Explained](https://toolradar.com/blog/what-is-grok-bot) · [MindStudio – What is Grok Bot](https://www.mindstudio.ai/blog/what-is-grok-bot)
- [Christopher Alarcon – Week-One Review](https://christopheralarcon.com/blog/what-is-grok-bot) · [The Rundown – Grok Bot Review](https://www.therundown.ai/tools/grok-bot)
- [Codersera – Grok Bot Complete Guide](https://codersera.com/blog/grok-bot-complete-guide-2026/) · [CellCog – Pricing](https://cellcog.ai/blog/grok-bot-pricing/) · [ai-toolbox – Grok Pricing 2026](https://www.ai-toolbox.co/grok-models/grok-pricing-plans-api-2026)
- [Pasquale Pillitteri – Grok Bot for business](https://pasqualepillitteri.it/en/news/14458/xai-grok-bot-enterprise-agents-login) · [OpenClaw Database – Grok Bot Security](https://openclawdatabase.com/grok-bot/security/index.md)
- [X Help – About Grok](https://help.x.com/en/using-x/about-grok) · [Wikipedia – Grok (chatbot)](https://en.wikipedia.org/wiki/Grok_(chatbot))
- [Al Jazeera – As millions adopt Grok to fact-check](https://www.aljazeera.com/economy/2025/7/11/as-millions-adopt-grok-to-fact-check-misinformation-abounds) · [Arab News – DFRLab study](https://www.arabnews.com/node/2605704/amp) · [Indicator – who gets grokked the most](https://indicator.media/p/who-gets-grokked-the-most) · [Tom Stafford – Grok, a mixed bag](https://tomstafford.substack.com/p/grok-a-mixed-bag) · [Decrypt – chatbot jailbreaks](https://decrypt.co/225121/ai-chatbot-security-jailbreaks-grok-chatgpt-gemini)

**竞品**
- [Dig.watch – Perplexity bot makes videos on X](https://dig.watch/updates/perplexity-ai-bot-now-makes-videos-on-x) · [YourStory – Perplexity video on X](https://yourstory.com/ai-story/perplexity-ai-video-search-feature-answer-x)
- [AI Weekly – OpenAI unveils Dots](https://aiweekly.co/alerts/openai-unveils-dots-always-on-chatgpt-agents-at-devday) · [Bernama](https://bernama.com/en/news.php?id=2613531) · [Implicator – $500 tier](https://www.implicator.ai/openai-500-chatgpt-tier-dots-paid-plans/) · [MindStudio – Dots pricing](https://www.mindstudio.ai/blog/openai-dots-agent-pricing)
- [PBS – Meta launches Muse](https://www.pbs.org/newshour/nation/meta-launches-personal-ai-agent-muse-to-help-with-everyday-tasks) · [Runtime Wire – Muse on WhatsApp](https://runtimewire.com/article/meta-muse-personal-ai-agent-whatsapp-apps-launch) · [The Rundown – Meta Muse](https://www.therundown.ai/news/meta-muse-personal-ai-agent)
- [Chrome Unboxed – Gemini Spark on Pro tier](https://chromeunboxed.com/googles-agentic-ai-gemini-spark-is-now-available-on-the-20-pro-tier-in-the-us/) · [APH Networks – Spark rollout](https://aphnetworks.com/news/31954-googles-gemini-spark-agentic-ai-assistant-now-rolling-out-more-users) · [Trending Topics – Gemini Spark](https://www.trendingtopics.eu/gemini-spark-is-googles-answer-to-the-openclaw-hype-high-risk-actions-included/)
- [Vellum – Best Grok Bot alternatives](https://www.vellum.ai/blog/best-grok-bot-alternatives) · [Munder Difflin – Grok Bot alternatives](https://munderdiffl.in/blog/grok-bot-alternatives/) · [Spinnable](https://www.spinnable.ai/blog/best-grok-bot-alternatives) · [Marblism](https://www.marblism.com/blog/grok-bot-alternatives) · [Colrows – Agentic AI bots compared](https://colrows.com/blogs/agentic-ai-bots-compared-2026/) · [Bloome](https://bloome.im/alternatives/grok-bot)

**国内**
- [火山引擎 – 2026 国内 AI Agent 工具清单](https://developer.volcengine.com/articles/7665936353855635519) · [火山引擎 – 10 款桌面 Agent](https://developer.volcengine.com/articles/7660044882941050930) · [CSDN – 国内 AI Agent 完整清单](https://blog.csdn.net/2501_92351994/article/details/163937422) · [新浪财经 – 豆包、千问与 Kimi](https://finance.sina.com.cn/cj/2026-01-19/doc-inhhvwpt6852300.shtml) · [人人都是产品经理 – Personal Agent 开源平替](https://www.woshipm.com/operate/6475152.html)

**开源**
- [DigitalOcean – What is OpenClaw](https://www.digitalocean.com/resources/articles/what-is-openclaw) · [freeCodeCamp – Build & secure OpenClaw](https://www.freecodecamp.org/news/how-to-build-and-secure-a-personal-ai-agent-with-openclaw/) · [ScriptByAI – OpenMausBot](https://www.scriptbyai.com/openmausbot-grok-bot-alternative/) · [ToolJunction – Open-source Grok Bot alternatives](https://www.tooljunction.io/blog/open-source-grok-bot-alternatives) · [OpenAlternative – grok-bot-alternative](https://openalternative.co/tags/grok-bot-alternative)
- GitHub 仓库数据：见第 4 节各链接（GitHub Search API，2026-10-11）。
