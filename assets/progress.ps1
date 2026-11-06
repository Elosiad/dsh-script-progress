# dsh-script-progress - PowerShell progress bar helper
#
# Usage (one-liner wrapper):
#   . "C:\Users\you\.dsh\script-progress\progress.ps1"
#   ForEach-WithProgress -Items $urls -Label 'download' -Unit 'req' -Process {
#       param($url)
#       Invoke-WebRequest $url | Out-Null
#   }
#
# Usage (manual):
#   Write-DshProgressLine -Done $i -Total $urls.Count -Label 'download' -Unit 'req'
#
# Output goes to stderr, matching the Python and Node helpers. The progress bar
# is pure ASCII on purpose: Windows PowerShell 5.1 decodes this file as ANSI/GBK
# unless it carries a BOM, and a stray non-ASCII byte in a comment would break
# parsing on the user's machine. Keep this file ASCII-only.
#
# State is kept per -Key, so nested loops just pass different keys.

$script:DshProgressBars = @{}
$script:DshProgressMilestones = @(10, 25, 50, 75, 90)

function Format-DshSeconds {
    param([double]$Seconds)
    if ($Seconds -lt 0 -or [double]::IsNaN($Seconds)) { return '--:--' }
    $total = [int][Math]::Round($Seconds)
    $h = [Math]::Floor($total / 3600)
    $m = [Math]::Floor(($total % 3600) / 60)
    $s = $total % 60
    if ($h -gt 0) { return ('{0}:{1:00}:{2:00}' -f $h, $m, $s) }
    return ('{0:00}:{1:00}' -f $m, $s)
}

function Format-DshRate {
    param([double]$Rate)
    if ($Rate -ge 100) { return ('{0:N0}' -f $Rate) }
    if ($Rate -ge 10) { return ('{0:N1}' -f $Rate) }
    return ('{0:N2}' -f $Rate)
}

function Get-DshBarState {
    param([string]$Key)

    if (-not $script:DshProgressBars.ContainsKey($Key)) {
        $script:DshProgressBars[$Key] = @{
            Stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
            Next      = 0
            LastEmit  = -1.0
            UiLast    = -1.0
        }
    }
    return $script:DshProgressBars[$Key]
}

# Task id for the DSH progress channel: 1-40 chars of A-Za-z0-9._-, starting with
# an alphanumeric. A label with no usable ASCII (e.g. Chinese) falls back to a
# short hash so two different tasks never collapse into one row.
function Get-DshTaskId {
    param([string]$Label)

    $safe = [regex]::Replace([string]$Label, '[^A-Za-z0-9._-]', '-')
    $safe = [regex]::Replace($safe, '-{2,}', '-').Trim('._-')
    if (([regex]::Replace($safe, '[^A-Za-z0-9]', '')).Length -lt 3) {
        $md5 = [System.Security.Cryptography.MD5]::Create()
        $bytes = $md5.ComputeHash([System.Text.Encoding]::UTF8.GetBytes([string]$Label))
        $safe = 'task-' + (-join ($bytes[0..1] | ForEach-Object { $_.ToString('x2') }))
    }
    if ($safe.Length -gt 40) { $safe = $safe.Substring(0, 40) }
    return $safe
}

# Append one JSON line to the DSH progress channel when the Host provided a
# directory. Absent outside a DSH shell call, where there is nobody to read it.
function Write-DshProgressState {
    param(
        [string]$State = 'running',
        [object]$Pct = $null,
        [string]$Message = '',
        [long]$Done = 0,
        [long]$Total = 0,
        [string]$Unit = 'it',
        [string]$Label = ''
    )

    $base = $env:DSH_PROGRESS_DIR
    if (-not $base) { return }

    $task = Get-DshTaskId -Label $Label
    $doc = [ordered]@{
        v     = 1
        task  = $task
        state = $State
        at    = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }
    if ($null -ne $Pct) { $doc.pct = [Math]::Round([double]$Pct, 1) }
    if ($Total -gt 0) { $doc.done = $Done; $doc.total = $Total }
    $doc.unit = $Unit
    $msg = $Message
    if (-not $msg) { $msg = $Label }
    if ($msg) { $doc.msg = $msg.Substring(0, [Math]::Min(200, $msg.Length)) }

    try {
        $line = ($doc | ConvertTo-Json -Compress)
        $path = Join-Path $base ($task + '.jsonl')
        [System.IO.File]::AppendAllText($path, $line + "`n", (New-Object System.Text.UTF8Encoding($false)))
    }
    catch {
        # The UI channel must never break the script that is reporting.
    }
}

