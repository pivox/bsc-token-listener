import type { ReorgRollbackImpact } from '../chain/canonical-chain.types.js';

export interface PendingShallowReorg {
  readonly identity: string;
  readonly impact: ReorgRollbackImpact;
  readonly requiresProjectionReconciliation?: boolean;
}

export class PendingShallowReorgQueue {
  private readonly items: PendingShallowReorg[] = [];

  enqueue(item: PendingShallowReorg): void {
    this.items.push(item);
  }

  peek(): PendingShallowReorg | undefined {
    return this.items[0];
  }

  async finalizeHead<T>(
    operation: (item: PendingShallowReorg) => Promise<T>,
  ): Promise<T> {
    const pending = this.items[0];
    if (!pending) {
      throw new Error('Aucun rollback shallow en attente pour le replay post-reorg.');
    }
    const result = await operation(pending);
    const head = this.items[0];
    if (
      head?.identity !== pending.identity
      || head.impact.reorgId !== pending.impact.reorgId
    ) {
      throw new Error('La FIFO de rollback shallow a changé pendant sa finalisation.');
    }
    this.items.shift();
    return result;
  }
}
