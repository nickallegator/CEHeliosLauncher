'use strict'

const got = require('got')
const { LoggerUtil } = require('helios-core')

const ConfigManager = require('./configmanager')
const AccessManager = require('./accessmanager')
const { loadTesterChannel } = require('./testerchannel')
const { calculateOfflineGrant } = require('./channelpolicy')

const logger = LoggerUtil.getLogger('ChannelManager')
const channel = loadTesterChannel()

class ChannelAccessError extends Error {
    constructor(code, message, options = {}) {
        super(message)
        this.name = 'ChannelAccessError'
        this.code = code
        this.statusCode = options.statusCode || null
        this.offline = Boolean(options.offline)
    }
}

function isRemoteChannel() {
    return channel?.schemaVersion === 2
}

function entitlementSet(values) {
    return new Set((values || []).map(value => String(value || '').trim().toLowerCase()).filter(Boolean))
}

function deriveAuthUrl() {
    const url = new URL(channel.remoteDistributionUrl)
    url.pathname = '/v1/auth/minecraft'
    url.search = ''
    url.hash = ''
    return url.toString()
}

function isSessionFresh(now = Date.now()) {
    const expiresAt = Date.parse(ConfigManager.getAccessSessionExpiresAt() || '')
    return Boolean(AccessManager.getSessionToken()) && Number.isFinite(expiresAt) && expiresAt > now + 30_000
}

function getOfflineGrant(now = Date.now()) {
    if(!isRemoteChannel()) return { valid: false, ageMs: Infinity }
    return calculateOfflineGrant(ConfigManager.getAccessChannelGrant(), channel.channel, channel.offlineGrantSeconds, now)
}

function clearChannelAuthorization(options = {}) {
    const entitlements = AccessManager.getEntitlements()
        .filter(value => String(value).toLowerCase() !== channel?.requiredEntitlement)
    ConfigManager.setAccessEntitlements(entitlements)
    ConfigManager.setAccessChannelGrant(null)
    if(options.clearSession) {
        ConfigManager.setAccessSessionToken(null)
        ConfigManager.setAccessSessionExpiresAt(null)
    }
    ConfigManager.save({ immediate: true })
    if(options.resetDistribution && isRemoteChannel()) {
        require('./distromanager').resetTesterDistributionToBootstrap()
    }
}

async function exchangeMinecraftToken() {
    const selected = ConfigManager.getSelectedAccount()
    if(!selected?.accessToken) {
        throw new ChannelAccessError('login_required', 'Sign in with the allowlisted Microsoft account to use the Cobble Power test channel.')
    }
    let response
    try {
        response = await got.post(deriveAuthUrl(), {
            responseType: 'json',
            json: { accessToken: selected.accessToken },
            timeout: { request: 8_000 },
            retry: { limit: 1 }
        })
    } catch(err) {
        if(err.response?.statusCode === 401) {
            clearChannelAuthorization({ clearSession: true, resetDistribution: true })
            throw new ChannelAccessError('login_required', 'Your Minecraft sign-in expired. Please sign in again.', { statusCode: 401 })
        }
        throw err
    }
    const data = response.body || {}
    const entitlements = entitlementSet(data.entitlements)
    AccessManager.setSessionToken(data.token || null, data.expiresAt || null)
    AccessManager.setEntitlements([...entitlements])
    if(data.profile) {
        AccessManager.setProfile({
            id: data.userId || data.profile.uuid || null,
            uuid: data.profile.uuid || selected.uuid || null,
            displayName: data.profile.displayName || selected.displayName || null,
            avatarUrl: data.profile.avatarUrl || null
        })
    }
    if(!entitlements.has(channel.requiredEntitlement)) {
        clearChannelAuthorization({ resetDistribution: true })
        throw new ChannelAccessError('access_denied', 'This Minecraft account is not enabled for the Cobble Power test channel.', { statusCode: 403 })
    }
    return data.token
}

async function fetchAuthorizedDistribution(sessionToken) {
    try {
        const response = await got.get(channel.remoteDistributionUrl, {
            responseType: 'json',
            headers: { Authorization: `Bearer ${sessionToken}` },
            timeout: { request: 10_000 },
            retry: { limit: 1 }
        })
        const releaseId = String(response.headers['x-cobblepower-release'] || '').trim()
        if(!releaseId) throw new Error('Authorized distribution response did not include a release ID')
        return { rawDistribution: response.body, releaseId }
    } catch(err) {
        const statusCode = err.response?.statusCode || null
        if(statusCode === 403) {
            clearChannelAuthorization({ resetDistribution: true })
            throw new ChannelAccessError('access_denied', 'This Minecraft account is no longer enabled for the Cobble Power test channel.', { statusCode })
        }
        throw err
    }
}

async function refreshAuthorizedDistribution(options = {}) {
    if(!isRemoteChannel()) {
        return { distribution: await require('./distromanager').DistroAPI.getDistribution(), offline: false }
    }
    let token = AccessManager.getSessionToken()
    if(options.forceExchange || !isSessionFresh()) token = await exchangeMinecraftToken()
    try {
        let result
        try {
            result = await fetchAuthorizedDistribution(token)
        } catch(err) {
            if(err.response?.statusCode !== 401) throw err
            token = await exchangeMinecraftToken()
            result = await fetchAuthorizedDistribution(token)
        }
        const distribution = require('./distromanager').installTesterDistribution(result.rawDistribution)
        ConfigManager.setAccessChannelGrant({
            channel: channel.channel,
            releaseId: result.releaseId,
            authorizedAt: new Date().toISOString()
        })
        ConfigManager.setAccessLastSync(new Date().toISOString())
        ConfigManager.save({ immediate: true })
        return { distribution, offline: false, releaseId: result.releaseId }
    } catch(err) {
        if(err instanceof ChannelAccessError) throw err
        const offlineGrant = getOfflineGrant()
        if(options.allowOffline !== false && offlineGrant.valid) {
            logger.warn('Release service unavailable; using the cached authorized distribution within the offline grace period.')
            return {
                distribution: await require('./distromanager').DistroAPI.getDistribution(),
                offline: true,
                releaseId: offlineGrant.grant.releaseId
            }
        }
        throw new ChannelAccessError(
            'connection_required',
            'Connect to the internet to authorize and update the Cobble Power test channel.',
            { offline: true }
        )
    }
}

async function bootstrap() {
    if(!isRemoteChannel() || ConfigManager.getSelectedAccount() == null) return null
    try {
        return await refreshAuthorizedDistribution({ allowOffline: true })
    } catch(err) {
        if(err.code === 'access_denied' || err.code === 'login_required') throw err
        logger.warn('Unable to refresh the tester channel during startup.', err.message || err)
        return null
    }
}

module.exports = {
    ChannelAccessError,
    bootstrap,
    channel,
    clearChannelAuthorization,
    deriveAuthUrl,
    exchangeMinecraftToken,
    getOfflineGrant,
    isRemoteChannel,
    isSessionFresh,
    refreshAuthorizedDistribution
}
