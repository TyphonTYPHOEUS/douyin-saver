# 拾影 · Douyin Saver

把好内容，留在手边。

一个可独立部署的抖音视频下载网站。粘贴链接或完整分享文案，逐条解析、去重，并在浏览器里接收和校验视频文件。不需要安装 Codex，也不需要登录抖音。

[在线体验](https://douyin-saver.typhon888.chatgpt.site) · [功能与部署](#本地运行) · [MIT License](LICENSE)

## 功能

- 识别抖音作品链接、`v.douyin.com` 短链接和分享页；还原常见 Markdown 转义与 HTML 实体。
- 每批最多 50 条链接，先去重链接，解析后再核对作品 ID。
- 逐条解析；最多同时接收 2 个文件；支持暂停后续任务、失败重试和自动保存。
- 接收文件后检查文件大小、MP4 容器、时长及视频轨道，再发起浏览器保存。
- 区分「待保存」「已发起保存」「未完成」，不把浏览器接收请求当成磁盘保存成功。
- 本地保存最近 200 条任务记录；刷新后不自动恢复下载，也不持久保存会过期的媒体票据。
- 中文响应式界面、键盘操作、使用指南和隐私说明。

## 本地运行

需要 Node.js 22.14+（22.x）及 npm。

```bash
npm ci
npm run setup
npm run dev
```

打开终端显示的地址，默认是 `http://127.0.0.1:5173`。`npm run setup` 只在缺少配置时生成 `.dev.vars`，已有配置会保留。该文件包含本地签名密钥，已被 Git 忽略。

```bash
npm test
npm run typecheck
npm run build
```

单元测试使用构造数据和模拟网络请求，不会下载示例作品。

## 配置解析服务

默认使用 [DTK 的公共演示接口](https://douyin.wtf/)。只向它发送提取后的公开作品链接，演示会话在服务端临时获取，不读取访客的浏览器 Cookie。演示服务存在共享配额和可用性限制；稳定运行建议使用自己的 DTK 实例及 API Key。

在本地 `.dev.vars` 或线上服务端环境中配置：

| 变量 | 用途 |
| --- | --- |
| `MEDIA_TOKEN_SECRET` | 必填，至少 32 字符的随机秘密；用于签发短期下载及任务票据 |
| `DTK_API_BASE` | 可选，解析服务 HTTPS 根地址；默认 `https://demo.douyin.wtf` |
| `DTK_API_KEY` | 自托管解析服务的服务端 API Key；设置后不使用演示登录 |

配置模板见 [.dev.vars.example](.dev.vars.example)。这些变量不能加 `NEXT_PUBLIC_` 前缀，也不能放入客户端代码。不要将 `.dev.vars`、`.env` 或真实密钥提交到 GitHub。

## 独立部署到 Cloudflare Workers

本项目使用 React、TypeScript、Vinext 和 Cloudflare Workers，可在自己的 Cloudflare 账号部署。无需 Sites 账号；仓库保留了 Sites 发布所需的构建支持。

1. 执行 `npm ci` 和 `npm run build`。
2. 运行 `npx wrangler login` 登录你自己的 Cloudflare 账号。
3. 配置随机签名密钥。命令会交互式读取，不要把真实密钥写进脚本：

```bash
npx wrangler secret put MEDIA_TOKEN_SECRET --config dist/server/wrangler.json --name douyin-saver
```

4. 如有自托管解析服务，同样通过 Wrangler 配置 `DTK_API_BASE` 和 `DTK_API_KEY`。
5. 执行 `npm run deploy:cloudflare`。自定义 Worker 名称可设置 `WORKER_NAME`，并在前面的 secret 命令中使用同一个名称。

`.openai/hosting.json` 中的 `project_id` 标识维护者的 Sites 站点，不是凭证，也不用于独立 Cloudflare 发布。若你要创建自己的 Sites 站点，请先移除该字段，并通过自己的 Sites 工作流注册。

## 数据与边界

- 视频通过服务端流式转发，在浏览器里接收和校验；本站不建立下载记录数据库或长期保存视频。
- 记录属于当前浏览器。清空记录或浏览器存储不会删除已经保存到设备的文件。
- 实际保存位置、是否允许多文件下载、移动端保存行为由浏览器决定。请在浏览器下载列表中确认文件结果。
- 当前只支持公开的视频作品及 200 MB 以内的文件，暂不支持图集、直播、私密或已删除作品。
- 校验等级为 **container**，检查容器结构和已知文件大小；不进行 FFmpeg 完整音视频解码，也不能据此保证画面全部可播放。
- 仅在解析服务明确标记 `watermark: false` 时显示「接口提供无水印」；本项目不做画面去水印处理。
- 服务端签名有效期 10 分钟，过期后请重新解析。不会循环重试失效的媒体签名。
- 限流为每个运行实例的内存限制，不能代替分布式配额。公开规模扩大时，应增加 WAF / Rate Limiting，并使用独立的解析服务配额。见 [SECURITY.md](SECURITY.md)。

请仅保存你有权下载和使用的内容，并尊重创作者及平台规则。

## 目录

```text
app/workbench.tsx       浏览器界面与任务队列
app/api/parse/         提交单条解析请求
app/api/tasks/         读取同一异步解析任务
app/api/media/         校验票据并流式转发视频
lib/douyin/            链接、解析服务、签名、MP4 校验与历史记录
scripts/               本地配置、运行与独立部署
build/                 Sites / Workers 构建支持
tests/                 无真实网络依赖的回归测试
```

项目不包含维护者本地下载的视频、个人记录、Codex 设置、浏览器 Cookie 或部署密钥。

## 参与与许可

欢迎提交 Issue 或 Pull Request。开发说明见 [CONTRIBUTING.md](CONTRIBUTING.md)。

应用代码使用 [MIT License](LICENSE)。保留的构建支持及依赖遵循各自许可证，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。DTK 是独立外部服务，本项目未打包其服务端源码。
