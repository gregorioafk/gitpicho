'use strict';
// gitpicho · frontend sin dependencias

// ---------- utilidades ----------
const $ = (s, el = document) => el.querySelector(s);
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k instanceof Node ? k : String(k));
  return el;
}
const SVGNS = 'http://www.w3.org/2000/svg';
function s(tag, attrs) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

async function api(url, body) {
  const opts = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Gitpanel': '1' }, body: JSON.stringify(body) };
  const r = await fetch(url, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}
const qs = (url, params) => url + '?' + new URLSearchParams(params);

function toast(msg, err = false) {
  const t = h('div', { class: 'toast' + (err ? ' err' : '') }, msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), err ? 9000 : 3500);
}

function ago(ts) {
  if (!ts) return '';
  const d = Date.now() / 1000 - ts;
  if (d < 60) return 'recién';
  if (d < 3600) return `hace ${Math.floor(d / 60)} min`;
  if (d < 86400) return `hace ${Math.floor(d / 3600)} h`;
  if (d < 86400 * 30) return `hace ${Math.floor(d / 86400)} d`;
  if (d < 86400 * 365) return `hace ${Math.floor(d / 86400 / 30)} mes`;
  return `hace ${Math.floor(d / 86400 / 365)} a`;
}

const store = {
  get(k, def) {
    try {
      const v = localStorage.getItem('ghl.' + k);
      return v == null ? def : JSON.parse(v);
    } catch {
      return def;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem('ghl.' + k, JSON.stringify(v));
    } catch {}
  },
};

// ---------- estado ----------
const hashParams = new URLSearchParams(location.hash.slice(1));
const S = {
  ov: null, // overview
  repo: hashParams.get('repo') || store.get('repo', null),
  detail: null,
  tab: hashParams.get('tab') || store.get('tab', 'changes'),
  file: null, // { path, orig, mode }
  diff: null,
  filters: store.get('filters', { text: '', dirty: false, alerts: false, hidden: false }),
  sort: store.get('sort', 'name'),
  logAll: store.get('logAll', true),
  log: null,
  commit: null,
  commitText: null,
  branches: [],
  busy: new Set(),
  lastOv: 0,
  lastRepo: 0,
};

const idOf = name => S.ov?.identities.find(i => i.name === name);
const idColor = name => `var(--${idOf(name)?.color || 'blue'})`;
const repoSum = p => S.ov?.repos.find(r => r.path === p);

// ---------- carga ----------
async function loadOverview() {
  try {
    S.ov = await api('/api/overview');
    S.lastOv = Date.now();
    if (S.repo && !repoSum(S.repo)) selectRepo(null);
  } catch (e) {
    toast('No se pudo cargar: ' + e.message, true);
  }
  renderSide();
  if (!S.repo) renderMain();
}

async function loadRepo() {
  if (!S.repo) return;
  const p = S.repo;
  try {
    const [d, br] = await Promise.all([api(qs('/api/repo', { repo: p })), api(qs('/api/branches', { repo: p })).catch(() => [])]);
    if (S.repo !== p) return;
    S.detail = d;
    S.branches = br;
    S.lastRepo = Date.now();
    // refleja el resumen fresco en la lista lateral
    if (S.ov) {
      const i = S.ov.repos.findIndex(r => r.path === p);
      if (i >= 0) S.ov.repos[i] = { ...d, files: undefined };
    }
    if (S.file && !fileExists(S.file)) S.file = null;
    if (!S.file && d.files?.length) {
      // abre el primer archivo para no arrancar con el panel de diff vacío
      const f = d.files.find(x => x.conflict) || d.files[0];
      S.file = { path: f.path, orig: f.orig, mode: fileModes(f).at(-1) };
      S.diff = null;
    }
    renderSide();
    renderMain();
    if (S.tab === 'changes' && S.file) await loadDiff();
    if (S.tab === 'history') await loadLog();
  } catch (e) {
    toast(e.message, true);
  }
}

function fileExists(f) {
  return (S.detail?.files || []).some(x => x.path === f.path && fileModes(x).includes(f.mode));
}

function fileModes(f) {
  if (f.untracked) return ['untracked'];
  if (f.conflict) return ['conflict'];
  const m = [];
  if (f.xy[0] !== '.') m.push('staged');
  if (f.xy[1] !== '.') m.push('unstaged');
  return m;
}

async function loadDiff() {
  const f = S.file;
  if (!f) {
    S.diff = null;
    renderDiffPane();
    return;
  }
  if (f.mode === 'conflict') return loadConflict(f);
  try {
    const d = await api(qs('/api/diff', { repo: S.repo, path: f.path, orig: f.orig || '', mode: f.mode }));
    if (S.file !== f) return;
    S.diff = d;
  } catch (e) {
    S.diff = { text: '', note: e.message };
  }
  renderDiffPane();
}

async function loadLog() {
  const p = S.repo;
  try {
    const log = await api(qs('/api/log', { repo: p, all: S.logAll ? '1' : '0', n: 400 }));
    if (S.repo !== p) return;
    S.log = log;
  } catch (e) {
    S.log = [];
    toast(e.message, true);
  }
  if (S.tab === 'history') renderBody();
}

function syncHash() {
  const q = new URLSearchParams();
  if (S.repo) q.set('repo', S.repo);
  if (S.repo && S.tab !== 'changes') q.set('tab', S.tab);
  if (!S.repo && S.view === 'prs') q.set('view', 'prs');
  history.replaceState(null, '', q.toString() ? '#' + q : location.pathname);
}

function selectRepo(p) {
  S.repo = p;
  S.view = null;
  store.set('repo', p);
  syncHash();
  S.detail = null;
  S.file = null;
  S.diff = null;
  S.log = null;
  S.commit = null;
  S.commitText = null;
  S.suggest = null;
  renderSide();
  renderMain();
  if (p) loadRepo();
}

// Ejecuta una acción con feedback y recarga el repo.
async function act(label, fn, { reloadAll = false, quiet = false } = {}) {
  if (S.busy.has(label)) return;
  S.busy.add(label);
  renderActionsBusy();
  try {
    const r = await fn();
    if (!quiet) toast(label + ' ✓' + (r?.out ? '\n' + r.out.trim().slice(0, 600) : ''));
    return r;
  } catch (e) {
    toast(`${label}: ${e.message}`, true);
  } finally {
    S.busy.delete(label);
    if (reloadAll) await loadOverview();
    if (S.repo) await loadRepo();
    renderActionsBusy();
  }
}

function renderActionsBusy() {
  document.querySelectorAll('[data-busy]').forEach(b => {
    const on = S.busy.has(b.dataset.busy);
    b.disabled = on;
    b.classList.toggle('loadingbtn', on);
  });
}

// ---------- sidebar ----------
function visibleRepos() {
  const f = S.filters;
  const t = f.text.trim().toLowerCase();
  return (S.ov?.repos || []).filter(r => {
    if (r.hidden && !f.hidden) return false;
    if (t && !(r.name.toLowerCase().includes(t) || (r.branch || '').toLowerCase().includes(t))) return false;
    if (f.dirty && !(r.counts?.total || r.ahead || r.behind)) return false;
    if (f.alerts && !(r.warnings.length || r.error)) return false;
    return true;
  });
}

function setFilter(k, v) {
  S.filters[k] = v;
  store.set('filters', S.filters);
  renderSide();
}

function renderSide() {
  const side = $('#side');
  const scroll = side.scrollTop;
  side.replaceChildren();
  const f = S.filters;

  const search = h('input', {
    class: 'input',
    placeholder: 'Buscar repo o rama…',
    value: f.text,
    oninput: e => {
      S.filters.text = e.target.value;
      store.set('filters', S.filters);
      renderRepoList();
    },
  });
  const chip = (k, label) => h('button', { class: 'chip' + (f[k] ? ' on' : ''), onclick: () => setFilter(k, !f[k]) }, label);
  side.append(
    h(
      'div',
      { class: 'side-top' },
      h(
        'div',
        { class: 'row' },
        h('div', { class: 'brand', onclick: () => selectRepo(null), title: 'Ir al resumen' }, 'git', h('span', {}, 'picho')),
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn sm' + (S.view === 'prs' && !S.repo ? ' primary' : ''), title: 'Pull requests abiertos de tus cuentas de GitHub (gh)', onclick: () => openPrs() }, 'PRs'),
        h('button', { class: 'btn sm ghost', title: 'Workspaces y ajustes', onclick: () => openWorkspaces() }, '⚙'),
        h('button', { class: 'btn sm ghost', title: 'Recargar todo', onclick: () => loadOverview() }, '↻'),
        h(
          'button',
          {
            class: 'btn sm',
            'data-busy': 'Fetch de todos',
            title: 'git fetch en todos los repos con remote, cada uno con su alias SSH',
            onclick: () =>
              act(
                'Fetch de todos',
                async () => {
                  const res = await api('/api/fetch-all', {});
                  const bad = res.filter(r => !r.ok);
                  if (bad.length) toast(`Fallaron ${bad.length}:\n` + bad.map(b => `• ${b.repo.split('/').slice(-2).join('/')}: ${b.error.split('\n')[0]}`).join('\n'), true);
                  return { out: `${res.length - bad.length}/${res.length} ok` };
                },
                { reloadAll: true }
              ),
          },
          'Fetch todos'
        )
      ),
      search,
      h(
        'div',
        { class: 'row wrap' },
        chip('dirty', 'Con cambios'),
        chip('alerts', 'Alertas'),
        chip('hidden', 'Ocultos'),
        h('div', { class: 'spacer' }),
        h(
          'select',
          {
            class: 'chip',
            title: 'Orden',
            onchange: e => {
              S.sort = e.target.value;
              store.set('sort', S.sort);
              renderRepoList();
            },
          },
          h('option', { value: 'name', selected: S.sort === 'name' }, 'A–Z'),
          h('option', { value: 'recent', selected: S.sort === 'recent' }, 'Recientes'),
          h('option', { value: 'changes', selected: S.sort === 'changes' }, 'Más cambios')
        )
      )
    )
  );

  if (!S.ov) {
    side.append(h('div', { class: 'loading' }, h('span', { class: 'spin' }), ' escaneando repos…'));
    return;
  }

  // identidades SSH
  if (!S.ov.identities.length) {
    side.append(h('div', { class: 'add-box' }, h('div', { class: 'muted', style: 'font-size:12px' }, 'Sin workspaces todavía.'), h('button', { class: 'btn primary', onclick: () => openWorkspaces('') }, '+ Agregar workspace')));
    return;
  }
  const ids = h('details', { class: 'ids', open: store.get('idsOpen', false) }, h('summary', {}, `Workspaces (${S.ov.identities.length})`));
  ids.addEventListener('toggle', () => store.set('idsOpen', ids.open));
  for (const id of S.ov.identities) {
    const key = id.ssh?.identityFile || '—';
    ids.append(
      h(
        'div',
        { class: 'idcard', style: `--idc: var(--${id.color || 'blue'})` },
        h(
          'div',
          { class: 't' },
          id.name,
          h('span', { class: 'spacer' }),
          h('span', { class: 'dim' }, `${id.repoCount} repos`),
          id.alertCount ? h('span', { class: 'badge b-warn' }, `⚠ ${id.alertCount}`) : null,
          h('button', { class: 'btn sm ghost', title: 'Editar workspace', onclick: () => openWorkspaces(id.name) }, '✎')
        ),
        h(
          'div',
          { class: 'kv' },
          h('span', {}, 'carpeta'),
          h('span', { class: 'mono' }, id.dir),
          h('span', {}, 'alias'),
          h('span', { class: 'mono' }, id.sshHost ? `${id.sshHost} → ${id.ssh?.hostname || '¿?'}` : '—'),
          h('span', {}, 'clave'),
          h('span', { class: 'mono', title: key }, key, id.ssh && id.ssh.keyExists === false ? h('span', { class: 'b-err' }, ' (no existe)') : null),
          h('span', {}, 'email'),
          h('span', { class: 'mono' }, id.email || '—')
        )
      )
    );
  }
  if (!S.ov.identities.some(i => !i.ssh)) {
    const others = S.ov.ssh.filter(x => !S.ov.identities.some(i => i.sshHost === x.host));
    if (others.length) ids.append(h('div', { class: 'muted', style: 'padding:0 10px 8px;font-size:12px' }, 'Otros Host en ~/.ssh/config: ', others.map(o => o.host).join(', ')));
  }
  side.append(ids);

  side.append(h('div', { id: 'repolist' }));
  renderRepoList();

  // carpetas sin git
  const ng = S.ov.nonGit;
  if (ng.length) {
    const det = h('details', { class: 'nongit', open: store.get('ngOpen', false) }, h('summary', {}, `Carpetas sin git (${ng.length})`));
    det.addEventListener('toggle', () => store.set('ngOpen', det.open));
    for (const n of ng) {
      det.append(
        h(
          'div',
          { class: 'ng-row', style: `--idc:${idColor(n.identity)}` },
          h('span', { class: 'nm', title: n.display }, n.name),
          h('span', { class: 'idtag' }, n.identity),
          h(
            'button',
            {
              class: 'btn sm',
              title: 'git init en esta carpeta',
              onclick: () => {
                if (confirm(`¿git init en ${n.display}?`)) act('git init', () => api('/api/init', { dir: n.path }), { reloadAll: true });
              },
            },
            'git init'
          )
        )
      );
    }
    side.append(det);
  }

  // agregar repo fuera de las carpetas raíz
  const pathIn = h('input', { class: 'input mono', placeholder: '~/otra/carpeta/repo' });
  const idSel = h('select', { class: 'input' }, S.ov.identities.map(i => h('option', { value: i.name }, i.name)));
  side.append(
    h(
      'div',
      { class: 'add-box' },
      h('div', { class: 'muted', style: 'font-size:12px' }, 'Agregar repo fuera de las carpetas'),
      pathIn,
      h(
        'div',
        { class: 'row' },
        idSel,
        h(
          'button',
          {
            class: 'btn',
            onclick: () => {
              if (pathIn.value.trim()) act('Repo agregado', () => api('/api/extra', { path: pathIn.value, identity: idSel.value }), { reloadAll: true });
            },
          },
          'Agregar'
        )
      )
    )
  );
  side.scrollTop = scroll;
}

