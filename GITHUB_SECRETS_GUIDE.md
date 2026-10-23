
# ============================= 环境变量文档 =============================
# 
# 在 GitHub 仓库的 Settings -> Secrets and variables -> Actions 中配置以下 secrets：
# 
# 【必需变量】
# USERNAMES        - 用户名列表，多个用逗号分隔 (例如: user1,user2,user3)
# PASSWORDS        - 密码列表，与用户名对应，多个用逗号分隔
# WEBSITE          - 目标网站 (例如: https://linux.do)
# 
# 【功能开关】(可选)
# AUTO_LIKE                  - 是否自动点赞 (true/false，默认: true)
# LIKE_SPECIFIC_USER         - 是否只点赞特定用户 (true/false，默认: false)
# ENABLE_RSS_FETCH           - 是否开启RSS抓取 (true/false，默认: false)
# ENABLE_TOPIC_DATA_FETCH    - 是否开启话题数据抓取 (true/false，默认: false)
# 
# 【运行配置】(可选)
# RUN_TIME_LIMIT_MINUTES - 运行时间限制(分钟) (默认: 20)
# MAX_CONCURRENT_ACCOUNTS - 同时运行的账号数量，必须为正整数 (默认: 3)
# SPECIFIC_USER          - 特定用户ID (默认: 14790897)
# HEALTH_PORT            - 健康检查端口 (默认: 7860)
# 
# 【Telegram通知】(可选)
# TELEGRAM_BOT_TOKEN - Telegram机器人令牌
# TELEGRAM_CHAT_ID   - Telegram聊天ID
# TELEGRAM_GROUP_ID  - Telegram群组ID
# 
# 【代理配置】(可选 - 两种方式任选其一)
# 方式1: 使用代理URL (推荐)
# PROXY_URL - 代理URL (例如: http://user:pass@proxy.com:8080 或 socks5://user:pass@proxy.com:1080)
# 
# 方式2: 分别配置各项
# PROXY_TYPE     - 代理类型 (http/socks5)
# PROXY_HOST     - 代理主机地址
# PROXY_PORT     - 代理端口
# PROXY_USERNAME - 代理用户名
# PROXY_PASSWORD - 代理密码
# 
# 【数据库配置】(可选)
# POSTGRES_URI       - PostgreSQL连接字符串 (主数据库)
# COCKROACH_URI      - CockroachDB连接字符串 (备用数据库)
# NEON_URI           - Neon数据库连接字符串 (备用数据库)
# AIVEN_MYSQL_URI    - Aiven MySQL连接字符串
# MONGO_URI          - MongoDB连接字符串
# 
# 【已废弃】
# HF_TOKEN - HuggingFace令牌 (已失效，无需设置)
# 
# 注意: GitHub.secrets优先级最高，即使没有设置对应的变量，它也会读取，这时变量为空值，
#       导致报错，.env读取的变量无法覆盖这个值
# ========================================================================

## 登录与运行故障排查

在 Actions 的 `readLike（自动阅读随机点赞）` 中点击 `Run workflow`，勾选
`login_only`，可以逐批验证全部账号。此模式登录后立即关闭浏览器，不运行阅读、
点赞、RSS 或 Telegram 通知。日志用 `账号 #1` 等序号对应 USERNAMES 中的位置。

只有页头的当前用户菜单出现、且未登录按钮消失才算登录成功。密码被网站拒绝时
不重复提交；导航超时可重试。账号失败不阻止其他账号验证，但整个 Action 会失败。
用户名周围的空白会去除，密码空白会原样保留；两份逗号列表必须一一对应且没有空项。

若登录成功之后才出现 `Network.enable timed out`，应检查页面运行和浏览器资源，
不能仅据此判断密码错误。阅读脚本每页只初始化一次，列表请求有超时、分页上限及
429 冷却；关闭浏览器也有超时清理。若仍在多账号并发时发生协议超时，可将
`MAX_CONCURRENT_ACCOUNTS` 设为 `2`，降低 runner 同时运行的浏览器数量。
