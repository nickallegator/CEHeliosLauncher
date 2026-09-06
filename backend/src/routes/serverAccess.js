'use strict'

const express = require('express')

const config = require('../config')
const store = require('../services/store')
const { createRateLimit } = require('../middleware/rateLimit')
const { asyncRoute } = require('../middleware/asyncRoute')
const {
    parseCredentials,
    authenticateCredential,
    buildWhitelistPayload
} = require('../services/serverAccess')

function bearerToken(req) {
    const authorization = String(req.headers.authorization || '')
    const separator = authorization.indexOf(' ')
    if(separator <= 0 || authorization.slice(0, separator).toLowerCase() !== 'bearer') return null
    return authorization.slice(separator + 1).trim()
}

function createServerAccessRouter(options = {}) {
    const router = express.Router()
    const accessStore = options.store || store
    const credentials = parseCredentials(options.credentials ?? config.serverAccess.credentials)
    const rateLimitPerMinute = options.rateLimitPerMinute ?? config.serverAccess.rateLimitPerMinute

    function requireServerCredential(req, res, next) {
        const serverId = String(req.headers['x-ag-server-id'] || '').trim().toLowerCase()
        if(!authenticateCredential(serverId, bearerToken(req), credentials)) {
            console.warn('[audit] server whitelist authorization denied', { requestId: req.requestId, serverId: serverId || null })
            res.set('WWW-Authenticate', 'Bearer realm="ag-server-access"')
            res.status(401).json({ error: 'unauthorized', requestId: req.requestId })
            return
        }
        req.agServerId = serverId
        next()
    }

    router.get(
        '/internal/server-access/whitelist',
        createRateLimit({
            windowMs: 60_000,
            limit: rateLimitPerMinute,
            keyGenerator: req => `${req.ip || 'unknown'}:${String(req.headers['x-ag-server-id'] || '').toLowerCase()}`
        }),
        requireServerCredential,
        asyncRoute(async (req, res) => {
            const payload = buildWhitelistPayload(await accessStore.listActiveMinecraftServerPlayers())
            const etag = `"${payload.revision}"`
            res.set({
                'Cache-Control': 'private, no-store',
                'ETag': etag,
                'X-AG-Whitelist-Revision': payload.revision
            })
            console.info('[audit] server whitelist issued', {
                requestId: req.requestId,
                serverId: req.agServerId,
                revision: payload.revision,
                activeCount: payload.activeCount,
                resolvedCount: payload.resolvedCount,
                pendingProfileCount: payload.pendingProfileCount
            })
            if(req.headers['if-none-match'] === etag) {
                res.status(304).end()
                return
            }
            res.json(payload)
        })
    )
    return router
}

module.exports = createServerAccessRouter()
module.exports.bearerToken = bearerToken
module.exports.createServerAccessRouter = createServerAccessRouter
