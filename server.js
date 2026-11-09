'use strict';
// gitpicho: panel local para manejar muchos repos git con varias identidades SSH.
// Sin dependencias: node:http + git vía execFile (nunca shell).

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile, spawn } = require('node:child_process');

const HOME = os.homedir();
const APP_DIR = __dirname;
const PUBLIC_DIR = path.join(APP_DIR, 'public');
const MAX_DIFF = 1_500_000;
const MAX_FILES = 3000;
const SKIP_DIRS = new Set(['node_modules', 'vendor', 'dist', 'build', 'System Volume Information', 'lost+found']);

const expand = p => (p && p.startsWith('~') ? path.join(HOME, p.slice(1)) : p);
const tilde = p => (p && p.startsWith(HOME) ? '~' + p.slice(HOME.length) : p);

// Config del usuario: $GITPICHO_CONFIG o ~/.config/gitpicho/config.json (nunca dentro del repo de la app).
const CONFIG_PATH = process.env.GITPICHO_CONFIG
  ? path.resolve(expand(process.env.GITPICHO_CONFIG))
  : path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'gitpicho', 'config.json');

const DEFAULT_CONFIG = { scanDepth: 3, roots: [], hidden: [], extra: [], reviewModel: 'sonnet', commitModel: 'haiku', terminal: '', editor: 'code' };
const COLORS = ['mauve', 'blue', 'peach', 'green', 'teal', 'pink', 'yellow', 'red'];

function loadConfig() {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw httpErr(500, `config inválida en ${tilde(CONFIG_PATH)}: ${e.message}`);
  }
  cfg = { ...DEFAULT_CONFIG, ...cfg };
  cfg.roots = Array.isArray(cfg.roots) ? cfg.roots : [];
  cfg.hidden ||= [];
  cfg.extra ||= [];
  return cfg;
}
function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
}

// Entorno base: git nunca pide nada por terminal (el server no tiene tty).
const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  SSH_ASKPASS_REQUIRE: 'never',
  GIT_PAGER: 'cat',
};

// Al abrir desde el menú el PATH viene recortado (sin nvm/yarn): se toma el del shell de login,
// así los hooks de git (husky, lint-staged, docker...) encuentran sus herramientas.
const shellPathReady = new Promise(resolve => {
  const shell = process.env.SHELL || '/bin/bash';
  execFile(shell, ['-ilc', 'printf "__PATH__%s__PATH__" "$PATH"'], { timeout: 8000, encoding: 'utf8' }, (_, stdout) => {
    const m = (stdout || '').match(/__PATH__(.*?)__PATH__/s);
    const parts = [...(m ? m[1].split(':') : []), path.join(HOME, '.local', 'bin'), ...(process.env.PATH || '').split(':')];
    const merged = [...new Set(parts.filter(Boolean))].join(':');
    process.env.PATH = merged;
    GIT_ENV.PATH = merged;
    TOOL_ENV.PATH = merged;
    resolve(merged);
  });
});

function httpErr(status, msg) {
  const e = new Error(msg);
  e.status = status;
  return e;
}

function git(cwd, args, { input, timeout = 30000, okCodes = [0], env = GIT_ENV } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, { cwd, env, timeout, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
      if (okCodes.includes(code)) return resolve(stdout);
      let msg = (stderr || '').trim() || (stdout || '').trim() || err.message;
      if (err && err.killed) msg = `timeout (${timeout / 1000}s) en git ${args[0]}. ¿Pide passphrase o credenciales? ` + msg;
      const e = new Error(msg);
      e.status = 400;
      reject(e);
    });
    if (input != null) child.stdin.end(input);
  });
}

// Corre fn sobre items con concurrencia limitada.
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k]);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------- SSH / identidades ----------

function parseSshConfig() {
  let txt = '';
  try {
    txt = fs.readFileSync(path.join(HOME, '.ssh', 'config'), 'utf8');
  } catch {
    return [];
  }
  const hosts = [];
  let cur = null;
  for (const raw of txt.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(\S+?)\s*[=\s]\s*(.*)$/);
    if (!m) continue;
    const k = m[1].toLowerCase();
    const v = m[2].trim();
    if (k === 'host') {
      cur = { host: v, hostname: '', user: '', identityFile: '' };
      hosts.push(cur);
    } else if (k === 'match') {
      cur = null;
    } else if (cur) {
      if (k === 'hostname') cur.hostname = v;
      else if (k === 'user') cur.user = v;
      else if (k === 'identityfile') cur.identityFile = v;
    }
  }
  // Solo la ruta de la clave y si existe; nunca se lee su contenido.
  for (const h of hosts) h.keyExists = h.identityFile ? fs.existsSync(expand(h.identityFile)) : null;
  return hosts;
}

async function readIdentities(cfg) {
  const ssh = parseSshConfig();
  const ids = await Promise.all(
    cfg.roots.map(async r => {
      let email = '';
      let userName = '';
      if (r.gitconfig) {
        const f = expand(r.gitconfig);
        email = (await git(HOME, ['config', '-f', f, 'user.email'], { okCodes: [0, 1] }).catch(() => '')).trim();
        userName = (await git(HOME, ['config', '-f', f, 'user.name'], { okCodes: [0, 1] }).catch(() => '')).trim();
      }
      return {
        name: r.name,
        dir: r.dir,
        color: r.color || null,
        sshHost: r.sshHost,
        gitconfig: r.gitconfig,
        email,
        userName,
        ssh: ssh.find(h => h.host === r.sshHost) || null,
      };
    })
  );
  return { ids, ssh };
}

// ---------- escaneo de repos ----------

async function isRepo(dir) {
  try {
    await fsp.stat(path.join(dir, '.git')); // dir normal o archivo (worktree)
    return true;
  } catch {
    return false;
  }
}

async function subdirs(dir) {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name))
      .map(e => path.join(dir, e.name));
  } catch {
    return [];
  }
}

// Repos bajo dir: un dir con .git es repo (no se baja más); si no, se baja hasta `depth` niveles
// (worktrees tipo wt/CMS-535/cms).
async function findRepos(dir, depth) {
  if (await isRepo(dir)) return [dir];
  if (depth <= 0) return [];
  const out = [];
  for (const d of await subdirs(dir)) out.push(...(await findRepos(d, depth - 1)));
  return out;
}

async function scan(cfg) {
  const repos = [];
  const nonGit = [];
  const depth = cfg.scanDepth || 3;
  for (const root of cfg.roots) {
    const rootDir = expand(root.dir);
    if (await isRepo(rootDir)) {
      repos.push({ path: rootDir, identity: root.name, name: path.basename(rootDir) });
      continue;
    }
    for (const d of await subdirs(rootDir)) {
      const found = await findRepos(d, depth - 1);
      if (!found.length) {
        nonGit.push({ path: d, identity: root.name, name: path.relative(rootDir, d) });
        continue;
      }
      for (const p of found) {
        const entry = { path: p, identity: root.name, name: path.relative(rootDir, p) };
        if (p !== d) entry.group = path.basename(d);
        repos.push(entry);
      }
    }
  }
  for (const x of cfg.extra) {
    const p = expand(x.path);
    if (!repos.some(r => r.path === p) && (await isRepo(p))) repos.push({ path: p, identity: x.identity, name: path.basename(p), extra: true });
  }
  return { repos, nonGit };
}

let known = new Map(); // path -> entry del escaneo
let knownNonGit = new Map();

async function refreshKnown(cfg = loadConfig()) {
  const { repos, nonGit } = await scan(cfg);
  known = new Map(repos.map(r => [r.path, r]));
  knownNonGit = new Map(nonGit.map(r => [r.path, r]));
  return { repos, nonGit };
}

async function repoOf(p) {
  if (!p) throw httpErr(400, 'falta repo');
  if (!known.has(p)) await refreshKnown();
  const e = known.get(p);
  if (!e) throw httpErr(404, `repo desconocido: ${p}`);
  return e;
}

// ---------- estado de un repo ----------

function parseStatus(out) {
  const parts = out.split('\0');
  const r = { branch: '', oid: '', upstream: '', ahead: 0, behind: 0, files: [] };
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    if (p.startsWith('# ')) {
      const [, k, ...rest] = p.split(' ');
      const v = rest.join(' ');
      if (k === 'branch.head') r.branch = v;
      else if (k === 'branch.oid') r.oid = v;
      else if (k === 'branch.upstream') r.upstream = v;
      else if (k === 'branch.ab') {
        const m = v.match(/\+(\d+) -(\d+)/);
        if (m) [r.ahead, r.behind] = [+m[1], +m[2]];
      }
      continue;
    }
    const f = p.split(' ');
    if (p[0] === '1') r.files.push({ xy: f[1], path: f.slice(8).join(' ') });
    else if (p[0] === '2') r.files.push({ xy: f[1], path: f.slice(9).join(' '), orig: parts[++i] }); // rename: path original va en el token siguiente
    else if (p[0] === 'u') r.files.push({ xy: f[1], path: f.slice(10).join(' '), conflict: true });
    else if (p[0] === '?') r.files.push({ xy: '??', path: p.slice(2), untracked: true });
  }
  return r;
}

