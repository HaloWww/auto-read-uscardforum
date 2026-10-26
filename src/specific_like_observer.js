const normalizeUsername = (value) => typeof value === "string" ? value.trim().toLowerCase() : "";
const positiveId = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0;

function postAction(body) {
  if (typeof body !== "string" || !body) return null;
  try {
    const values = body.trimStart().startsWith("{") ? JSON.parse(body) : Object.fromEntries(new URLSearchParams(body));
    if (Number(values.post_action_type_id) !== 2 || !positiveId(values.id)) return null;
    return Number(values.id);
  } catch {
    return null;
  }
}

function requestDetails(page, response, origin) {
  try {
    const request = response.request();
    const url = new URL(request.url());
    if (url.origin !== origin || request.frame() !== page.mainFrame()) return null;
    if (response.status() < 200 || response.status() >= 300) return null;
    if (request.method() === "POST" && /^\/post_actions(?:\.json)?\/?$/.test(url.pathname)) {
      const postId = postAction(request.postData());
      return postId ? { kind: "core", postId, request } : null;
    }
    const reaction = /^\/discourse-reactions\/posts\/(\d+)\/custom-reactions\/([^/]+)\/toggle(?:\.json)?\/?$/.exec(url.pathname);
    if (request.method() === "PUT" && reaction && positiveId(reaction[1])) {
      return { kind: "reaction", postId: Number(reaction[1]), reaction: decodeURIComponent(reaction[2]), request };
    }
  } catch {
    // A response can outlive its main frame; it cannot establish confirmation.
  }
  return null;
}

async function readMainReaction(page) {
  return page.evaluate(() => {
    try {
      const settings = window.Discourse?.__container__?.lookup("service:site-settings");
      if (typeof settings?.discourse_reactions_reaction_for_like === "string") {
        return settings.discourse_reactions_reaction_for_like;
      }
    } catch { /* Older/isolated contexts can still read the public bootstrap. */ }
    try {
      const element = document.querySelector("#data-preloaded");
      const raw = element?.getAttribute("data-preloaded") || element?.textContent;
      const preload = JSON.parse(raw || "null");
      const settings = typeof preload?.siteSettings === "string" ? JSON.parse(preload.siteSettings) : preload?.siteSettings;
      return typeof settings?.discourse_reactions_reaction_for_like === "string"
        ? settings.discourse_reactions_reaction_for_like : null;
    } catch { return null; }
  });
}

async function bounded(operation, timeoutMillis, message) {
  let timer;
  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMillis); }),
    ]);
  } finally { clearTimeout(timer); }
}

// Official PostSerializer responses are the evidence, not a click or HTTP 2xx:
// core app/controllers/post_actions_controller.rb and
// plugins/discourse-reactions/app/controllers/discourse_reactions/custom_reactions_controller.rb.
export function createSpecificLikeObserver(page, {
  targetUser, onConfirmed, origin: configuredOrigin, getMainReaction = readMainReaction, responseTimeoutMillis = 15000,
}) {
  const target = normalizeUsername(targetUser);
  if (!target) throw new Error("特定用户点赞观察器需要 targetUser");
  if (typeof onConfirmed !== "function") throw new TypeError("onConfirmed must be a function");
  if (!Number.isFinite(responseTimeoutMillis) || responseTimeoutMillis <= 0) throw new RangeError("responseTimeoutMillis must be positive");
  let origin;
  try {
    const url = new URL(configuredOrigin || page.url());
    if (!["http:", "https:"].includes(url.protocol)) throw new Error();
    origin = url.origin;
  } catch {
    throw new Error("特定用户点赞观察器需要有效的 HTTP(S) 论坛 origin");
  }
  const seen = new WeakSet();
  let stopped = false;
  let confirmed = false;
  let error = null;
  let pending = Promise.resolve();

  async function inspect(response, details) {
    if (confirmed || error) return;
    let post;
    try {
      post = await bounded(() => response.json(), responseTimeoutMillis, "点赞响应读取超时，未更新轮换进度");
    } catch {
      throw new Error("点赞响应无法解析，未更新轮换进度");
    }
    if (!post || typeof post !== "object" || Array.isArray(post) || post.success === false ||
        post.failed || post.error || (Array.isArray(post.errors) ? post.errors.length : post.errors)) return;
    if (Number(post.id) !== details.postId || normalizeUsername(post.username) !== target) return;
    if (details.kind === "core") {
      if (!Array.isArray(post.actions_summary) ||
          !post.actions_summary.some((action) => action?.id === 2 && action.acted === true)) return;
    } else {
      const reaction = post.current_user_reaction;
      if (!reaction || reaction.type !== "emoji" || reaction.id !== details.reaction) return;
      if (Object.hasOwn(post, "current_user_used_main_reaction")) {
        if (post.current_user_used_main_reaction !== true) return;
      } else {
        const mainReaction = await bounded(() => getMainReaction(page), responseTimeoutMillis,
          "无法读取论坛主反应配置，未更新轮换进度");
        if (typeof mainReaction !== "string" || !mainReaction || details.reaction !== mainReaction) return;
      }
    }
    confirmed = true;
    await onConfirmed({ postId: details.postId, kind: details.kind });
  }

  const onResponse = (response) => {
    if (stopped || confirmed || error) return;
    const details = requestDetails(page, response, origin);
    if (!details || seen.has(details.request)) return;
    seen.add(details.request);
    // Keep the event listener synchronous and handle its promises here. The
    // caller must await flush() so persistence failures become task failures.
    pending = pending.then(() => inspect(response, details)).catch((failure) => { error ??= failure; });
  };
  page.on("response", onResponse);

  const api = {
    get confirmed() { return confirmed; },
    get error() { return error; },
    stop() {
      if (!stopped) {
        stopped = true;
        page.off("response", onResponse);
      }
      return api;
    },
    async flush() {
      let current;
      do { current = pending; await current; } while (current !== pending);
      if (error) throw error;
      return confirmed;
    },
  };
  return api;
}
