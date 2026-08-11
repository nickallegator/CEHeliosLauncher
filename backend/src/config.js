const dotenv = require('dotenv')

dotenv.config()

function getEnv(key, fallback = null) {
    const value = process.env[key]
    if(value == null || value === '') {
        return fallback
    }
    return value
}

function parseNumber(value, fallback) {
    const n = Number.parseInt(value, 10)
    return Number.isFinite(n) ? n : fallback
}

function parseList(value) {
    if(!value) {
        return []
    }
    return value.split(',')
        .map(item => item.trim())
        .filter(Boolean)
}

function parseBoolean(value, fallback = false) {
    if(value == null || value === '') {
        return fallback
    }
    return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase())
}

function objectStorageConfig(prefix, defaults = {}) {
    return {
        provider: getEnv(`${prefix}_PROVIDER`, null),
        bucket: getEnv(`${prefix}_BUCKET`, null),
        region: getEnv(`${prefix}_REGION`, 'auto'),
        endpoint: getEnv(`${prefix}_ENDPOINT`, null),
        accessKeyId: getEnv(`${prefix}_ACCESS_KEY_ID`, null),
        secretAccessKey: getEnv(`${prefix}_SECRET_ACCESS_KEY`, null),
        forcePathStyle: parseBoolean(getEnv(`${prefix}_FORCE_PATH_STYLE`, ''), false),
        getTtlSeconds: parseNumber(getEnv(`${prefix}_GET_TTL_SECONDS`, String(defaults.getTtlSeconds || 900)), defaults.getTtlSeconds || 900),
        putTtlSeconds: parseNumber(getEnv(`${prefix}_PUT_TTL_SECONDS`, String(defaults.putTtlSeconds || 900)), defaults.putTtlSeconds || 900)
    }
}

