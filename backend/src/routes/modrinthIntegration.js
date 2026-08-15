'use strict'

const crypto = require('crypto')
const express = require('express')
const config = require('../config')
const db = require('../db')
const { asyncRoute } = require('../middleware/asyncRoute')
const { requireSession } = require('../middleware/session')
const { createRateLimit } = require('../middleware/rateLimit')
const { getExternalProviderRegistry } = require('../services/externalProviders')
const accounts = require('../services/modrinthAccounts')

const router = express.Router()
const oauthStartLimit = createRateLimit({ windowMs: 60_000, limit: 10 })
const oauthCallbackLimit = createRateLimit({ windowMs: 60_000, limit: 30 })

function enabled(req, res, next) {
    if(!config.modrinth.enabled) return res.status(404).json({ error: 'modrinth_integration_disabled' })
    next()
}

function hash(value) { return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex') }
function publicAccount(account) {
    return account ? {
        connected: true,
        provider: 'modrinth',
        username: account.username,
        displayName: account.displayName,
        avatarUrl: account.avatarUrl,
        scopes: account.scopes,
        expiresAt: account.expiresAt,
        connectedAt: account.connectedAt,
        reconnectRequired: account.reconnectRequired
    } : { connected: false, provider: 'modrinth', reconnectRequired: false }
}

router.post('/integrations/modrinth/oauth/start', enabled, oauthStartLimit, requireSession, asyncRoute(async (req, res) => {
    const provider = getExternalProviderRegistry().get('modrinth')
    const state = crypto.randomBytes(32).toString('base64url')
    const attemptId = crypto.randomUUID()
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000)
    await db.query(
        `insert into external_oauth_attempts(id,provider,user_id,state_hash,expires_at)
         values ($1,'modrinth',$2,$3,$4)`, [attemptId, req.userId, hash(state), expiresAt])
    res.set('Cache-Control', 'private, no-store')
    res.status(201).json({ schemaVersion: 1, attemptId, expiresAt, authorizationUrl: provider.authorizationUrl({ state }) })
}))

router.get('/integrations/modrinth/oauth/callback', enabled, oauthCallbackLimit, asyncRoute(async (req, res) => {
    const code = String(req.query.code || '').trim()
    const state = String(req.query.state || '').trim()
    if(!code || !state) return res.status(400).type('html').send(callbackPage(false, 'The Modrinth response was incomplete.'))
    const consumed = await db.query(
        `update external_oauth_attempts set status='failed',error_code='exchange_pending'
         where state_hash=$1 and status='pending' and expires_at > now()
         returning id,user_id`, [hash(state)])
    if(!consumed.rows.length) return res.status(400).type('html').send(callbackPage(false, 'This connection request expired or was already used.'))
    const attempt = consumed.rows[0]
    try {
        const provider = getExternalProviderRegistry().get('modrinth')
        const token = await provider.exchangeCode(code)
        const identity = await provider.identity(token.access_token)
        await accounts.saveAccount(attempt.user_id, identity, token)
        await db.query('update external_oauth_attempts set status=\'complete\',error_code=null,completed_at=now() where id=$1', [attempt.id])
        res.set('Cache-Control', 'no-store')
        res.type('html').send(callbackPage(true, `Connected as ${escapeHtml(identity.username || identity.name || 'Modrinth creator')}.`))
    } catch(error) {
        await db.query('update external_oauth_attempts set status=\'failed\',error_code=$2,completed_at=now() where id=$1', [attempt.id, String(error.code || 'oauth_failed').slice(0, 80)])
        res.status(502).type('html').send(callbackPage(false, 'Modrinth authorization could not be completed. Please return to AG Launcher and try again.'))
    }
}))

router.get('/integrations/modrinth/oauth/attempts/:attemptId', enabled, requireSession, asyncRoute(async (req, res) => {
    const { rows } = await db.query(
        `select status,error_code,expires_at,completed_at from external_oauth_attempts
         where id=$1 and user_id=$2 and provider='modrinth'`, [req.params.attemptId, req.userId])
    if(!rows.length) return res.status(404).json({ error: 'oauth_attempt_not_found' })
    const row = rows[0]
    res.set('Cache-Control', 'private, no-store')
    res.json({ schemaVersion: 1, status: row.status, error: row.error_code === 'exchange_pending' ? null : row.error_code, expiresAt: row.expires_at, completedAt: row.completed_at })
}))

router.get('/integrations/modrinth', enabled, requireSession, asyncRoute(async (req, res) => {
    res.set('Cache-Control', 'private, no-store')
    res.json({ schemaVersion: 1, account: publicAccount(await accounts.getAccount(req.userId)) })
}))

router.delete('/integrations/modrinth', enabled, requireSession, asyncRoute(async (req, res) => {
    await accounts.disconnect(req.userId)
    res.status(204).end()
}))

function escapeHtml(value) { return String(value).replace(/[&<>"']/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', '\'':'&#39;' })[character]) }
function callbackPage(success, message) {
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>AG Launcher · Modrinth</title><style>body{margin:0;background:#111a19;color:#e8f3ed;font:16px system-ui;display:grid;place-items:center;min-height:100vh}.card{max-width:560px;padding:40px;border:1px solid #3b6c5c;background:#182522}h1{color:${success ? '#7bd7ae' : '#ef9b7a'}}</style></head><body><main class="card"><h1>${success ? 'Modrinth connected' : 'Unable to connect'}</h1><p>${message}</p><p>You can close this page and return to AG Launcher.</p></main></body></html>`
}

module.exports = router
module.exports.callbackPage = callbackPage
