'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const AdmZip = require('adm-zip')

const { indexResourcePack, indexResourcePackStreaming, resolveComposition } = require('../../libraries/resource-pack-studio')
const { buildPack, zipEntryIsDirectory } = require('../../libraries/resource-pack-studio/builder')
const { PackStudioProjectStore, projectRecipeHash } = require('../../app/assets/js/packstudioprojects')
const { PackStudioInstallManager } = require('../../app/assets/js/packstudioinstallmanager')
const {
    componentResourcePath,
    componentSubject,
    componentSubjects,
    languageEntries,
    selectComponentPreview,
    selectPreviewFile
} = require('../../app/assets/js/packstudiocomponentpreview')
const { readOptions } = require('../../app/assets/js/communityinstallmanager')
const { discoverResourcePackShowcase } = require('../../app/assets/js/communityresourcepackshowcase')

function createPack(filePath, textureByte, suffix = '') {
    const zip = new AdmZip()
    // Real Resource Packs commonly retain explicit directory records.
    zip.addFile('assets/', Buffer.alloc(0))
    zip.addFile('assets/cobblepower/', Buffer.alloc(0))
    zip.addFile('assets/cobblemon/', Buffer.alloc(0))
    zip.addFile('pack.mcmeta', Buffer.from(JSON.stringify({ pack: { pack_format: 34, description: 'Pack Studio test' } })))
    zip.addFile('assets/cobblepower/blockstates/test_block.json', Buffer.from(JSON.stringify({ variants: { '': { model: 'cobblepower:block/test_block' } } })))
    zip.addFile('assets/cobblepower/models/block/test_block.json', Buffer.from(JSON.stringify({ parent: 'minecraft:block/cube_all', textures: { all: 'cobblepower:block/test_block' } })))
    zip.addFile('assets/cobblepower/textures/block/test_block.png', Buffer.from([textureByte, 2, 3, 4]))
    zip.addFile('assets/cobblepower/models/item/test_item.json', Buffer.from(JSON.stringify({ parent: 'cobblepower:block/test_block' })))
    zip.addFile('assets/cobblemon/bedrock/pokemon/resolvers/testmon.json', Buffer.from(JSON.stringify({ species: 'cobblemon:testmon', variations: [{ model: 'cobblemon:testmon.geo', poser: 'cobblemon:testmon', texture: 'cobblemon:textures/pokemon/testmon.png' }] })))
    zip.addFile('assets/cobblemon/bedrock/pokemon/models/testmon/testmon.geo.json', Buffer.from(JSON.stringify({ format_version: '1.12.0', 'minecraft:geometry': [] })))
    zip.addFile('assets/cobblemon/bedrock/pokemon/posers/testmon.json', Buffer.from(JSON.stringify({ poses: {} })))
    zip.addFile('assets/cobblemon/bedrock/pokemon/animations/testmon/testmon.animation.json', Buffer.from(JSON.stringify({ animations: {} })))
    zip.addFile('assets/cobblemon/textures/pokemon/testmon.png', Buffer.from([1, textureByte, 3]))
    zip.addFile('assets/cobblepower/sounds.json', Buffer.from(JSON.stringify({ [`machine${suffix}`]: { sounds: ['cobblepower:machine'] } })))
    zip.addFile('assets/cobblepower/sounds/machine.ogg', Buffer.from('OggS-test'))
    zip.addFile('assets/cobblepower/lang/en_us.json', Buffer.from(JSON.stringify({ [`block.cobblepower.test${suffix}`]: `Test ${suffix}` })))
    zip.addFile('assets/cobblepower/font/workshop.json', Buffer.from(JSON.stringify({ providers: [] })))
    zip.addFile('assets/cobblepower/textures/gui/workshop.png', Buffer.from([9, textureByte]))
    zip.writeZip(filePath)
}

test('Pack Studio treats standard ZIP directory markers as non-resource entries', () => {
    assert.equal(zipEntryIsDirectory({ fileName: 'assets/' }), true)
    assert.equal(zipEntryIsDirectory({ fileName: 'assets/cobblemon/', externalFileAttributes: 0x10 }), true)
    assert.equal(zipEntryIsDirectory({ fileName: 'assets/cobblemon/model.geo.json' }), false)
})

function source(index, revisionId, itemId, title) {
    return {
        revisionId, itemId, title, creator: 'Creator', license: 'Community-Use-1.0',
        sha256: index.sha256, sizeBytes: index.sizeBytes, files: index.files, components: index.components
    }
}

