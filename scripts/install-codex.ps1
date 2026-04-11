param(
    [switch]$Link
)

$SkillName = 'codex-feishu'
$CodeXSkillsDir = Join-Path $HOME '.codex\skills'
$TargetDir = Join-Path $CodeXSkillsDir $SkillName
$SourceDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

Write-Output "Installing $SkillName skill for Codex..."

if (-not (Test-Path (Join-Path $SourceDir 'SKILL.md'))) {
    Write-Output "Error: SKILL.md not found in $SourceDir"
    exit 1
}

New-Item -ItemType Directory -Force -Path $CodeXSkillsDir | Out-Null

if (Test-Path $TargetDir) {
    $item = Get-Item $TargetDir
    if ($item.LinkType -eq 'SymbolicLink') {
        Write-Output "Already installed as symlink -> $($item.Target)"
        Write-Output "To reinstall, remove it first: Remove-Item $TargetDir"
    } else {
        Write-Output "Already installed at $TargetDir"
        Write-Output "To reinstall, remove it first: Remove-Item $TargetDir -Recurse -Force"
    }
    exit 0
}

if ($Link) {
    try {
        New-Item -ItemType SymbolicLink -Path $TargetDir -Target $SourceDir | Out-Null
        Write-Output "Symlinked: $TargetDir -> $SourceDir"
    } catch {
        Write-Output 'Symlink creation failed. Enable Developer Mode or rerun without -Link.'
        exit 1
    }
} else {
    Copy-Item -Path $SourceDir -Destination $TargetDir -Recurse
    Write-Output "Copied to: $TargetDir"
}

$sdkDir = Join-Path $TargetDir 'node_modules\@larksuiteoapi\node-sdk'
if (-not (Test-Path $sdkDir)) {
    Write-Output 'Installing dependencies...'
    Push-Location $TargetDir
    try {
        npm install
        if ($LASTEXITCODE -ne 0) {
            exit $LASTEXITCODE
        }
    } finally {
        Pop-Location
    }
}

$daemonFile = Join-Path $TargetDir 'dist\daemon.mjs'
if (-not (Test-Path $daemonFile)) {
    Write-Output 'Building daemon bundle...'
    Push-Location $TargetDir
    try {
        npm run build
        if ($LASTEXITCODE -ne 0) {
            exit $LASTEXITCODE
        }
    } finally {
        Pop-Location
    }
}

Write-Output 'Pruning dev dependencies...'
Push-Location $TargetDir
try {
    npm prune --production
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
} finally {
    Pop-Location
}

Write-Output ''
Write-Output 'Done! Start a new Codex session and use:'
Write-Output '  codex-feishu setup    - configure Feishu bridge credentials'
Write-Output '  codex-feishu start    - start the bridge daemon'
Write-Output '  codex-feishu doctor   - diagnose issues'
Write-Output ''
Write-Output 'Windows first-run checklist:'
Write-Output '  1. Edit ~/.codex-feishu/config.env'
Write-Output '  2. In Feishu backend: add scopes + enable Bot'
Write-Output '  3. Publish once'
Write-Output '  4. Start the bridge with powershell -File scripts\daemon.ps1 start'
Write-Output '  5. In Feishu backend: Long Connection + im.message.receive_v1 + card.action.trigger'
Write-Output '  6. Publish again'
Write-Output ''
Write-Output 'Detailed guide:'
Write-Output "  $TargetDir\references\setup-guides.md"