const config = {
    port: parseNumber(getEnv('PORT', '8080'), 8080),
    baseUrl: getEnv('BASE_URL', 'http://localhost:8080'),
    trustProxy: parseBoolean(getEnv('TRUST_PROXY', 'false')),
    corsOrigins: parseList(getEnv('CORS_ORIGINS', '')),
    databaseUrl: getEnv('DATABASE_URL', null),
    sessionTtlDays: parseNumber(getEnv('SESSION_TTL_DAYS', '30'), 30),
    releases: {
        enabled: parseBoolean(getEnv('RELEASES_ENABLED', 'false')),
        channel: getEnv('RELEASES_CHANNEL', 'test'),
        requiredEntitlement: getEnv('RELEASES_REQUIRED_ENTITLEMENT', 'cobblepower:test').toLowerCase(),
        objectStorage: objectStorageConfig('RELEASES_STORAGE', { getTtlSeconds: 3600 })
    },
    schematics: {
        enabled: parseBoolean(getEnv('SCHEMATICS_ENABLED', 'false')),
        publicApiUrl: getEnv('SCHEMATICS_PUBLIC_API_URL', null),
        writeMode: getEnv('SCHEMATICS_WRITE_MODE', 'admin').trim().toLowerCase(),
        allowDevelopmentSeeds: parseBoolean(getEnv('SCHEMATICS_DEVELOPMENT_SEEDS', 'false')),
        features: {
            core: true,
            collections: parseBoolean(getEnv('SCHEMATICS_COLLECTIONS_ENABLED', 'false')),
            creators: parseBoolean(getEnv('SCHEMATICS_CREATORS_ENABLED', 'false'))
        },
        uploadRateLimit: parseNumber(getEnv('SCHEMATICS_UPLOADS_PER_HOUR', '10'), 10),
        reportRateLimit: parseNumber(getEnv('SCHEMATICS_REPORTS_PER_DAY', '10'), 10),
        storageDir: getEnv('SCHEMATICS_STORAGE_DIR', null),
        objectStorage: {
            provider: getEnv('SCHEMATICS_STORAGE_PROVIDER', null),
            bucket: getEnv('SCHEMATICS_STORAGE_BUCKET', null),
            region: getEnv('SCHEMATICS_STORAGE_REGION', 'auto'),
            endpoint: getEnv('SCHEMATICS_STORAGE_ENDPOINT', null),
            accessKeyId: getEnv('SCHEMATICS_STORAGE_ACCESS_KEY_ID', null),
            secretAccessKey: getEnv('SCHEMATICS_STORAGE_SECRET_ACCESS_KEY', null),
            publicBaseUrl: getEnv('SCHEMATICS_STORAGE_PUBLIC_BASE_URL', null),
            forcePathStyle: ['1', 'true', 'yes'].includes(getEnv('SCHEMATICS_STORAGE_FORCE_PATH_STYLE', '').toLowerCase()),
            putTtlSeconds: parseNumber(getEnv('SCHEMATICS_STORAGE_PUT_TTL_SECONDS', '900'), 900),
            getTtlSeconds: parseNumber(getEnv('SCHEMATICS_STORAGE_GET_TTL_SECONDS', '900'), 900),
            publicCacheControl: getEnv('SCHEMATICS_STORAGE_PUBLIC_CACHE_CONTROL', 'public, max-age=31536000, immutable'),
            privateCacheControl: getEnv('SCHEMATICS_STORAGE_PRIVATE_CACHE_CONTROL', 'private, max-age=60'),
            redirectCacheControl: getEnv('SCHEMATICS_STORAGE_REDIRECT_CACHE_CONTROL', 'public, max-age=86400')
        }
    },
    patreon: {
        clientId: getEnv('PATREON_CLIENT_ID', null),
        clientSecret: getEnv('PATREON_CLIENT_SECRET', null),
        redirectUri: getEnv('PATREON_REDIRECT_URI', null),
        scopes: getEnv('PATREON_SCOPES', ''),
        campaignId: getEnv('PATREON_CAMPAIGN_ID', null),
        authorizeUrl: getEnv('PATREON_AUTHORIZE_URL', 'https://www.patreon.com/oauth2/authorize'),
        tokenUrl: getEnv('PATREON_TOKEN_URL', 'https://www.patreon.com/api/oauth2/token'),
        apiBase: getEnv('PATREON_API_BASE', 'https://www.patreon.com/api/oauth2/v2'),
        defaultEntitlement: getEnv('PATREON_DEFAULT_ENTITLEMENT', 'patreon:subscriber'),
        tierMap: getEnv('PATREON_TIER_MAP', ''),
        creatorUserId: getEnv('PATREON_CREATOR_USER_ID', null)
    },
    oauthStateTtlMinutes: parseNumber(getEnv('OAUTH_STATE_TTL_MINUTES', '10'), 10)
}

if(!['disabled', 'admin', 'authenticated'].includes(config.schematics.writeMode)) {
    throw new Error('SCHEMATICS_WRITE_MODE must be disabled, admin, or authenticated')
}

if(config.schematics.enabled && process.env.NODE_ENV === 'production') {
    const storage = config.schematics.objectStorage
    const missing = ['provider', 'bucket', 'endpoint', 'accessKeyId', 'secretAccessKey'].filter(key => !storage[key])
    if(missing.length > 0) {
        throw new Error(`Schematics are enabled in production but storage is missing: ${missing.join(', ')}`)
    }
}

function maskDatabaseUrl(url) {
    if(!url) {
        return null
    }
    try {
        const parsed = new URL(url)
        if(parsed.password) {
            parsed.password = '****'
        }
        return parsed.toString()
    } catch (_err) {
        return 'invalid'
    }
}

if(!config.databaseUrl) {
    console.warn('[config] DATABASE_URL not set (check backend/.env)')
} else {
    console.log('[config] DATABASE_URL loaded:', maskDatabaseUrl(config.databaseUrl))
}

module.exports = config
