# Contributing

Thanks for looking at Cobalt Studio. The useful contributions are bug fixes, packaging fixes, accessibility, and small interface corrections that preserve the current layout.

## License of contributions

By submitting a contribution, you agree that it is licensed under AGPL-3.0-only, the same license as this repository. Do not contribute code you are not allowed to license that way.

Third-party material must keep its own license. In particular, do not relicense or edit the vendored GSAP files, font files, or the pinned cobalt checkout. Cobalt changes belong in a reviewed patch under `scripts/` and must remain AGPL-compatible.

## Setup

Requirements are Windows, Git, Node.js 20 or newer, pnpm, and the .NET 10 SDK for the desktop host.

```powershell
npm install
pwsh -NoProfile -File .\scripts\setup-cobalt.ps1
.\start.cmd
```

`setup-cobalt.ps1` fetches the cobalt commit in `UPSTREAM.json`. It does not upgrade cobalt on its own. Changing that pin requires checking the Instagram patch and the release smoke test.

## Checks

Unit checks that do not download media:

```powershell
node test/config.test.mjs
node test/network.test.mjs
node test/instagram.test.mjs
```

A release still uses the full suite through `scripts/release.ps1`. Do not skip it for a version that will be published. The release entry is `release.cmd` or `scripts/release.ps1`; do not call the lower-level build scripts directly for a release.

## Product boundaries

- Keep the task list usable. Do not add a page title, slogan, or decorative statistics above the download tabs.
- Phone connectivity beyond the address selector is a separate problem. Do not expand a QR or copy change into a network redesign unless that is the requested bug.
- Do not commit `cobalt-api/`, `node_modules/`, `release/`, `.build/`, `.data/`, `downloads/`, secrets, or personal media.
- Do not add a login bypass, DRM bypass, or private-content workaround. Public cobalt behavior is the limit.

## Pull requests

Describe the user-visible change, the risk, and how you checked it. Screenshots help for interface changes. A change to licensing, upstream pinning, or packaging needs the exact files and commands you ran.
