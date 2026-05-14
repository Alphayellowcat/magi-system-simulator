<div align="center">
<img width="1200" height="475" alt="MAGI System Banner" src="public/images/magi_banner.png" />
</div>

# MAGI 系统模拟器

一个基于荣格原型的AI决策系统，采用3+1架构：

## 🧠 系统架构

**三个并行人格**（基于荣格原型）：
- **MELCHIOR** (学者): 分析性思维 - 理性、事实驱动
- **BALTHASAR** (母亲): 保护性本能 - 安全、稳定导向
- **CASPER** (女人): 直觉自我 - 情感、欲望驱动

**一个总人格**：将三个并行人格的输出当作自己的潜意识输入，进行最终的意识整合和决策。

## 🔄 工作流程

1. **独立思考**: 三个人格并行读取人格契约、单人格记忆、共同记忆、工具/skill/MCP 注册表，并生成各自初步判断
2. **工具规划**: 人格可提出 `web.search.tavily`、`skill.run`、`mcp.call` 请求；读类低风险动作可直接执行，高风险动作进入审批队列
3. **三人格会议**: 三个人格读取彼此初步结论与待审批动作，进行一轮交叉质询、修正提案和二次投票
4. **共同整合**: Council integrator 汇总初步结论、会议记录、工具审计、待审批动作与澄清问题，形成最终答复
5. **确认与执行**: 需要用户意图、审批或补充信息时进入 `WAIT`，用户可在界面批准/拒绝动作或回答澄清问题

## 📚 协议文档

关于系统的详细决策协议（如双重否决、母亲否决权等）及彩蛋设定，请参阅 [协议文档](docs/protocols.md)。

## 🧩 Harness 文档

新版本将三贤者升级为 Markdown 驱动的 agent harness：

- `public/harness/personas/*.md`: 三个人格的可编辑人格契约
- `public/harness/memory/*.md`: 共同记忆与单人格私有记忆
- `public/harness/tools.md`: 工具注册表与三人格权限
- `public/harness/skills.md`: SKILL.md 风格的技能注册规范
- `public/harness/mcp.md`: MCP adapter 规划与执行门禁
- `public/harness/council.md`: 共同决断、自维护与执行协议

应用内侧栏 `Ops` 页可以调整模型配置、测试连接、保存运行时配置、调整推理强度，并直接编辑这些 harness 文档。运行时会优先使用本地保存的设置和 Markdown，未填写的模型配置会回退到 `.env.local`。

每轮会话的全链路 trace 会跟随该轮模型消息一起保存在 session 历史中，包含输入、运行时配置摘要、Markdown 上下文、人格输出、工具调用轨迹、三人格会议记录、待审批动作、澄清问题、综合决策和文档维护操作。界面上也会显示执行事件流，用于观察每一步是 queued、running、complete、waiting 还是 failed；后续如果需要独立审计文件，可以再从这些结构化 trace 导出 JSONL。

## 🛂 行动审批与确认

MAGI 现在会按风险对工具请求分类：

- `web.search.tavily`、`skill.run` 的 `load` 模式、MCP 的 `read/list/get/search/find/stat/inspect` 等读类动作会自动执行并进入 tool trace。
- `skill.run` 的脚本模式、MCP 的 `write/edit/delete/move/create/update/execute` 等变更类动作会生成 `pendingActions`，在聊天消息里显示 Approve/Reject。
- 审批通过后，前端会通过本地 bridge 真正执行 `skill.run` 或 `mcp.call`，并把执行结果、失败原因和追加 trace 写回原 session。
- 如果 council 认为缺少用户意图，会生成 `clarificationRequests`，用户可点击问题把它带回输入框继续回答。

## 🗂️ Harness 目录范式

```text
.magi/
  README.md
  skills/                 # 项目私有 skills，每个 skill 内含 SKILL.md
  mcp/
    servers.example.json  # 可提交示例
    servers.json          # 本机 MCP server 注册表，gitignored
  config/
    bridge.example.json   # 可提交示例
    bridge.json           # 本机 bridge 配置，gitignored
  state/                  # 会话、记忆、运行时设置、用户编辑后的 harness 文档，gitignored

public/harness/           # 可提交的默认 harness 模板
```

