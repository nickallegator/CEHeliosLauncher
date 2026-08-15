# Allegator Games Launcher Backend

Shared Node 22/PostgreSQL backend for authenticated launcher releases and the public multi-type Community catalog. Release objects remain isolated; Schematics and the generic Community types can share a private content bucket through separate prefixes and configuration namespaces.

## Local setup

Copy `.env.example` to `.env`, configure `DATABASE_URL`, then run:

```console
npm install
npm run db:migrate
npm start
```

Migrations in `backend/migrations` are the only schema source of truth. `npm run db:setup` is retained as a compatibility alias and applies the same migration chain.

Useful migration commands:

```console
npm run db:migrate
npm run db:migrate:test
npm run db:migrate:all
```

## Container

Build the provider-neutral image from the repository root so the shared schematic package is included:

```console
docker build -f backend/Dockerfile -t cehelios-backend .
```

Run migrations as a release job before starting a new image. Use `/health` for liveness and `/ready` for PostgreSQL and enabled-feature dependency readiness.

## Release channel

The release service uses `RELEASES_*` configuration and a private `cobblepower-releases` bucket. It issues short-lived signed artifact downloads only to Minecraft UUIDs on the test allowlist.

```console
npm run testers:add -- --uuid <minecraft-uuid> --label "Tester name"
npm run testers:disable -- --uuid <minecraft-uuid>
npm run testers:list
```

`GET /v1/releases/channels/test/distribution` requires an authenticated backend session and `cobblepower:test`.

## Schematic community

The schematic service uses a separate private R2 bucket and `SCHEMATICS_*` credentials. Production startup fails if schematics are enabled without object storage. Upload finalization validates and canonicalizes v2 content, strips community block-entity NBT, and creates immutable 128px and 512px PNG/WebP thumbnails.

See [the deployment runbook](../docs/schematics-community-deployment.md) for the two-service Render/R2 configuration, pilot release, and operating schedule.

Grant generic UUID entitlements after migrations:

```console
npm run entitlements:grant -- --uuid <minecraft-uuid> --entitlement schematics:admin --label "Owner"
npm run entitlements:revoke -- --uuid <minecraft-uuid> --entitlement schematics:admin
npm run entitlements:list -- --entitlement schematics:admin
```

Run the daily existence scan and weekly canonical verification in bounded batches:

```console
npm run schematics:scan -- --limit 500
npm run schematics:scan -- --verify-hash true --limit 500
```

## API summary

Authentication and access:

- `GET /health` and `GET /ready`
- `POST /v1/auth/minecraft`
- `GET /v1/entitlements` and `GET /v1/me`

Schematic reads are public; mutations require a Minecraft backend session:

- `GET /v1/schematics/capabilities`
- `GET /v1/community/capabilities`
- `GET /v1/community/catalog?category=all|schematics&sort=popular|recent&limit=<n>&cursor=<opaque>`
- `GET /v1/schematics` and `GET /v1/schematics/:id`
- `POST /v1/schematics/uploads`
- `POST /v1/schematics/uploads/:token/finalize`
- `GET /v1/schematics/:id/download`
- `GET /v1/schematics/:id/thumbnail?size=tiny|medium`
- `PATCH` and `DELETE /v1/schematics/:id`
- `POST`/`DELETE /v1/schematics/:id/like`
- `POST /v1/schematics/:id/view` and `POST /v1/schematics/:id/report`
- `/v1/schematics/admin/*` plus hide/restore/delete moderation
- Legacy `preflight` and `upload/:token` endpoints temporarily adapt to the v2 pipeline

The Community catalog is a read-only provider facade; existing schematic routes remain the source of type-specific details and mutations. Public catalog responses use ETags and stable cursor ordering. Personalized `mine=true` responses require a backend session and are never publicly cacheable.

Collections remain unmounted unless `SCHEMATICS_COLLECTIONS_ENABLED=true`. Their API/data is preserved, but the launcher intentionally hides Collection and Creator-profile navigation until a future cross-type Community destination is enabled.

## Multi-type Community content

`COMMUNITY_ENABLED=true` activates the generic Community platform. Each provider is independently gated by `COMMUNITY_AUTOMATION_ENABLED`, `COMMUNITY_BATTLE_TRAINERS_ENABLED`, `COMMUNITY_BUILDER_PRESETS_ENABLED`, and `COMMUNITY_RESOURCE_PACKS_ENABLED`. Start with all four false, then enable Builder Presets, Battle Trainers, Automation, and Resource Packs in that order after pilots pass.

The backend validates against the committed Cobble Power 1.0.4 contract matrix in `config/community-compatibility-1.0.4-test.1.json`. Uploads require a Minecraft-authenticated session, an approved license, rights attestation, and public visibility. Artifacts and previews are immutable after finalization; updates create revisions.

`COMMUNITY_RICH_PREVIEWS_ENABLED=true` enables immutable Resource Pack render overlays and the signed preview-assets API after the `community_revision_assets` migration has run. Keep it disabled until Cobble Power 1.0.4 and AG Launcher 2.5.0 are deployed and their contract and render-registry hashes have passed release promotion.

`COMMUNITY_PACK_STUDIO_ENABLED=true` enables opted-in Resource Pack component search, resolution, and owner grant management after `2026-08-14_resource_pack_studio.sql` has run and existing revisions have been indexed with `npm run community:pack-studio:index`. Set the same flag on the release-only service so authorized distributions advertise Pack Studio, while leaving `COMMUNITY_ENABLED=false` and Community storage credentials unset there. Resolution defaults to 120 requests per IP per hour through `COMMUNITY_COMPOSER_RESOLVES_PER_HOUR`.

Use `COMMUNITY_STORAGE_*` for the shared Community bucket. During migration, omitted values fall back one-for-one to `SCHEMATICS_STORAGE_*`. Signed upload and download URLs expire after 15 minutes. Resource Pack ZIPs are streamed through bounded temporary files and are never expanded into memory.

Generic endpoints are:

- `GET /v1/community/items/:type/:id`
- `GET /v1/community/items/:type/:id/download`
- `GET /v1/community/items/:type/:id/preview`
- `POST /v1/community/uploads` and `POST /v1/community/uploads/:token/finalize`
- Owner metadata, deletion, engagement, report, and administrator moderation routes under `/v1/community`

Deployment, installation-safety, and staged rollout details are documented in `docs/community-content-platform.md` at the repository root.
# Modrinth Resource Pack sources

The optional authenticated, read-only Modrinth source integration is documented in [`../docs/modrinth-resource-pack-sources.md`](../docs/modrinth-resource-pack-sources.md). Keep it disabled until migration, OAuth registration, managed secrets, and the 15-minute synchronization job are configured.
