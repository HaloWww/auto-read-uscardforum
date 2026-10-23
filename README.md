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
| `RUN_TIME_LIMIT_MINUTES` | `20`，readLike 全部账号的总运行时间，按批次分配 |
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

- **readLike**：每日自动阅读并随机点赞。
- **likeUser**：北京时间周六运行 20 分钟，阅读并给 `SPECIFIC_USER` 点赞。
- 手动运行时勾选 **login_only**：只检查全部账号能否登录，完成后关闭浏览器；不阅读、点赞或发送 Telegram 通知。
- 勾选 **verify_reading**：验证全部账号的登录、阅读脚本初始化及页面响应后退出，不点赞或发送通知。排查登录后失败时使用此模式；`login_only` 优先。

账号失败会在日志中标明序号并使本次运行失败，其他账号继续执行。

**Update Workflow Cron** 会将启动时间随机设在北京时间 07:00–23:59，需额外设置具有仓库内容和工作流写入权限的 `PAT_TOKEN`。不配置时，可使用阅读任务自身的固定计划或手动运行。

## 开发验证

使用 Node.js 20 或更高版本：

```sh
npm ci
npm test
```

测试使用本地 HTTP 站点和无头浏览器，不需要论坛账号。`npm start` 使用环境变量运行入口脚本；浏览器启动和计划执行由 Actions 工作流配置。回归测试工作流在提交和 Pull Request 时运行。
