<#
  Open the Claude desktop app on a new chat with a request already typed in,
  and bring it to the front so the user watches it — without sending it.

  1. claude://claude.ai/new opens a new chat. An unsent draft survives that,
     and a ?q= link appends to it rather than replacing it, so the box is
     cleared first (Ctrl+A, Delete) — only after checking that Claude really
     is the window in front, so no keystroke can land in another app.
  2. $Url, the claude://claude.ai/new?q=... link build.mjs built, fills it.

  Sending is left to the user: Claude asks a person to confirm any prompt
  that arrives by link.

  Focus uses AttachThreadInput rather than an Alt tap: Windows otherwise only
  flashes the taskbar icon of an app that is not already in front, and an Alt
  tap opens the menu bar of whichever app receives it.
#>
param(
  [Parameter(Mandatory = $true)][string]$Url
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class Focus {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
}
'@

function Get-ClaudeWindow {
  for ($i = 0; $i -lt 30; $i++) {
    $w = Get-Process -Name 'claude' -ErrorAction SilentlyContinue |
      Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if ($w) { return $w }
    Start-Sleep -Milliseconds 500
  }
  throw 'Claude did not open.'
}

function Test-ClaudeInFront {
  $fgPid = 0
  [Focus]::GetWindowThreadProcessId([Focus]::GetForegroundWindow(), [ref]$fgPid) | Out-Null
  (Get-Process -Id $fgPid -ErrorAction SilentlyContinue).ProcessName -eq 'claude'
}

function Show-Claude {
  $w = Get-ClaudeWindow
  if (Test-ClaudeInFront) { return }
  $h = $w.MainWindowHandle
  if ([Focus]::IsIconic($h)) { [Focus]::ShowWindow($h, 9) | Out-Null }   # SW_RESTORE
  $fgPid = 0
  $fgThread = [Focus]::GetWindowThreadProcessId([Focus]::GetForegroundWindow(), [ref]$fgPid)
  $me = [Focus]::GetCurrentThreadId()
  [Focus]::AttachThreadInput($me, $fgThread, $true) | Out-Null
  try {
    [Focus]::BringWindowToTop($h) | Out-Null
    [Focus]::SetForegroundWindow($h) | Out-Null
  } finally {
    [Focus]::AttachThreadInput($me, $fgThread, $false) | Out-Null
  }
  Start-Sleep -Milliseconds 400
}

try {
  if (-not $Url.StartsWith('claude://claude.ai/new?q=')) { throw 'Not a Claude new-chat link.' }

  Start-Process 'claude://claude.ai/new'
  Start-Sleep -Milliseconds 2500
  Show-Claude
  $cleared = $false
  if (Test-ClaudeInFront) {
    [System.Windows.Forms.SendKeys]::SendWait('^a')
    [System.Windows.Forms.SendKeys]::SendWait('{DEL}')
    $cleared = $true
  }

  Start-Process $Url
  Start-Sleep -Milliseconds 1500
  Show-Claude

  [PSCustomObject]@{ ok = $true; inFront = (Test-ClaudeInFront); cleared = $cleared } | ConvertTo-Json -Compress
} catch {
  [PSCustomObject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
}
