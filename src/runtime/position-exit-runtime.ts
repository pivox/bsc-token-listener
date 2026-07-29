export async function startPositionExitRuntime(input: {
  reconcilePendingDecisions: () => Promise<void>;
  reconcileNow: () => Promise<void>;
  start: () => void;
}): Promise<void> {
  await input.reconcilePendingDecisions();
  await input.reconcileNow();
  input.start();
}
