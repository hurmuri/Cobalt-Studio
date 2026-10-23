# Cobalt Studio Agent Instructions

## Scope and Product

- This folder is the Git repository published at https://github.com/hurmuri/Cobalt-Studio. Do not create a nested repository or change sibling projects. Never commit `cobalt-api/`, dependencies, release binaries, `.data/`, `downloads/`, `.build/`, or secrets.
- Cobalt Studio is AGPL-3.0-only because it patches and distributes cobalt. Do not relicense cobalt, FFmpeg, GSAP, Cabinet Grotesk, or other third-party components. The pinned cobalt revision lives in `UPSTREAM.json`.
- Read README.md, DESIGN.md, UX-CONTRACT.md and the relevant files in docs/ before changes. User instructions take precedence.
- This is a Windows download tool, not a landing page. Keep task controls immediately available. Do not add a heading, subtitle, slogan or decorative statistics above the downloading/completed tabs. Avoid ornamental copy and unnecessary whitespace.
- Preserve desktop and mobile task operations, source metadata, native folder opening and local-only settings authorization. Phone connectivity investigation is paused until the user explicitly resumes it.

## Current Defaults

- Windows download directory: `D:\downloads\cobalt`. Default concurrent downloads: 5. Supported choices: integers 1 through 10, consistently in the settings UI and scheduler.
- Existing user-selected settings persist. Missing directories are created when needed; never silently replace a saved path with the application directory.
- A request to change defaults applies to fresh settings; when the user also expects the running app to change, apply those specific settings through its local API and preserve unrelated settings.
- Existing task file paths remain valid. Changing the download directory affects new downloads; do not move or delete historical media without a separate user request.

## Code and Layout

- Root `.mjs` files are the server/CLI/MCP entry points. `lib/` owns queue/config/storage/download logic, `public/` owns the UI, `windows/` owns the WinForms/WebView2 host, `scripts/` owns startup/setup/release automation, `test/` owns maintained checks, and `docs/` owns workflow documentation.
- Shared UI tokens live in public/theme.css; desktop rules in public/workspace.css; post-view.js is shared with mobile. Keep text, icons and controls vertically centered, with consistent actual heights and padding; verify rendered geometry rather than CSS declarations alone.
- Mobile-access QR selection supports active physical IPv4 addresses and Tailscale. Default to the physical route; exclude host-only VM/container/loopback/link-local addresses. Render QR as an isolated SVG image with a four-module quiet zone and integer module size; generic icon strokes must never affect its modules. Verify decoded browser screenshots, address/link synchronization, refresh and empty/error states. This authorizes QR/address improvements, while broader phone connectivity diagnosis remains paused.
- Do not add React or a UI framework for small changes. Reuse the installed vanilla JS/native control implementation.
- Keep one-off screenshots and experiments under `.build/diagnostics/`. Keep screenshots and validation artifacts under `.build/verification/`. Keep active packaging staging and dependency fallback directories at their documented paths.
- Keep user state `.data/`, historical `downloads/`, `D:\downloads\cobalt`, and installed/upstream dependencies out of cleanup. Do not move `cobalt-api/` or `node_modules/`. Never stop unrelated services.

## Verification and Release

- Use PowerShell 7. Run the full `npm test` suite for a release; targeted checks are diagnostic only. The release script also performs the portable application smoke test.
- The only supported release entry is `scripts/release.ps1`; root `release.cmd` is its convenience wrapper. Default release command: `pwsh -NoProfile -File .\scripts\release.ps1 -Bump patch -Notes "..."`.
- Do not bypass full tests or release smoke for delivery. Do not call build-portable.ps1 directly for a release. Never overwrite an existing version unless explicitly requested.
- Runnable portable directory is always `release\Cobalt Studio\`. Each delivery has its own `release\artifacts\<VERSION>\` containing `Cobalt-Studio-v<VERSION>-win-x64.zip`, the independently runnable `Cobalt-Studio-v<VERSION>-win-x64.exe`, the manifest and SHA256SUMS.txt. Global latest pointers stay in `release\artifacts\`.
- The standalone launcher embeds the portable ZIP. Verify it copied alone into an empty folder, including a real media download and cached restart with persistent task IDs. Its replaceable runtime cache is under `%LOCALAPPDATA%\Cobalt Studio\runtimes`; persistent state is under `%LOCALAPPDATA%\Cobalt Studio\data`, independent of version. Never clean that data as a runtime cache.
- Keep upstream compatibility patches in scripts/patch-cobalt.mjs, apply to staged releases, and verify fallback behavior in test/instagram.test.mjs. Do not modify the nested upstream checkout for local fixes.
- Version changes must flow through scripts/sync-version.ps1. Follow docs/RELEASING.md: synchronize, test, stop this app only, back up user state, build, smoke, clean disposable smoke state, pack, hash, restore and verify user-state hashes, restart, then verify the running version.
- The cleanup helper must never delete `.build/runtime-state`; only a successful verified restoration may retire that recovery backup. Preserve an independent before-release snapshot when changing packaging or state handling.
- Verify archive and EXE hashes against the release manifest, check the running version, confirm original task IDs/media files, and distinguish browser UI checks from physical phone acceptance.

## Required Delivery Response

After EVERY completed package build, provide the user:

1. The actual released version and a concise list of changes.
2. The FULL absolute paths of BOTH the ZIP and the standalone EXE.
3. Clickable Markdown links to BOTH exact files, using full absolute paths.
4. What was actually verified and any remaining blocker.

`release/artifacts/latest.json` and `LATEST.md` identify the latest verified delivery. Never report stale links, only one deliverable, only a screenshot, or only the package directory. Delete verified obsolete build experiments when requested, preserving runtime-state recovery, independent user snapshots and all historical media.
