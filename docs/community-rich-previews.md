# Community rich previews

AG Launcher 2.5 renders verified Community artifacts locally. Rich previews are additive: the catalog thumbnail remains the loading, error, offline, reduced-capability, and older-launcher fallback.

## Runtime contract

The authorized distribution may expose `community.features.richPreviews` and signed `communityRenderContracts.registry` / `communityRenderContracts.renderRegistry` descriptors. The launcher verifies every descriptor and artifact by SHA-256 before caching it. Backend support remains disabled until `COMMUNITY_RICH_PREVIEWS_ENABLED=true` is set after the `community_revision_assets` migration.

Each content type owns a lifecycle controller with `mount`, `update`, `cancel`, and `destroy` behavior. Closing a detail view cancels downloads and workers, releases WebGL resources, and restores the static fallback. Only one Community WebGL context may be active.

## Resource resolution

Preview resources are resolved in this order:

1. The selected Community Resource Pack overlay.
2. Enabled Resource Packs in the selected instance.
3. Cobble Power and Cobblemon resources.
4. Locked Minecraft base resources.

ZIP providers validate entry names and bounds without extracting into an instance. Render caches include the profile, release, artifact and overlay hashes, and resource-stack signature so an old mesh cannot be reused against a different resource set.

## Adding a renderer

Register the type through `CommunityContentTypeDefinition`, keep artifact parsing in `libraries/community-rendering`, and keep DOM/WebGL ownership in an isolated controller under `app/assets/js/communitypreviews`. A renderer must provide an accessible DOM summary, keyboard controls where interactive, cancellation, deterministic fallback behavior, and cleanup tests.

Server-derived render assets are immutable revision children. Build and remotely verify them before the revision transaction; failed validation must not publish a revision.

## Local verification

Run the representative showroom with installed game resources:

```powershell
.\run-community-showroom.cmd --resources-from "$env:APPDATA\.cobblepower-test-launcher"
```

For an automated zero-error acceptance pass:

```powershell
node scripts/run-community-showroom.js --verify --resources-from "$env:APPDATA\.cobblepower-test-launcher"
```

The showroom is disposable, uses a local read-only API, disables publishing and game launch, and never uploads its representative artifacts.
