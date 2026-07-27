import type { Address } from 'viem';

export type RiskVerdict = 'ALLOW' | 'REVIEW' | 'BLOCK';
export type RiskCheckStatus = 'PASS' | 'WARN' | 'FAIL' | 'UNKNOWN';

export interface RiskCheck {
  code: string;
  label: string;
  status: RiskCheckStatus;
  critical: boolean;
  penalty: number;
  message: string;
  evidence?: Record<string, unknown>;
}

export interface TokenRiskReport {
  id: string;
  token: Address;
  pair: Address;
  blockNumber: bigint;
  score: number;
  verdict: RiskVerdict;
  checks: RiskCheck[];
  summary: {
    liquidityWbnb: bigint | null;
    owner: Address | null;
    implementation: Address | null;
    lpBurnedBps: number | null;
    buyTaxBps: number | null;
    sellTaxBps: number | null;
    roundTripLossBps: number | null;
    sensitiveSelectors: string[];
  };
  createdAtMs: number;
}
