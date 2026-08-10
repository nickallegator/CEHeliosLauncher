# CEHelios Access Backend

Shared backend for authenticated launcher releases, entitlements, and optional schematics services.

The release and schematics modules use separate feature flags, buckets, credentials, and readiness dependencies. For the Cobble Power test deployment, set `RELEASES_ENABLED=true` and `SCHEMATICS_ENABLED=false`.

## Setup

1) Create a Postgres database and run the schema:

```
psql %DATABASE_URL% -f schema.sql
```

If you use Docker Postgres in PowerShell (example container: `cehelios-postgres`), run:

```
Get-Content schema.sql | docker exec -i cehelios-postgres psql -U postgres -d cehelios
```

2) Copy `.env.example` to `.env` and fill in values.

3) Install deps and run:

```
npm install
npm start
```

## Migrations

Apply migrations from `backend/migrations` using the configured `DATABASE_URL`:

```
npm run db:migrate
```

To migrate the test database (uses `DATABASE_URL_TEST`):

```
npm run db:migrate:test
```

To migrate both main + test in one shot:

```
npm run db:migrate:all
```

## Object Storage (R2/S3)

### Private test releases

Create a private `cobblepower-releases` R2 bucket and a bucket-scoped API token. Do not enable `r2.dev` or a public custom domain. Configure `RELEASES_STORAGE_*` as shown in `.env.example`; signed downloads default to 3600 seconds.

Manage the Minecraft UUID allowlist after migrations:

```console
npm run testers:add -- --uuid <minecraft-uuid> --label "Tester name"
npm run testers:disable -- --uuid <minecraft-uuid>
npm run testers:list
```

Release endpoints:

- `GET /ready` checks PostgreSQL and the current release pointer when releases are enabled.
- `GET /v1/releases/channels/test/distribution` requires a backend bearer session and an active allowlisted Minecraft UUID.

Build the provider-neutral container from this directory:

```console
docker build -t cehelios-access-backend .
```

Run `npm run db:migrate` as a one-off release job before starting the new image. Configure the managed service with TLS PostgreSQL, HTTPS at a stable API domain, `/health` for liveness, `/ready` for readiness, and managed secrets. Retain structured logs and alert on elevated 401, 403, 429, and 5xx rates.

### Schematics

For signed uploads (schematics + thumbnails) configure these in `backend/.env`:

```
SCHEMATICS_STORAGE_PROVIDER=r2
SCHEMATICS_STORAGE_BUCKET=cehelios-schematics
SCHEMATICS_STORAGE_REGION=auto
SCHEMATICS_STORAGE_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
SCHEMATICS_STORAGE_ACCESS_KEY_ID=...
SCHEMATICS_STORAGE_SECRET_ACCESS_KEY=...
SCHEMATICS_STORAGE_PUBLIC_BASE_URL=https://assets.yourdomain.com
SCHEMATICS_STORAGE_FORCE_PATH_STYLE=false
SCHEMATICS_STORAGE_PUT_TTL_SECONDS=900
SCHEMATICS_STORAGE_GET_TTL_SECONDS=900
SCHEMATICS_STORAGE_PUBLIC_CACHE_CONTROL=public, max-age=31536000, immutable
SCHEMATICS_STORAGE_PRIVATE_CACHE_CONTROL=private, max-age=60
SCHEMATICS_STORAGE_REDIRECT_CACHE_CONTROL=public, max-age=86400
```

Notes:
- `PUBLIC_BASE_URL` is optional but recommended for CDN delivery.
- Cache controls are applied to stored objects and redirect responses; tune to your CDN policy.
- If object storage is not configured, uploads fall back to local storage.

### Lifecycle + Integrity

Recommended bucket rules (examples):
- Expire thumbnail objects older than 30–90 days.
- Keep deduped schematic blobs indefinitely.
- Optionally keep previous versions for N days if you re-upload versions.

Run a lightweight integrity scan:

```
npm run schematics:scan
```

Flags (optional):
- `--verify-hash true` downloads JSON schematics and recomputes hashes (slow).
- `--verify-thumbnails false` skips thumbnail existence checks.
- `--limit 200 --offset 0` for batch runs.