test('Pack Studio dispatches exact components to stable type-specific previews', () => {
    const component = {
        key: 'language:cobblepower:en_us', kind: 'language', identifier: 'cobblepower:en_us',
        filePaths: ['assets/cobblepower/lang/en_us.json', 'assets/cobblepower/textures/gui/preview.png'],
        mergeFragments: [{ value: { 'item.cobblepower.gear': 'Power Gear', 'block.cobblepower.station': 'Operations Station' } }]
    }
    assert.equal(selectComponentPreview({ kind: 'block' }), 'model')
    assert.equal(selectComponentPreview({ kind: 'pokemon' }), 'model')
    assert.equal(selectComponentPreview({ kind: 'item' }), 'item')
    assert.equal(selectComponentPreview({ kind: 'sound' }), 'sound')
    assert.equal(selectComponentPreview(component), 'language')
    assert.equal(selectPreviewFile(component, value => value.endsWith('.png')), 'assets/cobblepower/textures/gui/preview.png')
    assert.deepEqual(languageEntries(component), [
        ['block.cobblepower.station', 'Operations Station'],
        ['item.cobblepower.gear', 'Power Gear']
    ])
    assert.deepEqual(componentSubject({ kind: 'block', identifier: 'cobblepower:copper_machine' }), {
        kind: 'block', id: 'cobblepower:copper_machine', state: {}
    })
    assert.deepEqual(componentSubject({ kind: 'pokemon', identifier: 'cobblemon:barbaracle', namespace: 'cobblemon_reanimodel' }), {
        kind: 'pokemon', species: 'cobblemon:barbaracle', form: '', gender: 'MALE', aspects: [],
        variantKey: 'default', variantLabel: 'Default', resourceNamespace: 'cobblemon_reanimodel',
        resourceNamespaces: ['cobblemon_reanimodel'], pokemonOverride: null,
        shinyVariant: { declared: false, provides: [] }, defaultShiny: false
    })
    assert.equal(componentResourcePath(component), 'assets/cobblepower/lang/en_us.json')
    assert.equal(componentResourcePath({ kind: 'texture', identifier: 'cobblepower:textures/block/copper' }), 'assets/cobblepower/textures/block/copper.png')
})

