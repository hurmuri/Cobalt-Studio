# Cobalt Studio UI Contract

## Canonical UI Map

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
|---|---|---|---|---|
| Select/Listbox | Native select styled by workspace.css and mobile.css | DESIGN.md | Native OS popup | Browser keyboard and open-popup inspection |
| Form | app.js submitDownload/saveSettings and mobile.js submit | Existing API and this contract | Single link, batch links, local-only settings | test/ui-smoke.mjs and test/web.test.mjs |
| Scrollbar | public/theme.css | DESIGN.md | Task list and modal-body scrollers | Desktop and short viewport geometry |
| Toast | app.js showToast | This contract | Success and error | UI smoke and live regions |
| CRUD | app.js taskAction and server.mjs task API | Existing API | Create, retry, cancel, remove history | test/web.test.mjs and test/ui-smoke.mjs |

## Scope and Behavior

Desktop command submission creates tasks with saved defaults and preserves the current link on failure. New Task supports explicit per-download options and batch links. Existing task actions retain their API behavior. Delete removes history only, never media; its confirmation names the task and explains the consequence.

Settings are editable only from the local computer. Opening loads saved values. Cancel or Escape discards the form draft. Save prevents repeat submission, displays inline errors without clearing input, and closes after success. Display settings affect both desktop and companion media rendering. Mobile connectivity investigation remains paused.

Native dialog owns modality, focus containment, Escape, and return focus. Each dialog has an accessible title. Controls use labels and semantic input types. Native select popups remain OS owned; the closed trigger is styled consistently across dialogs. A switch supports Space and exposes its checked state.

The task list and settings body have separate scroll ownership. Settings header and Save/Cancel footer remain available at short heights. Full source URLs remain in real links and tooltips even when the visible text truncates. Post body text is escaped and expands independently of file download actions. The same shared renderer serves desktop and mobile.

## Audit Interpretation

Mobile-access QR selection is explicitly enabled. The address selector defaults to the physical IPv4 route and offers active Tailscale IPv4 addresses. Selection refreshes the QR image, copy target, browser URL and instructions as one operation. Loading clears stale actions; superseded requests are aborted or ignored. Refresh preserves a still-valid choice and falls back to an available address if the old interface disappears. No usable address produces a disabled selector and an actionable empty state. Broader physical-phone connectivity diagnosis remains outside this change.

This project uses vanilla JavaScript addEventListener with external scripts, required by its CSP. The premium static auditor recognizes inline framework handlers but cannot resolve these bindings. Treat actionless-button findings as unresolved static evidence until checked against app.js/mobile.js and browser interaction checks; do not add CSP-incompatible inline handlers to satisfy the scanner. Generated vendor scripts and bundled upstream cobalt interfaces are outside the authored surface.
