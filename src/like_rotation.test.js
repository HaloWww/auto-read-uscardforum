import test from "node:test";
import assert from "node:assert/strict";
import { prepareLikeRotation, previewLikeRotation } from "./like_rotation.js";

const accounts = Array.from({ length: 6 }, (_, index) => ({ username: `user-${index}`, password: `secret-${index}` }));
const options = { origin: "https://forum.test", targetUser: "target", now: Date.UTC(2026, 9, 26), random: () => 0.5 };

function store() {
  let value = null;
  const writes = [];
  return {
    writes, async load() { return structuredClone(value); },
    async save(next) { value = structuredClone(next); writes.push(value); },
  };
}

test("a failed initial save prevents returning accounts for browser launch", async () => {
  await assert.rejects(prepareLikeRotation(accounts, {
    ...options, store: { load: async () => null, save: async () => { throw new Error("no write permission"); } },
  }), /no write permission/);
});

test("only confirmed successes are persisted, and a same-week retry keeps the original unfinished draw", async () => {
  const persistence = store();
  const first = await prepareLikeRotation(accounts, { ...options, store: persistence });
  assert.equal(persistence.writes.length, 1);
  const completed = first.plan.selectedIds[0];
  await first.complete(completed);
  await first.flush();
  const retry = await prepareLikeRotation(accounts, { ...options, random: () => 0, store: persistence });
  assert.deepEqual(retry.plan.selectedIds, first.plan.selectedIds.slice(1));
  assert.equal(retry.plan.selectedAccounts.length, 1);
  assert.ok(retry.state.completedIds.includes(completed));
  const serialized = JSON.stringify(persistence.writes);
  for (const account of accounts) {
    assert.ok(!serialized.includes(account.username));
    assert.ok(!serialized.includes(account.password));
  }
});

test("a retry verifies current write access before returning its already saved draw", async () => {
  const persistence = store();
  await prepareLikeRotation(accounts, { ...options, store: persistence });
  persistence.save = async () => { throw new Error("write access revoked"); };
  await assert.rejects(prepareLikeRotation(accounts, { ...options, store: persistence }), /write access revoked/);
});

test("concurrent success callbacks save in order without losing either account", async () => {
  const persistence = store();
  let saving = 0;
  let maximum = 0;
  const save = persistence.save;
  persistence.save = async (state) => {
    maximum = Math.max(maximum, ++saving);
    await new Promise((resolve) => setImmediate(resolve));
    await save(state);
    saving--;
  };
  const rotation = await prepareLikeRotation(accounts, { ...options, store: persistence });
  await Promise.all(rotation.plan.selectedIds.map(rotation.complete));
  await rotation.flush();
  assert.equal(maximum, 1);
  assert.deepEqual(new Set(rotation.state.completedIds), new Set(rotation.plan.selectedIds));
  const writes = persistence.writes.length;
  await rotation.complete(rotation.plan.selectedIds[0]);
  assert.equal(persistence.writes.length, writes);
});

test("a completion-save failure is reported and cannot be overwritten by a later success", async () => {
  const persistence = store();
  const rotation = await prepareLikeRotation(accounts, { ...options, store: persistence });
  persistence.save = async () => { throw new Error("state conflict"); };
  await assert.rejects(rotation.complete(rotation.plan.selectedIds[0]), /state conflict/);
  await assert.rejects(rotation.complete(rotation.plan.selectedIds[1]), /state conflict/);
  await assert.rejects(rotation.flush(), /state conflict/);
  assert.deepEqual(rotation.state.completedIds, []);
});

test("preview covers all six accounts in four balanced weeks without persistence", () => {
  const preview = previewLikeRotation(accounts, options);
  assert.deepEqual(preview.map((week) => week.selectedIndexes.length), [2, 2, 1, 1]);
  assert.deepEqual(preview.flatMap((week) => week.selectedIndexes).sort(), [0, 1, 2, 3, 4, 5]);
});

test("preview accepts a Date or injected clock without depending on the host timezone", () => {
  for (const now of [new Date(options.now), () => options.now]) {
    assert.deepEqual(previewLikeRotation(accounts, { ...options, now }), previewLikeRotation(accounts, options));
  }
});
