#!/usr/bin/env bash
# Opcional (Ubuntu 23.10+): perfil AppArmor para que el Electron de gitpicho use su sandbox
# en vez de arrancar con --no-sandbox. Genera el perfil con la ruta real de esta instalación.
set -euo pipefail
DIR="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
PROFILE=/etc/apparmor.d/gitpicho

cat <<APP | sudo tee "$PROFILE" >/dev/null
# Generado por gitpicho/scripts/install-apparmor.sh
abi <abi/4.0>,
include <tunables/global>

profile gitpicho $DIR/node_modules/{,.pnpm/electron@*/node_modules/}electron/dist/electron flags=(unconfined) {
  userns,
  include if exists <local/gitpicho>
}
APP

sudo apparmor_parser -r "$PROFILE"
echo "Perfil instalado en $PROFILE"
