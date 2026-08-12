'use strict'

const fs = require('fs')
const config = require('../config')
const { createObjectStorage } = require('./s3ObjectStorage')

let singleton = null

function isMissingObject(error) {
    const status = error?.$metadata?.httpStatusCode || error?.statusCode
    return status === 404 || error?.name === 'NoSuchKey' || error?.Code === 'NoSuchKey'
}

function createCommunityObjectStorage(options = {}) {
    const settings = options.settings || config.community.objectStorage
    const storage = options.storage || createObjectStorage(settings, 'Community object storage')
    return {
        ...storage,
        settings,
        async putImmutable(key, body, putOptions = {}) {
            const expected = Buffer.isBuffer(body) ? body : Buffer.from(body)
            try {
                const existing = await storage.getBuffer(key, { maxBytes: expected.length })
                if(!Buffer.from(existing).equals(expected)) {
                    const error = new Error(`Immutable Community object already exists with different content: ${key}`)
                    error.code = 'IMMUTABLE_OBJECT_DRIFT'
                    throw error
                }
                return { existing: true }
            } catch(error) {
                if(!isMissingObject(error)) throw error
            }
            await storage.put(key, expected, putOptions)
            const uploaded = await storage.getBuffer(key, { maxBytes: expected.length })
            if(!Buffer.from(uploaded).equals(expected)) {
                await storage.delete(key).catch(() => {})
                const error = new Error(`Immutable Community object failed remote verification: ${key}`)
                error.code = 'IMMUTABLE_OBJECT_VERIFICATION_FAILED'
                throw error
            }
            return { existing: false }
        },
        async putImmutableFile(key, filePath, expected, putOptions = {}) {
            try {
                const actual = await storage.hash(key, { maxBytes: Number(expected.sizeBytes) })
                if(Number(actual.sizeBytes) !== Number(expected.sizeBytes) || actual.sha256 !== String(expected.sha256).toLowerCase()) {
                    const error = new Error(`Immutable Community object already exists with different content: ${key}`)
                    error.code = 'IMMUTABLE_OBJECT_DRIFT'
                    throw error
                }
                return { existing: true }
            } catch(error) {
                if(!isMissingObject(error)) throw error
            }
            await storage.put(key, fs.createReadStream(filePath), {
                ...putOptions,
                contentLength: Number(expected.sizeBytes),
                metadata: { ...(putOptions.metadata || {}), sha256: expected.sha256 }
            })
            const uploaded = await storage.hash(key, { maxBytes: Number(expected.sizeBytes) })
            if(Number(uploaded.sizeBytes) !== Number(expected.sizeBytes) || uploaded.sha256 !== String(expected.sha256).toLowerCase()) {
                await storage.delete(key).catch(() => {})
                const error = new Error(`Immutable Community object failed remote verification: ${key}`)
                error.code = 'IMMUTABLE_OBJECT_VERIFICATION_FAILED'
                throw error
            }
            return { existing: false }
        }
    }
}

function getCommunityObjectStorage() {
    if(!singleton) singleton = createCommunityObjectStorage()
    return singleton
}

function resetCommunityObjectStorageForTests() {
    singleton = null
}

module.exports = {
    createCommunityObjectStorage,
    getCommunityObjectStorage,
    isMissingObject,
    resetCommunityObjectStorageForTests
}
