'use strict'

/* global document, window */

const fs = require('fs')
const { loadWorkspaceLibrary } = require('./workspacelibrary')

const {
    ZipBufferResourceProvider,
    createResourceStack,
    readPngDimensions,
    resolveInheritedModel,
    resolveTexturePath,
    selectTopTexture,
    splitResourceId
} = loadWorkspaceLibrary('minecraft-resources')
const { pokemonFormsFromMetadata } = loadWorkspaceLibrary('resource-pack-studio')
const { ResourcePackCommunityPreview } = require('./communitypreviews/resource-pack')

const PREVIEWABLE_IMAGE = /\.png$/i
const PREVIEWABLE_AUDIO = /\.ogg$/i
const PREVIEWABLE_TEXT = /\.(?:json|mcmeta|txt|md)$/i

function componentSubjects(component) {
    if(component?.kind === 'block') return [{ kind: 'block', id: component.identifier, state: {} }]
    if(component?.kind !== 'pokemon') return []
    const forms = pokemonFormsFromMetadata(component.metadata)
    const variants = forms.length ? forms : [{
        key: 'default', label: 'Default', aspects: [],
        normal: { declared: true, provides: [] }, shiny: { declared: false, provides: [] }, defaultShiny: false
    }]
    return variants.map(variant => {
        const aspects = [...new Set((variant.aspects || []).map(value => String(value).toLowerCase()).filter(value => value !== 'shiny'))].sort()
        const gender = aspects.find(value => ['male', 'female', 'genderless'].includes(value)) || 'male'
        const form = aspects.find(value => !['male', 'female', 'genderless', 'shiny'].includes(value)) || ''
        return {
            kind: 'pokemon', species: component.identifier, form, gender: gender.toUpperCase(), aspects,
            variantKey: variant.key || aspects.join('+') || 'default',
            variantLabel: variant.label || 'Default',
            shinyVariant: variant.shiny || { declared: false, provides: [] },
            defaultShiny: variant.defaultShiny === true || component.metadata?.pokemonOverride?.shinyOnly === true,
            resourceNamespace: component.namespace || component.metadata?.namespace || null,
            resourceNamespaces: [component.namespace || component.metadata?.namespace].filter(Boolean),
            pokemonOverride: component.metadata?.pokemonOverride || null
        }
    })
}

function componentSubject(component) {
    const subjects = componentSubjects(component)
    return subjects[0] || null
}

function selectComponentPreview(component) {
    if(['block', 'pokemon'].includes(component?.kind)) return 'model'
    if(component?.kind === 'item') return 'item'
    if(component?.kind === 'sound') return 'sound'
    if(component?.kind === 'language') return 'language'
    if(component?.kind === 'font') return 'font'
    if(['ui', 'texture'].includes(component?.kind)) return 'image'
    return 'generic'
}

function selectPreviewFile(component, matcher) {
    return [...(component?.filePaths || [])].sort((left, right) => left.localeCompare(right)).find(matcher) || null
}

function languageEntries(component) {
    const values = []
    for(const fragment of component?.mergeFragments || []) {
        for(const [key, value] of Object.entries(fragment?.value || {})) values.push([key, String(value)])
    }
    return values.sort((left, right) => left[0].localeCompare(right[0]))
}

function componentResourcePath(component) {
    const id = splitResourceId(component?.identifier)
    if(!id.namespace || !id.path) return null
    if(component.kind === 'font') return `assets/${id.namespace}/font/${id.path}.json`
    if(component.kind === 'language') return `assets/${id.namespace}/lang/${component.metadata?.locale || id.path}.json`
    if(component.kind === 'ui') return `assets/${id.namespace}/textures/${id.path}.png`
    if(component.kind === 'texture') return `assets/${id.namespace}/${id.path.startsWith('textures/') ? id.path : `textures/${id.path}`}.png`
    if(component.kind === 'generic') return `assets/${id.namespace}/${id.path}`
    return null
}

