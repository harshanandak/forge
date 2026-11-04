param([ValidateSet('start', 'sample', 'stop')][string]$Mode, [string]$Trace)
$ErrorActionPreference = 'Stop'
$names = @('bun', 'node', 'powershell', 'pwsh', 'git', 'cmd', 'conhost')
try {
    if ($Mode -eq 'start') {
        $child = Start-Process pwsh -WindowStyle Hidden -PassThru -ArgumentList @('-NoProfile', '-File', "`"$PSCommandPath`"", '-Mode', 'sample', '-Trace', "`"$Trace`"")
        @{ id = $child.Id; started = $child.StartTime.Ticks } | ConvertTo-Json -Compress | Set-Content "$Trace.pid"
    } elseif ($Mode -eq 'stop') {
        if (Test-Path "$Trace.pid") {
            $saved = Get-Content "$Trace.pid" -Raw | ConvertFrom-Json
            $child = Get-Process -Id $saved.id -ErrorAction SilentlyContinue
            # A crashed sampler's PID can be reused; never stop that replacement.
            if ($child -and $child.StartTime.Ticks -eq $saved.started) { $child.Kill(); $null = $child.WaitForExit(1000) }
        }
        $rows = @(if (Test-Path $Trace) { Get-Content $Trace | ForEach-Object { try { $_ | ConvertFrom-Json } catch { } } })
        if (!$rows.Count -or (Test-Path "$Trace.failed")) { Write-Host 'Runner trace: no trace (sampler unavailable or failed)'; exit 0 }
        $gap = $rows | Sort-Object gapMs -Descending | Select-Object -First 1
        $maxCounts = @{}
        foreach ($name in $names) { $maxCounts[$name] = ($rows.processCounts.$name | Measure-Object -Maximum).Maximum }
        $cost = $rows.sampleDurationMs | Measure-Object -Average -Maximum
        $cpu = ($rows.samplerCpuMs | Measure-Object -Sum).Sum
        $elapsed = ($rows.gapMs | Measure-Object -Sum).Sum + $rows[-1].sampleDurationMs
        Write-Host "Runner trace: samples=$($rows.Count) maxGapMs=$($gap.gapMs) at=$($gap.timestamp) maxProcessCounts=$($maxCounts | ConvertTo-Json -Compress) sampleDurationMs(mean/max)=$([math]::Round($cost.Average, 2))/$($cost.Maximum) samplerCpuPercent=$([math]::Round(100 * $cpu / [math]::Max(1, $elapsed), 3))"
    } else {
        Add-Type -AssemblyName System.Diagnostics.PerformanceCounter
        $specs = @{
            cpuPercent = @('Processor', '% Processor Time', '_Total')
            availableMemoryMB = @('Memory', 'Available MBytes')
            diskTimePercent = @('PhysicalDisk', '% Disk Time', '_Total')
            diskQueueLength = @('PhysicalDisk', 'Avg. Disk Queue Length', '_Total')
        }
        $counters = @{}
        foreach ($key in $specs.Keys) {
            try { $counters[$key] = New-Object System.Diagnostics.PerformanceCounter -ArgumentList $specs[$key]; $null = $counters[$key].NextValue() }
            catch { $counters[$key] = $null }
        }
        $clock = [Diagnostics.Stopwatch]::StartNew()
        $self = [Diagnostics.Process]::GetCurrentProcess()
        $previousCpu = $self.TotalProcessorTime.TotalMilliseconds
        $previous = $null
        while ($true) {
            $at = $clock.Elapsed.TotalMilliseconds
            $row = [ordered]@{ timestamp = [DateTime]::UtcNow.ToString('o'); gapMs = $(if ($null -eq $previous) { $null } else { [math]::Round($at - $previous, 2) }) }
            $counts = @{}
            foreach ($name in $names) { $counts[$name] = 0 }
            $row.processes = @(Get-Process -Name $names -ErrorAction SilentlyContinue | ForEach-Object {
                $counts[$_.ProcessName.ToLowerInvariant()]++
                @{ name = $_.ProcessName; pid = $_.Id }
                $_.Dispose()
            })
            $row.processCounts = $counts
            foreach ($key in $specs.Keys) {
                try { $row[$key] = [math]::Round($counters[$key].NextValue(), 2) } catch { $row[$key] = $null }
            }
            $self.Refresh()
            $cpu = $self.TotalProcessorTime.TotalMilliseconds
            $row.samplerCpuMs = $cpu - $previousCpu
            $row.sampleDurationMs = [math]::Round($clock.Elapsed.TotalMilliseconds - $at, 2)
            [IO.File]::AppendAllText($Trace, ($row | ConvertTo-Json -Depth 4 -Compress) + "`n")
            $previousCpu = $cpu
            $previous = $at
            Start-Sleep -Milliseconds ([math]::Max(1, 1000 - [int]($clock.Elapsed.TotalMilliseconds - $at)))
        }
    }
} catch {
    if ($Mode -eq 'sample') { [IO.File]::WriteAllText("$Trace.failed", 'sampler failed') }
    Write-Host 'Runner trace: no trace (sampler unavailable or failed)'
}
