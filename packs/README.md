# Launcher pack manifests

Pack manifests are the source of truth for reproducible launcher profiles. They
pin the Minecraft, loader, Java, and module versions as well as every artifact's
SHA-256 digest and byte size. The generated Helios distribution continues to
contain the MD5 values required by the launcher.

Open the launcher with the local development distribution:

```powershell
npm run start:dev
```

Generate the Cobble Power development profile and lock file:

```powershell
npm run mods:generate -- --pack packs/cobble-power-1.21.1.json --distro distribution_dev.json --lock packs/locks/cobble-power-1.21.1.lock.json
```

Verify that its artifacts, lock, and distribution entry are current without
rewriting tracked output:

```powershell
npm run mods:check
```

Artifacts are cached by SHA-256 under `deps/mod-cache`, which is ignored by Git.
This allows an immutable artifact whose former upstream URL has disappeared to
be verified from an approved local copy. Cache entries are named by their
lowercase SHA-256 digest and are re-downloaded if corrupt.

The Cobblemon snapshot currently resolves through its immutable timestamped
Maven URL. Its provenance records the permanent CDN mirror target. Before a
production release, upload the exact cached binary to that target without
renaming or rebuilding it, retain the embedded `LICENSE`, publish the adjacent
notice in `packs/notices`, use immutable CDN cache headers, and update the
manifest source URL. The SHA-256 lock must remain unchanged.

`mods.json` and the `--mods` command remain supported for legacy profiles. New
profiles should use the versioned pack format and committed lock files.

## Private tester builds

The tester release definition is `packs/cobble-power-tester-release.json`. It
locks both the launcher/profile version and the exact Cobble Power JAR bytes.
Build the isolated Windows tester edition with:

```powershell
npm run dist:test
```

The build verifies the mod metadata and checksums, generates the one-profile
tester distribution, bundles the mod for offline repair, and writes the final
handoff folder under `dist/Cobble-Power-Tester-<profile-version>`. The handoff
folder contains only the NSIS installer, SHA-256 checksum, release manifest,
and tester instructions. Tester builds use a separate application identity and
`%APPDATA%\.cobblepower-test-launcher` data directory and do not modify the
production distribution channel.
