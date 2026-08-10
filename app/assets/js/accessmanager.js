const got = require('got')
const { LoggerUtil } = require('helios-core')

const ConfigManager = require('./configmanager')

const logger = LoggerUtil.getLogger('AccessManager')

const ENTITLEMENTS_ENV = process.env.HELIOS_ACCESS_ENTITLEMENTS
const ACCESS_API_ENV = process.env.HELIOS_ACCESS_API_URL
const ACCESS_AUTH_ENV = process.env.HELIOS_ACCESS_AUTH_URL
const ACCESS_TOKEN_ENV = process.env.HELIOS_ACCESS_SESSION_TOKEN

function normalizeEntitlements(entitlements) {
    return (entitlements || [])
        .map(e => String(e || '').trim().toLowerCase())
        .filter(Boolean)
}

function parseEntitlementsEnv() {
    if(!ENTITLEMENTS_ENV) {
        return null
    }
    return normalizeEntitlements(ENTITLEMENTS_ENV.split(','))
}

function getEntitlements() {
    const envEntitlements = parseEntitlementsEnv()
    if(envEntitlements != null) {
        return envEntitlements
    }
    return normalizeEntitlements(ConfigManager.getAccessEntitlements())
}

function setEntitlements(entitlements) {
    ConfigManager.setAccessEntitlements(normalizeEntitlements(entitlements))
    ConfigManager.setAccessLastSync(new Date().toISOString())
    ConfigManager.save()
}

function getSessionToken() {
    if(ACCESS_TOKEN_ENV) {
        return ACCESS_TOKEN_ENV
    }
    return ConfigManager.getAccessSessionToken()
}

function setSessionToken(token, expiresAt = undefined) {
    ConfigManager.setAccessSessionToken(token || null)
    if(expiresAt !== undefined) {
        ConfigManager.setAccessSessionExpiresAt(expiresAt || null)
    }
    ConfigManager.save()
}

function clearSessionToken() {
    ConfigManager.setAccessSessionToken(null)
    ConfigManager.setAccessSessionExpiresAt(null)
    ConfigManager.setAccessProfile({ displayName: null })
    ConfigManager.save()
}

function getAccessKey(access) {
    if(access == null) {
        return null
    }
    const provider = String(access.provider || '').trim().toLowerCase()
    const entitlement = String(access.entitlement || '').trim().toLowerCase()
    if(!entitlement) {
        return null
    }
    return provider ? `${provider}:${entitlement}` : entitlement
}

function hasAccess(access) {
    if(access == null) {
        return true
    }
    const entitlements = getEntitlements()
    const key = getAccessKey(access)
    if(!key) {
        return true
    }
    if(entitlements.includes(key)) {
        return true
    }
    const entitlementOnly = key.includes(':') ? key.split(':').slice(1).join(':') : key
    return entitlements.includes(entitlementOnly)
}

function getAccessConfig(distro) {
    const raw = distro?.rawDistribution
    return raw?.access || null
}

function getApiBaseUrl(distro) {
    const accessConfig = getAccessConfig(distro)
    return (ACCESS_API_ENV || accessConfig?.apiBaseUrl || accessConfig?.providers?.patreon?.apiBaseUrl || '').trim() || null
}

function getAuthUrl(distro) {
    const accessConfig = getAccessConfig(distro)
    return (ACCESS_AUTH_ENV || accessConfig?.authUrl || accessConfig?.providers?.patreon?.authUrl || '').trim() || null
}

function getMembershipUrl(distro) {
    const accessConfig = getAccessConfig(distro)
    return (accessConfig?.membershipUrl || accessConfig?.providers?.patreon?.membershipUrl || '').trim() || null
}

function getProfile() {
    return ConfigManager.getAccessProfile()
}

function setProfile(profile) {
    ConfigManager.setAccessProfile(profile)
    ConfigManager.save()
}

async function refreshEntitlements(distro) {
    const apiBaseUrl = getApiBaseUrl(distro)
    const sessionToken = getSessionToken()
    if(!apiBaseUrl || !sessionToken) {
        return getEntitlements()
    }

    try {
        const response = await got.get(`${apiBaseUrl.replace(/\/+$/, '')}/v1/entitlements`, {
            responseType: 'json',
            headers: {
                Authorization: `Bearer ${sessionToken}`
            },
            timeout: { request: 5000 }
        }).json()
        const entitlements = Array.isArray(response?.entitlements) ? response.entitlements : []
        setEntitlements(entitlements)
        return getEntitlements()
    } catch (err) {
        logger.warn('Failed to refresh entitlements.', err)
        return getEntitlements()
    }
}

async function refreshProfile(distro) {
    const apiBaseUrl = getApiBaseUrl(distro)
    const sessionToken = getSessionToken()
    if(!apiBaseUrl || !sessionToken) {
        return getProfile()
    }

    try {
        const response = await got.get(`${apiBaseUrl.replace(/\/+$/, '')}/v1/me`, {
            responseType: 'json',
            headers: {
                Authorization: `Bearer ${sessionToken}`
            },
            timeout: { request: 5000 }
        }).json()
        const entitlements = Array.isArray(response?.entitlements) ? response.entitlements : []
        const userId = response?.id || null
        const displayName = response?.displayName || null
        const avatarUrl = response?.avatarUrl || null
        setEntitlements(entitlements)
        setProfile({ id: userId, displayName, avatarUrl })
        return getProfile()
    } catch (err) {
        logger.warn('Failed to refresh profile.', err)
        return getProfile()
    }
}

module.exports = {
    getEntitlements,
    setEntitlements,
    getSessionToken,
    setSessionToken,
    clearSessionToken,
    getProfile,
    setProfile,
    hasAccess,
    getAccessKey,
    getApiBaseUrl,
    getAuthUrl,
    getMembershipUrl,
    refreshEntitlements,
    refreshProfile
}
