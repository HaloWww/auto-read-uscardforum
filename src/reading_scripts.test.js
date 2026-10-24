import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const scripts = ["index.js", "index_likeUser.js"];
const flush = () => new Promise((resolve) => setImmediate(resolve));
const response = (data = {}, status = 200, retryAfter = null) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: () => retryAfter }, json: async () => data,
});
const itemsFor = (script) => script === "index.js"
  ? { topic_list: { topics: [{ id: 123, posts_count: 5 }] } }
  : { posts: [{ topic_id: 123, post_number: 4 }] };

// Real timer ordering and clamped scrolling, without an external forum or a
// wall-clock wait. Navigation ends this document just as it does in a browser.
function browser(script, {
  readyState = "complete", height = 100, fetch, querySelectorAll = () => [],
  storage, target = true, url = "https://www.uscardforum.com/t/topic/438315/1", random = () => 0,
} = {}) {
  let now = 0;
  let nextTimer = 0;
  let contentHeight = height;
  let currentUrl = url;
  const timers = new Map();
  const errors = [];
  const requests = [];
  const events = [];
  const navigations = [];
  const values = new Map(Object.entries({ read: "true", autoLikeEnabled: "false" }));
  const localStorage = storage || {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
  if (target) localStorage.setItem("autoReadSpecificTarget", JSON.stringify({ topic_id: 438315, post_number: 1 }));
  const listeners = new Map();
  const body = {};
  Object.defineProperty(body, "offsetHeight", { get: () => contentHeight });
  Object.defineProperty(body, "scrollHeight", { get: () => contentHeight });
  const document = {
    readyState, body: readyState === "loading" ? null : body,
    documentElement: body, querySelectorAll,
    addEventListener(type, callback) {
      const existing = listeners.get(type) || [];
      existing.push(callback);
      listeners.set(type, existing);
    },
  };
  const window = {
    innerHeight: 800, scrollY: 0,
    scrollBy(x, y) { this.scrollY = Math.min(Math.max(0, contentHeight - this.innerHeight), this.scrollY + y); },
    addEventListener() { throw new Error("reader must not depend on window.load"); },
    location: {
      get href() { return currentUrl; },
      set href(value) { currentUrl = value; navigations.push(value); },
      get pathname() { return new URL(currentUrl).pathname; },
      get origin() { return new URL(currentUrl).origin; },
    },
  };
  const setTimeout = (callback, delay = 0) => {
    const id = ++nextTimer;
    timers.set(id, { callback, due: now + Number(delay) });
    return id;
  };
  class ClockDate extends Date { static now() { return now; } }
  const context = vm.createContext({
    window, document, localStorage, Date: ClockDate, AbortController,
    Math: Object.assign(Object.create(Math), { random }),
    MouseEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
    console: {
      log: (tag, json) => { if (tag === "[auto-read]") events.push(JSON.parse(json)); },
      warn() {}, error: (...args) => errors.push(args.map(String).join(" ")),
    },
    setTimeout, clearTimeout: (id) => timers.delete(id),
    fetch: async (requestUrl, options) => {
      requests.push(String(requestUrl));
      return fetch ? fetch(requestUrl, options) : response();
    },
  });
  const source = readFileSync(new URL(`../${script}`, import.meta.url), "utf8");
  return {
    inject: () => vm.runInContext(source, context, { timeout: 1000 }),
    async advance(milliseconds) {
      const end = now + milliseconds;
      for (let iterations = 0; iterations < 50000; iterations++) {
        await flush();
        if (navigations.length) { now = end; return; }
        const [id, timer] = [...timers.entries()].filter(([, entry]) => entry.due <= end)
          .sort((a, b) => a[1].due - b[1].due)[0] || [];
        if (!timer) { now = end; await flush(); return; }
        now = timer.due;
        timers.delete(id);
        try {
          const result = timer.callback();
          if (result?.catch) result.catch((error) => errors.push(error));
        } catch (error) { errors.push(error); }
      }
      throw new Error("Timer loop did not yield");
    },
    ready() {
      document.body = body;
      document.readyState = "interactive";
      for (const callback of listeners.get("DOMContentLoaded") || []) callback();
      listeners.delete("DOMContentLoaded");
    },
    setHeight(value) { contentHeight = value; },
    localStorage, document, window, requests, navigations, errors, events,
    get now() { return now; },
    get timerCount() { return timers.size; },
  };
}

function reaction(onClick, number = 1) {
  const button = { title: "Like this post", isConnected: true, dispatchEvent: onClick };
  const anchor = { getAttribute: () => `Post #${number}`, parentElement: { querySelector: () => button } };
  return { button, anchor };
}

for (const script of scripts) {
  test(`${script}: DOMContentLoaded starts once without waiting for window.load`, async () => {
    const page = browser(script, { readyState: "loading" });
    page.inject();
    page.inject();
    assert.equal(page.window.__autoReadStatus, undefined);
    page.ready();
    page.inject();
    await page.advance(6000);
    assert.equal(page.events.filter(({ type }) => type === "started").length, 1);
    assert.equal(page.window.__autoReadStatus.started, true);
    assert.equal(page.window.__autoReadStatus.lastTickAt, 6000);
    assert.equal(page.requests.length, 1);
    assert.deepEqual(page.errors, []);
  });

  test(`${script}: late content growth prevents leaving a false bottom and produces real scroll activity`, async () => {
    const page = browser(script);
    page.inject();
    await page.advance(2500);
    assert.equal(page.navigations.length, 0);
    page.setHeight(20000);
    await page.advance(10000);
    assert.ok(page.window.scrollY >= 1800);
    assert.ok(page.events.some(({ type }) => type === "scroll"));
    assert.equal(page.requests.length, 0);
    assert.equal(page.navigations.length, 0);
    assert.deepEqual(page.errors, []);
  });

  test(`${script}: delayed reaction rendering is scanned repeatedly but dispatched once`, async () => {
    let clicks = 0;
    let visible = false;
    const { button, anchor } = reaction(() => clicks++);
    const page = browser(script, {
      height: 100000000,
      querySelectorAll: () => visible ? [script === "index.js" ? button : anchor] : [],
    });
    page.localStorage.setItem("autoLikeEnabled", "true");
    page.inject();
    await page.advance(3500);
    assert.equal(clicks, 0);
    visible = true;
    await page.advance(20000);
    assert.equal(clicks, 1);
    assert.equal(page.events.filter(({ type }) => type === "like-attempt").length, 1);
    assert.equal(page.localStorage.getItem("read"), "true");
    assert.deepEqual(page.errors, []);
  });

  test(`${script}: the like limit disables likes while reading and scrolling continue`, async () => {
    let clicks = 0;
    const targets = Array.from({ length: 20 }, () => reaction(() => clicks++));
    const page = browser(script, {
      height: 100000000,
      querySelectorAll: () => targets.map((item) => script === "index.js" ? item.button : item.anchor),
    });
    page.localStorage.setItem("autoLikeEnabled", "true");
    page.inject();
    await page.advance(60000);
    assert.equal(clicks, script === "index.js" ? 9 : 1);
    assert.equal(page.localStorage.getItem("autoLikeEnabled"), "false");
    assert.equal(page.localStorage.getItem("read"), "true");
    assert.ok(page.window.scrollY > 10000);
    assert.equal(page.window.__autoReadStatus.lastTickAt, 60000);
    assert.deepEqual(page.errors, []);
  });

  test(`${script}: 429 honors Retry-After, persists a like pause and avoids request storms`, async () => {
    const page = browser(script, { fetch: () => response({}, 429, "120") });
    page.inject();
    await page.advance(5000);
    assert.equal(page.requests.length, 1);
    const deadline = Number(page.localStorage.getItem("autoReadRetryAfter"));
    assert.equal(page.window.__autoReadStatus.phase, "cooldown");
    assert.equal(page.window.__autoReadStatus.retryAt, deadline);
    assert.equal(page.localStorage.getItem("autoReadLikesPaused"), "true");
    await page.advance(deadline - page.now - 1);
    assert.equal(page.requests.length, 1);
    await page.advance(1001);
    assert.equal(page.requests.length, 2);
    assert.equal(page.localStorage.getItem("autoLikeEnabled"), "false");
    assert.deepEqual(page.errors, []);
  });

  test(`${script}: an empty list waits before another request`, async () => {
    const page = browser(script);
    page.inject();
    await page.advance(5000);
    assert.equal(page.requests.length, 1);
    const deadline = Number(page.localStorage.getItem("autoReadRetryAfter"));
    await page.advance(deadline - page.now - 1);
    assert.equal(page.requests.length, 1);
    await page.advance(1001);
    assert.equal(page.requests.length, 2);
    assert.deepEqual(page.errors, []);
  });

  test(`${script}: partial queues are retained through a rate-limit cooldown`, async () => {
    let calls = 0;
    const page = browser(script, { fetch: () => ++calls === 1 ? response(itemsFor(script)) : response({}, 429) });
    page.inject();
    await page.advance(10000);
    assert.equal(page.requests.length, 2);
    assert.equal(page.navigations.length, 0);
    const deadline = Number(page.localStorage.getItem("autoReadRetryAfter"));
    await page.advance(deadline - page.now + 1000);
    assert.equal(page.requests.length, 2);
    assert.equal(page.navigations[0], script === "index.js"
      ? "https://www.uscardforum.com/t/topic/123" : "https://www.uscardforum.com/t/topic/123/4");
    assert.deepEqual(page.errors, []);
  });

  test(`${script}: a hanging request times out while the heartbeat continues`, async () => {
    const page = browser(script, { fetch: (url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }) });
    page.inject();
    await page.advance(21000);
    assert.equal(page.requests.length, 1);
    assert.ok(Number(page.localStorage.getItem("autoReadRetryAfter")) > page.now);
    assert.equal(page.window.__autoReadStatus.lastTickAt, 21000);
    assert.equal(page.navigations.length, 0);
    assert.deepEqual(page.errors, []);
  });

  test(`${script}: stopping during an outstanding request prevents a later navigation`, async () => {
    let complete;
    const page = browser(script, { fetch: () => new Promise((resolve) => { complete = resolve; }) });
    page.inject();
    await page.advance(5000);
    assert.equal(page.requests.length, 1);
    page.localStorage.setItem("read", "false");
    complete(response(itemsFor(script)));
    await page.advance(20000);
    assert.equal(page.requests.length, 1);
    assert.equal(page.navigations.length, 0);
    assert.deepEqual(page.errors, []);
  });

  test(`${script}: one hundred simulated minutes keeps a live loop with bounded retries and timers`, async () => {
    const page = browser(script, { fetch: () => response({}, 503) });
    page.inject();
    await page.advance(100 * 60000);
    assert.equal(page.window.__autoReadStatus.started, true);
    assert.equal(page.window.__autoReadStatus.lastTickAt, 100 * 60000);
    assert.equal(page.localStorage.getItem("read"), "true");
    assert.ok(page.requests.length > 5 && page.requests.length < 20);
    assert.ok(page.timerCount <= 2);
    assert.deepEqual(page.errors, []);
  });
}

