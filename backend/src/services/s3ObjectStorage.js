const { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, PutObjectCommand, S3Client } = require('@aws-sdk/client-s3')
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner')

function validateSettings(settings, label = 'object storage') {
    const missing = ['bucket', 'accessKeyId', 'secretAccessKey'].filter(key => !settings?.[key])
    if(missing.length > 0) {
        throw new Error(`${label} is missing ${missing.join(', ')}`)
    }
}

async function streamToBuffer(body, maxBytes = null) {
    if(body == null) return Promise.resolve(Buffer.alloc(0))
    const parsedLimit = maxBytes == null || maxBytes === '' ? null : Number(maxBytes)
    const limit = Number.isFinite(parsedLimit) && parsedLimit >= 0 ? parsedLimit : null
    if(typeof body[Symbol.asyncIterator] === 'function') {
        const chunks = []
        let received = 0
        for await (const chunk of body) {
            const value = Buffer.from(chunk)
            received += value.length
            if(limit != null && received > limit) {
                if(typeof body.destroy === 'function') body.destroy()
                const error = new Error(`Object exceeds the ${limit} byte limit.`)
                error.code = 'OBJECT_TOO_LARGE'
                throw error
            }
            chunks.push(value)
        }
        return Buffer.concat(chunks, received)
    }
    const bytes = typeof body.transformToByteArray === 'function'
        ? Buffer.from(await body.transformToByteArray())
        : Buffer.from(body)
    if(limit != null && bytes.length > limit) {
        const error = new Error(`Object exceeds the ${limit} byte limit.`)
        error.code = 'OBJECT_TOO_LARGE'
        throw error
    }
    return bytes
}

function createS3Client(settings, label = 'object storage') {
    validateSettings(settings, label)
    return new S3Client({
        region: settings.region || 'auto',
        endpoint: settings.endpoint || undefined,
        forcePathStyle: Boolean(settings.forcePathStyle),
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
        credentials: {
            accessKeyId: settings.accessKeyId,
            secretAccessKey: settings.secretAccessKey
        }
    })
}

function createObjectStorage(settings, label = 'object storage') {
    const client = createS3Client(settings, label)
    const bucket = settings.bucket

    return {
        bucket,
        async head(key) {
            return client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
        },
        async getBuffer(key, options = {}) {
            const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
            return streamToBuffer(response.Body, options.maxBytes)
        },
        async getJson(key) {
            const body = await this.getBuffer(key)
            return JSON.parse(body.toString('utf8'))
        },
        async put(key, body, options = {}) {
            return client.send(new PutObjectCommand({
                Bucket: bucket,
                Key: key,
                Body: body,
                ContentType: options.contentType,
                CacheControl: options.cacheControl,
                Metadata: options.metadata
            }))
        },
        async delete(key) {
            return client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
        },
        async signPut(key, options = {}) {
            const ttl = Number.isFinite(Number(options.expiresIn))
                ? Number(options.expiresIn)
                : Number(settings.putTtlSeconds) || 900
            return getSignedUrl(client, new PutObjectCommand({
                Bucket: bucket,
                Key: key,
                ContentType: options.contentType || 'application/octet-stream'
            }), { expiresIn: ttl })
        },
        async signGet(key, expiresIn = null) {
            const ttl = Number.isFinite(Number(expiresIn))
                ? Number(expiresIn)
                : Number(settings.getTtlSeconds) || 900
            return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: ttl })
        },
        async ready() {
            return client.send(new HeadBucketCommand({ Bucket: bucket }))
        }
    }
}

module.exports = { createObjectStorage, createS3Client, streamToBuffer, validateSettings }
