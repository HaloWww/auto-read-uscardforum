import assert from "node:assert/strict";
import test from "node:test";
import { getShanghaiWeek, getRotationAccountId, planWeeklyRotation, markRotationCompleted } from "./weekly_rotation.js";

const origin = "https://forum.example";
const targetUser = "target-user";
const firstMonday = Date.parse("2026-10-25T16:00:00Z");
const week = 7 * 86400000;
const accounts = (count) => Array.from({ length: count }, (_, index) => ({ username: `account-${index + 1}`, password: ` secret ${index + 1} ` }));
const options = (index = 0, state = null) => ({ origin, targetUser, now: firstMonday + index * week, state, random: () => 0.31 });

for (const [count, sizes] of [[8, [2, 2, 2, 2]], [6, [2, 2, 1, 1]], [5, [2, 1, 1, 1]],
  [4, [1, 1, 1, 1]], [3, [1, 1, 1, 0]], [2, [1, 1, 0, 0]], [1, [1, 0, 0, 0]]]) {
  test(`${count} accounts are distributed ${sizes.join("/")} with complete non-overlapping coverage`, () => {
    const configured = accounts(count);
    let state;
    const seen = new Set();
    for (let index = 0; index < 4; index++) {
      const result = planWeeklyRotation(configured, options(index, state));
      assert.equal(result.selectedAccounts.length, sizes[index]);
      assert.equal(result.weekIndex, index + 1);
      assert.equal(result.weeksRemaining, 4 - index);
      for (const id of result.selectedIds) {
        assert.equal(seen.has(id), false);
        seen.add(id);
      }
      for (const [selection, account] of result.selectedAccounts.entries()) {
        assert.equal(account, configured[result.selectedIndexes[selection]], "return the original credentials without reparsing or trimming");
      }
      state = markRotationCompleted(result.state, result.selectedIds);
    }
    assert.equal(seen.size, count);
    assert.equal(state.completedIds.length, count);
    const next = planWeeklyRotation(configured, options(4, state));
    assert.equal(next.weekIndex, 1);
    assert.equal(next.completed, 0);
    assert.equal(next.selectedAccounts.length, sizes[0]);
  });
}

test("selection is random but a saved week's rerun never reshuffles or advances", () => {
  const configured = accounts(8);
  const first = planWeeklyRotation(configured, { ...options(), random: () => 0 });
  const different = planWeeklyRotation(configured, { ...options(), random: () => 0.99 });
  assert.notDeepEqual(first.selectedIds, different.selectedIds);
  const rerun = planWeeklyRotation(configured, { ...options(0, first.state), random: () => assert.fail("same-week plan must not shuffle") });
  assert.deepEqual(rerun.selectedIds, first.selectedIds);
  assert.equal(rerun.weekIndex, 1);
  const done = markRotationCompleted(first.state, first.selectedIds);
  const finishedRerun = planWeeklyRotation(configured, options(0, done));
  assert.deepEqual(finishedRerun.selectedAccounts, []);
});

test("partial success retries only failed members of the original weekly plan", () => {
  const configured = accounts(6);
  const first = planWeeklyRotation(configured, options());
  const partial = markRotationCompleted(first.state, first.selectedIds.slice(0, 1));
  const rerun = planWeeklyRotation(configured, options(0, partial));
  assert.deepEqual(rerun.selectedIds, first.selectedIds.slice(1));
  const next = planWeeklyRotation(configured, options(1, partial));
  assert.equal(next.selectedIds.length, 2, "ceil(five unfinished / three remaining weeks)");
  assert.equal(next.selectedIds.includes(first.selectedIds[0]), false);
});

test("missed weeks redistribute remaining accounts into the time left", () => {
  const configured = accounts(8);
  const first = planWeeklyRotation(configured, options());
  let state = markRotationCompleted(first.state, first.selectedIds);
  const third = planWeeklyRotation(configured, options(2, state));
  assert.equal(third.selectedIds.length, 3);
  state = markRotationCompleted(third.state, third.selectedIds);
  const fourth = planWeeklyRotation(configured, options(3, state));
  assert.equal(fourth.selectedIds.length, 3);
  state = markRotationCompleted(fourth.state, fourth.selectedIds);
  assert.equal(state.completedIds.length, 8);
});

