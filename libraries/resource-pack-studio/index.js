'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const AdmZip = require('adm-zip')
const yauzl = require('yauzl')

const SCHEMA_VERSION = 1
const COMPONENT_KINDS = Object.freeze([
    'block', 'pokemon', 'item', 'sound', 'font', 'language', 'ui', 'texture', 'generic'
])
const MAX_ENTRIES = 10_000
const MAX_ENTRY_BYTES = 64 * 1024 * 1024
const MAX_EXPANDED_BYTES = 512 * 1024 * 1024
const SAFE_PATH = /^[a-z0-9_. -]+(?:\/[a-z0-9_. -]+)*$/i
const RESOURCE_LOCATION = /^([a-z0-9_.-]+):([a-z0-9/._-]+)$/i
const ROOT_EXCLUSIONS = new Set(['pack.mcmeta', 'pack.png'])
const POKEMON_OVERRIDE_RESOURCES = Object.freeze(['model', 'texture', 'poser', 'animations', 'layers'])
const POKEMON_GENDERS = new Set(['male', 'female', 'genderless'])
const REGIONAL_SUFFIXES = Object.freeze([
    ['_galarian', 'galarian'], ['_galar', 'galarian'],
    ['_alolan', 'alolan'], ['_alola', 'alolan'],
    ['_hisuian', 'hisuian'], ['_hisui', 'hisuian'],
    ['_paldean', 'paldean'], ['_paldea', 'paldean']
])

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex')
}

function stableJson(value) {
    if(Array.isArray(value)) return value.map(stableJson)
    if(!value || typeof value !== 'object') return value
    return Object.keys(value).sort().reduce((result, key) => {
        result[key] = stableJson(value[key])
        return result
    }, {})
}

function normalizeEntryPath(value) {
    const raw = String(value || '').replaceAll('\\', '/')
    if(!raw || raw.startsWith('/') || /^[a-z]:/i.test(raw) || raw.includes('\0')) throw new Error('Unsafe Resource Pack path.')
    const parts = raw.split('/')
    if(parts.some(part => !part || part === '.' || part === '..')) throw new Error(`Unsafe Resource Pack path: ${raw}`)
    const normalized = parts.join('/')
    if(!SAFE_PATH.test(normalized)) throw new Error(`Unsupported Resource Pack path: ${raw}`)
    return normalized
}

function displayName(value) {
    return String(value || '').split(/[/:]/).at(-1).replace(/[_.-]+/g, ' ').replace(/\b\w/g, match => match.toUpperCase())
}

function resourceReferences(value, output = new Set()) {
    if(Array.isArray(value)) {
        value.forEach(entry => resourceReferences(entry, output))
    } else if(value && typeof value === 'object') {
        Object.values(value).forEach(entry => resourceReferences(entry, output))
    } else if(typeof value === 'string') {
        const match = value.toLowerCase().match(RESOURCE_LOCATION)
        if(match) output.add(`${match[1]}:${match[2]}`)
    }
    return output
}

function referenceCandidates(reference) {
    const match = String(reference).match(RESOURCE_LOCATION)
    if(!match) return []
    const namespace = match[1].toLowerCase()
    const resource = match[2].replace(/\.(json|png|ogg)$/i, '')
    const geometry = resource.replace(/\.geo$/i, '')
    return [
        `assets/${namespace}/${resource}`,
        `assets/${namespace}/${resource}.json`,
        `assets/${namespace}/${resource}.png`,
        `assets/${namespace}/${resource}.ogg`,
        `assets/${namespace}/models/${resource}.json`,
        `assets/${namespace}/textures/${resource}.png`,
        `assets/${namespace}/bedrock/${resource}.json`,
        `assets/${namespace}/bedrock/${geometry}.geo.json`
    ].map(value => value.toLowerCase())
}

function readJson(files, filePath) {
    const file = files.get(filePath.toLowerCase())
    if(!file || file.sizeBytes > 4 * 1024 * 1024) return null
    if(Object.hasOwn(file, 'document')) return file.document
    try { return JSON.parse(file.bytes.toString('utf8')) } catch(_error) { return null }
}

function resolveClosure(files, roots) {
    const selected = new Set()
    const pending = [...roots].map(value => String(value).toLowerCase())
    while(pending.length) {
        const filePath = pending.shift()
        if(selected.has(filePath) || !files.has(filePath)) continue
        selected.add(filePath)
        if(!filePath.endsWith('.json') && !filePath.endsWith('.mcmeta')) continue
        const document = readJson(files, filePath)
        if(!document) continue
        for(const reference of resourceReferences(document)) {
            for(const candidate of referenceCandidates(reference)) {
                if(files.has(candidate) && !selected.has(candidate)) pending.push(candidate)
            }
        }
    }
    for(const filePath of [...selected]) {
        if(filePath.endsWith('.png') && files.has(`${filePath}.mcmeta`)) selected.add(`${filePath}.mcmeta`)
    }
    return [...selected].sort()
}