function sortRepos(list) {
  const by = {
    name: (a, b) => a.name.localeCompare(b.name),
    recent: (a, b) => (b.lastCommit || 0) - (a.lastCommit || 0),
    changes: (a, b) => (b.counts?.total || 0) - (a.counts?.total || 0) || a.name.localeCompare(b.name),
  }[S.sort];
  return [...list].sort(by);
}

function repoBadges(r) {
  return [
    r.counts?.total ? h('span', { class: 'badge b-chg', title: `${r.counts.staged} staged · ${r.counts.unstaged} sin stage · ${r.counts.untracked} nuevos` }, `●${r.counts.total}`) : null,
    r.ahead ? h('span', { class: 'badge b-up', title: 'commits sin pushear' }, `↑${r.ahead}`) : null,
    r.behind ? h('span', { class: 'badge b-down', title: 'commits por bajar' }, `↓${r.behind}`) : null,
    r.warnings.length ? h('span', { class: 'badge b-warn', title: r.warnings.map(w => w.msg).join('\n') }, '⚠') : null,
    r.error ? h('span', { class: 'badge b-err', title: r.error }, '✕') : null,
    r.operation || r.counts?.conflicts ? h('span', { class: 'badge b-conf', title: (r.operation?.label || 'Conflictos') + (r.counts?.conflicts ? ` · ${r.counts.conflicts} con conflicto` : '') }, `⚔${r.counts?.conflicts || ''}`) : null,
    !r.remoteUrl && !r.error ? h('span', { class: 'badge dim', title: 'sin remote' }, '⌀') : null,
  ];
}

function renderRepoList() {
  const box = $('#repolist');
  if (!box) return;
  box.replaceChildren();
  const list = visibleRepos();
  for (const id of S.ov.identities) {
    const mine = sortRepos(list.filter(r => r.identity === id.name));
    if (!mine.length) continue;
    box.append(
      h(
        'div',
        { class: 'grp-h', style: `--idc: var(--${id.color || 'blue'})` },
        h('span', { class: 'dot' }),
        id.name,
        h('span', { class: 'dim', style: 'text-transform:none' }, id.sshHost),
        h('span', { class: 'spacer' }),
        h('span', {}, mine.length)
      )
    );
    for (const r of mine) {
      box.append(
        h(
          'div',
          {
            class: 'repo-row' + (r.path === S.repo ? ' sel' : '') + (r.hidden ? ' hid' : ''),
            style: `--idc: var(--${id.color || 'blue'})`,
            title: r.display,
            onclick: () => selectRepo(r.path),
          },
          h('span', { class: 'nm' }, r.name, r.branch ? h('small', {}, r.branch) : null),
          repoBadges(r)
        )
      );
    }
  }
  if (!box.children.length) box.append(h('div', { class: 'loading' }, 'Nada con esos filtros.'));
}

// ---------- main ----------
function renderMain() {
  const main = $('#main');
  main.replaceChildren();
  if (!S.repo && S.view === 'prs') return main.append(renderPrs());
  if (!S.repo) return main.append(renderDashboard());
  const r = S.detail || repoSum(S.repo);
  if (!r) return main.append(h('div', { class: 'loading' }, h('span', { class: 'spin' }), ' cargando…'));
  main.append(renderRepoHeader(r), h('div', { class: 'body', id: 'body' }));
  renderBody();
}

function renderDashboard() {
  if (!S.ov) return h('div', { class: 'loading' }, h('span', { class: 'spin' }), ' escaneando repos…');
  if (!S.ov.identities.length) return renderWelcome();
  const repos = S.ov.repos.filter(r => !r.hidden);
  const dirty = repos.filter(r => r.counts?.total);
  const ahead = repos.filter(r => r.ahead);
  const behind = repos.filter(r => r.behind);
  const alerts = repos.filter(r => r.warnings.length || r.error);
  const noRemote = repos.filter(r => !r.remoteUrl && !r.error);
  const tile = (n, l, filt) => h('div', { class: 'tile', onclick: filt }, h('div', { class: 'n' }, n), h('div', { class: 'l' }, l));
  const goRow = r => ({ class: 'click', onclick: () => selectRepo(r.path) });
  const idTag = r => h('span', { class: 'idtag', style: `--idc:${idColor(r.identity)}` }, r.identity);

  const el = h(
    'div',
    { class: 'dash' },
    h('h2', {}, 'Resumen'),
    h(
      'div',
      { class: 'tiles' },
      tile(repos.length, 'repos', () => setFilter('dirty', false)),
      tile(dirty.length, 'con cambios sin commitear', () => setFilter('dirty', true)),
      tile(ahead.length, 'con commits sin pushear'),
      tile(behind.length, 'atrasados vs remote'),
      tile(alerts.length, 'alertas de identidad', () => setFilter('alerts', true)),
      tile(noRemote.length, 'sin remote')
    )
  );

  const ops = repos.filter(r => r.operation || r.counts?.conflicts);
  if (ops.length) {
    el.append(
      h('h3', {}, 'Merges / rebases en curso'),
      h('table', { class: 'tbl' }, ops.map(r => h('tr', goRow(r), h('td', {}, r.name), h('td', {}, idTag(r)), h('td', {}, r.operation?.label || 'conflictos sin operación'), h('td', { class: 'b-err' }, r.counts?.conflicts ? `⚔ ${r.counts.conflicts} con conflicto` : 'sin conflictos: falta continuar'))))
    );
  }
  if (alerts.length) {
    el.append(
      h('h3', {}, 'Alertas de identidad / SSH'),
      h(
        'table',
        { class: 'tbl' },
        h('tr', {}, h('th', {}, 'Repo'), h('th', {}, 'Cuenta'), h('th', {}, 'Problema'), h('th', {}, '')),
        alerts.flatMap(r =>
          (r.error ? [{ msg: r.error }] : r.warnings).map(w =>
            h(
              'tr',
              goRow(r),
              h('td', {}, r.name),
              h('td', {}, idTag(r)),
              h('td', {}, w.msg),
              h('td', {}, w.kind === 'remote' && r.fixUrl ? fixButton(r) : null)
            )
          )
        )
      )
    );
  }
  if (ahead.length) {
    el.append(
      h('h3', {}, 'Commits sin pushear'),
      h('table', { class: 'tbl' }, ahead.map(r => h('tr', goRow(r), h('td', {}, r.name), h('td', {}, idTag(r)), h('td', { class: 'mono' }, r.branch), h('td', { class: 'b-up mono' }, `↑${r.ahead}`))))
    );
  }
  if (dirty.length) {
    el.append(
      h('h3', {}, 'Con cambios sin commitear'),
      h(
        'table',
        { class: 'tbl' },
        h('tr', {}, h('th', {}, 'Repo'), h('th', {}, 'Cuenta'), h('th', {}, 'Rama'), h('th', {}, 'Staged'), h('th', {}, 'Sin stage'), h('th', {}, 'Nuevos'), h('th', {}, 'Último commit')),
        [...dirty]
          .sort((a, b) => b.counts.total - a.counts.total)
          .map(r =>
            h(
              'tr',
              goRow(r),
              h('td', {}, r.name),
              h('td', {}, idTag(r)),
              h('td', { class: 'mono' }, r.branch),
              h('td', {}, r.counts.staged || ''),
              h('td', {}, r.counts.unstaged || ''),
              h('td', {}, r.counts.untracked || ''),
              h('td', { class: 'muted' }, ago(r.lastCommit))
            )
          )
      )
    );
  }
  return el;
}

function fixButton(r) {
  return h(
    'button',
    {
      class: 'btn sm',
      title: `${r.remoteUrl} → ${r.fixUrl}`,
      onclick: e => {
        e.stopPropagation();
        if (confirm(`Cambiar remote "${r.remoteName}" de\n  ${r.remoteUrl}\na\n  ${r.fixUrl}\n?`)) act('Remote corregido', () => api('/api/fix-remote', { repo: r.path }), { reloadAll: true });
      },
    },
    `Usar ${r.expectedHost}`
  );
}

