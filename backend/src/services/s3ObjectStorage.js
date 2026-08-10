const { S3Client, GetObjectCommand, HeadObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3')
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner')

function validateSettings(settings, label = 'object storage') {
    const missing = ['bucket', 'accessKeyId', 'secretAccessKey'].filter(key => !settings?.[key])
    if(missing.length > 0) {
        throw new Error(`${label} is missing ${missing.join(', ')}`)
    }
}

function streamToBuffer(body) {
    if(body == null) return Promise.resolve(Buffer.alloc(0))
    if(typeof body.transformToByteArray === 'function') {
        return body.transformToByteArray().then(bytes => Buffer.from(bytes))
    }
    return new Promise((resolve, reject) => {
        const chunks = []
        body.on('data', chunk => chunks.push(Buffer.from(chunk)))
        body.once('error', reject)
        body.once('end', () => resolve(Buffer.concat(chunks)))
    })
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
        async getBuffer(key) {
            const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
            return streamToBuffer(response.Body)
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
        async signGet(key, expiresIn = null) {
            const ttl = Number.isFinite(Number(expiresIn))
                ? Number(expiresIn)
                : Number(settings.getTtlSeconds) || 900
            return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: ttl })
        }
    }
}

module.exports = { createObjectStorage, createS3Client, streamToBuffer, validateSettings }
