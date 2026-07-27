import { randomBytes } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { config } from '../config/env.js';
import {
  RiskSettingsStore,
  type RuntimeRiskSettings,
} from '../security/risk-settings.store.js';
import { errorMessage } from '../utils/error.js';
import { logger } from '../utils/logger.js';
import { DashboardService } from './dashboard.js';
import { renderDashboardPage } from './dashboard.page.js';

const RISK_CONFIRMATION = 'I_UNDERSTAND_UNKNOWN_RISK';
const MAX_BODY_BYTES = 2_048;

function isLoopbackHost(host: string): boolean {
  return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host.toLowerCase());
}

function injectRiskSettings(page: string, nonce: string, minimumScore: number): string {
  const style = `<style nonce="${nonce}">
    .risk-settings { display: flex; align-items: center; justify-content: space-between; gap: 18px; margin-bottom: 20px; padding: 15px 17px; border: 1px solid #6a5529; border-radius: 14px; background: rgba(71,52,19,.34); }
    .risk-settings-copy strong { display: block; margin-bottom: 5px; }
    .risk-settings-copy span { color: #c4b58f; font-size: .8rem; }
    .risk-settings-form { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 10px; }
    .risk-settings-form label { display: inline-flex; align-items: center; gap: 7px; color: #eef5ff; font-size: .82rem; }
    .risk-settings-form input[type="number"] { width: 78px; border: 1px solid #4b6382; border-radius: 8px; background: #091629; color: #eef5ff; padding: 7px 8px; }
    .risk-settings-form button { border: 1px solid #8a6c30; border-radius: 8px; background: #4b3512; color: #ffe2a6; padding: 8px 11px; }
    .risk-settings-form button:disabled, .risk-settings-form input:disabled { opacity: .55; cursor: not-allowed; }
    .risk-settings-status { min-width: 130px; color: #c4b58f; font-size: .76rem; }
    @media (max-width: 850px) { .risk-settings { align-items: flex-start; flex-direction: column; } .risk-settings-form { justify-content: flex-start; } }
  </style>`;
  const form = `<section class="risk-settings" aria-label="Réglage du verdict de risque">
    <div class="risk-settings-copy">
      <strong>Seuil ALLOW pour informations inconnues</strong>
      <span>Les FAIL critiques et les WARN restent toujours refusés. Le changement concerne uniquement les futurs rapports.</span>
    </div>
    <form class="risk-settings-form" id="risk-settings-form">
      <label><input id="allow-unknown-reviews" type="checkbox"> Autoriser les UNKNOWN</label>
      <label>Score minimal <input id="allow-unknown-min-score" type="number" min="${minimumScore}" max="100" step="1" value="95"></label>
      <button id="risk-settings-save" type="submit">Enregistrer</button>
      <span class="risk-settings-status" id="risk-settings-status" aria-live="polite"></span>
    </form>
  </section>`;
  const script = `<script nonce="${nonce}">
    'use strict';
    (function () {
      const form = document.getElementById('risk-settings-form');
      const enabled = document.getElementById('allow-unknown-reviews');
      const score = document.getElementById('allow-unknown-min-score');
      const save = document.getElementById('risk-settings-save');
      const status = document.getElementById('risk-settings-status');
      if (!form || !enabled || !score || !save || !status) return;

      function applySettings(settings, writable) {
        enabled.checked = Boolean(settings.allowUnknownReviews);
        score.value = String(settings.allowUnknownMinScore);
        enabled.disabled = !writable;
        score.disabled = !writable;
        save.disabled = !writable;
        status.textContent = writable
          ? (settings.allowUnknownReviews ? 'Actif à partir de ' + settings.allowUnknownMinScore + '/100' : 'Mode strict')
          : 'Modification locale désactivée';
      }

      async function loadSettings() {
        const response = await fetch('/api/dashboard/risk-settings', {
          cache: 'no-store',
          headers: { Accept: 'application/json' }
        });
        if (!response.ok) throw new Error('Réponse HTTP ' + response.status);
        const payload = await response.json();
        applySettings(payload.settings, payload.writable);
      }

      form.addEventListener('submit', async function (event) {
        event.preventDefault();
        const allowUnknownReviews = enabled.checked;
        const allowUnknownMinScore = Number(score.value);
        if (!Number.isInteger(allowUnknownMinScore)
          || allowUnknownMinScore < ${minimumScore}
          || allowUnknownMinScore > 100) {
          status.textContent = 'Valeur entre ${minimumScore} et 100 requise.';
          return;
        }
        if (allowUnknownReviews && !window.confirm(
          'Ce réglage peut autoriser un achat malgré des informations OWNER ou LP inconnues. Continuer ?'
        )) return;

        save.disabled = true;
        status.textContent = 'Enregistrement…';
        try {
          const response = await fetch('/api/dashboard/risk-settings', {
            method: 'POST',
            cache: 'no-store',
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/json',
              'X-Risk-Settings-Confirmation': allowUnknownReviews ? '${RISK_CONFIRMATION}' : ''
            },
            body: JSON.stringify({ allowUnknownReviews, allowUnknownMinScore })
          });
          const payload = await response.json();
          if (!response.ok) throw new Error(payload.error || 'Réponse HTTP ' + response.status);
          applySettings(payload.settings, payload.writable);
          status.textContent = 'Enregistré pour les futurs tokens.';
        } catch (error) {
          status.textContent = 'Erreur : ' + (error instanceof Error ? error.message : String(error));
        } finally {
          save.disabled = false;
        }
      });

      loadSettings().catch(function (error) {
        status.textContent = 'Réglage indisponible : ' + (error instanceof Error ? error.message : String(error));
      });
    })();
  </script>`;

  return page
    .replace('</head>', `${style}</head>`)
    .replace('<section class="panel">', `${form}<section class="panel">`)
    .replace('Supervision en lecture seule des tokens écoutés et des positions.', 'Supervision des tokens, des positions et du seuil de risque.')
    .replace(' Le dashboard est strictement en lecture seule.', ' Le dashboard ne permet aucun achat ou vente manuel.')
    .replace("form-action 'none'", "form-action 'self'")
    .replace('</body>', `${script}</body>`);
}

