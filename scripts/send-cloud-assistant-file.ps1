[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$SourcePath,
    [Parameter(Mandatory = $true)]
    [string]$RemoteDirectory,
    [string]$RemoteName = "payload",
    [string]$ConfigPath = (Join-Path $PSScriptRoot "..\config\eval-lab-cloud.psd1"),
    [int]$StartPart = 0,
    [int]$ThrottleLimit = 8
)

$ErrorActionPreference = "Stop"
$source = (Resolve-Path -LiteralPath $SourcePath).Path
$config = Import-PowerShellDataFile -LiteralPath (Resolve-Path -LiteralPath $ConfigPath).Path
$opsmindRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\OpsMind")).Path
$aliyun = Join-Path $opsmindRoot ".tools\aliyuncli\aliyun.exe"
$aliyunHome = Join-Path $opsmindRoot ".tools\aliyun-home"
$chunkRoot = Join-Path ([IO.Path]::GetTempPath()) ("evalos-send-" + [Guid]::NewGuid().ToString("N"))
$chunkSize = 18000

if (-not (Test-Path -LiteralPath $aliyun)) {
    throw "Portable Alibaba Cloud CLI was not found: $aliyun"
}

New-Item -ItemType Directory -Path $chunkRoot | Out-Null
try {
    $bytes = [IO.File]::ReadAllBytes($source)
    $count = [Math]::Ceiling($bytes.Length / $chunkSize)
    $parts = for ($index = 0; $index -lt $count; $index++) {
        $offset = $index * $chunkSize
        $length = [Math]::Min($chunkSize, $bytes.Length - $offset)
        $chunk = [byte[]]::new($length)
        [Array]::Copy($bytes, $offset, $chunk, 0, $length)
        $name = "{0}.part.{1:D5}" -f $RemoteName, $index
        $path = Join-Path $chunkRoot $name
        [IO.File]::WriteAllBytes($path, $chunk)
        [pscustomobject]@{ Index = $index; Name = $name; Path = $path }
    }
    $parts = @($parts | Where-Object { $_.Index -ge $StartPart })
    if (-not $parts.Count) { throw "No chunks selected from StartPart=$StartPart" }

    $previousHomeDrive = $env:HOMEDRIVE
    $previousHomePath = $env:HOMEPATH
    $previousPluginDirectory = $env:ALIBABA_CLOUD_CLI_PLUGINS_DIR
    try {
        $env:HOMEDRIVE = Split-Path -Qualifier $aliyunHome
        $env:HOMEPATH = $aliyunHome.Substring($env:HOMEDRIVE.Length)
        $env:ALIBABA_CLOUD_CLI_PLUGINS_DIR = Join-Path $aliyunHome ".aliyun\plugins"
        $responses = $parts | ForEach-Object -Parallel {
            $content = [Convert]::ToBase64String([IO.File]::ReadAllBytes($_.Path))
            $output = & $using:aliyun ecs SendFile `
                --RegionId ([string]$using:config.RegionId) `
                --InstanceId.1 ([string]$using:config.InstanceId) `
                --Name $_.Name `
                --TargetDir $using:RemoteDirectory `
                --Content $content `
                --ContentType Base64 `
                --FileMode 0600 `
                --Overwrite true `
                --Timeout 120 `
                --profile ([string]$using:config.AliyunProfile)
            if ($LASTEXITCODE -ne 0) { throw "SendFile failed for $($_.Name)" }
            [pscustomobject]@{ Name = $_.Name; Response = $output }
        } -ThrottleLimit $ThrottleLimit
    } finally {
        $env:HOMEDRIVE = $previousHomeDrive
        $env:HOMEPATH = $previousHomePath
        $env:ALIBABA_CLOUD_CLI_PLUGINS_DIR = $previousPluginDirectory
    }

    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $source).Hash.ToLowerInvariant()
    [pscustomobject]@{
        status = "SUBMITTED"
        source = $source
        remote_directory = $RemoteDirectory
        remote_name = $RemoteName
        bytes = $bytes.Length
        parts = $responses.Count
        sha256 = $hash
    } | ConvertTo-Json
} finally {
    Remove-Item -LiteralPath $chunkRoot -Recurse -Force -ErrorAction SilentlyContinue
}
