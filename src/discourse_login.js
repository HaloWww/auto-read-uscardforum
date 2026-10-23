const accountSelector = "#current-user, .header-dropdown-toggle.current-user";

// Only the current user's header menu proves authentication. Topic avatars also
// exist for visitors and must never be used as a login success signal.
function loginState(selector) {
  const visible = (el) => el && el.getClientRects().length > 0;
  if (visible(document.querySelector(selector)) &&
      !Array.from(document.querySelectorAll(".d-header .auth-buttons")).some(visible)) {
    return "success";
  }
  const error = Array.from(document.querySelectorAll(
    "#login-alert, .login-modal .alert-error, .login-fullpage .alert-error, .alert.alert-error"
  )).find((el) => visible(el) && el.textContent.trim());
  if (error) return "rejected";
  if (visible(document.querySelector("#second-factor, #login-second-factor, .second-factor"))) {
    return "second-factor";
  }
  return false;
}

export async function isLoggedIn(page) {
  return (await page.evaluate(loginState, accountSelector)) === "success";
}

async function waitForLogin(page, timeout) {
  const deadline = Date.now() + timeout;
  // Poll from Node, using the same evaluation path as isLoggedIn. The patched
  // Puppeteer transport can leave an in-page waitForFunction attached to the
  // old execution context after Discourse replaces the document on login.
  while (Date.now() < deadline) {
    try {
      const state = await page.evaluate(loginState, accountSelector);
      if (state) return state;
    } catch (error) {
      if (!/execution context was destroyed|cannot find context|context.*not found/i.test(error.message)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const error = new Error(`登录状态等待超时 (${timeout}ms)`);
  error.name = "TimeoutError";
  throw error;
}

export async function loginDiscourse(page, username, password, {
  timeout = 60000,
  attempts = 3,
  onRetry = () => {},
} = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      if (await isLoggedIn(page)) return;
      // Discourse's login route works even when the home page's button has not
      // rendered yet, and does not require clicking a reaction on a topic.
      await page.goto(new URL("/login", page.url()).href, {
        waitUntil: "domcontentloaded", timeout,
      });
      if (await isLoggedIn(page)) return;
      for (const [selector, value] of [
        ["#login-account-name", username],
        ["#login-account-password", password],
      ]) {
        await page.waitForSelector(selector, { visible: true, timeout });
        await page.$eval(selector, (input) => {
          input.value = "";
          input.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await page.type(selector, value, { delay: 40 });
      }
      await page.waitForSelector("#login-button", { visible: true, timeout });

      // Authentication leaves a persistent DOM state; it does not require a
      // second click or a navigation event. Node polling also survives the
      // real-browser transport's execution-context patches.
      await page.click("#login-button");
      const status = await waitForLogin(page, timeout);
      if (status === "success") return;
      const error = new Error(status === "second-factor"
        ? "登录需要二次验证，请在浏览器完成验证后再运行"
        : "网站拒绝登录，请检查对应账号的密码、验证要求或访问限制");
      error.code = "LOGIN_REJECTED";
      throw error;
    } catch (error) {
      // Do not repeatedly submit credentials rejected by the server.
      if (error.code === "LOGIN_REJECTED") throw error;
      if (await isLoggedIn(page).catch(() => false)) return;
      if (attempt === attempts) throw error;
      await onRetry(attempt, error);
    }
  }
}