function renderRepoHeader(r) {
  const id = idOf(r.identity);
  const emailBad = r.warnings.some(w => w.kind === 'email');
  const remoteBad = r.warnings.some(w => w.kind === 'remote');
  const busyBtn = (label, op, text, title) =>
    h('button', { class: 'btn', 'data-busy': label, title, onclick: () => act(label, () => api('/api/net', { repo: r.path, op })) }, text);
  const open = (app, text) => h('button', { class: 'btn ghost', onclick: () => api('/api/open', { repo: r.path, app }).catch(e => toast(e.message, true)) }, text);

  const branchSel = h(
    'select',
    {
      title: 'Cambiar de rama (git switch)',
      onchange: e => act(`Cambio a ${e.target.value}`, () => api('/api/checkout', { repo: r.path, branch: e.target.value }), { reloadAll: true }),
    },
    S.branches.length
      ? S.branches.map(b => h('option', { value: b.name, selected: b.name === r.branch }, b.name + (b.track ? ` ${b.track}` : '')))
      : h('option', {}, r.branch || '—')
  );
  if (r.branch === '(detached)') branchSel.prepend(h('option', { selected: true, disabled: true }, `(detached ${r.oid?.slice(0, 7)})`));

  const n = r.counts?.total || 0;
  return h(
    'div',
    { class: 'repo-h', style: `--idc: var(--${id?.color || 'blue'})` },
    h('div', { class: 'row' }, h('h2', {}, r.name), h('span', { class: 'idtag' }, r.identity), h('span', { class: 'path' }, r.display)),
    h(
      'div',
      { class: 'idline' },
      h('span', {}, h('b', {}, 'commitea como'), h('span', { class: emailBad ? 'b-err mono' : 'mono' }, r.email || '—'), r.emailLocal ? h('span', { class: 'dim' }, ' (override local)') : null),
      h('span', {}, h('b', {}, 'remote'), h('span', { class: remoteBad ? 'b-warn mono' : 'mono' }, r.remoteUrl || 'sin remote')),
      r.upstream ? h('span', {}, h('b', {}, 'upstream'), h('span', { class: 'mono' }, r.upstream)) : null
    ),
    h(
      'div',
      { class: 'actions' },
      branchSel,
      busyBtn('Fetch', 'fetch', 'Fetch', `git fetch --all --prune (usa ${r.remoteHost || 'remote'})`),
      busyBtn('Pull', 'pull', `Pull${r.behind ? ` ↓${r.behind}` : ''}`, 'git pull --ff-only'),
      busyBtn('Push', 'push', `Push${r.ahead ? ` ↑${r.ahead}` : ''}`, r.upstream ? 'git push' : 'git push -u origin HEAD'),
      h('button', { class: 'btn', title: 'Traer otra rama a esta (git merge)', disabled: r.operation ? true : null, onclick: () => openMerge() }, 'Merge…'),
      h('button', { class: 'btn', 'data-busy': 'PR', title: 'Generar descripción de pull request (Problema / Solución) con Claude', onclick: () => genPr() }, '📝 Descripción PR'),
      h('button', { class: 'btn', title: 'Review de la rama con Claude (usa la carpeta de notas del workspace si está configurada)', onclick: () => openReview() }, '🔍 Review'),
      h('span', { class: 'spacer' }),
      open('code', 'VS Code'),
      open('lazygit', 'lazygit'),
      open('claude', 'Claude'),
      open('terminal', 'Terminal'),
      open('folder', 'Carpeta'),
      h(
        'button',
        { class: 'btn ghost', title: r.hidden ? 'Mostrar en la lista' : 'Ocultar de la lista', onclick: () => act(r.hidden ? 'Visible' : 'Oculto', () => api('/api/hide', { repo: r.path, hidden: !r.hidden }), { reloadAll: true }) },
        r.hidden ? 'Mostrar' : 'Ocultar'
      ),
      r.extra ? h('button', { class: 'btn ghost', onclick: () => act('Quitado', () => api('/api/extra', { path: r.path, remove: true }), { reloadAll: true }).then(() => selectRepo(null)) }, 'Quitar') : null
    ),
    r.operation ? opBanner(r) : null,
    r.warnings.length || r.error
      ? h(
          'div',
          { class: 'warns' },
          r.error ? h('div', { class: 'warn err' }, r.error) : null,
          r.warnings.map(w => h('div', { class: 'warn' }, '⚠ ', h('span', { class: 'spacer' }, w.msg), w.kind === 'remote' && r.fixUrl ? fixButton(r) : null))
        )
      : null,
    h(
      'div',
      { class: 'tabs' },
      h('button', { class: 'tab' + (S.tab === 'changes' ? ' on' : ''), onclick: () => setTab('changes') }, `Cambios${n ? ` (${n})` : ''}`),
      h('button', { class: 'tab' + (S.tab === 'history' ? ' on' : ''), onclick: () => setTab('history') }, 'Historial')
    )
  );
}

function setTab(t) {
  S.tab = t;
  store.set('tab', t);
  syncHash();
  renderMain();
  if (t === 'history' && !S.log) loadLog();
  if (t === 'changes' && S.file && !S.diff) loadDiff();
}

function renderBody() {
  const body = $('#body');
  if (!body) return;
  body.replaceChildren(S.tab === 'history' ? renderHistory() : renderChanges());
  if (S.tab === 'changes') renderDiffPane();
}

// ---------- cambios ----------
function renderChanges() {
  const d = S.detail;
  if (!d || !d.files) return h('div', { class: 'loading' }, h('span', { class: 'spin' }), ' leyendo estado…');
  const files = d.files;
  const staged = files.filter(f => !f.untracked && !f.conflict && f.xy[0] !== '.');
  const unstaged = files.filter(f => !f.untracked && !f.conflict && f.xy[1] !== '.');
  const untracked = files.filter(f => f.untracked);
  const conflicts = files.filter(f => f.conflict);
  const paths = f => (f.orig ? [f.path, f.orig] : [f.path]);

  const sec = (title, list, mode, headBtns) => {
    if (!list.length) return null;
    return [
      h('div', { class: 'fsec-h' }, `${title} (${list.length})`, h('span', { class: 'spacer' }), headBtns),
      list.map(f => fileRow(f, mode)),
    ];
  };

  const fileRow = (f, mode) => {
    const letter = mode === 'staged' ? f.xy[0] : mode === 'unstaged' ? f.xy[1] : mode === 'untracked' ? '?' : 'U';
    const sel = S.file && S.file.path === f.path && S.file.mode === mode;
    const btn = (txt, title, fn, cls = '') =>
      h('button', { class: 'btn sm ' + cls, title, onclick: e => (e.stopPropagation(), fn()) }, txt);
    const acts = {
      staged: [btn('−', 'Quitar del stage', () => act('Unstage', () => api('/api/unstage', { repo: S.repo, paths: paths(f) }), { quiet: true }))],
      unstaged: [
        btn('+', 'Agregar al stage', () => act('Stage', () => api('/api/stage', { repo: S.repo, paths: [f.path] }), { quiet: true })),
        btn('↺', 'Descartar cambios del archivo', () => {
          if (confirm(`¿Descartar los cambios sin stage de ${f.path}? No se puede deshacer.`)) act('Descartado', () => api('/api/discard', { repo: S.repo, paths: [f.path] }));
        }, 'danger'),
      ],
      untracked: [
        btn('+', 'Agregar al stage', () => act('Stage', () => api('/api/stage', { repo: S.repo, paths: [f.path] }), { quiet: true })),
        btn('🗑', 'Borrar archivo', () => {
          if (confirm(`¿Borrar ${f.path}? No se puede deshacer.`)) act('Borrado', () => api('/api/discard', { repo: S.repo, paths: [f.path], untracked: true }));
        }, 'danger'),
      ],
      conflict: [
        btn('+', 'Marcar resuelto (git add) si ya lo arreglaste a mano', async () => {
          const c = await api(qs('/api/conflict', { repo: S.repo, path: f.path })).catch(() => ({ blocks: 0 }));
          if (c.blocks && !confirm(`${f.path} todavía tiene ${c.blocks} bloque(s) con marcadores <<<<<<< >>>>>>>. ¿Marcarlo resuelto igual?`)) return;
          act('Resuelto', () => api('/api/stage', { repo: S.repo, paths: [f.path] }), { quiet: true });
        }),
      ],
    }[mode];
    const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/') + 1) : '';
    const base = f.path.slice(dir.length);
    return h(
      'div',
      {
        class: 'file' + (sel ? ' sel' : ''),
        title: f.orig ? `${f.orig} → ${f.path}` : f.path,
        onclick: () => {
          S.file = { path: f.path, orig: f.orig, mode };
          S.diff = null;
          renderBody();
          loadDiff();
        },
      },
      h('span', { class: `st st-${letter}` }, letter),
      h('span', { class: 'fn' }, h('span', {}, h('span', { class: 'dim' }, dir), base)),
      h('span', { class: 'fa' }, acts)
    );
  };

  const list = h(
    'div',
    { class: 'flist-scroll' },
    files.length ? null : h('div', { class: 'diff-empty' }, 'Sin cambios. Árbol limpio ✓'),
    sec('Conflictos', conflicts, 'conflict'),
    sec('Preparados', staged, 'staged', h('button', { class: 'btn sm', onclick: () => act('Unstage todo', () => api('/api/unstage', { repo: S.repo }), { quiet: true }) }, '− todo')),
    sec('Cambios', unstaged, 'unstaged', h('button', { class: 'btn sm', onclick: () => act('Stage todo', () => api('/api/stage', { repo: S.repo, paths: unstaged.map(f => f.path) }), { quiet: true }) }, '+ todo')),
    sec('Sin seguimiento', untracked, 'untracked', h('button', { class: 'btn sm', onclick: () => act('Stage nuevos', () => api('/api/stage', { repo: S.repo, paths: untracked.map(f => f.path) }), { quiet: true }) }, '+ todo')),
    d.filesTruncated ? h('div', { class: 'note' }, 'Lista recortada: demasiados archivos.') : null
  );

  // caja de commit
  const ta = h('textarea', {
    placeholder: 'Mensaje del commit  (Ctrl+Enter = commit)',
    oninput: e => (S.commitText = e.target.value),
    onkeydown: e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) doCommit(false);
      if (e.key === 'g' && e.ctrlKey && staged.length) {
        e.preventDefault();
        genCommit();
      }
    },
  });
  ta.value = S.commitText || '';
  const amend = h('input', { type: 'checkbox', id: 'amend' });
  const emailBad = d.warnings.some(w => w.kind === 'email');
  const doCommit = async push => {
    S.commitText = ta.value;
    const ok = await runCommit({ message: ta.value, amend: amend.checked, push });
    if (ok) {
      S.commitText = '';
      S.suggest = null;
      if (push) await act('Push', () => api('/api/net', { repo: S.repo, op: 'push' }));
      else await loadRepo();
    }
  };
  // Mensajes sugeridos por Claude
  const genCommit = async () => {
    S.commitText = ta.value;
    const repo = S.repo;
    const r = await act('Claude', () => api('/api/gen-commit', { repo }), { quiet: true });
    if (!r?.messages?.length || S.repo !== repo) return;
    S.suggest = { repo, list: r.messages };
    if (!(S.commitText || '').trim()) S.commitText = r.messages[0];
    renderBody();
  };
  const sugs = S.suggest?.repo === S.repo ? S.suggest.list : [];
  const box = h(
    'div',
    { class: 'commit-box' },
    h('div', { class: 'as' + (emailBad ? ' bad' : ' muted') }, 'Commiteás como ', h('span', { class: 'mono' }, d.email || '—'), emailBad ? ` · esperado ${d.expectedEmail}` : ''),
    sugs.length
      ? h(
          'div',
          { class: 'sugs' },
          sugs.map(m =>
            h(
              'button',
              {
                class: 'sug' + (m === ta.value ? ' on' : ''),
                title: 'Usar este mensaje',
                onclick: () => {
                  ta.value = m;
                  S.commitText = m;
                  box.querySelectorAll('.sug').forEach(b => b.classList.toggle('on', b.textContent === m));
                  ta.focus();
                },
              },
              m
            )
          )
        )
      : null,
    ta,
    h(
      'div',
      { class: 'row' },
      h('label', { class: 'row muted', style: 'font-size:12px' }, amend, 'amend'),
      h(
        'button',
        {
          class: 'btn',
          'data-busy': 'Claude',
          title: staged.length ? 'Proponer mensajes con Claude a partir de lo staged (Ctrl+G)' : 'Primero stageá algo',
          disabled: !staged.length ? true : null,
          onclick: genCommit,
        },
        '✨ Claude'
      ),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn', 'data-busy': 'Commit', disabled: !staged.length && !amend.checked ? true : null, onclick: () => doCommit(false) }, 'Commit'),
      h('button', { class: 'btn primary', 'data-busy': 'Push', disabled: !staged.length ? true : null, onclick: () => doCommit(true) }, 'Commit + Push')
    )
  );
  amend.addEventListener('change', () => {
    box.querySelector('[data-busy="Commit"]').disabled = !staged.length && !amend.checked;
  });

  return h('div', { class: 'changes' }, h('div', { class: 'flist' }, list, box), h('div', { class: 'diff', id: 'diffpane' }));
}

