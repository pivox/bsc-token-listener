import { randomBytes } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { formatEther, formatUnits } from 'viem';
import { pancakeRouterAbi } from '../abi/pancake-router.abi.js';
import { config } from '../config/env.js';
import { account, publicClient } from '../rpc/clients.js';
import type { RiskVerdict, TokenRiskReport } from '../security/token-risk.types.js';
import { pool } from '../storage/database.js';
import type {
  PairInfo,
  SessionStatus,
  TokenMetadata,
  TokenSession,
} from '../types/domain.js';
import { errorMessage } from '../utils/error.js';
import { parseJson } from '../utils/json.js';
import { logger } from '../utils/logger.js';
import {
  applyBasisPointReduction,
  calculatePnl,
} from './dashboard-metrics.js';
import { renderDashboardPage } from './dashboard.page.js';

const OPEN_STATUSES = new Set<SessionStatus>([
  'BUY_PENDING',
  'HOLDING',
  'SELL_PENDING',
  'MANUAL_REVIEW',
]);

const STATUS_LABELS: Record<SessionStatus | 'DISCOVERED', string> = {
  DISCOVERED: 'Écouté',
  WAITING_FIRST_BUY: 'En attente du premier achat',
  RISK_CHECKING: 'Analyse de risque',
  BUY_PENDING: 'Achat en attente',
  HOLDING: 'Position ouverte',
  SELL_PENDING: 'Vente en attente',
  CLOSED: 'Vendu',
  REJECTED: 'Refusé',
  EXPIRED: 'Expiré',
  MANUAL_REVIEW: 'Intervention requise',
};

interface DashboardRow {
  token_address: string;
  pair_address: string | null;
  source: string;
  metadata: unknown | null;
  discovered_payload: unknown;
  discovered_at: Date | string;
  discovered_updated_at: Date | string;
  status: SessionStatus | null;
  session_payload: unknown | null;
  session_updated_at: Date | string | null;
  risk_score: number | null;
  risk_verdict: RiskVerdict | null;
  risk_report: unknown | null;
  swap_count: string;
  buy_count: string;
  sell_count: string;
  failed_trade_count: string;
}

interface DashboardSummaryRow {
  detected_count: string;
  open_count: string;
  closed_count: string;
  issue_count: string;
  realized_pnl_wei: string;
}

interface DashboardCounters {
  detectedTokens: number;
  openPositions: number;
  closedPositions: number;
  issues: number;
  realizedPnlWei: bigint;
}

interface DashboardRecord {
  tokenAddress: string;
  pairAddress: string | null;
  source: string;
  metadata: TokenMetadata | null;
  pair: PairInfo | null;
  session: TokenSession | null;
  riskReport: TokenRiskReport | null;
  detectedAt: string;
  updatedAt: string;
  swaps: {
    total: number;
    buys: number;
    sells: number;
  };
  failedTradeCount: number;
}

interface DashboardTokenView {
  tokenAddress: string;
  pairAddress: string | null;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  source: string;
  status: SessionStatus | 'DISCOVERED';
  statusLabel: string;
  detectedAt: string;
  updatedAt: string;
  firstBuyAt: string | null;
  failedTradeCount: number;
  error: string | null;
  swaps: {
    total: number;
    buys: number;
    sells: number;
  };
  risk: {
    score: number | null;
    verdict: RiskVerdict | null;
    liquidityBnb: string | null;
    buyTaxPercent: string | null;
    sellTaxPercent: string | null;
  };
  progress: {
    current: number;
    target: number;
  } | null;
  entry: {
    mode: 'dry-run' | 'live';
    amountInBnb: string;
    amountOutToken: string;
    confirmedAt: string;
    transactionHash: string | null;
  } | null;
  valuation: {
    grossQuoteBnb: string | null;
    estimatedNetValueBnb: string | null;
    sellTaxAppliedBps: number | null;
    error: string | null;
  } | null;
  exit: {
    mode: 'dry-run' | 'live';
    amountInToken: string;
    amountOutBnb: string;
    confirmedAt: string;
    transactionHash: string | null;
  } | null;
  pnl: {
    unrealizedWei: string | null;
    unrealizedBnb: string | null;
    unrealizedPercent: string | null;
    realizedWei: string | null;
    realizedBnb: string | null;
    realizedPercent: string | null;
  };
  links: {
    token: string;
    pair: string | null;
    creationTransaction: string | null;
    entryTransaction: string | null;
    exitTransaction: string | null;
  };
}