function countFiles(files) {
  const c = { staged: 0, unstaged: 0, untracked: 0, conflicts: 0 };
  for (const f of files) {
    if (f.untracked) c.untracked++;
    else if (f.conflict) c.conflicts++;
    else {
      if (f.xy[0] !== '.') c.staged++;
      if (f.xy[1] !== '.') c.unstaged++;
    }
  }
  c.total = files.length;
  return c;
}

function parseRemote(url) {
  let m;
  if ((m = url.match(/^https?:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/))) return { kind: 'https', host: m[1], path: m[2] };
  if ((m = url.match(/^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/))) return { kind: 'ssh', host: m[1], path: m[2] };
  if ((m = url.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/))) return { kind: 'ssh', host: m[1], path: m[2] };
  return { kind: 'otro', host: '', path: url };
}

function isLocalConfig(origin) {
  return /(^|\/)\.git\//.test(origin) || origin.startsWith('.git');
}

async function summarize(entry, ctx, { untrackedAll = false } = {}) {
  const repo = entry.path;
  const id = ctx.ids.find(x => x.name === entry.identity);
  const s = {
    path: repo,
    display: tilde(repo),
    name: entry.name,
    group: entry.group || null,
    identity: entry.identity,
    extra: !!entry.extra,
    hidden: ctx.hidden.has(repo),
    warnings: [],
  };
  try {
    const [st, cfgOut, last, op] = await Promise.all([
      git(repo, ['status', '--porcelain=v2', '--branch', '-z', untrackedAll ? '-uall' : '-unormal']),
      git(repo, ['config', '--show-origin', '--get-regexp', '^(user\\.email|remote\\..*\\.url)$'], { okCodes: [0, 1] }),
      git(repo, ['log', '-1', '--format=%ct'], { okCodes: [0, 128] }).catch(() => ''),
      repoOperation(repo),
    ]);
    if (op) s.operation = op;
    const status = parseStatus(st);
    Object.assign(s, {
      branch: status.branch,
      oid: status.oid,
      upstream: status.upstream,
      ahead: status.ahead,
      behind: status.behind,
      counts: countFiles(status.files),
      lastCommit: +last.trim() || 0,
    });
    if (untrackedAll) s.files = status.files.slice(0, MAX_FILES);
    if (status.files.length > MAX_FILES) s.filesTruncated = true;

    const remotes = {};
    for (const line of cfgOut.split('\n')) {
      const m = line.match(/^file:(.*?)\t(\S+) (.*)$/);
      if (!m) continue;
      const [, origin, key, val] = m;
      if (key === 'user.email') {
        s.email = val; // la última definición gana, igual que git
        s.emailSource = tilde(origin);
        s.emailLocal = isLocalConfig(origin);
      } else {
        remotes[key.slice('remote.'.length, -'.url'.length)] = val;
      }
    }
    const remoteName = 'origin' in remotes ? 'origin' : Object.keys(remotes)[0];
    s.remoteName = remoteName || null;
    s.remoteUrl = remoteName ? remotes[remoteName] : null;

    if (id) {
      s.expectedHost = id.sshHost;
      s.expectedEmail = id.email;
      if (s.remoteUrl) {
        const r = parseRemote(s.remoteUrl);
        s.remoteHost = r.host;
        s.remoteKind = r.kind;
        if (id.sshHost && r.host !== id.sshHost) {
          const other = ctx.ids.find(x => x.sshHost === r.host);
          let msg;
          if (r.kind === 'https') msg = `remote por HTTPS (${r.host}): no usa la clave SSH de ${id.name}`;
          else if (other) msg = `usa el alias SSH de ${other.name} (${r.host}), esperado ${id.sshHost}`;
          else msg = `remote sin alias SSH (${r.host}): usa la clave SSH por defecto, no la de ${id.name}`;
          s.warnings.push({ kind: 'remote', msg });
          const realHost = ctx.sshByHost[r.host]?.hostname || r.host;
          const expHost = ctx.sshByHost[id.sshHost]?.hostname || 'github.com';
          const clean = r.path.replace(/\/$/, '').replace(/\.git$/, '');
          if (realHost === expHost && /^[\w.-]+\/[\w.-]+$/.test(clean)) s.fixUrl = `git@${id.sshHost}:${clean}.git`;
        }
      }
      if (id.email && s.email !== id.email) {
        s.warnings.push({
          kind: 'email',
          msg: s.email ? `commitea como ${s.email} (${s.emailSource}), esperado ${id.email}` : `sin user.email, esperado ${id.email}`,
        });
      }
    }
  } catch (e) {
    s.error = e.message;
  }
  return s;
}

async function context(cfg) {
  const { ids, ssh } = await readIdentities(cfg);
  return { ids, ssh, sshByHost: Object.fromEntries(ssh.map(h => [h.host, h])), hidden: new Set(cfg.hidden) };
}

// ---------- merge / rebase / conflictos ----------

