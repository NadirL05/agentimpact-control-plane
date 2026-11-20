const apiUrlInput = document.getElementById('apiUrl');
const statusEl = document.getElementById('status');
const workflowsContent = document.getElementById('workflows-content');
const runsContent = document.getElementById('runs-content');

function setStatus(msg) {
  statusEl.textContent = msg;
}

async function fetchJson(path) {
  const url = apiUrlInput.value.trim().replace(/\/$/, '') + path;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderWorkflow(w) {
  return `
    <div class="workflow-item">
      <h3>${escapeHtml(w.name)}</h3>
      <p>${escapeHtml(w.description)}</p>
      <div class="meta">
        <code>${escapeHtml(w.id)}</code><br>
        <strong>Triggers:</strong> ${w.trigger.map(escapeHtml).join(', ')}<br>
        <strong>Steps:</strong> ${w.steps.map(escapeHtml).join(' → ')}
      </div>
      <div style="margin-top: 8px;">
        <button class="success" onclick="runWorkflow('${escapeHtml(w.id)}')">▶️ Lancer</button>
      </div>
    </div>
  `;
}

function renderRun(run) {
  const statusClass = `status-${run.status}`;
  return `
    <div class="run-item">
      <div class="header">
        <strong>${escapeHtml(run.workflowName)}</strong>
        <span class="status-badge ${statusClass}">${run.status.toUpperCase()}</span>
      </div>
      <div class="meta" style="margin-bottom: 8px;">
        <code>${escapeHtml(run.id)}</code> — 
        Démarré·¢ à ${new Date(run.startedAt).toLocaleTimeString()}
        ${run.completedAt ? `— Fini à ${new Date(run.completedAt).toLocaleTimeString()}` : ''}
      </div>
      <div class="steps">
        ${run.steps.map((step) => {
          const stepClass = `step-${step.status}`;
          return `
            <div class="step">
              <span class="step-status ${stepClass}">${step.status.toUpperCase()}</span>
              ${escapeHtml(step.name)}
              ${step.result ? `— ${escapeHtml(step.result)}` : ''}
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

async function runWorkflow(workflowId) {
  try {
    setStatus('Lancement du workflow…');
    const url = apiUrlInput.value.trim().replace(/\/$/, '') + `/workflows/${workflowId}/run`;
    const res = await fetch(url, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    setStatus(`Workflow lancé: ${data.run.id}`);
    loadAll(); // Rafraî·¢chir la liste des runs
  } catch (err) {
    setStatus('Erreur: ' + err.message);
  }
}

async function loadAll() {
  try {
    setStatus('Chargement…');

    const [workflows, runs] = await Promise.all([
      fetchJson('/workflows').catch(() => ({ count: 0, items: [] })),
      fetchJson('/workflows/runs').catch(() => ({ count: 0, items: [] })),
    ]);

    // Workflows
    if (workflows.count > 0) {
      workflowsContent.innerHTML = workflows.items.map(renderWorkflow).join('');
    } else {
      workflowsContent.innerHTML = '<div class="empty">Aucun workflow</div>';
    }

    // Runs
    if (runs.count > 0) {
      // Trier par ordre décroissant (plus récent en haut)
      const sortedRuns = runs.items.sort((a, b) => 
        new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
      );
      runsContent.innerHTML = sortedRuns.map(renderRun).join('');
    } else {
      runsContent.innerHTML = '<div class="empty">Aucun run</div>';
    }

    setStatus('OK — ' + new Date().toLocaleTimeString());
  } catch (err) {
    setStatus('Erreur: ' + err.message);
    workflowsContent.innerHTML = '<div class="empty">Erreur de chargement</div>';
    runsContent.innerHTML = '<div class="empty">Erreur de chargement</div>';
  }
}

// Charger au démarrage
loadAll();
