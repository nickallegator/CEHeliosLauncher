# CEHelios Backend

Shared Node 22/PostgreSQL backend for authenticated launcher releases and the optional public schematic community. Releases and schematics have independent feature flags, health dependencies, R2 buckets, and credentials.

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

Minecraft access tokens are verified locally as RS256 JWTs against the reviewed
`config/minecraft-auth-keys.json` key set. This avoids a runtime dependency on
Minecraft Services, whose edge may block managed-container egress IPs. The
verifier accepts an emergency `MINECRAFT_AUTH_KEYS_JSON` environment override
using the same document shape. Check for official key rotation before releases:

```console
npm run minecraft-keys:check
npm run minecraft-keys:update
```

Review and deploy any generated key change. Tokens are never logged or sent to
another verification proxy.

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

Collections remain unmounted unless `SCHEMATICS_COLLECTIONS_ENABLED=true`. Creator-profile UI remains disabled unless its independent feature flag is enabled.
