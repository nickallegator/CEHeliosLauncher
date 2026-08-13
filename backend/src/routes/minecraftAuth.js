const express = require('express')

const sessions = require('../services/sessions')
const store = require('../services/store')
const config = require('../config')
const { createRateLimit } = require('../middleware/rateLimit')
const { asyncRoute } = require('../middleware/asyncRoute')
const {
    MinecraftTokenVerificationError,
    verifyMinecraftAccessToken
} = require('../services/minecraftTokenVerifier')

const router = express.Router()

function verifyMinecraftProfile(accessToken) {
    try {
        return verifyMinecraftAccessToken(accessToken)
    } catch(err) {
        if(err instanceof MinecraftTokenVerificationError) return null
        throw err
    }
}

function buildMinecraftEntitlements(activeTester, requiredEntitlement = config.releases.requiredEntitlement, grants = []) {
    const values = activeTester ? ['minecraft:player', requiredEntitlement] : ['minecraft:player']
    return Array.from(new Set([...values, ...grants].map(value => String(value).toLowerCase())))
}

async function resolveMinecraftEntitlements(providerUserId, dependencies = {}) {
    const entitlementStore = dependencies.store || store
    const requiredEntitlement = dependencies.requiredEntitlement || config.releases.requiredEntitlement
    const [activeTester, grants] = await Promise.all([
        entitlementStore.isMinecraftTester(providerUserId),
        entitlementStore.getMinecraftEntitlementGrants(providerUserId)
    ])
    return buildMinecraftEntitlements(activeTester, requiredEntitlement, grants)
}

router.post('/auth/minecraft', createRateLimit({ windowMs: 60_000, limit: 10 }), asyncRoute(async (req, res) => {
    const accessToken = typeof req.body?.accessToken === 'string' ? req.body.accessToken.trim() : ''
    if(!accessToken){
        res.status(400).json({ error: 'missing_access_token' })
        return
    }

    const profile = verifyMinecraftProfile(accessToken)
    if(!profile){
        res.status(401).json({ error: 'invalid_access_token' })
        return
    }

    const providerUserId = profile.id
    const tester = await store.getMinecraftTester(providerUserId)
    const displayName = tester?.label || null
    const avatarUrl = null
    const userId = await store.upsertUser('minecraft', providerUserId, displayName, avatarUrl)
    // Authentication is shared by the independently deployed release and
    // schematic services. Always resolve tester membership from the shared
    // allowlist so signing in through a schematic-only service cannot revoke
    // an otherwise valid release-channel entitlement.
    const minecraftEntitlements = await resolveMinecraftEntitlements(providerUserId)
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
module.exports.resolveMinecraftEntitlements = resolveMinecraftEntitlements
module.exports.verifyMinecraftProfile = verifyMinecraftProfile
