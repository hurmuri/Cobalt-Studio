# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| 1.0.19 | Yes |
| Older local builds | No |

## Reporting a vulnerability

Please do not open a public issue for a security report.

Use a private GitHub security advisory:

<https://github.com/hurmuri/Cobalt-Studio/security/advisories/new>

Include the version, the affected surface (desktop, phone page, cobalt child process, or packaging), and a minimal way to reproduce the problem. A fix will be coordinated on that advisory before public details are published.

## Known network boundary

Cobalt Studio has no accounts and no request authentication. The computer running it can be reached by other devices on a network it joins, including a LAN address or a Tailscale address selected in the phone dialog. That exposure is intentional for the phone page.

Do not forward the port to the public internet. A device that can open the service can submit, inspect, retry, and cancel download tasks. Changing the download directory and opening local folders are limited to the same computer.

This boundary is not, by itself, a vulnerability. A bypass of the local-only controls, a way to write outside the configured download directory, or an unintended exposure beyond the selected address should be reported privately.
