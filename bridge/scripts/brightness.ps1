<#
  Get/set the built-in display's brightness via WMI (root/wmi
  WmiMonitorBrightness / WmiMonitorBrightnessMethods). Only laptop panels and
  some DDC/CI-capable monitors expose this class — an external monitor or a
  desktop GPU with no WMI brightness provider genuinely has no answer here,
  so an absent class is reported as unsupported, never guessed at.

  Always prints exactly one line of JSON on stdout.
#>
param(
  [Parameter(Mandatory = $true)][ValidateSet('get', 'set')]
  [string]$Action,
  [int]$Level = -1
)

$ErrorActionPreference = 'Stop'

try {
    switch ($Action) {
        'get' {
            $b = Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightness -ErrorAction Stop | Select-Object -First 1
            if (-not $b) { throw "No brightness-capable display was found on this machine." }
            [PSCustomObject]@{ ok = $true; percent = [int]$b.CurrentBrightness } | ConvertTo-Json -Compress
        }
        'set' {
            if ($Level -lt 0 -or $Level -gt 100) { throw "Level must be 0-100, got $Level" }
            $m = Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightnessMethods -ErrorAction Stop | Select-Object -First 1
            if (-not $m) { throw "No brightness-capable display was found on this machine." }
            Invoke-CimMethod -InputObject $m -MethodName WmiSetBrightness -Arguments @{ Timeout = [uint32]1; Brightness = [byte]$Level } | Out-Null
            [PSCustomObject]@{ ok = $true; percent = $Level } | ConvertTo-Json -Compress
        }
    }
} catch {
    [PSCustomObject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
}
