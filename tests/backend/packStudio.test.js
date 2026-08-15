'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const {
    componentUpdateDiff,
    listComponents,
    loadSourcesForSelections,
    persistCompositionIndex,
    resolveComposition
} = require('../../backend/src/services/communityPackStudio')

const REVISION = '11111111-1111-4111-8111-111111111111'
const ITEM = '22222222-2222-4222-8222-222222222222'
const COMPONENT = '33333333-3333-4333-8333-333333333333'

test('Pack Studio update diffs expose added, removed, and changed files without mutating pinned revisions', () => {
    const result = componentUpdateDiff({
        contentSha256: 'a'.repeat(64),
        files: [{ path: 'keep.png', sha256: '1'.repeat(64) }, { path: 'remove.png', sha256: '2'.repeat(64) }]
    }, {
        contentSha256: 'b'.repeat(64),
        files: [{ path: 'keep.png', sha256: '3'.repeat(64) }, { path: 'add.png', sha256: '4'.repeat(64) }]
    })
    assert.deepEqual(result, { available: true, contentChanged: true, added: ['add.png'], removed: ['remove.png'], changed: ['keep.png'] })
})

test('Pack Studio persistence normalizes revision files, components, mappings, and disabled-by-default grants', async () => {
    const statements = []
    const client = {
        async query(sql, params) {
            statements.push({ sql, params })
            if(sql.includes('returning id')) return { rows: [{ id: COMPONENT }] }
            return { rows: [] }
        }
    }
    await persistCompositionIndex(client, {
        revisionId: REVISION,
        itemId: ITEM,
        ownerId: 9,
        enabled: false,
        index: {
            files: [{ path: 'assets/cobblepower/test.png', sha256: 'a'.repeat(64), sizeBytes: 4 }],
            components: [{
                key: 'texture:cobblepower:test', kind: 'texture', identifier: 'cobblepower:test', title: 'Test',
                namespace: 'cobblepower', contentSha256: 'b'.repeat(64), metadata: {}, mergeFragments: [],
                filePaths: ['assets/cobblepower/test.png']
            }]
        }
    })
    assert.ok(statements.some(value => value.sql.includes('community_resource_pack_files')))
    const staleRemoval = statements.find(value => value.sql.includes('delete from community_resource_components'))
    assert.deepEqual(staleRemoval.params, [REVISION, ['texture:cobblepower:test']])
    assert.ok(statements.some(value => value.sql.includes('community_resource_components')))
    assert.ok(statements.some(value => value.sql.includes('community_resource_component_files')))
    const grant = statements.find(value => value.sql.includes('community_resource_pack_composition_grants'))
    assert.equal(grant.params[2], false)
})

test('Pack Studio component catalog exposes bounded normalized source metadata', async () => {
    const db = {
        async query(_sql, params) {
            assert.equal(params.at(-1), 2)
            return { rows: [{
                id: COMPONENT,
                component_key: 'block:cobblepower:test', kind: 'block', identifier: 'cobblepower:test', title: 'Test Block',
                namespace: 'cobblepower', content_sha256: 'c'.repeat(64), metadata: {}, revision_id: REVISION,
                item_id: ITEM, source_title: 'Source', source_description: 'Description', tags: ['blocks'], license: 'Community-Use-1.0',
                owner_id: 9, creator_name: 'Builder', revision_number: 1, revision_sha256: 'd'.repeat(64),
                revision_size_bytes: 20, compatibility: { minecraft: '1.21.1' }, component_size_bytes: 4, file_count: 1
            }] }
        }
    }
    const result = await listComponents(db, { kind: 'block', query: 'test', limit: 1 })
    assert.equal(result.items[0].source.creator, 'Builder')
    assert.equal(result.items[0].fileCount, 1)
    assert.equal(result.items[0].source.revisionId, REVISION)
    assert.equal(result.nextCursor, null)
})

test('Pack Studio source resolution rejects unavailable grants and creates conflict-aware plans', async () => {
    let calls = 0
    const db = {
        async query(sql) {
            calls += 1
            if(sql.includes('from community_revisions r')) return { rows: [{
                revision_id: REVISION, sha256: 'e'.repeat(64), size_bytes: 40, object_key: 'private/source.zip', compatibility: {},
                item_id: ITEM, title: 'Source', license: 'Community-Use-1.0', status: 'active', visibility: 'public',
                current_revision_id: REVISION, creator: 'Builder', enabled: true, terms_version: 1
            }] }
            if(sql.includes('metadata @>')) return { rows: [] }
            return { rows: [{
                component_key: 'texture:cobblepower:test', kind: 'texture', identifier: 'cobblepower:test', title: 'Texture',
                namespace: 'cobblepower', content_sha256: 'f'.repeat(64), metadata: {}, merge_fragments: [],
                files: [{ path: 'assets/cobblepower/test.png', sha256: 'f'.repeat(64), sizeBytes: 4 }]
            }] }
        }
    }
    const selections = [{ sourceItemId: ITEM, sourceRevisionId: REVISION, componentKey: 'texture:cobblepower:test' }]
    const sources = await loadSourcesForSelections(db, selections)
    assert.equal(calls, 3)
    const plan = resolveComposition(sources, selections)
    assert.equal(plan.conflicts.length, 0)
    assert.equal(plan.outputFiles[0].sourcePath, 'assets/cobblepower/test.png')
    const denied = { query: async () => ({ rows: [{ enabled: false, status: 'active', visibility: 'public' }] }) }
    await assert.rejects(() => loadSourcesForSelections(denied, selections), error => error.code === 'composition_source_unavailable')
})
