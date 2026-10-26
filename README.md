# 美卡论坛自动阅读

使用 GitHub Actions 批量登录美卡论坛、自动阅读和点赞。运行环境由 Actions 准备，无需配置 `.env` 或部署服务。

## 配置

在仓库 **Settings → Secrets and variables → Actions → New repository secret** 中添加：

| 必需 Secret | 说明 |
| --- | --- |
| `USERNAMES` | 用户名，多个用英文逗号分隔，例如 `user1,user2` |
| `PASSWORDS` | 对应密码，顺序和数量须与用户名一致，例如 `password1,password2` |

密码中的空格会保留；当前列表格式不支持密码包含英文逗号。

可按需添加以下 Secrets：

| Secret | 默认值 / 说明 |
| --- | --- |
| `WEBSITE` | `https://www.uscardforum.com` |
| `RUN_TIME_LIMIT_MINUTES` | `100`，readLike 全部账号的总运行时间，按批次分配 |
| `MAX_CONCURRENT_ACCOUNTS` | `3`，每批同时运行的账号数 |
| `NAV_TIMEOUT_MS` | `60000`，导航和登录等待超时（毫秒） |
| `SPECIFIC_USER` | `halowang`，likeUser 任务的点赞对象 |
| `AUTO_LIKE` | `true`，设为 `false` 仅阅读 |
| `TELEGRAM_BOT_TOKEN` | 可选，Telegram 机器人 Token |
| `TELEGRAM_CHAT_ID` | 可选，接收登录结果的聊天 ID；须与 Token 一起配置 |
| `PROXY_URL` | 可选，完整代理地址，例如 `http://user:password@host:port` |
| `PROXY_TYPE` | 分开配置代理时使用，默认 `http` |
| `PROXY_HOST` / `PROXY_PORT` | 分开配置代理时须同时填写 |
| `PROXY_USERNAME` / `PROXY_PASSWORD` | 可选，代理认证信息 |

`PROXY_URL` 优先于分开的代理配置。

## 运行

在 **Actions** 中启用工作流，然后选择任务并点击 **Run workflow**：

- **readLike**：每日自动阅读并随机点赞，默认总时长 100 分钟。
- **likeUser**：北京时间周六运行 20 分钟，按四周轮换抽选账号，阅读并给 `SPECIFIC_USER` 点赞；其他账号不启动浏览器。
- 手动运行直接执行正式阅读，`run_time_minutes` 指定总时长，readLike 默认为 `100`。不再提供短验证开关。
- **Single-account reading verification (3 minutes)**：仅用第一个账号阅读 3 分钟，关闭点赞，比较服务端 `time_read` 前后值并检查自然阅读计时响应；数据没有增加会报告失败。后续调试使用这个任务。

账号失败会在日志中标明序号并使本次运行失败，其他账号继续执行。

每分钟直接读取页面累计计数，记录实际换帖、滚动、点赞请求及成功响应。达到点赞上限只停止点赞，阅读继续；阅读和验证任务共用并发组，避免同一组账号同时运行。

### 特定用户点赞轮换

从首次正式执行所在周开始，按北京时间自然周（周一至周日）组成四周周期。每周从本周期未完成的账号中随机抽选，数量为“剩余账号数 ÷ 剩余周数”向上取整：

| 配置账号数 | 第 1 周 | 第 2 周 | 第 3 周 | 第 4 周 |
| --- | --- | --- | --- | --- |
| 8 | 2 | 2 | 2 | 2 |
| 6 | 2 | 2 | 1 | 1 |
| 3 | 1 | 1 | 1 | 0 |

只有服务端确认给指定用户点赞成功才记为完成。同周手动重跑沿用原抽选计划，只重试未完成者；已完成或未选中的账号休眠。正常完成四周后开始下一轮；失败或漏跑会在剩余周内补配额，超期仍保留未完成账号，先补完再开启新周期。

进度自动保存在独立的 `like-user-state` 分支，仅存账号哈希和轮换记录，不保存明文账号或密码。工作流使用自带 `GITHUB_TOKEN` 的 `contents: write` 权限，无需新增 Secret。调整账号顺序或密码保留进度，增删账号会更新剩余名单；更换 `SPECIFIC_USER` 会开始新周期。

手动运行 **likeUser** 时，可勾选 **preview_rotation** 查看当前账号配置的新四周排班；预览不登录、不点赞，也不保存或推进进度。每日 **readLike** 仍使用全部账号。

**Update Workflow Cron** 会将启动时间随机设在北京时间 07:00–23:59，需额外设置具有仓库内容和工作流写入权限的 `PAT_TOKEN`。不配置时，可使用阅读任务自身的固定计划或手动运行。

## 开发验证

使用 Node.js 20 或更高版本：

```sh
npm ci
npm test
```

测试使用本地 HTTP 站点和无头浏览器，不需要论坛账号。`npm start` 使用环境变量运行入口脚本；浏览器启动和计划执行由 Actions 工作流配置。回归测试工作流在提交和 Pull Request 时运行。
