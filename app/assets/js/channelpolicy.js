'use strict'

function calculateOfflineGrant(grant, channel, offlineGrantSeconds, now = Date.now()) {
    const authorizedAt = Date.parse(grant?.authorizedAt || '')
    const ageMs = Number.isFinite(authorizedAt) ? Math.max(0, now - authorizedAt) : Infinity
    return {
        valid: grant?.channel === channel
            && Boolean(grant?.releaseId)
            && Number.isFinite(Number(offlineGrantSeconds))
            && ageMs <= Number(offlineGrantSeconds) * 1000,
        ageMs,
        grant: grant || {}
    }
}

function redactUrlQueries(value) {
    if(typeof value !== 'string') return value
    return value.replace(/https?:\/\/[^\s"'<>]+/gi, match => {
        try {
            const parsed = new URL(match)
            return `${parsed.origin}${parsed.pathname}${parsed.search ? '?[redacted]' : ''}`
        } catch(_err) {
            return '[invalid URL]'
        }
    })
}

function isArtifactAuthorizationError(error) {
    const detail = String(error?.displayable || error?.message || error || '')
    return /HTTP Response (401|403)|\b(401|403)\b/.test(detail)
}

module.exports = { calculateOfflineGrant, isArtifactAuthorizationError, redactUrlQueries }
