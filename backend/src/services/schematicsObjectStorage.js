'use strict'

const config = require('../config')
const { createObjectStorage } = require('./s3ObjectStorage')

let singleton = null

function createSchematicsObjectStorage(options = {}) {
    const settings = options.settings || config.schematics.objectStorage
    const storage = options.storage || createObjectStorage(settings, 'schematics object storage')
    return {
        ...storage,
        settings,
        async putImmutable(key, body, putOptions = {}) {
            try {
                const existing = await storage.getBuffer(key, { maxBytes: Buffer.byteLength(body) })
                if(!Buffer.from(existing).equals(Buffer.from(body))) {
                    throw new Error(`Immutable schematic object already exists with different content: ${key}`)
                }
                return { existing: true }
            } catch(error) {
                const status = error?.$metadata?.httpStatusCode || error?.statusCode
                const missing = status === 404 || error?.name === 'NoSuchKey' || error?.Code === 'NoSuchKey'
                if(!missing) throw error
            }
            await storage.put(key, body, putOptions)
            return { existing: false }
        }
    }
}

function getSchematicsObjectStorage() {
    if(!singleton) singleton = createSchematicsObjectStorage()
    return singleton
}

function resetSchematicsObjectStorageForTests() {
    singleton = null
}

module.exports = { createSchematicsObjectStorage, getSchematicsObjectStorage, resetSchematicsObjectStorageForTests }
