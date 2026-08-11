'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const test = require('node:test')

process.env.SCHEMATICS_ENABLED = 'false'

const { cleanMetadata, hashToken, imageVariants } = require('../../backend/src/routes/schematics')
const { floorWindow } = require('../../backend/src/services/schematicsRateLimits')
const { createSchematicsObjectStorage } = require('../../backend/src/services/schematicsObjectStorage')
const { streamToBuffer } = require('../../backend/src/services/s3ObjectStorage')

test('schematic metadata permits only public visibility', () => {
    assert.deepEqual(cleanMetadata({ name: ' Pilot ', tags: 'one, Two, one', visibility: 'public' }), {
        name: 'Pilot',
        description: '',
        tags: ['one', 'Two'],
        visibility: 'public',
        releaseVersion: null
    })
    assert.throws(() => cleanMetadata({ name: 'Private', visibility: 'private' }), /only public/i)
})

test('upload tokens are stored as irreversible SHA-256 values', () => {
    const token = crypto.randomBytes(32).toString('base64url')
    const hash = hashToken(token)
    assert.equal(hash.length, 64)
    assert.notEqual(hash, token)
    assert.equal(hashToken(token), hash)
})

test('preview pipeline validates and creates bounded immutable variants', async () => {
    const sharp = require('../../backend/node_modules/sharp')
    const input = await sharp({
        create: { width: 800, height: 400, channels: 4, background: { r: 40, g: 80, b: 120, alpha: 1 } }
    }).png().toBuffer()
    const variants = await imageVariants(input)
    assert.equal(variants.length, 4)
    assert.deepEqual(new Set(variants.map(item => item.label)), new Set(['tiny', 'medium']))
    assert.deepEqual(new Set(variants.map(item => item.mime)), new Set(['image/webp', 'image/png']))
    assert.ok(variants.every(item => item.width <= (item.label === 'tiny' ? 128 : 512)))
    await assert.rejects(() => imageVariants(Buffer.from('not an image')))
})

test('persistent rate-limit windows are deterministic', () => {
    assert.equal(floorWindow(new Date('2026-08-10T10:59:59.999Z'), 60 * 60 * 1000).toISOString(), '2026-08-10T10:00:00.000Z')
})

test('immutable object writes refuse upstream drift', async () => {
    const values = new Map([['schematics/aa/hash.json', Buffer.from('old')]])
    const storage = createSchematicsObjectStorage({
        settings: {},
        storage: {
            getBuffer: async key => {
                if(!values.has(key)) {
                    const error = new Error('missing')
                    error.$metadata = { httpStatusCode: 404 }
                    throw error
                }
                return values.get(key)
            },
            put: async (key, body) => values.set(key, Buffer.from(body))
        }
    })
    assert.deepEqual(await storage.putImmutable('schematics/aa/hash.json', Buffer.from('old')), { existing: true })
    await assert.rejects(() => storage.putImmutable('schematics/aa/hash.json', Buffer.from('changed')), /different content/i)
    assert.deepEqual(await storage.putImmutable('schematics/bb/new.json', Buffer.from('new')), { existing: false })
})

test('object downloads stop as soon as the configured byte limit is exceeded', async () => {
    async function* chunks() {
        yield Buffer.from('1234')
        yield Buffer.from('5678')
    }
    assert.equal((await streamToBuffer(chunks(), 8)).toString('utf8'), '12345678')
    await assert.rejects(() => streamToBuffer(chunks(), 7), error => error.code === 'OBJECT_TOO_LARGE')
})

test('object downloads are unlimited when no byte limit is supplied', async () => {
    async function* chunks() {
        yield Buffer.from('distribution-')
        yield Buffer.from('template')
    }
    assert.equal((await streamToBuffer(chunks())).toString('utf8'), 'distribution-template')
    assert.equal((await streamToBuffer(chunks(), null)).toString('utf8'), 'distribution-template')
    await assert.rejects(() => streamToBuffer(chunks(), 0), error => error.code === 'OBJECT_TOO_LARGE')
})