function Write-DshProgressLine {
    param(
        [Parameter(Mandatory)][long]$Done,
        [Parameter(Mandatory)][long]$Total,
        [string]$Label = '',
        [string]$Unit = 'it',
        [string]$Note = '',
        [string]$Key = 'default',
        [int]$IntervalMs = 500
    )

    $state = Get-DshBarState -Key $Key
    $elapsed = $state.Stopwatch.Elapsed.TotalSeconds
    if ($elapsed -le 0) { $elapsed = 0.001 }

    $rate = $Done / $elapsed
    $percent = 0.0
    if ($Total -gt 0) {
        $percent = [Math]::Min(100.0, ($Done * 100.0 / $Total))
    }
    $eta = $null
    if ($Total -gt 0 -and $rate -gt 0) {
        $eta = [Math]::Max(0.0, (($Total - $Done) / $rate))
    }

    $redirected = [Console]::IsOutputRedirected
    $rateText = Format-DshRate -Rate $rate
    $speedText = ('{0} {1}/s' -f $rateText, $Unit)

    # Milestones: one standalone line each, prefixed with @@PROGRESS so the agent
    # can find them in captured output. Printed whether or not output is redirected.
    while ($state.Next -lt $script:DshProgressMilestones.Count -and
           $percent -ge $script:DshProgressMilestones[$state.Next]) {
        $hit = $script:DshProgressMilestones[$state.Next]
        $state.Next++
        $etaArg = -1
        if ($null -ne $eta) { $etaArg = $eta }
        $mark = '@@PROGRESS {0}% {1}{2}/s eta={3}' -f $hit, $rateText, $Unit, (Format-DshSeconds -Seconds $etaArg)
        if ($Label) { $mark = $mark + ' label=' + $Label }
        if (-not $redirected) { [Console]::Error.Write("`n") }
        [Console]::Error.WriteLine($mark)
    }

    # DSH progress channel (for the Web UI), throttled to one line per second.
    $nowUi = [DateTime]::UtcNow.Ticks / 1e7
    if ($state.UiLast -lt 0 -or ($nowUi - $state.UiLast) -ge 1.0) {
        $state.UiLast = $nowUi
        Write-DshProgressState -State 'running' -Pct $percent -Message $Note -Done $Done -Total $Total -Unit $Unit -Label $Label
    }

    # No bar for the first 0.25s: the first frame carries no useful rate.
    if ($elapsed -lt 0.25 -and $percent -lt 100) { return }

    # Throttle unconditionally. PowerShell 5.1 often still reports
    # IsOutputRedirected=$false when a parent process captures the output, so the
    # redirect flag cannot be trusted to decide the refresh rate.
    $now = [DateTime]::UtcNow.Ticks / 1e7
    if ($state.LastEmit -ge 0 -and ($now - $state.LastEmit) -lt ($IntervalMs / 1000.0)) { return }
    $state.LastEmit = $now

    $filled = 0
    if ($Total -gt 0) { $filled = [int][Math]::Round(22 * $percent / 100.0) }
    $bar = ('#' * $filled) + ('-' * (22 - $filled))
    $etaText = '--:--'
    if ($null -ne $eta) { $etaText = Format-DshSeconds -Seconds $eta }
    $line = '[{0,3}%] {1} {2,12} ETA {3}' -f [int]$percent, $bar, $speedText, $etaText

    $tail = @()
    if ($Label) { $tail += $Label }
    if ($Note) { $tail += $Note }
    if ($tail.Count -gt 0) { $line = $line + ' | ' + ($tail -join ' ') }

    if ($redirected) {
        [Console]::Error.WriteLine($line)
    }
    else {
        [Console]::Error.Write("`r" + $line)
    }
}

function Complete-DshProgressLine {
    param(
        [Parameter(Mandatory)][long]$Done,
        [Parameter(Mandatory)][long]$Total,
        [string]$Label = '',
        [string]$Unit = 'it',
        [string]$Key = 'default'
    )

    $state = Get-DshBarState -Key $Key
    $elapsed = $state.Stopwatch.Elapsed.TotalSeconds
    if ($elapsed -le 0) { $elapsed = 0.001 }
    $rate = $Done / $elapsed
    $rateText = Format-DshRate -Rate $rate

    $redirected = [Console]::IsOutputRedirected
    $complete = ($Total -gt 0) -and ($Done -ge $Total)

    $finalState = 'done'
    $finalPct = 100
    if (-not $complete -and $Total -gt 0) {
        $finalState = 'cancelled'
        $finalPct = [Math]::Min(100.0, ($Done * 100.0 / $Total))
    }
    Write-DshProgressState -State $finalState -Pct $finalPct -Message $Label -Done $Done -Total $Total -Unit $Unit -Label $Label

    if ($complete) {
        $parts = @('@@PROGRESS', '100%', ($rateText + $Unit + '/s'), ('elapsed=' + (Format-DshSeconds -Seconds $elapsed)))
        if ($Label) { $parts += ('label=' + $Label) }
        if (-not $redirected) { [Console]::Error.Write("`n") }
        [Console]::Error.WriteLine(($parts -join ' '))
    }

    # Only claim completion when every item really ran: a mid-loop break must not
    # print 100%, or the agent reports a finished job that never finished.
    $head = 'done {0} {1}' -f $Done, $Unit
    if ($Total -gt 0 -and -not $complete) { $head = 'stopped at {0}/{1} {2}' -f $Done, $Total, $Unit }
    $summary = '{0} | took {1} | avg {2} {3}/s' -f $head, (Format-DshSeconds -Seconds $elapsed), $rateText, $Unit
    if ($Label) { $summary = $summary + ' | ' + $Label }
    [Console]::Error.WriteLine($summary)

    $script:DshProgressBars.Remove($Key)
}

function ForEach-WithProgress {
    <#
    .SYNOPSIS
      Walk a collection and print a progress bar plus milestones.
    #>
    param(
        [Parameter(Mandatory)][object[]]$Items,
        [string]$Label = '',
        [string]$Unit = 'it',
        [Parameter(Mandatory)][scriptblock]$Process
    )

    $key = [guid]::NewGuid().ToString('N')
    $total = $Items.Count
    $done = 0

    try {
        foreach ($item in $Items) {
            $done++
            Write-DshProgressLine -Done $done -Total $total -Label $Label -Unit $Unit -Key $key
            & $Process $item
        }
    }
    finally {
        Complete-DshProgressLine -Done $done -Total $total -Label $Label -Unit $Unit -Key $key
    }
}
