<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
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

1. **并行处理**: 三个AI调用同时生成各自的人格响应
2. **意识整合**: 第四个AI调用基于三者的输出进行最终决策
3. **涌现智慧**: 最终YES/NO从潜意识整合中自然涌现

## 🎭 EVA-MAGI 彩蛋协议

系统内置了受《EVA》和《少数派报告》启发的特殊决策规则：

- **🔴 双重否决**: MELCHIOR + BALTHASAR同时反对时，默认否定（除非CASPER有压倒性预知证据）
- **🟡 偏见检测**: CASPER同意但MELCHIOR反对时，标记潜在情感操纵
- **🟢 绝对共识**: 三个原型全部同意时，必须批准（三重共识不可否认）

*"The three must agree, or the answer is no." - Gendo Ikari*

## 🛡️ 系统加固特性

- **JSON防御系统**: 自动清理和验证模型输出，防止解析错误
- **超时熔断机制**: 45秒超时保护，防止单个人格调用卡死
- **母亲否决权**: BALTHASAR拥有对未来五年潜在伤害的绝对否决权

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
