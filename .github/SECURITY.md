# Security Policy

Rest Hippo is a desktop REST API client. It stores your requests, environments,
secrets, and OAuth tokens locally on your machine and makes network calls to the
endpoints you configure. Because it handles credentials and arbitrary HTTP
traffic, we take security reports seriously.

## Supported Versions

Security fixes are provided for the latest released version. We do not backport
fixes to older releases.

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
discussions, or pull requests.**

Instead, report them privately through GitHub's private vulnerability reporting:

1. Go to the [Security tab](https://github.com/jfigge/resthippo/security) of this
   repository.
2. Click **Report a vulnerability**.
3. Fill out the advisory form with the details below.

This routes the report directly and privately to the maintainer.

Please include as much of the following as you can:

- The type of issue (e.g. credential exposure, code execution, path traversal,
  SSRF, insecure token storage).
- The affected component (main process, renderer, OAuth/PKCE flow, storage layer,
  import/export, etc.) and the platform (macOS, Windows, Linux).
- The Rest Hippo version and OS version.
- Step-by-step instructions to reproduce, including any sample request,
  collection, or configuration needed.
- Proof-of-concept, and the impact you believe an attacker could achieve.

## What to Expect

- **Acknowledgement** within 5 business days.
- An initial assessment and severity triage within 10 business days.
- Progress updates as we investigate and prepare a fix.
- Coordinated disclosure: we will agree on a disclosure timeline with you and
  credit you in the release notes and published advisory unless you prefer to
  remain anonymous.

Thank you for helping keep Rest Hippo and its users safe.
