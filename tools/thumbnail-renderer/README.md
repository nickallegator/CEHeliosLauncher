# Thumbnail Renderer Stub

This is a minimal CLI stub that satisfies the helper script interface:

```
node tools/thumbnail-renderer/index.js --input <file> --output <file> --width 128 --height 128 --mime image/png --label tiny
```

Behavior:
- Reads the input schematic JSON (unused for now).
- Writes a 1x1 placeholder image in the requested mime (PNG/JPEG/WebP).
- Intended as a drop-in example while the real WebGL renderer is under development.

Usage example:

```
npm run schematics:thumbnails:regenerate -- --base-url https://your-backend.example.com --token <adminToken> --renderer tools/thumbnail-renderer/index.js
```
