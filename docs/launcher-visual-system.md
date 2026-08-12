# Allegator Games Launcher visual system

This document defines the renderer conventions introduced by the workshop visual overhaul. The launcher remains an EJS, CSS, and renderer-script application; the visual system does not replace authentication, distribution, repair, Java, mod-selection, news, or schematic controllers.

## Architecture

`app/app.ejs` renders two layers. The startup presentation is available immediately, while `#appShell` contains the persistent signed-in navigation and viewport. Authentication remains outside the shell. Home, Community, News, and Settings reuse existing controller entry points where those entry points own functional state.

The renderer style entry point is `app/assets/css/visual-overhaul.css`. Its import order is deliberate:

1. `tokens.css` — color, type, spacing, corners, elevation, motion, focus, and breakpoint values.
2. `foundations.css` — fonts, reset-compatible foundations, block-grid texture, accessibility, and shared typography.
3. `startup.css` — intro, loading loop, reduced-motion frame, and fatal state.
4. `shell.css` — title-safe persistent navigation and application viewport.
5. `home.css`, `community.css`, and `views.css` — route-specific layouts.
6. `responsive.css` — compact navigation and height/width adaptations.

Element IDs are controller and test hooks. New presentation rules should target reusable classes. Avoid adding layout rules to an ID unless an existing controller requires a uniquely positioned element.

## Design conventions

- Use the `--ag-*` tokens. Do not introduce one-off colors, shadows, animation durations, or spacing values in component rules.
- Pixelify Sans is reserved for short headings and high-value labels. Atkinson Hyperlegible is the control and body font.
- Use `.workshopPanel`, `.workshopButton`, `.workshopEyebrow`, `.panelChip`, and `.itemSlot` before creating a new visual primitive.
- Decorative texture must be CSS or a local vector. Screenshot backgrounds, decorative raster images, large blur filters, and permanently animated effects are outside the design system.
- Motion is limited to opacity and transform. Do not leave `will-change` enabled. Every animation must have a reduced-motion equivalent.
- Keep all visible copy in `app/assets/lang/*.toml`. `_custom.toml` remains the deployment-specific brand override.

## Startup presentation

`startup-presentation.js` owns the explicit `intro`, `distribution`, `account`, `ready`, and `fatal` states. The intro lasts 2.4 seconds and exposes Skip after 500 ms. If initialization is incomplete, the chomp asset is loaded only after the intro. Marking the renderer ready exits the presentation; fatal state detaches animation and exposes Retry and Close.

The original Allegator intro and chomp SVG files are packaged unchanged. Reduced-motion users receive `allegator-games-logo.svg` and no animated SVG is loaded. Do not add network work to startup or use a fabricated progress percentage.

## Product identity and logo assets

The full product name is **Allegator Games Launcher** and the compact UI name is **AG Launcher**. Cobble Power is a modpack/profile name and must not be used as the application, executable, or installer identity.

`app/assets/js/brand.js` is the runtime source of truth for product naming, application identity, default data directory, and recognized legacy identities. Electron Builder YAML mirrors those values because packaging configuration is evaluated before runtime modules are available.

The editable logo master lives at `build/branding/allegator-games-logo-source.svg`. Run `npm run brand:generate` after replacing it. The generator removes the hidden tracing reference, optimizes the renderer SVG, produces the square transparent app PNG, and generates Windows ICO and macOS ICNS resources. `predist`, `predist:test`, and `predist:channel` regenerate these outputs automatically.

Do not manually distort or separately recolor generated icon variants. Existing user configuration is copied non-destructively from recognized legacy product directories on first branded launch; game instances remain in their configured data directory.

Launcher-managed profile artwork is resolved through `app/assets/js/serverbranding.js`. This local override protects the UI from stale artwork in cached or already-promoted distributions while allowing unmanaged profiles to retain their configured icons. Add future first-party profile IDs to that registry instead of duplicating icon-selection logic in Settings or the profile selector.

## Routes

`shell.js` owns the small internal route map:

- `home`
- `community`
- `news`
- `settings`

`community/schematics` is accepted only as a compatibility alias and canonicalizes to `community`. Add a route only when it is a top-level application destination. Preserve existing controllers by adapting the route to their entry point, and make the route responsible for updating `aria-current`, focus, cancellation, and shell visibility. Network-backed views must cancel superseded work when their existing controller provides cancellation.

## Unified Community catalog

Community opens directly to individual creations with All selected. Category chips filter the same catalog; they do not introduce another navigation layer. Search, Popular/Newest sorting, creator/tag filters, progressive loading, and the accessible Load More control are shared across content types. The in-memory state retains the active filters, loaded entries, and scroll position until the launcher exits.

`community-modules.js` contains `CommunityContentTypeRegistry`. A content-type definition has a stable `id`, localized label, icon, capability check, catalog normalizer, detail handler, and optional publish/install handlers. The backend independently registers read providers. Both registries must support a type before its category or entries appear.

To add a future Community content type:

1. Add localized copy and a symbol to the shared local icon set.
2. Register a backend provider and expose it from `/v1/community/capabilities`.
3. Register a renderer definition that normalizes the shared `type:id` catalog model and dispatches detail/publishing behavior to the type controller.
4. Return `false` when either capability is absent. Unknown server types are ignored by older launchers.
5. Keep large type-specific code lazy and out of launcher startup.
6. Cover enabled, disabled, progressive loading, deduplication, cached-offline, unauthorized, empty, and failure behavior.

Schematics is the reference implementation and retains its existing details, publishing, installation, ownership, reports, and moderation controllers. Schematic-only tools appear only while its category is selected. Collection data, routes, and client controllers are preserved, but every Collection entry point is intentionally hidden until a later cross-type destination is designed.

## Accessibility

- Every route has a semantic heading and the shell navigation has an accessible label.
- Use native buttons and links. Practical interactive targets should be at least 40 CSS pixels when space permits.
- `:focus-visible` must remain visible against every surface.
- Dialogs use `role="dialog"`, `aria-modal`, focus trapping, Escape handling, and focus restoration.
- Do not make the persistent launch dock inert when News or Community is active.
- Test keyboard order at both 1180×680 and 980×600, including Windows display scaling.
- New colors must preserve WCAG AA contrast for their intended text size.

## Assets and verification

Run `npm run test:ui` after renderer asset or shell changes. `scripts/check-renderer-assets.js` rejects unexpected raster art, missing brand/font licenses, oversized assets, and excessive brand payload growth. The removed JPEG backgrounds and loading PNGs must not be reintroduced into packaged output.

Run `npm run test:renderer` and the Playwright renderer flow before packaging. A Windows acceptance pass must still exercise Microsoft sign-in, release authorization, Java management, optional-mod changes, repair, launch, Community/Schematics, News, and persisted Settings.
