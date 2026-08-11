'use strict'

const crypto = require('crypto')
const fs = require('fs')
const {
    S3Client,
    GetObjectCommand,
    HeadObjectCommand,
    PutObjectCommand
} = require('@aws-sdk/client-s3')

const { hashFile, loadPrepared, stableJson } = require('./release-publisher')

function storageSettings(environment = process.env) {
    const settings = {
        bucket: environment.RELEASES_STORAGE_BUCKET,
        region: environment.RELEASES_STORAGE_REGION || 'auto',
        endpoint: environment.RELEASES_STORAGE_ENDPOINT,
        accessKeyId: environment.RELEASES_STORAGE_ACCESS_KEY_ID,
        secretAccessKey: environment.RELEASES_STORAGE_SECRET_ACCESS_KEY,
        forcePathStyle: ['1', 'true', 'yes'].includes(String(environment.RELEASES_STORAGE_FORCE_PATH_STYLE || '').toLowerCase())
    }
    const missing = ['bucket', 'endpoint', 'accessKeyId', 'secretAccessKey'].filter(key => !settings[key])
    if(missing.length) throw new Error(`Missing release storage configuration: ${missing.join(', ')}`)
    return settings
}

async function hashBody(body) {
    const md5 = crypto.createHash('md5')
    const sha256 = crypto.createHash('sha256')
    let size = 0
    if(typeof body.transformToWebStream === 'function') body = body.transformToWebStream()
    for await (const chunk of body) {
        const buffer = Buffer.from(chunk)
        size += buffer.length
        md5.update(buffer)
        sha256.update(buffer)
    }
    return { size, md5: md5.digest('hex'), sha256: sha256.digest('hex') }
}

function createRemoteStorage(settings = storageSettings()) {
    const client = new S3Client({
        region: settings.region,
        endpoint: settings.endpoint,
        forcePathStyle: settings.forcePathStyle,
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
        credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey }
    })
    const Bucket = settings.bucket
    return {
        async head(key) {
            try { return await client.send(new HeadObjectCommand({ Bucket, Key: key })) }
            catch(err) {
                if(err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound' || err?.Code === 'NoSuchKey') return null
                throw err
            }
        },
        async get(key) {
            return client.send(new GetObjectCommand({ Bucket, Key: key }))
        },
        async getJson(key) {
            const response = await this.get(key)
            const chunks = []
            for await (const chunk of response.Body) chunks.push(Buffer.from(chunk))
            return { value: JSON.parse(Buffer.concat(chunks).toString('utf8')), etag: response.ETag || null }
        },
        async hash(key) {
            const response = await this.get(key)
            return hashBody(response.Body)
        },
        async put(key, body, options = {}) {
            return client.send(new PutObjectCommand({
                Bucket,
                Key: key,
                Body: body,
                ContentType: options.contentType,
                CacheControl: options.cacheControl,
                Metadata: options.metadata,
                IfNoneMatch: options.ifNoneMatch,
                IfMatch: options.ifMatch
            }))
        }
    }
}

async function verifyRemoteObject(storage, expected) {
    const head = await storage.head(expected.key)
    if(!head) throw new Error(`Remote object is missing: ${expected.key}`)
    if(Number(head.ContentLength) !== expected.size) throw new Error(`Remote size mismatch: ${expected.key}`)
    if(head.Metadata?.sha256 && head.Metadata.sha256 !== expected.sha256) throw new Error(`Remote metadata checksum mismatch: ${expected.key}`)
    const integrity = await storage.hash(expected.key)
    if(integrity.sha256 !== expected.sha256 || integrity.md5 !== expected.md5 || integrity.size !== expected.size) {
        throw new Error(`Remote checksum verification failed: ${expected.key}`)
    }
    return integrity
}

