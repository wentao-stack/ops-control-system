# OPS Control System — 进度总览

> 最后更新：2026-08-17
> 代码规模：后端 35 个 py 文件 / ~12.5k 行，前端 23 个页面 tsx / ~11k 行，测试 18 个文件 123 个用例
> 线上地址：https://ops.sanbunto.online （公开门户 `/`，OPS 控制台 `/admin/*`）

按开发阶段（期）整理，每期含目标、主要提交与验收结果。

---

## 第一期：资产清单与多主机监控（2026-07-17 ~ 07-29）

目标：把散落的服务器/VPS 纳入统一控制台，能看状态、能远程操作。

- 资产清单 v0：SQLite 存储 + 真实生产服务器入库（b424964, 919ad9b）
- 告警 / 变更 / Runbook / 主机监控 + JWT 登录认证（b424964）
- 多主机 SSH 监控看板：并行采集、/proc 指标、缓存（93d359c, 5231bf8, 97f79b9）
- 远程 SSH 控制：ping / exec / Web 终端面板（96d56a6）
- 远程服务探测 + Services 页面（e2f1985）
- Supervisor 远程进程管理（restart/status/logs，多源日志查看器）（23fa1f2, 01ca129）
- WebSSH 交互式终端：WebSocket + asyncssh + xterm.js，多连接并发、resize/重连修复（0d0d9a7, 7ed6350, 2d00425）
- local_machine 模式：开发机走 subprocess 而非 SSH+FRP 隧道（8c48c05）
- 进程管理统一切到 Supervisor（7d2ece7），移除 llama-swap（a7c81b0）

验收：监控/终端/服务/进程四类页面可用，生产机可远程重启服务。

## 第二期：云平台 + 知识库（2026-07-29 ~ 08-05）

目标：账单与知识库进控制台。

- Clouds 页面：Vultr 实时余额/账单历史（Vultr API v2 字段对齐、Remaining Credit 公式）、ConoHa VPS 3.0 实时 API、Namecheap DNS 参考面板（3c08a05, df2a8a1, b99516b, 452f933）
- Notes 知识库：分类/标签/Markdown 预览，详情页 + 分页（c7fdda9, 33e0fdb）
- 存储设计落地：SQLite WAL、Notes CRUD API、ExecLog 自动记录、备份工具（81ddfad）
- 种子知识库 11 篇笔记（5ed6d86）

验收：云账单实时可查，笔记可分类浏览。

## 第三期：工作流 + Agent 基础（2026-07-30 ~ 08-07）

目标：流程自动化 + 会调工具的聊天 Agent 上线。

- 工作流：模板 CRUD + 执行引擎（Shell / Note API 步骤）+ 执行日志 + 前端编辑器/时间线 UI（89bcde1, ac20f42, 2d0131a, 92e382b）
- Agent Week 1：后端基础 API + LLM 聊天 + SSE 流式（e83f593），本地 LLM（qwen36-27b-mtp-102k）配置（0b3cea7）
- 工具调用系统：6 个读取工具 + ToolRegistry + tool calling loop（094c6c2）
- 代码浏览器：语法高亮、Markdown 渲染、树展开/收起、复制（9f83421, 3967330）
- 对话体验修复：重复显示/重复创建/422 等一串 bug（784ec39, 070bbe9, 60af5ae）

验收：流程可配置可执行留痕；Agent 可流式对话并调用只读工具。

## 第四期：Agent 工具权限 + 记忆 + 主动监控（2026-08-06 ~ 08-07）

目标：Agent 从「能读」到「能安全地写」，并开始主动巡检。

- Phase 2 工具权限分级（read/write/exec）+ AgentToolCall 审计日志 + 命令黑名单 + 前端风险等级显示（ff07202）
- Phase 1 五个写入工具 + 前端确认机制，33 个单测全过（392fd3f, 7c53fb1）
- Phase 3 Token 用量追踪：AgentUsage 模型 + 用量统计面板（54943a2, f36929b）
- Phase 4 记忆系统：AgentMemory 模型 + save/get_memories 工具 + 记忆注入 system prompt + 记忆管理面板（d69e9f1, 1cc20b5）
- 主动监控：POST /agent/inspect 收集主机指标/服务/告警 → LLM 分析 → 自动建笔记（583f436）
- 架构升级：LangGraph 状态流（chatbot→invoke_tools→finalize）（d93ea95），SSE 即时串流（2b2131a），SSE 事件总线 12 种事件 + tool card + toast + 进度条（a07835b），LLM 超时 600s 不崩流（e37b94b）
- metrics_history 表：监控历史持久化 + 图表 API + 历史面板（00b27d3）

验收：写操作有确认与审计，Agent 能记住上下文、主动巡检出问题自动记笔记。

## 第五期：RAG 检索 + ComfyUI 生成（2026-08-07 ~ 08-13）

目标：Agent 答案有出处；控制台内直接跑 ComfyUI 出片。

