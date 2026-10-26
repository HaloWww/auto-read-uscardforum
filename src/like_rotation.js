import { markRotationCompleted, planWeeklyRotation } from "./weekly_rotation.js";

// Save the draw before any browser is started. A retry must use the same draw.
export async function prepareLikeRotation(accounts, { store, ...options }) {
  const previous = await store.load();
  const plan = planWeeklyRotation(accounts, { ...options, state: previous });
  if (plan.selectedAccounts.length || JSON.stringify(previous) !== JSON.stringify(plan.state)) {
    await store.save(plan.state);
  }
  let state = plan.state;
  let pending = Promise.resolve();
  let saveError;

  function complete(accountId) {
    const operation = pending.then(async () => {
      if (saveError) throw saveError;
      if (state.completedIds.includes(accountId)) return;
      const next = markRotationCompleted(state, [accountId]);
      await store.save(next);
      state = next;
    });
    // Register a rejection handler immediately, even while browsers keep running.
    pending = operation.catch((error) => { saveError ??= error; });
    return operation;
  }

  return {
    plan, complete,
    get state() { return state; },
    async flush() {
      await pending;
      if (saveError) throw saveError;
    },
  };
}

// Preview uses a new cycle in memory and never reads or writes remote state.
export function previewLikeRotation(accounts, options) {
  let state = null;
  const instant = typeof options.now === "function" ? options.now() : options.now ?? Date.now();
  const start = instant instanceof Date ? instant.getTime() : instant;
  return Array.from({ length: 4 }, (_, week) => {
    const plan = planWeeklyRotation(accounts, { ...options, state, now: start + week * 7 * 86400000 });
    state = markRotationCompleted(plan.state, plan.selectedIds);
    return { week: week + 1, selectedIndexes: plan.selectedIndexes };
  });
}
