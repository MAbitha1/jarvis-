<#
  Open the Claude desktop app on a new chat, type a request into it and send
  it, in front of the user — "open Claude, new chat, type it, run it".

  The text is read from $TextFile (written by build.mjs), never passed on the
  command line, and reaches the message box through the clipboard, whose
  previous text is put back afterwards. It is typed rather than sent as a
  claude://...?q= link: a link prompt comes with Claude's "use caution"
  notice and waits for a person, and one also appends to any unsent draft
  instead of replacing it.

  Every keystroke is sent only after checking that Claude really is the
  window in front, so none can land in another app. Focus uses
  AttachThreadInput rather than an Alt tap: Windows otherwise only flashes
  the taskbar icon of an app that is not in front, and an Alt tap opens the
  menu bar of whichever app receives it.
#>
param(
  [Parameter(Mandatory = $true)][string]$TextFile
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

function Send-ToClaude([string]$keys) {
  if (-not (Test-ClaudeInFront)) { throw 'Claude was not the window in front, so nothing more was typed.' }
  [System.Windows.Forms.SendKeys]::SendWait($keys)
}

$previous = $null
$touchedClipboard = $false
try {
  $text = Get-Content -LiteralPath $TextFile -Raw -Encoding UTF8
  if (-not $text -or -not $text.Trim()) { throw 'The request is empty.' }

  Start-Process 'claude://claude.ai/new'
  Start-Sleep -Milliseconds 2500
  Show-Claude
  Start-Sleep -Milliseconds 500

  # Clear any unsent draft, then type the request and send it.
  Send-ToClaude '^a'
  Send-ToClaude '{DEL}'
  try { $previous = Get-Clipboard -Raw -ErrorAction SilentlyContinue } catch {}
  $touchedClipboard = $true
  Set-Clipboard -Value $text
  Send-ToClaude '^v'
  Start-Sleep -Milliseconds 700
  Send-ToClaude '{ENTER}'
  Start-Sleep -Milliseconds 300

  [PSCustomObject]@{ ok = $true; sent = $true } | ConvertTo-Json -Compress
} catch {
  [PSCustomObject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
} finally {
  if ($touchedClipboard) {
    if ($null -ne $previous) { Set-Clipboard -Value $previous } else { Set-Clipboard -Value $null }
  }
}
