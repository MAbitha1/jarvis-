<#
  Enable or disable one named network adapter's admin state. $Name is never
  user text — pccontrol.mjs sources it from systeminformation's own
  wifiInterfaces() list (type === 'wireless'), so this can only ever be
  pointed at an adapter already confirmed to be Wi-Fi, never Ethernet.

  Admin-state changes on a network interface require elevation on Windows;
  when this process isn't elevated, netsh fails with "Access is denied" and
  that failure is reported back as structured JSON rather than retried or
  silently escalated.
#>
param(
  [Parameter(Mandatory = $true)][string]$Name,
  [Parameter(Mandatory = $true)][ValidateSet('enabled', 'disabled')]
  [string]$State
)

$ErrorActionPreference = 'Stop'

try {
    $output = netsh interface set interface name="$Name" admin=$State 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "netsh exited with code $LASTEXITCODE`: $output"
    }
    [PSCustomObject]@{ ok = $true; name = $Name; state = $State } | ConvertTo-Json -Compress
} catch {
    [PSCustomObject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
}
