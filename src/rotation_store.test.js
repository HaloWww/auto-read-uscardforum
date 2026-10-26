import test from "node:test";
import assert from "node:assert/strict";
import { createRotationStore } from "./rotation_store.js";

const baseSha = "1".repeat(40);
const oldSha = "2".repeat(40);
const nextSha = "3".repeat(40);
const state = { version: 1, cycle: { startWeek: 123, completed: ["anonymous-account-id"] } };
const file = (value = state, sha = oldSha) => ({
  type: "file", encoding: "base64", sha,
  content: Buffer.from(JSON.stringify(value)).toString("base64"),
});
const response = (status, body = {}) => new Response(JSON.stringify(body), { status });

function fixture(answers) {
  const calls = [];
  const store = createRotationStore({
    token: "private-token-never-log", repository: "owner/forum", baseSha,
    fetch: async (url, options) => {
      calls.push({ url, ...options, body: options.body && JSON.parse(options.body) });
      assert.ok(answers.length, "unexpected request");
      const answer = answers.shift();
      if (answer instanceof Error) throw answer;
      return typeof answer === "function" ? answer(url, options) : answer;
    },
  });
  return { store, calls, answers };
}

test("first save creates only the state branch and persists base64 JSON", async () => {
  const { store, calls, answers } = fixture([
    response(200), response(404), response(201), response(201, { content: { sha: nextSha } }),
  ]);
  assert.equal(await store.load(), null);
  assert.equal(calls.length, 2, "reading missing progress must not create anything");
  await store.save(state);
  assert.equal(answers.length, 0);
  assert.deepEqual(calls[2].body, { ref: "refs/heads/like-user-state", sha: baseSha });
  assert.equal(calls[3].method, "PUT");
  assert.equal(calls[3].body.branch, "like-user-state");
  assert.equal(calls[3].body.sha, undefined);
  assert.deepEqual(JSON.parse(Buffer.from(calls[3].body.content, "base64").toString()), state);
  assert.equal(calls[0].headers.Authorization, "Bearer private-token-never-log");
  assert.ok(calls.every((call) => call.signal instanceof AbortSignal && call.redirect === "error" && call.cache === "no-store"));
  assert.ok(calls.every((call) => !call.url.includes("private-token")));
});

test("existing progress reads the dedicated branch and saves using the current blob sha", async () => {
  const { store, calls } = fixture([
    response(200), response(200), response(200, file()),
    response(200, { content: { sha: nextSha } }), response(200, { content: { sha: "4".repeat(40) } }),
  ]);
  assert.deepEqual(await store.load(), state);
  assert.match(calls[2].url, /contents\/like-user-rotation\.json\?ref=like-user-state$/);
  await store.save({ ...state, changed: 1 });
  await store.save({ ...state, changed: 2 });
  assert.equal(calls[3].body.sha, oldSha);
  assert.equal(calls[4].body.sha, nextSha);
  assert.equal(calls.filter((call) => call.method === "POST").length, 0);
});

test("a state branch created before an interrupted first save can receive its missing file", async () => {
  const { store, calls } = fixture([
    response(200), response(200), response(404), response(201, { content: { sha: nextSha } }),
  ]);
  assert.equal(await store.load(), null);
  await store.save(state);
  assert.equal(calls.length, 4);
  assert.equal(calls[3].body.sha, undefined);
});

test("missing access is never treated as a new rotation and secrets are absent from errors", async () => {
  for (const status of [401, 403, 404]) {
    const { store, calls } = fixture([response(status, { message: "private-token-never-log hidden body" })]);
    await assert.rejects(store.load(), (error) => {
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert.doesNotMatch(error.message, /private-token|hidden body/);
      return true;
    });
    await assert.rejects(store.save(state), { code: "ROTATION_STORE_NOT_LOADED" });
    assert.equal(calls.length, 1);
  }
});

test("branch and file permission errors cannot reset existing progress", async () => {
  for (const answers of [
    [response(200), response(403)],
    [response(200), response(200), response(403)],
  ]) {
    const { store } = fixture(answers);
    await assert.rejects(store.load(), /HTTP 403/);
    await assert.rejects(store.save(state), { code: "ROTATION_STORE_NOT_LOADED" });
  }
});

