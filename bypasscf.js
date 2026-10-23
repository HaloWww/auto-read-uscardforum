import fs from "fs";
import { parseAccounts, positiveInteger } from "./src/accounts.js";
import { loginDiscourse } from "./src/discourse_login.js";
import { runAccountBatches } from "./src/account_runner.js";
import path from "path";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import TelegramBot from "node-telegram-bot-api";
import fetch from "node-fetch";
import { parseStringPromise } from "xml2js";
import { parseRss } from "./src/parse_rss.js";
import { processAndSaveTopicData } from "./src/topic_data.js";
import { closeAllConnections } from "./src/db.js";
import {
  getProxyConfig,
  getPuppeteerProxyArgs,
  testProxyConnection,
  getCurrentIP,
} from "./src/proxy_config.js";

dotenv.config();

// Keep diagnostics while ensuring a runtime failure cannot turn Actions green.
process.on("unhandledRejection", (reason) => {
  process.exitCode = 1;
  try {
    const msg = (reason && reason.message) ? reason.message : String(reason);
    console.warn("[unhandledRejection]", msg);
  } catch {
    console.warn("[unhandledRejection] (non-string reason)");
  }
});
process.on("uncaughtException", (err) => {
  process.exitCode = 1;
  try {
    const msg = (err && err.message) ? err.message : String(err);
    console.warn("[uncaughtException]", msg);
  } catch {
    console.warn("[uncaughtException] (non-string error)");
  }
});

// 截图保存的文件夹
// const screenshotDir = "screenshots";
// if (!fs.existsSync(screenshotDir)) {
//   fs.mkdirSync(screenshotDir);
// }
puppeteer.use(StealthPlugin());

// Load the default .env file
if (fs.existsSync(".env.local")) {
  console.log("Using .env.local file to supply config environment variables");
  const envConfig = dotenv.parse(fs.readFileSync(".env.local"));
  for (const k in envConfig) {
    process.env[k] = envConfig[k];
  }
} else {
  console.log(
    "Using .env file to supply config environment variables, you can create a .env.local file to overwrite defaults, it doesn't upload to git"
  );
}

// 读取以分钟为单位的运行时间限制
const runTimeLimitMinutes = positiveInteger(process.env.RUN_TIME_LIMIT_MINUTES, 20, "RUN_TIME_LIMIT_MINUTES");

// 将分钟转换为毫秒
const runTimeLimitMillis = runTimeLimitMinutes * 60 * 1000;

console.log(
  `运行时间限制为：${runTimeLimitMinutes} 分钟 (${runTimeLimitMillis} 毫秒)`
);

const loginOnly = process.env.LOGIN_ONLY === "true";
const token = loginOnly ? undefined : process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const groupId = process.env.TELEGRAM_GROUP_ID;
const specificUser = process.env.SPECIFIC_USER || "halowang";
const accounts = parseAccounts(process.env.USERNAMES, process.env.PASSWORDS);
const maxConcurrentAccounts = positiveInteger(process.env.MAX_CONCURRENT_ACCOUNTS, 3, "MAX_CONCURRENT_ACCOUNTS");
const loginUrl = (process.env.WEBSITE || "https://linux.do").replace(/\/+$/, "");
const navigationTimeout = positiveInteger(process.env.NAV_TIMEOUT_MS || process.env.NAV_TIMEOUT, 60000, "NAV_TIMEOUT_MS");
const activeBrowsers = new Set();
const runtimeErrors = new Map();
let failedAccounts = 0;
let shutdownTimer;

