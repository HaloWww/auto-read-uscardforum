import assert from "node:assert/strict";
import test from "node:test";
import { parseAccounts, positiveInteger } from "./accounts.js";

test("account parsing preserves password whitespace and account pairing", () => {
  assert.deepEqual(parseAccounts(" alice, bob ", " first , second "), [
    { username: "alice", password: " first " },
    { username: "bob", password: " second " },
  ]);
});

test("missing, empty and unpaired credentials are rejected before launch", () => {
  for (const [names, passwords] of [["", ""], ["alice,bob", "password"],
    ["alice,", "password,other"], ["alice,bob", "password,"]]) {
    assert.throws(() => parseAccounts(names, passwords));
  }
});

test("invalid concurrency and time limits cannot silently skip accounts", () => {
  assert.equal(positiveInteger("", 3, "limit"), 3);
  assert.equal(positiveInteger("2", 3, "limit"), 2);
  for (const value of ["-1", "0", "1.5", "3bad"]) {
    assert.throws(() => positiveInteger(value, 3, "limit"));
  }
});
