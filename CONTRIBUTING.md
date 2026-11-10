# 参与开发

安装 Node.js 22.14 或更新的 22.x 版本，运行 `npm ci`、`npm run setup` 和 `npm run dev`。

提交前运行 `npm test`、`npm run typecheck`、`npm run lint` 和 `npm run build`。测试使用本地构造的数据，不需要请求真实作品或公共演示接口。修复下载流程时，请为实际故障增加回归用例。

## 浏览器剪辑测试

在支持 H.264 High 5.2 / 1440×2560 / 60 fps 编码的桌面设备上，安装 Google Chrome、FFmpeg 与 FFprobe 后运行：

```bash
npm run test:browser -- --project=chrome
```

测试会自动启动本地开发服务，在被 Git 忽略的 `.browser-test/` 中生成不同颜色、比例、时长和音调的素材，验证四格、循环、完整解码、音轨、取消重试、空间不足以及界面自动剪辑流程；不下载真实作品，不请求公共解析服务。通过 `TEST_FFMPEG` / `TEST_FFPROBE` 可指定已有工具路径。

设置 `EDGE_EXECUTABLE_PATH` 为 Microsoft Edge 的实际可执行文件路径后，`npm run test:browser` 会同时运行 Chrome 与 Edge。浏览器能力由设备决定；不具备所需编码能力的 CI 机器不能代替真实设备验收。现有 CI 检查单元测试、类型、Lint 和生产构建。

`BROWSER_TEST_URL` 可指向已启动的本地服务。引擎测试使用 Vite 模块地址，因此应对开发服务运行；界面测试可单独对生产预览运行 `npm run test:browser -- tests/workbench.browser.spec.ts`。测试产生的录制、成片和浏览器文件不得提交。

请勿提交下载的视频、签名媒体地址、API 密钥、Cookie、个人下载记录或环境变量文件。Issue 中说明复现步骤和错误码；如需提供作品链接，请确认它可以公开。新增媒体域名必须保持 HTTPS 和逐次跳转检查，不能开放任意 URL 代理。

欢迎通过 Issue 讨论功能，或提交范围清晰的 Pull Request。