// Operación en curso (merge, rebase, cherry-pick, revert) según los archivos de control de git.
async function repoOperation(repo) {
  const gitDir = (await git(repo, ['rev-parse', '--absolute-git-dir'], { okCodes: [0, 128] }).catch(() => '')).trim();
  if (!gitDir) return null;
  const has = f => fs.existsSync(path.join(gitDir, f));
  const firstLine = f => {
    try {
      return fs.readFileSync(path.join(gitDir, f), 'utf8').split('\n')[0].trim();
    } catch {
      return '';
    }
  };
  if (has('rebase-merge') || has('rebase-apply')) {
    const d = has('rebase-merge') ? 'rebase-merge' : 'rebase-apply';
    const onto = firstLine(`${d}/onto`);
    const head = firstLine(`${d}/head-name`).replace(/^refs\/heads\//, '');
    return { type: 'rebase', label: `Rebase de ${head || 'HEAD'}${onto ? ` sobre ${onto.slice(0, 7)}` : ''}` };
  }
  if (has('MERGE_HEAD')) return { type: 'merge', label: firstLine('MERGE_MSG') || 'Merge en curso' };
  if (has('CHERRY_PICK_HEAD')) return { type: 'cherry-pick', label: `Cherry-pick de ${firstLine('CHERRY_PICK_HEAD').slice(0, 7)}` };
  if (has('REVERT_HEAD')) return { type: 'revert', label: `Revert de ${firstLine('REVERT_HEAD').slice(0, 7)}` };
  return null;
}

const OP_ABORT = { merge: ['merge', '--abort'], rebase: ['rebase', '--abort'], 'cherry-pick': ['cherry-pick', '--abort'], revert: ['revert', '--abort'] };
const OP_CONTINUE = { merge: ['commit', '--no-edit'], rebase: ['rebase', '--continue'], 'cherry-pick': ['cherry-pick', '--continue'], revert: ['revert', '--continue'] };

// Archivo en conflicto dentro del repo (valida que la ruta no se salga).
function repoFile(repo, rel) {
  const abs = path.resolve(repo, String(rel || ''));
  if (!abs.startsWith(repo + path.sep)) throw httpErr(400, 'archivo fuera del repo');
  return abs;
}

async function isConflicted(repo, rel) {
  const out = await git(repo, ['diff', '--name-only', '--diff-filter=U', '-z']);
  return out.split('\0').includes(rel);
}

// Separa el archivo en texto normal y bloques de conflicto (soporta diff3/zdiff3 con sección base).
function parseConflicts(text) {
  const lines = text.split('\n');
  const blocks = [];
  let cur = null;
  let part = null;
  lines.forEach((line, i) => {
    if (line.startsWith('<<<<<<<')) {
      cur = { start: i, oursLabel: line.slice(7).trim(), ours: [], base: null, theirs: [], baseLabel: '' };
      part = 'ours';
    } else if (cur && line.startsWith('|||||||')) {
      cur.base = [];
      cur.baseLabel = line.slice(7).trim();
      part = 'base';
    } else if (cur && line.startsWith('=======')) {
      part = 'theirs';
    } else if (cur && line.startsWith('>>>>>>>')) {
      cur.end = i;
      cur.theirsLabel = line.slice(7).trim();
      blocks.push(cur);
      cur = null;
      part = null;
    } else if (cur) cur[part].push(line);
  });
  return { lines, blocks };
}

const CONFLICT_PROMPT = `Resolvé este conflicto de merge de git. Te paso por stdin el archivo, el contexto alrededor del bloque, la versión "mía" (HEAD), la base común (si existe) y la versión "de ellos".
Combiná las dos intenciones cuando sean compatibles; si se contradicen, priorizá la que sea más completa o correcta y no pierdas cambios útiles de ninguna.
Respondé SOLO el código final que reemplaza el bloque completo (sin marcadores <<<<<<< ======= >>>>>>>, sin explicaciones, sin bloque de código).`;

// ---------- diffs ----------

function truncate(text) {
  if (text.length <= MAX_DIFF) return { text, truncated: false };
  return { text: text.slice(0, text.lastIndexOf('\n', MAX_DIFF) + 1), truncated: true };
}

async function fileDiff(repo, { path: p, orig, mode }) {
  if (!p) throw httpErr(400, 'falta path');
  if (mode === 'untracked') {
    const st = await fsp.stat(path.join(repo, p)).catch(() => null);
    if (st && st.size > 5 * 1024 * 1024) return { text: '', note: `archivo nuevo de ${(st.size / 1048576).toFixed(1)} MB, no se muestra` };
    return truncate(await git(repo, ['diff', '--no-color', '--no-ext-diff', '--no-index', '--', '/dev/null', p], { okCodes: [0, 1] }));
  }
  const args = ['diff', '--no-color', '--no-ext-diff'];
  if (mode === 'staged') args.push('--cached', '-M');
  args.push('--', ...(orig ? [orig, p] : [p]));
  return truncate(await git(repo, args));
}

const APPLY_FLAGS = {
  stage: ['--cached'],
  unstage: ['--cached', '--reverse'],
  discard: ['--reverse'],
};

// ---------- log ----------

const SEP = '\x1f';
const REC = '\x1e';

async function readLog(repo, { all, n }) {
  const limit = Math.min(Math.max(+n || 300, 1), 3000);
  const args = ['log', '--date-order', '--decorate=full', `-n${limit}`, `--format=%H${SEP}%P${SEP}%an${SEP}%ae${SEP}%at${SEP}%D${SEP}%s${REC}`];
  // --all incluiría refs/stash; se listan las refs a mano.
  if (all === '1') args.push('--branches', '--remotes', '--tags', 'HEAD');
  const out = await git(repo, args, { okCodes: [0, 128] }).catch(() => '');
  return out
    .split(REC)
    .map(r => r.replace(/^\n/, ''))
    .filter(Boolean)
    .map(r => {
      const [sha, parents, author, email, time, refs, subject] = r.split(SEP);
      return { sha, parents: parents ? parents.split(' ') : [], author, email, time: +time, refs: parseRefs(refs), subject };
    });
}

// %D con --decorate=full → [{ type: local|remote|tag|head, name, current }]
function parseRefs(d) {
  if (!d) return [];
  return d
    .split(', ')
    .map(x => {
      if (x === 'HEAD') return { type: 'head', name: 'HEAD' };
      if (x.startsWith('HEAD -> ')) return { type: 'local', name: x.slice(8).replace(/^refs\/heads\//, ''), current: true };
      if (x.startsWith('tag: ')) return { type: 'tag', name: x.slice(5).replace(/^refs\/tags\//, '') };
      if (x.startsWith('refs/heads/')) return { type: 'local', name: x.slice(11) };
      if (x.startsWith('refs/remotes/')) return { type: 'remote', name: x.slice(13) };
      return { type: 'other', name: x };
    })
    .filter(r => !(r.type === 'remote' && r.name.endsWith('/HEAD')));
}

// ---------- red ----------

async function netEnv(repo) {
  // Respeta core.sshCommand si existe, pero sin prompts: falla en vez de colgarse.
  const cmd = (await git(repo, ['config', 'core.sshCommand'], { okCodes: [0, 1] })).trim() || 'ssh';
  return { ...GIT_ENV, GIT_SSH_COMMAND: `${cmd} -o BatchMode=yes -o ConnectTimeout=15` };
}

async function netOp(repo, op) {
  const env = await netEnv(repo);
  const opts = { env, timeout: 120000 };
  if (op === 'fetch') return git(repo, ['fetch', '--all', '--prune'], opts);
  if (op === 'pull') return git(repo, ['pull', '--ff-only'], opts);
  if (op === 'push') {
    const up = await git(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { okCodes: [0, 128] });
    return up.trim() ? git(repo, ['push'], opts) : git(repo, ['push', '-u', 'origin', 'HEAD'], opts);
  }
  throw httpErr(400, `op desconocida: ${op}`);
}

function launch(cmd, args, cwd, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, detached: true, stdio: 'ignore' });
    child.once('error', e => reject(httpErr(400, `no se pudo abrir ${cmd}: ${e.message}`)));
    child.once('spawn', () => {
      child.unref();
      resolve({ ok: true });
    });
  });
}

// ---------- terminal / editor ----------

const OPENER = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
const editorCmd = () => loadConfig().editor || 'code';

// Cómo abre cada terminal conocida una carpeta (y opcionalmente un comando).
const TERMINALS = {
  ghostty: (dir, cmd) => [`--working-directory=${dir}`, ...(cmd ? ['-e', cmd] : [])],
  kitty: (dir, cmd) => ['--directory', dir, ...(cmd ? [cmd] : [])],
  alacritty: (dir, cmd) => ['--working-directory', dir, ...(cmd ? ['-e', cmd] : [])],
  wezterm: (dir, cmd) => ['start', '--cwd', dir, ...(cmd ? ['--', cmd] : [])],
  'gnome-terminal': (dir, cmd) => [`--working-directory=${dir}`, ...(cmd ? ['--', cmd] : [])],
  konsole: (dir, cmd) => ['--workdir', dir, ...(cmd ? ['-e', cmd] : [])],
  'xfce4-terminal': (dir, cmd) => [`--working-directory=${dir}`, ...(cmd ? ['-x', cmd] : [])],
  foot: (dir, cmd) => [`--working-directory=${dir}`, ...(cmd ? [cmd] : [])],
  'x-terminal-emulator': (_, cmd) => (cmd ? ['-e', cmd] : []),
};

// config.terminal > $TERMINAL > la primera terminal conocida instalada.
function pickTerminal() {
  const wanted = loadConfig().terminal || process.env.TERMINAL;
  if (wanted) return wanted;
  return Object.keys(TERMINALS).find(t => findBin(t)) || null;
}

function openTerminal(dir, cmd, env = TOOL_ENV) {
  if (process.platform === 'darwin') {
    const line = `cd ${JSON.stringify(dir)}${cmd ? ` && ${JSON.stringify(cmd)}` : ''}`;
    return launch('osascript', ['-e', `tell application "Terminal" to do script ${JSON.stringify(line)}`, '-e', 'tell application "Terminal" to activate'], dir, env);
  }
  const term = pickTerminal();
  if (!term) throw httpErr(400, 'no encontré una terminal: definí "terminal" en la config');
  const argsFor = TERMINALS[path.basename(term)] || ((_, c) => (c ? ['-e', c] : []));
  return launch(term, argsFor(dir, cmd), dir, env);
}

// ---------- Claude ----------

// Busca un ejecutable en PATH + ~/.local/bin (al abrir desde el menú el PATH puede venir recortado).
function findBin(name) {
  const dirs = [...(process.env.PATH || '').split(':'), path.join(HOME, '.local', 'bin')];
  for (const d of dirs) {
    const p = path.join(d, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {}
  }
  return null;
}

const TOOL_ENV = { ...GIT_ENV, PATH: `${path.join(HOME, '.local', 'bin')}:${process.env.PATH || ''}` };

// Cada cuenta usa su propio perfil de Claude (CLAUDE_CONFIG_DIR) y su vault: nunca se mezclan.
function claudeCtx(entry) {
  const root = loadConfig().roots.find(r => r.name === entry.identity);
  const env = { ...TOOL_ENV };
  if (root?.claudeConfigDir) env.CLAUDE_CONFIG_DIR = expand(root.claudeConfigDir);
  const vault = root?.vault && fs.existsSync(expand(root.vault)) ? expand(root.vault) : null;
  return { env, vault, identity: entry.identity };
}

const COMMIT_PROMPT =
  'Proponé 3 mensajes de commit Conventional Commits para el diff staged, en el idioma y estilo de los commits anteriores. ' +
  'Una sola línea cada uno, máximo 72 caracteres. Respondé SOLO las 3 líneas, sin numerar, sin comillas, sin texto extra.';

// 3 mensajes de commit para lo que está en stage, imitando el estilo de los últimos commits.
async function genCommit(repo, env = TOOL_ENV) {
  const stat = await git(repo, ['diff', '--cached', '--stat']);
  if (!stat.trim()) throw httpErr(400, 'No hay nada en stage');
  const diff = (await git(repo, ['diff', '--cached'])).slice(0, 60000);
  const recent = await git(repo, ['log', '--format=%s', '-10', '--no-merges'], { okCodes: [0, 128] }).catch(() => '');
  const input = `Últimos commits del repo (imitá idioma y estilo):\n${recent}\nDiff staged:\n${stat}\n${diff}`;
  const out = await runClaude(repo, COMMIT_PROMPT, input, { model: loadConfig().commitModel || 'haiku', timeout: 120000, env });
  const messages = out
    .split('\n')
    .map(l => l.trim().replace(/^[-*]\s+/, '').replace(/^\d+[.)]\s+/, '').replace(/^["'`]|["'`]$/g, ''))
    .filter(Boolean)
    .slice(0, 3);
  if (!messages.length) throw httpErr(400, 'Claude no devolvió mensajes');
  return { messages };
}

// Corre el CLI de claude en modo -p, sin herramientas, MCP ni settings.
function runClaude(cwd, prompt, input, { model = 'sonnet', timeout = 180000, env = TOOL_ENV } = {}) {
  const claude = findBin('claude');
  if (!claude) throw httpErr(400, 'no encontré el CLI de claude');
  const args = ['-p', prompt, '--model', model, '--tools', '', '--no-session-persistence', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'];
  return new Promise((resolve, reject) => {
    const child = execFile(claude, args, { cwd, env, timeout, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(httpErr(400, err.killed ? `Claude tardó demasiado (timeout ${timeout / 1000}s)` : (stderr || stdout || err.message).trim()));
      resolve(stdout.trim());
    });
    child.stdin.end(input);
  });
}

// Ramas candidatas a base del PR (remotas primero; si no hay remote, locales).
async function prBaseCandidates(repo, branch) {
  const names = ['develop', 'dev', 'main', 'master', 'staging'];
  const remote = (await git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes'])).split('\n').filter(Boolean);
  const local = (await git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])).split('\n').filter(Boolean);
  const pick = refs => refs.filter(r => names.includes(r.split('/').pop()) && r.split('/').slice(1).join('/') !== branch);
  const fromRemote = pick(remote).filter(r => r.includes('/'));
  const fromLocal = local.filter(r => names.includes(r) && r !== branch);
  return fromRemote.length ? fromRemote : fromLocal;
}

// Base = la candidata de la que la rama actual se separó más recién (menos commits propios).
async function pickBase(repo, cands) {
  const counts = [];
  for (const c of cands) {
    const n = parseInt(await git(repo, ['rev-list', '--count', `${c}..HEAD`], { okCodes: [0, 128] }), 10);
    if (!Number.isNaN(n)) counts.push({ ref: c, n });
  }
  const ahead = counts.filter(x => x.n > 0).sort((a, b) => a.n - b.n);
  return (ahead[0] || counts[0])?.ref || null;
}

const PR_EXCLUDE = [':(exclude)*.lock', ':(exclude)package-lock.json', ':(exclude)pnpm-lock.yaml', ':(exclude)yarn.lock', ':(exclude)*.min.js', ':(exclude)*.map'];

const PR_PROMPT = `Escribí la descripción de un pull request en Markdown crudo, para que la entienda rápido alguien que no conoce el código (revisor, PM o QA).
Usá exactamente esta estructura y nada más:

## Problema
1 a 3 frases: qué estaba mal o qué faltaba y a quién afecta.

## Solución
Viñetas cortas: qué se cambió y por qué. Mencioná archivos o componentes solo si ayudan a revisar.

Reglas: lenguaje simple y directo, sin relleno, sin título, sin secciones extra, sin emojis, sin envolver la respuesta en bloques de código.
Escribí en el idioma de los commits (si no queda claro, en español). No inventes cosas que no estén en el diff.
Respondé SOLO el markdown.`;

// Diff de la rama contra su base (o lo sin commitear si la rama no tiene commits propios).
async function branchContext(repo, baseReq) {
  const branch = (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  const candidates = await prBaseCandidates(repo, branch);
  const validRef = async r => !r.startsWith('-') && !!(await git(repo, ['rev-parse', '--verify', '--quiet', `${r}^{commit}`], { okCodes: [0, 1] })).trim();
  const base = baseReq && (candidates.includes(baseReq) || (await validRef(baseReq))) ? baseReq : await pickBase(repo, candidates);
  let commits = '';
  let stat = '';
  let diff = '';
  let source = 'commits';
  if (base) {
    commits = await git(repo, ['log', '--no-merges', '-n50', '--format=- %s%n%b', `${base}..HEAD`]);
    stat = await git(repo, ['diff', '--stat', `${base}...HEAD`, '--', '.', ...PR_EXCLUDE]);
    diff = await git(repo, ['diff', '--no-color', '--no-ext-diff', `${base}...HEAD`, '--', '.', ...PR_EXCLUDE]);
  }
  if (!diff.trim()) {
    source = 'sin-commitear';
    stat = await git(repo, ['diff', '--stat', 'HEAD', '--', '.', ...PR_EXCLUDE], { okCodes: [0, 128] });
    diff = await git(repo, ['diff', '--no-color', '--no-ext-diff', 'HEAD', '--', '.', ...PR_EXCLUDE], { okCodes: [0, 128] });
  }
  if (!diff.trim()) throw httpErr(400, base ? `No hay cambios entre ${base} y ${branch}` : 'No hay cambios para revisar');
  return { branch, base, candidates, commits, stat, diff, source };
}

async function genPr(repo, baseReq, env = TOOL_ENV) {
  const { branch, base, candidates, commits, stat, diff, source } = await branchContext(repo, baseReq);
  const input = [
    `Rama: ${branch}` + (base ? `  →  base: ${base}` : ''),
    commits.trim() ? `\nCommits:\n${commits.trim()}` : '',
    `\nArchivos:\n${stat.trim()}`,
    `\nDiff:\n${diff.slice(0, 80000)}`,
  ].join('\n');
  let markdown = await runClaude(repo, PR_PROMPT, input, { env });
  markdown = markdown.replace(/^```(?:markdown|md)?\s*\n/, '').replace(/\n```\s*$/, '').trim();
  return { markdown, base, candidates, branch, source };
}

// ---------- pull requests (gh) ----------

// gh con la config de cada cuenta (GH_CONFIG_DIR), sin prompts.
// Sin ghConfigDir se usa la cuenta por defecto de gh.
function ghEnv(root) {
  const env = { ...TOOL_ENV, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' };
  if (root?.ghConfigDir) env.GH_CONFIG_DIR = expand(root.ghConfigDir);
  return env;
}

function gh(args, env, cwd = HOME, timeout = 30000) {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { cwd, env, timeout, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(httpErr(400, err.killed ? 'gh tardó demasiado' : (stderr || stdout || err.message).trim()));
      resolve(stdout);
    });
  });
}

const PR_FIELDS = 'number,title,url,repository,author,updatedAt,isDraft,labels,commentsCount';

// owner/repo (minúsculas) -> rutas locales, a partir del remote de cada repo escaneado.
async function localReposByRemote() {
  if (!known.size) await refreshKnown();
  const map = {};
  await pool([...known.values()], 8, async e => {
    const url = (await git(e.path, ['config', '--get', 'remote.origin.url'], { okCodes: [0, 1] }).catch(() => '')).trim();
    if (!url) return;
    const key = parseRemote(url).path.replace(/\/$/, '').replace(/\.git$/, '').toLowerCase();
    (map[key] ||= []).push({ path: e.path, name: e.name, worktree: !!e.group, identity: e.identity });
  });
  for (const k of Object.keys(map)) map[k].sort((a, b) => a.worktree - b.worktree || a.name.localeCompare(b.name));
  return map;
}

async function prsFor(root, locals) {
  const out = { identity: root.name, ghConfigDir: root.ghConfigDir || null, connected: false };
  const env = ghEnv(root);
  try {
    out.login = (await gh(['api', 'user', '--jq', '.login'], env)).trim();
    out.connected = true;
  } catch (e) {
    return { ...out, error: e.message.split('\n')[0] };
  }
  const search = async q => {
    const rows = JSON.parse(await gh(['search', 'prs', ...q, '--state=open', '--limit', '50', '--json', PR_FIELDS], env));
    return rows.map(pr => {
      const repo = pr.repository?.nameWithOwner || '';
      return {
        number: pr.number,
        title: pr.title,
        url: pr.url,
        repo,
        author: pr.author?.login || '',
        updatedAt: pr.updatedAt,
        draft: pr.isDraft,
        labels: (pr.labels || []).map(l => l.name),
        comments: pr.commentsCount || 0,
        local: locals[repo.toLowerCase()] || [],
      };
    });
  };
  try {
    [out.reviewRequested, out.assigned, out.authored] = await Promise.all([search(['--review-requested=@me']), search(['--assignee=@me']), search(['--author=@me'])]);
  } catch (e) {
    out.error = e.message.split('\n')[0];
    return out;
  }
  // PRs de repos renombrados en GitHub: el remote local tiene el nombre viejo; se resuelve el actual con gh.
  const all = [...out.reviewRequested, ...out.assigned, ...out.authored];
  if (all.some(pr => !pr.local.length)) {
    const mine = Object.keys(locals).filter(k => locals[k].some(l => l.identity === root.name));
    await pool(mine, 6, async k => {
      if (!(k in canonicalRepo)) canonicalRepo[k] = (await gh(['api', `repos/${k}`, '--jq', '.full_name'], env).catch(() => k)).trim().toLowerCase();
    });
    for (const pr of all) {
      if (pr.local.length) continue;
      const k = mine.find(x => canonicalRepo[x] === pr.repo.toLowerCase());
      if (k) pr.local = locals[k];
    }
  }
  return out;
}

const canonicalRepo = {}; // owner/repo del remote local -> nombre actual en GitHub

// ---------- review de PR ----------

// Antepone a cada línea +/contexto su número en el archivo nuevo, para que Claude cite líneas exactas.
function annotateDiff(diff) {
  const out = [];
  let n = 0;
  let header = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff ')) header = true;
    const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (m) {
      header = false;
      n = +m[1];
      out.push(line);
    } else if (header || line.startsWith('\\')) out.push(line);
    else if (line.startsWith('-')) out.push(`      ${line}`);
    else if (line.startsWith('+') || line.startsWith(' ')) out.push(`${String(n++).padStart(5)} ${line}`);
    else out.push(line);
  }
  return out.join('\n');
}

const REVIEW_TYPES = ['rompe', 'bug', 'seguridad', 'mejora', 'pregunta'];

function reviewPrompt(vault) {
  return `Sos un revisor de código senior. Revisá los cambios de esta rama como en un pull request. Te paso por stdin los commits y el diff; a la izquierda de cada línea está su número en el archivo nuevo.

${vault ? `Contexto de negocio: en ${vault} hay un vault Obsidian con notas de dominio (reglas de negocio) y de servicios, enlazadas con [[wikilinks]] y con un campo \`resumen\` en el frontmatter.
1. Buscá con Grep en el vault el nombre del repo y 1 o 2 términos clave del cambio. De las notas que aparezcan mirá primero el \`resumen\` y abrí completas solo las relevantes (máximo 4).
2. Usá las reglas de negocio del vault para detectar cambios que las contradigan.` : 'No hay vault de contexto para este repo.'}
3. Si el cambio modifica funciones, tipos, exports, endpoints o esquemas, buscá con Grep sus usos en el repo para ver si algo se rompe.
No leas archivos fuera del repo${vault ? ' y del vault' : ''}. No modifiques nada.

Reportá solo hallazgos concretos y útiles, cada uno con un tipo:
- "rompe": puede romper algo existente (usos, contratos, datos o una regla de negocio)
- "bug": error lógico probable
- "seguridad": riesgo de seguridad
- "mejora": se puede hacer más simple, claro o eficiente
- "pregunta": algo dudoso que conviene que el autor aclare
Nada de elogios ni de estilo trivial que ya cubre el linter. Si no hay nada importante, devolvé la lista vacía.

Cada comentario: 1 o 2 frases, en español, tono amable y directo, listo para pegar en el PR (ej: "Esto podría romper X porque Y; ¿conviene Z?").

Al terminar respondé SOLO este JSON, sin texto antes ni después y sin bloque de código:
{"resumen":"1 o 2 frases sobre el cambio y su riesgo","hallazgos":[{"archivo":"ruta/relativa/al/repo","linea":123,"tipo":"rompe|bug|seguridad|mejora|pregunta","comentario":"..."}]}
"linea" es el número del archivo nuevo tal como aparece a la izquierda del diff.`;
}

function parseReview(text, repo) {
  const t = (text || '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const i = t.indexOf('{');
  const j = t.lastIndexOf('}');
  if (i < 0 || j < i) throw new Error('Claude no devolvió el JSON del review');
  const data = JSON.parse(t.slice(i, j + 1));
  const hallazgos = (Array.isArray(data.hallazgos) ? data.hallazgos : [])
    .filter(x => x && x.comentario)
    .map(x => {
      const archivo = String(x.archivo || '').replace(/^\.?\//, '');
      return {
        archivo,
        linea: Number.isInteger(+x.linea) && +x.linea > 0 ? +x.linea : null,
        tipo: REVIEW_TYPES.includes(x.tipo) ? x.tipo : 'mejora',
        comentario: String(x.comentario).trim(),
        existe: !!archivo && fs.existsSync(path.join(repo, archivo)),
      };
    });
  const order = Object.fromEntries(REVIEW_TYPES.map((t, k) => [t, k]));
  hallazgos.sort((a, b) => order[a.tipo] - order[b.tipo]);
  return { resumen: String(data.resumen || '').trim(), hallazgos };
}

const runningReviews = new Map(); // repo -> proceso claude

// Historial de reviews en disco: ~/.local/share/gitpicho/reviews/<sha1 del repo>/<timestamp>.json
const REVIEWS_DIR = path.join(process.env.XDG_DATA_HOME || path.join(HOME, '.local', 'share'), 'gitpicho', 'reviews');
const reviewDir = repo => path.join(REVIEWS_DIR, require('node:crypto').createHash('sha1').update(repo).digest('hex').slice(0, 16));

function saveReview(repo, data) {
  const dir = reviewDir(repo);
  fs.mkdirSync(dir, { recursive: true });
  const id = new Date(data.createdAt).toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, repo, ...data }, null, 2));
  return id;
}

function listReviews(repo) {
  const dir = reviewDir(repo);
  let files = [];
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }
  return files
    .sort()
    .reverse()
    .map(f => {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        return { id: r.id, createdAt: r.createdAt, branch: r.branch, base: r.base, head: r.head, count: r.hallazgos?.length || 0 };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function readReview(repo, id) {
  if (!/^[\w-]+$/.test(id || '')) throw httpErr(400, 'id inválido');
  try {
    return JSON.parse(fs.readFileSync(path.join(reviewDir(repo), `${id}.json`), 'utf8'));
  } catch {
    throw httpErr(404, 'review no encontrado');
  }
}

// Corre el review con Claude (solo lectura: Read/Grep/Glob sobre repo + vault) mostrando el progreso en vivo.
// Al final escribe \0 + JSON con el resultado.
async function reviewStream(res, b) {
  const entry = await repoOf(b.repo);
  const repo = entry.path;
  if (runningReviews.has(repo)) throw httpErr(409, 'ya hay un review corriendo en este repo');
  const claude = findBin('claude');
  if (!claude) throw httpErr(400, 'no encontré el CLI de claude');
  await shellPathReady;
  const { env, vault, identity } = claudeCtx(entry);
  const ctx = await branchContext(repo, b.base);
  const head = (await git(repo, ['rev-parse', 'HEAD'], { okCodes: [0, 128] })).trim();
  const createdAt = Date.now();
  let logText = '';
  const input = [
    `Repo: ${path.basename(repo)}  ·  Rama: ${ctx.branch}` + (ctx.base ? `  →  base: ${ctx.base}` : '  (cambios sin commitear)'),
    ctx.commits.trim() ? `\nCommits:\n${ctx.commits.trim()}` : '',
    `\nArchivos:\n${ctx.stat.trim()}`,
    `\nDiff:\n${annotateDiff(ctx.diff.slice(0, 120000))}`,
    ctx.diff.length > 120000 ? '\n(diff truncado: es muy grande)' : '',
  ].join('\n');
  const args = [
    '-p', reviewPrompt(vault),
    '--model', loadConfig().reviewModel || 'sonnet',
    '--output-format', 'stream-json', '--verbose',
    '--no-session-persistence', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--tools', 'Read,Grep,Glob',
    '--allowedTools', 'Read', 'Grep', 'Glob',
  ];
  if (vault) args.push('--add-dir', vault);

  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  const write = t => {
    logText += t;
    if (!res.writableEnded) res.write(t);
  };
  write(`Revisando ${ctx.branch} contra ${ctx.base || 'HEAD (sin commitear)'} · perfil ${identity}${vault ? ` · vault ${tilde(vault)}` : ' · sin vault'}\n`);

  const short = p => {
    const v = String(p || '');
    if (vault && v.startsWith(vault)) return 'vault:' + v.slice(vault.length + 1);
    if (v.startsWith(repo)) return v.slice(repo.length + 1) || '.';
    return tilde(v);
  };
  const progress = c => {
    const i = c.input || {};
    if (c.name === 'Read') return `📄 leyendo ${short(i.file_path)}`;
    if (c.name === 'Grep') return `🔎 buscando "${i.pattern}" en ${short(i.path || repo)}`;
    if (c.name === 'Glob') return `📂 ${i.pattern}${i.path ? ' en ' + short(i.path) : ''}`;
    return `🔧 ${c.name}`;
  };

  const child = spawn(claude, args, { cwd: repo, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  runningReviews.set(repo, child);
  child.stdin.end(input);
  let buf = '';
  let errBuf = '';
  let result = null;
  child.stdout.on('data', d => {
    buf += d;
    let k;
    while ((k = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, k).trim();
      buf = buf.slice(k + 1);
      if (!line) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.type === 'assistant') {
        for (const c of ev.message?.content || []) {
          if (c.type === 'tool_use') write(progress(c) + '\n');
          else if (c.type === 'text' && c.text.trim() && !c.text.trim().startsWith('{')) write(`💭 ${c.text.trim().replace(/\s+/g, ' ').slice(0, 160)}\n`);
        }
      } else if (ev.type === 'result') result = ev;
    }
  });
  child.stderr.on('data', d => (errBuf += d));
  const finish = payload => {
    runningReviews.delete(repo);
    // se guarda aunque el cliente ya no esté mirando (cerró la ventana o cambió de repo)
    if (payload.ok) {
      try {
        payload.id = saveReview(repo, { ...payload, log: logText });
      } catch (e) {
        payload.saveError = e.message;
      }
    }
    if (!res.writableEnded) res.end(`\n\0${JSON.stringify(payload)}`);
  };
  res.on('close', () => {}); // si el cliente se va, el review sigue corriendo y se guarda igual
  child.on('error', e => finish({ ok: false, error: e.message }));
  child.on('close', (code, signal) => {
    const meta = { branch: ctx.branch, base: ctx.base, candidates: ctx.candidates, source: ctx.source, cost: result?.total_cost_usd, ms: result?.duration_ms, head, createdAt, secs: Math.round((Date.now() - createdAt) / 1000), identity };
    if (signal) return finish({ ok: false, error: 'Cancelado', ...meta });
    if (!result || result.is_error) return finish({ ok: false, error: (result?.result || errBuf || `claude salió con código ${code}`).trim().slice(0, 2000), ...meta });
    try {
      finish({ ok: true, ...parseReview(result.result, repo), ...meta });
    } catch (e) {
      finish({ ok: false, error: `${e.message}\n\n${String(result.result).slice(0, 1500)}`, ...meta });
    }
  });
}


// ---------- rutas ----------

const routes = {
  'GET /api/ping': async () => ({ ok: true }),

  'GET /api/overview': async () => {
    const cfg = loadConfig();
    const [{ repos, nonGit }, ctx] = await Promise.all([refreshKnown(cfg), context(cfg)]);
    const summaries = await pool(repos, 8, r => summarize(r, ctx));
    for (const id of ctx.ids) {
      const mine = summaries.filter(s => s.identity === id.name && !s.hidden);
      id.repoCount = mine.length;
      id.alertCount = mine.filter(s => s.warnings.length).length;
    }
    return {
      configPath: tilde(CONFIG_PATH),
      identities: ctx.ids,
      ssh: ctx.ssh,
      repos: summaries,
      nonGit: nonGit.map(n => ({ ...n, display: tilde(n.path) })),
    };
  },

  'GET /api/repo': async q => {
    const entry = await repoOf(q.repo);
    const cfg = loadConfig();
    return summarize(entry, await context(cfg), { untrackedAll: true });
  },

  'GET /api/branches': async q => {
    const { path: repo } = await repoOf(q.repo);
    const out = await git(repo, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)%09%(upstream:short)%09%(upstream:track)%09%(committerdate:unix)', 'refs/heads']);
    return out
      .split('\n')
      .filter(Boolean)
      .map(l => {
        const [name, upstream, track, time] = l.split('\t');
        return { name, upstream, track, time: +time };
      });
  },

  'GET /api/diff': async q => {
    const { path: repo } = await repoOf(q.repo);
    return fileDiff(repo, q);
  },

  'GET /api/log': async q => {
    const { path: repo } = await repoOf(q.repo);
    return readLog(repo, q);
  },

  'GET /api/show': async q => {
    const { path: repo } = await repoOf(q.repo);
    if (!/^[0-9a-f]{4,64}$/.test(q.sha || '')) throw httpErr(400, 'sha inválido');
    return truncate(await git(repo, ['show', '--no-color', '--no-ext-diff', '--format=fuller', '--stat', '--patch', q.sha]));
  },

  'POST /api/stage': async (_, b) => {
    const { path: repo } = await repoOf(b.repo);
    await git(repo, b.paths?.length ? ['add', '-A', '--', ...b.paths] : ['add', '-A']);
    return { ok: true };
  },

  'POST /api/unstage': async (_, b) => {
    const { path: repo } = await repoOf(b.repo);
    await git(repo, b.paths?.length ? ['reset', '-q', '--', ...b.paths] : ['reset', '-q']);
    return { ok: true };
  },

  'POST /api/discard': async (_, b) => {
    const { path: repo } = await repoOf(b.repo);
    if (!b.paths?.length) throw httpErr(400, 'faltan paths');
    if (b.untracked) await git(repo, ['clean', '-f', '-q', '--', ...b.paths]);
    else await git(repo, ['restore', '--worktree', '--', ...b.paths]);
    return { ok: true };
  },

  'POST /api/apply': async (_, b) => {
    const { path: repo } = await repoOf(b.repo);
    const flags = APPLY_FLAGS[b.mode];
    if (!flags) throw httpErr(400, 'modo inválido');
    if (!b.patch) throw httpErr(400, 'falta patch');
    await git(repo, ['apply', ...flags, '--whitespace=nowarn', '-'], { input: b.patch });
    return { ok: true };
  },

  'GET /api/prs': async () => {
    await shellPathReady;
    const locals = await localReposByRemote();
    // Una consulta por cuenta de gh: workspaces que comparten config se muestran una sola vez.
    const seen = new Set();
    const roots = loadConfig().roots.filter(r => {
      const key = r.ghConfigDir ? expand(r.ghConfigDir) : 'default';
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return Promise.all(roots.map(r => prsFor(r, locals)));
  },

  // gh pr checkout en el repo local (con la cuenta gh de ese repo). Devuelve la base del PR para el review.
  'POST /api/pr-checkout': async (_, b) => {
    const entry = await repoOf(b.repo);
    const n = parseInt(b.number, 10);
    if (!n) throw httpErr(400, 'número de PR inválido');
    const root = loadConfig().roots.find(r => r.name === entry.identity);
    const env = { ...ghEnv(root), GIT_SSH_COMMAND: (await netEnv(entry.path)).GIT_SSH_COMMAND, GIT_TERMINAL_PROMPT: '0' };
    const info = JSON.parse(await gh(['pr', 'view', String(n), '--json', 'baseRefName,headRefName'], env, entry.path));
    const out = await gh(['pr', 'checkout', String(n)], env, entry.path, 120000);
    return { ok: true, out, base: `origin/${info.baseRefName}`, head: info.headRefName };
  },

  'GET /api/reviews': async q => {
    const { path: repo } = await repoOf(q.repo);
    return { running: runningReviews.has(repo), list: listReviews(repo) };
  },

  'GET /api/review': async q => {
    const { path: repo } = await repoOf(q.repo);
    return readReview(repo, q.id);
  },

  'GET /api/merge-targets': async q => {
    const { path: repo } = await repoOf(q.repo);
    const cur = (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    const out = await git(repo, ['for-each-ref', '--sort=-committerdate', '--format=%(refname)%09%(refname:short)%09%(committerdate:unix)', 'refs/heads', 'refs/remotes']);
    return {
      current: cur,
      refs: out
        .split('\n')
        .filter(Boolean)
        .map(l => {
          const [full, name, time] = l.split('\t');
          return { name, remote: full.startsWith('refs/remotes/'), time: +time };
        })
        .filter(r => r.name !== cur && !r.name.endsWith('/HEAD') && r.name !== 'origin'),
    };
  },

  'POST /api/merge': async (_, b) => {
    const { path: repo } = await repoOf(b.repo);
    const ref = String(b.branch || '');
    if (!ref || ref.startsWith('-')) throw httpErr(400, 'rama inválida');
    await shellPathReady;
    // exit 1 = quedaron conflictos (no es error de la app: se resuelven en la UI)
    const out = await git(repo, ['merge', '--no-edit', ref], { okCodes: [0, 1], timeout: 180000 });
    const op = await repoOperation(repo);
    const conflicts = (await git(repo, ['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean);
    return { ok: true, out, conflicts, inProgress: !!op };
  },

  'POST /api/op-abort': async (_, b) => {
    const { path: repo } = await repoOf(b.repo);
    const op = await repoOperation(repo);
    if (!op) throw httpErr(400, 'no hay merge/rebase en curso');
    await git(repo, OP_ABORT[op.type]);
    return { ok: true, type: op.type };
  },

  'GET /api/conflict': async q => {
    const { path: repo } = await repoOf(q.repo);
    const abs = repoFile(repo, q.path);
    const buf = await fsp.readFile(abs).catch(() => null);
    if (!buf) return { missing: true, blocks: [], text: '' }; // borrado en uno de los lados
    if (buf.includes(0)) return { binary: true, blocks: [], text: '' };
    const text = buf.toString('utf8');
    const { blocks } = parseConflicts(text);
    return { text, blocks: blocks.length };
  },

  // Resolver: con contenido final (resolutor por bloques) o tomando un lado entero.
  'POST /api/resolve': async (_, b) => {
    const { path: repo } = await repoOf(b.repo);
    const abs = repoFile(repo, b.path);
    if (!(await isConflicted(repo, b.path))) throw httpErr(400, 'el archivo ya no está en conflicto');
    if (b.side === 'ours' || b.side === 'theirs') {
      await git(repo, ['checkout', `--${b.side}`, '--', b.path]).catch(async e => {
        // si ese lado borró el archivo, resolver = borrarlo
        if (/does not have (our|their) version/.test(e.message)) return git(repo, ['rm', '-q', '--', b.path]);
        throw e;
      });
    } else if (typeof b.content === 'string') {
      if (/^(<<<<<<<|>>>>>>>)/m.test(b.content)) throw httpErr(400, 'todavía quedan marcadores de conflicto');
      await fsp.writeFile(abs, b.content);
    } else throw httpErr(400, 'falta content o side');
    if (fs.existsSync(abs)) await git(repo, ['add', '--', b.path]);
    return { ok: true };
  },

  // Propuesta de Claude para un bloque de conflicto.
  'POST /api/conflict-suggest': async (_, b) => {
    const entry = await repoOf(b.repo);
    const repo = entry.path;
    const text = await fsp.readFile(repoFile(repo, b.path), 'utf8');
    const { lines, blocks } = parseConflicts(text);
    const blk = blocks[+b.index];
    if (!blk) throw httpErr(400, 'bloque inexistente');
    const before = lines.slice(Math.max(0, blk.start - 40), blk.start).join('\n');
    const after = lines.slice(blk.end + 1, blk.end + 41).join('\n');
    const input = [
      `Archivo: ${b.path}`,
      `\n--- contexto antes ---\n${before}`,
      `\n--- MÍA (${blk.oursLabel}) ---\n${blk.ours.join('\n')}`,
      blk.base ? `\n--- BASE COMÚN ---\n${blk.base.join('\n')}` : '',
      `\n--- DE ELLOS (${blk.theirsLabel}) ---\n${blk.theirs.join('\n')}`,
      `\n--- contexto después ---\n${after}`,
    ].join('\n');
    let out = await runClaude(repo, CONFLICT_PROMPT, input, { env: claudeCtx(entry).env });
    out = out.replace(/^```[\w-]*\s*\n/, '').replace(/\n```\s*$/, '');
    return { text: out };
  },

  'POST /api/review-cancel': async (_, b) => {
    const { path: repo } = await repoOf(b.repo);
    const child = runningReviews.get(repo);
    if (!child) return { ok: false };
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
    return { ok: true };
  },

  // Abre un archivo del repo en VS Code en la línea indicada.
  'POST /api/open-file': async (_, b) => {
    const { path: repo } = await repoOf(b.repo);
    const abs = path.resolve(repo, String(b.file || ''));
    if (!abs.startsWith(repo + path.sep)) throw httpErr(400, 'archivo fuera del repo');
    const line = Number.isInteger(+b.line) && +b.line > 0 ? +b.line : 1;
    const ed = editorCmd();
    return /^(code|codium|cursor|windsurf)$/.test(path.basename(ed)) ? launch(ed, ['-g', `${abs}:${line}`], repo) : launch(ed, [abs], repo);
  },

  'POST /api/commit-cancel': async (_, b) => {
    const { path: repo } = await repoOf(b.repo);
    const child = runningCommits.get(repo);
    if (!child) return { ok: false };
    // mata el grupo entero: git + hook + lo que el hook lanzó (yarn, docker...)
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
    return { ok: true };
  },

  'POST /api/commit': async (_, b) => {
    const { path: repo } = await repoOf(b.repo);
    const msg = (b.message || '').trim();
    const args = ['commit'];
    if (b.amend) args.push('--amend');
    if (msg) args.push('-m', msg);
    else if (b.amend) args.push('--no-edit');
    else throw httpErr(400, 'falta mensaje');
    const out = await git(repo, args, { timeout: 180000 });
    return { ok: true, out };
  },

  'POST /api/net': async (_, b) => {
    const { path: repo } = await repoOf(b.repo);
    const out = await netOp(repo, b.op);
    return { ok: true, out };
  },

  'POST /api/fetch-all': async () => {
    const cfg = loadConfig();
    const { repos } = await refreshKnown(cfg);
    const hidden = new Set(cfg.hidden);
    // Los worktrees comparten .git con su repo base: un solo fetch por git-common-dir (evita "cannot lock ref").
    const seen = new Set();
    const targets = [];
    for (const r of repos.filter(r => !hidden.has(r.path))) {
      const common = (await git(r.path, ['rev-parse', '--path-format=absolute', '--git-common-dir']).catch(() => r.path)).trim();
      if (seen.has(common)) continue;
      seen.add(common);
      targets.push(r);
    }
    const results = await pool(targets, 4, async r => {
      const hasRemote = (await git(r.path, ['remote'], { okCodes: [0] }).catch(() => '')).trim();
      if (!hasRemote) return null;
      try {
        await netOp(r.path, 'fetch');
        return { repo: r.path, ok: true };
      } catch (e) {
        return { repo: r.path, ok: false, error: e.message };
      }
    });
    return results.filter(Boolean);
  },

  // Cambiar de rama / pararse en un commit / crear rama desde un commit.
  'POST /api/checkout': async (_, b) => {
    const { path: repo } = await repoOf(b.repo);
    const name = n => {
      if (!n || n.startsWith('-')) throw httpErr(400, 'nombre de rama inválido');
      return n;
    };
    const sha = v => {
      if (!/^[0-9a-f]{4,64}$/.test(v || '')) throw httpErr(400, 'sha inválido');
      return v;
    };
    if (b.detach) {
      await git(repo, ['switch', '--detach', sha(b.sha)]);
    } else if (b.newBranch) {
      await git(repo, ['check-ref-format', '--branch', name(b.newBranch)]).catch(() => {
        throw httpErr(400, `nombre de rama inválido: ${b.newBranch}`);
      });
      await git(repo, ['switch', '-c', b.newBranch, sha(b.sha)]);
    } else if (b.remote) {
      // origin/feature/x → rama local feature/x siguiendo a la remota (o la local si ya existe)
      const remote = name(b.remote);
      const local = remote.split('/').slice(1).join('/');
      const exists = (await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${local}`], { okCodes: [0, 1] })).trim();
      if (exists) await git(repo, ['switch', local]);
      else await git(repo, ['switch', '-c', local, '--track', remote]);
    } else {
      await git(repo, ['switch', name(b.branch)]);
    }
    return { ok: true };
  },

  'POST /api/fix-remote': async (_, b) => {
    const entry = await repoOf(b.repo);
    const s = await summarize(entry, await context(loadConfig()));
    if (!s.fixUrl) throw httpErr(400, 'no hay arreglo automático para este remote');
    await git(entry.path, ['remote', 'set-url', s.remoteName, s.fixUrl]);
    return { ok: true, from: s.remoteUrl, to: s.fixUrl };
  },

  'POST /api/gen-commit': async (_, b) => {
    const entry = await repoOf(b.repo);
    return genCommit(entry.path, claudeCtx(entry).env);
  },

  'POST /api/gen-pr': async (_, b) => {
    const entry = await repoOf(b.repo);
    return genPr(entry.path, b.base, claudeCtx(entry).env);
  },

  'POST /api/open': async (_, b) => {
    const entry = await repoOf(b.repo);
    const repo = entry.path;
    if (b.app === 'code') return launch(editorCmd(), [repo], repo);
    if (b.app === 'folder') return launch(OPENER, [repo], repo);
    if (b.app === 'terminal') return openTerminal(repo);
    if (b.app === 'lazygit') {
      if (!findBin('lazygit')) throw httpErr(400, 'lazygit no está instalado');
      return openTerminal(repo, 'lazygit');
    }
    if (b.app === 'claude') {
      const claude = findBin('claude');
      if (!claude) throw httpErr(400, 'no encontré el CLI de claude');
      return openTerminal(repo, claude, claudeCtx(entry).env);
    }
    throw httpErr(400, 'app desconocida');
  },

  // ---------- workspaces (carpetas raíz) y ajustes ----------

  'GET /api/config': async () => {
    const cfg = loadConfig();
    return {
      configPath: tilde(CONFIG_PATH),
      roots: cfg.roots,
      settings: { terminal: cfg.terminal, editor: cfg.editor, reviewModel: cfg.reviewModel, commitModel: cfg.commitModel, scanDepth: cfg.scanDepth },
      sshHosts: parseSshConfig().map(h => h.host).filter(h => !/[*?]/.test(h)),
      detectedTerminal: process.platform === 'darwin' ? 'Terminal.app' : pickTerminal(),
      colors: COLORS,
    };
  },

  // Alta o edición de un workspace. `original` = nombre anterior al editar.
  'POST /api/workspace': async (_, b) => {
    const cfg = loadConfig();
    const name = String(b.name || '').trim();
    if (!/^[\w.-]{1,40}$/.test(name)) throw httpErr(400, 'nombre inválido: letras, números, punto, guion o guion bajo');
    const dirAbs = path.resolve(expand(String(b.dir || '').trim()));
    let st;
    try {
      st = await fsp.stat(dirAbs);
    } catch {
      throw httpErr(400, `no existe la carpeta ${tilde(dirAbs)}`);
    }
    if (!st.isDirectory()) throw httpErr(400, `${tilde(dirAbs)} no es una carpeta`);
    const original = b.original ? String(b.original) : null;
    const idx = original ? cfg.roots.findIndex(r => r.name === original) : -1;
    if (original && idx < 0) throw httpErr(404, `no existe el workspace ${original}`);
    if (cfg.roots.some((r, i) => r.name === name && i !== idx)) throw httpErr(400, `ya hay un workspace llamado ${name}`);
    if (cfg.roots.some((r, i) => path.resolve(expand(r.dir)) === dirAbs && i !== idx)) throw httpErr(400, 'esa carpeta ya es un workspace');
    const opt = k => {
      const v = String(b[k] || '').trim();
      return v ? tilde(path.isAbsolute(expand(v)) ? path.resolve(expand(v)) : v) : undefined;
    };
    const root = {
      name,
      dir: tilde(dirAbs),
      color: COLORS.includes(b.color) ? b.color : idx >= 0 ? cfg.roots[idx].color : COLORS[cfg.roots.length % COLORS.length],
      sshHost: String(b.sshHost || '').trim() || undefined,
      gitconfig: opt('gitconfig'),
      claudeConfigDir: opt('claudeConfigDir'),
      vault: opt('vault'),
      ghConfigDir: opt('ghConfigDir'),
    };
    for (const k of Object.keys(root)) if (root[k] === undefined) delete root[k];
    if (idx >= 0) {
      cfg.roots[idx] = root;
      if (original !== name) for (const x of cfg.extra) if (x.identity === original) x.identity = name;
    } else {
      cfg.roots.push(root);
    }
    saveConfig(cfg);
    await refreshKnown(cfg);
    return { ok: true, root };
  },

  'POST /api/workspace-remove': async (_, b) => {
    const cfg = loadConfig();
    if (!cfg.roots.some(r => r.name === b.name)) throw httpErr(404, 'workspace desconocido');
    cfg.roots = cfg.roots.filter(r => r.name !== b.name);
    cfg.extra = cfg.extra.filter(x => x.identity !== b.name);
    saveConfig(cfg);
    await refreshKnown(cfg);
    return { ok: true };
  },

  'POST /api/settings': async (_, b) => {
    const cfg = loadConfig();
    for (const k of ['terminal', 'editor', 'reviewModel', 'commitModel']) if (typeof b[k] === 'string') cfg[k] = b[k].trim();
    if (b.scanDepth != null) cfg.scanDepth = Math.min(Math.max(parseInt(b.scanDepth, 10) || 3, 1), 6);
    saveConfig(cfg);
    return { ok: true };
  },

  'POST /api/hide': async (_, b) => {
    await repoOf(b.repo);
    const cfg = loadConfig();
    cfg.hidden = cfg.hidden.filter(p => p !== b.repo);
    if (b.hidden) cfg.hidden.push(b.repo);
    saveConfig(cfg);
    return { ok: true };
  },

  'POST /api/extra': async (_, b) => {
    const cfg = loadConfig();
    const p = path.resolve(expand((b.path || '').trim()));
    if (b.remove) {
      cfg.extra = cfg.extra.filter(x => expand(x.path) !== p);
    } else {
      if (!(await isRepo(p))) throw httpErr(400, `${p} no es un repo git`);
      if (!cfg.roots.some(r => r.name === b.identity)) throw httpErr(400, 'identidad inválida');
      cfg.extra = cfg.extra.filter(x => expand(x.path) !== p);
      cfg.extra.push({ path: tilde(p), identity: b.identity });
    }
    saveConfig(cfg);
    await refreshKnown(cfg);
    return { ok: true };
  },

  'POST /api/init': async (_, b) => {
    if (!knownNonGit.has(b.dir)) await refreshKnown();
    if (!knownNonGit.has(b.dir)) throw httpErr(404, 'carpeta desconocida');
    await git(b.dir, ['init']);
    await refreshKnown();
    return { ok: true };
  },
};

