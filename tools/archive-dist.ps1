param(
  [Parameter(Mandatory = $true)][string]$Version
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$dist = Join-Path $root 'dist'
$history = Join-Path $dist 'history'
$current = $Version.Trim()
$currentParts = $current.Split('.')

New-Item -ItemType Directory -Path $history -Force | Out-Null

$pattern = '^CyberAquarium-v(.+)-(portable\.zip|setup\.exe)$'
Get-ChildItem -LiteralPath $dist -File |
  Where-Object { $_.Name -match $pattern } |
  ForEach-Object {
    $version = $matches[1]
    if ($version -eq $current) { return }
    $parts = $version.Split('.')
    if ($parts[0] -eq $currentParts[0] -and $parts[1] -eq $currentParts[1]) {
      Remove-Item -LiteralPath $_.FullName -Force
      return
    }
    $versionDir = Join-Path $history ('v' + $version)
    New-Item -ItemType Directory -Path $versionDir -Force | Out-Null
    Move-Item -LiteralPath $_.FullName -Destination (Join-Path $versionDir $_.Name) -Force
  }
