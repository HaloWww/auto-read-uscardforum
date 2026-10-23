import { readFileSync } from "node:fs";
import { connect } from "puppeteer-real-browser";
import { parseAccounts, positiveInteger } from "./src/accounts.js";
import { loginDiscourse } from "./src/discourse_login.js";
import { runAccountBatches } from "./src/account_runner.js";
import { getProxyConfig, getPuppeteerProxyArgs } from "./src/proxy_config.js";
import { startReader, pauseLikes, verifyReader } from "./src/reader_session.js";

const accounts = parseAccounts(process.env.USERNAMES, process.env.PASSWORDS);
const runTimeMillis = positiveInteger(process.env.RUN_TIME_LIMIT_MINUTES, 20, "RUN_TIME_LIMIT_MINUTES") * 60000;
const maxConcurrentAccounts = positiveInteger(process.env.MAX_CONCURRENT_ACCOUNTS, 3, "MAX_CONCURRENT_ACCOUNTS");
const navigationTimeout = positiveInteger(process.env.NAV_TIMEOUT_MS, 60000, "NAV_TIMEOUT_MS");
const loginUrl = new URL(process.env.WEBSITE || "https://www.uscardforum.com").origin;
const loginOnly = process.env.LOGIN_ONLY === "true";
const verifyReading = !loginOnly && process.env.VERIFY_READING === "true";
const autoLike = !verifyReading && process.env.AUTO_LIKE !== "false";
const specificUser = process.env.SPECIFIC_USER || "halowang";
const scriptName = process.env.LIKE_SPECIFIC_USER === "true" ? "index_likeUser.js" : "index.js";
const script = loginOnly ? "" : readFileSync(new URL(scriptName, import.meta.url), "utf8");
const proxyConfig = getProxyConfig();
const activeBrowsers = new Set();
const runtimeErrors = new Map();
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

for (const event of ["unhandledRejection", "uncaughtException"]) {
  process.on(event, (error) => {
    process.exitCode = 1;
    console.error(`[${event}]`, error?.message || String(error));
  });
}

async function notify(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (loginOnly || verifyReading || !token || !chatId) return;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: message }),
        signal: AbortSignal.timeout(10000),
      });
      if (response.ok && (await response.json()).ok) return;
    } catch {
      // Do not log the request URL, since it contains the bot token.
    }
    if (attempt < 3) await sleep(1500 * attempt);
  }
  console.warn("Telegram 通知发送失败");
}

