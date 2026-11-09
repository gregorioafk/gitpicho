#!/usr/bin/env bash
# Crea un HOME de demo con repos falsos (cambios, commits sin pushear, merge con conflicto,
# remotes con la cuenta equivocada) para probar gitpicho sin tocar tus repos reales.
#
#   scripts/demo.sh /tmp/gitpicho-demo
#   HOME=/tmp/gitpicho-demo/home node server.js      # → http://localhost:7777
set -euo pipefail
ROOT="$(mkdir -p "${1:?uso: scripts/demo.sh <carpeta>}" && cd "$1" && pwd -P)"
H="$ROOT/home"
REMOTES="$ROOT/remotes"
rm -rf "$H" "$REMOTES"
mkdir -p "$H/.ssh" "$H/.config/gitpicho" "$H/code/trabajo" "$H/code/personal" "$REMOTES"

# --- identidades falsas -----------------------------------------------------
cat >"$H/.ssh/config" <<SSH
Host github-trabajo
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_ed25519_trabajo

Host github-personal
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_ed25519_personal
SSH
touch "$H/.ssh/id_ed25519_trabajo" "$H/.ssh/id_ed25519_personal" # vacías: solo para que existan
printf '[user]\n  name = Ana Dev\n  email = ana@acme.example\n' >"$H/.gitconfig-trabajo"
printf '[user]\n  name = Ana Dev\n  email = ana@ejemplo.dev\n' >"$H/.gitconfig-personal"
cat >"$H/.gitconfig" <<GC
[init]
  defaultBranch = main
[includeIf "gitdir:~/code/trabajo/"]
  path = ~/.gitconfig-trabajo
[includeIf "gitdir:~/code/personal/"]
  path = ~/.gitconfig-personal
GC

cat >"$H/.config/gitpicho/config.json" <<JSON
{
  "scanDepth": 3,
  "roots": [
    { "name": "trabajo", "dir": "~/code/trabajo", "color": "blue", "sshHost": "github-trabajo", "gitconfig": "~/.gitconfig-trabajo" },
    { "name": "personal", "dir": "~/code/personal", "color": "mauve", "sshHost": "github-personal", "gitconfig": "~/.gitconfig-personal" }
  ],
  "hidden": [],
  "extra": []
}
JSON

export HOME="$H" GIT_CONFIG_NOSYSTEM=1
T=$(( $(date +%s) - 86400 * 20 ))
commit() { # commit <repo> <mensaje> [horas atrás]
  local when=$(( $(date +%s) - ${3:-0} * 3600 ))
  GIT_AUTHOR_DATE="@$when" GIT_COMMITTER_DATE="@$when" git -C "$1" commit -q -m "$2"
}
file() { mkdir -p "$(dirname "$1")"; printf '%s\n' "${@:2}" >"$1"; }

# repo con remote "real" (bare local) y después la URL del alias → ahead/behind funcionan sin red
repo() { # repo <workspace> <nombre> <url-remote>
  local dir="$H/code/$1/$2" bare="$REMOTES/$2.git"
  git init -q "$dir"
  git init -q --bare "$bare"
  git -C "$dir" remote add origin "$bare"
  echo "$dir"
}
publish() { git -C "$1" push -q -u origin HEAD 2>/dev/null; git -C "$1" remote set-url origin "$2"; }

# trabajo/api-pagos: cambios staged y sin stage
d=$(repo trabajo api-pagos)
file "$d/src/pagos.js" "export function cobrar(monto) {" "  return { ok: true, monto };" "}"
file "$d/README.md" "# api-pagos" "API de cobros."
git -C "$d" add -A && commit "$d" "feat: endpoint de cobro" 72
file "$d/src/pagos.js" "export function cobrar(monto, moneda = 'USD') {" "  if (monto <= 0) throw new Error('monto inválido');" "  return { ok: true, monto, moneda };" "}"
git -C "$d" add -A && commit "$d" "feat: validar monto y moneda" 30
publish "$d" "git@github-trabajo:acme/api-pagos.git"
file "$d/src/pagos.js" "export function cobrar(monto, moneda = 'USD', cuotas = 1) {" "  if (monto <= 0) throw new Error('monto inválido');" "  if (cuotas < 1 || cuotas > 12) throw new Error('cuotas fuera de rango');" "  return { ok: true, monto, moneda, cuotas };" "}"
git -C "$d" add src/pagos.js
file "$d/src/reembolsos.js" "export function reembolsar(id) {" "  // TODO: llamar al proveedor" "  return { ok: true, id };" "}"
file "$d/README.md" "# api-pagos" "API de cobros y reembolsos." "" "## Correr" "npm start"

