const apiUrlInput = document.getElementById('apiUrl');
const statusEl = document.getElementById('status');

const profilesContent = document.getElementById('profiles-content');
const policiesContent = document.getElementById('policies-content');
const workflowsContent = document.getElementById('workflows-content');

function setStatus(msg) {
  statusEl.textContent = msg;
}

async function fetchJson(path) {
  const url = apiUrlInput.value.trim().replace(/\/$/, '') + path;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function renderProfile(p) {
  return `
    <div class="item">
      <h3>${escapeHtml(p.name)}</h3>
      <p>${escapeHtml(p.description)}</p>
      <div class="meta">
        <code>${escapeHtml(p.id)}</code><br>
        <strong>Capacities:</strong> ${p.capabilities.map(escapeHtml).join(', ')}<br>
        <strong>Limits:</strong> ${Object.entries(p.limits).filter(([_, v]) => v).map(([k]) => k).join(', ') || 'Aucune'}
      </div>
    </div>
  `;
}

function renderPolicy(p) {
  return `
    <div class="item">
      <h3>${escapeHtml(p.name)}</h3>
      <p>${escapeHtml(p.description)}</p>
      <div class="meta">
        <code>${escapeHtml(p.id)}</code><br>
        <strong>Rules:</strong> ${p.rules.map(escapeHtml).join(', ')}
      </div>
    </div>
  `;
}

function renderWorkflow(w) {
  return `
    <div class="item">
      <h3>${escapeHtml(w.name)}</h3>
      <p>${escapeHtml(w.description)}</p>
      <div class="meta">
        <code>${escapeHtml(w.id)}</code><br>
        <strong>Triggers:</strong> ${w.trigger.map(escapeHtml).join(', ')}<br>
        <strong>Steps:</strong> ${w.steps.map(escapeHtml).join(' → ')}
      </div>
    </div>
  `;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function loadAll() {
  try {
    setStatus('Chargement…');
    
    const [profiles, policies, workflows] = await Promise.all([
      fetchJson('/profiles').catch(() => ({ count: 0, items: [] })),
      fetchJson('/policies').catch(() => ({ count: 0, items: [] })),
      fetchJson('/workflows').catch(() => ({ count: 0, items: [] })),
    ]);

    // Profils
    if (profiles.count > 0) {
      profilesContent.innerHTML = profiles.items.map(renderProfile).join('');
    } else {
      profilesContent.innerHTML = '<div class="empty">Aucun profil</div>';
    }

    // Policies
    if (policies.count > 0) {
      policiesContent.innerHTML = policies.items.map(renderPolicy).join('');
    } else {
      policiesContent.innerHTML = '<div class="empty">Aucune policy</div>';
    }

    // Workflows
    if (workflows.count > 0) {
      workflowsContent.innerHTML = workflows.items.map(renderWorkflow).join('');
    } else {
      workflowsContent.innerHTML = '<div class="empty">Aucun workflow</div>';
    }

    setStatus('OK — ' + new Date().toLocaleTimeString());
  } catch (err) {
    setStatus('Erreur: ' + err.message);
    profilesContent.innerHTML = '<div class="empty">Erreur de chargement</div>';
    policiesContent.innerHTML = '<div class="empty">Erreur de chargement</div>';
    workflowsContent.innerHTML = '<div class="empty">Erreur de chargement</div>';
  }
}

// Charger au démarrage
loadAll();
