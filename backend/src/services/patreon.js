const config = require('../config')

function requirePatreonConfig() {
    if(!config.patreon.clientId || !config.patreon.clientSecret || !config.patreon.redirectUri) {
        return false
    }
    return true
}

function buildAuthorizeUrl(state) {
    const params = new URLSearchParams({
        response_type: 'code',
        client_id: config.patreon.clientId || '',
        redirect_uri: config.patreon.redirectUri || '',
        scope: config.patreon.scopes || '',
        state
    })
    const url = `${config.patreon.authorizeUrl}?${params.toString()}`
    console.log('[patreon] authorize redirect_uri:', config.patreon.redirectUri)
    console.log('[patreon] authorize url:', url)
    return url
}

async function exchangeCode(code) {
    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: config.patreon.clientId || '',
        client_secret: config.patreon.clientSecret || '',
        redirect_uri: config.patreon.redirectUri || ''
    })

    const res = await fetch(config.patreon.tokenUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'AG-Launcher-Access'
        },
        body
    })

    if(!res.ok) {
        const text = await res.text()
        throw new Error(`Token exchange failed (${res.status}): ${text}`)
    }

    return res.json()
}

async function fetchIdentity(accessToken) {
    const params = new URLSearchParams({
        include: 'memberships.currently_entitled_tiers',
        'fields[member]': 'patron_status,currently_entitled_amount_cents',
        'fields[tier]': 'title',
        'fields[user]': 'full_name,first_name,last_name,vanity,image_url,thumb_url'
    })

    const res = await fetch(`${config.patreon.apiBase}/identity?${params.toString()}`, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'User-Agent': 'AG-Launcher-Access'
        }
    })

    if(!res.ok) {
        const text = await res.text()
        throw new Error(`Identity fetch failed (${res.status}): ${text}`)
    }

    return res.json()
}

function parseTierMap(mapString) {
    if(!mapString) {
        return {}
    }
    const map = {}
    mapString.split(',').forEach(pair => {
        const [rawKey, rawValue] = pair.split('=').length > 1 ? pair.split('=') : pair.split(':')
        const key = String(rawKey || '').trim()
        const value = String(rawValue || '').trim()
        if(key && value) {
            map[key] = value
        }
    })
    return map
}

function extractMemberships(payload, campaignId) {
    const included = Array.isArray(payload?.included) ? payload.included : []
    const members = included.filter(item => item?.type === 'member')
    const tiers = included.filter(item => item?.type === 'tier')
    const tierIds = new Set(tiers.map(t => t.id).filter(Boolean))

    const memberships = []
    for(const member of members) {
        const campaignRel = member?.relationships?.campaign?.data?.id || null
        if(campaignId && campaignRel && campaignRel !== campaignId) {
            continue
        }
        const tierRel = member?.relationships?.currently_entitled_tiers?.data || []
        const memberTierIds = tierRel.map(t => t?.id).filter(id => id && tierIds.has(id))
        memberships.push({
            id: member.id,
            patronStatus: member?.attributes?.patron_status || null,
            entitledAmountCents: member?.attributes?.currently_entitled_amount_cents || 0,
            tierIds: memberTierIds
        })
    }
    return memberships
}

function mapEntitlements(memberships) {
    const tierMap = parseTierMap(config.patreon.tierMap)
    const entitlements = new Set()

    for(const membership of memberships) {
        for(const tierId of membership.tierIds) {
            if(tierMap[tierId]) {
                entitlements.add(tierMap[tierId])
            }
        }
        if(entitlements.size === 0 && membership.patronStatus) {
            if(config.patreon.defaultEntitlement) {
                entitlements.add(config.patreon.defaultEntitlement)
            }
        }
    }

    return Array.from(entitlements)
}

module.exports = {
    requirePatreonConfig,
    buildAuthorizeUrl,
    exchangeCode,
    fetchIdentity,
    extractMemberships,
    mapEntitlements
}