// ---------- commit en vivo ----------

const runningCommits = new Map(); // repo -> proceso git commit

// Corre git commit sin timeout y va mandando la salida (hooks incluidos) a medida que sale.
// Al final escribe \0 + JSON { code, signal }.
async function commitStream(res, b) {
  const { path: repo } = await repoOf(b.repo);
  if (runningCommits.has(repo)) throw httpErr(409, 'ya hay un commit corriendo en este repo');
  const msg = (b.message || '').trim();
  let args = ['commit'];
  if (b.continueOp) {
    const op = await repoOperation(repo);
    if (!op) throw httpErr(400, 'no hay merge/rebase en curso');
    args = OP_CONTINUE[op.type];
    if (op.type === 'merge' && msg) args = ['commit', '-m', msg];
  } else {
    if (b.amend) args.push('--amend');
    if (msg) args.push('-m', msg);
    else if (b.amend) args.push('--no-edit');
    else throw httpErr(400, 'falta mensaje');
  }
  await shellPathReady;

  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.write(`$ git ${args.map(a => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}\n`);
  const child = spawn('git', args, {
    cwd: repo,
    env: { ...GIT_ENV, GIT_EDITOR: 'true', FORCE_COLOR: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true, // grupo propio para poder cancelar hook + hijos
  });
  runningCommits.set(repo, child);
  child.stdout.on('data', d => res.write(d));
  child.stderr.on('data', d => res.write(d));
  const finish = result => {
    runningCommits.delete(repo);
    res.end(`\n\0${JSON.stringify(result)}`);
  };
  child.on('error', e => finish({ code: -1, error: e.message }));
  child.on('close', (code, signal) => finish({ code, signal }));
}

// ---------- http ----------

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > 20 * 1024 * 1024) reject(httpErr(413, 'body muy grande'));
      else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(httpErr(400, 'JSON inválido'));
      }
    });
    req.on('error', reject);
  });
}

