'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { normalizeGenericCatalogEntry } = require('../../app/assets/js/scripts/community-modules')

const root = path.resolve(__dirname, '../..')

test('Modrinth Community entries retain additive source and availability metadata', () => {
    const entry = normalizeGenericCatalogEntry({
        type: 'resource-packs', id: 'item', title: 'Pack', creator: { name: 'Creator' },
        source: { provider: 'modrinth', projectId: 'project', versionId: 'version', projectUrl: 'https://modrinth.com/resourcepack/pack' },
        availability: { available: true, lastVerifiedAt: '2026-08-15T00:00:00Z' }
    }, 'resource-packs')
    assert.equal(entry.source.provider, 'modrinth')
    assert.equal(entry.source.versionId, 'version')
    assert.equal(entry.availability.available, true)
})

test('launcher exposes account management and reviewed Modrinth import surfaces', () => {
    const settings = fs.readFileSync(path.join(root, 'app/settings.ejs'), 'utf8')
    const community = fs.readFileSync(path.join(root, 'app/partials/landing/community.ejs'), 'utf8')
    const modal = fs.readFileSync(path.join(root, 'app/partials/landing/community/modals/modrinth-import.ejs'), 'utf8')
    const client = fs.readFileSync(path.join(root, 'app/assets/js/communitymanager.js'), 'utf8')
    assert.match(settings, /settingsModrinthConnect/)
    assert.match(settings, /settingsModrinthDisconnect/)
    assert.match(community, /communityModrinthImportOpen/)
    assert.match(modal, /communityModrinthEmpty/)
    assert.match(modal, /modrinthNoEligibleReviewTip/)
    assert.match(modal, /communityModrinthUnlistedConsent/)
    assert.match(modal, /communityModrinthRights/)
    assert.match(modal, /communityModrinthComposition/)
    assert.match(client, /prepareModrinthCandidate/)
    assert.match(client, /publishModrinthCandidate/)
})

test('Modrinth importer uses the shared accessible modal lifecycle', () => {
    const controller = fs.readFileSync(path.join(root, 'app/assets/js/scripts/landing/schematics/modrinth.js'), 'utf8')
    assert.match(controller, /openModal\(modal, panel/)
    assert.match(controller, /closeModal\(modal\)/)
    assert.match(controller, /setModrinthImportAvailability/)
    assert.match(controller, /modrinthNoEligibleStatus/)
    assert.match(controller, /refreshModrinthVisibilityConsent/)
    assert.match(controller, /unlistedAcknowledged/)
})

test('Modrinth source presentation labels unlisted projects without changing catalog compatibility', () => {
    const controller = fs.readFileSync(path.join(root, 'app/assets/js/scripts/landing/schematics/community-content.js'), 'utf8')
    const client = fs.readFileSync(path.join(root, 'app/assets/js/communitymanager.js'), 'utf8')
    assert.match(controller, /value\.source\.unlisted/)
    assert.match(client, /unlistedAcknowledged/)
})