- RAG 语义搜索：qwen3-embedding:0.6b + ChromaDB + rag_search 工具（ab7b599）
- 向量搜索记忆：混合 RAG + 关键字排序 + 自动 upsert（d687b73），Agent 管理数据分页（14aed90）
- ComfyUI 生成页：工作流模板化一键生成（H3 T2VA + LTX I2V），真实进度（单调递增 + 自动重连）、时长按秒、品质提示（b2965e9, 4fd75c6, a304331）
- H3 Turbo 参考图 I2V 工作流 + uncensored enhancer 子图（b6f4a16, d8e0671）
- 作品画廊批量删除（a114767, 7534e7e），视频轮询防中断（e961a8b）

验收：Agent 回答可引用知识源；一键出片、进度真实、画廊可管理。

## 第六期：全站 i18n（2026-08-12 ~ 08-13）

目标：三语界面（zh-TW / en / ja）。

- i18next + react-i18next 初始化，语言切换按钮（单按钮循环三语）（3e47259, 8874813）
- 全页面覆盖：Agent/CodeBrowse/ComfyUI/Sequence/Clouds/Monitoring/Notes/Remote/Services/Settings/Workflow/AgentChat 等 14+ 页面，词典批量扩充（48f2fe9, aab9320, 266b40b）
- Agent 回复语言跟随前端（英文/日文）（15ef23c），工具监控结果跟随界面语言（7b5a793）
- 移除 Showcase 相关代码（2a01ada）

验收：tsc + production build 通过，三语切换全站生效。

## 第七期：内容分享门户（2026-08-14 ~ 08-17）

目标：把笔记/ComfyUI 作品发布成公开内容站。

- 内容分享功能：路由重构（公开门户 `/` + 管理控制台 `/admin/*`）、SharePost 模型/API、前端页面（4b07b7e）
- 公开主页深色主题 + 实时统计 + 特性卡片，纯内容分享不暴露资产（3bffe34, 96c5e51）
- 审核/发布工作流：notes 与 AI 内容 review → publish（2d7b4ca）
- 发布流程 publish-from-source（note|comfyui），JWT 走 api() helper（e726fb7）
- 文章 URL 改 /p/:id（数字 ID）（ee08eeb），顶栏显示应用名（80efa14），已发布笔记点击跳公开页（9019426）
- 主题筛选 chips 可点击过滤 + 词级 fallback（505da90, 48db49d）
- 文章详情页深色主题 + 完整 Markdown（8637bbe），主页视频播放/封面修复（d3dc86d），文章/影片分区 + 影片页重设计（b6516f4）
- ComfyUI 作品发布改表单（标题+主题描述+草稿选项）（e90b614），视频发布流程修复（6ae5cf7）
- 移除管理端内容管理页，编辑/发布统一走生成页（e47a806）

验收：公开站 `/` 与 `/p/:id` 正常，发布链路（笔记/ComfyUI）可用。

## 第八期：Agent RAG 深化 + 安全加固（2026-08-14 ~ 08-17，当前）

目标：Agent 执行有依据、可审计、多用户安全。

- Runbook 知识库：curated runbook catalog + 运营 runbook 目录扩展（7c76cae, c5fd7a4）
- 引导式 Runbook 执行：guided execution（1aa29a1），聊天标题本地化（2109bc9）
- Grounded RAG 引用（4168756），检索质量评估面板（07669d6），reindex 用户鉴权（1bd3a85），可变知识源同步 + Chroma source filter 修复（048493b, 7cbe651）
- Run 中心：运行列表 + 从聊天取消活跃运行（e575b4a, 70623b0）
- P0 安全管控：生产环境 shell 只读白名单、防重复进程命令、防读工具循环（4dba663, da5613e, 0498aac, 3cdd90f, 7a0aac2）
- 受控诊断（d1e2578），监控 CPU/磁盘指标解析修复（e6e36e8）
- 认证用户身份注入（_actor）：create_note / acknowledge_alert / supervisor_action / memory / RAG 检索全部以登录用户身份执行，不再信任模型传入 user（d662461）
- RAG 跨用户隔离回归测试：验证检索绝不泄漏其他用户 memory（test_agent_rag_isolation.py）
- 模型：默认 qwen38-27b-code-mtp-v1（4312c64，曾临时切 no-think-v1 后切回）

验收：全量 pytest 123 passed；线上 https://ops.sanbunto.online 重启后 HTTP 200。

---

## 未完成 / 下一步（详见 docs/P0_TODO.md）

- [x] P0-1 RAG/记忆用户隔离（d662461 完成，P0_TODO 已勾选）
- [x] P0-3 审计日志记录实际登录用户（_actor 注入完成，P0_TODO 已勾选）
- [ ] P0-2 AgentRun 持久化状态机（queued/running/awaiting_approval/... 断线恢复、步骤级超时/重试/幂等）
- [ ] 多用户上线前检查清单：前端多用户 UI、端到端多用户测试、安全审计
