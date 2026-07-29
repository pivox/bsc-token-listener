const FIELDS = [
  ['monitorIntervalSeconds', 'Intervalle monitor (s)', 'number'],
  ['maxHoldingMinutes', 'Durée maximale (min)', 'number'],
  ['stopLossBps', 'Stop-loss (bps)', 'number'],
  ['takeProfitBps', 'Take-profit (bps)', 'number'],
  ['liquidityDropBps', 'Baisse liquidité (bps)', 'number'],
  ['probeIntervalSeconds', 'Intervalle probe (s)', 'number'],
  ['quoteBufferBps', 'Buffer quote (bps)', 'number'],
  ['maxGasValueBps', 'Gas maximum / valeur (bps)', 'number'],
  ['emergencyMaxGasWei', 'Gas urgence maximum (wei)', 'text'],
  ['approvalGasUnits', 'Unités gas approval', 'text'],
  ['sellGasUnits', 'Unités gas vente', 'text'],
  ['trailingEnabled', 'Trailing activé', 'checkbox'],
  ['trailingActivationBps', 'Activation trailing (bps)', 'number'],
  ['trailingDrawdownBps', 'Recul trailing (bps)', 'number'],
  ['targetBuysAfterEntry', 'Achats après entrée', 'number'],
] as const;

export function injectExitPolicyControls(page: string, nonce: string): string {
  const inputs = FIELDS.map(([name, label, type]) =>
    `<label>${label}<input name="${name}" data-exit-field="${name}" type="${type}"${type === 'number' ? ' step="1"' : ''}></label>`
  ).join('');
  const section = `<section class="exit-policy-settings" id="exit-policy-settings">
    <div><strong>Politique de sortie des positions</strong>
      <p>Valeurs effectives persistées. Prévisualisation obligatoire avant application.</p>
    </div>
    <form id="exit-policy-form">${inputs}
      <div class="exit-policy-buttons">
        <button type="button" id="exit-policy-preview">Prévisualiser</button>
        <button type="submit" id="exit-policy-apply">Appliquer</button>
        <button type="button" id="exit-policy-reset">Valeurs .env</button>
      </div>
      <output id="exit-policy-status" aria-live="polite"></output>
    </form>
  </section>`;
  const style = `<style nonce="${nonce}">
    .exit-policy-settings { margin-bottom:20px; padding:17px; border:1px solid #355b72; border-radius:14px; background:rgba(17,48,67,.42); }
    .exit-policy-settings p { color:#9db3c5; margin:5px 0 14px; }
    #exit-policy-form { display:grid; grid-template-columns:repeat(auto-fit,minmax(185px,1fr)); gap:10px; }
    #exit-policy-form label { display:flex; flex-direction:column; gap:5px; font-size:.76rem; color:#b8c9d8; }
    #exit-policy-form input { border:1px solid #456174; border-radius:7px; background:#081827; color:#eef7ff; padding:7px; }
    #exit-policy-form input[type=checkbox] { align-self:flex-start; }
    .exit-policy-buttons { display:flex; gap:8px; align-items:end; flex-wrap:wrap; }
    .exit-policy-buttons button { border:1px solid #4f758c; border-radius:8px; background:#12364b; color:#d8efff; padding:8px 10px; }
    #exit-policy-status { grid-column:1/-1; color:#a9c6d8; white-space:pre-wrap; }
  </style>`;
  const script = `<script nonce="${nonce}">
    'use strict';
    (function () {
      const form = document.getElementById('exit-policy-form');
      const status = document.getElementById('exit-policy-status');
      if (!form || !status) return;
      let revision = 0;
      let previewed = false;
      const bigintFields = new Set(['emergencyMaxGasWei','approvalGasUnits','sellGasUnits']);
      function controls() { return Array.from(form.querySelectorAll('[data-exit-field]')); }
      function readCandidate() {
        const value = {};
        controls().forEach(function (input) {
          const key = input.dataset.exitField;
          value[key] = input.type === 'checkbox'
            ? input.checked
            : bigintFields.has(key) ? input.value : Number(input.value);
        });
        return value;
      }
      function applyView(view, writable) {
        revision = view.revision;
        controls().forEach(function (input) {
          const key = input.dataset.exitField;
          if (input.type === 'checkbox') input.checked = Boolean(view.settings[key]);
          else input.value = String(view.settings[key]);
          input.disabled = !writable;
        });
        form.querySelectorAll('button').forEach(function (button) { button.disabled = !writable; });
        previewed = false;
        status.textContent = 'Révision ' + revision + ' · source ' + view.source + (writable ? '' : ' · lecture seule');
      }
      async function request(path, options) {
        const response = await fetch(path, options);
        const payload = await response.json();
        if (!response.ok) {
          if (response.status === 409) void load();
          throw new Error(payload.error || 'Réponse HTTP ' + response.status);
        }
        return payload;
      }
      async function load() {
        const payload = await request('/api/dashboard/exit-policy', { cache:'no-store', headers:{Accept:'application/json'} });
        applyView(payload.view, payload.writable);
      }
      document.getElementById('exit-policy-preview').addEventListener('click', async function () {
        try {
          const preview = await request('/api/dashboard/exit-policy/preview', {
            method:'POST', headers:{Accept:'application/json','Content-Type':'application/json'},
            body:JSON.stringify({settings:readCandidate(),expectedRevision:revision})
          });
          previewed = true;
          status.textContent = preview.affectedPositions.length
            ? 'Impact potentiel : ' + preview.affectedPositions.join(', ')
            : 'Prévisualisation : aucune sortie immédiate.';
        } catch (error) { status.textContent = 'Erreur : ' + error.message; }
      });
      form.addEventListener('input', function () { previewed = false; });
      form.addEventListener('submit', async function (event) {
        event.preventDefault();
        if (!previewed) { status.textContent = 'Prévisualisation obligatoire.'; return; }
        if (!window.confirm('Appliquer cette politique aux positions ouvertes ?')) return;
        try {
          const payload = await request('/api/dashboard/exit-policy', {
            method:'PUT',
            headers:{Accept:'application/json','Content-Type':'application/json','X-Exit-Policy-Confirmation':'APPLY_EXIT_POLICY'},
            body:JSON.stringify({settings:readCandidate(),expectedRevision:revision})
          });
          applyView(payload.view, payload.writable);
        } catch (error) { status.textContent = 'Erreur : ' + error.message; }
      });
      document.getElementById('exit-policy-reset').addEventListener('click', async function () {
        if (!window.confirm('Restaurer les valeurs du fichier .env ?')) return;
        try {
          const payload = await request('/api/dashboard/exit-policy', {
            method:'DELETE',
            headers:{Accept:'application/json','Content-Type':'application/json','X-Exit-Policy-Confirmation':'RESET_EXIT_POLICY'},
            body:JSON.stringify({expectedRevision:revision})
          });
          applyView(payload.view, payload.writable);
        } catch (error) { status.textContent = 'Erreur : ' + error.message; }
      });
      load().catch(function (error) { status.textContent = 'Politique indisponible : ' + error.message; });
    })();
  </script>`;
  return page
    .replace('</head>', `${style}</head>`)
    .replace('<section class="panel">', `${section}<section class="panel">`)
    .replace('</body>', `${script}</body>`);
}
