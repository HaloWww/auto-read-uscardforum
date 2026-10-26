const branch = "like-user-state";
const filename = "like-user-rotation.json";

function storeError(message, code = "ROTATION_STORE_FAILED") {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** Keep rotation progress on its own branch; never write credentials or main. */
export function createRotationStore({
  token = process.env.GITHUB_TOKEN,
  repository = process.env.GITHUB_REPOSITORY,
  baseSha = process.env.GITHUB_SHA,
  apiUrl = process.env.GITHUB_API_URL || "https://api.github.com",
  fetch: request = globalThis.fetch,
} = {}) {
  if (!token || !/^[^/\s]+\/[^/\s]+$/.test(repository || "") ||
      !/^[0-9a-f]{40}$/i.test(baseSha || "") || typeof request !== "function") {
    throw storeError("四周轮换需要 GITHUB_TOKEN、GITHUB_REPOSITORY 和 GITHUB_SHA", "ROTATION_STORE_CONFIG");
  }
  let endpoint;
  try {
    endpoint = new URL(apiUrl);
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error();
  } catch {
    throw storeError("GITHUB_API_URL 必须是有效的 HTTPS API 地址", "ROTATION_STORE_CONFIG");
  }
  const repoPath = `${endpoint.href.replace(/\/$/, "")}/repos/${repository.split("/").map(encodeURIComponent).join("/")}`;
  let loaded = false;
  let branchExists = false;
  let sha;
  let busy = false;

  async function api(path, { method = "GET", body, allowNotFound = false } = {}) {
    let response;
    try {
      response = await request(`${repoPath}${path}`, {
        method, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15000),
        headers: {
          Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2026-03-10", "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw storeError("四周轮换状态请求失败或超时，未继续执行账号");
    }
    if (allowNotFound && response.status === 404) return null;
    if (!response.ok) {
      const hint = response.status === 401 || response.status === 403
        ? "，请确认工作流的 contents: write 权限与分支规则"
        : response.status === 409 || response.status === 422
          ? "，状态可能已被其他运行修改，请重新运行"
          : "";
      throw storeError(`四周轮换状态请求失败（HTTP ${response.status}）${hint}`,
        response.status === 409 || response.status === 422 ? "ROTATION_STORE_CONFLICT" : "ROTATION_STORE_FAILED");
    }
    try {
      return await response.json();
    } catch {
      throw storeError("四周轮换状态接口返回了无效 JSON");
    }
  }

  async function exclusive(action) {
    if (busy) throw storeError("四周轮换状态不能并行读写", "ROTATION_STORE_BUSY");
    busy = true;
    try { return await action(); } finally { busy = false; }
  }

  async function load() {
    return exclusive(async () => {
      loaded = false;
      // GitHub can disguise missing access as 404. Prove Contents read access
      // against the run's known commit before treating a state 404 as new.
      await api(`/git/commits/${baseSha}`);
      const reference = await api(`/git/ref/heads/${branch}`, { allowNotFound: true });
      branchExists = reference !== null;
      sha = undefined;
      if (!branchExists) { loaded = true; return null; }
      const file = await api(`/contents/${filename}?ref=${branch}`, { allowNotFound: true });
      if (file === null) { loaded = true; return null; }
      let state;
      try {
        if (file.type !== "file" || file.encoding !== "base64" ||
            !/^[0-9a-f]{40}$/i.test(file.sha || "") || typeof file.content !== "string") throw new Error();
        state = JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));
        if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error();
      } catch {
        throw storeError("已保存的四周轮换状态损坏，不能自动重置或重复分配账号", "ROTATION_STORE_CORRUPT");
      }
      sha = file.sha;
      loaded = true;
      return state;
    });
  }

  async function save(state) {
    return exclusive(async () => {
      if (!loaded) throw storeError("保存四周轮换进度前必须成功读取原有状态", "ROTATION_STORE_NOT_LOADED");
      let content;
      try {
        if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error();
        content = Buffer.from(`${JSON.stringify(state, null, 2)}\n`, "utf8").toString("base64");
      } catch {
        throw storeError("待保存的四周轮换状态无效", "ROTATION_STORE_CORRUPT");
      }
      let result;
      try {
        if (!branchExists) {
          await api("/git/refs", { method: "POST", body: { ref: `refs/heads/${branch}`, sha: baseSha } });
          branchExists = true;
        }
        result = await api(`/contents/${filename}`, {
          method: "PUT", body: {
            message: "Save four-week like rotation progress", branch, content,
            ...(sha ? { sha } : {}),
          },
        });
      } catch (error) {
        // The response can be lost after GitHub committed the state. Never
        // retry from stale assumptions, including after a branch creation race.
        loaded = false;
        throw error;
      }
      if (!/^[0-9a-f]{40}$/i.test(result?.content?.sha || "")) {
        // A write may have reached GitHub. Reload before any further write.
        loaded = false;
        throw storeError("四周轮换进度保存结果无法确认，请重新运行后读取状态");
      }
      sha = result.content.sha;
      return state;
    });
  }

  return { load, save };
}
