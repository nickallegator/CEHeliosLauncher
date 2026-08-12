const express = require('express')
const helmet = require('helmet')
const cors = require('cors')
const crypto = require('crypto')

const config = require('./config')

const authRoutes = require('./routes/auth')
const minecraftAuthRoutes = require('./routes/minecraftAuth')
const entitlementRoutes = require('./routes/entitlements')
const releaseRoutes = require('./routes/releases')
const db = require('./db')
const { createReleaseStorage } = require('./services/releaseStorage')
const { getSchematicsObjectStorage } = require('./services/schematicsObjectStorage')
const { getCommunityObjectStorage } = require('./services/communityObjectStorage')
const { createDefaultCommunityTypeRegistry } = require('./services/communityTypes')
const { safeError } = require('./services/logSafety')

const app = express()

if(config.trustProxy) app.set('trust proxy', 1)

app.use(helmet())
app.use(express.json({ limit: '64kb' }))
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
    if(config.schematics.enabled) {
        try {
            await db.query('select 1 from schematic_revisions limit 1')
            await getSchematicsObjectStorage().ready()
            checks.schematics = 'ok'
        } catch(_err) {
            checks.schematics = 'error'
        }
    } else {
        checks.schematics = 'disabled'
    }
    if(config.community.enabled && Object.values(config.community.types).some(Boolean)) {
        try {
            const handlers = createDefaultCommunityTypeRegistry()
            for(const [type, enabled] of Object.entries(config.community.types)) {
                if(enabled && !handlers.get(type)) throw new Error(`Missing Community handler: ${type}`)
            }
            await db.query('select 1 from community_revisions limit 1')
            await getCommunityObjectStorage().ready()
            checks.community = 'ok'
        } catch(_err) {
            checks.community = 'error'
        }
    } else {
        checks.community = 'disabled'
    }
    const ready = !Object.values(checks).includes('error')
    res.status(ready ? 200 : 503).json({ ok: ready, checks })
})

app.use('/auth/patreon', authRoutes)
app.use('/v1', minecraftAuthRoutes)
app.use('/v1', entitlementRoutes)
app.use('/v1', releaseRoutes)
if(config.schematics.enabled || config.community.enabled) {
    const communityRoutes = require('./routes/community')
    app.use('/v1', communityRoutes)
}
if(config.schematics.enabled) {
    const schematicsRoutes = require('./routes/schematics')
    app.use('/v1', schematicsRoutes)
    if(config.schematics.features.collections) {
        const collectionsRoutes = require('./routes/collections')
        app.use('/v1', collectionsRoutes)
    }
}

app.use((req, res) => {
    res.status(404).json({ error: 'not_found' })
})

app.use((err, req, res, _next) => {
    console.error('[server] error', { requestId: req.requestId, ...safeError(err) })
    if(err?.name === 'SchematicValidationError') {
        res.status(400).json({
            error: err.code || 'schematic_validation_failed',
            message: err.message,
            details: err.details || undefined,
            requestId: req.requestId
        })
        return
    }
    if(err?.name === 'CommunityValidationError') {
        res.status(400).json({
            error: err.code || 'community_validation_failed',
            message: err.message,
            details: err.details || undefined,
            requestId: req.requestId
        })
        return
    }
    const statusCode = Number(err?.statusCode)
    if(Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 500) {
        res.status(statusCode).json({ error: err.code || 'request_failed', requestId: req.requestId })
        return
    }
    res.status(500).json({ error: 'server_error', requestId: req.requestId })
})

app.listen(config.port, () => {
    console.log(`[server] listening on ${config.port}`)
})