function renderDiffPane() {
  const pane = $('#diffpane');
  if (!pane) return;
  pane.replaceChildren();
  if (S.file?.mode === 'conflict') return pane.append(renderConflict());
  if (!S.file) return pane.append(h('div', { class: 'diff-empty' }, 'Elegí un archivo para ver el diff.'));
  if (!S.diff) return pane.append(h('div', { class: 'loading' }, h('span', { class: 'spin' }), ' diff…'));
  const actions = { unstaged: ['stage', 'discard'], staged: ['unstage'] }[S.file.mode] || [];
  pane.append(renderDiff(S.diff, { actions: S.diff.truncated ? [] : actions, showFileHeader: true }));
}

// Divide la salida de git diff/show en preámbulo + archivos + hunks.
function parseDiff(text) {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const pre = [];
  const files = [];
  let f = null;
  let hk = null;
  for (const line of lines) {
    if (line.startsWith('diff --git ') || line.startsWith('diff --cc ') || line.startsWith('diff --combined ')) {
      f = { header: [line], hunks: [] };
      files.push(f);
      hk = null;
      continue;
    }
    if (!f) {
      pre.push(line);
      continue;
    }
    if (line.startsWith('@@')) {
      hk = { head: line, lines: [] };
      f.hunks.push(hk);
      continue;
    }
    if (hk) hk.lines.push(line);
    else f.header.push(line);
  }
  for (const x of files) {
    const plus = x.header.find(l => l.startsWith('+++ '));
    const minus = x.header.find(l => l.startsWith('--- '));
    const strip = p => p.replace(/^[ab]\//, '');
    let name = plus && !plus.endsWith('/dev/null') ? strip(plus.slice(4)) : minus ? strip(minus.slice(4)) : '';
    if (!name) {
      const m = x.header[0].match(/^diff --git a\/(.*) b\/(.*)$/);
      name = m ? m[2] : x.header[0];
    }
    x.name = name;
    x.binary = x.header.some(l => l.startsWith('Binary files'));
    x.isNew = x.header.some(l => l.startsWith('new file mode'));
    x.isDeleted = x.header.some(l => l.startsWith('deleted file mode'));
  }
  return { pre, files };
}

function renderDiff(d, { actions = [], showFileHeader = true } = {}) {
  const frag = h('div', {});
  if (d.note) frag.append(h('div', { class: 'note' }, d.note));
  if (!d.text) {
    if (!d.note) frag.append(h('div', { class: 'diff-empty' }, 'Sin diferencias (¿solo cambio de modo o archivo vacío?).'));
    return frag;
  }
  const { pre, files } = parseDiff(d.text);
  if (pre.length) frag.append(h('pre', { class: 'pre-msg' }, pre.join('\n').trim()));
  let budget = 30000; // líneas máximas a pintar
  for (const f of files) {
    if (showFileHeader) {
      frag.append(
        h('div', { class: 'dfile-h' }, f.isNew ? h('span', { class: 'st-A' }, 'nuevo') : null, f.isDeleted ? h('span', { class: 'st-D' }, 'borrado') : null, f.name)
      );
    }
    if (f.binary) frag.append(h('div', { class: 'note' }, 'Archivo binario.'));
    for (const hk of f.hunks) {
      const patch = f.header.join('\n') + '\n' + hk.head + '\n' + hk.lines.join('\n') + '\n';
      const label = { stage: 'Stage hunk', unstage: 'Unstage hunk', discard: 'Descartar hunk' };
      frag.append(
        h(
          'div',
          { class: 'hunk-h' },
          h('code', {}, hk.head),
          actions.map(a =>
            h(
              'button',
              {
                class: 'btn sm' + (a === 'discard' ? ' danger' : ''),
                onclick: () => {
                  if (a === 'discard' && !confirm('¿Descartar este hunk? No se puede deshacer.')) return;
                  act(label[a], () => api('/api/apply', { repo: S.repo, patch, mode: a }), { quiet: true });
                },
              },
              label[a]
            )
          )
        )
      );
      const m = hk.head.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
      let o = m ? +m[1] : 0;
      let n = m ? +m[2] : 0;
      const box = document.createDocumentFragment();
      for (const line of hk.lines) {
        if (budget-- <= 0) break;
        const c = line[0];
        let cls = 'ctx';
        let on = '';
        let nn = '';
        if (!m) cls = c === '+' ? 'add' : c === '-' ? 'del' : 'ctx';
        else if (c === '+') {
          cls = 'add';
          nn = n++;
        } else if (c === '-') {
          cls = 'del';
          on = o++;
        } else if (c === '\\') cls = 'meta';
        else {
          on = o++;
          nn = n++;
        }
        box.append(h('div', { class: 'dl ' + cls }, h('span', { class: 'no' }, on), h('span', { class: 'no' }, nn), h('span', { class: 'tx' }, line)));
      }
      frag.append(box);
    }
    if (budget <= 0) {
      frag.append(h('div', { class: 'note' }, 'Diff muy largo: se cortó la vista.'));
      break;
    }
  }
  if (d.truncated) frag.append(h('div', { class: 'note' }, 'Diff truncado (muy grande); acciones por hunk deshabilitadas.'));
  return frag;
}

// ---------- historial / graph ----------
const LANE_COLORS = ['blue', 'green', 'mauve', 'peach', 'teal', 'pink', 'yellow', 'sky', 'red', 'lavender'];
const LW = 14;
const RH = 26;

// Asigna carriles a cada commit (orden por fecha, padres después de hijos).
function layoutGraph(commits) {
  let lanes = [];
  const rows = [];
  let max = 1;
  for (const c of commits) {
    let col = lanes.indexOf(c.sha);
    const hadIncoming = col !== -1;
    if (!hadIncoming) {
      col = lanes.indexOf(null);
      if (col === -1) col = lanes.length;
      lanes[col] = c.sha;
    }
    const before = lanes.slice();
    for (let i = 0; i < lanes.length; i++) if (i !== col && lanes[i] === c.sha) lanes[i] = null;
    const outs = [];
    const [p0, ...rest] = c.parents;
    if (p0) {
      const k = lanes.indexOf(p0);
      if (k !== -1 && k < col) {
        lanes[col] = null; // el primer padre ya lo lleva un carril a la izquierda
        outs.push(k);
      } else {
        lanes[col] = p0;
        outs.push(col);
      }
    } else {
      lanes[col] = null;
    }
    for (const p of rest) {
      let j = lanes.indexOf(p);
      if (j === -1) {
        j = lanes.indexOf(null);
        if (j === -1) j = lanes.length;
        lanes[j] = p;
      }
      outs.push(j);
    }
    while (lanes.length && lanes[lanes.length - 1] == null) lanes.pop();
    max = Math.max(max, before.length, lanes.length, col + 1);
    rows.push({ col, before, outs, hadIncoming, sha: c.sha });
  }
  return { rows, max: Math.min(max, 24) };
}

function graphSvg(row, width, isHead) {
  const svg = s('svg', { width, height: RH, viewBox: `0 0 ${width} ${RH}` });
  const x = i => i * LW + LW / 2;
  const mid = RH / 2;
  const col = c => `var(--${LANE_COLORS[c % LANE_COLORS.length]})`;
  const curve = (x1, y1, x2, y2, c) =>
    svg.append(s('path', { d: x1 === x2 ? `M${x1} ${y1}V${y2}` : `M${x1} ${y1}C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`, stroke: col(c), 'stroke-width': 2, fill: 'none' }));
  row.before.forEach((sha, i) => {
    if (sha == null) return;
    if (sha === row.sha) {
      if (i !== row.col || row.hadIncoming) curve(x(i), 0, x(row.col), mid, i);
    } else curve(x(i), 0, x(i), RH, i);
  });
  for (const j of row.outs) curve(x(row.col), mid, x(j), RH, j);
  svg.append(s('circle', { cx: x(row.col), cy: mid, r: isHead ? 5 : 4, fill: isHead ? 'var(--base)' : col(row.col), stroke: col(row.col), 'stroke-width': isHead ? 2.5 : 1 }));
  return svg;
}

// Cambia de rama o de commit y recarga todo (lista lateral + repo + historial).
function checkout(label, body) {
  return act(label, () => api('/api/checkout', { repo: S.repo, ...body }), { reloadAll: true });
}

function localNameOf(ref) {
  return ref.type === 'remote' ? ref.name.split('/').slice(1).join('/') : ref.name;
}

function switchToRef(ref) {
  if (ref.type === 'remote') return checkout(`Switch a ${localNameOf(ref)}`, { remote: ref.name });
  return checkout(`Switch a ${ref.name}`, { branch: ref.name });
}

function refTag(ref) {
  const cls = { head: 'head', tag: 'tag', remote: 'remote', local: 'local', other: 'local' }[ref.type];
  const label = ref.type === 'tag' ? '🏷 ' + ref.name : ref.name;
  const canSwitch = (ref.type === 'local' && !ref.current) || ref.type === 'remote';
  return h(
    'span',
    {
      class: `ref ${ref.current ? 'head' : cls}` + (canSwitch ? ' sw' : ''),
      title: ref.current ? 'Rama actual' : canSwitch ? `Click: switch a ${localNameOf(ref)}` : null,
      onclick: canSwitch
        ? e => {
            e.stopPropagation();
            if (confirm(`¿Cambiar a la rama ${localNameOf(ref)}?` + (ref.type === 'remote' ? `\n(se crea local siguiendo a ${ref.name} si no existe)` : ''))) switchToRef(ref);
          }
        : null,
    },
    label
  );
}

// Barra de acciones del commit seleccionado en el historial.
function commitActions(c) {
  const branches = c.refs.filter(r => (r.type === 'local' && !r.current) || r.type === 'remote');
  const dirty = S.detail?.counts?.total || 0;
  const nameIn = h('input', { class: 'input mono', placeholder: 'nombre-de-rama-nueva', style: 'width:220px' });
  const create = () => {
    const n = nameIn.value.trim();
    if (n) checkout(`Rama ${n} creada`, { newBranch: n, sha: c.sha });
  };
  nameIn.addEventListener('keydown', e => e.key === 'Enter' && create());
  return h(
    'div',
    { class: 'cact' },
    h('div', { class: 'row wrap' }, h('b', {}, 'Pararse acá'), h('span', { class: 'mono dim' }, c.sha.slice(0, 10))),
    dirty ? h('div', { class: 'note', style: 'padding:0' }, `Tenés ${dirty} cambios sin commitear: git intenta llevarlos; si chocan, no cambia nada.`) : null,
    branches.length
      ? h(
          'div',
          { class: 'row wrap' },
          branches.map(r => h('button', { class: 'btn sm', title: r.type === 'remote' ? `Crea/usa la rama local ${localNameOf(r)} siguiendo a ${r.name}` : '', onclick: () => switchToRef(r) }, `Switch a ${localNameOf(r)}`))
        )
      : null,
    h(
      'div',
      { class: 'row wrap' },
      h(
        'button',
        {
          class: 'btn sm',
          title: 'git switch --detach: ver el código de ese momento sin estar en ninguna rama',
          onclick: () => {
            if (confirm(`¿Hacer checkout de ${c.sha.slice(0, 7)} en modo detached?\nPara volver, elegí una rama en el selector de arriba.`)) checkout(`Checkout ${c.sha.slice(0, 7)}`, { detach: true, sha: c.sha });
          },
        },
        'Checkout de este commit (detached)'
      ),
      nameIn,
      h('button', { class: 'btn sm', onclick: create }, 'Crear rama acá')
    )
  );
}

function renderHistory() {
  const wrap = h('div', { class: 'hist' + (S.commit ? ' split' : '') });
  const tool = h(
    'div',
    { class: 'htool' },
    h(
      'label',
      { class: 'row' },
      h('input', {
        type: 'checkbox',
        checked: S.logAll ? true : null,
        onchange: e => {
          S.logAll = e.target.checked;
          store.set('logAll', S.logAll);
          S.log = null;
          renderBody();
          loadLog();
        },
      }),
      'Todas las ramas'
    ),
    h('span', { class: 'muted' }, S.log ? `${S.log.length} commits` : ''),
    h('span', { class: 'spacer' }),
    S.commit ? h('button', { class: 'btn sm ghost', onclick: () => ((S.commit = null), renderBody()) }, 'Cerrar detalle ✕') : null
  );
  const list = h('div', { class: 'hlist' }, tool);
  if (!S.log) list.append(h('div', { class: 'loading' }, h('span', { class: 'spin' }), ' leyendo historial…'));
  else if (!S.log.length) list.append(h('div', { class: 'diff-empty' }, 'Sin commits todavía.'));
  else {
    const { rows, max } = layoutGraph(S.log);
    const width = max * LW + 4;
    const headSha = S.detail?.oid;
    S.log.forEach((c, i) => {
      list.append(
        h(
          'div',
          {
            class: 'crow' + (S.commit === c.sha ? ' sel' : ''),
            title: `${c.sha}\n${c.author} <${c.email}>\n${new Date(c.time * 1000).toLocaleString()}`,
            onclick: () => openCommit(c.sha),
          },
          graphSvg(rows[i], width, c.sha === headSha),
          h('span', { class: 'subj' }, c.refs.map(refTag), c.subject),
          h('span', { class: 'au' }, c.author),
          h('span', { class: 'tm' }, ago(c.time)),
          h('span', { class: 'sh' }, c.sha.slice(0, 7))
        )
      );
    });
  }
  wrap.append(list);
  if (S.commit) {
    const det = h('div', { class: 'hdetail' });
    if (!S.commitShow) det.append(h('div', { class: 'loading' }, h('span', { class: 'spin' }), ' cargando commit…'));
    else {
      const c = S.log?.find(x => x.sha === S.commit);
      if (c) det.append(commitActions(c));
      det.append(h('div', { class: 'diff' }, renderDiff(S.commitShow, { actions: [] })));
    }
    wrap.append(det);
  }
  return wrap;
}

async function openCommit(sha) {
  const list = $('.hlist');
  const scroll = list?.scrollTop || 0;
  S.commit = sha;
  S.commitShow = null;
  renderBody();
  $('.hlist').scrollTop = scroll;
  try {
    const d = await api(qs('/api/show', { repo: S.repo, sha }));
    if (S.commit !== sha) return;
    S.commitShow = d;
  } catch (e) {
    S.commitShow = { text: '', note: e.message };
  }
  const sc = $('.hlist')?.scrollTop || 0;
  renderBody();
  $('.hlist').scrollTop = sc;
}

// ---------- merge / rebase / conflictos ----------
const OP_NAME = { merge: 'merge', rebase: 'rebase', 'cherry-pick': 'cherry-pick', revert: 'revert' };

function opBanner(r) {
  const n = r.counts?.conflicts || 0;
  const op = r.operation;
  return h(
    'div',
    { class: 'warns' },
    h(
      'div',
      { class: 'warn err op' },
      h('b', {}, `⚔ ${op.label}`),
      h('span', {}, n ? ` · ${n} archivo${n === 1 ? '' : 's'} con conflicto: resolvelos en Cambios` : ' · sin conflictos pendientes: ya podés continuar'),
      h('span', { class: 'spacer' }),
      h(
        'button',
        {
          class: 'btn danger sm',
          title: `git ${op.type} --abort: vuelve todo a como estaba antes`,
          onclick: () => {
            if (confirm(`¿Abortar el ${OP_NAME[op.type]}? Vuelve todo a como estaba antes de empezarlo.`)) act(`${OP_NAME[op.type]} abortado`, () => api('/api/op-abort', { repo: r.path }), { reloadAll: true });
          },
        },
        `Abortar ${OP_NAME[op.type]}`
      ),
      h(
        'button',
        {
          class: 'btn primary sm',
          disabled: n ? true : null,
          title: n ? 'Primero resolvé los conflictos' : op.type === 'merge' ? 'Crea el commit del merge' : `git ${op.type} --continue`,
          onclick: async () => {
            const ok = await runCommit({ continueOp: true, title: `Continuar ${OP_NAME[op.type]}` });
            if (ok) await loadOverview();
          },
        },
        op.type === 'merge' ? 'Terminar merge (commit)' : `Continuar ${OP_NAME[op.type]}`
      )
    )
  );
}

async function openMerge() {
  const repo = S.repo;
  let t;
  try {
    t = await api(qs('/api/merge-targets', { repo }));
  } catch (e) {
    return toast(e.message, true);
  }
  $('#mergemodal')?.remove();
  const filter = h('input', { class: 'input', placeholder: 'Filtrar ramas…' });
  const sel = h('select', { class: 'input mono', size: 14, style: 'width:100%' });
  const fill = () => {
    const q = filter.value.trim().toLowerCase();
    const opts = r => h('option', { value: r.name }, `${r.name}   · ${ago(r.time)}`);
    const loc = t.refs.filter(r => !r.remote && r.name.toLowerCase().includes(q));
    const rem = t.refs.filter(r => r.remote && r.name.toLowerCase().includes(q));
    sel.replaceChildren(loc.length ? h('optgroup', { label: 'Locales' }, loc.map(opts)) : '', rem.length ? h('optgroup', { label: 'Remotas (hacé Fetch antes para tenerlas al día)' }, rem.map(opts)) : '');
    if (sel.options.length) sel.selectedIndex = 0;
  };
  filter.addEventListener('input', fill);
  fill();
  const dirty = S.detail?.counts?.total || 0;
  const close = () => m.remove();
  const go = async () => {
    const branch = sel.value;
    if (!branch) return;
    close();
    const r = await act(`Merge de ${branch}`, () => api('/api/merge', { repo, branch }), { reloadAll: true, quiet: true });
    if (!r) return;
    if (r.conflicts.length) {
      toast(`Merge de ${branch} con ${r.conflicts.length} conflicto(s): resolvelos en Cambios y después "Terminar merge".`, true);
      if (S.tab !== 'changes') setTab('changes');
    } else toast(`Merge de ${branch} ✓\n${r.out.trim().split('\n').slice(-3).join('\n')}`);
  };
  sel.addEventListener('dblclick', go);
  const m = h(
    'div',
    { class: 'modal-bg', id: 'mergemodal', onclick: e => e.target === m && close() },
    h(
      'div',
      { class: 'modal' },
      h('div', { class: 'row' }, h('b', {}, `Merge en ${t.current}`), h('span', { class: 'spacer' }), h('button', { class: 'btn ghost', onclick: close }, '✕')),
      h('div', { class: 'muted', style: 'font-size:12px' }, `Trae los cambios de la rama elegida a ${t.current} (git merge --no-edit). Si hay conflictos, los resolvés acá mismo.`),
      dirty ? h('div', { class: 'note', style: 'padding:0' }, `Tenés ${dirty} cambios sin commitear: si tocan los mismos archivos, git no deja mergear. Conviene commitear antes.`) : null,
      filter,
      sel,
      h('div', { class: 'row' }, h('span', { class: 'spacer' }), h('button', { class: 'btn', onclick: close }, 'Cancelar'), h('button', { class: 'btn primary', onclick: go }, 'Mergear'))
    )
  );
  document.body.append(m);
  filter.focus();
}

// Parte el archivo en texto normal y bloques de conflicto (mismo formato que el server, soporta zdiff3).
function splitConflicts(text) {
  const segs = [];
  let txt = [];
  let blk = null;
  let part = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('<<<<<<<')) {
      if (txt.length) segs.push({ type: 'text', lines: txt });
      txt = [];
      blk = { type: 'block', oursLabel: line.slice(7).trim(), ours: [], base: null, theirs: [], theirsLabel: '', result: null, how: '' };
      part = 'ours';
    } else if (blk && line.startsWith('|||||||')) {
      blk.base = [];
      part = 'base';
    } else if (blk && line.startsWith('=======')) part = 'theirs';
    else if (blk && line.startsWith('>>>>>>>')) {
      blk.theirsLabel = line.slice(7).trim();
      segs.push(blk);
      blk = null;
    } else if (blk) blk[part].push(line);
    else txt.push(line);
  }
  segs.push({ type: 'text', lines: txt });
  return segs;
}