async function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, { error: 'no' });
  try {
    const data = await fsp.readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch {
    send(res, 404, { error: 'no existe' });
  }
}

const PORT = +(process.env.PORT || loadConfig().port || 7777);

const server = http.createServer(async (req, res) => {
  try {
    // Solo localhost (evita DNS rebinding). POST exige header propio (evita CSRF desde otras páginas).
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '')) return send(res, 403, { error: 'host no permitido' });
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res);
    if (req.method === 'POST' && req.headers['x-gitpanel'] !== '1') return send(res, 403, { error: 'falta header X-Gitpanel' });
    if (req.method === 'POST' && url.pathname === '/api/commit-stream') return await commitStream(res, await readJson(req));
    if (req.method === 'POST' && url.pathname === '/api/review-stream') return await reviewStream(res, await readJson(req));
    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) return send(res, 404, { error: 'ruta inexistente' });
    const body = req.method === 'POST' ? await readJson(req) : {};
    send(res, 200, await route(Object.fromEntries(url.searchParams), body));
  } catch (e) {
    send(res, e.status || 500, { error: e.message });
  }
});

// Escucha en 127.0.0.1 y resuelve con el puerto real (port 0 = uno libre).
async function start(port = PORT) {
  await shellPathReady;
  return new Promise((resolve, reject) => {
    const onError = e => {
      server.off('listening', onListening);
      reject(e);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server.address().port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

module.exports = { start };

// `node server.js` sigue funcionando como modo web.
if (require.main === module) {
  start().then(port => console.log(`gitpicho en http://localhost:${port}`));
}
