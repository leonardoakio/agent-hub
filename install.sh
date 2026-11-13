#!/usr/bin/env bash
set -euo pipefail

REPO=$(cd "$(dirname "$0")" && pwd)
BIN_DIR="$HOME/.local/bin"
LINK="$BIN_DIR/hub"
CONFIG="${HUB_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/hub/config}"

if [[ -t 1 && -z ${NO_COLOR:-} ]]; then
  BLUE=$'\e[38;5;39m' TEAL=$'\e[38;5;44m' GREEN=$'\e[38;5;48m' MINT=$'\e[38;5;121m'
  GRAY=$'\e[38;5;245m' WHITE=$'\e[97m' YEL=$'\e[38;5;221m' RED=$'\e[38;5;203m' B=$'\e[1m' N=$'\e[0m'
  GRAD=(39 38 44 43 49 48 84)
else
  BLUE="" TEAL="" GREEN="" MINT="" GRAY="" WHITE="" YEL="" RED="" B="" N="" GRAD=()
fi
ANIMATE=0
[[ -t 1 && -z ${HUB_FAST:-} ]] && ANIMATE=1

# readlink -f não existe no macOS antes do 12.3
link_target() {
  local p=$1 dir
  while [[ -L $p ]]; do
    dir=$(cd -P "$(dirname "$p")" && pwd)
    p=$(readlink "$p")
    [[ $p == /* ]] || p="$dir/$p"
  done
  printf '%s/%s' "$(cd -P "$(dirname "$p")" && pwd)" "$(basename "$p")"
}

short() { printf '%s' "${1/#$HOME/\~}"; }

nap() { ((ANIMATE)) && sleep "$1"; return 0; }

gradient() {
  local text=$1 i out=""
  if [[ ${#GRAD[@]} -eq 0 ]]; then printf '%s' "$text"; return; fi
  for ((i = 0; i < ${#text}; i++)); do out+=$'\e[38;5;'"${GRAD[i * ${#GRAD[@]} / ${#text}]}m${text:i:1}"; done
  printf '%s%s%s' "$B" "$out" "$N"
}

spin() {
  local msg=$1 frames='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏' i
  ((ANIMATE)) || return 0
  tput civis 2>/dev/null || true
  for ((i = 0; i < 9; i++)); do
    printf '\r  %s%s%s %s' "$TEAL" "${frames:i % 10:1}" "$N" "$msg"
    sleep 0.07
  done
  printf '\r\e[K'
  tput cnorm 2>/dev/null || true
}

ok() { printf '  %s✓%s %s %s\n' "$GREEN" "$N" "$1" "${GRAY}${2:-}${N}"; }
warn() { printf '  %s!%s %s %s\n' "$YEL" "$N" "$1" "${GRAY}${2:-}${N}"; }
fail() { printf '  %s✗%s %s %s\n' "$RED" "$N" "$1" "${GRAY}${2:-}${N}"; }
section() { nap 0.15; printf '\n  %s%s%s\n' "$B" "$1" "$N"; }

mascot() {
  local lines=(
    "        ${MINT}●${N}"
    "    ${TEAL}╭───┴───╮${N}   $(gradient 'Agent Hub')"
    "    ${TEAL}│${N} ${WHITE}${B}$1${N} ${TEAL}│${N}   $2"
    "    ${TEAL}╰─┬───┬─╯${N}   $3"
    "      ${BLUE}╵   ╵${N}"
  )
  local l
  for l in "${lines[@]}"; do printf '%s\n' "$l"; nap 0.06; done
}

[[ -t 1 ]] && trap 'tput cnorm 2>/dev/null || true' EXIT

if [[ ${1:-} == --uninstall ]]; then
  echo
  mascot "• ~ •" "Removendo o comando hub…" "${GRAY}suas contas e logins não são apagados${N}"
  echo
  spin "removendo $(short "$LINK")"
  if [[ -L $LINK && $(link_target "$LINK") == "$(cd -P "$REPO" && pwd)/bin/hub" ]]; then rm "$LINK"; ok "comando removido" "$(short "$LINK")"
  elif [[ -e $LINK || -L $LINK ]]; then warn "não removi" "$(short "$LINK") aponta para outro lugar, não para este repositório"
  else warn "nada para remover" "$(short "$LINK") não existe"; fi
  printf '\n  %s(^ ◡ ^)/%s  até mais! %spara apagar também as contas: rm -r %s%s\n\n' "$TEAL" "$N" "$GRAY" "$(short "$(dirname "$CONFIG")")" "$N"
  exit 0
fi

echo
mascot "^ ◡ ^" "Oi, eu sou o ${B}Hubi${N}! Vou instalar o hub para você." "${GRAY}leva só alguns segundos${N}"
nap 0.4

# Sistema detectado antes de qualquer passo: caminhos, PATH e instalação seguem daqui.
detect_system() {
  local arch distro
  arch=$(uname -m)
  case $(uname -s) in
    Darwin) SYS_KIND=macos; SYS_NAME="macOS $(sw_vers -productVersion 2>/dev/null)" ;;
    MINGW* | MSYS* | CYGWIN*) SYS_KIND=windows; SYS_NAME="Windows (Git Bash)" ;;
    Linux)
      distro=$(sed -n 's/^PRETTY_NAME="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' /etc/os-release 2>/dev/null)
      SYS_NAME=${distro:-Linux}
      if [[ -n ${WSL_DISTRO_NAME:-} ]] || grep -qi microsoft /proc/version 2>/dev/null; then SYS_KIND=wsl; SYS_NAME="$SYS_NAME no WSL"; else SYS_KIND=linux; fi
      ;;
    *) SYS_KIND=other; SYS_NAME=$(uname -s) ;;
  esac
  SYS_NAME="$SYS_NAME · $arch"
}
detect_system

section "1. Verificando o ambiente"
spin "sistema operacional"
case $SYS_KIND in
  windows)
    warn "$SYS_NAME" "no Windows, rode no PowerShell: .\\install.ps1"
    exit 1
    ;;
  other) warn "$SYS_NAME" "sistema não testado: o hub foi feito para Linux, macOS e Windows" ;;
  *) ok "$SYS_NAME" "o hub vai instalar e gravar tudo no padrão deste sistema" ;;
esac
spin "Node.js"
if command -v node >/dev/null; then
  node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  if [[ $node_major -ge 18 ]]; then ok "node" "$(node --version): o hub e a interface (/ui)"
  else fail "node $(node --version)" "o hub precisa do Node.js 18 ou mais novo: https://nodejs.org"; exit 1; fi
else
  fail "node não encontrado" "o hub precisa do Node.js 18 ou mais novo: https://nodejs.org"
  exit 1
fi
spin "npm"
if command -v npm >/dev/null; then ok "npm" "$(npm --version): instala e atualiza as CLIs"; else warn "npm não encontrado" "necessário para /install e /update"; fi
spin "git"
if command -v git >/dev/null; then ok "git" "$(git --version | cut -d' ' -f3): atualizações do hub"; else warn "git não encontrado" "sem ele o hub não se atualiza sozinho"; fi
spin "AWS CLI"
if command -v aws >/dev/null; then ok "aws" "$(aws --version 2>&1 | cut -d' ' -f1): contas Bedrock"; else printf '  %s○%s aws %s\n' "$GRAY" "$N" "${GRAY}opcional: só para contas Bedrock${N}"; fi

section "2. Instalando o comando hub"
spin "criando o link em $(short "$BIN_DIR")"
chmod +x "$REPO/bin/hub" "$REPO/bin/hub.js"
mkdir -p "$BIN_DIR"
previous=""
[[ -L $LINK ]] && previous=$(readlink "$LINK")
if [[ -e $LINK && ! -L $LINK ]]; then
  warn "já existe um arquivo em $(short "$LINK")" "não é deste repositório"
  reply=n
  [[ -t 0 ]] && { read -rp "    Substituir pelo hub? [s/N] " reply || reply=n; }
  if [[ $reply != [sSyY]* ]]; then
    fail "instalação cancelada" "remova ou renomeie $(short "$LINK") e rode de novo"
    exit 1
  fi
fi
ln -sfn "$REPO/bin/hub" "$LINK"
if [[ -n $previous && $previous != "$REPO/bin/hub" ]]; then
  ok "hub atualizado" "$(short "$LINK") → $(short "$REPO/bin/hub") (antes: $(short "$previous"))"
elif [[ -n $previous ]]; then
  ok "hub já estava instalado" "$(short "$LINK") → $(short "$REPO/bin/hub")"
else
  ok "hub instalado" "$(short "$LINK") → $(short "$REPO/bin/hub")"
fi
printf '    %salterações neste repositório valem na hora, sem reinstalar%s\n' "$GRAY" "$N"

section "3. Conferindo o PATH"
spin "procurando $(short "$BIN_DIR") no PATH"
need_reload=0
not_in_path=0
case ":$PATH:" in
  *":$BIN_DIR:"*) ok "$(short "$BIN_DIR") já está no PATH" ;;
  *)
    case ${SHELL##*/} in
      zsh) rc="$HOME/.zshrc" ;;
      *) [[ $(uname) == Darwin ]] && rc="$HOME/.bash_profile" || rc="$HOME/.bashrc" ;;
    esac
    line='export PATH="$HOME/.local/bin:$PATH"'
    if [[ ${SHELL##*/} == fish ]]; then
      warn "$(short "$BIN_DIR") não está no PATH" "no fish, rode: fish_add_path ~/.local/bin"
      not_in_path=1
    elif [[ -f $rc ]] && grep -qE '(\$HOME|~)/\.local/bin' "$rc"; then
      ok "PATH já configurado em ${rc/#$HOME/\~}"
      need_reload=1
    elif [[ -t 0 ]]; then
      warn "$(short "$BIN_DIR") não está no PATH"
      read -rp "    Adicionar ao ${rc/#$HOME/\~}? [S/n] " reply || reply=n
      if [[ -z $reply || $reply == [sSyY]* ]]; then
        printf '\n# agent-hub\n%s\n' "$line" >>"$rc"
        ok "adicionado em ${rc/#$HOME/\~}"
        need_reload=1
      else
        warn "pulado" "adicione manualmente: $line"
        not_in_path=1
      fi
    else
      warn "$(short "$BIN_DIR") não está no PATH" "adicione ao seu shell: $line"
      not_in_path=1
    fi
    ;;
esac

section "4. Suas contas"
spin "lendo a configuração"
if [[ -f $CONFIG ]]; then
  count=$(grep -c '^\[' "$CONFIG" || true)
  ok "$count conta(s) cadastrada(s)" "${CONFIG/#$HOME/\~}"
else
  printf '  %s○%s nenhuma conta ainda %s\n' "$GRAY" "$N" "${GRAY}· você cadastra pelo /ui${N}"
fi

nap 0.3
echo
mascot "◕ ◡ ◕" "${GREEN}${B}Pronto!${N} O hub está instalado." "${GRAY}próximos passos:${N}"
echo
step=1
if ((need_reload)); then
  printf '  %s%d%s  %ssource %s%s  %s(ou abra um terminal novo)%s\n' "$TEAL" $((step++)) "$N" "$B" "${rc/#$HOME/\~}" "$N" "$GRAY" "$N"
elif ((not_in_path)); then
  printf '  %s%d%s  %sexport PATH="$HOME/.local/bin:$PATH"%s  %s(sem isso o comando hub não é encontrado)%s\n' "$TEAL" $((step++)) "$N" "$B" "$N" "$GRAY" "$N"
fi
printf '  %s%d%s  %shub%s       %sabre o menu%s\n' "$TEAL" $((step++)) "$N" "$B" "$N" "$GRAY" "$N"
printf '  %s%d%s  %s/ui%s       %scadastra suas contas e credenciais%s\n' "$TEAL" $((step++)) "$N" "$B" "$N" "$GRAY" "$N"
printf '  %s%d%s  %s/install%s  %sinstala as CLIs das contas (sempre a versão mais recente)%s\n' "$TEAL" $((step++)) "$N" "$B" "$N" "$GRAY" "$N"
printf '\n  %s# para remover depois: ./install.sh --uninstall%s\n\n' "$GRAY" "$N"
