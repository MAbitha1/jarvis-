/**
 * Shared guard for every global single-key shortcut in the app (Space, C, M,
 * S, K, V, G, T, D, Escape, the blade keys [ ] E X, SystemMonitor's own key).
 *
 * Each of those is bound on `window` so it fires from anywhere, which is
 * exactly wrong while the user is operating a form control: Space activating
 * a focused checkbox or opening a focused <select> is standard browser
 * behaviour, and a global handler that also treats that Space as "start
 * listening" steals the keypress from the control AND does something the
 * user didn't ask for. The original guard only checked for INPUT/TEXTAREA,
 * which missed SELECT, BUTTON (every button this app added — footer icons,
 * Settings, Tasks, the copy-code button — is exactly this) and
 * contentEditable regions.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  if (el.isContentEditable) return true
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON'
}
