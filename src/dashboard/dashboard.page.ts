export function renderDashboardPage(nonce: string, refreshSeconds: number): string {
  const refreshMilliseconds = refreshSeconds * 1000;
  return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>BSC Token Listener</title>
  <style nonce="${nonce}">
    :root {
      color-scheme: dark;
      --bg: #07101f;
      --panel: #0d192b;
      --panel-2: #12223a;
      --line: #223552;
      --text: #eef5ff;
      --muted: #91a4bf;
      --accent: #70a5ff;
      --positive: #45d49c;
      --negative: #ff7189;
      --warning: #ffc766;
      --radius: 14px;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: radial-gradient(circle at top, #102a4c 0, var(--bg) 38rem); color: var(--text); }
    button, a { font: inherit; }
    button { cursor: pointer; }
    .shell { width: min(1500px, calc(100% - 32px)); margin: 0 auto; padding: 28px 0 48px; }
    .topbar { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; margin-bottom: 24px; }
    .brand h1 { margin: 0; font-size: clamp(1.45rem, 3vw, 2.15rem); letter-spacing: -.035em; }
    .brand p { margin: 8px 0 0; color: var(--muted); }
    .runtime { display: flex; align-items: center; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
    .badge { display: inline-flex; align-items: center; gap: 7px; min-height: 32px; padding: 5px 10px; border: 1px solid var(--line); border-radius: 999px; background: rgba(13,25,43,.88); color: var(--muted); font-size: .82rem; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--positive); box-shadow: 0 0 0 4px rgba(69,212,156,.12); }
    .refresh { border: 1px solid #37609a; border-radius: 9px; background: #18345b; color: var(--text); padding: 8px 12px; }
    .refresh:disabled { cursor: progress; opacity: .65; }
    .cards { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; margin-bottom: 20px; }
    .card { min-height: 128px; padding: 18px; border: 1px solid var(--line); border-radius: var(--radius); background: linear-gradient(145deg, rgba(18,34,58,.96), rgba(10,22,39,.96)); box-shadow: 0 16px 50px rgba(0,0,0,.18); }
    .card-label { color: var(--muted); font-size: .84rem; }
    .card-value { margin-top: 14px; font-size: clamp(1.25rem, 2.5vw, 1.9rem); font-weight: 760; letter-spacing: -.025em; overflow-wrap: anywhere; }
    .card-note { margin-top: 8px; color: var(--muted); font-size: .78rem; }
    .positive { color: var(--positive); }
    .negative { color: var(--negative); }
    .panel { border: 1px solid var(--line); border-radius: var(--radius); background: rgba(13,25,43,.94); overflow: hidden; box-shadow: 0 24px 70px rgba(0,0,0,.22); }
    .panel-head { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 14px 16px; border-bottom: 1px solid var(--line); }
    .tabs { display: flex; flex-wrap: wrap; gap: 6px; }
    .tab { border: 1px solid transparent; border-radius: 9px; background: transparent; color: var(--muted); padding: 8px 11px; }
    .tab.active { border-color: #315887; background: #172d4b; color: var(--text); }
    .sync { color: var(--muted); font-size: .78rem; text-align: right; }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; min-width: 1120px; }
    th { padding: 12px 14px; text-align: left; color: var(--muted); background: #0a1627; font-size: .73rem; text-transform: uppercase; letter-spacing: .055em; }
    td { padding: 14px; border-top: 1px solid rgba(34,53,82,.68); vertical-align: middle; font-size: .86rem; }
    tbody tr:hover { background: rgba(112,165,255,.045); }
    .token-name { font-weight: 720; }
    .sub { display: block; margin-top: 4px; color: var(--muted); font-size: .75rem; }
    .status { display: inline-flex; align-items: center; padding: 5px 8px; border-radius: 999px; border: 1px solid var(--line); background: #13243c; font-size: .75rem; white-space: nowrap; }
    .status.good { color: var(--positive); border-color: rgba(69,212,156,.35); }
    .status.bad { color: var(--negative); border-color: rgba(255,113,137,.35); }
    .status.warn { color: var(--warning); border-color: rgba(255,199,102,.35); }
    .details-button { border: 1px solid #315887; border-radius: 8px; background: #142b49; color: var(--text); padding: 7px 10px; }
    .empty { padding: 46px 16px; text-align: center; color: var(--muted); }
    .error-banner { display: none; margin-bottom: 14px; padding: 12px 14px; border: 1px solid rgba(255,113,137,.42); border-radius: 10px; background: rgba(90,24,40,.45); color: #ffd5dc; }
    .error-banner.visible { display: block; }
    dialog { width: min(760px, calc(100% - 28px)); max-height: calc(100vh - 40px); border: 1px solid var(--line); border-radius: 16px; padding: 0; background: var(--panel); color: var(--text); box-shadow: 0 32px 100px rgba(0,0,0,.58); }
    dialog::backdrop { background: rgba(2,7,15,.76); backdrop-filter: blur(3px); }
    .dialog-head { position: sticky; top: 0; display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; padding: 18px 20px; border-bottom: 1px solid var(--line); background: var(--panel); z-index: 1; }
    .dialog-head h2 { margin: 0; font-size: 1.2rem; }
    .close { border: 1px solid var(--line); border-radius: 8px; background: var(--panel-2); color: var(--text); padding: 6px 10px; }
    .dialog-body { padding: 20px; }
    .detail-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .detail { padding: 12px; border: 1px solid var(--line); border-radius: 10px; background: #0a1627; }
    .detail dt { color: var(--muted); font-size: .72rem; }
    .detail dd { margin: 7px 0 0; overflow-wrap: anywhere; }
    .section-title { margin: 22px 0 10px; font-size: .92rem; }
    .timeline { margin: 0; padding: 0; list-style: none; }
    .timeline li { display: grid; grid-template-columns: 155px 1fr; gap: 12px; padding: 9px 0; border-top: 1px solid rgba(34,53,82,.65); }
    .timeline time { color: var(--muted); font-size: .76rem; }
    .links { display: flex; flex-wrap: wrap; gap: 8px; }
    .links a { color: #9fc2ff; text-decoration: none; border: 1px solid #315887; border-radius: 8px; padding: 7px 9px; }
    .alert { margin-top: 16px; padding: 11px; border-radius: 9px; background: rgba(117,37,54,.42); color: #ffd1d9; }
    .footnote { margin: 14px 2px 0; color: var(--muted); font-size: .77rem; line-height: 1.5; }
    @media (max-width: 950px) { .cards { grid-template-columns: repeat(2, minmax(0,1fr)); } .topbar { flex-direction: column; } .runtime { justify-content: flex-start; } }
    @media (max-width: 560px) { .shell { width: min(100% - 18px, 1500px); padding-top: 18px; } .cards { grid-template-columns: 1fr; } .panel-head { align-items: flex-start; flex-direction: column; } .sync { text-align: left; } .detail-grid { grid-template-columns: 1fr; } .timeline li { grid-template-columns: 1fr; gap: 3px; } }
  </style>
</head>
<body>
  <main class="shell">
    <header class="topbar">
      <div class="brand">
        <h1>BSC Token Listener</h1>
        <p>Supervision en lecture seule des tokens écoutés et des positions.</p>
      </div>
      <div class="runtime">
        <span class="badge"><span class="dot"></span><span id="bot-status">Connexion…</span></span>
        <span class="badge" id="network-badge">Réseau —</span>
        <span class="badge" id="mode-badge">Mode —</span>
        <button class="refresh" id="refresh-button" type="button">Actualiser</button>
      </div>
    </header>

    <div class="error-banner" id="error-banner" role="alert"></div>

  <section class="cards" aria-label="Synthèse">
      <article class="card"><div class="card-label">Dernier bloc BSC</div><div class="card-value" id="heartbeat-latest-block">—</div><div class="card-note" id="heartbeat-pair-created">Checkpoint pair-created: —</div></article>
      <article class="card"><div class="card-label">Monitoring</div><div class="card-value" id="heartbeat-swap-monitors">—</div><div class="card-note" id="heartbeat-monitor-queue">File: —</div><div class="card-note" id="heartbeat-monitor-wait">Attente max: —</div><div class="card-note" id="heartbeat-active-sessions">Sessions actives: —</div></article>
      <article class="card"><div class="card-label">Etat RPC</div><div class="card-value" id="heartbeat-http-status">—</div><div class="card-note" id="heartbeat-ws-status">WS : —</div></article>
      <article class="card"><div class="card-label">Providers RPC</div><div class="card-value" id="heartbeat-providers">—</div><div class="card-note" id="heartbeat-providers-detail">Détails: —</div></article>
      <article class="card"><div class="card-label">Budget RPC</div><div class="card-value" id="rpc-usage-total">—</div><div class="card-note" id="rpc-usage-budget">Projection: —</div><div class="card-note" id="rpc-usage-retries">Retries: —</div></article>
      <article class="card"><div class="card-label">Chaîne canonique</div><div class="card-value" id="chain-state">—</div><div class="card-note" id="chain-confirmed-head">Head confirmé: —</div><div class="card-note" id="chain-canonical-tip">Tip canonique: —</div><div class="card-note" id="chain-last-reorg">Dernier reorg: —</div></article>
      <article class="card"><div class="card-label">Réconciliation</div><div class="card-value" id="recovery-pending-sessions">—</div><div class="card-note" id="recovery-manual-review">Revue manuelle: —</div><div class="card-note" id="recovery-last-completed">Dernière passe: —</div></article>
      <article class="card"><div class="card-label">Solde wallet</div><div class="card-value" id="wallet-balance">—</div><div class="card-note" id="wallet-address">Wallet non configuré</div></article>
      <article class="card"><div class="card-label">Positions ouvertes</div><div class="card-value" id="open-positions">—</div><div class="card-note" id="detected-count">— tokens détectés</div></article>
      <article class="card"><div class="card-label">PnL latent estimé</div><div class="card-value" id="unrealized-pnl">—</div><div class="card-note" id="valuation-note">Cotation PancakeSwap V2</div></article>
      <article class="card"><div class="card-label">PnL brut réalisé</div><div class="card-value" id="realized-gross-pnl">—</div><div class="card-note" id="closed-count">— positions clôturées</div></article>
      <article class="card"><div class="card-label">Gas total</div><div class="card-value" id="realized-gas">—</div><div class="card-note">Gas confirmé achat + approval + vente</div></article>
      <article class="card"><div class="card-label">PnL net réalisé</div><div class="card-value" id="realized-net-pnl">—</div><div class="card-note">PnL brut moins gas confirmé</div></article>
    </section>

    <section class="panel">
      <div class="panel-head">
        <nav class="tabs" aria-label="Filtres">
          <button class="tab active" type="button" data-tab="listened">Écoutés <span id="tab-listened-count"></span></button>
          <button class="tab" type="button" data-tab="bought">Achetés <span id="tab-bought-count"></span></button>
          <button class="tab" type="button" data-tab="sold">Vendus <span id="tab-sold-count"></span></button>
          <button class="tab" type="button" data-tab="errors">Erreurs <span id="tab-errors-count"></span></button>
        </nav>
        <div class="sync" id="sync-label">Aucune synchronisation</div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Token</th><th>Détection</th><th>Entrée</th><th>Risque</th><th>Statut</th><th>Investi</th><th>Valeur / récupéré</th><th>PnL</th><th>Déclencheur</th><th></th></tr></thead>
          <tbody id="tokens-body"></tbody>
        </table>
        <div class="empty" id="empty-state" hidden>Aucun token dans cette vue.</div>
      </div>
    </section>
    <p class="footnote" id="fee-note">Les valeurs sont exprimées en BNB. Le dashboard ne permet aucune action de trading.</p>
  </main>

  <dialog id="details-dialog">
    <div class="dialog-head"><div><h2 id="dialog-title">Détail</h2><span class="sub" id="dialog-address"></span></div><button class="close" id="dialog-close" type="button">Fermer</button></div>
    <div class="dialog-body" id="dialog-content"></div>
  </dialog>

  <script nonce="${nonce}">
    'use strict';
    const REFRESH_MS = ${refreshMilliseconds};
    const state = { snapshot: null, tab: 'listened', filtered: [] };
    const byId = function (id) { return document.getElementById(id); };
    const escapeHtml = function (value) {
      return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, function (character) {
        return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[character];
      });
    };
    const shortAddress = function (value) { return value ? value.slice(0, 6) + '…' + value.slice(-4) : '—'; };
    const formatDate = function (value) { return value ? new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(value)) : '—'; };
    const formatBnb = function (value) {
      if (value === null || value === undefined) return '—';
      const number = Number(value);
      if (!Number.isFinite(number)) return escapeHtml(value) + ' BNB';
      return number.toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 8 }) + ' BNB';
    };
    const formatTokenAmount = function (value, symbol) {
      if (value === null || value === undefined) return '—';
      const number = Number(value);
      const displayed = Number.isFinite(number) ? number.toLocaleString('fr-FR', { maximumFractionDigits: 6 }) : value;
      return displayed + (symbol ? ' ' + symbol : '');
    };
    const toneForValue = function (value) { return value !== null && String(value).startsWith('-') ? 'negative' : 'positive'; };
    const statusTone = function (status) {
      if (status === 'CLOSED' || status === 'HOLDING') return 'good';
      if (status === 'REJECTED' || status === 'MANUAL_REVIEW') return 'bad';
      return 'warn';
    };
    const riskTone = function (verdict) { return verdict === 'ALLOW' ? 'good' : verdict === 'BLOCK' ? 'bad' : 'warn'; };
    const safeLink = function (url, label) {
      if (!url) return '';
      try {
        const parsed = new URL(url);
        const allowedHosts = ['bscscan.com', 'testnet.bscscan.com', 'dexscreener.com'];
        if (parsed.protocol !== 'https:' || !allowedHosts.includes(parsed.hostname)) return '';
        return '<a href="' + escapeHtml(parsed.href) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(label) + '</a>';
      } catch (_error) { return ''; }
    };
    const pnlHtml = function (bnb, percentage) {
      if (bnb === null || bnb === undefined) return '—';
      const suffix = percentage === null || percentage === undefined ? '' : ' <span class="sub">(' + escapeHtml(percentage) + ' %)</span>';
      return '<span class="' + toneForValue(bnb) + '">' + escapeHtml(formatBnb(bnb)) + suffix + '</span>';
    };
    const categories = function (tokens) {
      return {
        listened: tokens,
        bought: tokens.filter(function (token) { return token.entry !== null && token.exit === null; }),
        sold: tokens.filter(function (token) { return token.exit !== null || token.status === 'CLOSED'; }),
        errors: tokens.filter(function (token) { return Boolean(token.error) || token.failedTradeCount > 0; })
      };
    };

    function renderSummary(snapshot) {
      byId('bot-status').textContent = 'Bot actif';
      byId('network-badge').textContent = snapshot.network === 'mainnet' ? 'BSC Mainnet' : 'BSC Testnet';
      byId('mode-badge').textContent = snapshot.executionMode === 'live' ? 'LIVE' : 'DRY-RUN';
      byId('wallet-balance').textContent = formatBnb(snapshot.summary.walletBalanceBnb);
      byId('wallet-address').textContent = snapshot.walletAddress ? shortAddress(snapshot.walletAddress) : 'Wallet non configuré';
      byId('open-positions').textContent = String(snapshot.summary.openPositions);
      byId('detected-count').textContent = String(snapshot.summary.detectedTokens) + ' tokens détectés';
      byId('unrealized-pnl').innerHTML = pnlHtml(snapshot.summary.unrealizedPnlBnb, null);
      byId('valuation-note').textContent = snapshot.summary.valuationComplete ? 'Toutes les positions cotées' : 'Valorisation partielle ou indisponible';
      byId('realized-gross-pnl').innerHTML = pnlHtml(snapshot.summary.realizedGrossPnlBnb, null);
      byId('realized-gas').textContent = formatBnb(snapshot.summary.realizedGasBnb);
      byId('realized-net-pnl').innerHTML = pnlHtml(snapshot.summary.realizedNetPnlBnb, null);
      byId('closed-count').textContent = String(snapshot.summary.closedPositions) + ' positions clôturées';
      byId('heartbeat-latest-block').textContent = snapshot.heartbeat && snapshot.heartbeat.latestBlock
        ? snapshot.heartbeat.latestBlock
        : '—';
      byId('heartbeat-pair-created').textContent = 'Checkpoint pair-created: '
        + (snapshot.heartbeat && snapshot.heartbeat.pairCreatedCheckpoint
          ? snapshot.heartbeat.pairCreatedCheckpoint
          : '—');
      byId('heartbeat-swap-monitors').textContent = snapshot.heartbeat
        ? String(snapshot.heartbeat.monitoring.activeMonitors)
          + ' / ' + String(snapshot.heartbeat.monitoring.capacity)
        : '0 / 0';
      byId('heartbeat-monitor-queue').textContent = snapshot.heartbeat
        ? 'File: ' + String(snapshot.heartbeat.monitoring.waitingSessions)
          + ' · Échecs: ' + String(snapshot.heartbeat.monitoring.abandonedSessions)
        : 'File: 0 · Échecs: 0';
      byId('heartbeat-monitor-wait').textContent = snapshot.heartbeat
        && snapshot.heartbeat.monitoring.oldestWaitingAgeMs !== null
        ? 'Attente max: '
          + String(Math.floor(snapshot.heartbeat.monitoring.oldestWaitingAgeMs / 1000)) + ' s'
        : 'Attente max: —';
      byId('heartbeat-active-sessions').textContent = 'Sessions actives: '
        + String(snapshot.heartbeat ? snapshot.heartbeat.activeSessions : 0);
      byId('heartbeat-http-status').textContent = snapshot.heartbeat
        ? (snapshot.heartbeat.http.status === 'up' ? 'HTTP: OK' : 'HTTP: KO')
        : 'HTTP: —';
      byId('heartbeat-ws-status').textContent = snapshot.heartbeat
        ? (snapshot.heartbeat.webSocket.status === 'up' ? 'WS: OK' : 'WS: KO')
        : 'WS: —';
      const rpcUsage = snapshot.heartbeat ? snapshot.heartbeat.rpcUsage : null;
      byId('rpc-usage-total').textContent = rpcUsage
        ? String(rpcUsage.totalRequests) + ' requêtes'
        : '—';
      byId('rpc-usage-budget').textContent = rpcUsage
        ? (rpcUsage.budget.projectionStatus === 'ready'
          ? 'Projection 30 j: ' + String(rpcUsage.budget.projection30d)
          : 'Projection: observation insuffisante')
        : 'Projection: —';
      byId('rpc-usage-retries').textContent = rpcUsage
        ? 'Retries: ' + String(Object.values(rpcUsage.methods).reduce(function (sum, method) {
          return sum + method.retries;
        }, 0))
        : 'Retries: —';
      const providers = snapshot.heartbeat ? snapshot.heartbeat.providers : [];
      byId('heartbeat-providers').textContent = providers.length === 0
        ? 'Aucun fournisseur actif'
        : providers.map(function (provider) {
          const lag = provider.lagging ? ' · LAG' : '';
          return provider.id + '/' + provider.kind + ' · ' + provider.status + lag;
        }).join('\\n');
      byId('heartbeat-providers-detail').textContent = providers.length === 0
        ? 'Détails: indisponible'
        : providers.map(function (provider) {
          return (
            provider.id
            + ' · block: ' + (provider.blockNumber || '—')
            + ' · erreurs: ' + String(provider.errorRate)
            + ' % · latence: ' + String(provider.latencyMs ?? '—')
            + ' ms'
          );
        }).join(' | ');
      const chain = snapshot.heartbeat ? snapshot.heartbeat.chain : null;
      byId('chain-state').textContent = chain
        ? chain.state + (chain.stale ? ' · STALE' : '')
        : '—';
      byId('chain-confirmed-head').textContent = chain
        ? 'Head confirmé (' + String(chain.confirmations) + ' blocs): '
          + (chain.confirmedHead || '—')
        : 'Head confirmé: —';
      byId('chain-canonical-tip').textContent = chain
        ? 'Tip: ' + (chain.canonicalBlockNumber || '—')
          + (chain.canonicalBlockHash ? ' · ' + shortAddress(chain.canonicalBlockHash) : '')
        : 'Tip: —';
      byId('chain-last-reorg').textContent = chain && chain.lastReorg
        ? 'Reorg ' + chain.lastReorg.status + ' · ' + formatDate(chain.lastReorg.detectedAt)
          + ' · ancêtre ' + (chain.lastReorg.commonAncestorNumber || '—')
          + (chain.lastReorg.commonAncestorHash
            ? ' ' + shortAddress(chain.lastReorg.commonAncestorHash)
            : '')
          + ' · profondeur '
          + (chain.lastReorg.depth === null ? '—' : String(chain.lastReorg.depth))
          + ' · orphelins/rejoués ' + String(chain.lastReorg.orphanedEvents)
          + '/' + String(chain.lastReorg.replayedEvents)
        : 'Dernier reorg: —';
      byId('chain-last-reorg').title = chain && chain.lastReorg
        ? 'Détecté ' + formatDate(chain.lastReorg.detectedAt)
          + ' · ancêtre ' + (chain.lastReorg.commonAncestorNumber || '—')
          + (chain.lastReorg.commonAncestorHash
            ? ' ' + chain.lastReorg.commonAncestorHash
            : '')
        : '';
      byId('recovery-pending-sessions').textContent = snapshot.heartbeat
        ? String(snapshot.heartbeat.recovery.pendingSessions)
        : '—';
      byId('recovery-manual-review').textContent = 'Revue manuelle: '
        + String(snapshot.heartbeat ? snapshot.heartbeat.recovery.manualReviewSessions : 0);
      byId('recovery-last-completed').textContent = 'Dernière passe: '
        + (snapshot.heartbeat && snapshot.heartbeat.recovery.lastCompletedAt
          ? formatDate(snapshot.heartbeat.recovery.lastCompletedAt)
          : '—');
      byId('recovery-last-completed').title = snapshot.heartbeat
        ? (snapshot.heartbeat.recovery.lastErrorType || '')
        : '';
      byId('bot-status').title = snapshot.heartbeat ? snapshot.heartbeat.generatedAt : '';
      byId('fee-note').textContent = snapshot.feeNote + ' Le dashboard est strictement en lecture seule.';
      byId('sync-label').textContent = 'Actualisé le ' + formatDate(snapshot.generatedAt);
    }

    function renderTabs(tokens) {
      const grouped = categories(tokens);
      byId('tab-listened-count').textContent = '(' + grouped.listened.length + ')';
      byId('tab-bought-count').textContent = '(' + grouped.bought.length + ')';
      byId('tab-sold-count').textContent = '(' + grouped.sold.length + ')';
      byId('tab-errors-count').textContent = '(' + grouped.errors.length + ')';
      state.filtered = grouped[state.tab] || grouped.listened;
    }

    function renderTable() {
      const body = byId('tokens-body');
      const empty = byId('empty-state');
      if (state.filtered.length === 0) {
        body.innerHTML = '';
        empty.hidden = false;
        return;
      }
      empty.hidden = true;
      body.innerHTML = state.filtered.map(function (token, index) {
        const label = token.symbol || token.name || 'Token';
        const risk = token.risk.verdict ? '<span class="status ' + riskTone(token.risk.verdict) + '">' + escapeHtml(token.risk.verdict) + ' · ' + escapeHtml(token.risk.score) + '/100</span>' : '—';
        const invested = token.entry ? formatBnb(token.entry.amountInBnb) : '—';
        const entry = token.entry ? formatDate(token.entry.confirmedAt) : '—';
        const dexscreener = token.pairAddress ? 'https://dexscreener.com/bsc/' + token.pairAddress : null;
        const value = token.exit ? formatBnb(token.exit.amountOutBnb) : token.valuation ? formatBnb(token.valuation.estimatedNetValueBnb) : '—';
        const realizedValue = token.pnl.realizedNetBnb === null ? token.pnl.realizedGrossBnb : token.pnl.realizedNetBnb;
        const realizedPercent = token.pnl.realizedNetPercent === null ? token.pnl.realizedGrossPercent : token.pnl.realizedNetPercent;
        const simulation = token.pnl.kind === 'SIMULATED' ? '<span class="sub">Simulation</span>' : '';
        const pnl = token.exit ? pnlHtml(realizedValue, realizedPercent) + simulation : pnlHtml(token.pnl.unrealizedBnb, token.pnl.unrealizedPercent);
        const progress = token.progress ? escapeHtml(token.progress.current) + ' / ' + escapeHtml(token.progress.target) + '<span class="sub">achats après entrée</span>' : '—';
        return '<tr>' +
          '<td><span class="token-name">' + escapeHtml(label) + '</span><span class="sub">' + escapeHtml(shortAddress(token.tokenAddress)) + '</span></td>' +
          '<td>' + escapeHtml(formatDate(token.detectedAt)) + '<span class="sub">' + escapeHtml(token.source) + '</span></td>' +
          '<td>' + escapeHtml(entry) + '</td>' +
          '<td>' + risk + '</td>' +
          '<td><span class="status ' + statusTone(token.status) + '">' + escapeHtml(token.statusLabel) + '</span></td>' +
          '<td>' + escapeHtml(invested) + '</td>' +
          '<td>' + escapeHtml(value) + '</td>' +
          '<td>' + pnl + '</td>' +
          '<td>' + progress + '</td>' +
          '<td>' + safeLink(dexscreener, 'Dexscreener') + ' <button type="button" class="details-button" data-index="' + index + '">Voir</button></td>' +
          '</tr>';
      }).join('');
    }

    function render() {
      if (!state.snapshot) return;
      renderSummary(state.snapshot);
      renderTabs(state.snapshot.tokens);
      renderTable();
    }

    function detailItem(label, value) {
      return '<div class="detail"><dt>' + escapeHtml(label) + '</dt><dd>' + escapeHtml(value === null || value === undefined ? '—' : value) + '</dd></div>';
    }

    function showDetails(token) {
      const title = token.symbol || token.name || 'Token';
      byId('dialog-title').textContent = title;
      byId('dialog-address').textContent = token.tokenAddress;
      const risk = token.risk.verdict ? token.risk.verdict + ' · ' + token.risk.score + '/100' : 'Non disponible';
      const timeline = [
        { at: token.detectedAt, text: 'Paire détectée et écoute démarrée.' },
        token.firstBuyAt ? { at: token.firstBuyAt, text: 'Premier achat externe confirmé.' } : null,
        token.entry ? { at: token.entry.confirmedAt, text: 'Entrée ' + token.entry.mode + ' confirmée pour ' + formatBnb(token.entry.amountInBnb) + '.' } : null,
        token.progress ? { at: token.updatedAt, text: token.progress.current + ' achat(s) externe(s) comptabilisé(s) sur ' + token.progress.target + '.' } : null,
        token.exit ? { at: token.exit.confirmedAt, text: 'Position clôturée, ' + formatBnb(token.exit.amountOutBnb) + ' récupéré.' } : null,
        token.error ? { at: token.updatedAt, text: token.error } : null
      ].filter(Boolean);
      const links = [
        safeLink(token.links.token, 'Token BscScan'),
        safeLink(token.links.pair, 'Paire BscScan'),
        safeLink(token.pairAddress ? 'https://dexscreener.com/bsc/' + token.pairAddress : null, 'Dexscreener'),
        safeLink(token.links.creationTransaction, 'Transaction de création'),
        safeLink(token.links.entryTransaction, 'Transaction d’achat'),
        safeLink(token.links.exitTransaction, 'Transaction de vente')
      ].filter(Boolean).join('');
      const valuation = token.exit ? formatBnb(token.exit.amountOutBnb) : token.valuation ? formatBnb(token.valuation.estimatedNetValueBnb) : 'Indisponible';
      const realizedGross = formatBnb(token.pnl.realizedGrossBnb) + (token.pnl.kind === 'SIMULATED' ? ' (Simulation)' : '');
      const realizedNet = formatBnb(token.pnl.realizedNetBnb);
      const gas = formatBnb(token.pnl.gasBnb);
      const pnl = token.exit ? (token.pnl.realizedNetBnb === null ? realizedGross : realizedNet) : (formatBnb(token.pnl.unrealizedBnb) + (token.pnl.unrealizedPercent ? ' (' + token.pnl.unrealizedPercent + ' %)' : ''));
      const positionExit = token.positionExit;
      const exitPnl = positionExit && positionExit.economicPnlPercent !== null
        ? positionExit.economicPnlPercent + ' %'
        : '—';
      byId('dialog-content').innerHTML =
        '<dl class="detail-grid">' +
          detailItem('Statut', token.statusLabel) +
          detailItem('Risque', risk) +
          detailItem('Paire', token.pairAddress ? shortAddress(token.pairAddress) : '—') +
          detailItem('Swaps observés', token.swaps.total + ' (' + token.swaps.buys + ' achats / ' + token.swaps.sells + ' ventes)') +
          detailItem('Montant investi', token.entry ? formatBnb(token.entry.amountInBnb) : '—') +
          detailItem('Tokens reçus', token.entry ? formatTokenAmount(token.entry.amountOutToken, token.symbol) : '—') +
          detailItem(token.exit ? 'Montant récupéré' : 'Valeur estimée', valuation) +
          detailItem(token.exit ? 'PnL brut' : 'PnL latent', token.exit ? realizedGross : pnl) +
          detailItem('Gas total', token.exit ? gas : '—') +
          detailItem('PnL net', token.exit ? realizedNet : '—') +
          detailItem('Liquidité WBNB au contrôle', token.risk.liquidityBnb ? formatBnb(token.risk.liquidityBnb) : '—') +
          detailItem('Taxes estimées', 'Achat ' + (token.risk.buyTaxPercent || '—') + ' % / Vente ' + (token.risk.sellTaxPercent || '—') + ' %') +
          detailItem('Prochaine évaluation', positionExit ? formatDate(positionExit.nextEvaluationAt) : '—') +
          detailItem('Durée restante', positionExit && positionExit.remainingHoldingSeconds !== null ? positionExit.remainingHoldingSeconds + ' s' : '—') +
          detailItem('Valeur nette économique', positionExit ? formatBnb(positionExit.netValueBnb) : '—') +
          detailItem('PnL économique', exitPnl) +
          detailItem('Stop-loss', positionExit ? positionExit.stopLossPercent + ' %' : '—') +
          detailItem('Take-profit', positionExit ? positionExit.takeProfitPercent + ' %' : '—') +
          detailItem('Trailing', positionExit ? (positionExit.trailingEnabled ? (positionExit.trailingArmed ? 'Armé' : 'En attente') : 'Désactivé') : '—') +
          detailItem('Probe de vente', positionExit ? token.positionExit.lastProbeStatus : '—') +
          detailItem('Dernière raison', positionExit ? positionExit.lastReason : '—') +
          detailItem('État stale', positionExit ? positionExit.staleReason : '—') +
        '</dl>' +
        (token.error ? '<div class="alert">' + escapeHtml(token.error) + '</div>' : '') +
        '<h3 class="section-title">Chronologie</h3><ol class="timeline">' + timeline.map(function (event) { return '<li><time>' + escapeHtml(formatDate(event.at)) + '</time><span>' + escapeHtml(event.text) + '</span></li>'; }).join('') + '</ol>' +
        '<h3 class="section-title">Explorateur</h3><div class="links">' + (links || '<span class="sub">Aucun lien disponible</span>') + '</div>' +
        (token.valuation && token.valuation.error ? '<div class="alert">Cotation : ' + escapeHtml(token.valuation.error) + '</div>' : '');
      byId('details-dialog').showModal();
    }

    async function loadDashboard() {
      const button = byId('refresh-button');
      button.disabled = true;
      byId('error-banner').classList.remove('visible');
      try {
        const response = await fetch('/api/dashboard', { cache: 'no-store', headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error('Réponse HTTP ' + response.status);
        state.snapshot = await response.json();
        render();
      } catch (error) {
        byId('bot-status').textContent = 'Dashboard indisponible';
        byId('error-banner').textContent = 'Impossible de charger les données : ' + (error instanceof Error ? error.message : String(error));
        byId('error-banner').classList.add('visible');
      } finally {
        button.disabled = false;
      }
    }

    document.querySelector('.tabs').addEventListener('click', function (event) {
      const button = event.target.closest('[data-tab]');
      if (!button) return;
      state.tab = button.dataset.tab;
      document.querySelectorAll('.tab').forEach(function (tab) { tab.classList.toggle('active', tab === button); });
      renderTabs(state.snapshot ? state.snapshot.tokens : []);
      renderTable();
    });
    byId('tokens-body').addEventListener('click', function (event) {
      const button = event.target.closest('[data-index]');
      if (!button) return;
      const token = state.filtered[Number(button.dataset.index)];
      if (token) showDetails(token);
    });
    byId('refresh-button').addEventListener('click', loadDashboard);
    byId('dialog-close').addEventListener('click', function () { byId('details-dialog').close(); });
    byId('details-dialog').addEventListener('click', function (event) { if (event.target === byId('details-dialog')) byId('details-dialog').close(); });

    loadDashboard();
    window.setInterval(loadDashboard, REFRESH_MS);
  </script>
</body>
</html>`;
}
