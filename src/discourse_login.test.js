import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import puppeteer from "puppeteer";
import { isLoggedIn, loginDiscourse } from "./discourse_login.js";

let browser;

before(async () => {
  const executablePath = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ].find((candidate) => candidate && existsSync(candidate)) || puppeteer.executablePath();
  browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
});

after(async () => { await browser?.close(); });

const visitorHeader = '<header class="d-header"><div class="auth-buttons"><button>Log In</button></div></header>';
const currentUser = '<button id="current-user">Fixture user menu</button>';
const authenticatedHeader = `<header class="d-header">${currentUser}</header>`;
const topicAvatar = '<article><img class="avatar" alt="Another topic author" src="data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'32\' height=\'32\'%3E%3C/svg%3E"></article>';
const form = `<form method="post" action="/submit">
  <input id="login-account-name" name="username" value="stale username">
  <input id="login-account-password" name="password" type="password" value="stale password">
  <button id="login-button" type="submit">Log In</button>
</form>`;

// Each test owns a local server and browser page. No request or credential ever
// reaches the real forum; the fixture deliberately implements both Discourse
// login completion styles instead of mocking Puppeteer's browser APIs.
async function forum(t, mode = "ajax") {
  const state = { loginRequests: 0, submissions: [] };
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    if (request.url === "/submit" && request.method === "POST") {
      let body = "";
      for await (const chunk of request) body += chunk;
      state.submissions.push(Object.fromEntries(new URLSearchParams(body)));
      if (mode === "navigation") {
        response.writeHead(303, { location: "/signed-in" });
        response.end();
      } else {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ rejected: mode === "rejected" }));
      }
      return;
    }
    if (request.url === "/signed-in") {
      response.end(`<!doctype html>${authenticatedHeader}${topicAvatar}`);
      return;
    }
    if (request.url === "/login") {
      state.loginRequests++;
      const setup = `
        document.querySelector('form').addEventListener('submit', async (event) => {
          ${mode === "navigation" ? "return;" : "event.preventDefault();"}
          const result = await fetch('/submit', {
            method: 'POST', body: new URLSearchParams(new FormData(event.target)),
          }).then(response => response.json());
          if (result.rejected) {
            document.querySelector('form').insertAdjacentHTML('beforeend',
              '<div id="login-alert" class="alert alert-error">Incorrect username or password.</div>');
            return;
          }
          const complete = () => {
            document.querySelector('.auth-buttons').remove();
            document.querySelector('form').remove();
            ${mode === "avatar-only" ? "" : `document.querySelector('.d-header').insertAdjacentHTML('beforeend', ${JSON.stringify(currentUser)});`}
          };
          ${mode === "slow" ? "setTimeout(complete, 400);" : "complete();"}
        });
      `;
      const render = mode === "slow"
        ? `setTimeout(() => { document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(form)}); ${setup} }, 150);`
        : setup;
      response.end(`<!doctype html>${visitorHeader}${topicAvatar}${mode === "slow" ? "" : form}<script>${render}</script>`);
      return;
    }
    response.end(`<!doctype html>${mode === "already" ? authenticatedHeader : visitorHeader}${topicAvatar}`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const page = await browser.newPage();
  t.after(async () => {
    await page.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  return { state, page, url };
}

test("AJAX login submits once and succeeds without a navigation", async (t) => {
  const { page, state, url } = await forum(t);
  await loginDiscourse(page, "fixture-user", "fixture-password", { timeout: 3000 });

  assert.equal(await isLoggedIn(page), true);
  assert.equal(page.url(), `${url}/login`);
  assert.equal(state.loginRequests, 1);
  assert.deepEqual(state.submissions, [{ username: "fixture-user", password: "fixture-password" }]);
});

test("login also succeeds when the submit performs a full navigation", { timeout: 15000 }, async (t) => {
  const { page, state, url } = await forum(t, "navigation");
  await loginDiscourse(page, "fixture-user", "fixture-password", { timeout: 3000 });

  assert.equal(await isLoggedIn(page), true);
  assert.equal(page.url(), `${url}/signed-in`);
  assert.equal(state.submissions.length, 1);
});

test("a visible topic avatar never proves authentication", async (t) => {
  const { page, state } = await forum(t, "avatar-only");
  assert.ok(await page.$("img.avatar"));
  assert.ok(!(await isLoggedIn(page)));
  await assert.rejects(
    loginDiscourse(page, "fixture-user", "fixture-password", { timeout: 300, attempts: 1 }),
    { name: "TimeoutError" },
  );
  assert.equal(state.submissions.length, 1);
  assert.ok(!(await isLoggedIn(page)));
});

test("incorrect credentials are reported without retrying the submission", async (t) => {
  const { page, state } = await forum(t, "rejected");
  let retries = 0;
  await assert.rejects(
    loginDiscourse(page, "fixture-user", "fixture-password", {
      timeout: 3000,
      attempts: 3,
      onRetry: () => { retries++; },
    }),
    { code: "LOGIN_REJECTED" },
  );
  assert.equal(retries, 0);
  assert.equal(state.loginRequests, 1);
  assert.equal(state.submissions.length, 1);
});

test("login waits for delayed inputs and a delayed AJAX authentication result", async (t) => {
  const { page, state } = await forum(t, "slow");
  await loginDiscourse(page, "fixture-user", "fixture-password", { timeout: 3000 });

  assert.equal(await isLoggedIn(page), true);
  assert.equal(state.loginRequests, 1);
  assert.equal(state.submissions.length, 1);
});

test("an existing authenticated session does not open or submit the login form", async (t) => {
  const { page, state, url } = await forum(t, "already");
  await loginDiscourse(page, "fixture-user", "fixture-password", { timeout: 3000 });

  assert.equal(page.url(), `${url}/`);
  assert.equal(state.loginRequests, 0);
  assert.equal(state.submissions.length, 0);
});

test("a current-user marker alongside visible login controls is not authenticated", async (t) => {
  const { page } = await forum(t);
  await page.$eval(".d-header", (header, menu) => {
    header.insertAdjacentHTML("beforeend", menu);
  }, currentUser);
  assert.equal(await isLoggedIn(page), false);
});
