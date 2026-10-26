import { createHash } from "node:crypto";

const DAY = 86400000;
const WEEK = 7 * DAY;
const ACCOUNT_ID = /^[a-f0-9]{64}$/;
const unique = (values) => [...new Set(values)];
const digest = (value) => createHash("sha256").update(value).digest("hex");

function normalizeOrigin(origin) {
  const url = new URL(origin);
  if (!["https:", "http:"].includes(url.protocol)) throw new Error("轮换站点地址必须为 HTTP 或 HTTPS");
  return url.origin;
}

export function getShanghaiWeek(now = Date.now()) {
  const instant = typeof now === "function" ? now() : now;
  const milliseconds = instant instanceof Date ? instant.getTime() : instant;
  if (!Number.isFinite(milliseconds)) throw new Error("轮换时间无效");
  // Jan 1, 1970 was a Thursday. Adding three days puts the week boundary on
  // Monday; adding eight hours uses Shanghai calendar dates without host TZ.
  return Math.floor((milliseconds + 8 * 3600000 + 3 * DAY) / WEEK);
}

export function getRotationAccountId(accountOrUsername, origin) {
  const username = typeof accountOrUsername === "string" ? accountOrUsername : accountOrUsername?.username;
  if (typeof username !== "string" || !username.trim()) throw new Error("轮换账号用户名为空");
  return digest(JSON.stringify([normalizeOrigin(origin), username.trim().toLowerCase()]));
}

function validateState(state) {
  if (!state || typeof state !== "object" || state.version !== 1 || !ACCOUNT_ID.test(state.contextHash) ||
      !Number.isSafeInteger(state.startWeek) || !Number.isSafeInteger(state.lastWeek) ||
      state.lastWeek < state.startWeek || !Array.isArray(state.accountIds) || !Array.isArray(state.completedIds) ||
      !state.plans || typeof state.plans !== "object" || Array.isArray(state.plans)) {
    throw new Error("四周轮换进度格式无效，请检查持久化状态；不会自动清空已有进度");
  }
  for (const values of [state.accountIds, state.completedIds, ...Object.values(state.plans)]) {
    if (!Array.isArray(values) || values.some((id) => typeof id !== "string" || !ACCOUNT_ID.test(id)) ||
        unique(values).length !== values.length) {
      throw new Error("四周轮换进度包含无效或重复账号标识");
    }
  }
  const members = new Set(state.accountIds);
  if (state.completedIds.some((id) => !members.has(id)) ||
      Object.entries(state.plans).some(([week, ids]) => !/^-?\d+$/.test(week) ||
        !Number.isSafeInteger(Number(week)) || Number(week) < state.startWeek || Number(week) > state.lastWeek ||
        ids.some((id) => !members.has(id)))) {
    throw new Error("四周轮换进度中的账号或周次不一致");
  }
}

function newState(contextHash, startWeek, accountIds) {
  return { version: 1, contextHash, startWeek, lastWeek: startWeek, accountIds, completedIds: [], plans: {} };
}