interface DashboardSnapshot {
  generatedAt: string;
  startedAt: string;
  network: 'mainnet' | 'testnet';
  executionMode: 'dry-run' | 'live';
  riskPolicy: 'allow-only' | 'block-only';
  walletAddress: string | null;
  readOnly: true;
  feeNote: string;
  summary: {
    detectedTokens: number;
    openPositions: number;
    closedPositions: number;
    issues: number;
    walletBalanceBnb: string | null;
    unrealizedPnlBnb: string | null;
    realizedPnlBnb: string;
    valuationComplete: boolean;
  };
  tokens: DashboardTokenView[];
}

interface DiscoveredPayload {
  pair?: PairInfo;
  metadata?: TokenMetadata | null;
}

interface PositionQuote {
  grossWei: bigint;
  estimatedNetWei: bigint;
  sellTaxAppliedBps: number | null;
}

function count(value: string): number {
  return Number.parseInt(value, 10) || 0;
}

function isoDate(value: Date | string | number): string {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString();
}

function optionalJson<T>(value: unknown | null): T | null {
  return value === null ? null : parseJson<T>(value);
}

function formatBasisPoints(value: number | null): string | null {
  if (value === null) return null;
  const sign = value < 0 ? '-' : '';
  const absolute = Math.abs(value);
  return `${sign}${Math.trunc(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
}

function explorerUrl(path: string): string {
  const base = config.network === 'mainnet'
    ? 'https://bscscan.com'
    : 'https://testnet.bscscan.com';
  return `${base}/${path}`;
}

export class DashboardRepository {
  async listTokens(limit: number): Promise<DashboardRecord[]> {
    const result = await pool.query<DashboardRow>(
      `WITH latest_risk AS (
         SELECT DISTINCT ON (pair_address)
           pair_address, score, verdict, report
         FROM token_risk_reports
         ORDER BY pair_address, created_at DESC
       ), swap_counts AS (
         SELECT
           pair_address,
           COUNT(*)::text AS swap_count,
           (COUNT(*) FILTER (WHERE kind = 'BUY'))::text AS buy_count,
           (COUNT(*) FILTER (WHERE kind = 'SELL'))::text AS sell_count
         FROM swap_events
         GROUP BY pair_address
       ), failed_trades AS (
         SELECT pair_address, COUNT(*)::text AS failed_trade_count
         FROM trades
         WHERE status = 'FAILED'
         GROUP BY pair_address
       )
       SELECT
         d.token_address,
         d.pair_address,
         d.source,
         d.metadata,
         d.payload AS discovered_payload,
         d.created_at AS discovered_at,
         d.updated_at AS discovered_updated_at,
         s.status,
         s.payload AS session_payload,
         s.updated_at AS session_updated_at,
         r.score AS risk_score,
         r.verdict AS risk_verdict,
         r.report AS risk_report,
         COALESCE(sc.swap_count, '0') AS swap_count,
         COALESCE(sc.buy_count, '0') AS buy_count,
         COALESCE(sc.sell_count, '0') AS sell_count,
         COALESCE(ft.failed_trade_count, '0') AS failed_trade_count
       FROM discovered_tokens d
       LEFT JOIN token_sessions s ON s.pair_address = d.pair_address
       LEFT JOIN latest_risk r ON r.pair_address = d.pair_address
       LEFT JOIN swap_counts sc ON sc.pair_address = d.pair_address
       LEFT JOIN failed_trades ft ON ft.pair_address = d.pair_address
       ORDER BY
         CASE WHEN s.status IN ('BUY_PENDING', 'HOLDING', 'SELL_PENDING', 'MANUAL_REVIEW') THEN 0 ELSE 1 END,
         COALESCE(s.updated_at, d.updated_at) DESC
       LIMIT $1`,
      [limit],
    );

    const records: DashboardRecord[] = [];
    for (const row of result.rows) {
      try {
        const discovered = parseJson<DiscoveredPayload>(row.discovered_payload);
        const session = optionalJson<TokenSession>(row.session_payload);
        const storedMetadata = optionalJson<TokenMetadata>(row.metadata);
        const riskReport = optionalJson<TokenRiskReport>(row.risk_report);
        const pair = session?.pair ?? discovered.pair ?? null;
        records.push({
          tokenAddress: row.token_address,
          pairAddress: row.pair_address ?? pair?.pair ?? null,
          source: row.source,
          metadata: session?.metadata ?? storedMetadata ?? discovered.metadata ?? null,
          pair,
          session,
          riskReport,
          detectedAt: isoDate(row.discovered_at),
          updatedAt: isoDate(row.session_updated_at ?? row.discovered_updated_at),
          swaps: {
            total: count(row.swap_count),
            buys: count(row.buy_count),
            sells: count(row.sell_count),
          },
          failedTradeCount: count(row.failed_trade_count),
        });
      } catch (error) {
        logger.warn(
          { token: row.token_address, reason: errorMessage(error) },
          'Ligne ignorée par le dashboard: payload invalide.',
        );
      }
    }
    return records;
  }

  async getCounters(): Promise<DashboardCounters> {
    const result = await pool.query<DashboardSummaryRow>(
      `SELECT
         (SELECT COUNT(*)::text FROM discovered_tokens) AS detected_count,
         (SELECT COUNT(*)::text FROM token_sessions
          WHERE status IN ('BUY_PENDING', 'HOLDING', 'SELL_PENDING', 'MANUAL_REVIEW')) AS open_count,
         (SELECT COUNT(*)::text FROM token_sessions WHERE status = 'CLOSED') AS closed_count,
         (SELECT COUNT(*)::text FROM (
            SELECT pair_address FROM token_sessions WHERE status IN ('REJECTED', 'MANUAL_REVIEW')
            UNION
            SELECT pair_address FROM trades WHERE status = 'FAILED'
          ) issue_pairs) AS issue_count,
         COALESCE((
           SELECT SUM(
             (payload #>> '{exit,amountOutWei,__bsc_bot_bigint__}')::numeric
             - (payload #>> '{entry,amountInWei,__bsc_bot_bigint__}')::numeric
           )::text
           FROM token_sessions
           WHERE status = 'CLOSED'
             AND payload #>> '{entry,amountInWei,__bsc_bot_bigint__}' IS NOT NULL
             AND payload #>> '{exit,amountOutWei,__bsc_bot_bigint__}' IS NOT NULL
         ), '0') AS realized_pnl_wei`,
    );
    const row = result.rows[0];
    return {
      detectedTokens: count(row?.detected_count ?? '0'),
      openPositions: count(row?.open_count ?? '0'),
      closedPositions: count(row?.closed_count ?? '0'),
      issues: count(row?.issue_count ?? '0'),
      realizedPnlWei: BigInt(row?.realized_pnl_wei ?? '0'),
    };
  }
}

export class DashboardService {
  private readonly startedAt = new Date();
  private cache: { expiresAtMs: number; snapshot: DashboardSnapshot } | null = null;
  private inFlight: Promise<DashboardSnapshot> | null = null;

  constructor(private readonly repository: DashboardRepository) {}

  async getSnapshot(): Promise<DashboardSnapshot> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAtMs > now) return this.cache.snapshot;
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.buildSnapshot();
    try {
      const snapshot = await this.inFlight;
      this.cache = {
        expiresAtMs: Date.now() + config.dashboardRefreshSeconds * 1000,
        snapshot,
      };
      return snapshot;
    } finally {
      this.inFlight = null;
    }
  }

  private async buildSnapshot(): Promise<DashboardSnapshot> {
    const [records, counters, walletBalanceWei] = await Promise.all([
      this.repository.listTokens(config.dashboardMaxRows),
      this.repository.getCounters(),
      this.readWalletBalance(),
    ]);
    const tokens = await Promise.all(records.map((record) => this.toTokenView(record)));
    const openTokens = tokens.filter((token) =>
      token.entry !== null && token.exit === null && token.status !== 'DISCOVERED'
      && OPEN_STATUSES.has(token.status),
    );
    const valuedTokens = openTokens.filter((token) => token.pnl.unrealizedWei !== null);
    const unrealizedTotalWei = valuedTokens.length === 0
      ? (counters.openPositions === 0 ? 0n : null)
      : valuedTokens.reduce(
        (total, token) => total + BigInt(token.pnl.unrealizedWei ?? '0'),
        0n,
      );

    return {
      generatedAt: new Date().toISOString(),
      startedAt: this.startedAt.toISOString(),
      network: config.network,
      executionMode: config.executionMode,
      riskPolicy: config.riskPolicy,
      walletAddress: account?.address ?? null,
      readOnly: true,
      feeNote: 'PnL en BNB. La taxe de vente estimée est appliquée au PnL latent quand elle est connue; les frais de gas réseau ne sont pas encore persistés et ne sont donc pas déduits.',
      summary: {
        detectedTokens: counters.detectedTokens,
        openPositions: counters.openPositions,
        closedPositions: counters.closedPositions,
        issues: counters.issues,
        walletBalanceBnb: walletBalanceWei === null ? null : formatEther(walletBalanceWei),
        unrealizedPnlBnb: unrealizedTotalWei === null ? null : formatEther(unrealizedTotalWei),
        realizedPnlBnb: formatEther(counters.realizedPnlWei),
        valuationComplete: counters.openPositions === valuedTokens.length,
      },
      tokens,
    };
  }

  private async toTokenView(record: DashboardRecord): Promise<DashboardTokenView> {
    const session = record.session;
    const status = session?.status ?? 'DISCOVERED';
    const metadata = session?.metadata ?? record.metadata;
    const riskReport = record.riskReport;
    const entry = session?.entry ?? null;
    const exit = session?.exit ?? null;
    let quote: PositionQuote | null = null;
    let valuationError: string | null = null;

    if (session && entry && !exit && OPEN_STATUSES.has(session.status)) {
      try {
        quote = await this.quotePosition(session, riskReport?.summary.sellTaxBps ?? null);
      } catch (error) {
        valuationError = `Cotation RPC indisponible: ${errorMessage(error)}`;
      }
    }

    const unrealized = entry && quote
      ? calculatePnl(entry.amountInWei, quote.estimatedNetWei)
      : null;
    const realized = entry && exit
      ? calculatePnl(entry.amountInWei, exit.amountOutWei)
      : null;
    const pair = session?.pair ?? record.pair;
    const error = session?.rejectionReason
      ?? (record.failedTradeCount > 0 ? 'Une ou plusieurs transactions d’exécution ont échoué.' : null);

    return {
      tokenAddress: record.tokenAddress,
      pairAddress: record.pairAddress,
      name: metadata?.name ?? null,
      symbol: metadata?.symbol ?? null,
      decimals: metadata?.decimals ?? null,
      source: record.source,
      status,
      statusLabel: STATUS_LABELS[status],
      detectedAt: record.detectedAt,
      updatedAt: record.updatedAt,
      firstBuyAt: session?.firstBuy ? isoDate(session.firstBuy.observedAtMs) : null,
      failedTradeCount: record.failedTradeCount,
      error,
      swaps: record.swaps,
      risk: {
        score: riskReport?.score ?? null,
        verdict: riskReport?.verdict ?? null,
        liquidityBnb: riskReport?.summary.liquidityWbnb === null
          || riskReport?.summary.liquidityWbnb === undefined
          ? null
          : formatEther(riskReport.summary.liquidityWbnb),
        buyTaxPercent: formatBasisPoints(riskReport?.summary.buyTaxBps ?? null),
        sellTaxPercent: formatBasisPoints(riskReport?.summary.sellTaxBps ?? null),
      },
      progress: session && entry && !exit
        ? {
          current: session.subsequentBuyCount,
          target: session.targetBuysAfterEntry,
        }
        : null,
      entry: entry
        ? {
          mode: entry.mode,
          amountInBnb: formatEther(entry.amountInWei),
          amountOutToken: formatUnits(entry.amountOutToken, metadata?.decimals ?? 18),
          confirmedAt: isoDate(entry.confirmedAtMs),
          transactionHash: entry.transactionHash ?? null,
        }
        : null,
      valuation: entry && !exit
        ? {
          grossQuoteBnb: quote ? formatEther(quote.grossWei) : null,
          estimatedNetValueBnb: quote ? formatEther(quote.estimatedNetWei) : null,
          sellTaxAppliedBps: quote?.sellTaxAppliedBps ?? null,
          error: valuationError,
        }
        : null,
      exit: exit
        ? {
          mode: exit.mode,
          amountInToken: formatUnits(exit.amountInToken, metadata?.decimals ?? 18),
          amountOutBnb: formatEther(exit.amountOutWei),
          confirmedAt: isoDate(exit.confirmedAtMs),
          transactionHash: exit.transactionHash ?? null,
        }
        : null,
      pnl: {
        unrealizedWei: unrealized?.deltaWei.toString() ?? null,
        unrealizedBnb: unrealized ? formatEther(unrealized.deltaWei) : null,
        unrealizedPercent: unrealized?.percentage ?? null,
        realizedWei: realized?.deltaWei.toString() ?? null,
        realizedBnb: realized ? formatEther(realized.deltaWei) : null,
        realizedPercent: realized?.percentage ?? null,
      },
      links: {
        token: explorerUrl(`address/${record.tokenAddress}`),
        pair: record.pairAddress ? explorerUrl(`address/${record.pairAddress}`) : null,
        creationTransaction: pair?.createdTransactionHash
          ? explorerUrl(`tx/${pair.createdTransactionHash}`)
          : null,
        entryTransaction: entry?.transactionHash
          ? explorerUrl(`tx/${entry.transactionHash}`)
          : null,
        exitTransaction: exit?.transactionHash
          ? explorerUrl(`tx/${exit.transactionHash}`)
          : null,
      },
    };
  }

  private async quotePosition(
    session: TokenSession,
    sellTaxBps: number | null,
  ): Promise<PositionQuote> {
    const amountIn = session.entry?.amountOutToken ?? 0n;
    if (amountIn <= 0n) throw new Error('Quantité de token nulle.');
    const quoted = await publicClient.readContract({
      address: session.pair.router,
      abi: pancakeRouterAbi,
      functionName: 'getAmountsOut',
      args: [amountIn, [session.pair.token, session.pair.wbnb]],
    });
    const grossWei = quoted[quoted.length - 1] ?? 0n;
    const applicableTax = sellTaxBps !== null && sellTaxBps >= 0 && sellTaxBps <= 10_000
      ? sellTaxBps
      : null;
    return {
      grossWei,
      estimatedNetWei: applicableTax === null
        ? grossWei
        : applyBasisPointReduction(grossWei, applicableTax),
      sellTaxAppliedBps: applicableTax,
    };
  }

  private async readWalletBalance(): Promise<bigint | null> {
    if (!account) return null;
    try {
      return await publicClient.getBalance({ address: account.address });
    } catch (error) {
      logger.debug({ reason: errorMessage(error) }, 'Solde wallet indisponible pour le dashboard.');
      return null;
    }
  }
}

export class DashboardServer {
  private server: Server | null = null;

  constructor(private readonly service: DashboardService) {}

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server = server;

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => reject(error);
        server.once('error', onError);
        server.listen(config.dashboardPort, config.dashboardHost, () => {
          server.off('error', onError);
          resolve();
        });
      });
    } catch (error) {
      this.server = null;
      throw error;
    }

    logger.info(
      {
        host: config.dashboardHost,
        port: config.dashboardPort,
        url: `http://${config.dashboardHost}:${config.dashboardPort}/dashboard`,
      },
      'Dashboard en lecture seule démarré.',
    );
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? 'GET';
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;

    try {
      if (method !== 'GET') {
        this.sendJson(response, 405, { error: 'Méthode non autorisée.' }, { Allow: 'GET' });
        return;
      }
      if (pathname === '/api/dashboard') {
        this.sendJson(response, 200, await this.service.getSnapshot());
        return;
      }
      if (pathname === '/health') {
        this.sendJson(response, 200, {
          status: 'ok',
          network: config.network,
          executionMode: config.executionMode,
          dashboardReadOnly: true,
        });
        return;
      }
      if (pathname === '/' || pathname === '/dashboard' || pathname === '/dashboard/') {
        this.sendPage(response);
        return;
      }
      this.sendJson(response, 404, { error: 'Ressource introuvable.' });
    } catch (error) {
      logger.error({ reason: errorMessage(error), pathname }, 'Erreur du dashboard.');
      if (!response.headersSent) {
        this.sendJson(response, 500, { error: 'Le dashboard ne peut pas charger les données.' });
      } else {
        response.end();
      }
    }
  }

  private sendPage(response: ServerResponse): void {
    const nonce = randomBytes(18).toString('base64');
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': `default-src 'none'; connect-src 'self'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
    response.end(renderDashboardPage(nonce, config.dashboardRefreshSeconds));
  }

  private sendJson(
    response: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ): void {
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    });
    response.end(JSON.stringify(body));
  }
}