test("random likes can be cancelled after queueing and before dispatch", async () => {
  let clicks = 0;
  const { button } = reaction(() => clicks++);
  const page = browser("index.js", { height: 100000000, querySelectorAll: () => [button] });
  page.localStorage.setItem("autoLikeEnabled", "true");
  page.inject();
  page.localStorage.setItem("autoLikeEnabled", "false");
  await page.advance(10000);
  assert.equal(clicks, 0);
  assert.equal(page.localStorage.getItem("read"), "true");
});

test("specific-user likes recheck cancellation after target lookup", async () => {
  let clicks = 0;
  const { anchor } = reaction(() => clicks++);
  const page = browser("index_likeUser.js", { height: 100000000, querySelectorAll: () => {
    page.localStorage.setItem("autoLikeEnabled", "false");
    return [anchor];
  } });
  page.localStorage.setItem("autoLikeEnabled", "true");
  page.inject();
  await page.advance(10000);
  assert.equal(clicks, 0);
});

test("specific-user likes never dispatch on an unrelated seed topic", async () => {
  let clicks = 0;
  const { anchor } = reaction(() => clicks++);
  const page = browser("index_likeUser.js", { target: false, querySelectorAll: () => [anchor] });
  page.localStorage.setItem("autoLikeEnabled", "true");
  page.inject();
  await page.advance(10000);
  assert.equal(clicks, 0);
  assert.equal(page.localStorage.getItem("read"), "true");
});

