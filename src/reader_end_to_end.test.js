import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import puppeteer from "puppeteer";
import { startReader } from "./reader_session.js";

let chrome;
let browser;
const sources = Object.fromEntries(["index.js", "index_likeUser.js"].map((name) => [
  name, readFileSync(new URL(`../${name}`, import.meta.url), "utf8"),
]));

before(async () => {
  const executablePath = [process.env.PUPPETEER_EXECUTABLE_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ].find((path) => path && existsSync(path)) || puppeteer.executablePath();
  chrome = await puppeteer.launch({
    executablePath, headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--no-proxy-server"],
  });
  const require = createRequire(import.meta.url);
  const patched = createRequire(require.resolve("puppeteer-real-browser"))("rebrowser-puppeteer-core");
  browser = await patched.connect({ browserWSEndpoint: chrome.wsEndpoint(), defaultViewport: null });
});

after(async () => {
  await browser?.disconnect();
  await chrome?.close();
});

async function until(predicate, message, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(message);
}

async function readingState(page) {
  let result;
  await until(async () => {
    try {
      result = await page.evaluate(() => window.__autoReadStatus?.started ? {
        count: localStorage.getItem("clickCounter"), read: localStorage.getItem("read"),
      } : null);
      return result !== null;
    } catch { return false; } // A server-observed GET can precede document commit.
  }, "the latest topic never started its reader loop", 3000);
  return result;
}

