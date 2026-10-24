import { verifyReader } from "./reader_session.js";

export function createReaderMonitor({
  label, browser, getPage, onFailure, intervalMillis = 60000,
  log = console.log, now = Date.now,
  schedule = setTimeout, cancel = clearTimeout, verify = verifyReader,
}) {
  const counts = {
    documents: 0, scrolls: 0, topicTransitions: 0, likeAttempts: 0,
    likeAccepted: 0, checks: 0, rateLimits: 0,
  };
  const attached = new Map();
  const evaluationTimers = new Map();
  let startedAt;
  let stoppedAt;
  let timer;
  let running = false;
  let stopped = false;
  let failed = false;
  let printed = false;

  function summary() {
    return {
      ...counts,
      elapsedMillis: startedAt === undefined ? 0 : (stoppedAt ?? now()) - startedAt,
    };
  }

  function stop() {
    stopped = true;
    running = false;
    stoppedAt ??= now();
    if (timer !== undefined) cancel(timer);
    for (const [timeout, abort] of evaluationTimers) {
      cancel(timeout);
      abort(new Error("阅读监控已停止"));
    }
    evaluationTimers.clear();
    for (const [page, listeners] of attached) {
      for (const [event, listener] of Object.entries(listeners)) page.off(event, listener);
    }
    attached.clear();
    const result = summary();
    if (!printed) {
      printed = true;
      log(`${label}：阅读统计 ${JSON.stringify(result)}`);
    }
    return result;
  }

  function attach(page) {
    if (stopped || attached.has(page)) return api;
    const onResponse = (response) => {
      if (page !== getPage()) return;
      try {
        const request = response.request();
        if (request.method() !== "POST" || request.frame() !== page.mainFrame()) return;
        const url = new URL(response.url());
        if (url.origin !== new URL(page.url()).origin || !/reaction|post_actions|\/like/i.test(url.pathname)) return;
        const status = response.status();
        if (status >= 200 && status < 300) counts.likeAccepted++;
        else if (status === 429) counts.rateLimits++;
      } catch {
        // A response can outlive its frame; it cannot prove a successful like.
      }
    };
    page.on("response", onResponse);
    attached.set(page, { response: onResponse });
    return api;
  }

  async function readState(page) {
    let timeout;
    try {
      return await Promise.race([
        page.evaluate(() => ({
          injected: window.__autoInjected === true,
          read: localStorage.getItem("read"),
          status: window.__autoReadStatus,
        })),
        new Promise((_, reject) => {
          timeout = schedule(() => reject(new Error("阅读页面响应超时")), 15000);
          evaluationTimers.set(timeout, reject);
        }),
      ]);
    } finally {
      if (timeout !== undefined) {
        cancel(timeout);
        evaluationTimers.delete(timeout);
      }
    }
  }

  function collect(state) {
    // The real-browser transport deliberately skips Runtime.enable, so CDP
    // console events are absent even while the page scrolls and navigates.
    // These counters persist across documents and must be sampled, not summed.
    for (const key of ["documents", "scrolls", "topicTransitions", "likeAttempts"]) {
      const value = state?.status?.counters?.[key];
      if (Number.isSafeInteger(value) && value >= 0) counts[key] = Math.max(counts[key], value);
    }
  }

  async function sample() {
    if (stopped) return summary();
    const page = getPage();
    if (!page || page.isClosed() || !browser.connected) return summary();
    let state;
    try {
      state = await readState(page);
    } catch (error) {
      if (stopped) return summary();
      if (!/execution context was destroyed|cannot find context|context.*not found|net::ERR_ABORTED/i.test(error.message)) throw error;
      await verify(page, 15000);
      state = await readState(page);
    }
    if (!stopped && page === getPage()) collect(state);
    return summary();
  }

  async function fail(error) {
    if (failed || stopped) return;
    failed = true;
    const result = stop();
    try {
      await onFailure(error, result);
    } catch (cleanupError) {
      log(`${label}：监控故障处理失败：${cleanupError.message}`);
    }
  }

  async function check() {
    if (!running) return;
    counts.checks++;
    try {
      const page = getPage();
      if (!browser.connected) throw new Error("阅读浏览器连接已断开");
      if (!page || page.isClosed()) throw new Error("阅读页面已关闭");
      await verify(page, 15000);
      if (!running) return;
      let state;
      try {
        state = await readState(page);
      } catch (error) {
        if (!/execution context was destroyed|cannot find context|context.*not found|net::ERR_ABORTED/i.test(error.message)) throw error;
      }
      if (!running) return;
      if (!state?.injected || !state.status?.started) {
        await verify(page, 15000);
        state = await readState(page);
      }
      if (!running) return;
      if (!browser.connected || page.isClosed()) throw new Error("阅读页面或浏览器已断开");
      if (!state?.injected || !state.status?.started || state.read !== "true") {
        throw new Error("阅读脚本未运行或阅读状态已停止");
      }
      collect(state);
      const status = state.status;
      if (status.error) {
        const message = typeof status.error === "string" ? status.error : status.error.message || "未知错误";
        throw new Error(`阅读脚本错误：${message}`);
      }
      if (!["reading", "fetching", "cooldown"].includes(status.phase) || !Number.isFinite(status.lastTickAt)) {
        throw new Error("阅读脚本状态无效");
      }
      const coolingDown = status.phase === "cooldown" && Number.isFinite(status.retryAt) && status.retryAt > now();
      if (!coolingDown && now() - status.lastTickAt > 120000) throw new Error("阅读脚本超过两分钟没有活动");
      const minutes = Math.floor(summary().elapsedMillis / 60000);
      log(`${label}：已运行 ${minutes} 分钟，换页 ${counts.topicTransitions}，滚动 ${counts.scrolls}，点赞请求 ${counts.likeAttempts}，点赞 HTTP 2xx ${counts.likeAccepted}，状态 ${status.phase}`);
    } catch (error) {
      await fail(error);
    }
    if (running) timer = schedule(() => { void check(); }, intervalMillis);
  }

  function start() {
    if (running || stopped) return api;
    running = true;
    startedAt = now();
    timer = schedule(() => { void check(); }, intervalMillis);
    return api;
  }

  const api = { attach, start, stop, sample, summary };
  return api;
}