function soundResourcePath(value, fallbackNamespace) {
    const id = splitResourceId(typeof value === 'string' ? value : value?.name, fallbackNamespace)
    return id.path ? `assets/${id.namespace}/sounds/${id.path}.ogg` : null
}

function makeElement(tag, className, text = null) {
    const element = document.createElement(tag)
    if(className) element.className = className
    if(text != null) element.textContent = text
    return element
}

class PackStudioComponentPreview {
    constructor(options) {
        this.host = options.host
        this.component = options.component
        this.client = options.client
        this.cache = options.cache
        this.baseResourceStack = options.baseResourceStack
        this.renderBlock = options.renderBlock
        this.prepareArchive = options.prepareArchive || null
        this.onStatus = options.onStatus || (() => {})
        this.controller = new AbortController()
        this.objectUrls = []
        this.renderer = null
        this.destroyed = false
    }

    assertActive() {
        if(this.destroyed || this.controller.signal.aborted) throw Object.assign(new Error('Component preview was cancelled.'), { name: 'AbortError' })
    }

    loading() {
        this.host.replaceChildren(makeElement('div', 'communityPackStudioPreviewLoading', `Loading ${this.component.kind} preview…`))
        this.host.dataset.state = 'loading'
    }

    fallback(message) {
        this.host.replaceChildren(makeElement('div', 'communityPackStudioPreviewFallback', message))
        this.host.dataset.state = 'fallback'
    }

    objectUrl(bytes, mimeType) {
        const url = window.URL.createObjectURL(new window.Blob([Buffer.from(bytes)], { type: mimeType }))
        this.objectUrls.push(url)
        return url
    }

    async mount() {
        this.loading()
        try {
            const selection = {
                sourceItemId: this.component.source.itemId,
                sourceRevisionId: this.component.source.revisionId,
                componentKey: this.component.key
            }
            const resolution = await this.client.resolveComposition({ selections: [selection], conflictResolutions: {} }, { signal: this.controller.signal })
            this.assertActive()
            const source = resolution.sources.find(value => value.revisionId === selection.sourceRevisionId)
            if(!source) throw new Error('The selected component source was not present in the resolution response.')
            const cached = await this.cache.resolveToFile({ ...source, mimeType: 'application/zip' }, this.client.fetch.bind(this.client), { signal: this.controller.signal })
            this.assertActive()
            const previewPath = this.prepareArchive
                ? await this.prepareArchive({ component: this.component, resolution, source, sourceFile: cached.filePath, signal: this.controller.signal })
                : cached.filePath
            this.assertActive()
            const archive = fs.readFileSync(previewPath)
            const packProvider = new ZipBufferResourceProvider(archive, {
                maxBytes: 100 * 1024 * 1024,
                maxEntries: 10_000,
                maxExpandedBytes: 512 * 1024 * 1024
            })
            const stack = createResourceStack([packProvider, this.baseResourceStack])
            stack.cacheKey = `pack-studio-component:${source.sha256}`
            await this.render(selectComponentPreview(this.component), { archive, stack, component: this.component })
            this.assertActive()
            this.host.dataset.state = 'ready'
            this.onStatus(`${this.component.title} preview loaded from pinned revision #${this.component.source.revisionNumber}.`)
            return this
        } catch(error) {
            if(error?.name === 'AbortError' || this.destroyed) return this
            this.fallback(`Unable to preview this ${this.component.kind}: ${error.message}`)
            this.onStatus(error.message, true)
            return this
        }
    }

    async render(type, context) {
        if(type === 'model') return this.renderModel(context)
        if(type === 'item') return this.renderItem(context)
        if(type === 'image') return this.renderImage(context)
        if(type === 'sound') return this.renderSound(context)
        if(type === 'language') return this.renderLanguage(context)
        if(type === 'font') return this.renderFont(context)
        return this.renderGeneric(context)
    }

