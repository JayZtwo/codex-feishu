param()

$scriptDir = Split-Path -Parent $PSCommandPath
$nodeBin = $env:CODEX_FEISHU_NODE_EXECUTABLE

if (-not $nodeBin) {
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCommand) {
        $nodeBin = $nodeCommand.Source
    }
}

if (-not $nodeBin) {
    Write-Output "[FAIL] Node.js installed"
    Write-Output ""
    Write-Output "Install Node.js >= 20, then rerun this doctor command."
    exit 1
}

& $nodeBin (Join-Path $scriptDir 'doctor.mjs')
exit $LASTEXITCODE
