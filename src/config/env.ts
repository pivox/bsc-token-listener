import 'dotenv/config';
import {
  getAddress,
  isAddress,
  parseEther,
  type Address,
  type Hex,
} from 'viem';
import type { ExecutionMode } from '../types/domain.js';

function read(name: string, fallback?: string): string {
  const value = process.env[name]?.trim();
  if (value) return value;
  if (fallback !== undefined && fallback.length > 0) return fallback;
  throw new Error(`Variable d'environnement obligatoire manquante: ${name}`);
}

function firstUrl(name: string): string | undefined {
  return process.env[name]
    ?.split(',')
    .map((value) => value.trim())
    .find((value) => value.length > 0);
}

function readBoolean(name: string, fallback: boolean, legacyName?: string): boolean {
  const raw = process.env[name]?.trim() ?? (legacyName ? process.env[legacyName]?.trim() : undefined);
  const value = raw?.toLowerCase();
  if (!value) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  throw new Error(`${name} doit être un booléen.`);
}

function readInteger(
  name: string,
  fallback: number,
  min: number,
  max: number,
  legacyName?: string,
): number {
  const raw = process.env[name]?.trim() ?? (legacyName ? process.env[legacyName]?.trim() : undefined);
  const value = Number(raw ?? String(fallback));
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} doit être un entier entre ${min} et ${max}.`);
  }
  return value;
}

function readAddress(name: string, fallback?: string): Address {
  const value = read(name, fallback);
  if (!isAddress(value, { strict: false })) {
    throw new Error(`${name} n'est pas une adresse EVM valide.`);
  }
  return getAddress(value.toLowerCase());
}

function readOptionalAddress(name: string, legacyName?: string): Address | undefined {
  const value = process.env[name]?.trim() ?? (legacyName ? process.env[legacyName]?.trim() : undefined);
  if (!value) return undefined;
  if (!isAddress(value, { strict: false })) {
    throw new Error(`${name} n'est pas une adresse EVM valide.`);
  }
  return getAddress(value.toLowerCase());
}

function readPrivateKey(): Hex | undefined {
  const raw = process.env.PRIVATE_KEY?.trim();
  if (!raw) return undefined;
  const value = raw.startsWith('0x') ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/u.test(value)) {
    throw new Error('PRIVATE_KEY doit contenir exactement 32 octets hexadécimaux.');
  }
  return value as Hex;
}

const network = read('BSC_NETWORK', 'mainnet');
if (network !== 'mainnet' && network !== 'testnet') {
  throw new Error('BSC_NETWORK doit valoir mainnet ou testnet.');
}

const executionMode = read('EXECUTION_MODE', 'dry-run') as ExecutionMode;
if (executionMode !== 'dry-run' && executionMode !== 'live') {
  throw new Error('EXECUTION_MODE doit valoir dry-run ou live.');
}

const riskPolicy = read('RISK_POLICY', 'allow-only');
if (riskPolicy !== 'allow-only' && riskPolicy !== 'block-only') {
  throw new Error('RISK_POLICY doit valoir allow-only ou block-only.');
}

const privateKey = readPrivateKey();
const safetyProbeAddress = readOptionalAddress('SAFETY_PROBE_ADDRESS');
const riskProbeCaller = readOptionalAddress('RISK_PROBE_CALLER', 'SIMULATION_ACCOUNT');

if (executionMode === 'live') {
  if (!privateKey) throw new Error('PRIVATE_KEY est obligatoire en mode live.');
  if (read('CONFIRM_LIVE_TRADING', '') !== 'I_UNDERSTAND_REAL_FUNDS') {
    throw new Error('Mode live bloqué: définir CONFIRM_LIVE_TRADING=I_UNDERSTAND_REAL_FUNDS.');
  }
  if (riskPolicy !== 'allow-only') {
    throw new Error('Le mode live exige RISK_POLICY=allow-only.');
  }
  if (!safetyProbeAddress) {
    throw new Error('Le mode live exige SAFETY_PROBE_ADDRESS.');
  }
}

export const config = {
  network,
  httpRpcUrl: read('BSC_HTTP_RPC_URL', firstUrl('BSC_HTTP_URLS')),
  wsRpcUrl: read('BSC_WS_RPC_URL', firstUrl('BSC_WSS_URLS')),
  databaseUrl: read('DATABASE_URL'),
  autoMigrate: readBoolean('POSTGRES_AUTO_MIGRATE', true),
  dashboardEnabled: readBoolean('DASHBOARD_ENABLED', true),
  dashboardHost: read('DASHBOARD_HOST', '127.0.0.1'),
  dashboardPort: readInteger('DASHBOARD_PORT', 3000, 1, 65_535),
  dashboardRefreshSeconds: readInteger('DASHBOARD_REFRESH_SECONDS', 5, 2, 300),
  dashboardMaxRows: readInteger('DASHBOARD_MAX_ROWS', 250, 25, 5_000),
  factory: readAddress(
    'PANCAKE_FACTORY_ADDRESS',
    network === 'mainnet' ? '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73' : undefined,
  ),
  router: readAddress(
    'PANCAKE_ROUTER_ADDRESS',
    network === 'mainnet' ? '0x10ED43C718714eb63d5aA57B78B54704E256024E' : undefined,
  ),
  wbnb: readAddress(
    'WBNB_ADDRESS',
    network === 'mainnet' ? '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c' : undefined,
  ),
  executionMode,
  privateKey,
  buyAmountWei: parseEther(read('BUY_AMOUNT_BNB', '0.01')),
  slippageBps: readInteger('SLIPPAGE_BPS', 1500, 0, 5000, 'BUY_SLIPPAGE_BPS'),
  txDeadlineSeconds: readInteger('TX_DEADLINE_SECONDS', 90, 15, 600),
  targetBuysAfterEntry: readInteger('TARGET_BUYS_AFTER_ENTRY', 10, 1, 1000),
  maxConcurrentPositions: readInteger('MAX_CONCURRENT_POSITIONS', 1, 1, 100),
  maxActivePairMonitors: readInteger('MAX_ACTIVE_PAIR_MONITORS', 50, 1, 1000),
  pairMonitorTtlMinutes: readInteger('PAIR_MONITOR_TTL_MINUTES', 90, 1, 1440),
  reconcileSeconds: readInteger('RECONCILE_SECONDS', 15, 5, 300, 'EVENT_RECONCILE_SECONDS'),
  riskPolicy,
  riskMinScore: readInteger('RISK_MIN_SCORE', 80, 0, 100),
  minWbnbLiquidityWei: parseEther(read('MIN_WBNB_LIQUIDITY', '0.25')),
  riskProbeRequired: readBoolean('RISK_PROBE_REQUIRED', true, 'REQUIRE_SAFETY_PROBE'),
  safetyProbeAddress,
  riskProbeCaller,
  riskProbeAmountWei: parseEther(read('RISK_PROBE_AMOUNT_BNB', '0.005')),
  riskMaxBuyTaxBps: readInteger('RISK_MAX_BUY_TAX_BPS', 1500, 0, 10000),
  riskMaxSellTaxBps: readInteger('RISK_MAX_SELL_TAX_BPS', 1500, 0, 10000),
  riskMaxRoundTripLossBps: readInteger(
    'RISK_MAX_ROUNDTRIP_LOSS_BPS',
    3000,
    0,
    10000,
    'MAX_ROUND_TRIP_LOSS_BPS',
  ),
} as const;
