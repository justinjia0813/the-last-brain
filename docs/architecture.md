# 第一版行为与验收约定

## 用户行为
- 点击侧边栏图标或命令，打开当前 vault（笔记库）的聊天面板。
- 本地检索 Markdown 笔记的标题、路径和正文片段；问题、近期对话、命中片段、已确认记忆发送到用户配置的模型地址。
- 所有对话存入本 vault 的插件数据。生成记忆草稿，标明推断、未知、建议和来源；用户确认后才参与后续问答。
- AI（Artificial Intelligence，人工智能，即生成回答的模型）没有文件写入、命令执行或任何工具调用能力。
- 对笔记只读；必要的持久化只使用插件 loadData/saveData。密钥用 Obsidian SecretStorage（密钥存储）保存，不进入聊天数据。

## 模块和接口
- `types.ts`：唯一共享数据约定，源码即签名。
- `retrieval.ts`：`retrieve(notes: Note[], query: string, settings: Settings): Retrieval`；纯函数，中英文关键词、路径排除、正文分块、按总字符预算截断。无匹配返回空，不随意塞入笔记。
- `model.ts`：`buildRequest(input: CompletionInput): { url: string; headers: Record<string,string>; body: string }`；`parseCompletion(json: unknown): string`。标准 /chat/completions，无流式、无工具；HTTPS（Hypertext Transfer Protocol Secure，安全超文本传输协议，用于加密传输）或本机 HTTP。记忆必须区分证据和推断。
- `view.ts`：`ChatView extends ItemView`，构造 `(leaf: WorkspaceLeaf, host: ChatHost)`，类型 `the-last-brain-chat`，公开 `refresh(): void`。仅通过 host 调用业务能力；模型文本按纯文本呈现，来源用独立按钮打开现存笔记，避免执行模型生成的 HTML（HyperText Markup Language，超文本标记语言，用于描述网页结构）。
- `main.ts`：Obsidian 生命周期、设置、只读读取、单任务互斥、请求及持久化串行队列。输入提交先持久化；失败保留问题并可重试，不记录失败答案。上下文有明确预算。

## 依赖
运行时仅 Obsidian 原生能力；开发使用 TypeScript 和 esbuild 构建。测试通过 Node 内置测试器。无需后端、数据库或向量服务。

## 验收
1. 中文/英文检索相关片段，排除目录在读取前生效；长笔记后段可命中，总预算有界。
2. 多轮请求顺序正确，仅已确认且相关的记忆参与；来源明确为引用片段而非已验证事实。
3. 不可信笔记只能作为资料，模型请求不带工具；请求配置及响应验证，错误和重复点击安全处理。
4. 新建/切换/删除对话、重启恢复、记忆生成/确认/删除可用；不创建或修改 vault 笔记。
5. 类型检查、可运行检查、打包均通过；隔离测试环境验证交互和文件只读，不调用真实付费模型。

## 已知范围
首版只读 Markdown；关键词检索不保证同义词召回或全库穷尽，必须显示读取/跳过数。大库按文件体积限额跳过并明示，不假装已全量阅读。附件解析、语义向量、流式输出留待实际需要。
