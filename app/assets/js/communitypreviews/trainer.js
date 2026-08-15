'use strict'

/* global document */

const { loadWorkspaceLibrary } = require('../workspacelibrary')
const { parseBedrockGeometry } = loadWorkspaceLibrary('community-rendering')
const { CommunityModelViewer } = require('./model-viewer')

function splitId(value, fallbackNamespace = 'minecraft') {
    const parts = String(value || '').split(':')
    return parts.length === 2 ? { namespace: parts[0], path: parts[1] } : { namespace: fallbackNamespace, path: parts[0] }
}

function textureResourcePath(value) {
    const id = splitId(value, 'cobblepower')
    const texturePath = id.path.replace(/^textures\//, '').replace(/\.png$/i, '')
    return `assets/${id.namespace}/textures/${texturePath}.png`
}

async function resolveTrainerSkin(stack, skinId) {
    const id = splitId(skinId || 'cobblepower:default', 'cobblepower')
    const definitionPaths = [
        `data/${id.namespace}/battle_projector_skins/${id.path}.json`,
        `assets/${id.namespace}/battle_projector/skins/${id.path}.json`
    ]
    let definition = null
    for(const resourcePath of definitionPaths) { definition = await stack?.getJson(resourcePath); if(definition) break }
    if(!definition && id.path !== 'default') return { missing: true, reason: `Skin ${skinId} was not found in the active Resource Pack dependency.` }
    const modelType = String(definition?.model_type || 'default').toLowerCase()
    const modelPath = modelType === 'slim'
        ? 'assets/cobblemon/bedrock/npcs/models/alex.geo.json'
        : 'assets/cobblemon/bedrock/npcs/models/steve.geo.json'
    const geometry = await stack?.getJson(modelPath)
    const texture = definition?.texture ? await stack?.getBuffer(textureResourcePath(definition.texture)) : null
    if(!geometry || !texture) return { missing: true, reason: definition ? 'The trainer model or texture is unavailable in the selected profile.' : 'The default trainer skin has no locally resolvable texture.' }
    return { missing: false, definition, geometry, texture, modelType }
}

function displayIdentifier(value) { return String(value || '—').split(':').at(-1).replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase()) }

class TrainerCommunityPreview {
    constructor(options) { this.host = options.host; this.artifact = JSON.parse(Buffer.from(options.artifact).toString('utf8')); this.stack = options.resourceStack; this.viewer = null; this.destroyed = false }

    async mount() {
        this.host.replaceChildren(); this.host.className = 'communityRichView communityTrainerView'
        const stageColumn = document.createElement('section'); stageColumn.className = 'communityTrainerStageColumn'
        const stage = document.createElement('div'); stage.className = 'communityModelStage'
        this.canvas = document.createElement('canvas'); this.canvas.tabIndex = 0; this.canvas.setAttribute('aria-label', 'Rotatable Battle Trainer model. Drag to rotate and use the wheel to zoom.')
        const fit = document.createElement('button'); fit.type = 'button'; fit.textContent = 'Fit'; fit.className = 'communityModelFit'
        stage.append(this.canvas, fit); stageColumn.append(stage)
        this.modelStatus = document.createElement('p'); this.modelStatus.className = 'communityRichNote'; stageColumn.append(this.modelStatus)
        this.party = document.createElement('ol'); this.party.className = 'communityTrainerParty'; this.party.setAttribute('aria-label', 'Trainer Pokémon party')
        this.renderParty(); this.host.append(stageColumn, this.party)
        fit.addEventListener('click', () => { this.viewer?.fit(); this.viewer?.render() })
        await this.loadModel()
        return this
    }

    async loadModel() {
        try {
            const skin = await resolveTrainerSkin(this.stack, this.artifact.skin_id)
            if(this.destroyed) return
            if(skin.missing) { this.modelStatus.textContent = skin.reason; this.modelStatus.dataset.state = 'missing-dependency'; return }
            const mesh = parseBedrockGeometry(skin.geometry)
            this.viewer = new CommunityModelViewer(this.canvas)
            await this.viewer.setModel(mesh, skin.texture)
            this.modelStatus.textContent = `${skin.definition?.name || displayIdentifier(this.artifact.skin_id)} · ${skin.modelType === 'slim' ? 'Slim' : 'Default'} model`
        } catch(error) {
            this.modelStatus.textContent = `3D trainer preview unavailable: ${error.message}`
            this.modelStatus.dataset.state = 'missing-dependency'
        }
    }

    renderParty() {
        this.party.replaceChildren()
        const team = Array.isArray(this.artifact.team) ? this.artifact.team : []
        for(let slot = 0; slot < 6; slot += 1) {
            const pokemon = team[slot]
            const item = document.createElement('li'); item.className = 'communityTrainerSlot'; if(!pokemon) item.classList.add('empty')
            const heading = document.createElement('h3'); heading.textContent = pokemon ? `${displayIdentifier(pokemon.species)}${pokemon.form ? ` · ${displayIdentifier(pokemon.form)}` : ''} — Lv. ${pokemon.level}` : `Empty slot ${slot + 1}`
            item.append(heading)
            if(pokemon) {
                const facts = document.createElement('p'); facts.textContent = `${displayIdentifier(pokemon.gender)} · ${displayIdentifier(pokemon.nature)} nature · ${displayIdentifier(pokemon.ability)}`
                const moves = document.createElement('p'); moves.className = 'communityTrainerMoves'; moves.textContent = `Moves: ${(pokemon.moves || []).filter(Boolean).map(displayIdentifier).join(', ') || '—'}`
                const ivs = (pokemon.ivs || []).map(Number); const evs = (pokemon.evs || []).map(Number)
                const stats = document.createElement('p'); stats.className = 'communityTrainerStats'; stats.textContent = `IVs H/A/D/SA/SD/S: ${ivs.join('/')} · EVs: ${evs.join('/')} (${evs.reduce((sum, value) => sum + value, 0)} total)`
                item.append(facts, moves, stats)
            }
            this.party.append(item)
        }
    }

    update(artifact) { this.viewer?.destroy(); this.artifact = JSON.parse(Buffer.from(artifact).toString('utf8')); this.renderParty(); return this.loadModel() }
    resize(size) { this.viewer?.resize?.(size) }
    cancel() { /* Resource provider reads are bounded and become inert after destroy. */ }
    destroy() { this.destroyed = true; this.viewer?.destroy(); this.viewer = null; this.host.replaceChildren() }
}

module.exports = { TrainerCommunityPreview, resolveTrainerSkin, textureResourcePath }
