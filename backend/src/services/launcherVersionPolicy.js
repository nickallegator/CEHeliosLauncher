'use strict'

const semver = require('semver')

function normalizePolicy(raw, index = 0) {
    if(!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Launcher update policy ${index} must be an object`)
    const channel = String(raw.channel || '').trim().toLowerCase()
    if(!['stable', 'test'].includes(channel)) throw new Error(`Launcher update policy ${index} has an invalid channel`)
    const version = (value, label, nullable = false) => {
        if(nullable && (value == null || value === '')) return null
        const normalized = String(value || '').trim()
        if(!semver.valid(normalized)) throw new Error(`Launcher update policy ${index} ${label} must be valid SemVer`)
        return normalized
    }
    const updateUrl = String(raw.updateUrl || '').trim()
    const parsedUrl = updateUrl ? new URL(updateUrl) : null
    if(parsedUrl && parsedUrl.protocol !== 'https:') throw new Error(`Launcher update policy ${index} updateUrl must use HTTPS`)
    return {
        channel,
        recommendedVersion: version(raw.recommendedVersion, 'recommendedVersion', true),
        minimumVersion: version(raw.minimumVersion, 'minimumVersion', true),
        updateUrl: parsedUrl?.toString() || null,
        enforce: raw.enforce === true,
        requireHeader: raw.requireHeader === true
    }
}

function createLauncherVersionPolicies(entries = []) {
    if(!Array.isArray(entries)) throw new Error('LAUNCHER_UPDATE_POLICY_JSON must be an array')
    const policies = new Map()
    entries.forEach((entry, index) => {
        const policy = normalizePolicy(entry, index)
        if(policies.has(policy.channel)) throw new Error(`Duplicate launcher update policy channel: ${policy.channel}`)
        policies.set(policy.channel, policy)
    })
    return policies
}

function publicPolicy(policy) {
    return {
        schemaVersion: 1,
        channel: policy.channel,
        recommendedVersion: policy.recommendedVersion,
        minimumVersion: policy.minimumVersion,
        updateUrl: policy.updateUrl,
        enforced: policy.enforce
    }
}

function createLauncherVersionMiddleware(policies) {
    return (req, res, next) => {
        if(!req.headers.authorization || req.path === '/auth/minecraft' || req.path === '/launcher/update-policy') return next()
        const channel = String(req.headers['x-ag-launcher-channel'] || '').trim().toLowerCase()
        const currentVersion = String(req.headers['x-ag-launcher-version'] || '').trim()
        const policy = policies.get(channel)
        if(!policy || !policy.enforce || !policy.minimumVersion) return next()
        if(!currentVersion && !policy.requireHeader) return next()
        if(!semver.valid(currentVersion) || semver.lt(currentVersion, policy.minimumVersion)) {
            res.status(426).set('Cache-Control', 'private, no-store').json({
                ...publicPolicy(policy),
                error: 'launcher_update_required',
                requestId: req.requestId
            })
            return
        }
        next()
    }
}

module.exports = { createLauncherVersionMiddleware, createLauncherVersionPolicies, normalizePolicy, publicPolicy }