async function loadConflict(f) {
  S.conflict = null;
  renderDiffPane();
  try {
    const d = await api(qs('/api/conflict', { repo: S.repo, path: f.path }));
    if (S.file !== f) return;
    S.conflict = { path: f.path, ...d, segs: d.text ? splitConflicts(d.text) : [] };
  } catch (e) {
    S.conflict = { path: f.path, error: e.message, segs: [] };
  }
  renderDiffPane();
}

function renderConflict() {
  const c = S.conflict;
  if (!c || c.path !== S.file.path) return h('div', { class: 'loading' }, h('span', { class: 'spin' }), ' leyendo conflicto…');
  const repo = S.repo;
  const blocks = c.segs.filter(x => x.type === 'block');
  const done = blocks.filter(b => b.result != null).length;
  const rerender = () => renderDiffPane();
  const side = which =>
    act(`Resuelto con ${which === 'ours' ? 'mi versión' : 'la de ellos'}`, () => api('/api/resolve', { repo, path: c.path, side: which }), { quiet: false });
  const save = () => {
    const out = [];
    for (const sg of c.segs) {
      if (sg.type === 'text') out.push(...sg.lines);
      else if (sg.result !== '') out.push(...sg.result.split('\n'));
    }
    act('Conflicto resuelto', () => api('/api/resolve', { repo, path: c.path, content: out.join('\n') }));
  };

  const head = h(
    'div',
    { class: 'dfile-h wrap' },
    h('span', { class: 'st-U' }, '⚔'),
    c.path,
    blocks.length ? h('span', { class: done === blocks.length ? 'b-up' : 'muted', style: 'font-weight:400' }, ` ${done}/${blocks.length} resueltos`) : null,
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn sm', title: 'Quedarse con tu versión del archivo entero (--ours)', onclick: () => confirm('¿Usar tu versión del archivo entero?') && side('ours') }, 'Todo mío'),
    h('button', { class: 'btn sm', title: 'Quedarse con la versión de ellos del archivo entero (--theirs)', onclick: () => confirm('¿Usar la versión de ellos del archivo entero?') && side('theirs') }, 'Todo de ellos'),
    h('button', { class: 'btn sm', onclick: () => api('/api/open-file', { repo, file: c.path, line: 1 }).catch(e => toast(e.message, true)) }, 'VS Code'),
    blocks.length ? h('button', { class: 'btn sm primary', disabled: done < blocks.length ? true : null, title: done < blocks.length ? 'Resolvé todos los bloques primero' : 'Guarda el archivo y lo marca como resuelto (git add)', onclick: save }, 'Guardar y marcar resuelto') : null
  );
  if (c.error) return h('div', {}, head, h('div', { class: 'note' }, c.error));
  if (c.missing) return h('div', {}, head, h('div', { class: 'note' }, 'El archivo fue borrado en uno de los dos lados. Elegí "Todo mío" o "Todo de ellos" (si ese lado lo borró, se borra).'));
  if (c.binary) return h('div', {}, head, h('div', { class: 'note' }, 'Archivo binario: elegí "Todo mío" o "Todo de ellos".'));
  if (!blocks.length) return h('div', {}, head, h('div', { class: 'note' }, 'No quedan marcadores de conflicto en el archivo. Si ya está bien, marcalo como resuelto con + en la lista.'));

  const wrap = h('div', { class: 'conf' }, head);
  let lineNo = 1;
  let k = 0;
  const ctxLines = (lines, from) => lines.map((l, i) => h('div', { class: 'dl ctx' }, h('span', { class: 'no' }, ''), h('span', { class: 'no' }, from + i), h('span', { class: 'tx' }, ' ' + l)));
  c.segs.forEach((sg, si) => {
    if (sg.type === 'text') {
      const L = si === c.segs.length - 1 && sg.lines.at(-1) === '' ? sg.lines.slice(0, -1) : sg.lines; // sin la línea vacía del \n final
      const first = si === 0;
      const last = si === c.segs.length - 1;
      // solo un poco de contexto alrededor de cada bloque
      if (L.length <= 8) wrap.append(...ctxLines(L, lineNo));
      else {
        if (!first) wrap.append(...ctxLines(L.slice(0, 3), lineNo));
        wrap.append(h('div', { class: 'dl meta' }, h('span', { class: 'no' }, ''), h('span', { class: 'no' }, ''), h('span', { class: 'tx' }, `   … ${L.length - (first ? 0 : 3) - (last ? 0 : 3)} líneas sin conflicto …`)));
        if (!last) wrap.append(...ctxLines(L.slice(-3), lineNo + L.length - 3));
      }
      lineNo += L.length;
      return;
    }
    const b = sg;
    const idx = k++;
    const choose = (how, text) => {
      b.result = text;
      b.how = how;
      rerender();
    };
    const claude = async btn => {
      btn.disabled = true;
      btn.textContent = '✨ pensando…';
      try {
        const r = await api('/api/conflict-suggest', { repo, path: c.path, index: idx });
        choose('Claude', r.text);
      } catch (e) {
        toast(e.message, true);
        btn.disabled = false;
        btn.textContent = '✨ Claude';
      }
    };
    const pre = (cls, title, lines) => h('div', { class: `cside ${cls}` }, h('div', { class: 'clabel' }, title), h('pre', {}, lines.join('\n') || '(vacío)'));
    const card = h('div', { class: 'cblock' + (b.result != null ? ' ok' : '') });
    card.append(h('div', { class: 'row wrap' }, h('b', {}, `Conflicto ${idx + 1}/${blocks.length}`), b.result != null ? h('span', { class: 'b-up' }, `✓ ${b.how}`) : null, h('span', { class: 'spacer' }),
      b.result == null
        ? [
            h('button', { class: 'btn sm', onclick: () => choose('mío', b.ours.join('\n')) }, 'Usar mío'),
            h('button', { class: 'btn sm', onclick: () => choose('de ellos', b.theirs.join('\n')) }, 'Usar de ellos'),
            h('button', { class: 'btn sm', title: 'Mío y después lo de ellos', onclick: () => choose('ambos', [...b.ours, ...b.theirs].join('\n')) }, 'Ambos'),
            h('button', { class: 'btn sm', title: 'Editar a mano partiendo de tu versión', onclick: () => choose('a mano', b.ours.join('\n')) }, 'Editar'),
            h('button', { class: 'btn sm', title: 'Claude propone cómo combinarlos (lo podés editar)', onclick: e => claude(e.currentTarget) }, '✨ Claude'),
          ]
        : h('button', { class: 'btn sm ghost', onclick: () => choose('', null) }, 'Deshacer')
    ));
    if (b.result == null) {
      card.append(h('div', { class: 'cgrid' }, pre('mine', `Mío · ${b.oursLabel}`, b.ours), pre('theirs', `De ellos · ${b.theirsLabel}`, b.theirs)));
      if (b.base) card.append(h('details', { class: 'cbase' }, h('summary', {}, 'Ver base común (cómo estaba antes de los dos cambios)'), h('pre', {}, b.base.join('\n') || '(vacío)')));
    } else {
      const ta = h('textarea', { class: 'cres', spellcheck: 'false', oninput: e => ((b.result = e.target.value), fit(e.target)) });
      ta.value = b.result;
      const fit = el => {
        el.style.height = 'auto';
        el.style.height = el.scrollHeight + 4 + 'px';
      };
      requestAnimationFrame(() => fit(ta));
      card.append(ta);
    }
    wrap.append(card);
    // números de línea del archivo tal como está (con marcadores)
    lineNo += 2 + b.ours.length + b.theirs.length + (b.base ? b.base.length + 1 : 0);
  });
  return wrap;
}

