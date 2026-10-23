import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const scripts = ["index.js", "index_likeUser.js", "index_likeUser_activity.js"];
const flush = () => new Promise((resolve) => setImmediate(resolve));

// Execute each complete userscript with a browser-like document and a controlled clock.
// No forum account, navigation, or external network access is needed for these cases.
function browser(script, { readyState = "complete", reading = true, fetch, storage, querySelectorAll } = {}) {
  let now = 0;
  let nextTimer = 0;
  const timers = new Map();
  const errors = [];
  const controls = [];
  const requests = [];
  const values = new Map(Object.entries({
    isFirstRun: "false", read: String(reading), autoLikeEnabled: "false",
  }));
  const localStorage = storage || {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
  const eventTarget = () => {
    const listeners = new Map();
    return {
      addEventListener(type, callback, options = {}) {
        const entries = listeners.get(type) || [];
        entries.push({ callback, once: options.once });
        listeners.set(type, entries);
      },
      dispatch(type) {
        const entries = listeners.get(type) || [];
        listeners.set(type, entries.filter((entry) => !entry.once));
        for (const { callback } of entries) callback();
      },
      listeners,
    };
  };
  const body = { offsetHeight: 100, appendChild: (element) => controls.push(element) };
  const document = {
    ...eventTarget(), readyState, body: readyState === "loading" ? null : body,
    createElement: () => ({ ...eventTarget(), style: {} }),
    querySelectorAll: querySelectorAll || (() => []),
  };
  const initialUrl = "https://www.uscardforum.com/t/topic/438315/1";
  const window = {
    ...eventTarget(), location: { href: initialUrl, pathname: "/t/topic/438315/1" },
    innerHeight: 800, scrollY: 0, scrollBy() {},
  };
  const setTimeout = (callback, delay = 0) => {
    const id = ++nextTimer;
    timers.set(id, { callback, due: now + Number(delay) });
    return id;
  };
  class ClockDate extends Date {
    static now() { return now; }
  }
  const context = vm.createContext({
    window, document, localStorage, Date: ClockDate, AbortController,
    MouseEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout: (id) => timers.delete(id),
    setInterval: () => ++nextTimer, clearInterval() {},
    fetch: async (url, options) => {
      requests.push(String(url));
      return fetch ? fetch(url, options) : response({});
    },
  });
  const source = readFileSync(new URL(`../${script}`, import.meta.url), "utf8");
  const inject = () => vm.runInContext(source, context, { timeout: 1000 });
  const advance = async (milliseconds) => {
    const end = now + milliseconds;
    for (let iterations = 0; iterations < 1000; iterations++) {
      await flush();
      const [id, timer] = [...timers.entries()]
        .filter(([, entry]) => entry.due <= end)
        .sort((a, b) => a[1].due - b[1].due)[0] || [];
      if (!timer) { now = end; await flush(); return; }
      now = timer.due;
      timers.delete(id);
      try {
        const result = timer.callback();
        if (result?.catch) result.catch((error) => errors.push(error));
      } catch (error) { errors.push(error); }
    }
    throw new Error("Timer loop failed to yield");
  };
  return {
    inject, advance, controls, requests, localStorage, window, document, errors,
    get now() { return now; },
    finishLoading() {
      document.body = body;
      document.readyState = "interactive";
      document.dispatch("DOMContentLoaded");
      document.readyState = "complete";
      window.dispatch("load");
    },
    initialUrl,
  };
}

function response(data, status = 200, retryAfter = null) {
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get: () => retryAfter }, json: async () => data,
  };
}

const posts = { posts: [{ topic_id: 123, post_number: 4 }] };
const topics = { topic_list: { topics: [{ id: 123, posts_count: 5 }] } };

