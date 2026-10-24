// Observe Discourse's own reading requests. Never submit or alter reading timings.
export function createReadingEvidence(page, username) {
  const origin = new URL(page.url()).origin;
  const seen = new WeakSet();
  const settled = new WeakSet();
  const topics = new Set();
  const posts = new Set();
  const counts = {
    requests: 0, accepted: 0, rejected: 0, failed: 0,
    parsed: 0, topicTimeMillis: 0,
  };
  const statuses = {};
  let stopped = false;

  function matches(request) {
    try {
      const url = new URL(request.url());
      return request.method() === "POST" && request.frame() === page.mainFrame() &&
        url.origin === origin &&
        /^\/(?:topics\/timings|t\/\d+\/timings)(?:\.json)?\/?$/.test(url.pathname);
    } catch {
      return false;
    }
  }

  function observe(request) {
    if (stopped || !matches(request)) return false;
    if (!seen.has(request)) {
      seen.add(request);
      counts.requests++;
    }
    return true;
  }

  function parse(request) {
    try {
      const raw = request.postData();
      if (!raw) return;
      let topicId, topicTime, entries;
      if (raw.trimStart().startsWith("{")) {
        const body = JSON.parse(raw);
        topicId = Number(body.topic_id);
        topicTime = Number(body.topic_time);
        entries = Object.entries(body.timings ?? {});
      } else {
        const body = new URLSearchParams(raw);
        topicId = Number(body.get("topic_id"));
        topicTime = Number(body.get("topic_time"));
        entries = Array.from(body.entries()).flatMap(([key, value]) => {
          const match = /^timings\[(\d+)\]$/.exec(key);
          return match ? [[match[1], value]] : [];
        });
      }
      if (!Number.isSafeInteger(topicId) || topicId <= 0) {
        topicId = Number(/^\/t\/(\d+)\/timings/.exec(new URL(request.url()).pathname)?.[1]);
      }
      if (!Number.isSafeInteger(topicId) || topicId <= 0 ||
          !Number.isSafeInteger(topicTime) || topicTime < 0) return;
      counts.parsed++;
      counts.topicTimeMillis += topicTime;
      topics.add(topicId);
      for (const [post, milliseconds] of entries) {
        const number = Number(post);
        const time = Number(milliseconds);
        if (Number.isSafeInteger(number) && number > 0 &&
            Number.isSafeInteger(time) && time > 0) posts.add(`${topicId}:${number}`);
      }
    } catch {
      // An unavailable/malformed body is not evidence of reading progress.
    }
  }

  const onRequest = (request) => observe(request);
  const onResponse = (response) => {
    const request = response.request();
    if (!observe(request) || settled.has(request)) return;
    settled.add(request);
    const status = response.status();
    statuses[status] = (statuses[status] ?? 0) + 1;
    if (status >= 200 && status < 300) {
      counts.accepted++;
      parse(request);
    } else {
      counts.rejected++;
    }
  };
  const onFailed = (request) => {
    if (!observe(request) || settled.has(request)) return;
    settled.add(request);
    counts.failed++;
  };
  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("requestfailed", onFailed);

  function summary() {
    return { ...counts, posts: posts.size, topics: topics.size, statuses: { ...statuses } };
  }

  function stop() {
    if (!stopped) {
      stopped = true;
      page.off("request", onRequest);
      page.off("response", onResponse);
      page.off("requestfailed", onFailed);
    }
    return summary();
  }

  async function snapshot() {
    // /summary.json has a one-hour server cache. The ordinary user JSON uses
    // UserCardSerializer's direct user_stat.time_read instead.
    return page.evaluate(async (name) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch(`/u/${encodeURIComponent(name)}.json?_=${Date.now()}`, {
          credentials: "same-origin", cache: "no-store", signal: controller.signal,
          headers: { Accept: "application/json", "X-Requested-With": "XMLHttpRequest" },
        });
        if (!response.ok) throw new Error(`读取服务端阅读数据失败（HTTP ${response.status}）`);
        const body = await response.json();
        const stats = {};
        for (const key of ["time_read", "recent_time_read", "posts_read_count", "topics_entered"]) {
          const value = body.user?.[key];
          if (Number.isSafeInteger(value) && value >= 0) stats[key] = value;
        }
        if (stats.time_read === undefined) throw new Error("服务端用户数据没有可核验的 time_read");
        return {
          source: "user", cached: Number(response.headers.get("Age") ?? 0) > 0,
          status: response.status, stats,
        };
      } catch (error) {
        if (/^读取服务端阅读数据失败|^服务端用户数据没有/.test(error.message)) throw error;
        throw new Error("读取服务端阅读数据失败（请求或解析错误）");
      } finally {
        clearTimeout(timer);
      }
    }, username);
  }

  return { snapshot, summary, stop };
}
