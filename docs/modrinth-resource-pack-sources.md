# Modrinth Resource Pack Sources

AG Community can publish reviewed Resource Pack revisions whose immutable ZIP remains on Modrinth. The backend stores provider identifiers, verified SHA-512/SHA-256 values, component indexes, and generated thumbnails. It never mirrors the source ZIP or a render-overlay ZIP into R2.

## Security boundary

- OAuth requests only `USER_READ` and `PROJECT_READ`.
- The Modrinth client secret and access tokens are backend-only.
- Access tokens use AES-256-GCM at rest. Generate a 32-byte key and retain it in managed secrets.
- A project claim requires an accepted team member whose Modrinth permission bitfield includes `UPLOAD_VERSION`.
- Every publish re-resolves, streams, hashes, and validates the exact selected ZIP after preparation.
- Launcher downloads are accepted only after the stored AG SHA-256 and size pass local validation.
- Direct R2 publication remains available and uses the same Community APIs.

## Production configuration

Register a Modrinth OAuth application with this callback (replace the host as needed):

```text
https://cobblepower-schematics-api.onrender.com/v1/integrations/modrinth/oauth/callback
```

Configure the Community backend:

```text
COMMUNITY_MODRINTH_ENABLED=false
MODRINTH_CLIENT_ID=<application id>
MODRINTH_CLIENT_SECRET=<managed secret>
MODRINTH_REDIRECT_URI=https://cobblepower-schematics-api.onrender.com/v1/integrations/modrinth/oauth/callback
MODRINTH_OAUTH_SCOPES=USER_READ PROJECT_READ
MODRINTH_API_BASE=https://api.modrinth.com
MODRINTH_USER_AGENT=AGLauncher/2.6 (contact: <support address>)
EXTERNAL_TOKEN_ENCRYPTION_KEY=<32 bytes encoded as base64>
EXTERNAL_TOKEN_ENCRYPTION_KEY_ID=v1
MODRINTH_SYNC_CONCURRENCY=4
```

Generate the encryption key locally and copy only its output into the managed secret:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Run migrations before enabling the feature:

```powershell
cd backend
npm run db:migrate
```

Create a managed cron job from the same backend image with this command and a 15-minute schedule:

```text
npm run community:modrinth:sync
```

The job uses bounded concurrency, Modrinth rate-limit headers, and bounded retry/backoff. It detects releases but does not publish them.

## Creator workflow

1. Open Settings > Account or Community > Import from Modrinth.
2. Connect Modrinth in the system browser.
3. Select an eligible owned Resource Pack and choose tracked channels. Release is always enabled; Beta and Alpha are optional.
4. Check for releases. Detection creates private review candidates only.
5. Prepare a candidate. AG downloads the selected ZIP into bounded temporary storage, verifies Modrinth SHA-512 and size, computes SHA-256, validates it, and builds the component index.
6. Review metadata, license, rights, Pack Studio consent, and the detected file/component information.
7. Publish. AG repeats ownership, identity, download, hash, and archive validation before atomically creating the Community revision.

If an exact upstream version or file disappears or changes identity, new downloads and Pack Studio builds are blocked. Existing locally validated cache entries continue to work offline.

## Key rotation

`EXTERNAL_TOKEN_ENCRYPTION_KEY_ID` is stored with every credential. Before changing the encryption key, reconnect linked accounts or run a controlled re-encryption migration. The backend refuses to decrypt a token whose key ID is not the active ID; it never guesses keys.