for (const script of scripts) {
  test(`${script}: early and duplicate injection initializes once when the body exists`, async () => {
    const page = browser(script, { readyState: "loading", reading: false });
    page.inject();
    page.inject();
    assert.equal(page.controls.length, 0);
    assert.equal(page.document.listeners.get("DOMContentLoaded").length, 1);
    page.finishLoading();
    page.inject();
    await page.advance(10000);
    assert.equal(page.controls.length, script === "index.js" ? 2 : 6);
    assert.equal(page.requests.length, 0);
    assert.deepEqual(page.errors, []);
  });

  test(`${script}: late injection starts and 429 honors Retry-After without a request storm`, async () => {
    const page = browser(script, { fetch: () => response({}, 429, "120") });
    page.inject();
    page.inject();
    await page.advance(2000);
    assert.equal(page.requests.length, 1);
    const retryAt = Number(page.localStorage.getItem("autoReadRetryAfter"));
    await page.advance(retryAt - page.now - 1);
    assert.equal(page.requests.length, 1);
    await page.advance(1);
    assert.equal(page.requests.length, 2);
    assert.equal(page.localStorage.getItem("autoLikeEnabled"), "false");
    assert.deepEqual(page.errors, []);
  });

  test(`${script}: an empty list waits before fetching again`, async () => {
    const page = browser(script);
    page.inject();
    await page.advance(2000);
    assert.equal(page.requests.length, 1);
    await page.advance(59999 - (script === "index.js" ? 2000 : 0));
    assert.equal(page.requests.length, 1);
    await page.advance(1);
    assert.equal(page.requests.length, 2);
    assert.deepEqual(page.errors, []);
  });

  test(`${script}: consecutive failures back off and pause queued navigation`, async () => {
    let calls = 0;
    const page = browser(script, {
      fetch: () => {
        calls++;
        if (calls === 1) return response(script === "index.js" ? topics : posts);
        return response({}, 429);
      },
    });
    page.inject();
    await page.advance(10000);
    assert.equal(page.requests.length, 2);
    assert.equal(page.window.location.href, page.initialUrl);
    const retryAt = Number(page.localStorage.getItem("autoReadRetryAfter"));
    await page.advance(retryAt - page.now);
    assert.equal(page.requests.length, 2);
    assert.equal(page.window.location.href, script === "index.js"
      ? "https://www.uscardforum.com/t/topic/123"
      : "https://www.uscardforum.com/t/topic/123/4");
    assert.deepEqual(page.errors, []);

    const failingPage = browser(script, { fetch: () => response({}, 503) });
    failingPage.inject();
    await failingPage.advance(2000);
    const firstRetry = Number(failingPage.localStorage.getItem("autoReadRetryAfter"));
    await failingPage.advance(firstRetry - failingPage.now);
    assert.equal(failingPage.requests.length, 2);
    assert.equal(Number(failingPage.localStorage.getItem("autoReadRetryAfter")), firstRetry + 120000);
    assert.deepEqual(failingPage.errors, []);
  });

  test(`${script}: a hanging request times out and schedules a bounded retry`, async () => {
    const page = browser(script, {
      fetch: (url, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    });
    page.inject();
    await page.advance(2000);
    await page.advance(15000);
    assert.equal(page.requests.length, 1);
    assert.ok(Number(page.localStorage.getItem("autoReadRetryAfter")) > page.now);
    assert.equal(page.window.location.href, page.initialUrl);
    assert.deepEqual(page.errors, []);
  });

  test(`${script}: stopping while a request is pending prevents navigation`, async () => {
    let complete;
    const page = browser(script, { fetch: () => new Promise((resolve) => { complete = resolve; }) });
    page.inject();
    await page.advance(2000);
    assert.equal(page.requests.length, 1);
    page.localStorage.setItem("read", "false");
    complete(response(script === "index.js" ? topics : posts));
    await page.advance(20000);
    assert.equal(page.requests.length, 1);
    assert.equal(page.window.location.href, page.initialUrl);
    assert.deepEqual(page.errors, []);
  });
}

test("latest topics: filtered pages yield between requests and stop at the page limit", async () => {
  const page = browser("index.js", {
    fetch: (url) => {
      const id = Number(new URL(url).searchParams.get("page")) + 1;
      return response({ topic_list: { topics: [{ id, posts_count: 9999 }] } });
    },
  });
  page.inject();
  await flush();
  assert.equal(page.requests.length, 1);
  await page.advance(10000);
  assert.equal(page.requests.length, 10);
  assert.equal(page.window.location.href, page.initialUrl);
  assert.deepEqual(page.errors, []);
});

for (const script of scripts.slice(1)) {
  function reactionTarget(onClick) {
    const reaction = { title: "Like this post", dispatchEvent: onClick };
    return { getAttribute: () => "Post #1", parentElement: { querySelector: () => reaction } };
  }

  test(`${script}: manually disabling likes cancels an already scheduled click and keeps reading`, async () => {
    let clicks = 0;
    const target = reactionTarget(() => clicks++);
    const page = browser(script, { querySelectorAll: () => [target] });
    page.localStorage.setItem("autoLikeEnabled", "true");
    page.inject();
    page.localStorage.setItem("autoLikeEnabled", "false");
    await page.advance(2000);
    assert.equal(clicks, 0);
    assert.equal(Number(page.localStorage.getItem("clickCounter") || 0), 0);
    assert.equal(page.localStorage.getItem("read"), "true");
    assert.equal(page.requests.length, 1);
    assert.deepEqual(page.errors, []);
  });

  test(`${script}: a 429 pause survives the next page and reading resumes after the cooldown`, async () => {
    const firstPage = browser(script, { fetch: () => response({}, 429, "120") });
    firstPage.localStorage.setItem("autoLikeEnabled", "true");
    firstPage.inject();
    await firstPage.advance(2000);
    assert.equal(firstPage.localStorage.getItem("autoLikeEnabled"), "false");
    let clicks = 0;
    const target = reactionTarget(() => clicks++);
    const nextPage = browser(script, {
      storage: firstPage.localStorage, querySelectorAll: () => [target],
    });
    nextPage.inject();
    await nextPage.advance(2000);
    assert.equal(clicks, 0);
    assert.equal(nextPage.localStorage.getItem("read"), "true");
    assert.equal(nextPage.requests.length, 0);
    const retryAt = Number(nextPage.localStorage.getItem("autoReadRetryAfter"));
    await nextPage.advance(retryAt - nextPage.now);
    assert.equal(nextPage.requests.length, 1);
    assert.equal(clicks, 0);
    assert.equal(nextPage.localStorage.getItem("read"), "true");
    assert.deepEqual(nextPage.errors, []);
  });

  test(`${script}: disabling likes during target lookup is checked again before dispatch`, async () => {
    let clicks = 0;
    const target = reactionTarget(() => clicks++);
    const page = browser(script, {
      querySelectorAll: () => {
        page.localStorage.setItem("autoLikeEnabled", "false");
        return [target];
      },
    });
    page.localStorage.setItem("autoLikeEnabled", "true");
    page.inject();
    await page.advance(2000);
    assert.equal(clicks, 0);
    assert.equal(Number(page.localStorage.getItem("clickCounter") || 0), 0);
    assert.equal(page.localStorage.getItem("read"), "true");
    assert.equal(page.requests.length, 1);
    assert.deepEqual(page.errors, []);
  });

  test(`${script}: an enabled like still dispatches and counts once`, async () => {
    let clicks = 0;
    const target = reactionTarget((event) => { assert.equal(event.type, "click"); clicks++; });
    const page = browser(script, { querySelectorAll: () => [target] });
    page.localStorage.setItem("autoLikeEnabled", "true");
    page.inject();
    await page.advance(2000);
    assert.equal(clicks, 1);
    assert.equal(page.localStorage.getItem("clickCounter"), "1");
    assert.deepEqual(page.errors, []);
  });

  test(`${script}: repeated search pages stop and never duplicate queued posts`, async () => {
    const page = browser(script, { fetch: () => response(posts) });
    page.inject();
    await page.advance(10000);
    assert.equal(page.requests.length, 2);
    assert.deepEqual(page.requests.map((url) => new URL(url).searchParams.get("page")), ["1", "2"]);
    assert.equal(page.window.location.href, "https://www.uscardforum.com/t/topic/123/4");
    assert.equal(page.localStorage.getItem("specificUserPostList"), "[]");
    assert.deepEqual(page.errors, []);
  });
}
