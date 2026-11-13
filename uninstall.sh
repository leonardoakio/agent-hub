#!/usr/bin/env bash
# Remove o comando hub. Com --all, apaga também as contas e dados do hub e a linha de PATH do instalador.
# A lógica fica no install.sh, que já detecta o sistema; este arquivo só dá um nome óbvio ao comando.
set -euo pipefail
case ${1:-} in
  --all) exec "$(dirname "$0")/install.sh" --purge ;;
  "") exec "$(dirname "$0")/install.sh" --uninstall ;;
  *) printf 'uso: ./uninstall.sh [--all]\n' >&2; exit 2 ;;
esac