    async renderModel({ archive }) {
        const subjects = this.component.kind === 'pokemon' ? componentSubjects(this.component) : [componentSubject(this.component)]
        const subject = subjects[0]
        const container = makeElement('div', 'communityPackStudioComponentInteractive')
        this.host.replaceChildren(container)
        this.renderer = new ResourcePackCommunityPreview({
            host: container,
            artifact: archive,
            resourceStack: this.baseResourceStack,
            resources: subjects,
            showcase: { schemaVersion: 1, subjects: [subject] },
            renderBlock: this.renderBlock,
            showResourceBrowser: subjects.length > 1,
            compact: true
        })
        await this.renderer.mount()
        this.assertActive()
    }

    async renderItem({ stack }) {
        const id = splitResourceId(this.component.identifier)
        const model = await resolveInheritedModel(stack, `${id.namespace}:item/${id.path}`)
        const textureId = selectTopTexture(model)
        if(!textureId) throw new Error(`No display texture was found for item ${this.component.identifier}.`)
        const texture = splitResourceId(textureId, id.namespace)
        const bytes = await stack.getBuffer(resolveTexturePath(texture.namespace, texture.path))
        if(!bytes) throw new Error(`Item texture ${textureId} is missing from the selected resource stack.`)
        this.renderImageBytes(bytes, `${this.component.title} item texture`, 'communityPackStudioItemPreview')
    }

    renderImage({ stack, component }) {
        const filePath = selectPreviewFile(component, value => PREVIEWABLE_IMAGE.test(value) && !/\.png\.mcmeta$/i.test(value))
            || componentResourcePath(component)
        if(!filePath) throw new Error('This component has no safe PNG preview resource.')
        return Promise.resolve(stack.getBuffer(filePath)).then(bytes => {
            if(!bytes) throw new Error(`Preview resource is missing: ${filePath}`)
            this.renderImageBytes(bytes, `${this.component.title} texture`, 'communityPackStudioTexturePreview')
        })
    }

    renderImageBytes(bytes, alt, className) {
        if(!readPngDimensions(bytes)) throw new Error('The component preview is not a valid PNG image.')
        const image = makeElement('img', className)
        image.alt = alt
        image.src = this.objectUrl(bytes, 'image/png')
        this.host.replaceChildren(image)
    }

    async renderSound({ stack, component, filePath: explicitPath = null }) {
        let filePath = explicitPath || selectPreviewFile(component, value => PREVIEWABLE_AUDIO.test(value))
        if(!filePath) {
            const id = splitResourceId(component.identifier)
            const definitions = await stack.getJson(`assets/${id.namespace}/sounds.json`)
            const event = definitions?.[component.metadata?.event || id.path]
            filePath = soundResourcePath(event?.sounds?.[0], id.namespace)
        }
        const panel = makeElement('div', 'communityPackStudioMediaPreview')
        panel.append(makeElement('strong', null, this.component.title), makeElement('p', null, 'Audio playback is manual and never starts automatically.'))
        if(filePath) {
            const bytes = await stack.getBuffer(filePath)
            if(!bytes) throw new Error(`Audio resource is missing: ${filePath}`)
            const audio = makeElement('audio', 'communityPackStudioAudioPreview')
            audio.controls = true; audio.preload = 'metadata'; audio.src = this.objectUrl(bytes, 'audio/ogg')
            panel.append(audio)
        } else panel.append(makeElement('p', 'communityPackStudioPreviewFallback', 'This sound event contains metadata but no local OGG resource.'))
        this.host.replaceChildren(panel)
    }

