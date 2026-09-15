# The Last Brain

Read-only conversations with your current Obsidian vault, local chat history, and manually reviewed memories with sources. The interface is currently in Chinese. Requires Obsidian 1.11.4 or later.

## Install the test release

Download [the latest release](https://github.com/justinjia0813/the-last-brain/releases/latest), extract the `the-last-brain` folder into your vault's `.obsidian/plugins/` directory, and enable it in **Settings → Community plugins**. Open Model configuration, choose a provider, enter the model and key, and save; then enable sending context in plugin settings. Open the ribbon chat icon to start. The community listing is at https://community.obsidian.md/plugins/the-last-brain; directory approval and availability may lag behind GitHub releases.

**Network and privacy:** The plugin calls only the OpenAI-compatible model endpoint you configure, and only when you send a message, request a memory draft, or explicitly test the connection. A connection test sends a fixed synthetic greeting and no vault content. It transmits your question, bounded recent history, retrieved Markdown excerpts, and relevant confirmed memories. A provider account, key, and payment may be required by your chosen service; an unauthenticated local model can also be used. There is no plugin subscription, telemetry, advertising, self-update mechanism, or access to files outside the current vault.

Your notes are read-only. Chat history, source snapshots, and memories are stored in the plugin's own `data.json`; keys use Obsidian's secret storage. Model output is displayed as plain text, and no tools or file editing operations are exposed to the model. Memory drafts require confirmation before reuse. Lexical retrieval is limited to Markdown and does not guarantee complete vault coverage. Desktop macOS was tested with a synthetic local model; real provider quality and mobile behavior remain unverified.

Licensed under the [MIT License](LICENSE). Bugs and feedback: [GitHub Issues](https://github.com/justinjia0813/the-last-brain/issues).

## 中文说明

基于当前 Obsidian vault（笔记库）的只读 AI（Artificial Intelligence，人工智能，即帮助你理解笔记并生成回答的模型）聊天插件。

## 安装与开始

需要 **Obsidian 1.11.4 或更新版本**。当前版本为 0.2.0；[社区条目](https://community.obsidian.md/plugins/the-last-brain)的审核及更新显示可能晚于 GitHub 发布。

1. 下载并解压 [the-last-brain-0.2.0.zip](https://github.com/justinjia0813/the-last-brain/releases/download/0.2.0/the-last-brain-0.2.0.zip)，将整个 `the-last-brain` 文件夹放到目标库的 `.obsidian/plugins/` 下。文件夹中应有 `main.js`、`manifest.json`、`styles.css`。
2. 在 Obsidian「设置 → 第三方插件」中启用 **The Last Brain**。若列表未更新，重启 Obsidian。
3. 打开插件设置，填写**模型服务地址、模型名称、密钥**。地址兼容 OpenAI 的聊天接口，例如 `https://api.openai.com/v1`；本地模型服务可填 `http://localhost:11434/v1`。通过「配置模型」选择服务，填写后点「保存并使用」。也可主动测试连接，测试只发送固定问候，不发送笔记。不内置或捆绑任何模型额度。
4. 按需要设置排除目录，并开启「允许向配置的模型服务发送上下文」。
5. 点击左侧聊天图标，或执行「The Last Brain: 打开只读问答」命令。

## 使用

- 输入包含具体项目、公司或主题名称的问题。插件在本地查找相关笔记片段，把片段和问题交给模型回答。
- 回答下方的「来源片段」保留当时引用的文本、路径和笔记修改时间。点击路径打开现存笔记；来源已删除时仅提示，不创建文件。引用编号由模型生成，应对照片段检查。
- 对话自动保存。可新建、切换或删除对话。删除对话会同时删除该对话生成的记忆，执行前有确认。
- 一轮问答完成后，点击「整理为记忆草稿」。草稿区分**证据、推断、未知、建议**，并区分用户偏好与笔记中的主张。这是提示词要求，并不保证模型每次严格遵循；请审阅。
- 在「记忆」页查看草稿，可编辑草稿，保存为草稿或「确认记忆」后才会按相关性加入后续问答。可删除不再适用的记忆。已有记忆不会因笔记变化自动更新。
- 模型错误时保留问题，可以重试。不要把没有引用依据的回答当作库中已证实的结论。

## 只读与保存位置

**不新建、不编辑、不删除、不移动你的笔记或附件；不执行命令，也不给模型任何操作工具。**

保存记录需要写入插件自身的数据文件：`.obsidian/plugins/the-last-brain/data.json`。它包含设置、对话、引用片段快照、记忆草稿及确认状态。每个笔记库分别保存；若你的同步方案同步插件目录，这些数据也可能随之同步。卸载前请自行备份该文件。

密钥存放于 Obsidian 自带密钥存储，不进入上述聊天数据。对话与记忆文件本身没有额外加密。

仅点击「发送」、「整理为记忆草稿」或「测试连接」才发起模型请求；不会后台扫描上报或自动生成记忆。问答和记忆请求包括问题、近期对话、命中的笔记片段与相关已确认记忆；连接测试仅发送固定问候。模型服务由你选择，可能产生该服务的调用费用。

排除目录在读取前生效，也阻止关联记忆参与后续请求。历史消息中已经生成的回答仍可能包含被排除内容；更改排除设置后请新建对话，并删除不应继续保留的旧对话。该设置不能撤回过去已经发送给模型的内容。

## 当前范围

| 项目 | 当前行为 |
| --- | --- |
| 笔记读取 | 仅 Markdown 正文与路径；不解析附件，不抓取外部链接 |
| 检索 | 中英文关键词、正文分块；默认最多 6 个来源，每篇笔记取最相关的一段 |
| 规模 | 每个文件最多 1 MB，每次最多读取 20 MB；按路径顺序读取，超限或失败的跳过数量可见 |
| 笔记上下文 | 默认 16,000 字符上限，可选 8,000 / 16,000 / 32,000；每个候选片段最多约 1,200 字符 |
| 对话上下文 | 当前问题最多 12,000 字符；历史最多 7 条、合计约 8,000 字符。完整历史仍保存在本地 |
| 记忆沉淀 | 基于最近最多 7 条对话及相关笔记片段；不是无限长对话的全量总结 |
| 记忆复用 | 仅相关且已确认的记忆，最多 4 条、正文约 6,000 字符 |
| 输出 | 整段返回、纯文本展示；不渲染模型生成的网页、图片或可执行代码 |
| 请求 | 90 秒等待上限；可停止等待并丢弃迟到回答，但停止或超时不保证服务端已停止处理，重试可能额外计费 |
| 已验证平台 | macOS 桌面版 Obsidian；移动端尚未实测 |

关键词检索不保证同义词召回，也不能据此声称已完整阅读全库。首版未加入向量检索、附件解析、自动记忆或笔记编辑能力。

## 开发与验证

```sh
npm ci
npm run check
```

构建生成根目录 `main.js` 和 `release/the-last-brain/` 安装目录。运行时只依赖 Obsidian。

`tests/core.test.ts`、`tests/host.test.ts` 与 `tests/storage.test.ts` 检查检索、请求预算、来源隔离、记忆筛选、响应校验、历史恢复和损坏数据保护。

0.2.0 的原生界面检查使用 `tests/native-ui.cjs` 和 `tests/model-settings-ui.cjs`，通过 Obsidian 命令行创建临时测试视图和内存设置，不更改真实对话或密钥；模型测试仅访问本机合成服务。脚本默认目标库为 workspace。旧版完整检索检查保留在 `tests/obsidian-smoke.cjs`，其界面选择器对应 0.1.0。详细结果见 [验收记录](docs/validation.md)。

开发接口依据 [Obsidian 官方示例插件](https://github.com/obsidianmd/obsidian-sample-plugin)和安装的官方类型定义；网络请求采用 [Obsidian requestUrl](https://docs.obsidian.md/Reference/TypeScript%20API/requestUrl)。