test("overdue unfinished accounts are caught up before another cycle can start", () => {
  const configured = accounts(6);
  const first = planWeeklyRotation(configured, options());
  const partial = markRotationCompleted(first.state, first.selectedIds.slice(0, 1));
  const overdue = planWeeklyRotation(configured, options(4, partial));
  assert.equal(overdue.overdue, true);
  assert.equal(overdue.selectedIds.length, 5);
  assert.equal(overdue.state.startWeek, first.state.startWeek);
  const done = markRotationCompleted(overdue.state, overdue.selectedIds);
  assert.equal(planWeeklyRotation(configured, options(4, done)).selectedIds.length, 0);
  const next = planWeeklyRotation(configured, options(5, done));
  assert.equal(next.weekIndex, 1);
  assert.equal(next.overdue, false);
  assert.equal(next.selectedIds.length, 2);
});

test("reordering accounts and changing passwords preserve identity and completed progress", () => {
  const configured = accounts(6);
  const first = planWeeklyRotation(configured, options());
  const done = markRotationCompleted(first.state, first.selectedIds);
  const reordered = [...configured].reverse().map((account) => ({ ...account, password: "new significant password " }));
  const next = planWeeklyRotation(reordered, options(1, done));
  assert.equal(next.completed, 2);
  assert.equal(next.selectedIds.some((id) => first.selectedIds.includes(id)), false);
  assert.ok(next.selectedAccounts.every((account) => account.password === "new significant password "));
  assert.equal(getRotationAccountId("ACCOUNT-1", `${origin}/somewhere`), getRotationAccountId(configured[0], origin));
});

test("new members keep existing progress and wait for next week's draw", () => {
  const configured = accounts(6);
  const first = planWeeklyRotation(configured, options());
  const done = markRotationCompleted(first.state, first.selectedIds);
  const expanded = accounts(8);
  const sameWeek = planWeeklyRotation(expanded, options(0, done));
  assert.equal(sameWeek.completed, 2);
  assert.equal(sameWeek.selectedIds.length, 0);
  const next = planWeeklyRotation(expanded, options(1, sameWeek.state));
  assert.equal(next.selectedIds.length, 2);
  assert.equal(next.total, 8);
});

test("members added in the last week join its persisted plan instead of missing the cycle", () => {
  const configured = accounts(4);
  let state;
  for (let index = 0; index < 4; index++) {
    const result = planWeeklyRotation(configured, options(index, state));
    state = markRotationCompleted(result.state, result.selectedIds);
  }
  const expanded = accounts(6);
  const lastWeek = planWeeklyRotation(expanded, options(3, state));
  assert.equal(lastWeek.completed, 4);
  assert.equal(lastWeek.selectedIds.length, 2);
  const done = markRotationCompleted(lastWeek.state, lastWeek.selectedIds);
  assert.equal(done.completedIds.length, 6);
});

test("deleted members are removed without scrambling remaining credentials or resetting completed members", () => {
  const configured = accounts(6);
  const first = planWeeklyRotation(configured, options());
  const done = markRotationCompleted(first.state, first.selectedIds);
  const removed = configured.filter((account) => getRotationAccountId(account, origin) !== first.selectedIds[0]);
  const next = planWeeklyRotation(removed, options(1, done));
  assert.equal(next.total, 5);
  assert.equal(next.completed, 1);
  assert.ok(next.state.accountIds.every((id) => id !== first.selectedIds[0]));
  assert.ok(Object.values(next.state.plans).flat().every((id) => id !== first.selectedIds[0]));
});

