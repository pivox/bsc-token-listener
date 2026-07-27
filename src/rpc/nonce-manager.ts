import type { Address } from 'viem';
import type { AppPublicClient } from './clients.js';
import { SerialTaskQueue } from '../utils/serial-task-queue.js';

export class NonceManager {
  private readonly queue = new SerialTaskQueue();
  private nextNonce: number | undefined;

  public constructor(
    private readonly publicClient: AppPublicClient,
    private readonly address: Address,
  ) {}

  public send<T>(sender: (nonce: number) => Promise<T>): Promise<T> {
    return this.queue.run(async () => {
      const networkNonce = await this.publicClient.getTransactionCount({
        address: this.address,
        blockTag: 'pending',
      });

      if (this.nextNonce === undefined || networkNonce > this.nextNonce) {
        this.nextNonce = networkNonce;
      }

      const nonce = this.nextNonce ?? networkNonce;
      this.nextNonce = nonce;
      try {
        const result = await sender(nonce);
        this.nextNonce = nonce + 1;
        return result;
      } catch (error) {
        this.nextNonce = undefined;
        throw error;
      }
    });
  }

  public reset(): void {
    this.nextNonce = undefined;
  }
}
