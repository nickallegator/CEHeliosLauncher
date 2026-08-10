const express = require('express')
const helmet = require('helmet')
const cors = require('cors')
const crypto = require('crypto')

const config = require('./config')

const authRoutes = require('./routes/auth')
const minecraftAuthRoutes = require('./routes/minecraftAuth')
const entitlementRoutes = require('./routes/entitlements')
const schematicsRoutes = require('./routes/schematics')
const collectionsRoutes = require('./routes/collections')
const releaseRoutes = require('./routes/releases')
const uploadTokens = require('./services/schematicsUploadTokens')
const db = require('./db')
const { createReleaseStorage } = require('./services/releaseStorage')
const { safeError } = require('./services/logSafety')

const app = express()

if(config.trustProxy) app.set('trust proxy', 1)

app.use(helmet())
app.use(express.json({ limit: '12mb' }))
app.use((req, res, next) => {
    req.requestId = String(req.headers['x-request-id'] || crypto.randomUUID()).slice(0, 128)
    res.set('X-Request-ID', req.requestId)
    next()
})

if(config.corsOrigins.length > 0) {
    app.use(cors({
        origin: config.corsOrigins,
        credentials: false
    }))
}

app.get('/health', (_req, res) => {
    res.json({ ok: true })
})

app.get('/ready', async (_req, res) => {
    const checks = {}
    try {
        await db.query('select 1')
        checks.postgres = 'ok'
    } catch(_err) {
        checks.postgres = 'error'
    }
    if(config.releases.enabled) {
        try {
            await createReleaseStorage().ready()
            checks.releases = 'ok'
        } catch(_err) {
            checks.releases = 'error'
        }
    } else {
        checks.releases = 'disabled'
    }
    checks.schematics = config.schematics.enabled ? 'enabled' : 'disabled'
    const ready = !Object.values(checks).includes('error')
    res.status(ready ? 200 : 503).json({ ok: ready, checks })
})

app.use('/auth/patreon', authRoutes)
app.use('/v1', minecraftAuthRoutes)
app.use('/v1', entitlementRoutes)
app.use('/v1', releaseRoutes)
if(config.schematics.enabled) {
    app.use('/v1', schematicsRoutes)
    app.use('/v1', collectionsRoutes)
}

app.use((req, res) => {
    res.status(404).json({ error: 'not_found' })
})

app.use((err, req, res, _next) => {
    console.error('[server] error', { requestId: req.requestId, ...safeError(err) })
    res.status(500).json({ error: 'server_error', requestId: req.requestId })
})

const tokenCleanupInterval = setInterval(() => {
    uploadTokens.cleanupExpired().catch(() => {})
}, 10 * 60 * 1000)
if(typeof tokenCleanupInterval.unref === 'function'){
    tokenCleanupInterval.unref()
}
uploadTokens.cleanupExpired().catch(() => {})

app.listen(config.port, () => {
    console.log(`[server] listening on ${config.port}`)
})
