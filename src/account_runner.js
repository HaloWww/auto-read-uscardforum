const sleepFor = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function budgetError() {
  const error = new Error("账号运行时间预算已耗尽，未启动登录");
  error.code = "ACCOUNT_BUDGET_EXHAUSTED";
  return error;
}

/**
 * Give every batch an equal share of one wall-clock budget, including login
 * and cleanup time. launch must settle within its own timeout and must clean
 * up resources it opens before throwing; only resolved values reach close.
 *
 * Results follow input order. A cleanup failure is recorded as closeError
 * separately from the login result, and never prevents another cleanup.
 * onBatch is a synchronous progress callback; its indexes are zero-based,
 * and endIndex is exclusive.
 */
export async function runAccountBatches(
  accounts,
  {
    maxConcurrentAccounts = 3,
    runTimeMillis,
    launch,
    close = async (value) => value.close(),
    delayBetweenInstances = 10000,
    keepAlive = true,
    now = Date.now,
    sleep = sleepFor,
    onBatch = () => {},
  },
) {
  if (!Array.isArray(accounts)) {
    throw new TypeError("accounts must be an array");
  }
  if (!Number.isInteger(maxConcurrentAccounts) || maxConcurrentAccounts < 1) {
    throw new RangeError("maxConcurrentAccounts must be a positive integer");
  }
  if (!Number.isFinite(runTimeMillis) || runTimeMillis < 0) {
    throw new RangeError("runTimeMillis must be a non-negative number");
  }
  if (!Number.isFinite(delayBetweenInstances) || delayBetweenInstances < 0) {
    throw new RangeError("delayBetweenInstances must be a non-negative number");
  }
  if (typeof launch !== "function" || typeof close !== "function") {
    throw new TypeError("launch and close must be functions");
  }

  const results = new Array(accounts.length);
  const startedAt = now();
  const batchCount = Math.ceil(accounts.length / maxConcurrentAccounts);

  for (let batchIndex = 0; batchIndex < batchCount; batchIndex++) {
    const startIndex = batchIndex * maxConcurrentAccounts;
    const endIndex = Math.min(startIndex + maxConcurrentAccounts, accounts.length);
    const deadline = startedAt + (runTimeMillis * (batchIndex + 1)) / batchCount;
    const batchStartedAt = now();
    const active = [];

    try {
      onBatch({ batchIndex, startIndex, endIndex, deadline });
      await Promise.all(
        accounts.slice(startIndex, endIndex).map(async (account, offset) => {
          const index = startIndex + offset;
          try {
            // Do not spend an already exhausted batch's budget on launch delays.
            const launchAt = batchStartedAt + offset * delayBetweenInstances;
            if (now() >= deadline || launchAt >= deadline) throw budgetError();
            const delay = launchAt - now();
            if (delay > 0) await sleep(delay);
            if (now() >= deadline) throw budgetError();

            const value = await launch(account, index);
            const result = { account, index, success: true, value };
            results[index] = result;
            if (value != null) active.push(result);
          } catch (error) {
            results[index] = { account, index, success: false, error };
          }
        }),
      );

      // The final batch gets its reading time too. Login time is already spent
      // from this slot, rather than being added to every batch's reading time.
      const remaining = deadline - now();
      if (keepAlive && active.length && remaining > 0) await sleep(remaining);
    } finally {
      for (const result of active) {
        try {
          await close(result.value, result.account, result.index);
        } catch (error) {
          result.closeError = error;
        }
      }
    }
  }

  return results;
}
