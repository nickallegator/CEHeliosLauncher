const express = require('express')

const config = require('../config')
const { requireSession } = require('../middleware/session')
const { createRateLimit } = require('../middleware/rateLimit')
const { asyncRoute } = require('../middleware/asyncRoute')
const store = require('../services/store')
const { createGameServerRegistry, isServerStatusAuthorized } = require('../services/gameServerRegistry')
const { createMinecraftStatusMonitor } = require('../services/minecraftStatus')

const router = express.Router()
const registry = createGameServerRegistry(config.gameServers.entries)
const monitor = createMinecraftStatusMonitor({
    timeoutMs: config.gameServers.timeoutMs,
    cacheMs: config.gameServers.cacheSeconds * 1000,
    failureCacheMs: 5000
})
const statusLimit = createRateLimit({
    windowMs: 60_000,
    limit: 60,
    keyGenerator: req => `${req.ip || 'unknown'}:${req.userId || 'anonymous'}`
})
const statusGlobalLimit = createRateLimit({
    windowMs: 60_000,
    limit: 600,
    keyGenerator: () => 'game-server-status'
})

router.get('/game-servers/:profileId/status', requireSession, statusGlobalLimit, statusLimit, asyncRoute(async (req, res) => {
    if(!config.gameServers.statusEnabled) {
        res.status(404).json({ error: 'not_found' })
        return
    }
    const entry = registry.get(req.params.profileId)
    if(!entry || !entry.statusEnabled) {
        res.status(404).json({ error: 'unknown_profile' })
        return
    }
    const [entitlements, activeTester] = await Promise.all([
        store.getEntitlements(req.userId),
        store.isUserActiveMinecraftTester(req.userId)
    ])
    if(!isServerStatusAuthorized(entry, entitlements, activeTester)) {
        res.status(403).json({ error: 'server_status_access_denied' })
        return
    }
    const result = await monitor.get(entry)
    res.set('Cache-Control', 'private, no-store')
    res.json({ schemaVersion: 1, profileId: entry.profileId, ...result })
}))

module.exports = router