test('Pack Studio recognizes resolver forms and resolver-free partial Pokemon overrides', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-pack-pokemon-forms-'))
    try {
        const filePath = path.join(root, 'forms.zip')
        const zip = new AdmZip()
        zip.addFile('pack.mcmeta', Buffer.from(JSON.stringify({ pack: { pack_format: 34, description: 'Forms' } })))
        zip.addFile('assets/example_models/bedrock/pokemon/resolvers/2_darumaka_galar.json', Buffer.from(JSON.stringify({
            species: 'cobblemon:darumaka', variations: [
                { aspects: ['galarian'], model: 'example_models:darumaka_galar.geo', texture: 'example_models:textures/pokemon/darumaka_galar/darumaka_galar.png' },
                { aspects: ['galarian', 'shiny'], texture: 'example_models:textures/pokemon/darumaka_galar/darumaka_galar_shiny.png' }
            ]
        })))
        zip.addFile('assets/example_models/bedrock/pokemon/models/darumaka_galar/darumaka_galar.geo.json', Buffer.from('{}'))
        zip.addFile('assets/example_models/textures/pokemon/darumaka_galar/darumaka_galar.png', Buffer.from([1]))
        zip.addFile('assets/example_models/textures/pokemon/darumaka_galar/darumaka_galar_shiny.png', Buffer.from([2]))
        zip.addFile('assets/example_models/bedrock/pokemon/resolvers/3_dialga_origin.json', Buffer.from(JSON.stringify({
            species: 'cobblemon:dialga', variations: [{
                aspects: ['origin-forme'], poser: 'example_models:dialga_origin'
            }]
        })))
        zip.addFile('assets/example_models/bedrock/pokemon/posers/dialga_origin.json', Buffer.from('{}'))
        zip.addFile('assets/example_models/bedrock/pokemon/resolvers/4_eevee_shiny.json', Buffer.from(JSON.stringify({
            species: 'cobblemon:eevee', variations: [{
                aspects: ['shiny'], texture: 'example_models:textures/pokemon/eevee/eevee_shiny.png'
            }]
        })))
        zip.addFile('assets/example_models/textures/pokemon/eevee/eevee_shiny.png', Buffer.from([3]))
        zip.addFile('assets/example_models/bedrock/pokemon/posers/gliscor.json', Buffer.from('{}'))
        zip.addFile('assets/example_models/bedrock/pokemon/animations/gliscor/gliscor.animation.json', Buffer.from('{}'))
        zip.addFile('assets/cobblemon/bedrock/pokemon/animations/unown/unown.animation.json', Buffer.from('{}'))
        zip.addFile('assets/cobblemon/bedrock/pokemon/models/boltund/boltund.geo.json', Buffer.from('{}'))
        zip.writeZip(filePath)

        const indexed = indexResourcePack(filePath)
        const darumaka = indexed.components.find(value => value.key === 'pokemon:cobblemon:darumaka')
        assert.deepEqual(darumaka.metadata.pokemonVariants.map(value => value.key), ['galarian', 'galarian+shiny'])
        assert.deepEqual(darumaka.metadata.pokemonForms.map(value => value.key), ['galarian'])
        assert.deepEqual(componentSubjects(darumaka).map(value => value.aspects), [['galarian']])
        assert.equal(componentSubjects(darumaka)[0].shinyVariant.declared, true)
        assert.equal(darumaka.metadata.pokemonOverride.scope, 'full')
        const dialga = indexed.components.find(value => value.key === 'pokemon:cobblemon:dialga')
        assert.ok(dialga)
        assert.deepEqual(dialga.metadata.pokemonVariants.map(value => value.key), ['origin-forme'])
        assert.ok(dialga.filePaths.includes('assets/example_models/bedrock/pokemon/posers/dialga_origin.json'))
        assert.equal(indexed.components.some(value => value.key === 'pokemon:cobblemon:dialga_origin'), false)
        const eevee = indexed.components.find(value => value.key === 'pokemon:cobblemon:eevee')
        assert.deepEqual(eevee.metadata.pokemonOverride, {
            schemaVersion: 1, scope: 'partial', provides: ['texture'], shinyOnly: true
        })
        assert.equal(eevee.metadata.pokemonForms[0].defaultShiny, true)
        assert.equal(componentSubjects(eevee)[0].defaultShiny, true)
        for(const [species, provides] of [
            ['gliscor', ['poser', 'animations']], ['unown', ['animations']], ['boltund', ['model']]
        ]) {
            const component = indexed.components.find(value => value.key === `pokemon:cobblemon:${species}`)
            assert.ok(component, species)
            assert.equal(component.metadata.pokemonOverride.scope, 'partial')
            assert.deepEqual(component.metadata.pokemonOverride.provides, provides)
        }
        const candidates = discoverResourcePackShowcase(filePath)
        assert.ok(candidates.some(value => value.species === 'cobblemon:darumaka' && value.aspects.includes('galarian')))
        assert.ok(candidates.some(value => value.species === 'cobblemon:dialga' && value.aspects.includes('origin-forme')))
        assert.equal(candidates.some(value => value.species === 'cobblemon:dialga_origin'), false)
        const eeveeCandidate = candidates.find(value => value.species === 'cobblemon:eevee')
        assert.equal(eeveeCandidate.defaultShiny, true)
        assert.equal(eeveeCandidate.shinyVariant.declared, true)
        for(const species of ['gliscor', 'unown', 'boltund']) assert.ok(candidates.some(value => value.species === `cobblemon:${species}`), species)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('Pack Studio indexes all safe logical component kinds with stable streaming closures', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-pack-index-'))
    try {
        const filePath = path.join(root, 'source.zip'); createPack(filePath, 7)
        const first = indexResourcePack(filePath); const second = indexResourcePack(filePath)
        assert.deepEqual(first, second)
        assert.deepEqual(await indexResourcePackStreaming(filePath), first)
        const kinds = new Set(first.components.map(component => component.kind))
        for(const kind of ['block','pokemon','item','sound','font','language','ui']) assert.equal(kinds.has(kind), true, kind)
        const block = first.components.find(component => component.key === 'block:cobblepower:test_block')
        assert.ok(block.filePaths.includes('assets/cobblepower/blockstates/test_block.json'))
        assert.ok(block.filePaths.includes('assets/cobblepower/textures/block/test_block.png'))
        assert.equal(first.components.find(component => component.kind === 'sound').mergeFragments[0].strategy, 'json-object')
        const pokemon = first.components.find(component => component.key === 'pokemon:cobblemon:testmon')
        assert.deepEqual(pokemon.metadata.pokemonOverride, {
            schemaVersion: 1, scope: 'full', provides: ['model', 'texture', 'poser', 'animations']
        })
        assert.ok(pokemon.filePaths.includes('assets/cobblemon/bedrock/pokemon/models/testmon/testmon.geo.json'))
        assert.ok(pokemon.filePaths.includes('assets/cobblemon/bedrock/pokemon/posers/testmon.json'))
        assert.ok(pokemon.filePaths.includes('assets/cobblemon/bedrock/pokemon/animations/testmon/testmon.animation.json'))
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('Pack Studio merges custom Pokemon resolver overlays into one dependency-complete component', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-pack-pokemon-'))
    try {
        const filePath = path.join(root, 'custom-models.zip')
        const zip = new AdmZip()
        zip.addFile('pack.mcmeta', Buffer.from(JSON.stringify({ pack: { pack_format: 34, description: 'Custom models' } })))
        zip.addFile('assets/cobblemon_reanimodel/bedrock/pokemon/resolvers/0_barbaracle_base.json', Buffer.from(JSON.stringify({
            species: 'cobblemon:barbaracle', variations: [{
                model: 'cobblemon_reanimodel:barbaracle.geo', poser: 'cobblemon_reanimodel:barbaracle',
                texture: 'cobblemon_reanimodel:textures/pokemon/barbaracle/barbaracle.png'
            }]
        })))
        zip.addFile('assets/cobblemon_reanimodel/bedrock/pokemon/resolvers/1_barbaracle_shiny.json', Buffer.from(JSON.stringify({
            species: 'cobblemon:barbaracle', variations: [{ aspects: ['shiny'], texture: 'cobblemon_reanimodel:textures/pokemon/barbaracle/barbaracle_shiny.png' }]
        })))
        zip.addFile('assets/cobblemon_reanimodel/bedrock/pokemon/models/barbaracle/barbaracle.geo.json', Buffer.from(JSON.stringify({ format_version: '1.12.0', 'minecraft:geometry': [] })))
        zip.addFile('assets/cobblemon_reanimodel/bedrock/pokemon/posers/barbaracle.json', Buffer.from(JSON.stringify({ poses: {} })))
        zip.addFile('assets/cobblemon_reanimodel/bedrock/pokemon/animations/barbaracle/barbaracle.animation.json', Buffer.from(JSON.stringify({ animations: {} })))
        zip.addFile('assets/cobblemon_reanimodel/textures/pokemon/barbaracle/barbaracle.png', Buffer.from([1, 2, 3]))
        zip.addFile('assets/cobblemon_reanimodel/textures/pokemon/barbaracle/barbaracle_shiny.png', Buffer.from([4, 5, 6]))
        zip.writeZip(filePath)
        const component = indexResourcePack(filePath).components.find(value => value.key === 'pokemon:cobblemon:barbaracle')
        assert.equal(component.namespace, 'cobblemon_reanimodel')
        for(const required of [
            'assets/cobblemon_reanimodel/bedrock/pokemon/resolvers/0_barbaracle_base.json',
            'assets/cobblemon_reanimodel/bedrock/pokemon/resolvers/1_barbaracle_shiny.json',
            'assets/cobblemon_reanimodel/bedrock/pokemon/models/barbaracle/barbaracle.geo.json',
            'assets/cobblemon_reanimodel/bedrock/pokemon/posers/barbaracle.json',
            'assets/cobblemon_reanimodel/bedrock/pokemon/animations/barbaracle/barbaracle.animation.json'
        ]) assert.ok(component.filePaths.includes(required), required)
        assert.equal(component.metadata.pokemonOverride.scope, 'full')
        const candidate = discoverResourcePackShowcase(filePath).find(value => value.species === 'cobblemon:barbaracle')
        assert.equal(candidate.resourceNamespace, 'cobblemon_reanimodel')
        assert.equal(candidate.pokemonOverride.scope, 'full')
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('Pack Studio composition blocks different files until an explicit winner is selected', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-pack-conflict-'))
    try {
        const leftPath = path.join(root, 'left.zip'); const rightPath = path.join(root, 'right.zip')
        createPack(leftPath, 4); createPack(rightPath, 8, '-other')
        const left = source(indexResourcePack(leftPath), '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Left')
        const right = source(indexResourcePack(rightPath), '22222222-2222-4222-8222-222222222222', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Right')
        const selections = [left, right].map(value => ({ sourceItemId: value.itemId, sourceRevisionId: value.revisionId, componentKey: 'block:cobblepower:test_block' }))
        const unresolved = resolveComposition([left, right], selections)
        assert.ok(unresolved.conflicts.some(conflict => conflict.targetPath === 'assets/cobblepower/textures/block/test_block.png'))
        const conflict = unresolved.conflicts.find(value => value.targetPath.endsWith('test_block.png'))
        const resolved = resolveComposition([left, right], selections, { [conflict.key]: `${right.revisionId}:block:cobblepower:test_block` })
        assert.equal(resolved.conflicts.some(value => value.key === conflict.key), false)
        assert.equal(resolved.outputFiles.find(value => value.targetPath.endsWith('test_block.png')).sourceRevisionId, right.revisionId)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('Pack Studio builds deterministic attributed Resource Pack ZIPs', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-pack-build-'))
    try {
        const sourcePath = path.join(root, 'source.zip'); createPack(sourcePath, 5)
        const indexed = source(indexResourcePack(sourcePath), '33333333-3333-4333-8333-333333333333', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'Workshop Source')
        const project = {
            schemaVersion: 1, id: crypto.randomUUID(), name: 'My Workshop', conflictResolutions: {},
            selections: [{ sourceItemId: indexed.itemId, sourceRevisionId: indexed.revisionId, componentKey: 'block:cobblepower:test_block' }]
        }
        const plan = resolveComposition([indexed], project.selections)
        const resolution = { schemaVersion: 1, sources: [{ ...indexed, downloadUrl: 'redacted' }], plan }
        const first = await buildPack({ project, resolution, sourceFiles: { [indexed.revisionId]: sourcePath }, outputPath: path.join(root, 'first.zip') })
        const second = await buildPack({ project, resolution, sourceFiles: { [indexed.revisionId]: sourcePath }, outputPath: path.join(root, 'second.zip') })
        assert.equal(first.sha256, second.sha256)
        const output = new AdmZip(first.outputPath)
        assert.ok(output.getEntry('pack.mcmeta'))
        assert.ok(output.getEntry('CREDITS.md').getData().toString('utf8').includes('Workshop Source'))
        assert.ok(output.getEntry(`ag-licenses/${indexed.itemId}/${indexed.revisionId}/Community-Use-1.0.txt`))
        assert.ok(output.getEntry('ag-pack-studio.json'))
        assert.ok(output.getEntry('assets/cobblepower/textures/block/test_block.png'))
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('Pack Studio project storage is atomic, reusable, and resilient to unrelated corrupt files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-pack-projects-'))
    try {
        const store = new PackStudioProjectStore(root)
        const project = store.create('Reusable Pack')
        project.selections.push({ sourceItemId: crypto.randomUUID(), sourceRevisionId: crypto.randomUUID(), componentKey: 'block:cobblepower:test' })
        store.save(project)
        const copy = store.duplicate(project.id)
        assert.equal(copy.name, 'Reusable Pack Copy')
        assert.equal(copy.selections.length, 1)
        assert.equal(projectRecipeHash(copy), projectRecipeHash(project))
        copy.conflictResolutions['path:example'] = 'winner'
        assert.notEqual(projectRecipeHash(copy), projectRecipeHash(project))
        fs.writeFileSync(path.join(root, 'corrupt.json'), '{')
        assert.equal(store.list().length, 2)
        assert.equal(store.remove(project.id), true)
        assert.equal(store.get(project.id), null)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('Pack Studio installs streaming output at highest priority and protects local modifications', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-pack-install-'))
    try {
        const instanceDirectory = path.join(root, 'instances')
        const profileId = 'Cobble-Power-1.21.1'
        const instance = path.join(instanceDirectory, profileId)
        fs.mkdirSync(instance, { recursive: true })
        fs.writeFileSync(path.join(instance, 'options.txt'), 'resourcePacks:["file/existing.zip"]\n')
        const outputPath = path.join(root, 'output.zip')
        fs.writeFileSync(outputPath, Buffer.from('deterministic-pack-output'))
        const manager = new PackStudioInstallManager({ instanceDirectory, indexPath: path.join(root, 'install-index.json') })
        const project = { id: crypto.randomUUID(), name: 'Installed Studio Pack' }
        const record = manager.install({ profileId, project, build: { outputPath }, confirmModified: () => false })
        assert.equal(readOptions(record.optionsPath).resourcePacks.at(-1), record.packId)
        assert.equal(manager.status(profileId, project.id).state, 'installed')
        manager.setEnabled({ profileId, projectId: project.id, enabled: false })
        assert.equal(manager.status(profileId, project.id).state, 'disabled')
        manager.setEnabled({ profileId, projectId: project.id, enabled: true })
        fs.appendFileSync(record.packPath, 'modified')
        assert.throws(() => manager.remove({ profileId, projectId: project.id, confirmModified: () => false }), /modified outside AG Launcher/)
        assert.equal(manager.remove({ profileId, projectId: project.id, confirmModified: () => true }), true)
        assert.equal(fs.existsSync(record.packPath), false)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
