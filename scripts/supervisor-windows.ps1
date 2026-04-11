param(
    [Parameter(Position=0)]
    [string]$Command = 'help',

    [Parameter(Position=1)]
    [int]$LogLines = 50
)

$BridgeHome = if ($env:CODEX_FEISHU_HOME) { $env:CODEX_FEISHU_HOME } else { Join-Path $HOME '.codex-feishu' }
$SkillDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$RuntimeDir = Join-Path $BridgeHome 'runtime'
$DataDir = Join-Path $BridgeHome 'data'
$MessagesDir = Join-Path $DataDir 'messages'
$LogDir = Join-Path $BridgeHome 'logs'
$PidFile = Join-Path $RuntimeDir 'bridge.pid'
$StatusFile = Join-Path $RuntimeDir 'status.json'
$LogFile = Join-Path $LogDir 'bridge.log'
$ConfigFile = Join-Path $BridgeHome 'config.env'
$DaemonFile = Join-Path $SkillDir 'dist\daemon.mjs'
$DoctorScript = Join-Path $PSScriptRoot 'doctor.ps1'
$ScheduledTaskName = 'codex-feishu-bridge'

function Ensure-Directories {
    foreach ($dir in @($MessagesDir, $LogDir, $RuntimeDir)) {
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
    }
}

function Read-Pid {
    if (-not (Test-Path $PidFile)) {
        return $null
    }

    try {
        $raw = (Get-Content $PidFile -Raw).Trim()
        if (-not $raw) {
            return $null
        }
        return [int]$raw
    } catch {
        return $null
    }
}

function Test-PidAlive([int]$Pid) {
    try {
        Get-Process -Id $Pid -ErrorAction Stop | Out-Null
        return $true
    } catch {
        return $false
    }
}

function Read-Status {
    if (-not (Test-Path $StatusFile)) {
        return $null
    }

    try {
        return Get-Content $StatusFile -Raw | ConvertFrom-Json
    } catch {
        return $null
    }
}

function Status-Running {
    $status = Read-Status
    return [bool]($status -and $status.running -eq $true)
}

function Get-LastExitReason {
    $status = Read-Status
    if ($status -and $status.PSObject.Properties.Name -contains 'lastExitReason') {
        return $status.lastExitReason
    }
    return $null
}

function Resolve-NodeExecutable {
    if ($env:CODEX_FEISHU_NODE_EXECUTABLE -and (Test-Path $env:CODEX_FEISHU_NODE_EXECUTABLE)) {
        return $env:CODEX_FEISHU_NODE_EXECUTABLE
    }

    $command = Get-Command node -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }

    return $null
}

function Resolve-CodexExecutable {
    if ($env:CODEX_FEISHU_CODEX_EXECUTABLE -and (Test-Path $env:CODEX_FEISHU_CODEX_EXECUTABLE)) {
        return $env:CODEX_FEISHU_CODEX_EXECUTABLE
    }

    $command = Get-Command codex -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }

    if ($env:LOCALAPPDATA) {
        $wellKnown = Join-Path $env:LOCALAPPDATA 'Programs\OpenAI\Codex\codex.exe'
        if (Test-Path $wellKnown) {
            return $wellKnown
        }
    }

    return $null
}

function Import-ConfigEnv {
    if (-not (Test-Path $ConfigFile)) {
        return
    }

    foreach ($rawLine in Get-Content $ConfigFile) {
        $line = $rawLine.Trim()
        if (-not $line -or $line.StartsWith('#')) {
            continue
        }

        $eqIndex = $line.IndexOf('=')
        if ($eqIndex -lt 1) {
            continue
        }

        $key = $line.Substring(0, $eqIndex).Trim()
        $value = $line.Substring($eqIndex + 1).Trim()
        if (
            (($value.StartsWith('"')) -and ($value.EndsWith('"'))) -or
            (($value.StartsWith("'")) -and ($value.EndsWith("'")))
        ) {
            $value = $value.Substring(1, $value.Length - 2)
        }

        [Environment]::SetEnvironmentVariable($key, $value, 'Process')
    }
}

function Ensure-Built {
    $needsBuild = -not (Test-Path $DaemonFile)
    if (-not $needsBuild) {
        $daemonWriteTime = (Get-Item $DaemonFile).LastWriteTimeUtc
        $staleSource = Get-ChildItem (Join-Path $SkillDir 'src') -Recurse -Filter *.ts |
            Where-Object { $_.LastWriteTimeUtc -gt $daemonWriteTime } |
            Select-Object -First 1
        $needsBuild = $null -ne $staleSource
    }

    if (-not $needsBuild) {
        return
    }

    Write-Output 'Building daemon bundle...'
    Push-Location $SkillDir
    try {
        npm run build
        if ($LASTEXITCODE -ne 0) {
            exit $LASTEXITCODE
        }
    } finally {
        Pop-Location
    }
}

function Test-ServiceInstalled {
    & schtasks.exe /Query /TN $ScheduledTaskName *> $null
    return $LASTEXITCODE -eq 0
}

