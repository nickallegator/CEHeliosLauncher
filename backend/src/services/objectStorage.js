const { PutObjectCommand, GetObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3')
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner')

const config = require('../config')
const { createS3Client } = require('./s3ObjectStorage')

const SCHEMATIC_FORMAT_EXTENSIONS = {
    json: 'json'
}
const DEFAULT_PUT_TTL_SECONDS = 900
const DEFAULT_GET_TTL_SECONDS = 900
const DEFAULT_PUBLIC_CACHE_CONTROL = 'public, max-age=31536000, immutable'
const DEFAULT_PRIVATE_CACHE_CONTROL = 'private, max-age=60'
const DEFAULT_REDIRECT_CACHE_CONTROL = 'public, max-age=86400'

function normalizeFormat(format){
    const normalized = typeof format === 'string' ? format.trim().toLowerCase() : ''
    return SCHEMATIC_FORMAT_EXTENSIONS[normalized] ? normalized : 'json'
}

function resolveSchematicExtension(format){
    const normalized = normalizeFormat(format)
    return SCHEMATIC_FORMAT_EXTENSIONS[normalized] || 'json'
}

function isEnabled() {
    const settings = config.schematics?.objectStorage
    return Boolean(settings?.provider && settings?.bucket && settings?.accessKeyId && settings?.secretAccessKey)
}

function getPutTtlSeconds() {
    const settings = config.schematics?.objectStorage
    return Number.isFinite(Number(settings?.putTtlSeconds)) ? Number(settings.putTtlSeconds) : DEFAULT_PUT_TTL_SECONDS
}

function getGetTtlSeconds() {
    const settings = config.schematics?.objectStorage
    return Number.isFinite(Number(settings?.getTtlSeconds)) ? Number(settings.getTtlSeconds) : DEFAULT_GET_TTL_SECONDS
}

function getPublicCacheControl() {
    const settings = config.schematics?.objectStorage
    const value = typeof settings?.publicCacheControl === 'string' ? settings.publicCacheControl.trim() : ''
    return value || DEFAULT_PUBLIC_CACHE_CONTROL
}

function getPrivateCacheControl() {
    const settings = config.schematics?.objectStorage
    const value = typeof settings?.privateCacheControl === 'string' ? settings.privateCacheControl.trim() : ''
    return value || DEFAULT_PRIVATE_CACHE_CONTROL
}

function getRedirectCacheControl() {
    const settings = config.schematics?.objectStorage
    const value = typeof settings?.redirectCacheControl === 'string' ? settings.redirectCacheControl.trim() : ''
    return value || DEFAULT_REDIRECT_CACHE_CONTROL
}

function getClient() {
    const settings = config.schematics.objectStorage
    return createS3Client(settings, 'schematics object storage')
}

function buildObjectKey(id, format) {
    const ext = resolveSchematicExtension(format)
    return `${id}.${ext}`
}

function buildHashObjectKey(hash, format) {
    const safeHash = String(hash || '').trim().toLowerCase()
    const ext = resolveSchematicExtension(format)
    return `hash/${safeHash}.${ext}`
}

function buildThumbnailKey(id, label, mime) {
    const safeLabel = String(label || 'thumb').replace(/[^a-z0-9_-]/gi, '_')
    let ext = 'png'
    if(mime === 'image/webp') {
        ext = 'webp'
    } else if(mime === 'image/jpeg') {
        ext = 'jpg'
    }
    return `${id}-${safeLabel}.${ext}`
}

async function signPutObject(key, contentType, options = {}) {
    const settings = config.schematics.objectStorage
    const client = getClient()
    const expiresIn = Number.isFinite(Number(options.expiresIn)) ? Number(options.expiresIn) : getPutTtlSeconds()
    const command = new PutObjectCommand({
        Bucket: settings.bucket,
        Key: key,
        ContentType: contentType || 'application/octet-stream',
        CacheControl: options.cacheControl || undefined
    })
    return getSignedUrl(client, command, { expiresIn })
}

async function signGetObject(key, expiresIn = null) {
    const settings = config.schematics.objectStorage
    const client = getClient()
    const command = new GetObjectCommand({
        Bucket: settings.bucket,
        Key: key
    })
    const ttl = Number.isFinite(Number(expiresIn)) ? Number(expiresIn) : getGetTtlSeconds()
    return getSignedUrl(client, command, { expiresIn: ttl })
}

async function getObject(key) {
    const settings = config.schematics.objectStorage
    const client = getClient()
    const command = new GetObjectCommand({
        Bucket: settings.bucket,
        Key: key
    })
    return client.send(command)
}

async function headObject(key) {
    const settings = config.schematics.objectStorage
    const client = getClient()
    const command = new HeadObjectCommand({
        Bucket: settings.bucket,
        Key: key
    })
    return client.send(command)
}

function getPublicUrl(key) {
    const base = config.schematics.objectStorage.publicBaseUrl
    if(!base) {
        return null
    }
    return `${base.replace(/\/+$/, '')}/${key.replace(/^\/+/, '')}`
}

module.exports = {
    isEnabled,
    normalizeFormat,
    resolveSchematicExtension,
    buildObjectKey,
    buildHashObjectKey,
    buildThumbnailKey,
    getPutTtlSeconds,
    getGetTtlSeconds,
    getPublicCacheControl,
    getPrivateCacheControl,
    getRedirectCacheControl,
    signPutObject,
    signGetObject,
    getObject,
    headObject,
    getPublicUrl
}