function componentKey(kind, identifier) {
    return `${kind}:${String(identifier).toLowerCase()}`
}

function normalizePokemonAspects(values = []) {
    return [...new Set((Array.isArray(values) ? values : [])
        .map(value => String(value || '').trim().toLowerCase())
        .filter(Boolean))].sort()
}

function pokemonVariantKey(aspects = []) {
    return normalizePokemonAspects(aspects).join('+') || 'default'
}

function pokemonVariantLabel(aspects = []) {
    const values = normalizePokemonAspects(aspects).filter(value => !POKEMON_GENDERS.has(value))
    if(values.length === 0) return 'Default'
    return values.map(value => displayName(value)).join(' + ')
}

function pokemonPreviewVariants(variations = []) {
    const variants = new Map()
    for(const variation of variations || []) {
        if(!variation || !['model', 'texture', 'poser', 'layers'].some(key => variation[key] != null)) continue
        const aspects = normalizePokemonAspects(variation.aspects)
        const key = pokemonVariantKey(aspects)
        variants.set(key, { key, label: pokemonVariantLabel(aspects), aspects })
    }
    return [...variants.values()].sort((left, right) => {
        const leftShiny = left.aspects.includes('shiny') ? 1 : 0
        const rightShiny = right.aspects.includes('shiny') ? 1 : 0
        return leftShiny - rightShiny || left.aspects.length - right.aspects.length || left.key.localeCompare(right.key)
    })
}

function pokemonVariationProvides(variation = {}) {
    return POKEMON_OVERRIDE_RESOURCES.filter(resource => resource !== 'animations' && variation?.[resource] != null)
}

function mergePokemonForms(forms = []) {
    const merged = new Map()
    for(const input of forms || []) {
        const aspects = normalizePokemonAspects(input?.aspects).filter(value => value !== 'shiny')
        const key = pokemonVariantKey(aspects)
        const previous = merged.get(key) || {
            key,
            label: pokemonVariantLabel(aspects),
            aspects,
            normal: { declared: false, provides: [] },
            shiny: { declared: false, provides: [] }
        }
        for(const lane of ['normal', 'shiny']) {
            const value = input?.[lane]
            if(!value) continue
            previous[lane].declared ||= value.declared === true
            previous[lane].provides = POKEMON_OVERRIDE_RESOURCES.filter(resource =>
                previous[lane].provides.includes(resource) || (value.provides || []).includes(resource))
        }
        previous.defaultShiny = previous.shiny.declared && !previous.normal.declared
        merged.set(key, previous)
    }
    return [...merged.values()].sort((left, right) => left.aspects.length - right.aspects.length || left.key.localeCompare(right.key))
}

function pokemonFormsFromVariations(variations = []) {
    return mergePokemonForms((variations || []).filter(variation => variation && ['model', 'texture', 'poser', 'layers'].some(key => variation[key] != null)).map(variation => {
        const rawAspects = normalizePokemonAspects(variation.aspects)
        const shiny = rawAspects.includes('shiny')
        const aspects = rawAspects.filter(value => value !== 'shiny')
        return {
            key: pokemonVariantKey(aspects),
            label: pokemonVariantLabel(aspects),
            aspects,
            normal: shiny ? null : { declared: true, provides: pokemonVariationProvides(variation) },
            shiny: shiny ? { declared: true, provides: pokemonVariationProvides(variation) } : null
        }
    }))
}

function pokemonFormsFromMetadata(metadata = {}) {
    if(Array.isArray(metadata.pokemonForms) && metadata.pokemonForms.length) return mergePokemonForms(metadata.pokemonForms)
    const forms = new Map()
    for(const variant of metadata.pokemonVariants || []) {
        const rawAspects = normalizePokemonAspects(variant?.aspects)
        const shiny = rawAspects.includes('shiny')
        const aspects = rawAspects.filter(value => value !== 'shiny')
        const key = pokemonVariantKey(aspects)
        const form = forms.get(key) || {
            key, label: pokemonVariantLabel(aspects), aspects,
            normal: { declared: false, provides: [] }, shiny: { declared: false, provides: [] }
        }
        form[shiny ? 'shiny' : 'normal'].declared = true
        form.defaultShiny = form.shiny.declared && !form.normal.declared
        forms.set(key, form)
    }
    return mergePokemonForms([...forms.values()])
}