function shuffled(values, random) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index--) {
    const value = random();
    if (!Number.isFinite(value) || value < 0 || value >= 1) throw new Error("轮换随机数必须在 [0, 1) 之间");
    const other = Math.floor(value * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

/** Plan one Shanghai calendar week without performing I/O or changing inputs. */
export function planWeeklyRotation(accounts, {
  state: previous = null, origin, targetUser, now = Date.now(), random = Math.random,
} = {}) {
  if (!Array.isArray(accounts) || !accounts.length) throw new Error("四周轮换至少需要一个账号");
  if (typeof targetUser !== "string" || !targetUser.trim()) throw new Error("特定点赞用户不能为空");
  if (typeof random !== "function") throw new Error("轮换随机函数无效");
  const normalizedOrigin = normalizeOrigin(origin);
  const contextHash = digest(JSON.stringify([normalizedOrigin, targetUser.trim().toLowerCase()]));
  const entries = accounts.map((account, index) => ({ account, index, id: getRotationAccountId(account, normalizedOrigin) }));
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  if (byId.size !== accounts.length) throw new Error("轮换账号重复，请检查 USERNAMES（用户名不区分大小写）");
  const accountIds = [...byId.keys()].sort();
  const weekNumber = getShanghaiWeek(now);
  let state;
  let resetReason = null;
  if (previous === null || previous === undefined) {
    state = newState(contextHash, weekNumber, accountIds);
    resetReason = "initial";
  } else {
    validateState(previous);
    if (weekNumber < previous.lastWeek) throw new Error("当前自然周早于已保存的轮换进度，不会倒退执行");
    if (previous.contextHash !== contextHash) {
      state = newState(contextHash, weekNumber, accountIds);
      resetReason = "target-changed";
    } else {
      state = {
        version: 1, contextHash, startWeek: previous.startWeek, lastWeek: previous.lastWeek,
        accountIds,
        completedIds: previous.completedIds.filter((id) => byId.has(id)),
        plans: Object.fromEntries(Object.entries(previous.plans).map(([week, ids]) => [week, ids.filter((id) => byId.has(id))])),
      };
      const elapsed = weekNumber - state.startWeek;
      const allCompleted = state.completedIds.length === accountIds.length;
      if (elapsed >= 4 && allCompleted && state.lastWeek !== weekNumber) {
        // A late catch-up must not trigger another like in the same week. Its
        // next cycle gets four fresh weeks; ordinary cycles keep their anchor.
        const startWeek = state.lastWeek >= state.startWeek + 4
          ? weekNumber : state.startWeek + Math.floor(elapsed / 4) * 4;
        state = newState(contextHash, startWeek, accountIds);
        resetReason = "cycle-complete";
      }
    }
  }

  const elapsed = weekNumber - state.startWeek;
  const overdue = elapsed >= 4;
  const weekIndex = Math.min(4, elapsed + 1);
  const weeksRemaining = Math.max(1, 4 - elapsed);
  const completed = new Set(state.completedIds);
  const pending = accountIds.filter((id) => !completed.has(id));
  const previousPlan = state.plans[String(weekNumber)];
  let plan;
  if (previousPlan) {
    plan = [...previousPlan];
    if (weeksRemaining === 1) {
      // New accounts added in the last week must not miss the whole cycle.
      plan.push(...pending.filter((id) => !plan.includes(id)));
    }
  } else {
    const count = Math.ceil(pending.length / weeksRemaining);
    plan = shuffled(pending, random).slice(0, count);
  }
  state = { ...state, lastWeek: weekNumber, plans: { ...state.plans, [weekNumber]: plan } };
  const selectedIds = plan.filter((id) => !completed.has(id));
  const selected = selectedIds.map((id) => byId.get(id));
  return {
    state, selectedIds,
    selectedAccounts: selected.map((entry) => entry.account),
    selectedIndexes: selected.map((entry) => entry.index),
    weekNumber, weekIndex, weeksRemaining, total: accounts.length,
    completed: completed.size, overdue, resetReason,
  };
}

/** Mark only confirmed successful likes; failures remain available for retry. */
export function markRotationCompleted(previous, successfulIds) {
  validateState(previous);
  if (!Array.isArray(successfulIds) || successfulIds.some((id) => typeof id !== "string")) {
    throw new Error("轮换成功账号标识无效");
  }
  const planned = new Set(previous.plans[String(previous.lastWeek)] || []);
  if (successfulIds.some((id) => !planned.has(id))) throw new Error("不能将本周未安排的账号标记为点赞完成");
  return {
    version: 1, contextHash: previous.contextHash, startWeek: previous.startWeek, lastWeek: previous.lastWeek,
    accountIds: [...previous.accountIds],
    completedIds: unique([...previous.completedIds, ...successfulIds]).sort(),
    plans: Object.fromEntries(Object.entries(previous.plans).map(([week, ids]) => [week, [...ids]])),
  };
}