### Thumbnail Regeneration Helper

Use the helper to fetch missing thumbnail upload URLs and upload regenerated images:

```
npm run schematics:thumbnails:regenerate -- --base-url https://your-backend.example.com --token <adminToken>
```

Optional flags:
- `--ids <uuid,uuid>` to target specific schematics.
- `--limit 25 --offset 0` for batch runs.
- `--labels tiny,medium --mimes image/webp,image/png`
- `--renderer path/to/renderer.js` (invoked as `node renderer.js --input <file> --output <file> --width 128 --height 128 --mime image/png --label tiny`)
- `--sizes tiny=128,medium=512` to override label sizes.

If no renderer is supplied, the helper uploads a tiny placeholder image so you can verify the pipeline end-to-end.

Stub renderer:
- `tools/thumbnail-renderer/index.js` provides a drop-in CLI that writes a placeholder image.

## Endpoints

Health/Auth:
- `GET /health` -- health check
- `GET /ready` -- dependency readiness check
- `GET /auth/patreon/start?redirect=<url>` -- starts Patreon OAuth flow
- `GET /auth/patreon/callback` -- Patreon OAuth callback
- `POST /v1/auth/minecraft` -- exchange Minecraft access token for a backend session
- `GET /v1/entitlements` -- returns `{ entitlements: [] }` for a valid session token
- `GET /v1/me` -- returns session user profile (includes `id`)

Schematics:
- `GET /v1/schematics` -- list schematics (filters: `query`, `tags`, `creator`, `mine`, `page`, `pageSize`)
- `GET /v1/schematics/:id` -- schematic detail
- `GET /v1/schematics/share/:token` -- share-link detail
- `POST /v1/schematics/preflight` -- signed upload URLs for schematic and thumbnails
- `POST /v1/schematics/upload/:token` -- finalize metadata after upload
- `PATCH /v1/schematics/:id` -- update editable fields (owner only)
- `DELETE /v1/schematics/:id` -- soft delete (owner only)
- `POST /v1/schematics/:id/like` -- like schematic (owner-only for private)
- `DELETE /v1/schematics/:id/like` -- remove like
- `POST /v1/schematics/:id/view` -- record a view (owner-only for private)
- `POST /v1/schematics/:id/report` -- report schematic
- `GET /v1/schematics/tags` -- list tags
- `POST /v1/schematics/:id/thumbnail/preflight` -- signed upload URL for a new thumbnail
- `POST /v1/schematics/:id/thumbnail/commit` -- finalize thumbnail metadata
- `GET /v1/schematics/:id/thumbnail?size=tiny|medium` -- proxy/redirect thumbnail by size label
- `POST /v1/schematics/thumbnails/regenerate` -- admin batch: returns missing thumbnail upload URLs (optionally cleans stale DB rows)

Collections:
- `GET /v1/collections` -- list collections (filters: `visibility`, `creator`, `query`, `sort`, `mine`, `limit`, `offset`)
- `GET /v1/collections/:id` -- collection detail (includes items)
- `GET /v1/collections/share/:token` -- share-link detail
- `POST /v1/collections` -- create collection
- `PATCH /v1/collections/:id` -- update collection
- `DELETE /v1/collections/:id` -- delete collection
- `POST /v1/collections/:id/like` -- like collection
- `DELETE /v1/collections/:id/like` -- unlike collection
- `POST /v1/collections/:id/view` -- record collection view
- `POST /v1/collections/:id/items` -- add schematic to collection
- `DELETE /v1/collections/:id/items/:schematicId` -- remove schematic from collection

## Launcher Integration

Set in your distribution index:

```json
{
  "access": {
    "apiBaseUrl": "https://your-backend.example.com",
    "authUrl": "https://your-backend.example.com/auth/patreon/start"
  }
}
```

The launcher calls `GET /v1/entitlements` with:

```
Authorization: Bearer <sessionToken>
```

## Notes

- Entitlements are stored as strings (ex: `patreon:dev`) in the `entitlements` table.
- Tier mapping is configured via `PATREON_TIER_MAP` (ex: `12345=patreon:dev`).
