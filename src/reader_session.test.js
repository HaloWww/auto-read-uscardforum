import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import puppeteer from "puppeteer";
import { loginDiscourse, isLoggedIn } from "./discourse_login.js";
import { startReader, pauseLikes } from "./reader_session.js";

let chrome;
let browser;
let patchedPuppeteer;

before(async () => {
  const executablePath = [process.env.PUPPETEER_EXECUTABLE_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ].find((path) => path && existsSync(path)) || puppeteer.executablePath();
  chrome = await puppeteer.launch({
    executablePath, headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--site-per-process",
      "--no-proxy-server", "--host-resolver-rules=MAP reader-frame.test 127.0.0.1"],
  });
  const require = createRequire(import.meta.url);
  patchedPuppeteer = createRequire(require.resolve("puppeteer-real-browser"))("rebrowser-puppeteer-core");
  browser = await patchedPuppeteer.connect({ browserWSEndpoint: chrome.wsEndpoint(), defaultViewport: null });
});

after(async () => {
  await browser?.disconnect();
  await chrome?.close();
});

const source = `if (!window.__autoInjected) {
  window.__autoInjected = true;
  window.__autoReadStatus = { started: true, lastTickAt: Date.now(), phase: "reading", retryAt: 0 };
  window.__readerInstallCount = (window.__readerInstallCount || 0) + 1;
}`;
const authenticated = '<header class="d-header"><button id="current-user">Fixture account</button></header>';
const visitor = '<header class="d-header"><div class="auth-buttons">Log in</div></header>';

// A real HttpOnly session cookie is the only way a new tab can authenticate.
// Every test uses its own browser context and local server, so another test's
// session cannot hide a recovery that accidentally changes browser contexts.
async function forum(t, client = browser) {
  const state = { submissions: 0, loginRetries: 0, topicRequests: 0 };
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    const signedIn = /(?:^|;\s*)auth=fixture(?:;|$)/.test(request.headers.cookie || "");
    if (request.url === "/submit" && request.method === "POST") {
      for await (const _ of request) { /* drain the submitted form */ }
      state.submissions++;
      response.writeHead(303, {
        "Set-Cookie": "auth=fixture; Path=/; HttpOnly; SameSite=Lax",
        Location: "/signed-in",
      });
      response.end();
      return;
    }
    if (request.url === "/login") {
      response.end(`<!doctype html>${visitor}<form method="post" action="/submit">
        <input id="login-account-name" name="username">
        <input id="login-account-password" name="password" type="password">
        <button id="login-button" type="submit">Log in</button></form>`);
      return;
    }
    if (request.url?.startsWith("/topic")) state.topicRequests++;
    response.end(`<!doctype html>${signedIn ? authenticated : visitor}<main>Local reading fixture</main>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const context = await client.createBrowserContext();
  const page = await context.newPage();
  t.after(async () => {
    await context.close().catch(() => {});
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await loginDiscourse(page, "fixture-account", "fixture-password", {
    timeout: 3000, onRetry: () => state.loginRetries++,
  });
  assert.equal(await isLoggedIn(page), true);
  assert.equal(state.submissions, 1);
  return { page, context, origin, state, topicUrl: `${origin}/topic` };
}

async function assertReader(page, fixture) {
  assert.equal(page.browserContext(), fixture.context);
  assert.equal(await isLoggedIn(page), true, "recovery must retain the authenticated HttpOnly session");
  assert.equal(await page.evaluate(() => window.__readerInstallCount), 1);
  assert.equal(fixture.state.submissions, 1, "reading initialization must never resubmit credentials");
  assert.equal(fixture.state.loginRetries, 0);
}

test("reading initializes after real login and installs once on later documents", { timeout: 20000 }, async (t) => {
  const fixture = await forum(t);
  let recoveries = 0;
  const { page } = await startReader(fixture.page, {
    source, topicUrl: fixture.topicUrl, timeout: 3000, onRecovery: () => recoveries++,
  });
  await assertReader(page, fixture);
  await page.goto(`${fixture.topicUrl}/next`, { waitUntil: "domcontentloaded" });
  await assertReader(page, fixture);
  assert.equal(recoveries, 0);
});

test("a destroyed cross-site iframe does not break the main target's reader registration", { timeout: 20000 }, async (t) => {
  const fixture = await forum(t);
  const frameUrl = `http://reader-frame.test:${new URL(fixture.origin).port}/frame`;
  await fixture.page.evaluate((url) => {
    const frame = document.createElement("iframe");
    frame.id = "disposable-frame";
    frame.src = url;
    document.body.appendChild(frame);
  }, frameUrl);
  const iframe = await fixture.page.waitForFrame((frame) => frame.url() === frameUrl, { timeout: 3000 });
  const iframeSession = iframe._client();
  assert.notEqual(iframeSession.id(), fixture.page._client().id(), "fixture must create a real OOPIF");
  const detached = new Promise((resolve) => fixture.page.once("framedetached", resolve));
  let recoveries = 0;
  const { page } = await startReader(fixture.page, {
    source, topicUrl: fixture.topicUrl, timeout: 3000,
    onRecovery: () => recoveries++,
    configurePage: async (candidate) => {
      await candidate.evaluate(() => document.querySelector("#disposable-frame")?.remove());
      await detached;
    },
  });
  await assertReader(page, fixture);
  assert.equal(recoveries, 0, "a removed child frame must not force an account restart");
});