test("specific-user post numbers are matched exactly, without confusing #1 and #10", async () => {
  let right = 0;
  let wrong = 0;
  const one = reaction(() => right++, 1);
  const ten = reaction(() => wrong++, 10);
  const page = browser("index_likeUser.js", {
    height: 100000000, querySelectorAll: () => [ten.anchor, one.anchor],
    url: "https://www.uscardforum.com/t/topic/438315",
  });
  page.localStorage.setItem("autoLikeEnabled", "true");
  page.inject();
  await page.advance(10000);
  assert.equal(right, 1);
  assert.equal(wrong, 0);
  assert.deepEqual(page.errors, []);
});

for (const script of scripts) {
  test(`${script}: repeated API pages stop and queue only unique posts`, async () => {
    const page = browser(script, { fetch: () => response(itemsFor(script)) });
    page.inject();
    await page.advance(10000);
    assert.equal(page.requests.length, 2);
    assert.equal(page.navigations.length, 1);
    assert.equal(page.localStorage.getItem(script === "index.js" ? "topicList" : "specificUserPostList"), "[]");
    assert.deepEqual(page.errors, []);
  });

  test(`${script}: a loop exception is exposed to runtime monitoring`, async () => {
    const page = browser(script, { height: 100000000, querySelectorAll: () => { throw new Error("fixture scan failed"); } });
    page.localStorage.setItem("autoLikeEnabled", "true");
    page.inject();
    assert.match(page.window.__autoReadStatus.error, /fixture scan failed/);
    assert.ok(page.errors.length > 0);
  });
}

test("latest topics skip large threads but stop after the pagination bound", async () => {
  const page = browser("index.js", { fetch: (url) => {
    const id = Number(new URL(url).searchParams.get("page")) + 1;
    return response({ topic_list: { topics: [{ id, posts_count: 9999 }] } });
  } });
  page.inject();
  await page.advance(20000);
  assert.equal(page.requests.length, 10);
  assert.equal(page.navigations.length, 0);
  assert.equal(page.window.__autoReadStatus.phase, "cooldown");
  assert.deepEqual(page.errors, []);
});
