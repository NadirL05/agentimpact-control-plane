// Script de la page de connexion (externe pour la CSP script-src 'self').
document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('error');
  errorEl.textContent = '';
  const password = document.getElementById('password').value;
  try {
    const res = await fetch('/dashboard/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ password }),
    });
    if (res.status === 429) {
      errorEl.textContent = 'Trop d’essais. Réessayez dans 15 minutes.';
      return;
    }
    if (!res.ok) {
      errorEl.textContent = 'Identifiants invalides.';
      return;
    }
    window.location.href = '/dashboard/';
  } catch {
    errorEl.textContent = 'Erreur réseau.';
  }
});