test("a closed login page recovers in the same authenticated browser context", { timeout: 20000 }, async (t) => {
  const fixture = await forum(t);
  await fixture.page.close();
  let recoveries = 0;
  const { page } = await startReader(fixture.page, {
    source, topicUrl: fixture.topicUrl, timeout: 3000, onRecovery: () => recoveries++,
  });
  assert.notEqual(page, fixture.page);
  await assertReader(page, fixture);
  await page.reload({ waitUntil: "domcontentloaded" });
  await assertReader(page, fixture);
  assert.equal(recoveries, 1);
});

test("a detached main CDP session recovers even when page.isClosed is false", { timeout: 20000 }, async (t) => {
  const fixture = await forum(t);
  const session = fixture.page._client();
  // Main frame sessions attach under a tab session. Calling session.detach()
  // sends to the wrong parent on current Chromium; detach through that parent.
  await session.parentSession().send("Target.detachFromTarget", { sessionId: session.id() });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(fixture.page.isClosed(), false);
  await assert.rejects(fixture.page.evaluateOnNewDocument(() => {}), /Session closed|Target closed/);
  let recoveries = 0;
  const { page } = await startReader(fixture.page, {
    source, topicUrl: fixture.topicUrl, timeout: 3000, onRecovery: () => recoveries++,
  });
  await assertReader(page, fixture);
  await page.reload({ waitUntil: "domcontentloaded" });
  await assertReader(page, fixture);
  assert.equal(recoveries, 1);
});

test("pausing likes survives navigation and reader injection ignores child frames", { timeout: 20000 }, async (t) => {
  const fixture = await forum(t);
  const { page } = await startReader(fixture.page, {
    source, enabled: true, topicUrl: fixture.topicUrl, timeout: 3000,
  });
  assert.equal(await page.evaluate(() => localStorage.getItem("autoLikeEnabled")), "true");
  await pauseLikes(page);
  await page.goto(`${fixture.topicUrl}/next`, { waitUntil: "domcontentloaded" });
  assert.deepEqual(await page.evaluate(() => ({
    paused: localStorage.getItem("autoReadLikesPaused"),
    enabled: localStorage.getItem("autoLikeEnabled"),
  })), { paused: "true", enabled: "false" });
  await page.evaluate(() => {
    const frame = document.createElement("iframe");
    frame.src = "/frame";
    document.body.appendChild(frame);
  });
  const child = await page.waitForFrame((frame) => frame.parentFrame() !== null && frame.url().endsWith("/frame"), { timeout: 3000 });
  assert.equal(await child.evaluate(() => window.__autoInjected), undefined);
  await assertReader(page, fixture);
});

test("ordinary configuration errors are reported without a recovery attempt", { timeout: 20000 }, async (t) => {
  const fixture = await forum(t);
  let recoveries = 0;
  await assert.rejects(startReader(fixture.page, {
    source, topicUrl: fixture.topicUrl, timeout: 3000,
    configurePage: async () => { throw new Error("fixture configuration rejected"); },
    onRecovery: () => recoveries++,
  }), /fixture configuration rejected/);
  assert.equal(recoveries, 0);
  assert.equal(fixture.state.submissions, 1);
  assert.equal(fixture.state.topicRequests, 0);
});

test("an injection marker alone cannot pass reading initialization", { timeout: 20000 }, async (t) => {
  const fixture = await forum(t);
  await assert.rejects(startReader(fixture.page, {
    source: "window.__autoInjected = true;", topicUrl: fixture.topicUrl, timeout: 400,
  }), /未确认登录状态或阅读循环启动/);
});

test("a failed reading loop cannot pass initialization with a fresh heartbeat", { timeout: 20000 }, async (t) => {
  const fixture = await forum(t);
  await assert.rejects(startReader(fixture.page, {
    source: `${source}; window.__autoReadStatus.error = 'fixture scroll failed';`,
    topicUrl: fixture.topicUrl, timeout: 3000,
  }), /阅读循环失败：fixture scroll failed/);
});

test("a disconnected browser fails explicitly instead of retrying account login", { timeout: 20000 }, async (t) => {
  const client = await patchedPuppeteer.connect({ browserWSEndpoint: chrome.wsEndpoint(), defaultViewport: null });
  const fixture = await forum(t, client);
  await client.disconnect();
  let recoveries = 0;
  await assert.rejects(startReader(fixture.page, {
    source, topicUrl: fixture.topicUrl, timeout: 3000,
    onRecovery: () => recoveries++,
  }), /disconnected|closed|connection|session/i);
  assert.equal(recoveries, 0);
  assert.equal(fixture.state.submissions, 1);
});
