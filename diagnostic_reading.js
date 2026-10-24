import { readFileSync } from "node:fs";
import { connect } from "puppeteer-real-browser";
import { parseAccounts } from "./src/accounts.js";
import { loginDiscourse } from "./src/discourse_login.js";
import { startReader } from "./src/reader_session.js";
import { getProxyConfig, getPuppeteerProxyArgs } from "./src/proxy_config.js";
import { createReadingEvidence } from "./src/reading_evidence.js";

const [account] = parseAccounts(process.env.USERNAMES, process.env.PASSWORDS);
const origin = new URL(process.env.WEBSITE || "https://www.uscardforum.com").origin;
const source = readFileSync(new URL("./index.js", import.meta.url), "utf8");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const proxy = getProxyConfig();
let browser;
let evidence;
const watchdog = setTimeout(() => { console.error("单账号诊断超过 6 分钟"); process.exit(1); }, 360000);

async function state(page) {
  return page.evaluate(() => ({
    path: window.location.pathname,
    ready: document.readyState,
    visibility: document.visibilityState,
    focused: document.hasFocus(),
    y: window.scrollY,
    viewportHeight: window.innerHeight,
    bodyHeight: document.body?.scrollHeight,
    documentHeight: document.documentElement?.scrollHeight,
    scrollingElement: document.scrollingElement?.tagName,
    articles: document.querySelectorAll("article, .topic-post").length,
    read: localStorage.getItem("read"),
    reader: window.__autoReadStatus,
  }));
}

try {
  console.log("诊断范围：仅第 1 个账号，实际阅读 3 分钟，关闭点赞；比较服务端阅读时间与自然阅读计时响应。");
  const options = {
    headless: "auto", connectOption: { protocolTimeout: 60000 },
    args: ["--no-sandbox", "--disable-setuid-sandbox", ...getPuppeteerProxyArgs(proxy)],
  };
  if (proxy?.username && proxy.password) options.proxy = proxy;
  const connection = await connect(options);
  browser = connection.browser;
  let page = connection.page;
  page.setDefaultNavigationTimeout(60000);
  await page.setExtraHTTPHeaders({ "accept-language": "en-US,en;q=0.9" });
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await sleep(8000);
  await loginDiscourse(page, account.username, account.password);
  console.log("单账号登录验证成功");
  evidence = createReadingEvidence(page, account.username);
  const before = await evidence.snapshot();
  console.log(`服务端阅读数据（运行前）：${JSON.stringify(before)}`);
  const reader = await startReader(page, {
    source, enabled: false,
    topicUrl: `${origin}/t/topic/438315/1`,
    configurePage: async (candidate) => {
      if (candidate !== page) throw new Error("诊断页已失效，需要重新取得完整的前后数据");
    },
  });
  page = reader.page;
  const deadline = Date.now() + 180000;
  console.log(`阅读开始：${new Date().toISOString()}`);
  console.log(`页面状态：${JSON.stringify(await state(page))}`);
  while (Date.now() < deadline) {
    await sleep(Math.min(15000, deadline - Date.now()));
    try {
      console.log(`页面状态：${JSON.stringify(await state(page))}`);
      console.log(`自然阅读计时响应：${JSON.stringify(evidence.summary())}`);
    } catch (error) {
      if (!/context|ERR_ABORTED/i.test(error.message)) throw error;
      console.log("正在换帖，下一次采样继续检查");
    }
  }
  await page.evaluate(() => localStorage.setItem("read", "false"));
  const after = await evidence.snapshot();
  const delta = {};
  for (const [key, value] of Object.entries(after.stats || {})) {
    if (typeof value === "number" && typeof before.stats?.[key] === "number") delta[key] = value - before.stats[key];
  }
  console.log(`服务端阅读数据（运行后）：${JSON.stringify(after)}`);
  console.log(`服务端阅读增量：${JSON.stringify(delta)}`);
  console.log(`自然阅读计时最终统计：${JSON.stringify(evidence.summary())}`);
  if (before.cached || after.cached || !(delta.time_read > 0) || evidence.summary().accepted < 1) {
    throw new Error("尚未证明真实阅读成功：需要服务端 time_read 增加且观察到自然阅读计时 POST 成功");
  }
  console.log("真实阅读验证通过：服务端阅读时间确实增加，且站点自然提交了阅读计时。");
} catch (error) {
  console.error(`单账号阅读诊断失败：${error.message}`);
  process.exitCode = 1;
} finally {
  evidence?.stop();
  await browser?.close().catch(() => browser.disconnect());
  clearTimeout(watchdog);
}
