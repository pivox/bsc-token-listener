import type { Address, PublicClient } from 'viem';
import { erc20Abi } from '../abi/erc20.abi.js';
import type { TokenMetadata } from '../types/domain.js';

export class TokenMetadataService {
  constructor(private readonly client: PublicClient) {}

  async read(token: Address): Promise<TokenMetadata> {
    const bytecode = await this.client.getBytecode({ address: token });
    if (!bytecode || bytecode === '0x') {
      throw new Error('Le contrat ne contient aucun bytecode.');
    }

    const [name, symbol, decimals, totalSupply] = await Promise.all([
      this.readOptionalString(token, 'name'),
      this.readOptionalString(token, 'symbol'),
      this.client.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }),
      this.client.readContract({ address: token, abi: erc20Abi, functionName: 'totalSupply' }),
    ]);

    if (decimals > 36) throw new Error(`Décimales incohérentes: ${decimals}.`);
    if (totalSupply <= 0n) throw new Error('Total supply nul.');

    return {
      address: token,
      name,
      symbol,
      decimals,
      totalSupply,
      codeSizeBytes: Math.max(0, (bytecode.length - 2) / 2),
    };
  }

  private async readOptionalString(
    token: Address,
    functionName: 'name' | 'symbol',
  ): Promise<string | null> {
    try {
      const value = await this.client.readContract({
        address: token,
        abi: erc20Abi,
        functionName,
      });
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed.slice(0, 128) : null;
    } catch {
      return null;
    }
  }
}
