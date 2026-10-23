import { isLoggedIn } from "./discourse_login.js";

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const navigationChanged = (error) => /execution context was destroyed|cannot find context|context.*not found|net::ERR_ABORTED/i.test(error.message);
const sessionClosed = (error) => /target closed|session closed|connection closed|frame.*detached|detached frame/i.test(error.message);

export function injectReader(source, user, enabled) {
  if (window.top !== window || window.__autoInjected) return;
  localStorage.setItem("read", "true");
  localStorage.setItem("specificUser", user);
  localStorage.setItem("autoLikeEnabled", String(enabled && localStorage.getItem("autoReadLikesPaused") !== "true"));
  eval(source);
}

export async function pauseLikes(page) {
  for (let attempt = 0; ; attempt++) {
    try {
      await page.evaluate(() => {
        localStorage.setItem("autoReadLikesPaused", "true");
        localStorage.setItem("autoLikeEnabled", "false");
      });
      return;
    } catch (error) {
      if (attempt >= 9 || !navigationChanged(error)) throw error;
      await sleep(200);
    }
  }
}

export async function verifyReader(page, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (page.isClosed()) throw new Error("Target closed during reading initialization");
    try {
      if (await isLoggedIn(page) && await page.evaluate(() => window.__autoInjected === true)) return;
    } catch (error) {
      if (!navigationChanged(error)) throw error;
    }
    await sleep(200);
  }
  throw new Error("阅读初始化超时：未确认登录状态或脚本注入");
}

export async function startReader(page, {
  source, user = "halowang", enabled = true, topicUrl, timeout = 60000,
  configurePage = async () => {}, onRecovery = () => {},
}) {
  const browser = page.browser();
  const context = page.browserContext();
  let current = page;
  for (let attempt = 0; attempt < 2; attempt++) {
    let session;
    try {
      if (!browser.connected) throw new Error("Browser connection closed");
      if (current.isClosed()) throw new Error("Target closed before reading initialization");
      await configurePage(current);
      // Puppeteer's evaluateOnNewDocument broadcasts to every OOPIF. A detached
      // ad/challenge iframe can reject that call even when the main page lives.
      // Register on the main target only and retain this session until close.
      session = await current.createCDPSession();
      await session.send("Page.enable");
      const preload = `(${injectReader.toString()})(${JSON.stringify(source)},${JSON.stringify(user)},${JSON.stringify(enabled)});`;
      await session.send("Page.addScriptToEvaluateOnNewDocument", { source: preload });
      await current.goto(topicUrl, { waitUntil: "domcontentloaded", timeout }).catch((error) => {
        if (!navigationChanged(error)) throw error;
      });
      await current.evaluate(injectReader, source, user, enabled).catch((error) => {
        if (!navigationChanged(error)) throw error;
      });
      await verifyReader(current, timeout);
      return { page: current, session };
    } catch (error) {
      await session?.detach().catch(() => {});
      if (attempt || !browser.connected || (!sessionClosed(error) && !navigationChanged(error))) throw error;
      onRecovery(error);
      // Keep the authenticated browser context and its cookies. A dead CDP
      // session can leave isClosed() false, so always obtain a fresh Page.
      const previous = current;
      current = await context.newPage();
      if (!previous.isClosed()) await previous.close().catch(() => {});
    }
  }
}
