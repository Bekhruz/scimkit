# Security policy

scimkit sits on the path by which identity providers create, change and disable accounts. Please report
anything that could let a client act outside its tenant, bypass authentication, read data it should not, or
make the service unavailable.

## Reporting a vulnerability

Report privately through GitHub's
[private vulnerability reporting](https://github.com/Bekhruz/scimkit/security/advisories/new). Please do not
open a public issue.

Include what you found, how to reproduce it (a failing test is ideal), and the impact you expect. You can
expect an acknowledgement within three working days and a first assessment within ten. Fixes are released
as patch versions, and the advisory is published once a fix is available. With your permission you will be
credited.

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | ✔         |

## What scimkit does for you, and what it does not

- It verifies bearer tokens and scopes every operation to the tenant of the token. Serve SCIM over HTTPS
  only; tokens are credentials.
- It limits request bodies, filter size and depth, PATCH and bulk sizes. Rate limiting is up to your
  deployment (a reverse proxy or your framework's throttler).
- With `trustProxy`, it trusts `X-Forwarded-Proto` and `X-Forwarded-Host` for building URLs; enable it only
  behind a proxy that sets them. Setting `baseUrl` avoids the question entirely.
- Passwords sent by clients are handed to `hooks.setPassword` and never stored or returned by scimkit.
