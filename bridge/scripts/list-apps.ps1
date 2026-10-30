<#
  The apps in the Start menu, as Windows itself lists them: a display name
  and an AppID that `explorer.exe shell:AppsFolder\<AppID>` launches. Read
  only. pccontrol.mjs matches the user's words against these names, so what
  gets launched is always an AppID from this list, never text from a request.
#>
$ErrorActionPreference = 'Stop'

try {
    $apps = @(Get-StartApps | ForEach-Object { [PSCustomObject]@{ name = $_.Name; id = $_.AppID } })
    [PSCustomObject]@{ ok = $true; apps = $apps } | ConvertTo-Json -Compress -Depth 3
} catch {
    [PSCustomObject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
}
