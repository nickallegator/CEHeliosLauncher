'use strict'

const express = require('express')

const config = require('../config')
const db = require('../db')
const { asyncRoute } = require('../middleware/asyncRoute')
const sessions = require('../services/sessions')
const { createCommunityCatalog } = require('../services/communityCatalog')

const router = express.Router()
const catalog = createCommunityCatalog({ database: db, settings: config.schematics })

async function optionalSession(req) {
    const authorization = req.headers.authorization || ''
    const [type, token] = authorization.split(' ')
    if(type?.toLowerCase() !== 'bearer' || !token) return null
    return sessions.getSession(token)
}

router.get('/community/capabilities', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=300')
    res.json(catalog.capabilities())
})

router.get('/community/catalog', asyncRoute(async (req, res) => {
    let ownerId = null
    if(String(req.query.mine || '').toLowerCase() === 'true') {
        const session = await optionalSession(req)
        if(!session) {
            res.status(401).json({ error: 'authentication_required' })
            return
        }
        ownerId = session.userId
    }
    const result = await catalog.list({
        category: req.query.category,
        query: req.query.query,
        sort: req.query.sort,
        creator: req.query.creator,
        tags: req.query.tags,
        limit: req.query.limit,
        cursor: req.query.cursor,
        ownerId
    })
    const etag = catalog.etag(result)
    res.set('ETag', etag)
    res.set('Cache-Control', ownerId == null ? 'public, max-age=60, stale-if-error=86400' : 'private, no-store')
    res.set('Vary', 'Authorization')
    if(req.headers['if-none-match'] === etag) {
        res.status(304).end()
        return
    }
    res.json(result)
}))

module.exports = router
module.exports.optionalSession = optionalSession
