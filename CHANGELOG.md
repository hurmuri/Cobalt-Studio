# Changelog

All notable changes to Cobalt Studio are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.19] - 2026-10-22

First public source release.

### Added

- Windows desktop and phone page in front of a self-hosted cobalt 11.7.1 instance.
- Direct download from the address field, separate batch creation, queue, and progress.
- Post metadata, source address, and optional media thumbnails.
- Phone QR codes for a real LAN IPv4 address or a Tailscale address. The code is an isolated SVG with a four-module quiet zone.
- Portable ZIP and a standalone EXE that extracts its runtime on first launch.
- An Instagram compatibility patch so malformed embed markup does not skip cobalt's public fallback.

### Security

- There is no account system. Do not publish the service port to the internet.

[1.0.19]: https://github.com/hurmuri/Cobalt-Studio/releases/tag/v1.0.19