// ---------- commit con salida en vivo ----------
const stripAnsi = t => t.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r(?!\n)/g, '\n');

// Corre git commit mostrando la salida de los hooks a medida que sale. Devuelve true si salió bien.
async function runCommit({ message, amend, push, continueOp, title }) {
  const repo = S.repo;
  const name = repoSum(repo)?.name || repo;
  const log = h('pre', { class: 'joblog' });
  const status = h('span', { class: 'muted' }, 'git commit corriendo (incluye hooks de pre-commit)…');
  const clock = h('span', { class: 'mono dim' }, '0s');
  const t0 = Date.now();
  const timer = setInterval(() => (clock.textContent = `${Math.round((Date.now() - t0) / 1000)}s`), 1000);
  let running = true;
  const cancelBtn = h(
    'button',
    {
      class: 'btn danger',
      onclick: () => {
        if (confirm('¿Cancelar el commit? Se corta el hook (lint, tests, docker…).')) api('/api/commit-cancel', { repo }).catch(e => toast(e.message, true));
      },
    },
    'Cancelar'
  );
  const closeBtn = h('button', { class: 'btn', style: 'display:none', onclick: () => m.remove() }, 'Cerrar');
  const m = h(
    'div',
    { class: 'modal-bg', id: 'jobmodal' },
    h(
      'div',
      { class: 'modal' },
      h('div', { class: 'row' }, h('span', { class: 'spin' }), h('b', {}, title || `Commit en ${name}`), h('span', { class: 'spacer' }), clock),
      log,
      h('div', { class: 'row' }, status, h('span', { class: 'spacer' }), cancelBtn, closeBtn)
    )
  );
  document.body.append(m);

  const done = (ok, msg) => {
    running = false;
    clearInterval(timer);
    m.querySelector('.spin')?.remove();
    cancelBtn.style.display = 'none';
    closeBtn.style.display = '';
    status.className = ok ? 'b-up' : 'b-err';
    status.textContent = msg;
    m.dataset.done = '1';
    if (ok && !push) setTimeout(() => m.isConnected && m.remove(), 1500);
    if (ok && push) m.remove();
  };

  let text = '';
  try {
    const r = await fetch('/api/commit-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Gitpanel': '1' },
      body: JSON.stringify({ repo, message, amend, continueOp }),
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      done(false, e.error || r.statusText);
      return false;
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done: end, value } = await reader.read();
      if (end) break;
      text += dec.decode(value, { stream: true });
      const i = text.indexOf('\0');
      log.textContent = stripAnsi(i >= 0 ? text.slice(0, i) : text);
      log.scrollTop = log.scrollHeight;
    }
    const i = text.indexOf('\0');
    const res = i >= 0 ? JSON.parse(text.slice(i + 1) || '{}') : { code: -1, error: 'se cortó la conexión' };
    if (res.code === 0) {
      done(true, '✓ Commit hecho');
      return true;
    }
    done(false, res.signal ? '✕ Cancelado' : `✕ Falló (código ${res.code ?? '?'})${res.error ? ': ' + res.error : ''}. Revisá la salida del hook.`);
    return false;
  } catch (e) {
    done(false, '✕ ' + e.message);
    return false;
  } finally {
    if (running) clearInterval(timer);
    loadRepo();
  }
}

// ---------- pull requests (gh) ----------
S.view = hashParams.get('view');
S.prs = null;
S.prsAt = 0;

function openPrs() {
  S.repo = null;
  S.view = 'prs';
  store.set('repo', null);
  syncHash();
  renderSide();
  renderMain();
  if (!S.prs || Date.now() - S.prsAt > 60000) loadPrs();
}

async function loadPrs() {
  S.prs = null;
  if (S.view === 'prs') renderMain();
  try {
    S.prs = await api('/api/prs');
  } catch (e) {
    S.prs = { error: e.message };
  }
  S.prsAt = Date.now();
  if (S.view === 'prs' && !S.repo) renderMain();
}

async function checkoutAndReview(pr) {
  const local = pr.local[0];
  if (!confirm(`¿Hacer checkout del PR #${pr.number} en ${local.name}?\nTu repo local cambia a la rama del PR (gh pr checkout) y después corre el review.`)) return;
  const r = await act(`Checkout PR #${pr.number}`, () => api('/api/pr-checkout', { repo: local.path, number: pr.number }), { reloadAll: true, quiet: true });
  if (!r?.ok) return;
  selectRepo(local.path);
  await loadRepo();
  runReview(r.base);
}

function renderPrs() {
  const el = h(
    'div',
    { class: 'dash' },
    h('div', { class: 'row' }, h('h2', { style: 'margin:0' }, 'Pull requests'), h('span', { class: 'spacer' }), S.prsAt ? h('span', { class: 'dim', style: 'font-size:12px' }, ago(S.prsAt / 1000)) : null, h('button', { class: 'btn', onclick: () => loadPrs() }, '↻ Actualizar'))
  );
  if (!S.prs) return el.append(h('div', { class: 'loading' }, h('span', { class: 'spin' }), ' consultando GitHub con cada cuenta…')), el;
  if (S.prs.error) return el.append(h('div', { class: 'warn err' }, S.prs.error)), el;

  const prTable = (title, list) => {
    if (!list?.length) return h('div', { class: 'muted', style: 'margin:6px 0 4px' }, `${title}: nada`);
    return [
      h('h3', {}, `${title} (${list.length})`),
      h(
        'table',
        { class: 'tbl' },
        list.map(pr =>
          h(
            'tr',
            {},
            h('td', { style: 'width:100%' }, h('div', {}, h('span', { class: 'mono dim' }, `#${pr.number} `), pr.title, pr.draft ? h('span', { class: 'badge dim' }, ' draft') : null, pr.labels.map(l => h('span', { class: 'ref local', style: 'margin-left:6px' }, l))), h('div', { class: 'muted', style: 'font-size:12px' }, h('span', { class: 'mono' }, pr.repo), ` · ${pr.author} · ${ago(Date.parse(pr.updatedAt) / 1000)}`, pr.comments ? ` · 💬 ${pr.comments}` : '')),
            h(
              'td',
              { style: 'white-space:nowrap' },
              h('a', { class: 'btn sm', href: pr.url, target: '_blank', rel: 'noopener' }, 'GitHub'),
              ' ',
              pr.local.length ? h('button', { class: 'btn sm', title: pr.local[0].path, onclick: () => selectRepo(pr.local[0].path) }, 'Ir al repo') : h('span', { class: 'dim', style: 'font-size:12px' }, 'no clonado'),
              ' ',
              pr.local.length ? h('button', { class: 'btn sm primary', title: 'gh pr checkout + review con Claude contra la base del PR', onclick: () => checkoutAndReview(pr) }, 'Checkout + Review') : null
            )
          )
        )
      ),
    ];
  };

  for (const acc of S.prs) {
    const id = idOf(acc.identity);
    el.append(h('h3', { style: 'margin-top:26px' }, h('span', { class: 'idtag', style: `--idc: var(--${id?.color || 'blue'})` }, acc.identity), acc.connected ? h('span', { class: 'muted', style: 'text-transform:none;margin-left:8px' }, `@${acc.login}`) : null));
    if (!acc.connected) {
      const cmd = `GH_CONFIG_DIR=${acc.ghConfigDir} gh auth login`;
      el.append(
        h(
          'div',
          { class: 'warn' },
          h('span', {}, 'gh no está conectado para esta cuenta. Conectala desde una terminal con:'),
          h('code', { class: 'mono' }, cmd),
          h('span', { class: 'spacer' }),
          h('button', { class: 'btn sm', onclick: () => copyText(cmd) }, 'Copiar')
        )
      );
      continue;
    }
    if (acc.error) el.append(h('div', { class: 'warn err' }, acc.error));
    el.append(...[prTable('Te piden review', acc.reviewRequested), prTable('Asignados a vos', acc.assigned), prTable('Tuyos abiertos', acc.authored)].flat());
  }
  return el;
}