范式上，**skill** 是“怎么做”的流程/规则包，**MCP** 是“能调用什么工具”的 provider。比如 PDF 审查方法应该是 skill；文件读写、GitHub、浏览器、数据库等动作能力应该是 MCP/tool provider。

## 🔌 本地 Bridge

Vite 开发服务器现在会挂载一个本机 harness bridge：

- `GET /api/harness/bridge/status`: 查看可发现 skills、本地 MCP 配置和 bridge 状态
- `POST /api/harness/bridge/tools/execute`: 执行 `skill.run` 或 `mcp.call`
- `POST /api/harness/bridge/mcp/list-tools`: 调用 MCP `tools/list`

本地配置文件：

- 复制 `.magi/config/bridge.example.json` 为 `.magi/config/bridge.json`，用于配置 skill script 执行权限和额外 skill roots。
- 复制 `.magi/mcp/servers.example.json` 为 `.magi/mcp/servers.json`，用于配置 stdio 或 Streamable HTTP MCP servers。

`.magi/config/bridge.json` 和 `.magi/mcp/servers.json` 已被 `.gitignore` 忽略，因为它们通常包含本机路径、命令或密钥。旧版顶层 `magi.bridge.json` / `magi.mcp.json` 仍可兼容读取，但不再推荐。

## 💾 配置与会话存储

运行时状态采用 bridge-backed 文件存储，浏览器 `localStorage` 只是 fallback：

- `.magi/state/sessions.json`: 会话历史，每轮回答内含结构化 trace
- `.magi/state/memories.json`: 旧版 Cortex 记忆
- `.magi/state/settings.json`: 模型运行时配置
- `.magi/state/documents.json`: 用户编辑后的 harness Markdown

仓库内 `public/harness/*.md` 是默认模板；用户修改后的版本会进入 `.magi/state/documents.json`。`.magi/state/` 已被 `.gitignore` 忽略，避免把本机配置、密钥或会话历史提交出去。

## 🧪 CLI 验证飞轮

仓库内置命令行验证入口，方便绕过 UI 直接测试 bridge、MCP、三人格编排、流式 synthesis、审计日志与工具 trace：

```bash
npm run magi:status
npm run magi:smoke
npm run magi:smoke:full
npm run magi:cli -- "请读取当前项目目录树，判断你能否看到本体代码"
```

- `magi:status`: 启动 Vite harness bridge，列出 runtime skills、MCP servers 和 tools。
- `magi:smoke`: 只做确定性的 bridge/MCP smoke check，不调用模型。
- `magi:smoke:full`: 在 smoke check 后跑一轮真实 MAGI prompt，并断言 `mcp.call`、`council-tools`、`synthesis-tools`、`synthesis-stream` 和 auditRef。
- `magi:cli`: 运行单条 prompt；支持 `--format json|jsonl`、`--stream`、`--out <path>`、`--expect-tool <id>`、`--expect-phase <phase>`、`--save-session`。

CLI 会读取 `.env.local`、`.magi/state/settings.json`、`.magi/state/documents.json` 和 `.magi/state/memories.json`，并为每次运行写入 `.magi/audit/<sessionId>.jsonl`。`smoke --full` 默认还会把 JSON 报告写入 `.magi/artifacts/cli/`。

## 本地运行

**先决条件：** Node.js

1. 安装依赖：
   `npm install`

2. 配置环境变量：
   复制示例配置文件：
   `cp .env.example .env.local`
   
   在 `.env.local` 中填入你的配置：
   - `OPENAI_API_KEY`: API密钥 (vLLM/OpenAI/DeepSeek)
   - `OPENAI_BASE_URL`: API服务器地址
   - `OPENAI_MODEL_NAME`: 模型名称
   - `VITE_TAVILY_API_KEY`: Tavily Search API Key (用于联网搜索)
   - `VITE_PORT`: 开发服务器端口 (可选，默认: 3000)

3. 确保 vLLM 或其他兼容服务器正在运行 (如果使用本地模型)。

4. 运行应用：
   `npm run dev`
