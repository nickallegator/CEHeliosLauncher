# Schematic Community Deployment Runbook

This release keeps private mod delivery and the public schematic community independent. Both services use the same OCI image and PostgreSQL database so Minecraft sessions work across services, but they use separate feature flags and R2 credentials.

## 1. Create the private R2 bucket

Create `cobblepower-schematics` in the same Cloudflare account as the release bucket. Do not enable `r2.dev` or a public custom domain. Create a bucket-scoped credential that can read, write, list, and delete objects in this bucket only.

Configure CORS for the launcher origins used by Electron signed uploads:

```json
[
  {
    "AllowedOrigins": ["*"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["content-type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 900
  }
]
```

The bucket remains private; possession of a short-lived presigned URL authorizes only that transfer. Add a lifecycle rule that expires `pending/` objects after one day. Do not expire `schematics/` or `thumbnails/` objects.

## 2. Build and migrate

Build from the repository root so the shared parser is included:

```console
docker build -f backend/Dockerfile -t cehelios-backend .
```

Run `npm run db:migrate --prefix backend` as a one-off release job against the managed TLS `DATABASE_URL` before either service uses the new image. Migrations are idempotent and are the schema source of truth.

For a database containing legacy schematic rows, run one validation pass before enabling public reads. It backfills migration-compatible rows and quarantines current revisions whose R2 objects, thumbnails, canonical metadata, or hash are invalid:

```console
npm run schematics:scan --prefix backend -- --verify-hash true --quarantine-invalid true --limit 500
```

## 3. Preserve the release service

The existing release API keeps:

```text
RELEASES_ENABLED=true
SCHEMATICS_ENABLED=false
SCHEMATICS_PUBLIC_API_URL=https://cobblepower-schematics-api.onrender.com
```

Do not provide schematic R2 credentials to this service. The public URL is injected into each freshly authorized launcher distribution, so changing the schematic service host does not require a launcher rebuild.

## 4. Create the Virginia schematic service

Create a second Render Web Service in Virginia from the same repository and `backend/Dockerfile`. Use the repository root as the Docker build context. Configure `/health` as liveness and `/ready` as readiness.

Set:

```text
NODE_ENV=production
TRUST_PROXY=true
BASE_URL=https://cobblepower-schematics-api.onrender.com
CORS_ORIGINS=null
DATABASE_URL=<the same managed PostgreSQL internal/TLS URL>
RELEASES_ENABLED=false
SCHEMATICS_ENABLED=true
SCHEMATICS_WRITE_MODE=admin
SCHEMATICS_COLLECTIONS_ENABLED=false
SCHEMATICS_CREATORS_ENABLED=false
SCHEMATICS_DEVELOPMENT_SEEDS=false
SCHEMATICS_UPLOADS_PER_HOUR=10
SCHEMATICS_REPORTS_PER_DAY=10
SCHEMATICS_STORAGE_PROVIDER=r2
SCHEMATICS_STORAGE_BUCKET=cobblepower-schematics
SCHEMATICS_STORAGE_REGION=auto
SCHEMATICS_STORAGE_ENDPOINT=https://<cloudflare-account-id>.r2.cloudflarestorage.com
SCHEMATICS_STORAGE_ACCESS_KEY_ID=<schematic bucket credential>
SCHEMATICS_STORAGE_SECRET_ACCESS_KEY=<schematic bucket secret>
SCHEMATICS_STORAGE_FORCE_PATH_STYLE=false
SCHEMATICS_STORAGE_PUT_TTL_SECONDS=900
SCHEMATICS_STORAGE_GET_TTL_SECONDS=900
```

`CORS_ORIGINS=null` allows Electron's `file://` origin. If web clients are added later, use an explicit comma-separated origin allowlist instead.

Verify `GET /health` returns HTTP 200 and `GET /ready` reports database and schematics storage as `ok`. A schematic-only service must not require the release bucket.

## 5. Grant administration and publish the pilot

From a one-off shell with `DATABASE_URL` configured:

```console
npm run entitlements:grant --prefix backend -- --uuid <owner-minecraft-uuid> --entitlement schematics:admin --label "Owner"
npm run entitlements:list --prefix backend -- --entitlement schematics:admin
```

Sign into the launcher with that Microsoft/Minecraft account and upload one genuine `cobblepower_schematic` v2 file. The response must report `schemaVersion: 2`, revision 1, a canonical SHA-256, block count, and the number of stripped block-entity NBT values. Confirm anonymous catalog/detail/download access and all four thumbnail variants.

## 6. Roll out compatible clients

Promote Cobble Power `1.0.2-test.1` through the existing tag-driven test channel. Build launcher `2.3.1-test.1`, test from an installed Windows shortcut, and distribute the installer. Confirm installation writes only to the selected profile under `config/cobblepower/schematics/<player-uuid>/`.

After the pilot acceptance matrix succeeds, change `SCHEMATICS_WRITE_MODE` from `admin` to `authenticated` and restart the schematic service. No launcher or backend image rebuild is required.

## 7. Operations

Run daily object and thumbnail existence checks:

```console
npm run schematics:scan --prefix backend -- --limit 500
```

Run the canonical hash check weekly in bounded batches:

```console
npm run schematics:scan --prefix backend -- --verify-hash true --limit 500
```

Exit code 2 means integrity issues were found; exit code 1 means the scan itself failed. Alert on `/ready` failures, repeated finalization failures, elevated 429/5xx rates, and scan non-zero exits. Logs contain request IDs and schematic audit events; presigned query strings must never be logged.
