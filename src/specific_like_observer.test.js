import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createSpecificLikeObserver } from "./specific_like_observer.js";

function fixture(options = {}) {
  const page = new EventEmitter();
  const frame = {};
  page.url = () => options.pageUrl || "https://forum.example/t/topic/7/1";
  page.mainFrame = () => frame;
  page.evaluate = (callback) => callback();
  const completions = [];
  const observer = createSpecificLikeObserver(page, {
    targetUser: " TargetUser ", onConfirmed: async (proof) => completions.push(proof), ...options,
  });
  const response = (post, overrides = {}) => {
    const request = {
      url: () => "https://forum.example/discourse-reactions/posts/123/custom-reactions/heart/toggle",
      method: () => "PUT", frame: () => frame, postData: () => "", ...overrides.request,
    };
    return { request: () => request, status: () => 200, json: async () => post, ...overrides.response };
  };
  return { page, observer, completions, response };
}

const likedReaction = (overrides = {}) => ({
  id: 123, username: "targetuser", current_user_reaction: { id: "heart", type: "emoji", can_undo: true },
  current_user_used_main_reaction: true, ...overrides,
});
const likedCore = (overrides = {}) => ({
  id: 123, username: "TARGETUSER", actions_summary: [{ id: 2, count: 8, acted: true }], ...overrides,
});
const coreRequest = (overrides = {}) => ({
  url: () => "https://forum.example/post_actions.json", method: () => "POST",
  postData: () => "id=123&post_action_type_id=2", ...overrides,
});

test("confirms a main reaction only from the target author's successful official PUT response", async () => {
  const { page, observer, completions, response } = fixture();
  page.emit("response", response(likedReaction()));
  assert.equal(observer.confirmed, false, "dispatching an event does not itself confirm anything");
  assert.equal(await observer.flush(), true);
  assert.equal(observer.confirmed, true);
  assert.equal(observer.error, null);
  assert.deepEqual(completions, [{ postId: 123, kind: "reaction" }]);
  observer.stop();
});

test("core likes require a matching request action, post ID and explicit acted true", async () => {
  for (const body of ["id=123&post_action_type_id=2", JSON.stringify({ id: 123, post_action_type_id: 2 })]) {
    const { page, observer, completions, response } = fixture();
    page.emit("response", response(likedCore(), { request: coreRequest({ postData: () => body }) }));
    assert.equal(await observer.flush(), true);
    assert.deepEqual(completions, [{ postId: 123, kind: "core" }]);
    observer.stop();
  }
});

test("non-main reactions, toggles off, generic success and rejected JSON never complete", async () => {
  const variants = [
    likedReaction({ current_user_reaction: null }),
    likedReaction({ current_user_used_main_reaction: false }),
    likedReaction({ current_user_reaction: { id: "laughing", type: "emoji" } }),
    likedReaction({ current_user_reaction: { id: "heart", type: "unknown" } }),
    likedReaction({ errors: ["rejected"] }), likedReaction({ error: "rejected" }),
    likedReaction({ success: false }), likedReaction({ failed: "FAILED" }),
    likedReaction({ id: 999 }), likedReaction({ username: "another-user" }),
    { success: "OK" }, {}, null,
  ];
  for (const variant of variants) {
    const { page, observer, completions, response } = fixture();
    page.emit("response", response(variant));
    assert.equal(await observer.flush(), false);
    assert.equal(completions.length, 0);
    observer.stop();
  }
});

test("core unlikes, other actions and positive counts alone do not establish a like", async () => {
  const variants = [
    [likedCore({ actions_summary: [{ id: 2, count: 9 }] }), coreRequest()],
    [likedCore({ actions_summary: [{ id: 2, acted: false }] }), coreRequest()],
    [likedCore(), coreRequest({ method: () => "DELETE" })],
    [likedCore(), coreRequest({ postData: () => "id=123&post_action_type_id=3" })],
    [likedCore(), coreRequest({ postData: () => "id=999&post_action_type_id=2" })],
    [likedCore(), coreRequest({ postData: () => "{broken" })],
  ];
  for (const [post, request] of variants) {
    const { page, observer, response } = fixture();
    page.emit("response", response(post, { request }));
    assert.equal(await observer.flush(), false);
    observer.stop();
  }
});

test("foreign origins, child frames, reads and HTTP rejection are ignored without parsing", async () => {
  const variants = [
    { request: { url: () => "https://other.example/discourse-reactions/posts/123/custom-reactions/heart/toggle" } },
    { request: { frame: () => ({}) } }, { request: { method: () => "POST" } },
    { request: { method: () => "GET" } },
    { request: { method: () => "POST", url: () => "https://forum.example/topics/timings" } },
    { response: { status: () => 429 } }, { response: { status: () => 403 } },
    { response: { status: () => 302 } },
  ];
  for (const variant of variants) {
    const { page, observer, response } = fixture();
    const data = response(likedReaction(), variant);
    data.json = () => assert.fail("unrelated/rejected responses must not be parsed");
    page.emit("response", data);
    assert.equal(await observer.flush(), false);
    observer.stop();
  }
});

