[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$PrivateKeyPath,

    [Parameter(Mandatory = $true)]
    [string]$PeerPublicKey,

    [Parameter(Mandatory = $true)]
    [string]$Endpoint,

    [string]$InterfaceAddress = "10.77.240.2/32",
    [string]$AllowedIPs = "10.77.240.0/24",
    [ValidateRange(1, 65535)]
    [int]$PersistentKeepalive = 25,
    [string]$TunnelName = "opsmind-management"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ($TunnelName -notmatch '^[a-z0-9-]{1,32}$') {
    throw "Invalid tunnel name"
}
if ($InterfaceAddress -ne "10.77.240.2/32") {
    throw "Unexpected management interface address"
}
if ($AllowedIPs -ne "10.77.240.0/24") {
    throw "Unexpected management route"
}
if ($Endpoint -notmatch '^[A-Za-z0-9.-]+:[0-9]{1,5}$') {
    throw "Invalid WireGuard endpoint"
}
if (-not (Test-Path -LiteralPath $PrivateKeyPath -PathType Leaf)) {
    throw "WireGuard private key file not found"
}

$privateKey = [IO.File]::ReadAllText($PrivateKeyPath).Trim()
if ($privateKey -notmatch '^[A-Za-z0-9+/]{43}=$') {
    throw "Invalid WireGuard private key"
}
if ($PeerPublicKey -notmatch '^[A-Za-z0-9+/]{43}=$') {
    throw "Invalid WireGuard peer public key"
}

$wireGuard = Join-Path $env:ProgramFiles "WireGuard\wireguard.exe"
if (-not (Test-Path -LiteralPath $wireGuard -PathType Leaf)) {
    throw "WireGuard executable not found"
}

$configRoot = Join-Path $env:ProgramData "OpsMind\WireGuard"
$configPath = Join-Path $configRoot "$TunnelName.conf"
New-Item -ItemType Directory -Path $configRoot -Force | Out-Null

$config = @(
    "[Interface]"
    "PrivateKey = $privateKey"
    "Address = $InterfaceAddress"
    ""
    "[Peer]"
    "PublicKey = $PeerPublicKey"
    "Endpoint = $Endpoint"
    "AllowedIPs = $AllowedIPs"
    "PersistentKeepalive = $PersistentKeepalive"
) -join "`r`n"

[IO.File]::WriteAllText($configPath, "$config`r`n", [Text.UTF8Encoding]::new($false))
& icacls.exe $configRoot /inheritance:r /grant:r 'SYSTEM:(OI)(CI)F' 'Administrators:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "Failed to secure the WireGuard configuration directory"
}

$serviceName = "WireGuardTunnel`$$TunnelName"
$existingService = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($null -ne $existingService) {
    & $wireGuard /uninstalltunnelservice $TunnelName
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to remove the existing WireGuard tunnel service"
    }
}

& $wireGuard /installtunnelservice $configPath
if ($LASTEXITCODE -ne 0) {
    throw "Failed to install the persistent WireGuard tunnel service"
}

$service = Get-Service -Name $serviceName
if ($service.Status -ne 'Running') {
    Start-Service -Name $serviceName
    $service = Get-Service -Name $serviceName
}
if ($service.Status -ne 'Running') {
    throw "WireGuard tunnel service is not running"
}

[pscustomobject]@{
    TunnelName = $TunnelName
    Status = $service.Status
    StartType = $service.StartType
    ConfigPath = $configPath
}
