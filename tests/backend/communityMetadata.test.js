'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const { _test } = require('../../backend/src/routes/community')

test('Community upload metadata remains valid when the single-use session is finalized', () => {
    const initial = _test.cleanMetadata({
        title: '  Portable Operation  ',
        description: 'Tested automation',
        tags: ['automation', 'portable', 'automation'],
        license: 'Community-Use-1.0',
        rightsAttested: true,
        visibility: 'public',
        compatibility: {
            minecraft: '1.21.1',
            loader: 'NeoForge',
            cobblePower: '>=1.0.4-test.1 <1.1.0',
            cobblemon: '>=1.6.0 <1.7.0'
        }
    })
    const finalized = _test.cleanMetadata(initial)
    assert.deepEqual(finalized, initial)
    assert.equal(finalized.rightsAttested, true)
    assert.deepEqual(finalized.tags, ['automation', 'portable'])
})

test('Community upload metadata preserves a bounded Resource Pack showcase', () => {
    const metadata = _test.cleanMetadata({
        title: 'Copper Pack',
        license: 'Community-Use-1.0',
        rightsAttested: true,
        showcase: {
            schemaVersion: 1,
            subjects: [
                { kind: 'block', id: 'cobblepower:copper_machine', state: { facing: 'north' } },
                { kind: 'pokemon', species: 'cobblemon:pikachu', gender: 'MALE' }
            ]
        }
    })
    assert.equal(metadata.showcase.subjects.length, 2)
    assert.equal(metadata.showcase.subjects[1].species, 'cobblemon:pikachu')
})

test('Community upload metadata requires a distribution-rights attestation', () => {
    assert.throws(() => _test.cleanMetadata({
        title: 'Unattested',
        license: 'Community-Use-1.0'
    }), error => error.code === 'rights_attestation_required')
})

test('Community upload metadata rejects compatibility outside the deployed matrix', () => {
    assert.throws(() => _test.cleanMetadata({
        title: 'Future-only content',
        license: 'Community-Use-1.0',
        rightsAttested: true,
        compatibility: {
            minecraft: '1.21.1',
            loader: 'neoforge',
            cobblePower: '>=1.0.0',
            cobblemon: '>=1.0.0'
        }
    }), error => error.code === 'unsupported_compatibility_range')
})