export class WritableDashboardServer {
  private server: Server | null = null;
  private readonly settingsWritable = isLoopbackHost(config.dashboardHost);

  constructor(
    private readonly service: DashboardService,
    private readonly riskSettings: RiskSettingsStore,
  ) {}

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
        riskSettingsWritable: this.settingsWritable,
      },
      'Dashboard démarré avec réglage local du seuil de risque.',
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
      if (method === 'GET' && pathname === '/api/dashboard') {
        const [snapshot, settings] = await Promise.all([
          this.service.getSnapshot(),
          this.riskSettings.get(),
        ]);
        this.sendJson(response, 200, {
          ...snapshot,
          riskSettings: settings,
          riskSettingsWritable: this.settingsWritable,
        });
        return;
      }
      if (method === 'GET' && pathname === '/api/dashboard/risk-settings') {
        this.sendJson(response, 200, {
          settings: await this.riskSettings.get(),
          writable: this.settingsWritable,
          minimumScore: config.riskMinScore,
        });
        return;
      }
      if (method === 'POST' && pathname === '/api/dashboard/risk-settings') {
        await this.updateRiskSettings(request, response);
        return;
      }
      if (method === 'GET' && pathname === '/health') {
        this.sendJson(response, 200, {
          status: 'ok',
          network: config.network,
          executionMode: config.executionMode,
          dashboardTradingActions: false,
          riskSettingsWritable: this.settingsWritable,
        });
        return;
      }
      if (method === 'GET' && (pathname === '/' || pathname === '/dashboard' || pathname === '/dashboard/')) {
        this.sendPage(response);
        return;
      }
      if (method !== 'GET' && method !== 'POST') {
        this.sendJson(response, 405, { error: 'Méthode non autorisée.' }, { Allow: 'GET, POST' });
        return;
      }
      this.sendJson(response, 404, { error: 'Ressource introuvable.' });
    } catch (error) {
      logger.error({ reason: errorMessage(error), pathname }, 'Erreur du dashboard.');
      if (!response.headersSent) {
        this.sendJson(response, 500, { error: 'Le dashboard ne peut pas traiter la requête.' });
      } else {
        response.end();
      }
    }
  }

  private async updateRiskSettings(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (!this.settingsWritable) {
      this.sendJson(response, 403, { error: 'Le réglage est autorisé uniquement sur une écoute loopback.' });
      return;
    }
    const host = request.headers.host;
    const origin = request.headers.origin;
    if (!host || origin !== `http://${host}`) {
      this.sendJson(response, 403, { error: 'Origine de la requête refusée.' });
      return;
    }
    if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
      this.sendJson(response, 415, { error: 'Content-Type application/json requis.' });
      return;
    }

    const payload = await this.readJsonBody(request) as Partial<RuntimeRiskSettings>;
    if (typeof payload.allowUnknownReviews !== 'boolean') {
      this.sendJson(response, 400, { error: 'allowUnknownReviews doit être un booléen.' });
      return;
    }
    if (payload.allowUnknownReviews
      && request.headers['x-risk-settings-confirmation'] !== RISK_CONFIRMATION) {
      this.sendJson(response, 400, { error: 'Confirmation explicite requise pour autoriser les UNKNOWN.' });
      return;
    }

    const settings = await this.riskSettings.set({
      allowUnknownReviews: payload.allowUnknownReviews,
      allowUnknownMinScore: Number(payload.allowUnknownMinScore),
    });
    logger.warn(
      {
        allowUnknownReviews: settings.allowUnknownReviews,
        allowUnknownMinScore: settings.allowUnknownMinScore,
      },
      'Réglage du verdict de risque modifié depuis le dashboard local.',
    );
    this.sendJson(response, 200, { settings, writable: true });
  }

  private async readJsonBody(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_BODY_BYTES) throw new Error('Corps de requête trop volumineux.');
      chunks.push(buffer);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    return JSON.parse(text || '{}') as unknown;
  }

  private sendPage(response: ServerResponse): void {
    const nonce = randomBytes(18).toString('base64');
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': `default-src 'none'; connect-src 'self'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
    response.end(injectRiskSettings(
      renderDashboardPage(nonce, config.dashboardRefreshSeconds),
      nonce,
      config.riskMinScore,
    ));
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
