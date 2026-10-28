<#
  Toggle Windows' light/dark app + system theme via the two HKCU Personalize
  DWORD values. Current-user registry key only — no admin, nothing else
  touched.
#>
param(
  [Parameter(Mandatory = $true)][ValidateSet('dark', 'light')]
  [string]$Mode
)

$ErrorActionPreference = 'Stop'

try {
    $value = if ($Mode -eq 'dark') { 0 } else { 1 }
    $path = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize'
    if (-not (Test-Path $path)) { New-Item -Path $path -Force | Out-Null }
    Set-ItemProperty -Path $path -Name AppsUseLightTheme -Value $value -Type DWord
    Set-ItemProperty -Path $path -Name SystemUsesLightTheme -Value $value -Type DWord
    [PSCustomObject]@{ ok = $true; mode = $Mode } | ConvertTo-Json -Compress
} catch {
    [PSCustomObject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
}
