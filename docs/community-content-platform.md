# Community Content Platform

This document describes the multi-type Community platform introduced for AG Launcher 2.4.0 and Cobble Power 1.0.3. Schematics retain their existing storage and APIs; Automation bundles, Battle Trainers, Builder Presets, and Resource Packs use the generic platform.

## Release boundary

The mod owns portable artifact contracts. `generateCommunityContracts` writes the registry, canonical fixtures, and a deterministic contract hash. The mod release workflow publishes those files beside the JAR. The launcher promotion workflow verifies the release checksums and the publisher refuses to enable new types unless the contract declares all four supported format IDs and versions.

The backend compatibility matrix at `backend/config/community-compatibility-1.0.3-test.1.json` is the deployed policy. A type must be supported by the mod contract, backend matrix, authorized distribution, and launcher registry before it is shown.

## Storage and immutability

Generic artifacts use the private Community bucket:

```text
pending/community/<upload-id>/artifact
pending/community/<upload-id>/preview
community/<type>/<sha-prefix>/<sha256>.<extension>
community/previews/<revision-id>/tiny.webp
community/previews/<revision-id>/medium.webp
```

Finalization downloads pending uploads into bounded temporary files, validates and canonicalizes them, verifies compatibility and licensing, writes content-addressed immutable objects, and commits item/revision metadata transactionally. Failed validation creates no public revision. Configure a one-day R2 lifecycle rule for `pending/community/`.

Run `npm run community:scan` from `backend/` for the daily existence scan. Set `COMMUNITY_INTEGRITY_FULL_HASH=true` for the weekly streamed hash verification. The scheduled GitHub workflow supports both modes.

## Configuration

Preferred variables are:

```text
COMMUNITY_ENABLED=true
COMMUNITY_PUBLIC_API_URL=https://<community-service-host>
COMMUNITY_STORAGE_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
COMMUNITY_STORAGE_REGION=auto
COMMUNITY_STORAGE_BUCKET=cobblepower-schematics
COMMUNITY_STORAGE_ACCESS_KEY_ID=<read-write-service-key>
COMMUNITY_STORAGE_SECRET_ACCESS_KEY=<read-write-service-secret>
COMMUNITY_WRITE_MODE=authenticated
COMMUNITY_AUTOMATION_ENABLED=false
COMMUNITY_BATTLE_TRAINERS_ENABLED=false
COMMUNITY_BUILDER_PRESETS_ENABLED=false
COMMUNITY_RESOURCE_PACKS_ENABLED=false
```

The storage and public URL settings fall back to their `SCHEMATICS_*` equivalents during migration. Keep the type flags off until the matching mod contract, backend deployment, pilot artifact, and packaged launcher test have passed.

## Installation ownership

The launcher writes an atomic generic installation index in its Community cache. Each entry records the profile, optional account UUID, Community type/item, revision, source hash, managed paths, installed hashes, UUID mappings, dependencies, and Resource Pack state.

- Automation and trainer content is profile- and account-scoped.
- Builder presets are profile-scoped.
- Resource Packs are profile-scoped and are enabled at highest priority on first install.
- Revision updates are always manual.
- Modified or untracked files are not replaced or removed without confirmation.
- Automation asset UUID mappings are retained across updates.
- Resource Pack changes are applied only while Minecraft is stopped, with an atomic `options.txt` backup.

The existing schematic install index remains a compatibility adapter for installed 2.3.x content. Schematics continue through their proven installer while all new content uses the generic index; a future schema migration can unify the two without risking existing user-managed files.

## Publication and moderation

Browsing is public. Publishing and engagement require a valid Minecraft backend session. Publishing requires an allowed license plus the rights-distribution attestation. Only public visibility is accepted. Reports never hide content automatically; administrators can hide, restore, delete, and inspect audit events.

The custom `Community-Use-1.0` terms are served by the API and stored with the repository. SPDX license identifiers redirect to their canonical license page.

## Local Community showroom

Run `run-community-showroom.cmd` from the launcher repository to open a disposable, read-only catalog with representative Automation, Battle Trainer, Builder Preset, and Resource Pack artifacts. The showroom binds to `127.0.0.1`, redirects Community and access calls to its temporary local API, disables publication and game launch, and removes its temporary launcher and Minecraft data after the window closes.

Use `run-community-showroom.cmd --keep-data` to preserve the generated instance for inspection, or `run-community-showroom.cmd --data-dir <path>` to use an explicit persistent location. The showroom never reads or writes the installed launcher's profile, production PostgreSQL database, or R2 bucket.

## Rollout

1. Apply migrations and deploy the backend with all new provider flags disabled.
2. Publish Cobble Power 1.0.3-test.1 and verify the Community contract artifact.
3. Publish and validate one owner pilot for each provider in staging.
4. Package and acceptance-test AG Launcher 2.4.0-test.1.
5. Enable Builder Presets, Battle Trainers, Automation, and Resource Packs one at a time.
6. Confirm browse, publish, install, manual update, modification protection, removal, offline use, and Minecraft loading for each type.

Rollback disables the affected provider flag and restores the prior launcher/mod release. Immutable objects and database history are retained.
