import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createReadingEvidence } from "./reading_evidence.js";

function fixture() {
  const page = new EventEmitter();
  const frame = {};
  page.mainFrame = () => frame;
  page.url = () => "https://forum.example/t/topic/123";
  page.evaluate = (callback, arg) => callback(arg);
  const evidence = createReadingEvidence(page, "private name");
  const request = (body, overrides = {}) => ({
    url: () => "https://forum.example/topics/timings",
    method: () => "POST", frame: () => frame, postData: () => body, ...overrides,
  });
  const respond = (req, status = 200) => page.emit("response", {
    request: () => req, status: () => status,
  });
  return { page, evidence, request, respond };
}

test("counts only natural successful timings with unique topic/post evidence", () => {
  const { page, evidence, request, respond } = fixture();
  const first = request("topic_id=123&topic_time=22000&timings%5B1%5D=5000&timings%5B2%5D=3000");
  page.emit("request", first);
  respond(first);
  respond(first); // duplicate response notifications must not double count
  respond(request(JSON.stringify({ topic_id: 123, topic_time: 4000, timings: { 2: 4000, 3: 1000 } })));
  respond(request("topic_time=1000&timings%5B1%5D=1000", {
    url: () => "https://forum.example/t/456/timings.json",
  }), 204);
  assert.deepEqual(evidence.summary(), {
    requests: 3, accepted: 3, rejected: 0, failed: 0, parsed: 3,
    topicTimeMillis: 27000, posts: 4, topics: 2, statuses: { 200: 2, 204: 1 },
  });
  evidence.stop();
});

test("rejects unrelated requests and does not count rejected/failed requests as read", () => {
  const { page, evidence, request, respond } = fixture();
  const body = "topic_id=123&topic_time=22000&timings%5B1%5D=5000";
  respond(request(body, { url: () => "https://ads.example/topics/timings" }));
  respond(request(body, { frame: () => ({}) }));
  respond(request(body, { method: () => "GET" }));
  respond(request(body, { url: () => "https://forum.example/post_actions" }));
  respond(request(body), 429);
  const failed = request(body);
  page.emit("requestfailed", failed);
  page.emit("requestfailed", failed);
  assert.deepEqual(evidence.summary(), {
    requests: 2, accepted: 0, rejected: 1, failed: 1, parsed: 0,
    topicTimeMillis: 0, posts: 0, topics: 0, statuses: { 429: 1 },
  });
  evidence.stop();
});

test("malformed payload is not fabricated evidence and stop detaches all listeners", () => {
  const { page, evidence, request, respond } = fixture();
  respond(request("{broken"));
  respond(request("topic_id=123&topic_time=NaN&timings%5B1%5D=5000"));
  respond(request("topic_id=123&topic_time=1000&timings%5B-1%5D=999&timings%5B2%5D=-5"));
  const result = evidence.stop();
  assert.equal(result.accepted, 3);
  assert.equal(result.parsed, 1);
  assert.equal(result.posts, 0);
  assert.equal(result.topicTimeMillis, 1000);
  respond(request("topic_id=123&topic_time=1000"));
  assert.deepEqual(evidence.stop(), result);
  for (const event of ["request", "response", "requestfailed"]) assert.equal(page.listenerCount(event), 0);
});

test("snapshot reads fresh ordinary user JSON and returns only numeric public statistics", async () => {
  const { evidence } = fixture();
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.match(url, /^\/u\/private%20name\.json\?_=/);
    assert.equal(options.credentials, "same-origin");
    assert.equal(options.cache, "no-store");
    return new Response(JSON.stringify({ user: {
      username: "secret", email: "private@example.com", user_auth_tokens: ["secret"],
      time_read: 600, recent_time_read: 120, posts_read_count: 3,
      topics_entered: "invalid", password: "private",
    } }), { status: 200 });
  };
  try {
    assert.deepEqual(await evidence.snapshot(), {
      source: "user", cached: false, status: 200,
      stats: { time_read: 600, recent_time_read: 120, posts_read_count: 3 },
    });
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
    evidence.stop();
  }
});

test("snapshot detects intermediary cached responses", async () => {
  const { evidence } = fixture();
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ user: { time_read: 1 } }), {
    headers: { Age: "20" },
  });
  try { assert.equal((await evidence.snapshot()).cached, true); }
  finally { globalThis.fetch = original; evidence.stop(); }
});

test("snapshot failures are explicit and never return private server content", async () => {
  const { evidence } = fixture();
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("private response", { status: 403 });
    await assert.rejects(evidence.snapshot(), /HTTP 403/);
    globalThis.fetch = async () => new Response(JSON.stringify({ user: { email: "private" } }));
    await assert.rejects(evidence.snapshot(), /没有可核验的 time_read/);
    globalThis.fetch = async () => { throw new Error("secret URL and token"); };
    await assert.rejects(evidence.snapshot(), /请求或解析错误/);
  } finally { globalThis.fetch = original; evidence.stop(); }
});
