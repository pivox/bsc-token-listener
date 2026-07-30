import { logger } from '../utils/logger.js';

export class TransactionQueue {
  private runningOperations = 0;
  private tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const startedAtMs = Date.now();
    logger.debug(
      { runningOperations: this.runningOperations },
      'TransactionQueue: opération en file d’attente.',
    );
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    this.runningOperations += 1;
    logger.debug(
      { runningOperations: this.runningOperations },
      'TransactionQueue: début exécution opération.',
    );
    try {
      return await operation();
    } finally {
      const durationMs = Date.now() - startedAtMs;
      this.runningOperations -= 1;
      logger.debug(
        {
          runningOperations: this.runningOperations,
          durationMs,
        },
        'TransactionQueue: opération terminée.',
      );
      release();
    }
  }
}
