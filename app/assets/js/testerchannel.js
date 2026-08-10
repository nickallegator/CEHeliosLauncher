'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const CHANNEL_SCHEMA_VERSION = 2
const LEGACY_CHANNEL_SCHEMA_VERSION = 1
const CHANNEL_FILE_NAME = 'tester-channel.json'

function requireString(value, label) {
    const normalized = String(value == null ? '' : value).trim()
    if(!normalized){
        throw new Error(`${label} is required`)
    }
    return normalized
}

function resolveContainedPath(root, relativePath, label) {
    const value = requireString(relativePath, label)
    if(path.isAbsolute(value)){
        throw new Error(`${label} must be relative`)
    }
    const resolvedRoot = path.resolve(root)
    const resolved = path.resolve(resolvedRoot, value)
    if(resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)){
        throw new Error(`${label} must stay inside ${resolvedRoot}`)
    }
    return resolved
}

function resolveChannelPath(options = {}) {
    const environment = options.environment || process.env
    if(environment.HELIOS_TEST_CHANNEL_PATH){
        return path.resolve(environment.HELIOS_TEST_CHANNEL_PATH)
    }
    const resourcesPath = options.resourcesPath || process.resourcesPath
    if(!resourcesPath){
        return null
    }
    const candidate = path.join(resourcesPath, 'tester', CHANNEL_FILE_NAME)
    return fs.existsSync(candidate) ? candidate : null
}

function validateDigest(value, algorithm, label) {
    const normalized = requireString(value, label).toLowerCase()
    const length = algorithm === 'sha256' ? 64 : 32
    if(!new RegExp(`^[a-f0-9]{${length}}$`).test(normalized)){
        throw new Error(`${label} must be a valid ${algorithm.toUpperCase()} digest`)
    }
    return normalized
}

function validateSize(value, label) {
    if(!Number.isSafeInteger(value) || value <= 0){
        throw new Error(`${label} must be a positive integer`)
    }
    return value
}

function loadTesterChannel(options = {}) {
    const channelPath = options.channelPath
        ? path.resolve(options.channelPath)
        : resolveChannelPath(options)
    if(channelPath == null || !fs.existsSync(channelPath)){
        return null
    }

    let raw
    try {
        raw = JSON.parse(fs.readFileSync(channelPath, 'utf8'))
    } catch(err) {
        throw new Error(`Unable to read tester channel ${channelPath}: ${err.message}`)
    }
    if(raw.schemaVersion !== CHANNEL_SCHEMA_VERSION && raw.schemaVersion !== LEGACY_CHANNEL_SCHEMA_VERSION){
        throw new Error(`Unsupported tester channel schemaVersion: ${raw.schemaVersion}`)
    }

    const root = path.dirname(channelPath)
    if(raw.schemaVersion === CHANNEL_SCHEMA_VERSION){
        const bootstrapDistributionPath = resolveContainedPath(root, raw.bootstrapDistribution, 'bootstrapDistribution')
        if(!fs.existsSync(bootstrapDistributionPath)){
            throw new Error(`Tester bootstrap distribution is missing: ${bootstrapDistributionPath}`)
        }
        const remoteDistributionUrl = requireString(raw.remoteDistributionUrl, 'remoteDistributionUrl')
        let parsedRemote
        try {
            parsedRemote = new URL(remoteDistributionUrl)
        } catch(_err) {
            throw new Error('remoteDistributionUrl must be a valid URL')
        }
        if(parsedRemote.protocol !== 'https:' && parsedRemote.hostname !== 'localhost' && parsedRemote.hostname !== '127.0.0.1'){
            throw new Error('remoteDistributionUrl must use HTTPS')
        }
        const offlineGrantSeconds = Number(raw.offlineGrantSeconds)
        if(!Number.isSafeInteger(offlineGrantSeconds) || offlineGrantSeconds < 0 || offlineGrantSeconds > 86400){
            throw new Error('offlineGrantSeconds must be an integer between 0 and 86400')
        }
        const requiredEntitlement = requireString(raw.requiredEntitlement, 'requiredEntitlement').toLowerCase()
        if(!/^[a-z0-9][a-z0-9:_-]*$/.test(requiredEntitlement)){
            throw new Error('requiredEntitlement contains invalid characters')
        }
        return {
            schemaVersion: CHANNEL_SCHEMA_VERSION,
            channelPath,
            bootstrapDistributionPath,
            distributionPath: bootstrapDistributionPath,
            id: requireString(raw.id, 'id'),
            name: requireString(raw.name, 'name'),
            channel: requireString(raw.channel, 'channel').toLowerCase(),
            remoteDistributionUrl,
            requiredEntitlement,
            offlineGrantSeconds,
            artifacts: []
        }
    }

    const distributionPath = resolveContainedPath(root, raw.distribution, 'distribution')
    if(!fs.existsSync(distributionPath)){
        throw new Error(`Tester distribution is missing: ${distributionPath}`)
    }
    if(!Array.isArray(raw.artifacts) || raw.artifacts.length === 0){
        throw new Error('Tester channel must contain at least one bundled artifact')
    }

    const artifacts = raw.artifacts.map((artifact, index) => {
        const label = `artifacts[${index}]`
        return {
            id: requireString(artifact.id, `${label}.id`),
            sourcePath: resolveContainedPath(root, artifact.source, `${label}.source`),
            destination: requireString(artifact.destination, `${label}.destination`),
            size: validateSize(artifact.size, `${label}.size`),
            md5: validateDigest(artifact.md5, 'md5', `${label}.md5`),
            sha256: validateDigest(artifact.sha256, 'sha256', `${label}.sha256`)
        }
    })

    return {
        schemaVersion: LEGACY_CHANNEL_SCHEMA_VERSION,
        channelPath,
        distributionPath,
        id: requireString(raw.id, 'id'),
        name: requireString(raw.name, 'name'),
        artifacts
    }
}