test("old plugin versions must match the configured main reaction rather than assuming heart", async () => {
  for (const [main, expected] of [["heart", true], ["+1", false], [null, false]]) {
    const { page, observer, response } = fixture({ getMainReaction: async () => main });
    const post = likedReaction();
    delete post.current_user_used_main_reaction;
    page.emit("response", response(post));
    assert.equal(await observer.flush(), expected);
    observer.stop();
  }
  const { page, observer, response } = fixture({ getMainReaction: async () => "+1" });
  const post = likedReaction({ current_user_reaction: { id: "+1", type: "emoji" } });
  delete post.current_user_used_main_reaction;
  page.emit("response", response(post, { request: {
    url: () => "https://forum.example/discourse-reactions/posts/123/custom-reactions/%2B1/toggle.json",
  } }));
  assert.equal(await observer.flush(), true);
  observer.stop();
});

test("default legacy lookup reads public old and new Discourse bootstrap formats", async () => {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  try {
    globalThis.window = {};
    for (const attribute of [true, false]) {
      const payload = JSON.stringify({ siteSettings: JSON.stringify({ discourse_reactions_reaction_for_like: "heart" }) });
      globalThis.document = { querySelector: () => ({ getAttribute: () => attribute ? payload : null, textContent: attribute ? "" : payload }) };
      const { page, observer, response } = fixture();
      const post = likedReaction(); delete post.current_user_used_main_reaction;
      page.emit("response", response(post));
      assert.equal(await observer.flush(), true);
      observer.stop();
    }
  } finally {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  }
});

test("duplicate and simultaneous confirmations invoke persistent completion only once", async () => {
  let release;
  let calls = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const { page, observer, response } = fixture({ onConfirmed: async () => { calls++; await gate; } });
  const data = response(likedReaction());
  page.emit("response", data); page.emit("response", data);
  page.emit("response", response(likedReaction()));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(observer.confirmed, true);
  assert.equal(calls, 1);
  let flushed = false;
  const flushing = observer.flush().then(() => { flushed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(flushed, false);
  release();
  await flushing;
  assert.equal(calls, 1);
  observer.stop();
});

test("persistence failures remain visible and flush rejects instead of losing progress errors", async () => {
  const expected = new Error("state branch write failed");
  const { page, observer, response } = fixture({ onConfirmed: async () => { throw expected; } });
  page.emit("response", response(likedReaction()));
  await assert.rejects(observer.flush(), (error) => error === expected);
  assert.equal(observer.confirmed, true);
  assert.equal(observer.error, expected);
  observer.stop();
});

test("stop prevents new observations but flush finishes already received responses", async () => {
  let resolveBody;
  const body = new Promise((resolve) => { resolveBody = resolve; });
  const { page, observer, response, completions } = fixture();
  page.emit("response", response(null, { response: { json: () => body } }));
  observer.stop();
  page.emit("response", response(likedReaction()));
  assert.equal(page.listenerCount("response"), 0);
  resolveBody(likedReaction());
  assert.equal(await observer.flush(), true);
  assert.equal(completions.length, 1);
  observer.stop();
});

test("unreadable or hanging successful response fails safely without exposing its body", async () => {
  for (const json of [async () => { throw new Error("sensitive raw body"); }, () => new Promise(() => {})]) {
    const { page, observer, response, completions } = fixture({ responseTimeoutMillis: 10 });
    page.emit("response", response(null, { response: { json } }));
    await assert.rejects(observer.flush(), /点赞响应无法解析/);
    assert.equal(observer.confirmed, false);
    assert.equal(observer.error.message.includes("sensitive"), false);
    assert.equal(completions.length, 0);
    observer.stop();
  }
});

test("missing target or completion callback is rejected before listening", () => {
  assert.throws(() => fixture({ targetUser: "" }), /targetUser/);
  assert.throws(() => fixture({ onConfirmed: null }), /onConfirmed/);
});

test("a recovered about:blank page uses the explicit forum origin before navigation", async () => {
  const { page, observer, response } = fixture({ pageUrl: "about:blank", origin: "https://forum.example" });
  page.emit("response", response(likedReaction()));
  assert.equal(await observer.flush(), true);
  observer.stop();
});

test("non-HTTP origins cannot silently disable confirmation on a recovered page", () => {
  for (const origin of ["about:blank", "file:///tmp/forum", "javascript:alert(1)", "not-a-url"]) {
    assert.throws(() => fixture({ origin }), /有效的 HTTP\(S\) 论坛 origin/);
  }
  assert.throws(() => fixture({ pageUrl: "about:blank" }), /有效的 HTTP\(S\) 论坛 origin/);
});
