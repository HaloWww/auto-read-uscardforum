import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createReaderMonitor } from "./reader_monitor.js";

const flush = () => new Promise((resolve) => setImmediate(resolve));

function fakeClock() {
  let current = 0;
  let sequence = 0;
  const timers = new Map();
  return {
    now: () => current,
    schedule(callback, delay) {
      const id = ++sequence;
      timers.set(id, { callback, due: current + delay });
      return id;
    },
    cancel: (id) => timers.delete(id),
    pending: () => timers.size,
    async advance(milliseconds) {
      const end = current + milliseconds;
      for (let count = 0; count < 1000; count++) {
        await flush();
        const entry = [...timers.entries()].filter(([, timer]) => timer.due <= end)
          .sort((a, b) => a[1].due - b[1].due)[0];
        if (!entry) { current = end; await flush(); return; }
        const [id, timer] = entry;
        timers.delete(id);
        current = timer.due;
        timer.callback();
      }
      throw new Error("Unexpected timer loop");
    },
  };
}

class Page extends EventEmitter {
  constructor(clock) {
    super();
    this.clock = clock;
    this.frame = {};
    this.closed = false;
    this.evaluations = 0;
  }
  mainFrame() { return this.frame; }
  url() { return "https://forum.test/t/topic/123/1"; }
  isClosed() { return this.closed; }
  state() {
    return { injected: true, read: "true", status: { started: true, lastTickAt: this.clock.now(), phase: "reading" } };
  }
  async evaluate() { this.evaluations++; return this.state(); }
  event(type, extra = {}) {
    this.emit("console", { text: () => `[auto-read] ${JSON.stringify({ type, ...extra })}` });
  }
  response({ method = "POST", path = "/discourse-reactions/posts/1/custom-reactions/like/toggle.json",
    status = 200, frame = this.frame, origin = "https://forum.test" } = {}) {
    this.emit("response", {
      request: () => ({ method: () => method, frame: () => frame }),
      url: () => `${origin}${path}`, status: () => status,
    });
  }
}

function fixture(options = {}) {
  const clock = fakeClock();
  const page = new Page(clock);
  const browser = { connected: true };
  const failures = [];
  const logs = [];
  let current = page;
  const monitor = createReaderMonitor({
    label: "账号 #1", browser, getPage: () => current,
    onFailure: async (error) => failures.push(error), log: (message) => logs.push(message),
    ...clock, verify: async () => {}, ...options,
  });
  monitor.attach(page);
  return { clock, page, browser, failures, logs, monitor, setPage: (next) => { current = next; } };
}

test("monitor counts reader activity and only matching main-frame POST responses", async () => {
  const { page, monitor, clock, logs, failures } = fixture();
  monitor.attach(page).start();
  assert.equal(page.listenerCount("console"), 1);
  page.event("started");
  page.event("scroll", { count: 3 });
  page.event("scroll");
  page.event("scroll", { count: -1 });
  page.event("topic");
  page.event("like-attempt");
  page.event("like-attempt");
  page.emit("console", { text: () => "[auto-read] not json" });
  page.response();
  page.response({ path: "/post_actions", status: 201 });
  page.response({ status: 429 });
  page.response({ status: 500 });
  page.response({ method: "GET" });
  page.response({ frame: {} });
  page.response({ path: "/session" });
  page.response({ origin: "https://unrelated.test" });
  await clock.advance(60000);
  assert.deepEqual(monitor.stop(), {
    documents: 1, scrolls: 4, topicTransitions: 1, likeAttempts: 2,
    likeAccepted: 2, rateLimits: 1, checks: 1, elapsedMillis: 60000,
  });
  assert.ok(logs.some((line) => line.includes("已运行 1 分钟") && line.includes("点赞 HTTP 2xx 2")));
  assert.ok(logs.every((line) => !line.includes("https://")));
  assert.deepEqual(failures, []);
});

test("stop removes listeners, freezes the summary and prevents later checks or duplicate final logs", async () => {
  const { page, monitor, clock, logs } = fixture();
  monitor.start();
  await clock.advance(60000);
  const result = monitor.stop();
  assert.equal(page.listenerCount("console"), 0);
  assert.equal(page.listenerCount("response"), 0);
  page.event("scroll");
  page.response();
  monitor.start();
  await clock.advance(180000);
  assert.deepEqual(monitor.stop(), result);
  assert.equal(page.evaluations, 1);
  assert.equal(logs.filter((line) => line.includes("阅读统计")).length, 1);
});

test("checks never overlap when the page responds more slowly than the heartbeat interval", async () => {
  const { page, monitor, clock, failures } = fixture({ intervalMillis: 1000 });
  let complete;
  page.evaluate = () => {
    page.evaluations++;
    if (page.evaluations === 1) return new Promise((resolve) => { complete = resolve; });
    return Promise.resolve(page.state());
  };
  monitor.start();
  await clock.advance(3500);
  assert.equal(page.evaluations, 1);
  complete(page.state());
  await clock.advance(0);
  await clock.advance(1000);
  assert.equal(page.evaluations, 2);
  assert.deepEqual(failures, []);
  monitor.stop();
});

