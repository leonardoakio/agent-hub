# Se o Windows recusar o script: powershell -ExecutionPolicy Bypass -File .\install.ps1
param([switch]$Uninstall, [switch]$Purge)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$Repo = Split-Path -Parent $MyInvocation.MyCommand.Path
$BinDir = Join-Path $env:USERPROFILE '.local\bin'
$Shim = Join-Path $BinDir 'hub.cmd'
$Target = Join-Path $Repo 'bin\hub.cmd'
$Marker = 'rem agent-hub:'
if ($env:HUB_CONFIG) { $Config = $env:HUB_CONFIG }
elseif ($env:XDG_CONFIG_HOME) { $Config = Join-Path $env:XDG_CONFIG_HOME 'hub\config' }
else { $Config = Join-Path $env:USERPROFILE '.config\hub\config' }

function Short([string]$p) {
  if ($p.StartsWith($env:USERPROFILE, [System.StringComparison]::OrdinalIgnoreCase)) { return '~' + $p.Substring($env:USERPROFILE.Length) }
  return $p
}
function Ok([string]$a, [string]$b = '') { Write-Host '  ' -NoNewline; Write-Host ([char]0x2713) -ForegroundColor Green -NoNewline; Write-Host " $a " -NoNewline; Write-Host $b -ForegroundColor DarkGray }
function Warn([string]$a, [string]$b = '') { Write-Host '  ' -NoNewline; Write-Host '!' -ForegroundColor Yellow -NoNewline; Write-Host " $a " -NoNewline; Write-Host $b -ForegroundColor DarkGray }
function Fail([string]$a, [string]$b = '') { Write-Host '  ' -NoNewline; Write-Host ([char]0x2717) -ForegroundColor Red -NoNewline; Write-Host " $a " -NoNewline; Write-Host $b -ForegroundColor DarkGray }
function Section([string]$t) { Write-Host ''; Write-Host "  $t" -ForegroundColor White }
function Mascot([string]$face, [string]$m1, [string]$m2) {
  Write-Host ([string][char]0x25CF).PadLeft(9) -ForegroundColor Green
  Write-Host '    ╭───┴───╮' -ForegroundColor Cyan -NoNewline; Write-Host '   Agent Hub' -ForegroundColor Cyan
  Write-Host '    │' -ForegroundColor Cyan -NoNewline; Write-Host " $face " -ForegroundColor White -NoNewline
  Write-Host '│' -ForegroundColor Cyan -NoNewline; Write-Host "   $m1"
  Write-Host '    ╰─┬───┬─╯' -ForegroundColor Cyan -NoNewline; Write-Host "   $m2" -ForegroundColor DarkGray
  Write-Host '      ╵   ╵' -ForegroundColor Blue
}
function Has([string]$cmd) { return [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function FirstLine([scriptblock]$sb) {
  try { $o = & $sb 2>&1 | Select-Object -First 1; return ([string]$o).Trim() } catch { return '' }
}
function IsOurs([string]$file) {
  if (-not (Test-Path -LiteralPath $file)) { return $false }
  $text = Get-Content -LiteralPath $file -Raw
  return ($text -match [regex]::Escape($Marker)) -and ($text -match [regex]::Escape($Target))
}

function RemoveShim {
  if (IsOurs $Shim) {
    Remove-Item -LiteralPath $Shim -Force
    Ok 'comando removido' (Short $Shim)
  } elseif (Test-Path -LiteralPath $Shim) {
    Warn 'não removi' "$(Short $Shim) aponta para outro lugar, não para este repositório"
  } else {
    Warn 'nada para remover' "$(Short $Shim) não existe"
  }
}
# Tira a pasta do PATH do usuário só se ela ficou vazia (outros programas também usam ~\.local\bin).
function RemovePathEntry {
  if ((Test-Path -LiteralPath $BinDir) -and @(Get-ChildItem -LiteralPath $BinDir -Force).Count -gt 0) { Ok 'PATH mantido' "$(Short $BinDir) tem outros programas"; return }
  if (Test-Path -LiteralPath $BinDir) { Remove-Item -LiteralPath $BinDir -Force }
  $envKey = Get-Item -Path 'HKCU:\Environment'
  $rawUser = [string]$envKey.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
  $norm = { param($p) ([Environment]::ExpandEnvironmentVariables($p)).TrimEnd('\') }
  $parts = @($rawUser -split ';' | Where-Object { $_ -ne '' })
  $keep = @($parts | Where-Object { (& $norm $_) -ine $BinDir.TrimEnd('\') })
  if ($keep.Count -eq $parts.Count) { return }
  $newPath = $keep -join ';'
  if ($rawUser -match '%') { Set-ItemProperty -Path 'HKCU:\Environment' -Name 'Path' -Value $newPath -Type ExpandString }
  else { [Environment]::SetEnvironmentVariable('Path', $newPath, 'User') }
  Ok 'PATH do usuário limpo' "$(Short $BinDir) removido"
}
function Bye([string]$hint) {
  Write-Host ''
  Write-Host '  (^ ◡ ^)/' -ForegroundColor Cyan -NoNewline
  Write-Host '  até mais! ' -NoNewline
  Write-Host $hint -ForegroundColor DarkGray
  Write-Host ''
}

if ($Uninstall) {
  Write-Host ''
  Mascot '• ~ •' 'Removendo o comando hub…' 'suas contas e logins não são apagados'
  Write-Host ''
  RemoveShim
  Bye 'para apagar tudo do hub: .\uninstall.ps1 -All'
  exit 0
}

if ($Purge) {
  $confDir = Split-Path -Parent $Config
  Write-Host ''
  Mascot '• ~ •' 'Apagando tudo do hub…' 'as CLIs, seus logins, skills e instruções continuam'
  Write-Host ''
  Write-Host '  Vai sair:' -ForegroundColor White
  Write-Host "    • comando $(Short $Shim)"
  Write-Host "    • contas e dados do hub em $(Short $confDir)"
  Write-Host "    • $(Short $BinDir) do PATH do usuário, se ficar vazia"
  Write-Host '  Fica: ' -ForegroundColor White -NoNewline
  Write-Host "a pasta deste repositório ($(Short $Repo)); o comando para apagá-la aparece no final."
  Write-Host ''
  $reply = Read-Host '  Continuar? [s/N]'
  if ($reply -notmatch '^[sSyY]') { Fail 'cancelado' 'nada foi apagado'; exit 1 }
  Write-Host ''
  RemoveShim
  if (Test-Path -LiteralPath $confDir) { Remove-Item -LiteralPath $confDir -Recurse -Force; Ok 'contas e dados removidos' (Short $confDir) }
  else { Ok 'sem dados para remover' "$(Short $confDir) não existe" }
  RemovePathEntry
  Bye "para apagar a pasta do projeto: Remove-Item -Recurse -Force '$(Short $Repo)'"
  exit 0
}

Write-Host ''
Mascot '^ ◡ ^' 'Oi, eu sou o Hubi! Vou instalar o hub para você.' 'leva só alguns segundos'

Section '1. Verificando o ambiente'
# Sistema detectado antes de qualquer passo: caminhos, PATH e instalação seguem daqui.
$sysName = 'Windows'
try { $sysName = (Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).Caption -replace '^Microsoft ', '' } catch {}
$sysArch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
Ok "$sysName · $sysArch" 'o hub vai instalar e gravar tudo no padrão do Windows (%USERPROFILE%)'
# Pergunta antes de instalar algo na máquina. Com HUB_YES=1 não pergunta.
function Confirm([string]$q) {
  if ($env:HUB_YES) { return $true }
  $reply = Read-Host "    $q [S/n]"
  return ($reply -eq '') -or ($reply -match '^[sSyY]')
}
# O winget grava o PATH novo no registro; este PowerShell ainda tem o antigo.
function RefreshPath {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = (@($machine, $user, $env:Path) | Where-Object { $_ }) -join ';'
}
function WingetInstall([string]$id) {
  if (-not (Has 'winget')) { return $false }
  & winget install --id $id -e --accept-source-agreements --accept-package-agreements
  # já instalado numa versão antiga: o install recusa e o upgrade resolve
  if ($LASTEXITCODE -ne 0) { & winget upgrade --id $id -e --accept-source-agreements --accept-package-agreements }
  RefreshPath
  return $true
}
function NodeMajor {
  if (-not (Has 'node')) { return 0 }
  try { return [int](& node -p "process.versions.node.split('.')[0]") } catch { return 0 }
}
$nodeNew = $false
if ((NodeMajor) -lt 18) {
  if (Has 'node') { Warn "node $(FirstLine { node --version })" 'antigo demais: o hub precisa do Node.js 18 ou mais novo' }
  else { Warn 'node não encontrado' 'o hub precisa do Node.js 18 ou mais novo' }
  if ((Has 'winget') -and (Confirm 'Instalar o Node.js LTS agora (winget)?')) { [void](WingetInstall 'OpenJS.NodeJS.LTS'); $nodeNew = $true }
  if ((NodeMajor) -lt 18) { Fail 'sem Node.js 18+' 'instale em https://nodejs.org e rode de novo'; exit 1 }
}
Ok 'node' "$(FirstLine { node --version }) - o hub e a interface (/ui)"
# npm.cmd: o npm.ps1 pode ser bloqueado pela política de execução
if (Has 'npm.cmd') { Ok 'npm' "$(FirstLine { npm.cmd --version }) - instala e atualiza as CLIs" }
else { Warn 'npm não encontrado' 'necessário para /install e /update' }
if (-not (Has 'git')) {
  Warn 'git não encontrado' 'sem ele o hub não se atualiza sozinho nem instala skills'
  if ((Has 'winget') -and (Confirm 'Instalar o Git agora (winget)?')) { [void](WingetInstall 'Git.Git') }
}
if (Has 'git') { Ok 'git' "$((FirstLine { git --version }) -replace '^git version ', '') - atualizações do hub" }
if (Has 'aws') { Ok 'aws' "$(((FirstLine { aws --version }) -split ' ')[0]) - contas Bedrock" }
else { Write-Host '  ' -NoNewline; Write-Host 'o' -ForegroundColor DarkGray -NoNewline; Write-Host ' aws ' -NoNewline; Write-Host 'opcional - só para contas Bedrock' -ForegroundColor DarkGray }

Section '2. Instalando o comando hub'
if (-not (Test-Path -LiteralPath $Target)) { Fail 'bin\hub.cmd não encontrado' "rode o instalador de dentro do repositório ($Repo)"; exit 1 }
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
$previous = $false
if (Test-Path -LiteralPath $Shim) {
  if (IsOurs $Shim) { $previous = $true }
  else {
    Warn "já existe um arquivo em $(Short $Shim)" 'não é deste repositório'
    $reply = Read-Host '    Substituir pelo hub? [s/N]'
    if ($reply -notmatch '^[sSyY]') {
      Fail 'instalação cancelada' "remova ou renomeie $(Short $Shim) e rode de novo"
      exit 1
    }
  }
}
$content = "@echo off`r`n$Marker gerado pelo install.ps1; chama o hub deste repositório`r`n`"$Target`" %*`r`n"
# sem BOM: o cmd.exe não entende arquivo .cmd com BOM
[System.IO.File]::WriteAllText($Shim, $content, (New-Object System.Text.UTF8Encoding($false)))
if ($previous) { Ok 'hub já estava instalado' "$(Short $Shim) → $(Short $Target)" }
else { Ok 'hub instalado' "$(Short $Shim) → $(Short $Target)" }
Write-Host '    alterações neste repositório valem na hora, sem reinstalar' -ForegroundColor DarkGray

Section '3. Conferindo o PATH'
$pathChanged = $false
$norm = { param($p) ([Environment]::ExpandEnvironmentVariables($p)).TrimEnd('\') }
# valor cru (com %VARIAVEIS%) para não estragar o que já está no PATH
$envKey = Get-Item -Path 'HKCU:\Environment'
$rawUser = [string]$envKey.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
$parts = @($rawUser -split ';' | Where-Object { $_ -ne '' })
$inUser = @($parts | Where-Object { (& $norm $_) -ieq $BinDir.TrimEnd('\') }).Count -gt 0
if ($inUser) {
  Ok "$(Short $BinDir) já está no PATH"
} else {
  $newPath = (@($parts) + $BinDir) -join ';'
  if ($rawUser -match '%') {
    # mantém o tipo REG_EXPAND_SZ e avisa os outros programas da mudança
    Set-ItemProperty -Path 'HKCU:\Environment' -Name 'Path' -Value $newPath -Type ExpandString
    [Environment]::SetEnvironmentVariable('AGENT_HUB_PATH_REFRESH', '1', 'User')
    [Environment]::SetEnvironmentVariable('AGENT_HUB_PATH_REFRESH', $null, 'User')
  } else {
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
  }
  $env:Path = "$env:Path;$BinDir"
  Ok "adicionado $(Short $BinDir) ao PATH do seu usuário"
  $pathChanged = $true
}

Section '4. Suas contas'
if (Test-Path -LiteralPath $Config) {
  $count = @(Get-Content -LiteralPath $Config | Where-Object { $_ -match '^\[' }).Count
  Ok "$count conta(s) cadastrada(s)" (Short $Config)
} else {
  Write-Host '  ' -NoNewline; Write-Host 'o' -ForegroundColor DarkGray -NoNewline; Write-Host ' nenhuma conta ainda ' -NoNewline; Write-Host '- você cadastra pelo /ui' -ForegroundColor DarkGray
}

Write-Host ''
Mascot '◕ ◡ ◕' 'Pronto! O hub está instalado.' 'próximos passos:'
Write-Host ''
$step = 1
function Step([string]$cmd, [string]$what) {
  Write-Host ('  {0}  ' -f $script:step) -ForegroundColor Cyan -NoNewline
  Write-Host $cmd.PadRight(9) -ForegroundColor White -NoNewline
  Write-Host " $what" -ForegroundColor DarkGray
  $script:step++
}
if ($pathChanged -or $nodeNew) { Step 'abra um terminal novo' '(o PATH mudou; neste aqui o hub já funciona)' }
Step 'hub' 'abre o menu'
Step '/ui' 'cadastra suas contas e credenciais'
Step '/install' 'instala as CLIs das contas (sempre a versão mais recente)'
Write-Host ''
Write-Host '  # para remover depois: .\uninstall.ps1 (tudo, inclusive as contas: .\uninstall.ps1 -All)' -ForegroundColor DarkGray
Write-Host ''
