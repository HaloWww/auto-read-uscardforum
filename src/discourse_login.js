const accountSelector = "#current-user, .header-dropdown-toggle.current-user";

// Only the current user's header menu proves authentication. Topic avatars also
// exist for visitors and must never be used as a login success signal.
export async function isLoggedIn(page) {
  return page.evaluate((selector) => {
    const visible = (el) => el && el.getClientRects().length > 0;
    return Boolean(visible(document.querySelector(selector)) &&
      !Array.from(document.querySelectorAll(".d-header .auth-buttons")).some(visible));
  }, accountSelector);
}

export async function loginDiscourse(page, username, password, {
  timeout = 60000,
  attempts = 3,
  onRetry = () => {},
} = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
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

      // Start observing before the single submit. AJAX logins need not trigger
      // navigation; polling survives a full navigation as well.
      const outcome = page.waitForFunction((selector) => {
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
      }, { timeout, polling: 100, signal: controller.signal }, accountSelector);
      // Attach a handler immediately so a failed click cannot leave an
      // unhandled timeout rejection behind.
      const observed = outcome.then(async (handle) => {
        try { return { status: await handle.jsonValue() }; }
        finally { await handle.dispose(); }
      }).catch((error) => ({ error }));
      await page.click("#login-button");
      const result = await observed;
      if (result.error) throw result.error;
      if (result.status === "success") return;
      const error = new Error(result.status === "second-factor"
        ? "登录需要二次验证，请在浏览器完成验证后再运行"
        : "网站拒绝登录，请检查对应账号的密码、验证要求或访问限制");
      error.code = "LOGIN_REJECTED";
      throw error;
    } catch (error) {
      // Do not repeatedly submit credentials rejected by the server.
      if (error.code === "LOGIN_REJECTED" || attempt === attempts) throw error;
      await onRetry(attempt, error);
    } finally {
      controller.abort();
    }
  }
}