function Start-Bridge {
    Ensure-Directories
    Ensure-Built

    $pid = Read-Pid
    if ($pid -and (Test-PidAlive $pid)) {
        Write-Output "Bridge already running (PID: $pid)"
        if (Test-Path $StatusFile) {
            Get-Content $StatusFile
        }
        exit 1
    }

    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    Remove-Item $StatusFile -Force -ErrorAction SilentlyContinue

    Import-ConfigEnv

    $nodeBin = Resolve-NodeExecutable
    if (-not $nodeBin) {
        Write-Output 'node executable not found. Set CODEX_FEISHU_NODE_EXECUTABLE if Node.js is installed in a non-standard location.'
        exit 127
    }

    $codexBin = Resolve-CodexExecutable
    if ($codexBin -and -not $env:CODEX_FEISHU_CODEX_EXECUTABLE) {
        [Environment]::SetEnvironmentVariable('CODEX_FEISHU_CODEX_EXECUTABLE', $codexBin, 'Process')
    }

    Write-Output 'Starting bridge...'
    $commandLine = "`"$nodeBin`" `"$DaemonFile`" >> `"$LogFile`" 2>&1"
    $process = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/d', '/c', $commandLine) -WindowStyle Hidden -WorkingDirectory $SkillDir -PassThru

    $started = $false
    for ($i = 0; $i -lt 12; $i += 1) {
        Start-Sleep -Seconds 1
        if (Status-Running) {
            $started = $true
            break
        }

        try {
            $process.Refresh()
        } catch {
            break
        }
        if ($process.HasExited) {
            break
        }
    }

    if ($started) {
        $newPid = Read-Pid
        Write-Output "Bridge started (PID: $newPid)"
        Get-Content $StatusFile
        exit 0
    }

    Write-Output 'Failed to start bridge.'
    try {
        $process.Refresh()
        if ($process.HasExited) {
            Write-Output 'Process exited during startup.'
        }
    } catch {
        # ignore refresh failures
    }

    $reason = Get-LastExitReason
    if ($reason) {
        Write-Output "Last exit reason: $reason"
    }

    Write-Output ''
    Write-Output 'Recent logs:'
    if (Test-Path $LogFile) {
        Get-Content $LogFile -Tail 20
    }
    exit 1
}

function Stop-Bridge {
    $pid = Read-Pid
    if (-not $pid) {
        Write-Output 'No bridge running'
        exit 0
    }

    if (Test-PidAlive $pid) {
        Write-Output "Stopping bridge (PID: $pid)..."
        Stop-Process -Id $pid -ErrorAction SilentlyContinue
        for ($i = 0; $i -lt 10; $i += 1) {
            if (-not (Test-PidAlive $pid)) {
                break
            }
            Start-Sleep -Seconds 1
        }
        if (Test-PidAlive $pid) {
            Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
        }
    } else {
        Write-Output 'Bridge was not running (stale PID file)'
    }

    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    Write-Output 'Bridge stopped'
}

function Show-Status {
    $pid = Read-Pid
    if ($pid -and (Test-PidAlive $pid)) {
        Write-Output "Bridge process is running (PID: $pid)"
    } else {
        Write-Output 'Bridge is not running'
        if (Test-Path $PidFile) {
            Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
        }
    }

    if (Test-Path $StatusFile) {
        Get-Content $StatusFile
    } else {
        $reason = Get-LastExitReason
        if ($reason) {
            Write-Output "Last exit reason: $reason"
        }
    }

    if (Test-ServiceInstalled) {
        Write-Output "Scheduled task installed: $ScheduledTaskName"
    }
}

function Show-Logs {
    $lines = [Math]::Max($LogLines, 1)
    if (-not (Test-Path $LogFile)) {
        return
    }

    Get-Content $LogFile -Tail $lines | ForEach-Object {
        $_ -replace '(token|secret|password)(["'']?\s*[:=]\s*["'']?)[^ "'']+', '$1$2*****'
    }
}

function Install-Service {
    $supervisorPath = Join-Path $PSScriptRoot 'supervisor-windows.ps1'
    $taskCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$supervisorPath`" service-run"
    & schtasks.exe /Create /TN $ScheduledTaskName /SC ONLOGON /TR $taskCommand /RL LIMITED /F
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
    Write-Output "Installed scheduled task: $ScheduledTaskName"
}

function Uninstall-Service {
    & schtasks.exe /Delete /TN $ScheduledTaskName /F *> $null
    if ($LASTEXITCODE -eq 0) {
        Write-Output "Removed scheduled task: $ScheduledTaskName"
        return
    }
    Write-Output "Scheduled task not found: $ScheduledTaskName"
}

function Invoke-ServiceRun {
    Ensure-Directories
    Import-ConfigEnv

    $nodeBin = Resolve-NodeExecutable
    if (-not $nodeBin) {
        Write-Output 'node executable not found. Set CODEX_FEISHU_NODE_EXECUTABLE if Node.js is installed in a non-standard location.'
        exit 127
    }

    $codexBin = Resolve-CodexExecutable
    if ($codexBin -and -not $env:CODEX_FEISHU_CODEX_EXECUTABLE) {
        [Environment]::SetEnvironmentVariable('CODEX_FEISHU_CODEX_EXECUTABLE', $codexBin, 'Process')
    }

    Set-Location $SkillDir
    & $nodeBin $DaemonFile
    exit $LASTEXITCODE
}

switch ($Command) {
    'start' {
        Start-Bridge
    }
    'stop' {
        Stop-Bridge
    }
    'status' {
        Show-Status
    }
    'logs' {
        Show-Logs
    }
    'doctor' {
        & $DoctorScript
        exit $LASTEXITCODE
    }
    'install-service' {
        Install-Service
    }
    'uninstall-service' {
        Uninstall-Service
    }
    'service-run' {
        Invoke-ServiceRun
    }
    default {
        Write-Output 'Usage: supervisor-windows.ps1 {start|stop|status|logs [N]|doctor|install-service|uninstall-service}'
        exit 1
    }
}
