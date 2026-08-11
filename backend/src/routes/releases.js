const express = require('express')

const config = require('../config')
const { requireSession } = require('../middleware/session')
const { createRateLimit } = require('../middleware/rateLimit')
const { asyncRoute } = require('../middleware/asyncRoute')
const store = require('../services/store')
const { createReleaseStorage } = require('../services/releaseStorage')

const router = express.Router()
const distributionLimit = createRateLimit({ windowMs: 60_000, limit: 30 })

function injectSchematicsService(distribution, schematicsConfig = config.schematics) {
    if(!schematicsConfig.publicApiUrl) return distribution
    distribution.schematics = {
        schemaVersion: 2,
        enabled: true,
        apiBaseUrl: schematicsConfig.publicApiUrl.replace(/\/+$/, ''),
        features: schematicsConfig.features,
        allowedVisibilities: ['public']
    }
    return distribution
}

router.get('/releases/channels/:channel/distribution', distributionLimit, requireSession, asyncRoute(async (req, res) => {
    if(!config.releases.enabled) {
        res.status(404).json({ error: 'not_found' })
        return
    }
    if(String(req.params.channel).toLowerCase() !== config.releases.channel) {
        res.status(404).json({ error: 'unknown_channel' })
        return
    }
    const entitlements = await store.getEntitlements(req.userId)
    const activeTester = await store.isUserActiveMinecraftTester(req.userId)
    if(!activeTester || !entitlements.map(value => String(value).toLowerCase()).includes(config.releases.requiredEntitlement)) {
        console.warn('[audit] channel authorization denied', { requestId: req.requestId, userId: req.userId, channel: req.params.channel })
        res.status(403).json({ error: 'channel_access_denied' })
        return
    }

    const releaseStorage = createReleaseStorage()
    const result = await releaseStorage.getAuthorizedDistribution(req.params.channel)
    injectSchematicsService(result.distribution)
    console.info('[audit] channel distribution issued', { requestId: req.requestId, userId: req.userId, channel: req.params.channel, releaseId: result.releaseId })
    res.set('Cache-Control', 'private, no-store')
    res.set('X-CobblePower-Release', result.releaseId)
    res.json(result.distribution)
}))

module.exports = router
module.exports.injectSchematicsService = injectSchematicsService
