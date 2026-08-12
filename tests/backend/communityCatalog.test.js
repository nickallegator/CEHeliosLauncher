'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const {
    CommunityCatalogRegistry,
    createCommunityCatalog,
    decodeCursor,
    encodeCursor,
    normalizeSchematicRow
} = require('../../backend/src/services/communityCatalog')

const schematicRow = Object.freeze({
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

test('Community schematic entries normalize into the shared content model', () => {
    const entry = normalizeSchematicRow(schematicRow)
    assert.equal(entry.key, `schematics:${schematicRow.id}`)
    assert.equal(entry.type, 'schematics')
    assert.deepEqual(entry.creator, { id: '7', name: 'BuilderNick' })
    assert.equal(entry.stats.likes, 9)
    assert.equal(entry.schematic.revision.number, 2)
})

test('Community cursors are opaque, sort-bound, and reject malformed input', () => {
    const encoded = encodeCursor({
        sort: 'popular',
        likes: 9,
        updatedAt: schematicRow.updated_at,
        type: 'schematics',
        id: schematicRow.id
    })
    assert.equal(decodeCursor(encoded, 'popular').id, schematicRow.id)
    assert.throws(() => decodeCursor(encoded, 'recent'), /cursor is invalid/)
    assert.throws(() => decodeCursor('../not-a-cursor', 'popular'), /cursor is invalid/)
})

test('Community provider registry rejects duplicate and incomplete providers', () => {
    const provider = { id: 'schematics', list: async () => ({ items: [] }), capability: () => ({ id: 'schematics' }) }
    const registry = new CommunityCatalogRegistry([provider])
    assert.throws(() => registry.register(provider), /Duplicate/)
    assert.throws(() => registry.register({ id: 'datapacks' }), /require an id and list function/)
})

test('Community catalog uses deterministic popular ordering and cursor pagination', async () => {
    const calls = []
    const database = {
        async query(sql, params) {
            calls.push({ sql, params })
            return { rows: [schematicRow, { ...schematicRow, id: '33333333-3333-4333-8333-333333333333', likes: 8 }] }
        }
    }
    const catalog = createCommunityCatalog({ database, settings: { enabled: true, writeMode: 'authenticated' } })
    const result = await catalog.list({ category: 'all', sort: 'popular', limit: 1, query: 'work', tags: 'copper' })
    assert.equal(result.items.length, 1)
    assert.ok(result.nextCursor)
    assert.match(calls[0].sql, /coalesce\(s\.likes, 0\) desc, s\.updated_at desc, s\.id asc/)
    assert.equal(calls[0].params.at(-1), 2)
    assert.deepEqual(catalog.capabilities().categories.map(category => category.id), ['schematics'])
})

test('Community catalog validates category and sorting inputs', async () => {
    const catalog = createCommunityCatalog({ database: { query: async () => ({ rows: [] }) }, settings: { enabled: true } })
    await assert.rejects(() => catalog.list({ category: 'resource-packs' }), /Unsupported Community category/)
    await assert.rejects(() => catalog.list({ sort: 'random' }), /Unsupported Community sort/)
})

test('All merges enabled providers using deterministic type-aware ordering', async () => {
    const entry = (type, id) => ({
        key: `${type}:${id}`,
        type,
        id,
        title: id,
        updatedAt: '2026-08-10T00:00:00.000Z',
        stats: { likes: 5 }
    })
    const provider = (id, item) => ({
        id,
        list: async () => [item],
        capability: () => ({ id, readable: true })
    })
    const registry = new CommunityCatalogRegistry([
        provider('schematics', entry('schematics', 'one')),
        provider('datapacks', entry('datapacks', 'one'))
    ])
    const catalog = createCommunityCatalog({ settings: {}, registry })
    const result = await catalog.list({ category: 'all', sort: 'popular', limit: 1 })
    assert.deepEqual(result.items.map(item => item.type), ['datapacks'])
    assert.equal(decodeCursor(result.nextCursor, 'popular').type, 'datapacks')
    assert.deepEqual((await catalog.list({ category: 'datapacks' })).items.map(item => item.type), ['datapacks'])
})