// This is a local Discourse-shaped site, not a mock of the reader. Actual DOM
// scrolling, page navigations, pagination, and dispatched reaction clicks are
// observed by the server while the unmodified production scripts run in Chrome.
async function forum(t, {
  script = "index.js", enabled = false, initialLikes = 0,
  blockLoad = false, reactionDelay = 0, contentHeight = 950, expandAfter = 0,
} = {}) {
  const state = { topics: [], scrolls: [], reactions: [], expansions: [], latestPages: [], searchPages: [], heldImages: 0 };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://fixture");
    if (["/scroll", "/reaction", "/expanded"].includes(url.pathname)) {
      for await (const _ of request) { /* drain sendBeacon body */ }
      (url.pathname === "/scroll" ? state.scrolls : url.pathname === "/reaction" ? state.reactions : state.expansions).push({
        topic: Number(url.searchParams.get("topic")), y: Number(url.searchParams.get("y")),
      });
      response.writeHead(204).end();
      return;
    }
    if (url.pathname === "/never-load") {
      state.heldImages++;
      // Deliberately leave the image pending, as an ad/tracker request can do.
      return;
    }
    if (url.pathname === "/latest.json" || url.pathname === "/search") {
      const page = Number(url.searchParams.get("page"));
      response.setHeader("Content-Type", "application/json");
      if (url.pathname === "/latest.json") {
        state.latestPages.push(page);
        response.end(JSON.stringify({ topic_list: { topics: page === 0 ? [
          { id: 2, posts_count: 5, last_read_post_number: 1 },
          { id: 3, posts_count: 5, last_read_post_number: 1 },
        ] : [] } }));
      } else {
        state.searchPages.push(page);
        response.end(JSON.stringify({ posts: page === 1 ? [
          { topic_id: 2, post_number: 1 }, { topic_id: 3, post_number: 1 },
        ] : [] }));
      }
      return;
    }
    const topic = Number(url.pathname.match(/^\/t\/topic\/(\d+)/)?.[1] || 0);
    if (topic) state.topics.push(topic);
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<!doctype html><html><head><style>
      body { margin: 0; } main { min-height: ${contentHeight}px; }
      article { height: 100px; } button { min-height: 32px; }
      </style></head><body>
      <header class="d-header"><button id="current-user">Fixture account</button></header>
      <main data-topic="${topic}"><article id="post_1" data-post-number="1"><button aria-label="Post #1">#1</button></article></main>
      ${blockLoad && topic ? '<img src="/never-load" alt="Pending fixture image">' : ""}
      <script>
        window.addEventListener('scroll', () => navigator.sendBeacon('/scroll?topic=${topic}&y=' + window.scrollY));
        document.addEventListener('click', event => {
          if (!event.target.matches('.discourse-reactions-reaction-button')) return;
          event.target.title = 'You liked this post';
          navigator.sendBeacon('/reaction?topic=${topic}');
        });
        const renderReaction = () => document.querySelector('#post_1').insertAdjacentHTML('beforeend',
          '<button class="discourse-reactions-reaction-button" title="Like this post">Like</button>');
        ${reactionDelay ? `setTimeout(renderReaction, ${reactionDelay});` : "renderReaction();"}
        ${expandAfter ? `setTimeout(() => {
          document.querySelector('main').style.minHeight = '2000px';
          navigator.sendBeacon('/expanded?topic=${topic}');
        }, ${expandAfter});` : ""}
      </script></body></html>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  t.after(async () => {
    await context.close().catch(() => {});
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.setViewport({ width: 1000, height: 600 });
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.evaluate((count) => {
    localStorage.setItem("clickCounter", String(count));
    localStorage.setItem("clickCounterTimestamp", String(Date.now()));
  }, initialLikes);
  // Make the probabilistic like branch deterministic without changing a line
  // of production reader code, and retain normal browser timing and DOM events.
  await page.evaluateOnNewDocument(() => { Math.random = () => 0; });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const result = await startReader(page, {
    source: sources[script], user: "fixture-target", enabled,
    topicUrl: `${origin}/t/topic/1/1`, timeout: 5000,
  });
  return { ...result, state, errors };
}

test("real readLike continues scrolling and opens multiple topics after reaching its like limit", { timeout: 25000 }, async (t) => {
  const { page, state, errors } = await forum(t, { enabled: true, initialLikes: 8 });
  await until(() => new Set(state.topics).size >= 3,
    "readLike did not navigate through two new topics", 18000);
  assert.ok(state.scrolls.filter((event) => event.y > 0).length >= 2);
  assert.equal(state.reactions.length, 1, "the ninth like must prevent further likes");
  assert.deepEqual(await readingState(page), { count: "9", read: "true" });
  assert.deepEqual(state.latestPages, [0, 1]);
  assert.deepEqual(errors, []);
});

test("readLike waits for delayed posts and scrolls the added content before leaving a topic", { timeout: 35000 }, async (t) => {
  const { state, errors } = await forum(t, { contentHeight: 400, expandAfter: 2500 });
  await until(() => state.topics.length >= 2,
    "reader never reached another topic after the newly loaded posts", 25000);
  assert.ok(state.expansions.some((event) => event.topic === 1),
    "reader left the initial apparent bottom before its delayed posts rendered");
  assert.ok(state.scrolls.some((event) => event.topic === 1 && event.y >= 1000),
    "reader navigated away without scrolling the newly appended posts");
  assert.deepEqual(errors, []);
});

for (const script of Object.keys(sources)) {
  test(`${script}: AUTO_LIKE=false still navigates through multiple real topics`, { timeout: 25000 }, async (t) => {
    const { page, state, errors } = await forum(t, { script, enabled: false });
    await until(() => new Set(state.topics).size >= 3,
      "disabling likes must not leave the browser idle", 18000);
    assert.equal(state.reactions.length, 0);
    assert.equal((await readingState(page)).read, "true");
    if (script === "index.js") assert.ok(state.scrolls.some((event) => event.y > 0));
    else assert.deepEqual(state.searchPages, [1, 2]);
    assert.deepEqual(errors, []);
  });

  test(`${script}: a pending image does not defer reading forever after DOMContentLoaded`, { timeout: 20000 }, async (t) => {
    const { page, state, errors } = await forum(t, { script, blockLoad: true, enabled: false });
    assert.ok(state.heldImages > 0, "fixture must hold window.load open");
    await until(() => state.topics.length >= 2,
      "reader stayed idle while an unrelated image kept window.load pending", 11000).catch(async (error) => {
      const status = await page.evaluate(() => ({
        status: window.__autoReadStatus, readyState: document.readyState,
        y: window.scrollY, height: document.body.offsetHeight,
        viewport: window.innerHeight,
      })).catch(() => null);
      t.diagnostic(JSON.stringify({ state, status }));
      throw error;
    });
    assert.deepEqual(errors, []);
  });

  test(`${script}: reaction buttons rendered after startup are still considered`, { timeout: 20000 }, async (t) => {
    const { page, state, errors } = await forum(t, {
      script, enabled: true, reactionDelay: script === "index.js" ? 3500 : 2500,
      contentHeight: script === "index.js" ? 2000 : 950,
    });
    await until(() => state.reactions.length > 0,
      "reader never considered a reaction button that appeared after its first scan", 13000);
    if (script === "index_likeUser.js") {
      await until(() => new Set(state.topics).size >= 3,
        "reaching the specific-user like limit stopped reading", 5000);
      assert.equal((await readingState(page)).read, "true");
      assert.equal(state.reactions.length, 1);
    }
    assert.deepEqual(errors, []);
  });
}
