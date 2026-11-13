# Remove o comando hub. Com -All, apaga também as contas e dados do hub e tira a pasta do PATH se ficar vazia.
# A lógica fica no install.ps1; este arquivo só dá um nome óbvio ao comando.
param([switch]$All)
$installer = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'install.ps1'
if ($All) { & $installer -Purge } else { & $installer -Uninstall }
exit $LASTEXITCODE
