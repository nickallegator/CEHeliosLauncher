# Access Gating (Patreon)

This launcher supports gating modules behind entitlements (ex: Patreon tiers). The launcher:

- Shows locked mods with a badge.
- Skips downloading gated files when the user lacks entitlements.

## Distribution Config

Add optional access config to your distribution index:

```json
{
  "access": {
    "apiBaseUrl": "https://api.example.com",
    "authUrl": "https://api.example.com/auth/patreon/start",
    "providers": {
      "patreon": {
        "campaignId": "1234567890"
      }
    }
  }
}
```

## Module Gating

Mark gated modules with `access`:

```json
{
  "id": "curse.maven:example:123",
  "name": "Example Dev Mod",
  "type": "ForgeMod",
  "access": {
    "provider": "patreon",
    "entitlement": "dev",
    "label": "Patreon Required",
    "url": "https://patreon.com/YourPage"
  },
  "artifact": {
    "size": 1234,
    "MD5": "abc123",
    "url": "https://cdn.example.com/example.jar"
  }
}
```

The launcher checks entitlements against `provider:entitlement` (ex: `patreon:dev`).

## API Expectations

`GET /v1/entitlements`

Response:

```json
{
  "entitlements": ["patreon:dev", "patreon:beta"]
}
```

The request includes:

```
Authorization: Bearer <sessionToken>
```

## Environment Overrides (dev)

You can override access behavior without a backend:

- `HELIOS_ACCESS_API_URL` - base URL for `/v1/entitlements`
- `HELIOS_ACCESS_AUTH_URL` - OAuth start URL
- `HELIOS_ACCESS_SESSION_TOKEN` - session token override
- `HELIOS_ACCESS_ENTITLEMENTS` - comma-separated entitlements