test("changing the target user or forum starts a new independent cycle", () => {
  const configured = accounts(6);
  const first = planWeeklyRotation(configured, options());
  const done = markRotationCompleted(first.state, first.selectedIds);
  for (const changed of [{ targetUser: "someone-else" }, { origin: "https://another.example" }]) {
    const next = planWeeklyRotation(configured, { ...options(1, done), ...changed });
    assert.equal(next.resetReason, "target-changed");
    assert.equal(next.completed, 0);
    assert.equal(next.weekIndex, 1);
  }
  const sameTarget = planWeeklyRotation(configured, { ...options(1, done), targetUser: "TARGET-USER" });
  assert.equal(sameTarget.completed, 2);
});

test("Shanghai Monday week boundaries are independent of UTC date and survive new year", () => {
  const sunday = getShanghaiWeek(Date.parse("2026-10-25T15:59:59.999Z"));
  const monday = getShanghaiWeek(Date.parse("2026-10-25T16:00:00.000Z"));
  assert.equal(monday, sunday + 1);
  assert.equal(getShanghaiWeek(Date.parse("2026-10-26T00:00:00Z")), monday);
  const newYear = getShanghaiWeek(new Date("2027-01-01T00:00:00Z"));
  assert.equal(getShanghaiWeek(Date.parse("2026-12-27T16:00:00Z")), newYear);
  assert.equal(getShanghaiWeek(Date.parse("2027-01-03T15:59:59Z")), newYear);
  assert.equal(getShanghaiWeek(Date.parse("2027-01-03T16:00:00Z")), newYear + 1);
  assert.equal(getShanghaiWeek(() => firstMonday), monday);
});

test("serialized state never contains credentials, raw usernames or the target name", () => {
  const configured = accounts(6);
  const result = planWeeklyRotation(configured, options());
  const serialized = JSON.stringify(markRotationCompleted(result.state, result.selectedIds));
  for (const account of configured) {
    assert.equal(serialized.includes(account.username), false);
    assert.equal(serialized.includes(account.password), false);
  }
  assert.equal(serialized.includes(targetUser), false);
  assert.equal(serialized.includes(origin), false);
});

test("planning and completion do not mutate caller-owned durable snapshots", () => {
  const configured = accounts(6);
  const first = planWeeklyRotation(configured, options());
  const snapshot = JSON.stringify(first.state);
  const done = markRotationCompleted(first.state, first.selectedIds);
  assert.equal(JSON.stringify(first.state), snapshot);
  const completedSnapshot = JSON.stringify(done);
  const next = planWeeklyRotation(configured, options(1, { ...done, legacyPrivateMetadata: "not retained" }));
  assert.equal(JSON.stringify(done), completedSnapshot);
  assert.equal(Object.hasOwn(next.state, "legacyPrivateMetadata"), false);
});

test("invalid or inconsistent durable state fails closed instead of resetting and reliking", () => {
  const configured = accounts(6);
  const first = planWeeklyRotation(configured, options());
  for (const state of [{}, { ...first.state, version: 99 }, { ...first.state, completedIds: ["bad"] },
    { ...first.state, accountIds: [...first.state.accountIds, first.state.accountIds[0]] },
    { ...first.state, plans: { "not-a-week": [] } }]) {
    assert.throws(() => planWeeklyRotation(configured, options(1, state)), /轮换进度/);
  }
  assert.throws(() => planWeeklyRotation(configured, options(-1, first.state)), /不会倒退/);
  assert.throws(() => markRotationCompleted(first.state, [getRotationAccountId("outside-plan", origin)]), /未安排/);
});

test("invalid configuration is rejected before choosing any account", () => {
  assert.throws(() => planWeeklyRotation([], options()), /至少需要/);
  assert.throws(() => planWeeklyRotation([{ username: "Alice" }, { username: " alice " }], options()), /账号重复/);
  assert.throws(() => planWeeklyRotation(accounts(6), { ...options(), targetUser: "" }), /不能为空/);
  assert.throws(() => planWeeklyRotation(accounts(6), { ...options(), random: () => 1 }), /随机数/);
  assert.throws(() => planWeeklyRotation(accounts(6), { ...options(), now: NaN }), /时间无效/);
});
