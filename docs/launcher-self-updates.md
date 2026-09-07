# AG Launcher self-updates

AG Launcher uses the public `nickallegator/CEHeliosLauncher` GitHub Releases feed and `electron-updater`. Private Minecraft and Community credentials are not involved.

## Release contract

- `package.json` is the canonical version.
- Test versions use `x.y.z-test.n` and tags use `v<version>`.
- A release is immutable. Fixes always use a higher version.
- Test launchers accept only `test` prereleases. Stable launchers accept only stable versions.
- Only packaged Windows authenticated-channel builds enable the updater. Development, showroom, unpacked, and legacy standalone builds remain disabled.

Every release contains the NSIS installer, its blockmap, `latest.yml`, `SHA256SUMS.txt`, `bom.cdx.json`, `launcher-release.json`, and `RELEASE_NOTES.md`. The publishing workflow verifies the downloaded release assets before taking the GitHub release out of draft.

The release workflow runs the repository smoke suites and `npm run lint:release`. The narrower lint target keeps the release gate strict for the updater and its integration points while older unrelated compatibility code is progressively brought under the repository-wide lint policy.

## Publishing a test update

1. Update `package.json` to the next unique prerelease and run `npm install --package-lock-only` so the lock agrees.
2. Add `docs/releases/<version>.md`.
3. Merge the reviewed change to the deployed launcher integration branch.
4. Create and push an annotated tag named `v<version>` at that exact commit.
5. Approve the `ag-launcher-test` GitHub Environment deployment.
6. Confirm the GitHub prerelease contains the complete artifact set and that the prior installed launcher offers the update.

`2.8.0-test.1` is the one-time manual bootstrap. Use `2.8.0-test.2` for the first end-to-end update test.

## Backend compatibility policy

`LAUNCHER_UPDATE_POLICY_JSON` advertises recommended/minimum versions. Keep `enforce` and `requireHeader` false during migration. When updater-capable clients are broadly adopted, a future deployment may enforce a minimum version for protected online routes. Minecraft authentication and the public update-policy endpoint stay reachable; a valid offline channel grant can still launch already-installed content.

## Stable signing gate

Stable publishing fails unless `AG_WINDOWS_PUBLIC_TRUST_SIGNING=true` and all of these values are available to the release environment:

- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_CLIENT_SECRET`
- `AZURE_ARTIFACT_SIGNING_ENDPOINT`
- `AZURE_ARTIFACT_SIGNING_ACCOUNT`
- `AZURE_ARTIFACT_SIGNING_PROFILE`
- `AZURE_ARTIFACT_SIGNING_PUBLISHER`

Use `electron-builder.channel.signed.yml` for the stable signed build. Configure the expected publisher name there so `electron-updater` rejects installers signed by a different publisher.
