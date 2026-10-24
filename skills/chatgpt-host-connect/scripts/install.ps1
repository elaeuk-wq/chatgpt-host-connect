# Native Windows direct host installation (Tunnel/Key must already be recorded).
# Normal end-to-end use is the Node run command described in SKILL.md.
param(
    [Parameter(Mandatory=$true)][string]$Name,
    [Parameter(Mandatory=$true)][string]$TunnelId,
    [Parameter(Mandatory=$true)][string]$KeyFile,
    [switch]$AllowControl
)
$ErrorActionPreference = 'Stop'
if (!$AllowControl) { throw 'Installation requires -AllowControl' }
. (Join-Path $PSScriptRoot 'bootstrap.ps1')
$python = Prepare-HostPython $true
$env:PYTHONUTF8 = '1'
& $python (Join-Path $PSScriptRoot 'host.py') install --name $Name --tunnel-id $TunnelId --key-file $KeyFile --allow-control
exit $LASTEXITCODE
