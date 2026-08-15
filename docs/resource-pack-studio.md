# AG Launcher Resource Pack Studio

Pack Studio builds local Minecraft Resource Packs from immutable, creator-approved Community Resource Pack revisions. A project is a recipe: it pins exact source revisions and logical components, records every conflict decision, and never republishes the result to Community.

## Production rollout

1. Deploy `backend/migrations/2026-08-14_resource_pack_studio.sql` while `COMMUNITY_PACK_STUDIO_ENABLED=false`.
2. Deploy the backend and run `npm run community:pack-studio:index -- --limit 100` from the backend directory. Repeat until the command reports an empty `indexed` array. A single revision can be retried with `--revision <uuid>`. After an indexing-rule upgrade, use `--force` (optionally together with `--revision <uuid>`) to replace stale component rows transactionally while preserving revision objects and composition grants.
3. Have each Resource Pack owner open the exact revision and accept `AG-Pack-Studio-Composition-Grant-1.0`. Existing revisions are excluded until their owner explicitly enables them.
4. Verify component search and resolution in staging, then set `COMMUNITY_PACK_STUDIO_ENABLED=true` on both services. On the Community service it enables the APIs; on the release-only service it advertises the capability in authorized distributions. Keep `COMMUNITY_ENABLED=false` and omit Community storage credentials on the release-only service.
5. Publish an AG Launcher build containing Pack Studio. The authorized distribution exposes the feature automatically through `community.features.packStudio`.

Readiness checks require the component and grant tables plus the existing private Community object store. No new bucket or public object URL is required.

## Composition and safety

The indexer discovers dependency-complete blocks, Pokémon, items, sounds, fonts, languages, UI resources, textures, and generic safe assets. Search never exposes revisions that are hidden, deleted, quarantined, incompatible, or not opted in. Resolution returns short-lived source descriptors; the launcher streams each unique archive into its SHA-256 cache.

Ordinary duplicate paths require an explicit winner. `sounds.json` and language JSON are merged by key, with conflicting keys also requiring an explicit winner. Builds synthesize their own `pack.mcmeta` and `pack.png`, use stable entry ordering and timestamps, and emit:

- `CREDITS.md`
- `ag-pack-studio.json`
- `ag-licenses/AG-Pack-Studio-Composition-Grant-1.0.txt`
- one source notice directory per Community item

Generated packs retain the existing 100 MiB compressed, 512 MiB expanded, 10,000-entry, safe-path, namespace, and file-type limits. Construction runs outside the renderer process. Installation uses `ag-studio-<project-id>.zip`, updates `options.txt` transactionally, and enables the pack at highest priority.

## Local verification

Run the read-only showroom against installed game resources:

```powershell
.\run-community-showroom.cmd --verify --resources-from "$env:APPDATA\.cobblepower-test-launcher"
```

The verification exercises component discovery, local project persistence, server resolution, checksum-cached source download, deterministic construction, and highest-priority installation into a disposable instance.

Run focused automated coverage with:

```powershell
node --test tests/backend/packStudio.test.js tests/renderer/packStudio.test.js tests/showroom/communityShowroom.test.js
```

## Operational notes

- Revoking a grant prevents future resolution but does not delete previously downloaded or installed packs.
- Source revisions remain pinned. A newer current revision is shown as an update and must be reviewed and selected manually.
- Installed output remains usable offline. New or changed recipes require a successful current resolve and all source archives to validate.
- Projects are stored globally under the launcher Community cache and are reusable across compatible Cobble Power profiles.
