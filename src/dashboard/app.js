const apiUrlInput = document.getElementById('apiUrl');
const statusEl = document.getElementById('status');

const profilesContent = document.getElementById('profiles-content');
const policiesContent = document.getElementById('policies-content');
const workflowsContent = document.getElementById('workflows-content');

function setStatus(msg) {
  statusEl.textContent = msg;
}

async function fetchJson(path) {
  const base = apiUrlInput.value.trim().replace(/\/$/, '') || window.location.origin;
  const res = await fetch(base + path, { credentials: 'include' });
  if (res.status === 401) {
    window.location.href = '/dashboard/login.html';
    throw new Error('unauthorized');
  }
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

function renderCard(result, render, emptyText) {
  if (!result || result.error) return '<div class="empty">Impossible de charger</div>';
  if (result.count > 0) return result.items.map(render).join('');
  return '<div class="empty">' + escapeHtml(emptyText) + '</div>';
}

async function loadAll() {
  try {
    setStatus('Chargement…');

    // Une erreur de chargement n'est jamais affichée comme une liste vide.
    const failed = () => ({ error: true });
    const [profiles, policies, workflows] = await Promise.all([
      fetchJson('/profiles').catch(failed),
      fetchJson('/policies').catch(failed),
      fetchJson('/workflows').catch(failed),
    ]);

    profilesContent.innerHTML = renderCard(profiles, renderProfile, 'Aucun profil');
    policiesContent.innerHTML = renderCard(policies, renderPolicy, 'Aucune policy');
    workflowsContent.innerHTML = renderCard(workflows, renderWorkflow, 'Aucun workflow');

    if (profiles.error || policies.error || workflows.error) {
      setStatus('Erreur : une partie n’a pas pu être chargée — ' + new Date().toLocaleTimeString());
      return;
    }
    setStatus('OK — ' + new Date().toLocaleTimeString());
  } catch (err) {
    setStatus('Erreur: ' + err.message);
    profilesContent.innerHTML = '<div class="empty">Erreur de chargement</div>';
    policiesContent.innerHTML = '<div class="empty">Erreur de chargement</div>';
    workflowsContent.innerHTML = '<div class="empty">Erreur de chargement</div>';
  }
}

document.getElementById('refresh').addEventListener('click', loadAll);
loadAll();