// ---------- review de PR ----------
const REVIEW_LABEL = { rompe: 'puede romper', bug: 'bug', seguridad: 'seguridad', mejora: 'mejora', pregunta: 'pregunta' };

async function copyText(t) {
  try {
    await navigator.clipboard.writeText(t);
  } catch {
    const ta = h('textarea', {}, t);
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('Copiado ✓');
}

// Abre el último review si es del mismo commit; si no, corre uno nuevo.
// Abre el último review guardado del repo (o el que está corriendo); si no hay ninguno, corre uno nuevo.
async function openReview() {
  const repo = S.repo;
  const hidden = $('#revmodal');
  if (hidden?.dataset.repo === repo && hidden.dataset.running) {
    hidden.style.display = '';
    return;
  }
  try {
    const { running, list } = await api(qs('/api/reviews', { repo }));
    if (running) return toast('Hay un review corriendo en este repo: cuando termine queda en el historial.');
    if (!list.length) return runReview();
    const r = await api(qs('/api/review', { repo, id: list[0].id }));
    if (S.repo === repo) showReview(r, list);
  } catch (e) {
    toast(e.message, true);
  }
}

async function runReview(base) {
  const repo = S.repo;
  $('#revmodal')?.remove();
  const log = h('pre', { class: 'joblog' });
  const clock = h('span', { class: 'mono dim' }, '0s');
  const t0 = Date.now();
  const timer = setInterval(() => (clock.textContent = `${Math.round((Date.now() - t0) / 1000)}s`), 1000);
  const m = h(
    'div',
    { class: 'modal-bg', id: 'revmodal' },
    h(
      'div',
      { class: 'modal wide' },
      h('div', { class: 'row' }, h('span', { class: 'spin' }), h('b', {}, `Review de ${repoSum(repo)?.name || repo}`), h('span', { class: 'spacer' }), clock),
      h('div', { class: 'muted', style: 'font-size:12px' }, 'Claude lee el diff, busca contexto en las notas del workspace (si hay) y los usos en el repo. Solo lectura.'),
      log,
      h(
        'div',
        { class: 'row' },
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn', title: 'Cerrar esta ventana: el review sigue y queda guardado', onclick: () => (m.style.display = 'none') }, 'Seguir en segundo plano'),
        h(
          'button',
          {
            class: 'btn danger',
            onclick: () => api('/api/review-cancel', { repo }).catch(e => toast(e.message, true)),
          },
          'Cancelar'
        )
      )
    )
  );
  m.dataset.running = '1';
  m.dataset.repo = repo;
  document.body.append(m);

  let text = '';
  let res;
  try {
    const r = await fetch('/api/review-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Gitpanel': '1' },
      body: JSON.stringify({ repo, base }),
    });
    if (!r.ok) res = { ok: false, error: (await r.json().catch(() => ({}))).error || r.statusText };
    else {
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += dec.decode(value, { stream: true });
        const i = text.indexOf('\0');
        log.textContent = i >= 0 ? text.slice(0, i) : text;
        log.scrollTop = log.scrollHeight;
      }
      const i = text.indexOf('\0');
      res = i >= 0 ? JSON.parse(text.slice(i + 1)) : { ok: false, error: 'se cortó la conexión' };
    }
  } catch (e) {
    res = { ok: false, error: e.message };
  } finally {
    clearInterval(timer);
  }
  res.secs ??= Math.round((Date.now() - t0) / 1000);
  res.log = text.split('\0')[0];
  const name = repoSum(repo)?.name || repo;
  const inBackground = m.style.display === 'none' || S.repo !== repo || !m.isConnected;
  if (inBackground) {
    m.remove();
    if (res.ok) toast(`Review de ${name} listo: ${res.hallazgos.length} hallazgo(s). Abrilo con 🔍 Review.`);
    else if (res.error !== 'Cancelado') toast(`Review de ${name} falló: ${res.error}`, true);
    return;
  }
  const list = res.ok ? (await api(qs('/api/reviews', { repo })).catch(() => ({ list: [] }))).list : undefined;
  showReview(res, list);
}

function showReview(r, list) {
  $('#revmodal')?.remove();
  if (r.ok === undefined) r.ok = true; // los guardados en disco son siempre exitosos
  const fecha = ts => new Date(ts).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' });
  const histSel =
    list?.length > 1
      ? h(
          'select',
          {
            class: 'input',
            style: 'width:auto;max-width:330px',
            title: 'Reviews anteriores de este repo',
            onchange: async e => {
              try {
                showReview(await api(qs('/api/review', { repo: S.repo, id: e.target.value })), list);
              } catch (err) {
                toast(err.message, true);
              }
            },
          },
          list.map(x => h('option', { value: x.id, selected: x.id === r.id }, `${fecha(x.createdAt)} · ${x.branch} · ${x.count} hallazgo${x.count === 1 ? '' : 's'}`))
        )
      : null;
  const stale = r.ok && r.head && S.detail?.oid && r.head !== S.detail.oid;
  const close = () => m.remove();
  const loc = f => (f.archivo ? f.archivo + (f.linea ? `:${f.linea}` : '') : 'general');
  const asMarkdown = () =>
    [`**Review**`, r.resumen, '', ...r.hallazgos.map(f => `- \`${loc(f)}\` — **${REVIEW_LABEL[f.tipo]}**: ${f.comentario}`)].join('\n');
  const baseSel =
    r.candidates?.length > 1
      ? h('select', { class: 'input', style: 'width:auto', title: 'Rama base', onchange: e => runReview(e.target.value) }, r.candidates.map(c => h('option', { value: c, selected: c === r.base }, c)))
      : h('span', { class: 'muted mono' }, r.base || 'sin commitear');
  const meta = [r.createdAt ? fecha(r.createdAt) : '', r.secs ? `${r.secs}s` : '', r.cost ? `US$${r.cost.toFixed(2)}` : ''].filter(Boolean).join(' · ');

  const body = !r.ok
    ? [h('div', { class: 'warn err', style: 'white-space:pre-wrap' }, r.error || 'Error'), r.log ? h('pre', { class: 'joblog' }, r.log) : null]
    : [
        stale ? h('div', { class: 'note', style: 'padding:0' }, `Este review es del commit ${r.head.slice(0, 7)}; la rama cambió desde entonces. Usá "Volver a revisar" para uno nuevo.`) : null,
        r.resumen ? h('div', { class: 'rev-sum' }, r.resumen) : null,
        r.source === 'sin-commitear' ? h('div', { class: 'note', style: 'padding:0' }, 'La rama no tiene commits propios: se revisaron los cambios sin commitear.') : null,
        r.hallazgos.length
          ? h(
              'div',
              { class: 'findings' },
              r.hallazgos.map(f =>
                h(
                  'div',
                  { class: `finding t-${f.tipo}` },
                  h(
                    'div',
                    { class: 'row' },
                    h('span', { class: 'ftype' }, REVIEW_LABEL[f.tipo]),
                    f.archivo && f.existe
                      ? h('button', { class: 'floc', title: 'Abrir en el editor en esa línea', onclick: () => api('/api/open-file', { repo: S.repo, file: f.archivo, line: f.linea }).catch(e => toast(e.message, true)) }, loc(f))
                      : h('span', { class: 'floc dim' }, loc(f)),
                    h('span', { class: 'spacer' }),
                    h('button', { class: 'btn sm', title: 'Copiar el comentario para pegarlo en el PR', onclick: () => copyText(f.comentario) }, 'Copiar')
                  ),
                  h('div', { class: 'ftext' }, f.comentario)
                )
              )
            )
          : h('div', { class: 'diff-empty' }, 'Sin hallazgos importantes ✓'),
        r.log ? h('details', { class: 'revlog' }, h('summary', {}, 'Qué revisó Claude'), h('pre', { class: 'joblog' }, r.log)) : null,
      ];

  const m = h(
    'div',
    { class: 'modal-bg', id: 'revmodal', onclick: e => e.target === m && close() },
    h(
      'div',
      { class: 'modal wide' },
      h(
        'div',
        { class: 'row' },
        h('b', {}, 'Review'),
        r.ok ? h('span', { class: 'muted' }, `${r.hallazgos.length} hallazgo${r.hallazgos.length === 1 ? '' : 's'}`) : null,
        histSel,
        h('span', { class: 'spacer' }),
        r.branch ? h('span', { class: 'muted mono' }, `${r.branch} →`) : null,
        baseSel,
        h('button', { class: 'btn ghost', title: 'Cerrar (Esc)', onclick: close }, '✕')
      ),
      h('div', { class: 'rev-body' }, body),
      h(
        'div',
        { class: 'row' },
        h('span', { class: 'dim', style: 'font-size:12px' }, meta),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn', onclick: () => runReview(r.candidates?.length > 1 ? baseSel.value : undefined) }, 'Volver a revisar'),
        r.ok && r.hallazgos.length ? h('button', { class: 'btn primary', onclick: () => copyText(asMarkdown()) }, 'Copiar todo (markdown)') : null
      )
    )
  );
  document.body.append(m);
}

// ---------- descripción de PR ----------
async function genPr(base) {
  const repo = S.repo;
  const r = await act('PR', () => api('/api/gen-pr', { repo, base }), { quiet: true });
  if (r?.markdown && S.repo === repo) showPrModal(r);
}

function showPrModal(r) {
  $('#prmodal')?.remove();
  const ta = h('textarea', { class: 'pr-text', spellcheck: 'false' });
  ta.value = r.markdown;
  const close = () => m.remove();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(ta.value);
    } catch {
      ta.select();
      document.execCommand('copy');
    }
    toast('Copiado ✓');
  };
  const baseSel = r.candidates.length
    ? h('select', { class: 'input', style: 'width:auto', title: 'Rama base del PR', onchange: e => genPr(e.target.value) }, r.candidates.map(c => h('option', { value: c, selected: c === r.base }, c)))
    : h('span', { class: 'muted' }, r.base || 'sin base');
  const m = h(
    'div',
    { class: 'modal-bg', id: 'prmodal', onclick: e => e.target === m && close() },
    h(
      'div',
      { class: 'modal' },
      h('div', { class: 'row' }, h('b', {}, 'Descripción del PR'), h('span', { class: 'spacer' }), h('span', { class: 'muted mono' }, `${r.branch} →`), baseSel, h('button', { class: 'btn ghost', title: 'Cerrar (Esc)', onclick: close }, '✕')),
      r.source === 'sin-commitear' ? h('div', { class: 'note' }, 'La rama no tiene commits propios: se describieron los cambios sin commitear.') : null,
      ta,
      h(
        'div',
        { class: 'row' },
        h('span', { class: 'muted', style: 'font-size:12px' }, 'Markdown crudo: editalo si querés y pegalo en el PR.'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn', 'data-busy': 'PR', onclick: () => genPr(r.candidates.length ? baseSel.value : undefined) }, 'Regenerar'),
        h('button', { class: 'btn primary', onclick: copy }, 'Copiar')
      )
    )
  );
  document.body.append(m);
  ta.focus();
  ta.setSelectionRange(0, 0);
}

