const express = require('express')

const sessions = require('../services/sessions')
const store = require('../services/store')
const config = require('../config')
const { createRateLimit } = require('../middleware/rateLimit')
const { asyncRoute } = require('../middleware/asyncRoute')

const router = express.Router()

const MC_PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile'

async function fetchMinecraftProfile(accessToken) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 7000)
    try {
        const res = await fetch(MC_PROFILE_URL, {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Accept': 'application/json'
            },
            signal: controller.signal
        })
        if(!res.ok){
            return null
        }
        const data = await res.json()
        if(!data?.id){
            return null
        }
        return data
    } catch (_err) {
        return null
    } finally {
        clearTimeout(timeout)
    }
}

function extractAvatar(profile){
    const skin = Array.isArray(profile?.skins) ? profile.skins.find(s => s?.state === 'ACTIVE') : null
    return skin?.url || null
}

function buildMinecraftEntitlements(activeTester, requiredEntitlement = config.releases.requiredEntitlement, grants = []) {
    const values = activeTester ? ['minecraft:player', requiredEntitlement] : ['minecraft:player']
    return Array.from(new Set([...values, ...grants].map(value => String(value).toLowerCase())))
}

router.post('/auth/minecraft', createRateLimit({ windowMs: 60_000, limit: 10 }), asyncRoute(async (req, res) => {
    const accessToken = typeof req.body?.accessToken === 'string' ? req.body.accessToken.trim() : ''
    if(!accessToken){
        res.status(400).json({ error: 'missing_access_token' })
        return
    }

    const profile = await fetchMinecraftProfile(accessToken)
    if(!profile){
        res.status(401).json({ error: 'invalid_access_token' })
        return
    }

    const providerUserId = profile.id
    const displayName = profile.name || null
    const avatarUrl = extractAvatar(profile)
    const userId = await store.upsertUser('minecraft', providerUserId, displayName, avatarUrl)
    const activeTester = config.releases.enabled && await store.isMinecraftTester(providerUserId)
    const grants = await store.getMinecraftEntitlementGrants(providerUserId)
    const minecraftEntitlements = buildMinecraftEntitlements(activeTester, config.releases.requiredEntitlement, grants)
    await store.replaceEntitlements(userId, minecraftEntitlements, 'minecraft')
    const entitlements = await store.getEntitlements(userId)
    const session = await sessions.createSession(userId)

    res.json({
        token: session.token,
        expiresAt: session.expiresAt,
        userId,
        profile: {
            uuid: store.normalizeMinecraftUuid(providerUserId),
            displayName,
            avatarUrl
        },
        entitlements
    })
}))

module.exports = router
module.exports.buildMinecraftEntitlements = buildMinecraftEntitlements