test("corrupt stored JSON, file metadata and non-object state fail without being overwritten", async () => {
  for (const invalid of [
    { ...file(), content: Buffer.from("{broken").toString("base64") },
    { ...file(), encoding: "none" },
    file(null), file([]), file("text"),
  ]) {
    const { store, calls } = fixture([response(200), response(200), response(200, invalid)]);
    await assert.rejects(store.load(), { code: "ROTATION_STORE_CORRUPT" });
    await assert.rejects(store.save(state), { code: "ROTATION_STORE_NOT_LOADED" });
    assert.equal(calls.length, 3);
  }
});

test("concurrent branch creation and stale blob writes fail instead of retrying an overwrite", async () => {
  const first = fixture([response(200), response(404), response(422)]);
  await first.store.load();
  await assert.rejects(first.store.save(state), { code: "ROTATION_STORE_CONFLICT" });
  await assert.rejects(first.store.save(state), { code: "ROTATION_STORE_NOT_LOADED" });
  assert.equal(first.calls.length, 3);
  const second = fixture([response(200), response(200), response(200, file()), response(409)]);
  await second.store.load();
  await assert.rejects(second.store.save(state), { code: "ROTATION_STORE_CONFLICT" });
  await assert.rejects(second.store.save(state), { code: "ROTATION_STORE_NOT_LOADED" });
  assert.equal(second.calls.length, 4);
});

test("network exceptions and invalid API JSON produce bounded sanitized failures", async () => {
  for (const answer of [new Error("Authorization Bearer private-token-never-log"), new Response("not json", { status: 200 })]) {
    const { store } = fixture([answer]);
    await assert.rejects(store.load(), (error) => {
      assert.equal(error.code, "ROTATION_STORE_FAILED");
      assert.doesNotMatch(error.message, /private-token|Authorization|not json/);
      return true;
    });
  }
});

test("ambiguous write responses require reloading before another save", async () => {
  const { store, calls } = fixture([response(200), response(404), response(201), response(200, {})]);
  await store.load();
  await assert.rejects(store.save(state), /保存结果无法确认/);
  await assert.rejects(store.save(state), { code: "ROTATION_STORE_NOT_LOADED" });
  assert.equal(calls.length, 4);
});

test("a lost write response requires a fresh read rather than another blind mutation", async () => {
  for (const result of [new Error("private-token-never-log"), new Response("not json", { status: 200 })]) {
    const { store, calls } = fixture([response(200), response(200), response(200, file()), result]);
    await store.load();
    await assert.rejects(store.save(state), { code: "ROTATION_STORE_FAILED" });
    await assert.rejects(store.save(state), { code: "ROTATION_STORE_NOT_LOADED" });
    assert.equal(calls.length, 4);
  }
});

test("invalid save inputs and saving without a load cannot make remote requests", async () => {
  const { store, calls } = fixture([response(200), response(404)]);
  await assert.rejects(store.save(state), { code: "ROTATION_STORE_NOT_LOADED" });
  await store.load();
  for (const invalid of [null, [], "value", 5]) {
    await assert.rejects(store.save(invalid), { code: "ROTATION_STORE_CORRUPT" });
  }
  const circular = {}; circular.self = circular;
  await assert.rejects(store.save(circular), { code: "ROTATION_STORE_CORRUPT" });
  assert.equal(calls.length, 2);
});

test("one store cannot race its own reads or writes", async () => {
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const { store, calls } = fixture([async () => { await waiting; return response(200); }, response(404)]);
  const loading = store.load();
  await assert.rejects(store.load(), { code: "ROTATION_STORE_BUSY" });
  await assert.rejects(store.save(state), { code: "ROTATION_STORE_BUSY" });
  release();
  assert.equal(await loading, null);
  assert.equal(calls.length, 2);
});

test("configuration requires a token, repository, known commit and HTTPS endpoint", () => {
  const config = { token: "token", repository: "owner/repo", baseSha, fetch: () => {} };
  for (const override of [
    { token: "" }, { repository: "missing-owner" }, { repository: "owner/repo/extra" },
    { baseSha: "unknown" }, { apiUrl: "http://insecure.test" },
    { apiUrl: "https://token@api.test" }, { apiUrl: "https://api.test?token=secret" },
  ]) assert.throws(() => createRotationStore({ ...config, ...override }), { code: "ROTATION_STORE_CONFIG" });
});