// ---------- arranque ----------
window.addEventListener('focus', () => {
  // al volver a la ventana: refresca el repo abierto y, cada tanto, la lista completa
  if (S.repo && Date.now() - S.lastRepo > 3000) loadRepo();
  if (Date.now() - S.lastOv > 60000) loadOverview();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && $('#prmodal')) {
    $('#prmodal').remove();
    return;
  }
  const rm = $('#revmodal');
  if (rm && rm.style.display !== 'none') {
    // mientras corre el review, Esc lo manda a segundo plano en vez de cortarlo
    if (e.key === 'Escape') rm.dataset.running ? (rm.style.display = 'none') : rm.remove();
    return;
  }
  if ($('#jobmodal')) {
    // mientras corre el commit no se cierra con Esc
    if (e.key === 'Escape' && $('#jobmodal').dataset.done) $('#jobmodal').remove();
    return;
  }
  if (e.key === 'g' && e.ctrlKey && !e.target.matches('textarea')) {
    e.preventDefault();
    $('[data-busy="Claude"]:not(:disabled)')?.click();
    return;
  }
  if (e.target.matches('input, textarea, select')) return;
  if (e.key === '/') {
    e.preventDefault();
    $('.side-top .input')?.focus();
  } else if (e.key === 'r') loadRepo();
  else if (e.key === 'Escape') selectRepo(null);
});

renderSide();
renderMain();
if (S.view === 'prs' && !S.repo) loadPrs();
loadOverview().then(() => {
  if (S.repo) loadRepo();
});

// ---------- workspaces (carpetas raíz) y ajustes ----------

// Ventana de workspaces: lista, alta/edición y ajustes generales. `edit` = nombre a editar, '' = alta nueva.
async function openWorkspaces(edit = null) {
  let cfg;
  try {
    cfg = await api('/api/config');
  } catch (e) {
    return toast(e.message, true);
  }
  $('#wsmodal')?.remove();
  const close = () => m.remove();
  const body = h('div', { class: 'ws-body' });
  const m = h(
    'div',
    { class: 'modal-bg', id: 'wsmodal', onclick: e => e.target === m && close() },
    h('div', { class: 'modal' }, h('div', { class: 'row' }, h('b', {}, 'Workspaces'), h('span', { class: 'spacer' }), h('button', { class: 'btn ghost', onclick: close }, '✕')), body)
  );

  const field = (label, input, hint) => h('label', { class: 'ws-field' }, h('span', {}, label), input, hint ? h('small', { class: 'muted' }, hint) : null);

  const showList = () => {
    body.replaceChildren(
      h('div', { class: 'muted', style: 'font-size:12px' }, 'Un workspace es una carpeta con repos adentro (por ejemplo ~/code o ~/trabajo). gitpicho escanea hasta ', cfg.settings.scanDepth, ' niveles y agrupa los repos por workspace.'),
      cfg.roots.length
        ? h(
            'div',
            { class: 'ws-list' },
            cfg.roots.map(r =>
              h(
                'div',
                { class: 'idcard', style: `--idc: var(--${r.color || 'blue'})` },
                h('div', { class: 't' }, r.name, h('span', { class: 'spacer' }), h('button', { class: 'btn sm', onclick: () => showForm(r) }, 'Editar')),
                h('div', { class: 'kv' }, h('span', {}, 'carpeta'), h('span', { class: 'mono' }, r.dir), r.sshHost ? [h('span', {}, 'alias SSH'), h('span', { class: 'mono' }, r.sshHost)] : null)
              )
            )
          )
        : h('div', { class: 'note' }, 'Todavía no hay workspaces.'),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => showForm(null) }, '+ Agregar workspace'), h('span', { class: 'spacer' }), h('button', { class: 'btn', onclick: showSettings }, 'Ajustes')),
      h('div', { class: 'muted mono', style: 'font-size:11px' }, 'config: ', cfg.configPath)
    );
  };

  const showForm = r => {
    const v = r || {};
    const inp = (k, ph, extra = {}) => h('input', { class: 'input mono', name: k, value: v[k] || '', placeholder: ph, ...extra });
    const name = inp('name', 'trabajo');
    const dir = inp('dir', '~/code');
    const color = h('select', { class: 'input' }, cfg.colors.map(c => h('option', { value: c, selected: (v.color || cfg.colors[cfg.roots.length % cfg.colors.length]) === c }, c)));
    const dl = h('datalist', { id: 'ws-ssh-hosts' }, cfg.sshHosts.map(x => h('option', { value: x })));
    const sshHost = inp('sshHost', 'github-trabajo', { list: 'ws-ssh-hosts' });
    const gitconfig = inp('gitconfig', '~/.gitconfig-trabajo');
    const claudeDir = inp('claudeConfigDir', '~/.claude');
    const vault = inp('vault', '~/notas/trabajo');
    const ghDir = inp('ghConfigDir', '~/.config/gh');
    const err = h('div', { class: 'b-err', style: 'font-size:12px' });
    const save = async () => {
      err.textContent = '';
      try {
        await api('/api/workspace', {
          original: r?.name,
          name: name.value,
          dir: dir.value,
          color: color.value,
          sshHost: sshHost.value,
          gitconfig: gitconfig.value,
          claudeConfigDir: claudeDir.value,
          vault: vault.value,
          ghConfigDir: ghDir.value,
        });
        toast(r ? 'Workspace actualizado' : 'Workspace agregado');
        close();
        loadOverview();
      } catch (e) {
        err.textContent = e.message;
      }
    };
    const remove = () => {
      if (!confirm(`¿Quitar el workspace ${r.name}? No se borra nada del disco.`)) return;
      act('Workspace quitado', () => api('/api/workspace-remove', { name: r.name }), { reloadAll: true }).then(close);
    };
    const adv = h(
      'details',
      { class: 'ws-adv', open: !!(v.sshHost || v.gitconfig || v.claudeConfigDir || v.vault || v.ghConfigDir) },
      h('summary', {}, 'Identidad y Claude (opcional)'),
      field('Alias SSH esperado', sshHost, 'Host de ~/.ssh/config que deberían usar los remotes. Si un repo usa otro, aparece una alerta con arreglo de un click.'),
      field('gitconfig de la cuenta', gitconfig, 'Archivo con user.email esperado (ej. el que cargás con includeIf). Avisa si un repo commitea con otro email.'),
      field('Perfil de Claude (CLAUDE_CONFIG_DIR)', claudeDir, 'Para usar otra cuenta de Claude Code en este workspace. Vacío = el perfil por defecto.'),
      field('Carpeta de notas para el review', vault, 'Docs o vault Obsidian con reglas de negocio. Claude la lee (solo lectura) al revisar un diff.'),
      field('Config de gh (GH_CONFIG_DIR)', ghDir, 'Para ver PRs con otra cuenta de GitHub. Vacío = la cuenta por defecto de gh.')
    );
    body.replaceChildren(
      h('div', { class: 'row' }, h('button', { class: 'btn sm ghost', onclick: showList }, '← Workspaces'), h('b', {}, r ? `Editar ${r.name}` : 'Nuevo workspace')),
      h('div', { class: 'ws-grid' }, field('Nombre', name), field('Color', color)),
      field('Carpeta', dir, 'Carpeta que contiene tus repos (o un repo suelto). Acepta ~.'),
      dl,
      adv,
      err,
      h(
        'div',
        { class: 'row' },
        r ? h('button', { class: 'btn danger', onclick: remove }, 'Quitar') : null,
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn', onclick: cfg.roots.length ? showList : close }, 'Cancelar'),
        h('button', { class: 'btn primary', onclick: save }, 'Guardar')
      )
    );
    (r ? dir : name).focus();
  };

  const showSettings = () => {
    const st = cfg.settings;
    const inp = (k, ph) => h('input', { class: 'input mono', value: st[k] ?? '', placeholder: ph });
    const terminal = inp('terminal', cfg.detectedTerminal || 'gnome-terminal');
    const editor = inp('editor', 'code');
    const reviewModel = inp('reviewModel', 'sonnet');
    const commitModel = inp('commitModel', 'haiku');
    const depth = h('input', { class: 'input', type: 'number', min: 1, max: 6, value: st.scanDepth });
    const save = async () => {
      try {
        await api('/api/settings', { terminal: terminal.value, editor: editor.value, reviewModel: reviewModel.value, commitModel: commitModel.value, scanDepth: depth.value });
        toast('Ajustes guardados');
        close();
        loadOverview();
      } catch (e) {
        toast(e.message, true);
      }
    };
    body.replaceChildren(
      h('div', { class: 'row' }, h('button', { class: 'btn sm ghost', onclick: showList }, '← Workspaces'), h('b', {}, 'Ajustes')),
      field('Terminal', terminal, `Vacío = automática${cfg.detectedTerminal ? ` (detectada: ${cfg.detectedTerminal})` : ''}. Soporta ghostty, kitty, alacritty, wezterm, gnome-terminal, konsole, xfce4-terminal, foot.`),
      field('Editor', editor, 'Comando para abrir repos y archivos (code, codium, cursor…).'),
      h('div', { class: 'ws-grid' }, field('Modelo para review y PR', reviewModel), field('Modelo para mensajes de commit', commitModel)),
      field('Profundidad de escaneo', depth, 'Niveles de carpetas que baja buscando repos (sirve para worktrees anidados).'),
      h('div', { class: 'row' }, h('span', { class: 'spacer' }), h('button', { class: 'btn', onclick: showList }, 'Cancelar'), h('button', { class: 'btn primary', onclick: save }, 'Guardar'))
    );
  };

  if (edit === '') showForm(null);
  else if (edit) showForm(cfg.roots.find(r => r.name === edit) || null);
  else if (!cfg.roots.length) showForm(null);
  else showList();
  document.body.append(m);
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && $('#wsmodal')) $('#wsmodal').remove();
});

function renderWelcome() {
  return h(
    'div',
    { class: 'dash welcome' },
    h('h2', {}, 'Bienvenido a gitpicho'),
    h('p', { class: 'muted' }, 'Todos tus repos git en una ventana: qué está sucio, qué falta pushear y qué repo usa la cuenta equivocada.'),
    h(
      'ol',
      {},
      h('li', {}, h('b', {}, 'Agregá un workspace: '), 'la carpeta donde tenés tus repos (~/code, ~/trabajo…).'),
      h('li', {}, h('b', {}, 'Opcional: '), 'decile qué alias SSH y qué email espera ese workspace. gitpicho te avisa si un repo commitea o pushea con otra cuenta.'),
      h('li', {}, h('b', {}, 'Listo: '), 'stage por hunk, historial con graph, merge con resolución de conflictos y review con Claude.')
    ),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => openWorkspaces('') }, '+ Agregar workspace')),
    S.ov?.configPath ? h('div', { class: 'muted mono', style: 'font-size:11px;margin-top:14px' }, 'La config se guarda en ', S.ov.configPath) : null
  );
}
