<#
  Read or switch the Wi-Fi radio — the same switch as the Wi-Fi button in
  Windows quick settings, through the Windows.Devices.Radios API.

  Unlike netsh's adapter admin state (wifi-adapter.ps1), this needs no
  Administrator rights, and it leaves the adapter itself enabled, so Windows
  reconnects to the usual network on its own when the radio comes back on.

  $State is a ValidateSet value, never user text. Omit it to only read.
#>
param(
  [ValidateSet('On', 'Off')]
  [string]$State
)

$ErrorActionPreference = 'Stop'

try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $asTaskGeneric = [System.WindowsRuntimeSystemExtensions].GetMethods() |
        Where-Object {
            $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
            $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
        } | Select-Object -First 1

    function Await($op, [type]$resultType) {
        $task = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($op))
        $task.Wait(-1) | Out-Null
        $task.Result
    }

    [Windows.Devices.Radios.Radio, Windows.System.Devices, ContentType = WindowsRuntime] | Out-Null
    [Windows.Devices.Radios.RadioAccessStatus, Windows.System.Devices, ContentType = WindowsRuntime] | Out-Null

    $access = Await ([Windows.Devices.Radios.Radio]::RequestAccessAsync()) ([Windows.Devices.Radios.RadioAccessStatus])
    if ("$access" -ne 'Allowed') { throw "Windows did not allow radio control ($access)." }

    $radios = Await ([Windows.Devices.Radios.Radio]::GetRadiosAsync()) `
        ([System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]])
    $wifi = $radios | Where-Object { "$($_.Kind)" -eq 'WiFi' } | Select-Object -First 1
    if (-not $wifi) { throw 'No Wi-Fi radio was found on this machine.' }

    if ($State) {
        $result = Await ($wifi.SetStateAsync($State)) ([Windows.Devices.Radios.RadioAccessStatus])
        if ("$result" -ne 'Allowed') { throw "Windows refused to switch Wi-Fi $State ($result)." }
    }

    [PSCustomObject]@{ ok = $true; name = $wifi.Name; state = "$($wifi.State)" } | ConvertTo-Json -Compress
} catch {
    [PSCustomObject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
}
