const config = require('../config')
const { createObjectStorage } = require('./s3ObjectStorage')

const CHANNEL_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const OBJECT_KEY_PATTERN = /^(?:maven|third-party)\/[A-Za-z0-9._+@%/-]+$/

function validateChannel(channel) {
    const normalized = String(channel || '').trim().toLowerCase()
    if(!CHANNEL_PATTERN.test(normalized)) throw new Error('Invalid release channel')
    return normalized
}

function validateObjectKey(key) {
    const normalized = String(key || '').trim()
    if(!OBJECT_KEY_PATTERN.test(normalized)
        || normalized.includes('..')
        || normalized.includes('//')
        || normalized.includes('\\')
        || normalized.startsWith('/')) {
        throw new Error(`Release template contains a disallowed object key: ${normalized || '<empty>'}`)
    }
    return normalized
}

function currentKey(channel) {
    return `channels/${validateChannel(channel)}/current.json`
}

function assertReleasePointer(pointer, channel) {
    const releaseId = String(pointer?.releaseId || '').trim()
    const templateKey = String(pointer?.templateKey || '').trim()
    const descriptorKey = String(pointer?.descriptorKey || '').trim()
    const prefix = `channels/${validateChannel(channel)}/releases/`
    if(!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(releaseId)) {
        throw new Error('Current release pointer has an invalid releaseId')
    }
    if(templateKey !== `${prefix}${releaseId}/distribution-template.json`) {
        throw new Error('Current release pointer has an invalid templateKey')
    }
    if(descriptorKey !== `${prefix}${releaseId}/release.json`) {
        throw new Error('Current release pointer has an invalid descriptorKey')
    }
    return { releaseId, templateKey, descriptorKey }
}

async function replaceR2Urls(value, signer) {
    if(Array.isArray(value)) {
        return Promise.all(value.map(item => replaceR2Urls(item, signer)))
    }
    if(value && typeof value === 'object') {
        const output = {}
        for(const key of Object.keys(value)) {
            output[key] = await replaceR2Urls(value[key], signer)
        }
        return output
    }
    if(typeof value === 'string' && value.startsWith('r2://')) {
        const key = validateObjectKey(value.slice(5))
        return signer(key)
    }
    return value
}

function containsR2Placeholder(value) {
    if(typeof value === 'string') return value.startsWith('r2://')
    if(Array.isArray(value)) return value.some(containsR2Placeholder)
    if(value && typeof value === 'object') return Object.values(value).some(containsR2Placeholder)
    return false
}

function createReleaseStorage(options = {}) {
    const settings = options.settings || config.releases.objectStorage
    const storage = options.storage || createObjectStorage(settings, 'release object storage')
    return {
        async getAuthorizedDistribution(channel = config.releases.channel) {
            const normalizedChannel = validateChannel(channel)
            const pointer = assertReleasePointer(await storage.getJson(currentKey(normalizedChannel)), normalizedChannel)
            const template = await storage.getJson(pointer.templateKey)
            const distribution = await replaceR2Urls(template, key => storage.signGet(key, settings.getTtlSeconds))
            if(containsR2Placeholder(distribution)) {
                throw new Error('Distribution signing left unresolved R2 placeholders')
            }
            return { distribution, releaseId: pointer.releaseId }
        },
        async ready(channel = config.releases.channel) {
            return storage.head(currentKey(channel))
        }
    }
}

module.exports = {
    assertReleasePointer,
    containsR2Placeholder,
    createReleaseStorage,
    currentKey,
    replaceR2Urls,
    validateChannel,
    validateObjectKey
}
