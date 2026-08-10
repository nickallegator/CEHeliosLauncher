# Authenticated Cobble Power Test Channel

## Release flow

1. Tag the mod repository with a unique prerelease such as `v1.0.1-test.1`.
2. The mod workflow builds with Temurin Java 21 and publishes the immutable JAR plus SHA-256.
3. Run the launcher repository's `Promote Cobble Power Test Release` workflow with that tag, a pack version, and the expected current release ID.
4. Review the prepared `release.json`, distribution template, lock, and publish state.
5. Approve the protected `cobblepower-test` GitHub Environment. The workflow uploads immutable objects, verifies them from R2, and changes `channels/test/current.json` last.

The launcher refreshes its authorized distribution immediately before repair. A new mod release therefore does not require rebuilding the installer.

## Required GitHub environment secrets

- `COBBLEPOWER_CROSS_REPO_TOKEN`: read access to the mod repository's release assets.
- `RELEASES_STORAGE_ENDPOINT`
- `RELEASES_STORAGE_BUCKET`
- `RELEASES_STORAGE_ACCESS_KEY_ID`
- `RELEASES_STORAGE_SECRET_ACCESS_KEY`

The R2 token must be restricted to the private release bucket. It must not be shared with schematics or packaged into the launcher.

## Local commands

Prepare without remote writes:

```console
npm run releases -- prepare --mod <jar> --mod-version <version> --pack-version <pack-version> --source-repository <url> --source-tag v<version> --source-commit <40-char-sha> --source-repo <mod-repo> --expected-previous <release-id>
```

Then use `publish`, `verify`, `promote`, or `rollback`. All authenticated commands read only `RELEASES_STORAGE_*` credentials.

Build the schema-v2 installer once the managed API has a stable HTTPS URL:

```console
npm run dist:channel -- --api-url https://api.example.com
```

Preserve the sanitized `2.2.1-test.4` installer and its manifest separately as the emergency standalone fallback. Its current SHA-256 is `ab8ad2c7809ac1d691b3d5860518479bb52795e161de859319902014f2ba6e8a`.

Do not distribute the earlier `test.4` binary with SHA-256 `2106df52508c6d3c59951825ad6efc5c59aab8272d555916ed98ac1ba59d85bb`. The old Electron packaging boundary included the backend directory and local `.env`; withdraw that binary and rotate any backend/storage credentials that existed when it was built if it was shared.

Builds targeting localhost are package-verification artifacts only. The build script marks them with `DO-NOT-DISTRIBUTE-LOCAL-API.txt`.
