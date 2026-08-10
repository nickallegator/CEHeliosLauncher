const express = require('express')
const crypto = require('crypto')

const config = require('../config')
const store = require('../services/store')
const sessions = require('../services/sessions')
const patreon = require('../services/patreon')

const router = express.Router()

function buildState() {
    return crypto.randomBytes(24).toString('base64url')
}

function stateExpiry() {
    return new Date(Date.now() + config.oauthStateTtlMinutes * 60 * 1000)
}

function formatTokenResponse(token, redirectUrl) {
    const escaped = String(token)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
    const redirectText = redirectUrl
        ? `If the launcher did not update, you can copy the token below and paste it into the launcher.`
        : `Copy the token below into the launcher.`
    return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Patreon Linked</title>
    <style>
      body { font-family: Arial, sans-serif; padding: 24px; background: #111; color: #f6f6f6; }
      .box { background: #1f1f1f; padding: 16px; border-radius: 8px; }
      code { display: block; padding: 12px; background: #0b0b0b; border-radius: 6px; word-break: break-all; }
    </style>
  </head>
  <body>
    <h1>Patreon linked</h1>
    <p>${redirectText}</p>
    <div class="box">
      <code>${escaped}</code>
    </div>
  </body>
</html>`
}

router.get('/start', async (req, res) => {
    if(!patreon.requirePatreonConfig()) {
        res.status(500).json({ error: 'patreon_not_configured' })
        return
    }

    const state = buildState()
    const redirectUrl = req.query.redirect ? String(req.query.redirect) : null
    console.log('[auth] start redirect param:', redirectUrl || 'none')
    await store.createOAuthState(state, redirectUrl, stateExpiry())
    res.redirect(patreon.buildAuthorizeUrl(state))
})

router.get('/callback', async (req, res) => {
    const code = String(req.query.code || '')
    const state = String(req.query.state || '')
    if(!code || !state) {
        res.status(400).json({ error: 'missing_code_or_state' })
        return
    }

    const stateRecord = await store.consumeOAuthState(state)
    if(stateRecord == null) {
        res.status(400).json({ error: 'invalid_state' })
        return
    }
    const redirectUrl = stateRecord.redirectUrl
    console.log('[auth] callback redirect target:', redirectUrl || 'none')

    try {
        const tokenResponse = await patreon.exchangeCode(code)
        const identity = await patreon.fetchIdentity(tokenResponse.access_token)
        const userId = identity?.data?.id
        if(!userId) {
            res.status(400).json({ error: 'missing_user_id' })
            return
        }

        const attrs = identity?.data?.attributes || {}
        const fullName = attrs.full_name || null
        const vanity = attrs.vanity || null
        const first = attrs.first_name || null
        const last = attrs.last_name || null
        const combined = [first, last].filter(Boolean).join(' ') || null
        const displayName = fullName || vanity || combined || first || last || null
        const avatarUrl = attrs.image_url || attrs.thumb_url || null
        const localUserId = await store.upsertUser('patreon', userId, displayName, avatarUrl)
        await store.savePatreonTokens(localUserId, tokenResponse)

        const memberships = patreon.extractMemberships(identity, config.patreon.campaignId)
        let entitlements = patreon.mapEntitlements(memberships)
        if(entitlements.length === 0 && config.patreon.creatorUserId && String(userId) === String(config.patreon.creatorUserId)) {
            entitlements = ['patreon:supporter']
            console.log('[patreon] creator override applied')
        }
        console.log('[patreon] memberships', JSON.stringify(memberships))
        console.log('[patreon] entitlements', JSON.stringify(entitlements))
        await store.replaceEntitlements(localUserId, entitlements, 'patreon')

        const session = await sessions.createSession(localUserId)

        if(redirectUrl) {
            if(redirectUrl.includes('{token}')) {
                const target = redirectUrl.replace('{token}', session.token)
                console.log('[auth] redirecting to', target)
                res.redirect(target)
                return
            }
            try {
                const url = new URL(redirectUrl)
                url.searchParams.set('token', session.token)
                const target = url.toString()
                console.log('[auth] redirecting to', target)
                res.redirect(target)
                return
            } catch (err) {
                // Fall through to HTML token page.
            }
        }

        res.setHeader('Content-Type', 'text/html')
        res.send(formatTokenResponse(session.token, redirectUrl))
    } catch (err) {
        console.error('[auth] callback error', err)
        res.status(500).json({ error: 'auth_failed' })
    }
})

module.exports = router
