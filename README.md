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

1. **并行处理**: 三个AI调用同时生成各自的人格响应
2. **意识整合**: 第四个AI调用基于三者的输出进行最终决策
3. **涌现智慧**: 最终YES/NO从潜意识整合中自然涌现

## 📚 协议文档

关于系统的详细决策协议（如双重否决、母亲否决权等）及彩蛋设定，请参阅 [协议文档](docs/protocols.md)。

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
