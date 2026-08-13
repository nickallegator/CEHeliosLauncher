'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const {
    createCommunityCatalog,
    decodeCursor,
    encodeCursor,
    normalizeSchematicRow
} = require('../../backend/src/services/communityCatalog')

const row = Object.freeze({
    id: '11111111-1111-4111-8111-111111111111',
    owner_id: 7,
    name: 'Copper Workshop',
    creator: 'Owner',
    creator_display_name: 'BuilderNick',
    description: 'A compact workshop.',
    tags: ['workshop', 'copper'],
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-10T00:00:00.000Z',
    downloads: 12,
    likes: 9,
    views: 30,
    release_version: '1.0.2-test.1',
    revision_id: '22222222-2222-4222-8222-222222222222',
    revision_number: 2,
    sha256: 'a'.repeat(64),
    revision_size_bytes: 1024,
    block_count: 200,
    format_id: 'cobblepower_schematic',
    format_version: 2
})

test('schematics normalize into the unified Community card contract', () => {
    const entry = normalizeSchematicRow(row)
    assert.equal(entry.key, `schematics:${row.id}`)
    assert.equal(entry.creator.name, 'BuilderNick')
    assert.equal(entry.revision.number, 2)
    assert.equal(entry.typeData.blockCount, 200)
})

test('catalog capabilities expose only the deployed schematic provider', () => {
    const catalog = createCommunityCatalog({ database: { query: async () => ({ rows: [] }) }, settings: { enabled: true, writeMode: 'authenticated' } })
    assert.deepEqual(catalog.capabilities().categories.map(value => value.id), ['schematics'])
    assert.equal(catalog.capabilities().categories[0].writable, true)
})

test('popular catalog pagination is deterministic and cursor-bound', async () => {
    const calls = []
    const catalog = createCommunityCatalog({
        database: { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [row, { ...row, id: '33333333-3333-4333-8333-333333333333', likes: 8 }] } } },
        settings: { enabled: true, writeMode: 'admin' }
    })
    const result = await catalog.list({ category: 'all', sort: 'popular', limit: 1 })
    assert.equal(result.items.length, 1)
    assert.ok(result.nextCursor)
    assert.match(calls[0].sql, /coalesce\(s\.likes, 0\) desc, s\.updated_at desc, s\.id asc/)
    assert.equal(decodeCursor(result.nextCursor, 'popular').id, row.id)
    assert.throws(() => decodeCursor(result.nextCursor, 'recent'), /cursor is invalid/)
})

test('catalog rejects unsupported categories and malformed cursors', async () => {
    const catalog = createCommunityCatalog({ database: { query: async () => ({ rows: [] }) }, settings: { enabled: true } })
    await assert.rejects(() => catalog.list({ category: 'resource-packs' }), /Unsupported Community category/)
    const cursor = encodeCursor({ sort: 'popular', likes: 1, updatedAt: row.updated_at, type: 'automation', id: row.id })
    await assert.rejects(() => catalog.list({ cursor }), /cursor is invalid/)
})