async function publishPrepared(preparedDir, storage = createRemoteStorage()) {
    const { state } = loadPrepared(preparedDir)
    for(const object of state.objects) {
        const local = await hashFile(object.filePath)
        if(local.size !== object.size || local.md5 !== object.md5 || local.sha256 !== object.sha256) {
            throw new Error(`Prepared object drifted: ${object.file}`)
        }
        const existing = await storage.head(object.key)
        if(existing) {
            if(Number(existing.ContentLength) !== object.size || existing.Metadata?.sha256 !== object.sha256) {
                throw new Error(`Refusing to overwrite immutable object: ${object.key}`)
            }
        } else {
            await storage.put(object.key, fs.createReadStream(object.filePath), {
                contentType: object.contentType,
                cacheControl: 'private, max-age=31536000, immutable',
                metadata: { sha256: object.sha256, md5: object.md5, releaseid: state.releaseId },
                ifNoneMatch: '*'
            })
        }
        await verifyRemoteObject(storage, object)
    }
    return state
}

async function verifyRelease(releaseId, channel = 'test', storage = createRemoteStorage()) {
    const prefix = `channels/${channel}/releases/${releaseId}`
    const descriptorResponse = await storage.getJson(`${prefix}/release.json`)
    const descriptor = descriptorResponse.value
    if(descriptor.releaseId !== releaseId || descriptor.channel !== channel) throw new Error('Release descriptor identity mismatch')
    const privateModules = descriptor.modules.filter(module => module.objectKey)
    for(const module of privateModules) {
        await verifyRemoteObject(storage, {
            key: module.objectKey,
            size: module.size,
            md5: module.md5,
            sha256: module.sha256
        })
    }
    for(const notice of descriptor.notices || []) {
        await verifyRemoteObject(storage, {
            key: notice.objectKey,
            size: notice.size,
            md5: notice.md5,
            sha256: notice.sha256
        })
    }
    const templateHead = await storage.head(`${prefix}/distribution-template.json`)
    if(!templateHead) throw new Error('Release distribution template is missing')
    return descriptor
}

async function readCurrent(channel, storage) {
    const key = `channels/${channel}/current.json`
    try {
        const result = await storage.getJson(key)
        return { key, pointer: result.value, etag: result.etag }
    } catch(err) {
        if(err?.$metadata?.httpStatusCode === 404 || err?.name === 'NoSuchKey') return { key, pointer: null, etag: null }
        throw err
    }
}

async function getCurrentRelease(channel = 'test', storage = createRemoteStorage()) {
    const current = await readCurrent(channel, storage)
    return {
        schemaVersion: 1,
        channel,
        releaseId: current.pointer?.releaseId || null
    }
}

async function promoteRelease(options, storage = createRemoteStorage()) {
    const channel = options.channel || 'test'
    const releaseId = options.releaseId
    await verifyRelease(releaseId, channel, storage)
    const current = await readCurrent(channel, storage)
    const actualPrevious = current.pointer?.releaseId || null
    if(actualPrevious === releaseId) return { ...current.pointer, unchanged: true }
    const expectedPrevious = options.expectedPreviousReleaseId || null
    if(actualPrevious !== expectedPrevious) {
        throw new Error(`Channel moved: expected previous release ${expectedPrevious || '<none>'}, found ${actualPrevious || '<none>'}`)
    }
    const prefix = `channels/${channel}/releases/${releaseId}`
    const pointer = {
        schemaVersion: 1,
        releaseId,
        templateKey: `${prefix}/distribution-template.json`,
        descriptorKey: `${prefix}/release.json`,
        promotedAt: options.promotedAt || new Date().toISOString()
    }
    await storage.put(current.key, stableJson(pointer), {
        contentType: 'application/json',
        cacheControl: 'private, no-store',
        ifMatch: current.etag || undefined,
        ifNoneMatch: current.etag ? undefined : '*'
    })
    const confirmed = await storage.getJson(current.key)
    if(confirmed.value.releaseId !== releaseId) throw new Error('Promotion pointer verification failed')
    return pointer
}

async function verifyCurrent(channel = 'test', storage = createRemoteStorage()) {
    const current = await readCurrent(channel, storage)
    if(!current.pointer?.releaseId) throw new Error(`Channel ${channel} has no current release`)
    return verifyRelease(current.pointer.releaseId, channel, storage)
}

module.exports = {
    createRemoteStorage,
    getCurrentRelease,
    hashBody,
    promoteRelease,
    publishPrepared,
    readCurrent,
    storageSettings,
    verifyCurrent,
    verifyRelease,
    verifyRemoteObject
}
