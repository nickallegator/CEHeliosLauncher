const express = require('express')

const store = require('../services/store')
const { requireSession } = require('../middleware/session')
const { asyncRoute } = require('../middleware/asyncRoute')

const router = express.Router()

router.get('/entitlements', requireSession, asyncRoute(async (req, res) => {
    const entitlements = await store.getEntitlements(req.userId)
    res.json({ entitlements })
}))

router.get('/me', requireSession, asyncRoute(async (req, res) => {
    const entitlements = await store.getEntitlements(req.userId)
    const user = await store.getUser(req.userId)
    res.json({
        entitlements,
        id: user?.id || req.userId,
        displayName: user?.display_name || null,
        avatarUrl: user?.avatar_url || null
    })
}))

module.exports = router