async function closeBrowser(browser) {
  if (!browser) return;
  activeBrowsers.delete(browser);
  let timer;
  try {
    await Promise.race([
      browser.close(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("关闭浏览器超时，断开连接以清理进程")), 10000);
      }),
    ]);
  } catch (error) {
    // puppeteer-real-browser's disconnected handler terminates its own Chrome
    // process tree. This also works when a renderer no longer answers CDP.
    browser.disconnect();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function runAccounts() {
  try {
    const results = await runAccountBatches(accounts, {
      maxConcurrentAccounts,
      runTimeMillis: runTimeLimitMillis,
      keepAlive: !loginOnly,
      launch: (account, index) => launchBrowserForUser(account.username, account.password, index),
      close: ({ browser }) => closeBrowser(browser),
      onBatch: ({ startIndex, endIndex }) =>
        console.log(`当前批次：${startIndex + 1} - ${endIndex}`),
    });
    for (const result of results) {
      const runtimeError = runtimeErrors.get(result.value?.browser);
      if (!result.success || result.closeError || runtimeError) {
        failedAccounts++;
        console.error(`账号 #${result.index + 1} 失败：${(result.error || result.closeError || runtimeError).message}`);
      }
    }
    console.log(`账号任务完成：${results.length - failedAccounts} 成功，${failedAccounts} 失败`);
    if (failedAccounts) process.exitCode = 1;
  } catch (error) {
    console.error("账号任务失败：", error.message);
    process.exitCode = 1;
  } finally {
    await Promise.allSettled([...activeBrowsers].map(closeBrowser));
    if (enableTopicDataFetch && !loginOnly) await closeAllConnections();
    healthServer.close();
    clearTimeout(shutdownTimer);
  }
}
const isLikeSpecificUser = process.env.LIKE_SPECIFIC_USER === "true"; // 只有明确设置为"true"才开启
console.log("ENV LIKE_SPECIFIC_USER=", process.env.LIKE_SPECIFIC_USER, "=> boolean", isLikeSpecificUser);
const isAutoLike = process.env.AUTO_LIKE !== "false"; // 默认开启，只有明确设置为"false"才关闭
const enableRssFetch = process.env.ENABLE_RSS_FETCH === "true"; // 是否开启抓取RSS，只有明确设置为"true"才开启，默认为false
const enableTopicDataFetch = process.env.ENABLE_TOPIC_DATA_FETCH === "true"; // 是否开启抓取话题数据，只有明确设置为"true"才开启，默认为false

console.log(
  `RSS抓取功能状态: ${enableRssFetch ? "开启" : "关闭"} (环境变量值: "${process.env.ENABLE_RSS_FETCH || ''}")，勿设置`
);
console.log(
  `话题数据抓取功能状态: ${
    enableTopicDataFetch ? "开启" : "关闭"
  } (环境变量值: "${process.env.ENABLE_TOPIC_DATA_FETCH || ''}")，勿设置`
);

// 代理配置
const proxyConfig = getProxyConfig();
if (proxyConfig) {
  console.log(
    `代理配置: ${proxyConfig.type}://${proxyConfig.host}:${proxyConfig.port}`
  );

  // 测试代理连接
  console.log("正在测试代理连接...");
  const proxyWorking = await testProxyConnection(proxyConfig);
  if (proxyWorking) {
    console.log("✅ 代理连接测试成功");
  } else {
    console.log("❌ 代理连接测试失败，将使用直连");
  }
} else {
  console.log("未配置代理，使用直连");
  const currentIP = await getCurrentIP();
  if (currentIP) {
    console.log(`当前IP地址: ${currentIP}`);
  }
}

let bot;
if (token && (chatId || groupId)) {
  bot = new TelegramBot(token);
}
// 简单的 Telegram 发送重试
async function tgSendWithRetry(id, message, maxRetries = 3) {
  let lastErr;
  for (let i = 0; i < maxRetries; i++) {
    try {
      await bot.sendMessage(id, message);
      return true;
    } catch (e) {
      lastErr = e;
      const delay = 1500 * (i + 1);
      console.error(
        `Telegram send failed (attempt ${i + 1}/${maxRetries}): ${
          e && e.message ? e.message : e
        }`
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
async function sendToTelegram(message) {
  if (!bot || !chatId) return;
  try {
    await tgSendWithRetry(chatId, message, 3);
    console.log("Telegram message sent successfully");
  } catch (error) {
    console.error(
      "Error sending Telegram message:",
      error && error.code ? error.code : "",
      error && error.message
        ? error.message.slice(0, 100)
        : String(error).slice(0, 100)
    );
  }
}
async function sendToTelegramGroup(message) {
  if (!bot || !groupId) {
    console.error("sendToTelegramGroup: bot 或 groupId 不存在");
    return;
  }
  // 过滤空内容，避免 Telegram 400 错误
  if (!message || !String(message).trim()) {
    console.warn("Telegram 群组推送内容为空，跳过发送");
    return;
  }
  // 分割长消息，Telegram单条最大4096字符
  const MAX_LEN = 4000;
  if (typeof message === "string" && message.length > MAX_LEN) {
    let start = 0;
    let part = 1;
    while (start < message.length) {
      const chunk = message.slice(start, start + MAX_LEN);
      try {
        await tgSendWithRetry(groupId, chunk, 3);
        console.log(`Telegram group message part ${part} sent successfully`);
      } catch (error) {
        console.error(
          `Error sending Telegram group message part ${part}:`,
          error
        );
      }
      start += MAX_LEN;
      part++;
    }
  } else {
    try {
      await tgSendWithRetry(groupId, message, 3);
      console.log("Telegram group message sent successfully");
    } catch (error) {
      console.error("Error sending Telegram group message:", error);
    }
  }
}

//随机等待时间
function delayClick(time) {
  return new Promise(function (resolve) {
    setTimeout(resolve, time);
  });
}

async function launchBrowserForUser(username, password, accountIndex) {
  const label = `账号 #${accountIndex + 1} (${username[0]}***)`;
  let browser = null; // 在 try 之外声明 browser 变量
  try {
    console.log(`${label}：启动浏览器`);
    const browserOptions = {
      headless: "auto",
      connectOption: { protocolTimeout: navigationTimeout },
      args: ["--no-sandbox", "--disable-setuid-sandbox"], // Linux 需要的安全设置
    };

    // 添加代理配置到浏览器选项
    const proxyConfig = getProxyConfig();
    if (proxyConfig) {
      const proxyArgs = getPuppeteerProxyArgs(proxyConfig);
      browserOptions.args.push(...proxyArgs);
      console.log(
        `为用户 ${username[0] + "***"} 启用代理: ${proxyConfig.type}://${proxyConfig.host}:${proxyConfig.port}`
      );

      // 如果有用户名密码，puppeteer-real-browser会自动处理
      if (proxyConfig.username && proxyConfig.password) {
        browserOptions.proxy = {
          host: proxyConfig.host,
          port: proxyConfig.port,
          username: proxyConfig.username,
          password: proxyConfig.password,
        };
      }
    }

    var { connect } = await import("puppeteer-real-browser");
    const { page, browser: newBrowser } = await connect(browserOptions);
    browser = newBrowser;
    activeBrowsers.add(browser);
    browser.on("disconnected", () => {
      if (activeBrowsers.has(browser)) runtimeErrors.set(browser, new Error("浏览器意外断开连接"));
    });
    page.on("error", (error) => {
      runtimeErrors.set(browser, error);
      console.error(`${label} 浏览器错误：${error.message}`);
    });
    // 设置浏览器窗口/视口大小（宽度x高度，单位：像素）
    // 可选分辨率：1920x1080（Full HD）、1366x768（笔记本）、1440x900（MacBook）
    // await page.setViewport({
    //   width: 1080,
    //   height: 1920
    // });
    // 启动截图功能
    // takeScreenshots(page);
    //登录操作
    await navigatePage(loginUrl, page);
    await delayClick(8000);
    // 设置额外的 headers
    await page.setExtraHTTPHeaders({
      "accept-language": "en-US,en;q=0.9",
    });
    // 验证 `navigator.webdriver` 属性是否为 undefined
    // const isWebDriverUndefined = await page.evaluate(() => {
    //   return `${navigator.webdriver}`;
    // });

    // console.log("navigator.webdriver is :", isWebDriverUndefined); // 输出应为 false
    page.on("pageerror", (error) => {
      console.error(`${label} 页面错误：${error.message}`);
    });
    // Observe real HTTP responses, not console strings. A rate limit stops
    // likes in the existing document and each later document; do this once.
    let rateLimited = false;
    page.on("response", (response) => {
      if (rateLimited || response.status() !== 429 ||
          new URL(response.url()).origin !== new URL(loginUrl).origin) return;
      rateLimited = true;
      console.warn(`${label}：网站返回 429，暂停自动点赞`);
      const disableLikes = () => localStorage.setItem("autoLikeEnabled", "false");
      void (async () => {
        await page.evaluateOnNewDocument(disableLikes);
        if (!page.isClosed()) await page.evaluate(disableLikes);
      })().catch((error) => console.warn(`${label}：暂停点赞失败：${error.message}`));
    });
    console.log(`${label}：登录操作`);
    await loginDiscourse(page, username, password, {
      timeout: navigationTimeout,
      onRetry: (attempt, error) =>
        console.warn(`${label}：登录暂时失败，重试 ${attempt}/2：${error.message}`),
    });
    console.log(`${label}：已验证当前用户菜单，登录成功`);
    if (loginOnly) return { browser };

    //真正执行阅读脚本
    let externalScriptPath;
    if (isLikeSpecificUser) {
      const randomChoice = Math.random() < 0.5; // 生成一个随机数，50% 概率为 true
      if (randomChoice) {
        externalScriptPath = path.join(
          dirname(fileURLToPath(import.meta.url)),
          "index_likeUser.js"
        );
        console.log("使用index_likeUser_activity");
      } else {
        externalScriptPath = path.join(
          dirname(fileURLToPath(import.meta.url)),
          "index_likeUser.js"
        );
        console.log("使用index_likeUser");
      }
    } else {
      externalScriptPath = path.join(
        dirname(fileURLToPath(import.meta.url)),
        "index.js"
      );
    }
    const externalScript = fs.readFileSync(externalScriptPath, "utf8");

    // 在每个新的文档加载时执行外部脚本
    await page.evaluateOnNewDocument(
      (...args) => {
        const [specificUser, scriptToEval, isAutoLike] = args;
        if (window.__autoInjected) return;
        localStorage.setItem("read", true);
        localStorage.setItem("specificUser", specificUser);
        localStorage.setItem("isFirstRun", "false");
        localStorage.setItem("autoLikeEnabled", isAutoLike);
        console.log("当前点赞用户：", specificUser);
        eval(scriptToEval);
      },
      specificUser,
      externalScript,
      isAutoLike && !rateLimited
    ); //变量必须从外部显示的传入, 因为在浏览器上下文它是读取不了的
    // 添加一个监听器来监听每次页面加载完成的事件
    page.on("load", async () => {
      // await page.evaluate(externalScript); //因为这个是在页面加载好之后执行的,而脚本是在页面加载好时刻来判断是否要执行，由于已经加载好了，脚本就不会起作用
    });
    // 如果是Linuxdo，就导航到我的帖子，但我感觉这里写没什么用，因为外部脚本已经定义好了，不对，这里不会点击按钮，所以不会跳转，需要手动跳转
    if (loginUrl == "https://linux.do") {
      await page.goto("https://linux.do/t/topic/13716/790", {
        waitUntil: "domcontentloaded",
        timeout: navigationTimeout,
      });
    } else if (loginUrl == "https://meta.appinn.net") {
      await page.goto("https://meta.appinn.net/t/topic/52006", {
        waitUntil: "domcontentloaded",
        timeout: navigationTimeout,
      });
    } else if (loginUrl == "https://www.uscardforum.com") {
      await page.goto("https://www.uscardforum.com/t/topic/438315/1", {
        waitUntil: "domcontentloaded",
        timeout: navigationTimeout,
      });
    } else {
      await page.goto(`${loginUrl}/t/topic/1`, {
        waitUntil: "domcontentloaded",
        timeout: navigationTimeout,
      });
    }
    // Ensure automation injected after navigation (fallback in case init-script failed)
    try {
      await page.evaluate(
        (specificUser, scriptToEval, isAutoLike) => {
          if (!window.__autoInjected) {
            localStorage.setItem("read", true);
            localStorage.setItem("specificUser", specificUser);
            localStorage.setItem("isFirstRun", "false");
            localStorage.setItem("autoLikeEnabled", isAutoLike);
            try { eval(scriptToEval); } catch (e) { console.error("eval external script failed", e); }
          }
        },
        specificUser,
        externalScript,
        isAutoLike && !rateLimited
      );
    } catch (e) {
      console.warn(`Post-navigation inject failed: ${e && e.message ? e.message : e}`);
    }
    if (token && chatId) {
      await sendToTelegram(`${username} 登录成功`);
    } // 监听页面跳转到新话题，自动推送RSS example：https://linux.do/t/topic/525305.rss
    // 记录已推送过的 topicId，防止重复推送
    if (enableRssFetch || enableTopicDataFetch) {
      const pushedTopicIds = new Set();
      const processedTopicIds = new Set(); // 用于话题数据处理的记录
      page.on("framenavigated", async (frame) => {
        if (frame.parentFrame() !== null) return;
        const url = frame.url();
        const match = url.match(/https:\/\/linux\.do\/t\/topic\/(\d+)/);
        if (match) {
          const topicId = match[1];

          // RSS抓取处理
          if (enableRssFetch && !pushedTopicIds.has(topicId)) {
            pushedTopicIds.add(topicId);
            const rssUrl = `https://linux.do/t/topic/${topicId}.rss`;
            console.log("检测到话题跳转，抓取RSS：", rssUrl);
            try {
              // 停顿1.5秒再抓取
              await new Promise((r) => setTimeout(r, 1500));
              const rssPage = await browser.newPage();
              await rssPage.goto(rssUrl, {
                waitUntil: "domcontentloaded",
                timeout: 20000,
              });
              // 停顿0.5秒再获取内容，确保页面渲染完成
              await new Promise((r) => setTimeout(r, 1000));
              const xml = await rssPage.evaluate(() => document.body.innerText);
              await rssPage.close();
              const parsedData = await parseRss(xml);
              sendToTelegramGroup(parsedData);
            } catch (e) {
              console.error("抓取或发送RSS失败：", e, "可能是非公开话题");
            }
          }

          // 话题数据抓取处理
          if (enableTopicDataFetch && !processedTopicIds.has(topicId)) {
            processedTopicIds.add(topicId);
            console.log("检测到话题跳转，抓取话题数据：", url);
            try {
              // 停顿1秒再处理话题数据
              await new Promise((r) => setTimeout(r, 1000));
              await processAndSaveTopicData(page, url);
            } catch (e) {
              console.error("抓取或保存话题数据失败：", e);
            }
          }
        }
        // 停顿0.5秒后允许下次抓取
        await new Promise((r) => setTimeout(r, 500));
      });
    }
    return { browser };
  } catch (err) {
    console.error(`${label} 失败：${err.message}`);
    await closeBrowser(browser).catch((error) => console.warn(`${label} 关闭失败：${error.message}`));
    if (token && chatId) await sendToTelegram(`${label} 失败：${err.message}`);
    throw err;
  }
}

async function navigatePage(url, page) {
  page.setDefaultNavigationTimeout(navigationTimeout);
  await page.goto(url, { waitUntil: "domcontentloaded" }); //如果使用默认的load,linux下页面会一直加载导致无法继续执行

  const startTime = Date.now(); // 记录开始时间
  let pageTitle = await page.title(); // 获取当前页面标题

  while (pageTitle.includes("Just a moment") || pageTitle.includes("请稍候")) {
    console.log("The page is under Cloudflare protection. Waiting...");

    await delayClick(2000); // 每次检查间隔2秒

    // 重新获取页面标题
    pageTitle = await page.title();

    // 检查是否超过15秒
    if (Date.now() - startTime > 35000) {
      console.log("Timeout exceeded, aborting actions.");
      sendToTelegram(`超时了,无法通过Cloudflare验证`);
      throw new Error("Cloudflare 验证超时");
    }
  }
  console.log("页面标题：", pageTitle);
}

// 每秒截图功能
async function takeScreenshots(page) {
  let screenshotIndex = 0;
  setInterval(async () => {
    screenshotIndex++;
    const screenshotPath = path.join(
      screenshotDir,
      `screenshot-${screenshotIndex}.png`
    );
    try {
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.log(`Screenshot saved: ${screenshotPath}`);
    } catch (error) {
      console.error("Error taking screenshot:", error);
    }
  }, 1000);
  // 注册退出时删除文件夹的回调函数
  process.on("exit", () => {
    try {
      fs.rmdirSync(screenshotDir, { recursive: true });
      console.log(`Deleted folder: ${screenshotDir}`);
    } catch (error) {
      console.error(`Error deleting folder ${screenshotDir}:`, error);
    }
  });
}
import express from "express";

const healthApp = express();
const HEALTH_PORT = process.env.HEALTH_PORT || 7860;

// 健康探针路由
healthApp.get("/health", (req, res) => {
  const memoryUsage = process.memoryUsage();

  // 将字节转换为MB
  const memoryUsageMB = {
    rss: `${(memoryUsage.rss / (1024 * 1024)).toFixed(2)} MB`, // 转换为MB并保留两位小数
    heapTotal: `${(memoryUsage.heapTotal / (1024 * 1024)).toFixed(2)} MB`,
    heapUsed: `${(memoryUsage.heapUsed / (1024 * 1024)).toFixed(2)} MB`,
    external: `${(memoryUsage.external / (1024 * 1024)).toFixed(2)} MB`,
    arrayBuffers: `${(memoryUsage.arrayBuffers / (1024 * 1024)).toFixed(2)} MB`,
  };

  const healthData = {
    status: "OK",
    timestamp: new Date().toISOString(),
    memoryUsage: memoryUsageMB,
    uptime: process.uptime().toFixed(2), // 保留两位小数
  };

  res.status(200).json(healthData);
});
healthApp.get("/", (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Auto Read</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            background-color: #f4f4f4;
            color: #333;
            margin: 0;
            padding: 20px;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
          }
          .container {
            background-color: #fff;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 0 15px rgba(0, 0, 0, 0.1);
            max-width: 600px;
            text-align: center;
          }
          h1 {
            color: #007bff;
          }
          p {
            font-size: 18px;
            margin: 15px 0;
          }
          a {
            color: #007bff;
            text-decoration: none;
            font-weight: bold;
          }
          a:hover {
            text-decoration: underline;
          }
          footer {
            margin-top: 20px;
            font-size: 14px;
            color: #555;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>Welcome to the Auto Read App</h1>
          <p>You can check the server's health at <a href="/health">/health</a>.</p>
          <p>GitHub: <a href="https://github.com/14790897/auto-read-liunxdo" target="_blank">https://github.com/14790897/auto-read-liunxdo</a></p>
          <footer>&copy; 2024 Auto Read App</footer>
        </div>
      </body>
    </html>
  `);
});
const healthServer = healthApp.listen(HEALTH_PORT, () => {
  console.log(
    `Health check endpoint is running at http://localhost:${HEALTH_PORT}/health`
  );
});

// Leave time for batch cleanup before the Actions job timeout. Expiring this
// watchdog means work did not finish, so never report a successful run.
shutdownTimer = setTimeout(() => {
  console.error("运行时间预算及清理宽限期已耗尽");
  process.exit(1);
}, runTimeLimitMillis + 120000);
await runAccounts();
