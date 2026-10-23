# Third-party notices

Cobalt Studio is AGPL-3.0-only. That license does not replace the licenses
of the components below. Do not remove their notices, and do not treat their
source as relicensed merely because it is shipped beside this program.

## cobalt

- Project: [imputnet/cobalt](https://github.com/imputnet/cobalt)
- Version used by Cobalt Studio 1.0.19: 11.7.1
- Commit: [`a636575b09de1fc55d9b8cd98cac88f5f2f16b42`](https://github.com/imputnet/cobalt/commit/a636575b09de1fc55d9b8cd98cac88f5f2f16b42)
- License: AGPL-3.0-only
- Copyright: imput and contributors
- How it is obtained: `scripts/setup-cobalt.ps1` clones that exact commit into `cobalt-api/`. The checkout is intentionally not stored in this repository.
- Local change: `scripts/patch-cobalt.mjs` is applied to release staging only. It keeps a malformed Instagram embed page from skipping cobalt's later public fallback. The vendored checkout itself stays unmodified.

Portable builds copy the cobalt license and the cobalt API source they ship into the package as `COBALT-LICENSE.txt`, `COBALT-API-LICENSE.txt`, and `cobalt-api/`.

## FFmpeg

- Build: FFmpeg 6.1.1 essentials, 64-bit Windows, from [gyan.dev](https://www.gyan.dev/ffmpeg/builds/)
- Package: `ffmpeg-static` 5.3.0, GPL-3.0-or-later
- Upstream source identified by that build: <https://github.com/FFmpeg/FFmpeg/commit/e38092ef93>
- License: GPL-3.0
- Role: separate `ffmpeg.exe` used to merge and transcode media. It is not statically linked into the Cobalt Studio executable.
- Packaged notices: `FFMPEG-LICENSE.txt` and `ffmpeg.exe.LICENSE`

## Node.js

- License: MIT, plus the third-party licenses shipped with Node.js
- Source: <https://github.com/nodejs/node>
- Packaged notice: `NODE-LICENSE.txt`
- Cobalt Studio requires Node.js 20 or newer to run from source. Portable builds include a Node.js runtime.

## GSAP

- Files: `public/vendor/gsap.min.js`, `public/vendor/ScrollTrigger.min.js`, and the `gsap` npm dependency
- Version: 3.14.2
- Copyright: (c) 2008-2025, GreenSock / Webflow
- License: GSAP Standard "No Charge" License, <https://gsap.com/standard-license>
- These files are not AGPL and are not OSI open-source. The standard license permits this unpaid application to use and distribute them. Do not remove the notice in `public/vendor/NOTICE.md`.

## qrcode

- Package: `qrcode` 1.5.4
- Author: Ryan Day
- License: MIT
- Homepage: <https://github.com/soldair/node-qrcode>

## Cabinet Grotesk

- Files: `public/fonts/cabinet-400.woff2`, `cabinet-500.woff2`, `cabinet-700.woff2`
- Designer / publisher: Indian Type Foundry, served by Fontshare
- License: ITF Free Font License, <https://www.fontshare.com/licenses/itf-free-font-license>
- The font files are bundled for offline use. They are not AGPL. See `public/fonts/SOURCE.md`.

## .NET and WebView2

- The Windows desktop host and standalone launcher are built with the .NET SDK. The .NET runtime is licensed under MIT: <https://github.com/dotnet/runtime>
- UI hosting uses the Microsoft WebView2 SDK, `Microsoft.Web.WebView2`. Its license is the license attached to that NuGet package: <https://www.nuget.org/packages/Microsoft.Web.WebView2>
- The Evergreen WebView2 Runtime is installed separately on Windows and remains Microsoft software.

## Other cobalt dependencies

The cobalt API has its own production dependency tree, installed with pnpm from the lockfile in the pinned checkout. Those packages remain under the licenses in their own `package.json` and `LICENSE` files. They are fetched locally and are not vendored into this Git repository.