    async renderLanguage({ stack, component }) {
        let entries = languageEntries(component)
        if(entries.length === 0) {
            const document = await stack.getJson(componentResourcePath(component))
            entries = document && typeof document === 'object' && !Array.isArray(document)
                ? Object.entries(document).map(([key, value]) => [key, String(value)]).sort((left, right) => left[0].localeCompare(right[0]))
                : []
        }
        const panel = makeElement('div', 'communityPackStudioTextPreview')
        const heading = makeElement('div', 'communityPackStudioTextPreviewHeader', `${entries.length} translation entries`)
        const list = makeElement('dl', 'communityPackStudioTranslationList')
        for(const [key, value] of entries.slice(0, 80)) {
            const dt = makeElement('dt', null, key); const dd = makeElement('dd', null, value); list.append(dt, dd)
        }
        if(entries.length > 80) list.append(makeElement('dt', null, '…'), makeElement('dd', null, `${entries.length - 80} additional entries`))
        panel.append(heading, list); this.host.replaceChildren(panel)
    }

    async renderFont({ stack, component }) {
        const definitionPath = selectPreviewFile(component, value => /\/font\/.*\.json$/i.test(value)) || componentResourcePath(component)
        const document = definitionPath ? await stack.getJson(definitionPath) : null
        const bitmap = (document?.providers || []).find(value => value?.type === 'bitmap' && value.file)
        const bitmapId = splitResourceId(bitmap?.file, splitResourceId(component.identifier).namespace)
        const imagePath = selectPreviewFile(component, value => PREVIEWABLE_IMAGE.test(value))
            || (bitmapId.path ? `assets/${bitmapId.namespace}/textures/${bitmapId.path}` : null)
        const panel = makeElement('div', 'communityPackStudioFontPreview')
        if(imagePath) {
            const bytes = await stack.getBuffer(imagePath)
            if(bytes && readPngDimensions(bytes)) {
                const image = makeElement('img', null); image.alt = `${this.component.title} glyph sheet`; image.src = this.objectUrl(bytes, 'image/png'); panel.append(image)
            }
        }
        panel.append(makeElement('strong', null, this.component.title), makeElement('p', null, `${Array.isArray(document?.providers) ? document.providers.length : 0} validated font providers`))
        this.host.replaceChildren(panel)
    }

    async renderGeneric({ stack, component }) {
        const directPath = componentResourcePath(component)
        const imagePath = selectPreviewFile(component, value => PREVIEWABLE_IMAGE.test(value)) || (PREVIEWABLE_IMAGE.test(directPath || '') ? directPath : null)
        if(imagePath) return this.renderImage({ stack, component })
        const audioPath = selectPreviewFile(component, value => PREVIEWABLE_AUDIO.test(value)) || (PREVIEWABLE_AUDIO.test(directPath || '') ? directPath : null)
        if(audioPath) return this.renderSound({ stack, component, filePath: audioPath })
        const textPath = selectPreviewFile(component, value => PREVIEWABLE_TEXT.test(value)) || (PREVIEWABLE_TEXT.test(directPath || '') ? directPath : null)
        const panel = makeElement('div', 'communityPackStudioTextPreview')
        if(textPath) {
            const bytes = await stack.getBuffer(textPath)
            const text = Buffer.from(bytes || []).toString('utf8').slice(0, 16_000)
            const pre = makeElement('pre', 'communityPackStudioCodePreview', text); panel.append(pre)
        } else {
            panel.append(makeElement('strong', null, this.component.title))
            const list = makeElement('ul', 'communityPackStudioFileList')
            for(const filePath of ((component.filePaths?.length ? component.filePaths : [directPath]).filter(Boolean)).slice(0, 80)) list.append(makeElement('li', null, filePath))
            panel.append(list)
        }
        this.host.replaceChildren(panel)
    }

    resize(size) { this.renderer?.resize?.(size) }

    destroy() {
        if(this.destroyed) return
        this.destroyed = true
        this.controller.abort()
        this.renderer?.destroy?.(); this.renderer = null
        for(const url of this.objectUrls.splice(0)) window.URL.revokeObjectURL(url)
        this.host.removeAttribute('data-state')
        this.host.replaceChildren()
    }
}

module.exports = {
    PackStudioComponentPreview,
    componentResourcePath,
    componentSubject,
    componentSubjects,
    languageEntries,
    selectComponentPreview,
    selectPreviewFile,
    soundResourcePath
}
