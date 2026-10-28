<#
  Get/set the Windows master volume and mute state via the Core Audio API
  (IAudioEndpointVolume), the standard no-install technique — nothing like
  nircmd is downloaded or required. Called by pccontrol.mjs with a fixed,
  validated argument list; never by string-building a command.

  Always prints exactly one line of JSON on stdout: either
  { ok: true, percent, muted } or { ok: false, error }. Never throws past
  this script — pccontrol.mjs only has to parse JSON, not guess at exit codes.
#>
param(
  [Parameter(Mandatory = $true)][ValidateSet('get', 'set', 'mute', 'unmute')]
  [string]$Action,
  [int]$Level = -1
)

$ErrorActionPreference = 'Stop'

Add-Type @'
using System;
using System.Runtime.InteropServices;

[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
    int RegisterControlChangeNotify(IntPtr pNotify);
    int UnregisterControlChangeNotify(IntPtr pNotify);
    int GetChannelCount(out int pnChannelCount);
    int SetMasterVolumeLevel(float fLevelDB, Guid pguidEventContext);
    int SetMasterVolumeLevelScalar(float fLevel, Guid pguidEventContext);
    int GetMasterVolumeLevel(out float pfLevelDB);
    int GetMasterVolumeLevelScalar(out float pfLevel);
    int SetChannelVolumeLevel(uint nChannel, float fLevelDB, Guid pguidEventContext);
    int SetChannelVolumeLevelScalar(uint nChannel, float fLevel, Guid pguidEventContext);
    int GetChannelVolumeLevel(uint nChannel, out float pfLevelDB);
    int GetChannelVolumeLevelScalar(uint nChannel, out float pfLevel);
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, Guid pguidEventContext);
    int GetMute(out bool pbMute);
    int GetVolumeStepInfo(out uint pnStep, out uint pnStepCount);
    int VolumeStepUp(Guid pguidEventContext);
    int VolumeStepDown(Guid pguidEventContext);
    int QueryHardwareSupport(out uint pdwHardwareSupportMask);
    int GetVolumeRange(out float pflVolumeMindB, out float pflVolumeMaxdB, out float pflVolumeIncrementdB);
}

[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
    int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
}

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
    int NotImplemented1();
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppDevice);
}

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumeratorComObject {
}

public static class JarvisAudio {
    static IAudioEndpointVolume Vol() {
        var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
        IMMDevice dev;
        // eRender = 0, eConsole = 1
        Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0, 1, out dev));
        var iid = typeof(IAudioEndpointVolume).GUID;
        object epv;
        // CLSCTX_ALL = 23
        Marshal.ThrowExceptionForHR(dev.Activate(ref iid, 23, IntPtr.Zero, out epv));
        return (IAudioEndpointVolume)epv;
    }
    public static float GetVolume() {
        float v; Marshal.ThrowExceptionForHR(Vol().GetMasterVolumeLevelScalar(out v)); return v;
    }
    public static void SetVolume(float v) {
        Marshal.ThrowExceptionForHR(Vol().SetMasterVolumeLevelScalar(v, Guid.Empty));
    }
    public static bool GetMute() {
        bool m; Marshal.ThrowExceptionForHR(Vol().GetMute(out m)); return m;
    }
    public static void SetMute(bool m) {
        Marshal.ThrowExceptionForHR(Vol().SetMute(m, Guid.Empty));
    }
}
'@

function Report {
    param([float]$Fraction, [bool]$Muted)
    [PSCustomObject]@{
        ok      = $true
        percent = [int][math]::Round($Fraction * 100)
        muted   = $Muted
    } | ConvertTo-Json -Compress
}

try {
    switch ($Action) {
        'get' {
            Report -Fraction ([JarvisAudio]::GetVolume()) -Muted ([JarvisAudio]::GetMute())
        }
        'set' {
            if ($Level -lt 0 -or $Level -gt 100) { throw "Level must be 0-100, got $Level" }
            [JarvisAudio]::SetVolume($Level / 100.0)
            Report -Fraction ([JarvisAudio]::GetVolume()) -Muted ([JarvisAudio]::GetMute())
        }
        'mute' {
            [JarvisAudio]::SetMute($true)
            Report -Fraction ([JarvisAudio]::GetVolume()) -Muted $true
        }
        'unmute' {
            [JarvisAudio]::SetMute($false)
            Report -Fraction ([JarvisAudio]::GetVolume()) -Muted $false
        }
    }
} catch {
    [PSCustomObject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
}
