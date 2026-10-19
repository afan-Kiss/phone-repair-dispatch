# GitHub push script - reads api_key from .github-credentials
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$credFile = Join-Path $root '.github-credentials'

if (-not (Test-Path $credFile)) {
    Write-Error "Missing $credFile (expected api_key=...)"
}

$apiKey = $null
Get-Content $credFile -Encoding UTF8 | ForEach-Object {
    if ($_ -match '^\s*api_key\s*=\s*(.+)\s*$') {
        $apiKey = $Matches[1].Trim()
    }
}

if (-not $apiKey) {
    Write-Error "api_key not found in .github-credentials"
}

Set-Location $root

if (-not (Test-Path (Join-Path $root '.git'))) {
    Write-Error "Not a git repository"
}

$remoteUrl = git remote get-url origin 2>$null
if (-not $remoteUrl) {
    Write-Error "origin remote not configured"
}

$cleanUrl = $remoteUrl -replace '^https://[^@]+@', 'https://'
$cleanUrl = $cleanUrl -replace '^https://', ''
if ($cleanUrl -notmatch '^github\.com/') {
    $cleanUrl = "github.com/$cleanUrl"
}
$authUrl = "https://x-access-token:${apiKey}@${cleanUrl}"

git remote set-url origin $authUrl
try {
    & git push @args
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    Write-Host 'Push succeeded'
}
finally {
    git remote set-url origin ('https://' + $cleanUrl)
}