function inferredPokemonIdentity(value) {
    let name = String(value || '').toLowerCase().replace(/\.(?:animation|geo)?\.json$/i, '').replace(/\.json$/i, '')
    name = name.replace(/^\d+_/, '')
    const aspects = []
    for(const [suffix, aspect] of REGIONAL_SUFFIXES) {
        const index = name.indexOf(`${suffix}_`)
        if(name.endsWith(suffix) || index > 0) {
            const tail = index > 0 ? name.slice(index + suffix.length + 1) : ''
            name = index > 0 ? name.slice(0, index) : name.slice(0, -suffix.length)
            aspects.push(aspect)
            if(tail === 'zen' || tail === 'zen_mode' || tail === 'zen-mode') aspects.push('zen-mode')
            if(tail.includes('shiny')) aspects.push('shiny')
            break
        }
    }
    return /^[a-z0-9_.-]+$/.test(name) && name ? { species: `cobblemon:${name}`, aspects } : null
}

function inferPokemonAsset(filePath) {
    const normalized = String(filePath || '').replaceAll('\\', '/')
    let match = normalized.match(/^assets\/([^/]+)\/bedrock\/pokemon\/(?:models|animations)\/([^/]+)\//i)
    if(!match) match = normalized.match(/^assets\/([^/]+)\/bedrock\/pokemon\/posers\/(?:[^/]+\/)*([^/]+)\.json$/i)
    if(!match) match = normalized.match(/^assets\/([^/]+)\/textures\/pokemon\/([^/]+)\//i)
    if(!match) return null
    const identity = inferredPokemonIdentity(match[2])
    return identity ? { ...identity, namespace: match[1].toLowerCase(), sourcePath: normalized } : null
}

function addPokemonResolverComponent(files, file, add) {
    const match = file.path.match(/^assets\/([^/]+)\/bedrock\/pokemon\/resolvers\/(.+)\.json$/i)
    if(!match) return false
    const document = readJson(files, file.path)
    const rawSpecies = String(document?.species || match[2].split('/').at(-1)).toLowerCase()
    const species = rawSpecies.includes(':') ? rawSpecies : `cobblemon:${rawSpecies}`
    const roots = [file.path]
    const speciesPath = species.split(':').at(-1).split('/').at(-1)
    const resolverNamespace = match[1].toLowerCase()
    const pokemonVariants = pokemonPreviewVariants(document?.variations)
    const pokemonForms = pokemonFormsFromVariations(document?.variations)
    for(const variation of document?.variations || []) {
        const poser = String(variation?.poser || '')
        const poserParts = poser.includes(':') ? poser.split(':', 2) : [resolverNamespace, poser]
        const poserNamespace = poserParts[0] || resolverNamespace
        const poserPath = poserParts[1] || speciesPath
        roots.push(`assets/${poserNamespace}/bedrock/pokemon/posers/${poserPath}.json`)
        const model = String(variation?.model || '')
        let modelPath = ''
        if(model) {
            const modelParts = model.includes(':') ? model.split(':', 2) : [resolverNamespace, model]
            const modelNamespace = modelParts[0] || resolverNamespace
            modelPath = String(modelParts[1] || '').replace(/\.geo(?:\.json)?$/i, '').replace(/\.json$/i, '')
            roots.push(
                `assets/${modelNamespace}/bedrock/pokemon/models/${speciesPath}/${modelPath}.geo.json`,
                `assets/${modelNamespace}/bedrock/pokemon/models/${poserPath}/${modelPath}.geo.json`,
                `assets/${modelNamespace}/bedrock/pokemon/models/${modelPath}/${modelPath}.geo.json`,
                `assets/${modelNamespace}/bedrock/pokemon/models/${modelPath}.geo.json`,
                `assets/${modelNamespace}/bedrock/${modelPath}.geo.json`
            )
        }
        for(const folder of new Set([speciesPath, poserPath, modelPath].filter(Boolean))) {
            const prefix = `assets/${poserNamespace}/bedrock/pokemon/animations/${folder.toLowerCase()}/`
            for(const candidate of files.keys()) if(candidate.startsWith(prefix)) roots.push(candidate)
        }
    }
    add('pokemon', species, roots, { namespace: resolverNamespace, species, pokemonVariants, pokemonForms })
    return true
}

function pokemonOverrideMetadata(filePaths = [], variations = []) {
    const provided = new Set()
    for(const filePath of filePaths) {
        const normalized = String(filePath || '').replaceAll('\\', '/').toLowerCase()
        if(/\/bedrock\/pokemon\/models\//.test(normalized)) provided.add('model')
        if(/\/textures\/pokemon\//.test(normalized)) provided.add('texture')
        if(/\/bedrock\/pokemon\/posers\//.test(normalized)) provided.add('poser')
        if(/\/bedrock\/pokemon\/animations\//.test(normalized)) provided.add('animations')
    }
    for(const variation of variations || []) {
        for(const resource of ['model', 'texture', 'poser', 'layers']) if(variation?.[resource] != null) provided.add(resource)
    }
    const provides = POKEMON_OVERRIDE_RESOURCES.filter(value => provided.has(value))
    return {
        schemaVersion: 1,
        scope: provided.has('model') && provided.has('texture') ? 'full' : 'partial',
        provides
    }
}

function mergeShowcaseCandidates(candidates = []) {
    const merged = new Map()
    for(const candidate of candidates) {
        const aspects = normalizePokemonAspects(candidate?.aspects)
        const key = candidate?.kind === 'block' ? `block:${candidate.id}` : `pokemon:${candidate?.species}:${pokemonVariantKey(aspects)}`
        if(candidate?.kind !== 'pokemon') { if(candidate) merged.set(key, candidate); continue }
        const previous = merged.get(key)
        const provides = new Set([
            ...(previous?.pokemonOverride?.provides || []),
            ...(candidate.pokemonOverride?.provides || [])
        ])
        const resourceNamespaces = [...new Set([
            ...(previous?.resourceNamespaces || [previous?.resourceNamespace]),
            ...(candidate.resourceNamespaces || [candidate.resourceNamespace])
        ].filter(Boolean).map(value => String(value).toLowerCase()))]
        const sourcePaths = [...new Set([
            ...(previous?.sourcePaths || [previous?.sourcePath]),
            ...(candidate.sourcePaths || [candidate.sourcePath])
        ].filter(Boolean))]
        const pokemonOverride = pokemonOverrideMetadata([], [{
            model: provides.has('model') ? true : null,
            texture: provides.has('texture') ? true : null,
            poser: provides.has('poser') ? true : null,
            layers: provides.has('layers') ? true : null
        }])
        if(provides.has('animations')) pokemonOverride.provides = POKEMON_OVERRIDE_RESOURCES.filter(value => provides.has(value))
        if(previous?.pokemonOverride?.shinyOnly === true || candidate.pokemonOverride?.shinyOnly === true) pokemonOverride.shinyOnly = true
        merged.set(key, {
            ...(previous || {}),
            ...candidate,
            resourceNamespace: resourceNamespaces.find(value => value !== 'cobblemon') || resourceNamespaces[0] || 'cobblemon',
            resourceNamespaces,
            sourcePath: sourcePaths[0] || null,
            sourcePaths,
            aspects,
            variantKey: pokemonVariantKey(aspects),
            variantLabel: candidate.variantLabel || pokemonVariantLabel(aspects),
            pokemonOverride
        })
    }
    return [...merged.values()].sort((left, right) => {
        const identity = (left.id || left.species).localeCompare(right.id || right.species)
        return identity || String(left.variantKey || '').localeCompare(String(right.variantKey || ''))
    })
}

function showcaseCandidatesFromComponents(components = []) {
    const candidates = []
    for(const component of components || []) {
        const sourcePaths = [...new Set(component?.filePaths || [])].sort((left, right) => left.localeCompare(right))
        if(component?.kind === 'block') {
            candidates.push({
                kind: 'block', id: component.identifier, state: {},
                sourcePath: sourcePaths[0] || null, sourcePaths
            })
            continue
        }
        if(component?.kind !== 'pokemon') continue
        const forms = pokemonFormsFromMetadata(component.metadata)
        const variants = forms.length ? forms : [{ key: 'default', label: 'Default', aspects: [], normal: { declared: true, provides: [] }, shiny: { declared: false, provides: [] }, defaultShiny: false }]
        for(const variant of variants) {
            const aspects = normalizePokemonAspects(variant.aspects).filter(value => value !== 'shiny')
            const gender = aspects.find(value => POKEMON_GENDERS.has(value)) || 'male'
            const form = aspects.find(value => !POKEMON_GENDERS.has(value) && value !== 'shiny') || ''
            candidates.push({
                kind: 'pokemon', species: component.identifier, form, gender: gender.toUpperCase(), aspects,
                variantKey: variant.key || pokemonVariantKey(aspects),
                variantLabel: variant.label || pokemonVariantLabel(aspects),
                shinyVariant: stableJson(variant.shiny || { declared: false, provides: [] }),
                defaultShiny: variant.defaultShiny === true,
                resourceNamespace: component.namespace,
                resourceNamespaces: [component.namespace].filter(Boolean),
                sourcePath: sourcePaths[0] || null,
                sourcePaths,
                pokemonOverride: component.metadata?.pokemonOverride || null
            })
        }
    }
    return mergeShowcaseCandidates(candidates)
}

function indexResourcePack(source) {
    let stat
    let files
    let expandedBytes
    let archiveSha256
    if(typeof source === 'string') {
        stat = fs.statSync(source)
        if(!stat.isFile()) throw new Error('Resource Pack source is not a file.')
        const archive = new AdmZip(source)
        const entries = archive.getEntries().filter(entry => !entry.isDirectory)
        if(entries.length > MAX_ENTRIES) throw new Error(`Resource Pack exceeds ${MAX_ENTRIES} entries.`)
        files = new Map()
        expandedBytes = 0
        for(const entry of entries) {
            const entryPath = normalizeEntryPath(entry.entryName)
            const bytes = entry.getData()
            if(bytes.length > MAX_ENTRY_BYTES) throw new Error(`${entryPath} exceeds the per-entry size limit.`)
            expandedBytes += bytes.length
            if(expandedBytes > MAX_EXPANDED_BYTES) throw new Error('Resource Pack exceeds the expanded size limit.')
            const key = entryPath.toLowerCase()
            if(files.has(key)) throw new Error(`Resource Pack contains a duplicate path: ${entryPath}`)
            files.set(key, { path: entryPath, sha256: sha256(bytes), sizeBytes: bytes.length, bytes })
        }
        archiveSha256 = sha256(fs.readFileSync(source))
    } else {
        stat = { size: Number(source?.sizeBytes) }
        files = source?.files
        expandedBytes = Number(source?.expandedBytes)
        archiveSha256 = String(source?.sha256 || '')
        if(!(files instanceof Map) || !Number.isSafeInteger(stat.size) || !Number.isSafeInteger(expandedBytes) || !/^[a-f0-9]{64}$/.test(archiveSha256)) {
            throw new Error('Streamed Resource Pack index input is invalid.')
        }
    }

    const components = new Map()
    const claimed = new Set()
    const add = (kind, identifier, roots, metadata = {}, mergeFragments = []) => {
        if(!COMPONENT_KINDS.includes(kind)) throw new Error(`Unsupported Pack Studio component kind: ${kind}`)
        const key = componentKey(kind, identifier)
        const previous = components.get(key)
        const fileKeys = [...new Set([
            ...(previous?.filePaths || []).map(value => String(value).toLowerCase()),
            ...resolveClosure(files, roots)
        ])].sort()
        const fragments = [...new Map(
            [...(previous?.mergeFragments || []), ...mergeFragments]
                .map(fragment => [JSON.stringify(stableJson(fragment)), fragment])
        ).values()]
        if(fileKeys.length === 0 && fragments.length === 0) return
        fileKeys.forEach(value => claimed.add(value))
        const digestInput = {
            key,
            files: fileKeys.map(value => ({ path: files.get(value).path, sha256: files.get(value).sha256 })),
            mergeFragments: fragments
        }
        const resolvedMetadata = { ...(previous?.metadata || {}), ...metadata }
        if(kind === 'pokemon') {
            const variants = [...(previous?.metadata?.pokemonVariants || []), ...(metadata.pokemonVariants || [])]
            resolvedMetadata.pokemonVariants = [...new Map(variants.map(variant => {
                const aspects = normalizePokemonAspects(variant?.aspects)
                const key = pokemonVariantKey(aspects)
                return [key, { key, label: variant?.label || pokemonVariantLabel(aspects), aspects }]
            })).values()].sort((left, right) => {
                const leftShiny = left.aspects.includes('shiny') ? 1 : 0
                const rightShiny = right.aspects.includes('shiny') ? 1 : 0
                return leftShiny - rightShiny || left.aspects.length - right.aspects.length || left.key.localeCompare(right.key)
            })
            resolvedMetadata.pokemonForms = mergePokemonForms([
                ...(previous?.metadata?.pokemonForms || []),
                ...(metadata.pokemonForms || [])
            ])
        }
        if(kind === 'pokemon') {
            const override = pokemonOverrideMetadata(fileKeys)
            const forms = resolvedMetadata.pokemonForms || []
            const declaredNormal = forms.some(form => form.normal?.declared)
            const declaredShiny = forms.some(form => form.shiny?.declared)
            const completeNormal = forms.some(form => form.normal?.provides?.includes('model') && form.normal?.provides?.includes('texture'))
            if(forms.length) {
                override.scope = completeNormal ? 'full' : 'partial'
                if(declaredShiny && !declaredNormal) override.shinyOnly = true
            }
            resolvedMetadata.pokemonOverride = override
        }
        components.set(key, {
            key,
            kind,
            identifier: String(identifier).toLowerCase(),
            title: metadata.title || previous?.title || displayName(identifier),
            namespace: metadata.namespace || previous?.namespace || String(identifier).split(':')[0] || 'minecraft',
            metadata: stableJson(resolvedMetadata),
            filePaths: fileKeys.map(value => files.get(value).path),
            mergeFragments: stableJson(fragments),
            contentSha256: sha256(Buffer.from(JSON.stringify(stableJson(digestInput))))
        })
    }

    // Resolver declarations are the authoritative species/form identity. Claim their
    // complete resource closures before considering resolver-free filename inference,
    // otherwise form-specific poser names become duplicate fake species components.
    for(const file of files.values()) addPokemonResolverComponent(files, file, add)

    const inferredPokemonAssets = new Map()
    for(const file of files.values()) {
        if(claimed.has(file.path.toLowerCase())) continue
        const inferred = inferPokemonAsset(file.path)
        if(!inferred) continue
        const group = inferredPokemonAssets.get(inferred.species) || { roots: [], namespaces: new Set(), variants: [] }
        group.roots.push(file.path)
        group.namespaces.add(inferred.namespace)
        group.variants.push({ aspects: inferred.aspects })
        inferredPokemonAssets.set(inferred.species, group)
    }
    for(const [species, group] of inferredPokemonAssets) {
        const namespace = [...group.namespaces].find(value => value !== 'cobblemon') || [...group.namespaces][0] || 'cobblemon'
        add('pokemon', species, group.roots, {
            namespace,
            species,
            pokemonVariants: group.variants.map(variant => ({
                key: pokemonVariantKey(variant.aspects),
                label: pokemonVariantLabel(variant.aspects),
                aspects: normalizePokemonAspects(variant.aspects)
            }))
        })
    }

    for(const file of files.values()) {
        let match = file.path.match(/^assets\/([^/]+)\/blockstates\/(.+)\.json$/i)
        if(match) add('block', `${match[1]}:${match[2]}`, [file.path], { namespace: match[1].toLowerCase() })

        match = file.path.match(/^assets\/([^/]+)\/models\/item\/(.+)\.json$/i)
        if(match) add('item', `${match[1]}:${match[2]}`, [file.path], { namespace: match[1].toLowerCase() })

        match = file.path.match(/^assets\/([^/]+)\/font\/(.+)\.json$/i)
        if(match) add('font', `${match[1]}:${match[2]}`, [file.path], { namespace: match[1].toLowerCase() })

        match = file.path.match(/^assets\/([^/]+)\/lang\/([^/]+)\.json$/i)
        if(match) {
            const document = readJson(files, file.path)
            if(document && typeof document === 'object' && !Array.isArray(document)) {
                add('language', `${match[1]}:${match[2]}`, [], {
                    namespace: match[1].toLowerCase(), locale: match[2].toLowerCase(), entryCount: Object.keys(document).length
                }, [{ targetPath: file.path, strategy: 'json-object', value: document }])
                claimed.add(file.path.toLowerCase())
            }
        }

        match = file.path.match(/^assets\/([^/]+)\/sounds\.json$/i)
        if(match) {
            const document = readJson(files, file.path)
            if(document && typeof document === 'object' && !Array.isArray(document)) {
                for(const [event, definition] of Object.entries(document)) {
                    const roots = []
                    for(const sound of Array.isArray(definition?.sounds) ? definition.sounds : []) {
                        const name = typeof sound === 'string' ? sound : sound?.name
                        if(!name) continue
                        const resource = String(name).includes(':') ? String(name) : `${match[1]}:${name}`
                        const id = resource.match(RESOURCE_LOCATION)
                        if(id) roots.push(`assets/${id[1]}/sounds/${id[2]}.ogg`)
                    }
                    add('sound', `${match[1]}:${event}`, roots, {
                        namespace: match[1].toLowerCase(), event
                    }, [{ targetPath: file.path, strategy: 'json-object', value: { [event]: definition } }])
                }
                claimed.add(file.path.toLowerCase())
            }
        }
    }

    for(const file of files.values()) {
        const key = file.path.toLowerCase()
        if(claimed.has(key) || ROOT_EXCLUSIONS.has(key) || /(^|\/)licen[cs]e(?:\.|$)/i.test(key) || /(^|\/)credits?(?:\.|$)/i.test(key)) continue
        const ui = file.path.match(/^assets\/([^/]+)\/textures\/(gui|font)\/(.+)\.(png|json)$/i)
        if(ui) add('ui', `${ui[1]}:${ui[2]}/${ui[3]}`, [file.path], { namespace: ui[1].toLowerCase(), section: ui[2].toLowerCase() })
        else if(/\.png(?:\.mcmeta)?$/i.test(file.path)) {
            const match = file.path.match(/^assets\/([^/]+)\/(.+?)(?:\.png|\.png\.mcmeta)$/i)
            if(match) add('texture', `${match[1]}:${match[2]}`, [file.path], { namespace: match[1].toLowerCase() })
        } else {
            const match = file.path.match(/^assets\/([^/]+)\/(.+)$/i)
            if(match) add('generic', `${match[1]}:${match[2]}`, [file.path], { namespace: match[1].toLowerCase(), extension: path.extname(file.path).toLowerCase() })
        }
    }

    const notices = [...files.values()].filter(file => /(^|\/)(licen[cs]e|credits?)(\.|$)/i.test(file.path)).map(file => ({
        path: file.path,
        sha256: file.sha256,
        sizeBytes: file.sizeBytes
    }))
    return {
        schemaVersion: SCHEMA_VERSION,
        sha256: archiveSha256,
        sizeBytes: stat.size,
        expandedBytes,
        files: [...files.values()].map(({ bytes: _bytes, document: _document, ...file }) => file).sort((a, b) => a.path.localeCompare(b.path)),
        components: [...components.values()].sort((a, b) => a.key.localeCompare(b.key)),
        notices
    }
}

function openStreamingZip(filePath) {
    return new Promise((resolve, reject) => yauzl.open(filePath, {
        lazyEntries: true,
        autoClose: false,
        decodeStrings: true,
        validateEntrySizes: true
    }, (error, zip) => error ? reject(error) : resolve(zip)))
}

function hashFile(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256')
        const input = fs.createReadStream(filePath)
        input.on('data', chunk => hash.update(chunk))
        input.on('error', reject)
        input.on('end', () => resolve(hash.digest('hex')))
    })
}

async function indexResourcePackStreaming(filePath) {
    const stat = await fs.promises.stat(filePath)
    if(!stat.isFile()) throw new Error('Resource Pack source is not a file.')
    const files = new Map()
    let expandedBytes = 0
    let entryCount = 0
    const zip = await openStreamingZip(filePath)
    try {
        await new Promise((resolve, reject) => {
            zip.on('error', reject)
            zip.on('end', resolve)
            zip.on('entry', entry => {
                if(entry.fileName.endsWith('/')) { zip.readEntry(); return }
                let entryPath
                try {
                    entryCount += 1
                    if(entryCount > MAX_ENTRIES) throw new Error(`Resource Pack exceeds ${MAX_ENTRIES} entries.`)
                    entryPath = normalizeEntryPath(entry.fileName)
                    if(entry.uncompressedSize > MAX_ENTRY_BYTES) throw new Error(`${entryPath} exceeds the per-entry size limit.`)
                    expandedBytes += Number(entry.uncompressedSize)
                    if(expandedBytes > MAX_EXPANDED_BYTES) throw new Error('Resource Pack exceeds the expanded size limit.')
                    const key = entryPath.toLowerCase()
                    if(files.has(key)) throw new Error(`Resource Pack contains a duplicate path: ${entryPath}`)
                    zip.openReadStream(entry, (error, input) => {
                        if(error) { reject(error); return }
                        const hash = crypto.createHash('sha256')
                        const retainDocument = /\.(?:json|mcmeta)$/i.test(entryPath) && entry.uncompressedSize <= 4 * 1024 * 1024
                        const chunks = []
                        let sizeBytes = 0
                        input.on('data', chunk => {
                            sizeBytes += chunk.length
                            hash.update(chunk)
                            if(retainDocument) chunks.push(chunk)
                        })
                        input.on('error', reject)
                        input.on('end', () => {
                            let document = null
                            if(retainDocument) {
                                try { document = JSON.parse(Buffer.concat(chunks, sizeBytes).toString('utf8')) } catch(_error) { document = null }
                            }
                            files.set(key, { path: entryPath, sha256: hash.digest('hex'), sizeBytes, document })
                            zip.readEntry()
                        })
                    })
                } catch(error) { reject(error) }
            })
            zip.readEntry()
        })
    } finally { zip.close() }
    return indexResourcePack({
        sizeBytes: stat.size,
        expandedBytes,
        sha256: await hashFile(filePath),
        files
    })
}

function selectionRef(selection) {
    return `${selection.sourceRevisionId}:${selection.componentKey}`
}

function resolveComposition(sources, selections, resolutions = {}) {
    const sourceMap = new Map(sources.map(source => [String(source.revisionId), source]))
    const chosen = []
    for(const selection of selections) {
        const source = sourceMap.get(String(selection.sourceRevisionId))
        const component = source?.components?.find(value => value.key === selection.componentKey)
        if(!source || !component) throw new Error(`Pack Studio component is unavailable: ${selection.componentKey}`)
        chosen.push({ source, component, ref: selectionRef(selection) })
    }
    const files = new Map()
    const merged = new Map()
    const conflicts = []
    for(const value of chosen) {
        const fileMap = new Map(value.source.files.map(file => [file.path.toLowerCase(), file]))
        for(const filePath of value.component.filePaths) {
            const file = fileMap.get(filePath.toLowerCase())
            if(!file) throw new Error(`Indexed Resource Pack file is missing: ${filePath}`)
            const key = file.path.toLowerCase()
            const candidates = files.get(key) || []
            if(!candidates.some(candidate => candidate.file.sha256 === file.sha256)) candidates.push({ ...value, file })
            files.set(key, candidates)
        }
        for(const fragment of value.component.mergeFragments || []) {
            const target = fragment.targetPath.toLowerCase()
            const candidates = merged.get(target) || []
            candidates.push({ ...value, fragment })
            merged.set(target, candidates)
        }
    }

    const outputFiles = []
    for(const [targetPath, candidates] of files) {
        if(candidates.length === 1) {
            const candidate = candidates[0]
            outputFiles.push({ targetPath: candidate.file.path, sourceRevisionId: candidate.source.revisionId, sourcePath: candidate.file.path, sha256: candidate.file.sha256 })
            continue
        }
        const conflictKey = `path:${targetPath}`
        const winner = candidates.find(candidate => candidate.ref === resolutions[conflictKey])
        if(!winner) conflicts.push({ key: conflictKey, targetPath, candidates: candidates.map(candidate => ({ ref: candidate.ref, title: candidate.component.title, creator: candidate.source.creator, sha256: candidate.file.sha256 })) })
        else outputFiles.push({ targetPath: winner.file.path, sourceRevisionId: winner.source.revisionId, sourcePath: winner.file.path, sha256: winner.file.sha256 })
    }
    const selectedSources = new Map(chosen.map(value => [String(value.source.revisionId), value.source]))
    for(const source of selectedSources.values()) {
        for(const notice of source.notices || []) {
            const targetPath = `ag-licenses/${source.itemId}/${source.revisionId}/notices/${notice.path}`
            outputFiles.push({ targetPath, sourceRevisionId: source.revisionId, sourcePath: notice.path, sha256: notice.sha256 })
        }
    }

    const synthesized = []
    for(const [targetPath, candidates] of merged) {
        const result = {}
        const values = new Map()
        for(const candidate of candidates) {
            for(const [key, value] of Object.entries(candidate.fragment.value || {})) {
                const digest = sha256(Buffer.from(JSON.stringify(stableJson(value))))
                const entries = values.get(key) || []
                if(!entries.some(entry => entry.digest === digest)) entries.push({ ...candidate, digest, value })
                values.set(key, entries)
            }
        }
        for(const [key, entries] of values) {
            if(entries.length === 1) { result[key] = entries[0].value; continue }
            const conflictKey = `json:${targetPath}:${key}`
            const winner = entries.find(entry => entry.ref === resolutions[conflictKey])
            if(winner) result[key] = winner.value
            else conflicts.push({
                key: conflictKey,
                targetPath,
                jsonKey: key,
                candidates: entries.map(entry => ({ ref: entry.ref, title: entry.component.title, creator: entry.source.creator }))
            })
        }
        synthesized.push({ targetPath, value: stableJson(result) })
    }
    outputFiles.sort((a, b) => a.targetPath.localeCompare(b.targetPath))
    synthesized.sort((a, b) => a.targetPath.localeCompare(b.targetPath))
    conflicts.sort((a, b) => a.key.localeCompare(b.key))
    return { schemaVersion: SCHEMA_VERSION, components: chosen.map(value => ({ ref: value.ref, key: value.component.key })), outputFiles, synthesized, conflicts }
}

module.exports = {
    COMPONENT_KINDS,
    MAX_ENTRIES,
    MAX_ENTRY_BYTES,
    MAX_EXPANDED_BYTES,
    SCHEMA_VERSION,
    componentKey,
    indexResourcePack,
    indexResourcePackStreaming,
    normalizeEntryPath,
    mergeShowcaseCandidates,
    inferPokemonAsset,
    normalizePokemonAspects,
    pokemonPreviewVariants,
    pokemonVariantKey,
    pokemonVariantLabel,
    pokemonOverrideMetadata,
    pokemonFormsFromMetadata,
    pokemonFormsFromVariations,
    mergePokemonForms,
    showcaseCandidatesFromComponents,
    resolveComposition,
    sha256,
    stableJson
}
