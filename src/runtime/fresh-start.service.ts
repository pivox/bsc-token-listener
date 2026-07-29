import { isHash } from 'viem';
import type { CanonicalBlockReader } from '../chain/canonical-chain.types.js';
import { confirmedHead } from '../chain/confirmed-blocks.js';
import type { FreshStartRepository } from './fresh-start.repository.js';
import type { FreshStartRun } from './fresh-start.types.js';

export class FreshStartService {
  constructor(
    private readonly reader: CanonicalBlockReader,
    private readonly repository: Pick<FreshStartRepository, 'apply'>,
    private readonly confirmations: number,
    private readonly now: () => number = Date.now,
  ) {}

  async apply(): Promise<FreshStartRun> {
    const latest = await this.reader.getBlockNumber();
    const number = confirmedHead(latest, this.confirmations);
    if (number === null) {
      throw new Error(
        'Aucun bloc BSC suffisamment confirmé pour le fresh-start.',
      );
    }

    const header = await this.reader.getBlock(number);
    if (
      header.number !== number
      || !isHash(header.hash)
      || !isHash(header.parentHash)
    ) {
      throw new Error(`Header fresh-start invalide pour le bloc ${number}.`);
    }

    return this.repository.apply(
      {
        number,
        hash: header.hash,
        parentHash: header.parentHash,
      },
      this.now(),
    );
  }
}
