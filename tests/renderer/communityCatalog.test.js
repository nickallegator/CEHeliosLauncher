'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
    COMMUNITY_CACHE_LIMIT,
    CommunityApiClient,
    createCommunitySessionState,
    deduplicateCommunityEntries,
    normalizeCommunityEntry,
    normalizeCommunityParams
} = require('../../app/assets/js/communitymanager')

function item(id = 'one') {
    return {
        type: 'schematics',
        id,
        title: `Schematic ${id}`,
        creator: { name: 'Builder' },
        stats: { likes: 2 }
    }
}

test('Community entries normalize and deduplicate by stable type:id keys', () => {
    assert.equal(normalizeCommunityEntry(item()).key, 'schematics:one')
    assert.deepEqual(deduplicateCommunityEntries([item(), item(), item('two')]).map(entry => entry.key), [
        'schematics:one',
        'schematics:two'
    ])
    assert.equal(normalizeCommunityEntry({ type: 'unknown' }), null)
})

test('Community cache keys normalize filter order and omit empty values', () => {
    const first = normalizeCommunityParams({ sort: 'popular', query: '', category: 'all' }).toString()
    const second = normalizeCommunityParams({ category: 'all', sort: 'popular' }).toString()
    assert.equal(first, second)
})

test('Community session state restores category, filters, entries, and scroll safely', () => {
    const state = createCommunitySessionState({
        category: 'schematics',
        sort: 'recent',
        query: 'tower',
        filters: { creator: 'Nick', tags: 'stone' },
        scrollTop: 240,
        items: [item(), item()]
    })
    assert.equal(state.category, 'schematics')
    assert.equal(state.sort, 'recent')
    assert.equal(state.scrollTop, 240)
    assert.equal(state.items.length, 1)
})

test('Community client uses ETags and falls back to its bounded catalog cache', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-community-'))
    const cachePath = path.join(directory, 'catalog.json')
    let online = true
    const client = new CommunityApiClient({
        baseUrl: 'https://community.example.test',
        cachePath,
        fetch: async (_url, options) => {
            if(!online) throw new Error('offline')
            assert.equal(options.headers.Accept, 'application/json')
            return new Response(JSON.stringify({ schemaVersion: 1, items: [item(), item()], nextCursor: null }), {
                status: 200,
                headers: { 'content-type': 'application/json', etag: '"catalog-1"' }
            })
        }
    })
    const first = await client.catalog({ category: 'all', sort: 'popular' })
    assert.equal(first.items.length, 1)
    online = false
    const cached = await client.catalog({ sort: 'popular', category: 'all' })
    assert.equal(cached.offline, true)
    assert.equal(cached.cached, true)

    for(let index = 0; index < COMMUNITY_CACHE_LIMIT + 4; index++) {
        client.writeCommunityCache(`key-${index}`, { catalog: { schemaVersion: 1, items: [] } })
    }
    assert.equal(JSON.parse(fs.readFileSync(cachePath, 'utf8')).entries.length, COMMUNITY_CACHE_LIMIT)
})

test('personalized My Uploads results are never persisted for offline reuse', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-community-private-'))
    const cachePath = path.join(directory, 'catalog.json')
    let online = true
    const client = new CommunityApiClient({
        baseUrl: 'https://community.example.test',
        cachePath,
        fetch: async () => {
            if(!online) throw new Error('offline')
            return new Response(JSON.stringify({ schemaVersion: 1, items: [item('private')], nextCursor: null }), {
                status: 200,
                headers: { 'content-type': 'application/json' }
            })
        }
    })
    await client.catalog({ category: 'schematics', mine: 'true' })
    assert.equal(fs.existsSync(cachePath), false)
    online = false
    await assert.rejects(() => client.catalog({ category: 'schematics', mine: 'true' }), /offline/)
})
