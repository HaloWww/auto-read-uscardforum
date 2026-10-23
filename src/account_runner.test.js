import test from "node:test";
import assert from "node:assert/strict";
import { runAccountBatches } from "./account_runner.js";

function fakeClock() {
  let current = 0;
  const sleeps = [];
  return {
    now: () => current,
    advance: (milliseconds) => { current += milliseconds; },
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      current += milliseconds;
    },
    sleeps,
  };
}

test("every batch, including the last, reads until its wall-clock deadline", async () => {
  const clock = fakeClock();
  const closed = [];
  const launched = [];
  const results = await runAccountBatches(["first", "last"], {
    maxConcurrentAccounts: 1,
    runTimeMillis: 100,
    delayBetweenInstances: 0,
    ...clock,
    launch: async (account) => {
      launched.push([account, clock.now()]);
      clock.advance(10);
      return { account };
    },
    close: async (browser) => closed.push([browser.account, clock.now()]),
  });

  assert.deepEqual(launched, [["first", 0], ["last", 50]]);
  assert.deepEqual(closed, [["first", 50], ["last", 100]]);
  assert.deepEqual(clock.sleeps, [40, 40]);
  assert.ok(results.every((result) => result.success));
});

test("one account failure leaves its peers and later batches running", async () => {
  const clock = fakeClock();
  const closed = [];
  const error = new Error("login rejected");
  const results = await runAccountBatches(["bad", "peer", "later"], {
    maxConcurrentAccounts: 2,
    runTimeMillis: 100,
    delayBetweenInstances: 0,
    ...clock,
    launch: async (account) => {
      if (account === "bad") throw error;
      return account;
    },
    close: async (account) => closed.push(account),
  });

  assert.deepEqual(results.map((result) => result.success), [false, true, true]);
  assert.equal(results[0].error, error);
  assert.deepEqual(closed, ["peer", "later"]);
});

test("cleanup time reduces the next batch's remaining reading time", async () => {
  const clock = fakeClock();
  const launched = [];
  const results = await runAccountBatches(["first", "last"], {
    maxConcurrentAccounts: 1,
    runTimeMillis: 100,
    delayBetweenInstances: 0,
    ...clock,
    launch: async (account) => {
      launched.push([account, clock.now()]);
      return account;
    },
    close: async (account) => {
      if (account === "first") clock.advance(20);
    },
  });

  assert.deepEqual(launched, [["first", 0], ["last", 70]]);
  assert.deepEqual(clock.sleeps, [50, 30]);
  assert.equal(clock.now(), 100);
  assert.ok(results.every((result) => result.success));
});

test("cleanup failures do not prevent closing peers or launching later batches", async () => {
  const clock = fakeClock();
  const closed = [];
  const error = new Error("browser close failed");
  const results = await runAccountBatches(["bad-close", "peer", "later", "no-browser"], {
    maxConcurrentAccounts: 2,
    runTimeMillis: 100,
    delayBetweenInstances: 0,
    ...clock,
    launch: async (account) => account === "no-browser" ? null : account,
    close: async (account) => {
      closed.push(account);
      if (account === "bad-close") throw error;
    },
  });

  assert.deepEqual(closed, ["bad-close", "peer", "later"]);
  assert.equal(results[0].closeError, error);
  assert.ok(results.every((result) => result.success));
});

test("a login that uses up the whole budget prevents remaining accounts from starting", async () => {
  const clock = fakeClock();
  const launched = [];
  const closed = [];
  const results = await runAccountBatches(["slow", "later", "last"], {
    maxConcurrentAccounts: 1,
    runTimeMillis: 90,
    delayBetweenInstances: 0,
    ...clock,
    launch: async (account) => {
      launched.push(account);
      clock.advance(100);
      return account;
    },
    close: async (account) => closed.push(account),
  });

  assert.deepEqual(launched, ["slow"]);
  assert.deepEqual(closed, ["slow"]);
  assert.deepEqual(results.map((result) => result.success), [true, false, false]);
  assert.equal(results[1].error.code, "ACCOUNT_BUDGET_EXHAUSTED");
  assert.equal(results[2].error.code, "ACCOUNT_BUDGET_EXHAUSTED");
});

test("accounts whose staggered start falls outside their batch budget fail explicitly", async () => {
  const clock = fakeClock();
  const launched = [];
  const results = await runAccountBatches(["first", "too-late"], {
    maxConcurrentAccounts: 2,
    runTimeMillis: 10,
    delayBetweenInstances: 10,
    ...clock,
    launch: async (account) => {
      launched.push(account);
      return null;
    },
  });

  assert.deepEqual(launched, ["first"]);
  assert.equal(results[1].success, false);
  assert.equal(results[1].error.code, "ACCOUNT_BUDGET_EXHAUSTED");
});

test("cleanup still runs when the reading wait fails", async () => {
  const closed = [];
  const error = new Error("sleep failed");
  await assert.rejects(runAccountBatches(["account"], {
    runTimeMillis: 10,
    delayBetweenInstances: 0,
    now: () => 0,
    sleep: async () => { throw error; },
    launch: async (account) => account,
    close: async (account) => closed.push(account),
  }), error);
  assert.deepEqual(closed, ["account"]);
});