async function closeBrowser(browser) {
  if (!browser) return;
  activeBrowsers.delete(browser);
  let timer;
  try {
    await Promise.race([
      browser.close(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("关闭浏览器超时")), 10000);
      }),
    ]);
  } catch (error) {
    // real-browser terminates its Chrome process tree when disconnected.
    browser.disconnect();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function launchAccount({ username, password }, index) {
  const label = `账号 #${index + 1} (${username[0]}***)`;
  let browser;
  let page;
  try {
    console.log(`${label}：启动浏览器`);
    const options = {
      headless: "auto",
      connectOption: { protocolTimeout: navigationTimeout },
      args: ["--no-sandbox", "--disable-setuid-sandbox", ...getPuppeteerProxyArgs(proxyConfig)],
    };
    if (proxyConfig?.username && proxyConfig.password) {
      options.proxy = {
        host: proxyConfig.host, port: proxyConfig.port,
        username: proxyConfig.username, password: proxyConfig.password,
      };
    }
    const connection = await connect(options);
    browser = connection.browser;
    page = connection.page;
    activeBrowsers.add(browser);
    browser.on("disconnected", () => {
      if (activeBrowsers.has(browser)) runtimeErrors.set(browser, new Error("浏览器意外断开连接"));
    });
    const configurePage = async (targetPage) => {
      targetPage.on("error", (error) => runtimeErrors.set(browser, error));
      targetPage.on("pageerror", (error) => console.error(`${label} 页面错误：${error.message}`));
      targetPage.setDefaultNavigationTimeout(navigationTimeout);
      await targetPage.setExtraHTTPHeaders({ "accept-language": "en-US,en;q=0.9" });
    };
    await configurePage(page);
    await page.goto(loginUrl, { waitUntil: "domcontentloaded" });
    const challengeDeadline = Date.now() + 35000;
    while (/Just a moment|请稍候/.test(await page.title())) {
      if (Date.now() >= challengeDeadline) throw new Error("Cloudflare 验证超时");
      await sleep(2000);
    }
    await sleep(8000);
    await loginDiscourse(page, username, password, {
      timeout: navigationTimeout,
      onRetry: (attempt, error) => console.warn(`${label}：登录重试 ${attempt}/2：${error.message}`),
    });
    console.log(`${label}：已验证当前用户菜单，登录成功`);
    if (loginOnly) return browser;

    let rateLimited = false;
    const onResponse = (response) => {
      if (rateLimited || response.status() !== 429 || new URL(response.url()).origin !== loginUrl) return;
      rateLimited = true;
      console.warn(`${label}：网站返回 429，暂停自动点赞`);
      if (!page.isClosed()) void pauseLikes(page).catch((error) => console.warn(`${label}：暂停点赞失败：${error.message}`));
    };
    const topicPath = new URL(loginUrl).hostname === "www.uscardforum.com" ? "/t/topic/438315/1" : "/t/topic/1";
    const reader = await startReader(page, {
      source: script, user: specificUser, enabled: autoLike,
      topicUrl: new URL(topicPath, loginUrl).href, timeout: navigationTimeout,
      configurePage: async (targetPage) => {
        if (targetPage !== page) await configurePage(targetPage);
        page = targetPage;
        targetPage.on("response", onResponse);
      },
      onRecovery: (error) => console.warn(`${label}：阅读页面会话失效，保留登录状态恢复一次：${error.message}`),
    });
    page = reader.page;
    console.log(`${label}：阅读脚本初始化成功`);
    if (verifyReading) {
      await sleep(5000);
      // Re-evaluate after scripts and page navigation have had time to run.
      await verifyReader(page, navigationTimeout);
      console.log(`${label}：阅读页面响应验证通过`);
    }
    await notify(`${label} 登录成功`);
    return browser;
  } catch (error) {
    console.error(`${label} 失败：${error.message} (browserConnected=${browser?.connected ?? false}, pageClosed=${page?.isClosed() ?? true})`);
    await closeBrowser(browser).catch((closeError) => console.warn(`${label}：${closeError.message}`));
    await notify(`${label} 失败：${error.message}`);
    throw error;
  }
}

console.log(`运行 ${accounts.length} 个账号，并发 ${maxConcurrentAccounts}，总预算 ${runTimeMillis / 60000} 分钟`);
const watchdog = setTimeout(() => {
  console.error("运行预算及清理宽限期已耗尽");
  process.exit(1);
}, runTimeMillis + 120000);
try {
  const results = await runAccountBatches(accounts, {
    maxConcurrentAccounts, runTimeMillis, keepAlive: !loginOnly && !verifyReading,
    launch: launchAccount, close: closeBrowser,
    onBatch: ({ startIndex, endIndex }) => console.log(`当前批次：${startIndex + 1} - ${endIndex}`),
  });
  let failed = 0;
  for (const result of results) {
    const error = result.error || result.closeError || runtimeErrors.get(result.value);
    if (error) {
      failed++;
      console.error(`账号 #${result.index + 1} 失败：${error.message}`);
    }
  }
  console.log(`账号任务完成：${results.length - failed} 成功，${failed} 失败`);
  if (failed) process.exitCode = 1;
} catch (error) {
  console.error("账号任务失败：", error.message);
  process.exitCode = 1;
} finally {
  await Promise.allSettled([...activeBrowsers].map(closeBrowser));
  clearTimeout(watchdog);
}
