# Changelog

All notable changes to scimkit are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-18

The first release.

### Added

- `ScimServer`: a SCIM 2.0 service provider (RFC 7643, RFC 7644) independent of any HTTP framework, with
  Users, Groups, the Enterprise User extension and custom resource types and schemas; the full filter
  grammar; PATCH with value paths and sub-attributes; sorting, pagination and attribute projection; ETags
  with `If-Match` and `If-None-Match`; `/.search` per resource type and across them; `/Bulk` with `bulkId`
  references; `/Me`; and the discovery endpoints.
- Lenient compatibility mode (the default) for the request shapes Okta and Microsoft Entra ID send, and a
  strict mode.
- Per-tenant bearer tokens (`ScimTokens`, `bearerTokenAuth`, `staticTokenAuth`) stored as SHA-256 hashes.
- `beforeWrite`, `onEvent` and `setPassword` hooks, with lifecycle, activation and membership events.
- `MemoryScimStore` and, in `scimkit/postgres`, `PostgresScimStore` and `PostgresTokenStore` with
  idempotent, concurrency-safe migrations.
- `simpleEquality` for repositories over your own tables.
- Adapters: `ScimModule` for NestJS 10–12 on Express and Fastify (`scimkit/nestjs`), `createNodeHandler`
  and `createFetchHandler`.
- `scimkit/verify` and the `scimkit verify` command: RFC, Okta and Entra conformance profiles for any SCIM
  endpoint. `scimkit migrate` and `scimkit token create | list | revoke`.

[Unreleased]: https://github.com/Bekhruz/scimkit/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Bekhruz/scimkit/releases/tag/v0.1.0
