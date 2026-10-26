import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { connect } from "puppeteer-real-browser";
import { prepareLikeRotation } from "./like_rotation.js";
import { getRotationAccountId } from "./weekly_rotation.js";
import { runAccountBatches } from "./account_runner.js";
import { startReader } from "./reader_session.js";
import { createSpecificLikeObserver } from "./specific_like_observer.js";

const accounts = Array.from({ length: 6 }, (_, index) => ({ username: `fixture-${index}`, password: ` password-${index} ` }));
const baseTime = Date.UTC(2026, 9, 26);
function memoryStore() {
  let state = null;
  return {
    async load() { return structuredClone(state); },
    async save(next) { state = structuredClone(next); },
  };
}

test("the scheduler launches only the weekly draw across all four weeks and same-week retries launch none", async () => {
  const store = memoryStore();
  const launched = [];
  for (let week = 0; week < 4; week++) {
    const options = { store, origin: "https://forum.test", targetUser: "target", now: baseTime + week * 7 * 86400000, random: () => 0.3 };
    const rotation = await prepareLikeRotation(accounts, options);
    const thisWeek = [];
    let clock = 0;
    await runAccountBatches(rotation.plan.selectedAccounts, {
      maxConcurrentAccounts: 3, delayBetweenInstances: 0, runTimeMillis: 60000,
      now: () => clock, sleep: async (ms) => { clock += ms; }, close: async () => {},
      launch: async (account) => {
        assert.equal(account, accounts.find((original) => original.username === account.username));
        assert.ok(account.password.startsWith(" ") && account.password.endsWith(" "));
        thisWeek.push(account.username);
        await rotation.complete(getRotationAccountId(account, options.origin));
        return account;
      },
    });
    await rotation.flush();
    launched.push(thisWeek);
    assert.deepEqual((await prepareLikeRotation(accounts, options)).plan.selectedAccounts, []);
  }
  assert.deepEqual(launched.map((week) => week.length), [2, 2, 1, 1]);
  assert.equal(new Set(launched.flat()).size, 6);
});

test("one real-browser fixture account is completed only after the production script's target-author PUT response", { timeout: 40000 }, async (t) => {
  let reactionRequests = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://fixture");
    if (url.pathname === "/search") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ posts: url.searchParams.get("page") === "1" ? [{ topic_id: 2, post_number: 4 }] : [] }));
      return;
    }
    if (url.pathname === "/discourse-reactions/posts/22/custom-reactions/heart/toggle" && request.method === "PUT") {
      for await (const _ of request) { /* drain the real browser request */ }
      reactionRequests++;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ id: 22, username: "target", current_user_reaction: { id: "heart", type: "emoji" }, current_user_used_main_reaction: true }));
      return;
    }
    const targeted = url.pathname.startsWith("/t/topic/2/");
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<!doctype html><style>body{margin:0}article{height:${targeted ? 2200 : 80}px}</style>
      <header class="d-header"><button id="current-user">Fixture account</button></header>
      <article id="post_${targeted ? 4 : 1}" data-post-number="${targeted ? 4 : 1}">
        <button class="discourse-reactions-reaction-button" title="Like this post">Like</button>
      </article><script>document.addEventListener('click',async event=>{
        if(!event.target.matches('.discourse-reactions-reaction-button'))return;
        await fetch('/discourse-reactions/posts/22/custom-reactions/heart/toggle',{method:'PUT'});
        event.target.title='Unlike this post';
      });</script>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const chromePath = [process.env.PUPPETEER_EXECUTABLE_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ].find((path) => path && existsSync(path));
  const { browser, page } = await connect({
    headless: "new", customConfig: chromePath ? { chromePath } : {},
    connectOption: { protocolTimeout: 15000 },
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--no-proxy-server"],
  });
  t.after(async () => browser.close());
  const store = memoryStore();
  const options = { origin, targetUser: "target", store, now: baseTime, random: () => 0.3 };
  const rotation = await prepareLikeRotation(accounts, options);
  const account = rotation.plan.selectedAccounts[0];
  const accountId = getRotationAccountId(account, origin);
  let consoleEvents = 0;
  page.on("console", () => consoleEvents++);
  const observer = createSpecificLikeObserver(page, { origin, targetUser: "target", onConfirmed: () => rotation.complete(accountId) });
  t.after(() => observer.stop());
  const source = readFileSync(new URL("../index_likeUser.js", import.meta.url), "utf8");
  await startReader(page, { source, user: "target", enabled: true, topicUrl: `${origin}/t/topic/1/1`, timeout: 10000 });
  const deadline = Date.now() + 15000;
  while (!observer.confirmed && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await observer.flush(), true);
  await rotation.flush();
  assert.equal(reactionRequests, 1);
  assert.equal(consoleEvents, 0, "the test must use the production transport without Runtime console events");
  assert.deepEqual(rotation.state.completedIds, [accountId]);
  const retry = await prepareLikeRotation(accounts, options);
  assert.equal(retry.plan.selectedAccounts.length, 1, "the other drawn account was never started and remains pending");
  assert.ok(!retry.plan.selectedIds.includes(accountId));
});
