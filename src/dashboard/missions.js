// Onglet Missions du tableau de bord (docs/IMPLEMENTATION_PLAN.md, étape 6).
// Lecture seule : GET /dashboard/api/missions. Aucun script en ligne (CSP).
(function (global) {
  'use strict';

  var FILTERS = [
    ['a_relire', 'À relire'],
    ['bloquees', 'Bloquées'],
    ['en_cours', 'En cours'],
    ['toutes', 'Toutes'],
  ];
  var CATEGORY = {
    a_relire: 'À relire', bloquee: 'Bloquée', en_cours: 'En cours',
    en_attente: 'En attente', terminee: 'Terminée', refusee: 'Refusée',
  };
  var EMPTY = {
    a_relire: 'Aucune PR à relire. Tout est à jour.',
    bloquees: 'Aucune mission bloquée.',
    en_cours: 'Aucune mission en cours.',
    toutes: 'Aucune mission pour le moment.',
  };
  var PR_STATE = { open: 'ouverte', merged: 'fusionnée', closed: 'fermée', unknown: 'état inconnu' };

  function esc(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** Liens sortants limités à GitHub et Linear, en https. */
  function safeUrl(url) {
    return typeof url === 'string' && /^https:\/\/(github\.com|linear\.app)\/[^\s"'<>]*$/.test(url) ? url : null;
  }

  function fmtDuration(seconds) {
    if (typeof seconds !== 'number' || !isFinite(seconds) || seconds < 0) return '—';
    if (seconds < 60) return Math.round(seconds) + ' s';
    if (seconds < 3600) return Math.round(seconds / 60) + ' min';
    var h = Math.floor(seconds / 3600);
    var m = Math.round((seconds % 3600) / 60);
    return h + ' h ' + (m < 10 ? '0' : '') + m;
  }

  function fmtTokens(n) {
    if (typeof n !== 'number' || !isFinite(n) || n < 0) return '—';
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace('.', ',') + ' M';
    if (n >= 1e3) return Math.round(n / 1e3) + ' k';
    return String(n);
  }

  function fmtEur(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '—';
    return n.toFixed(2).replace('.', ',') + ' €';
  }

  function fmtDate(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function link(url, label) {
    var safe = safeUrl(url);
    return safe ? '<a href="' + esc(safe) + '" target="_blank" rel="noopener noreferrer">' + esc(label) + '</a>' : '';
  }

  function renderFilters(counts, active) {
    return FILTERS.map(function (f) {
      var n = counts && typeof counts[f[0]] === 'number' ? counts[f[0]] : 0;
      return '<button type="button" class="filter' + (f[0] === active ? ' active' : '') + '" data-filter="' + f[0] + '"'
        + ' aria-pressed="' + (f[0] === active) + '">' + esc(f[1]) + ' <span class="count">' + n + '</span></button>';
    }).join('');
  }

  function renderWeek(week, pricesConfigured) {
    if (!week) return '';
    var cost = pricesConfigured ? fmtEur(week.cost_eur) : 'tarif à configurer';
    return '7 derniers jours : <strong>' + esc(week.missions) + '</strong> mission(s) · <strong>'
      + esc(fmtTokens(week.tokens)) + '</strong> tokens · coût estimé <strong>' + esc(cost) + '</strong>';
  }

  function renderItem(item) {
    var usage = item.usage || {};
    var pr = item.pr_url ? link(item.pr_url, 'Ouvrir la PR') : '';
    var prState = item.pr_state && PR_STATE[item.pr_state] ? ' <span class="muted">(' + esc(PR_STATE[item.pr_state]) + ')</span>' : '';
    var rows = [
      ['Dépôt', esc(item.repo || '—')],
      ['Ticket', link(item.linear_url, item.ticket) || esc(item.ticket || '—')],
      ['Lancée le', esc(fmtDate(item.created_at))],
      ['Durée', esc(fmtDuration(item.duration_s))],
      ['Tests', esc(item.tests || '—')],
      ['Tokens', esc(fmtTokens(usage.tokens)) + (usage.model ? ' <span class="muted">(' + esc(usage.model) + ')</span>' : '')],
      ['Coût estimé', esc(fmtEur(usage.cost_eur))],
    ];
    var block = item.block
      ? '<div class="block"><p><strong>Pourquoi :</strong> ' + esc(item.block.text) + '</p><p><strong>À faire :</strong> '
        + esc(item.block.action) + '</p></div>'
      : '';
    return '<details class="mission cat-' + esc(item.category) + '">'
      + '<summary><span class="badge">' + esc(CATEGORY[item.category] || item.category) + '</span>'
      + '<span class="ticket">' + esc(item.ticket) + '</span>'
      + '<span class="title">' + esc(item.title) + '</span>'
      + '<span class="duration">' + esc(fmtDuration(item.duration_s)) + '</span>'
      + (pr ? '<span class="pr">' + pr + prState + '</span>' : '') + '</summary>'
      + block
      + '<dl>' + rows.map(function (r) { return '<dt>' + r[0] + '</dt><dd>' + r[1] + '</dd>'; }).join('') + '</dl>'
      + '</details>';
  }

  function renderList(data, filter) {
    if (!data || !Array.isArray(data.items) || data.items.length === 0) {
      return '<div class="empty">' + esc(EMPTY[filter] || EMPTY.toutes) + '</div>';
    }
    return data.items.map(renderItem).join('');
  }

  var LOADING = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
  var ERROR = '<div class="empty error">Impossible de charger les missions. '
    + '<button type="button" class="retry" data-retry="1">Réessayer</button></div>';

  var state = { filter: 'a_relire', timer: null };

  function el(id) { return global.document.getElementById(id); }

  async function load(options) {
    var list = el('missions-list');
    if (!list) return;
    if (!(options && options.silent)) list.innerHTML = LOADING;
    try {
      var res = await global.fetch('/dashboard/api/missions?filter=' + encodeURIComponent(state.filter), { credentials: 'include' });
      if (res.status === 401) {
        global.location.href = '/dashboard/login.html';
        return;
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json();
      el('missions-filters').innerHTML = renderFilters(data.counts, state.filter);
      el('missions-week').innerHTML = renderWeek(data.week, data.prices_configured);
      list.innerHTML = renderList(data, state.filter);
      el('missions-updated').textContent = 'Mis à jour à ' + new Date().toLocaleTimeString('fr-FR');
    } catch (err) {
      list.innerHTML = ERROR;
      el('missions-updated').textContent = 'Erreur de chargement';
    }
  }

  function setFilter(filter) {
    if (!FILTERS.some(function (f) { return f[0] === filter; })) return;
    state.filter = filter;
    load();
  }

  function showTab(tab) {
    var missions = tab === 'missions';
    el('home-panel').hidden = missions;
    el('missions-panel').hidden = !missions;
    el('tab-home').setAttribute('aria-selected', String(!missions));
    el('tab-missions').setAttribute('aria-selected', String(missions));
    if (state.timer) { global.clearInterval(state.timer); state.timer = null; }
    if (missions) {
      load();
      // Rafraîchissement toutes les 30 s tant que l'onglet est affiché.
      state.timer = global.setInterval(function () { load({ silent: true }); }, 30000);
    }
  }

  global.MissionsBoard = {
    esc: esc, safeUrl: safeUrl, fmtDuration: fmtDuration, fmtTokens: fmtTokens, fmtEur: fmtEur,
    renderFilters: renderFilters, renderWeek: renderWeek, renderItem: renderItem, renderList: renderList,
    load: load, setFilter: setFilter, showTab: showTab, state: state,
  };

  var panel = el('missions-panel');
  if (!panel) return;
  el('missions-filters').addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-filter]') : null;
    if (b) setFilter(b.getAttribute('data-filter'));
  });
  el('missions-list').addEventListener('click', function (e) {
    if (e.target && e.target.closest && e.target.closest('[data-retry]')) load();
  });
  el('tab-home').addEventListener('click', function () { global.location.hash = ''; showTab('home'); });
  el('tab-missions').addEventListener('click', function () { global.location.hash = 'missions'; showTab('missions'); });
  if (global.addEventListener) {
    global.addEventListener('hashchange', function () {
      showTab(global.location.hash === '#missions' ? 'missions' : 'home');
    });
  }
  showTab(global.location.hash === '#missions' ? 'missions' : 'home');
})(window);