test("stopping during an unfinished check cancels its deadline and ignores the late response", async () => {
  const { page, monitor, clock, failures, logs } = fixture();
  let complete;
  page.evaluate = () => new Promise((resolve) => { complete = resolve; });
  monitor.start();
  await clock.advance(60000);
  const result = monitor.stop();
  assert.equal(clock.pending(), 0);
  complete(page.state());
  await clock.advance(180000);
  assert.deepEqual(monitor.summary(), result);
  assert.deepEqual(failures, []);
  assert.equal(logs.filter((line) => line.includes("已运行")).length, 0);
});

test("a stale reader fails once and cannot keep reporting successful heartbeats", async () => {
  const { page, monitor, clock, failures, logs } = fixture();
  page.state = () => ({ injected: true, read: "true", status: { started: true, lastTickAt: -120001, phase: "reading" } });
  monitor.start();
  await clock.advance(240000);
  assert.equal(failures.length, 1);
  assert.match(failures[0].message, /两分钟没有活动/);
  assert.equal(monitor.summary().checks, 1);
  assert.equal(logs.filter((line) => line.includes("已运行")).length, 0);
  assert.equal(page.listenerCount("console"), 0);
});

test("an active cooldown permits old ticks but an expired cooldown cannot mask a stalled reader", async () => {
  const { page, monitor, clock, failures } = fixture();
  page.state = () => ({ injected: true, read: "true", status: { started: true, lastTickAt: 0, phase: "cooldown", retryAt: 240001 } });
  monitor.start();
  await clock.advance(240000);
  assert.deepEqual(failures, []);
  assert.equal(monitor.summary().checks, 4);
  await clock.advance(60000);
  assert.equal(failures.length, 1);
  assert.match(failures[0].message, /两分钟没有活动/);
});

test("a recorded script error fails even when its tick is fresh and cooldown is valid", async () => {
  const { page, monitor, clock, failures, logs } = fixture();
  page.state = () => ({ injected: true, read: "true", status: {
    started: true, lastTickAt: clock.now(), phase: "cooldown", retryAt: 300000,
    error: "topic navigation failed",
  } });
  monitor.start();
  await clock.advance(180000);
  assert.equal(failures.length, 1);
  assert.match(failures[0].message, /阅读脚本错误：topic navigation failed/);
  assert.equal(monitor.summary().checks, 1);
  assert.equal(logs.filter((line) => line.includes("已运行")).length, 0);
});

test("an initialization recovery may close the old page without falsely failing the live replacement", async () => {
  const { page, monitor, clock, failures, setPage } = fixture();
  monitor.start();
  page.closed = true;
  page.emit("close");
  const replacement = new Page(clock);
  setPage(replacement);
  monitor.attach(replacement);
  page.event("started");
  replacement.event("started");
  await clock.advance(60000);
  assert.deepEqual(failures, []);
  assert.equal(monitor.summary().documents, 1);
  assert.equal(replacement.evaluations, 1);
  monitor.stop();
});

test("closed pages, disconnected browsers and stopped readers each produce a single failure", async () => {
  for (const type of ["closed", "disconnected", "stopped", "evaluation-error"]) {
    const { page, browser, monitor, clock, failures, logs } = fixture();
    if (type === "closed") page.closed = true;
    else if (type === "disconnected") browser.connected = false;
    else if (type === "stopped") page.state = () => ({ injected: true, read: "false", status: { started: true } });
    else page.evaluate = async () => { throw new Error("CDP connection failure"); };
    monitor.start();
    await clock.advance(180000);
    assert.equal(failures.length, 1, type);
    assert.equal(logs.filter((line) => line.includes("已运行")).length, 0, type);
    assert.equal(monitor.summary().checks, 1, type);
  }
});

test("navigation during a check re-verifies the real reader before logging success", async () => {
  let recoveries = 0;
  const { page, monitor, clock, failures } = fixture({ verify: async (target, timeout) => {
    assert.equal(target, page);
    assert.equal(timeout, 15000);
    recoveries++;
  } });
  page.evaluate = async () => {
    page.evaluations++;
    if (page.evaluations === 1) throw new Error("Execution context was destroyed");
    return page.state();
  };
  monitor.start();
  await clock.advance(60000);
  assert.equal(recoveries, 2);
  assert.equal(page.evaluations, 2);
  assert.deepEqual(failures, []);
  monitor.stop();
});

test("lost authentication fails verification before an otherwise active reader can log success", async () => {
  let verifications = 0;
  const { page, monitor, clock, failures, logs } = fixture({ verify: async () => {
    verifications++;
    throw new Error("登录状态已丢失");
  } });
  monitor.start();
  await clock.advance(180000);
  assert.equal(verifications, 1);
  assert.equal(page.evaluations, 0);
  assert.equal(failures.length, 1);
  assert.match(failures[0].message, /登录状态已丢失/);
  assert.equal(logs.filter((line) => line.includes("已运行")).length, 0);
  assert.equal(monitor.summary().checks, 1);
});

test("an unresponsive page has a bounded check and fails instead of reporting activity", async () => {
  const { page, monitor, clock, failures, logs } = fixture();
  page.evaluate = () => new Promise(() => {});
  monitor.start();
  await clock.advance(75000);
  assert.equal(failures.length, 1);
  assert.match(failures[0].message, /响应超时/);
  assert.equal(logs.filter((line) => line.includes("已运行")).length, 0);
});
