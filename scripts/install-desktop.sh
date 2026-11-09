#!/usr/bin/env bash
# Linux: deja el comando `gitpicho` en ~/.local/bin y un acceso directo en el menú de aplicaciones.
set -euo pipefail
DIR="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
BIN="${XDG_BIN_HOME:-$HOME/.local/bin}"
APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"

mkdir -p "$BIN" "$APPS"
ln -sf "$DIR/gitpicho" "$BIN/gitpicho"
cat >"$APPS/gitpicho.desktop" <<DESK
[Desktop Entry]
Type=Application
Name=gitpicho
Comment=Todos tus repos git en una ventana
Exec=$DIR/gitpicho
Icon=$DIR/icon.png
Terminal=false
Categories=Development;RevisionControl;
StartupWMClass=gitpicho
DESK

echo "Listo: comando $BIN/gitpicho y acceso directo en el menú."
case ":$PATH:" in *":$BIN:"*) ;; *) echo "Ojo: $BIN no está en tu PATH." ;; esac