# trabajo/web-tienda: 2 commits sin pushear
d=$(repo trabajo web-tienda)
file "$d/index.html" "<h1>Tienda</h1>"
git -C "$d" add -A && commit "$d" "chore: proyecto inicial" 200
publish "$d" "git@github-trabajo:acme/web-tienda.git"
file "$d/index.html" "<h1>Tienda</h1>" "<nav>Productos · Carrito</nav>"
git -C "$d" add -A && commit "$d" "feat: navegación principal" 5
file "$d/carrito.js" "export const carrito = [];"
git -C "$d" add -A && commit "$d" "feat: carrito en memoria" 2
git -C "$d" switch -q -c feature/checkout
file "$d/checkout.js" "export function pagar() {}"
git -C "$d" add -A && commit "$d" "wip: checkout" 1
git -C "$d" switch -q main

# trabajo/app-mobile: merge con conflicto en curso
d=$(repo trabajo app-mobile)
file "$d/config.js" "export const API = 'https://api.acme.example';" "export const TIMEOUT = 5000;"
git -C "$d" add -A && commit "$d" "chore: config base" 100
publish "$d" "git@github-trabajo:acme/app-mobile.git"
git -C "$d" switch -q -c feature/offline
file "$d/config.js" "export const API = 'https://api.acme.example';" "export const TIMEOUT = 15000;" "export const OFFLINE = true;"
git -C "$d" commit -qam "feat: modo offline" && git -C "$d" switch -q main
file "$d/config.js" "export const API = 'https://api.acme.example/v2';" "export const TIMEOUT = 8000;"
git -C "$d" commit -qam "fix: apuntar a la API v2"
git -C "$d" merge feature/offline >/dev/null 2>&1 || true

# trabajo/infra: remote por HTTPS (no usa la clave SSH del workspace)
d=$(repo trabajo infra)
file "$d/main.tf" 'provider "aws" {}'
git -C "$d" add -A && commit "$d" "chore: terraform base" 400
publish "$d" "https://github.com/acme/infra.git"

# personal/blog: usa el alias de la cuenta de trabajo + email equivocado
d=$(repo personal blog)
file "$d/posts/hola.md" "# Hola mundo"
git -C "$d" add -A && commit "$d" "post: hola mundo" 300
publish "$d" "git@github-trabajo:ana/blog.git"
git -C "$d" config user.email ana@acme.example

# personal/dotfiles: limpio, 3 commits por bajar
d=$(repo personal dotfiles)
file "$d/.zshrc" "export EDITOR=vim"
git -C "$d" add -A && commit "$d" "zsh: base" 500
publish "$d" "git@github-personal:ana/dotfiles.git"
tmp="$ROOT/tmp-clone"; rm -rf "$tmp"; git clone -q "$REMOTES/dotfiles.git" "$tmp"
for m in "zsh: alias de git" "nvim: lsp" "tmux: tema"; do
  echo "# $m" >>"$tmp/.zshrc"; git -C "$tmp" -c user.name="Ana Dev" -c user.email=ana@ejemplo.dev commit -qam "$m"
done
git -C "$tmp" push -q
git -C "$d" remote set-url origin "$REMOTES/dotfiles.git"; git -C "$d" fetch -q; git -C "$d" remote set-url origin "git@github-personal:ana/dotfiles.git"
rm -rf "$tmp"

# personal/side-project: sin remote, con historia
d="$H/code/personal/side-project"; git init -q "$d"
for i in 1 2 3 4; do file "$d/notas.md" "versión $i"; git -C "$d" add -A; commit "$d" "idea $i" $(( 48 - i * 10 )); done

# personal/ideas: carpeta sin git
mkdir -p "$H/code/personal/ideas"; echo "pendiente" >"$H/code/personal/ideas/todo.txt"

echo "Demo lista en $H"
echo "Probá:  HOME=$H node $(cd "$(dirname "$0")/.." && pwd)/server.js"