function hashFile(filePath, algorithm) {
    return crypto.createHash(algorithm).update(fs.readFileSync(filePath)).digest('hex')
}

function isValidArtifact(filePath, artifact) {
    if(!fs.existsSync(filePath) || fs.statSync(filePath).size !== artifact.size){
        return false
    }
    return hashFile(filePath, 'sha256') === artifact.sha256
}

function seedBundledArtifacts(dataDirectory, options = {}) {
    const channel = loadTesterChannel(options)
    if(channel == null){
        return []
    }

    const resolvedDataDirectory = path.resolve(requireString(dataDirectory, 'dataDirectory'))
    const seeded = []
    for(const artifact of channel.artifacts){
        if(!isValidArtifact(artifact.sourcePath, artifact)){
            throw new Error(`Bundled tester artifact failed integrity validation: ${artifact.id}`)
        }

        const destinationPath = resolveContainedPath(
            resolvedDataDirectory,
            artifact.destination,
            `destination for ${artifact.id}`
        )
        if(isValidArtifact(destinationPath, artifact)){
            continue
        }

        fs.mkdirSync(path.dirname(destinationPath), { recursive: true })
        const temporaryPath = `${destinationPath}.${process.pid}.${crypto.randomUUID()}.tmp`
        try {
            fs.copyFileSync(artifact.sourcePath, temporaryPath)
            if(!isValidArtifact(temporaryPath, artifact)){
                throw new Error(`Failed to stage bundled tester artifact: ${artifact.id}`)
            }
            fs.rmSync(destinationPath, { force: true })
            fs.renameSync(temporaryPath, destinationPath)
        } finally {
            fs.rmSync(temporaryPath, { force: true })
        }
        seeded.push(destinationPath)
    }
    return seeded
}

function isTesterBuild(options = {}) {
    return loadTesterChannel(options) != null
}

module.exports = {
    CHANNEL_FILE_NAME,
    CHANNEL_SCHEMA_VERSION,
    LEGACY_CHANNEL_SCHEMA_VERSION,
    isTesterBuild,
    loadTesterChannel,
    resolveChannelPath,
    seedBundledArtifacts
}
