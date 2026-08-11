/**
 * Schematics UI
 */

var pathUtil = require('path')
var {
    SchematicApiClient,
    SchematicApiError,
    SchematicInstallManager,
    loadCore,
    moduleContainsCobblePower
} = require('./assets/js/schematicmanager')
var schematicsFormatCore = loadCore()
var { normalizeJsonSchematic, parseCanonicalSchematic } = schematicsFormatCore

const SCHEMATICS_DEBUG_MODELS = process.env.HELIOS_SCHEMATICS_DEBUG_MODELS === '1'
const SCHEMATICS_DEBUG_BLOCKS = [
    'minecraft:torch',
    'minecraft:wall_torch',
    'minecraft:soul_torch',
    'minecraft:grass_block',
    'minecraft:dirt',
    'minecraft:grass',
    'minecraft:lantern',
    'minecraft:soul_lantern',
    'minecraft:campfire',
    'minecraft:soul_campfire'
]
let schematicsDebugLogged = false
let schematicsHitDebugEnabled = false

function buildDemoBlocks(width, height, depth, blockId, accentBlock) {
    const blocks = []
    const maxY = height - 1
    for(let y = 0; y < height; y++){
        for(let x = 0; x < width; x++){
            for(let z = 0; z < depth; z++){
                const isWall = x === 0 || z === 0 || x === width - 1 || z === depth - 1
                const isTop = y === maxY
                if(isWall || isTop){
                    blocks.push({ pos: [x, y, z], block: blockId })
                }
            }
        }
    }
    if(accentBlock){
        blocks.push({ pos: [Math.floor(width / 2), maxY + 1, Math.floor(depth / 2)], block: accentBlock })
    }
    return blocks
}

function buildVariedDemoBlocks(){
    const blocks = []
    const palette = [
        { block: 'minecraft:stone_bricks' },
        { block: 'minecraft:oak_planks' },
        { block: 'minecraft:glass' },
        { block: 'minecraft:water', state: { level: 0 } },
        { block: 'minecraft:oak_leaves', state: { persistent: true } },
        { block: 'minecraft:glowstone' },
        { block: 'minecraft:torch' },
        { block: 'minecraft:sea_lantern' },
        { block: 'minecraft:grass_block' }
    ]

    let index = 0
    for(let y = 0; y < 4; y++){
        for(let x = 0; x < 4; x++){
            for(let z = 0; z < 4; z++){
                const entry = palette[index % palette.length]
                blocks.push({
                    pos: [x, y, z],
                    block: entry.block,
                    state: entry.state
                })
                index += 1
            }
        }
    }
    blocks.push({ pos: [1, 4, 1], block: 'minecraft:lantern' })
    blocks.push({ pos: [2, 4, 2], block: 'minecraft:campfire' })
    return blocks
}

const SCHEMATICS_FALLBACK = [
    {
        id: 'skyforge-airship-dock',
        name: 'Skyforge Airship Dock',
        creator: 'AerialSmith',
        likes: 1030,
        views: 19260,
        release: '2025-12-18',
        size: '124 x 96 x 78',
        downloads: 12840,
        version: '1.20+',
        tags: ['Airship', 'Dock', 'Steampunk'],
        description: 'A modular airship dock with crane bays, fueling gantries, and storage hangars built for bustling skyports.',
        blocks: buildVariedDemoBlocks(),
        accent: '92, 160, 255'
    },
    {
        id: 'verdant-terrace-village',
        name: 'Verdant Terrace Village',
        creator: 'Oakweaver',
        likes: 780,
        views: 14700,
        release: '2025-10-05',
        size: '160 x 120 x 64',
        downloads: 9805,
        version: '1.19+',
        tags: ['Village', 'Terraces', 'Survival'],
        description: 'A hillside village layered with farms, bridges, and community plazas connected by lush terraces.',
        blocks: buildDemoBlocks(5, 5, 5, 'minecraft:oak_planks', 'minecraft:torch'),
        accent: '110, 204, 120'
    },
    {
        id: 'crimson-keep',
        name: 'Crimson Keep',
        creator: 'RedstoneRook',
        likes: 1380,
        views: 25860,
        release: '2026-01-12',
        size: '148 x 110 x 92',
        downloads: 17240,
        version: '1.20+',
        tags: ['Castle', 'Fortress', 'Nether'],
        description: 'A towering basalt fortress with lava-lit halls and a commanding central keep.',
        blocks: buildDemoBlocks(6, 7, 6, 'minecraft:polished_blackstone_bricks', 'minecraft:lantern'),
        accent: '237, 96, 97'
    },
    {
        id: 'riverstone-market-hall',
        name: 'Riverstone Market Hall',
        creator: 'MossyBricks',
        likes: 590,
        views: 11100,
        release: '2025-08-21',
        size: '92 x 68 x 44',
        downloads: 7400,
        version: '1.18+',
        tags: ['Market', 'Medieval', 'Town'],
        description: 'A compact market hall with merchant stalls, canopy roofs, and a riverfront dock.',
        blocks: buildDemoBlocks(4, 4, 5, 'minecraft:stone_bricks', 'minecraft:torch'),
        accent: '148, 190, 210'
    },
    {
        id: 'ender-observatory',
        name: 'Ender Observatory',
        creator: 'VoidAtlas',
        likes: 900,
        views: 16900,
        release: '2025-11-15',
        size: '110 x 110 x 96',
        downloads: 11250,
        version: '1.19+',
        tags: ['Observatory', 'End', 'Arcane'],
        description: 'An arcane observatory designed for void research, complete with rotating lenses and ritual circles.',
        blocks: buildDemoBlocks(5, 6, 5, 'minecraft:purpur_block', 'minecraft:end_rod'),
        accent: '186, 120, 255'
    },
    {
        id: 'sunken-library',
        name: 'Sunken Library',
        creator: 'Tidebound',
        likes: 676,
        views: 12700,
        release: '2025-09-28',
        size: '104 x 88 x 56',
        downloads: 8450,
        version: '1.18+',
        tags: ['Library', 'Underwater', 'Ruins'],
        description: 'A partially flooded archive with recovered stacks, glass domes, and submerged reading rooms.',
        blocks: buildVariedDemoBlocks(),
        accent: '76, 180, 200'
    },
    {
        id: 'glassspire-tower',
        name: 'Glassspire Tower',
        creator: 'SkylineFlux',
        likes: 770,
        views: 14400,
        release: '2025-12-02',
        size: '76 x 76 x 140',
        downloads: 9600,
        version: '1.20+',
        tags: ['Tower', 'Modern', 'Beacon'],
        description: 'A sleek, vertical tower built from glass and prismarine with an illuminated beacon crown.',
        blocks: buildVariedDemoBlocks(),
        accent: '160, 220, 255'
    },
    {
        id: 'copperworks-forge',
        name: 'Copperworks Forge',
        creator: 'Rustwright',
        likes: 500,
        views: 9300,
        release: '2025-07-14',
        size: '88 x 70 x 48',
        downloads: 6200,
        version: '1.17+',
        tags: ['Forge', 'Industrial', 'Workshop'],
        description: 'An industrial forge with copper piping, smelting pits, and animated ventilation stacks.',
        blocks: buildDemoBlocks(4, 4, 4, 'minecraft:copper_block', 'minecraft:lantern'),
        accent: '220, 140, 80'
    },
    {
        id: 'snowfall-lodge',
        name: 'Snowfall Lodge',
        creator: 'Frostline',
        likes: 570,
        views: 10700,
        release: '2025-12-29',
        size: '96 x 88 x 56',
        downloads: 7100,
        version: '1.18+',
        tags: ['Lodge', 'Winter', 'Cozy'],
        description: 'A warm alpine lodge with stone fireplaces, timber beams, and snow-lined balconies.',
        blocks: buildDemoBlocks(5, 5, 5, 'minecraft:spruce_planks', 'minecraft:lantern'),
        accent: '180, 220, 255'
    },
    {
        id: 'obsidian-gatehouse',
        name: 'Obsidian Gatehouse',
        creator: 'NetherForge',
        likes: 820,
        views: 15300,
        release: '2026-01-05',
        size: '120 x 90 x 80',
        downloads: 10200,
        version: '1.20+',
        tags: ['Gatehouse', 'Nether', 'Defense'],
        description: 'A fortified gateway with obsidian bastions, reinforced bridges, and defensive ramps.',
        blocks: buildDemoBlocks(5, 6, 5, 'minecraft:obsidian', 'minecraft:shroomlight'),
        accent: '180, 80, 120'
    },
    {
        id: 'coral-reef-station',
        name: 'Coral Reef Station',
        creator: 'Seabright',
        likes: 430,
        views: 8100,
        release: '2025-08-08',
        size: '90 x 84 x 46',
        downloads: 5400,
        version: '1.13+',
        tags: ['Ocean', 'Station', 'Coral'],
        description: 'A coastal research station built on coral platforms with glass walkways and docked skiffs.',
        blocks: buildDemoBlocks(4, 4, 5, 'minecraft:prismarine', 'minecraft:sea_lantern'),
        accent: '120, 210, 190'
    },
    {
        id: 'hanging-gardens',
        name: 'Hanging Gardens',
        creator: 'Ivyspire',
        likes: 1270,
        views: 23820,
        release: '2025-11-30',
        size: '140 x 110 x 90',
        downloads: 15880,
        version: '1.19+',
        tags: ['Gardens', 'Wonder', 'Mythic'],
        description: 'A mythic wonder stacked with waterfalls, suspended terraces, and lush botanical vaults.',
        blocks: buildDemoBlocks(6, 6, 6, 'minecraft:moss_block', 'minecraft:glowstone'),
        accent: '140, 220, 130'
    }
]

const SCHEMATIC_PREVIEW_SVG = `
<svg viewBox="0 0 48 48" aria-hidden="true" focusable="false" stroke-linecap="round" stroke-linejoin="round">
    <path d="M24 6 8 14v20l16 8 16-8V14L24 6z"/>
    <path d="M8 14l16 8 16-8"/>
    <path d="M24 22v20"/>
</svg>
`

const COLLECTION_PREVIEW_SVG = `
<svg viewBox="0 0 48 48" aria-hidden="true" focusable="false" stroke-linecap="round" stroke-linejoin="round">
    <rect x="8" y="12" width="32" height="24" rx="4"/>
    <path d="M14 18h20"/>
    <path d="M14 24h20"/>
    <path d="M14 30h12"/>
</svg>
`

const SCHEMATIC_LIKE_SVG = `
<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M12 21s-7.2-4.3-9.4-8.3C.9 9.9 2.1 6.7 4.9 6c2-.5 3.9.3 5.1 1.8 1.2-1.5 3.1-2.3 5.1-1.8 2.8.7 4 3.9 2.3 6.7C19.2 16.7 12 21 12 21z"/>
</svg>
`

const SCHEMATIC_VIEW_SVG = `
<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M12 5c-5.2 0-9.7 3.4-11 7 1.3 3.6 5.8 7 11 7s9.7-3.4 11-7c-1.3-3.6-5.8-7-11-7z"/>
    <circle cx="12" cy="12" r="3.5"/>
</svg>
`

class CommunityEngagement {
    constructor(entry){
        this.entry = entry || {}
    }

    static resolveMetric(entry, key){
        if(!entry || typeof entry !== 'object'){
            return null
        }
        if(entry[key] != null){
            return entry[key]
        }
        if(entry.stats?.[key] != null){
            return entry.stats[key]
        }
        if(entry.engagement?.[key] != null){
            return entry.engagement[key]
        }
        return null
    }

    static parseValue(value){
        return Number.isFinite(Number(value)) ? Number(value) : 0
    }

    static formatCount(value){
        if(value == null || Number.isNaN(Number(value))){
            return '--'
        }
        return formatDownloadCount(value)
    }

    createStat({ svg, value, label, className = 'schematicEngagementStat' }){
        const stat = document.createElement('span')
        stat.className = className
        stat.setAttribute('role', 'img')
        stat.setAttribute('aria-label', `${label} ${CommunityEngagement.formatCount(value)}`)
        const icon = document.createElement('span')
        icon.innerHTML = svg
        const count = document.createElement('span')
        count.textContent = CommunityEngagement.formatCount(value)
        stat.appendChild(icon)
        stat.appendChild(count)
        return stat
    }

    getLikes(){
        return CommunityEngagement.resolveMetric(this.entry, 'likes')
    }

    getViews(){
        return CommunityEngagement.resolveMetric(this.entry, 'views')
    }

    createRow({ className = 'schematicEngagement' } = {}){
        const row = document.createElement('div')
        row.className = className
        row.appendChild(this.createStat({ svg: SCHEMATIC_LIKE_SVG, value: this.getLikes(), label: 'Likes' }))
        row.appendChild(this.createStat({ svg: SCHEMATIC_VIEW_SVG, value: this.getViews(), label: 'Views' }))
        return row
    }
}

function formatEngagementCount(value){
    return CommunityEngagement.formatCount(value)
}

function createGridEntryMedia({ className, imageUrl, alt, fallbackSvg, imageClass } = {}){
    const wrapper = document.createElement('div')
    if(className){
        wrapper.className = className
    }
    wrapper.setAttribute('aria-hidden', 'true')
    if(imageUrl){
        const img = document.createElement('img')
        img.src = imageUrl
        img.alt = alt || ''
        img.loading = 'lazy'
        img.decoding = 'async'
        if(imageClass){
            img.className = imageClass
        }
        wrapper.appendChild(img)
    } else if(fallbackSvg){
        const icon = document.createElement('div')
        icon.className = 'schematicsGridIcon'
        icon.innerHTML = fallbackSvg
        wrapper.appendChild(icon)
    }
    return wrapper
}

const SCHEMATICS_SORT_DEFAULT = 'likes-desc'

const SCHEMATIC_SORTERS = {
    'likes-desc': (a, b) => (getLikesValue(b) - getLikesValue(a)) || (getReleaseTimestamp(b) - getReleaseTimestamp(a)) || compareSchematicName(a, b),
    'likes-asc': (a, b) => (getLikesValue(a) - getLikesValue(b)) || (getReleaseTimestamp(b) - getReleaseTimestamp(a)) || compareSchematicName(a, b),
    'release-desc': (a, b) => (getReleaseTimestamp(b) - getReleaseTimestamp(a)) || (getLikesValue(b) - getLikesValue(a)) || compareSchematicName(a, b),
    'release-asc': (a, b) => (getReleaseTimestamp(a) - getReleaseTimestamp(b)) || (getLikesValue(b) - getLikesValue(a)) || compareSchematicName(a, b)
}

const SCHEMATIC_INDEX = new Map()
const SCHEMATIC_NORMALIZED_CACHE = new Map()
const SCHEMATIC_DETAIL_CACHE = new Map()
const SCHEMATICS_GRID_CARD_WIDTH = 210
const SCHEMATICS_GRID_GAP = 16
const SCHEMATICS_GRID_ROWS = 3
const SCHEMATICS_PAGE_SIZE_FALLBACK = 24
const SCHEMATICS_VIEW_COPY = {
    content: {
        schematics: {
            eyebrow: schematicsEyebrow?.textContent || 'Community',
            title: schematicsTitle?.textContent || 'Schematics Library',
            subtitle: schematicsSubtitle?.textContent || 'Browse, preview, and install build schematics curated by the community.'
        },
        collections: {
            eyebrow: schematicsEyebrow?.textContent || 'Community',
            title: 'Collections Library',
            subtitle: 'Browse curated collections of schematics and discover themed build sets.'
        }
    },
    creators: {
        list: {
            eyebrow: schematicsEyebrow?.textContent || 'Community',
            title: 'Creators',
            subtitle: 'Explore community creators and jump into their latest builds and collections.'
        },
        profile: {
            eyebrow: schematicsEyebrow?.textContent || 'Community',
            title: 'Creator',
            subtitle: 'Review published schematics and collections from this creator.'
        }
    },
    schematics: {
        eyebrow: schematicsEyebrow?.textContent || 'Community',
        title: schematicsTitle?.textContent || 'Schematics Library',
        subtitle: schematicsSubtitle?.textContent || 'Browse, preview, and install build schematics curated by the community.'
    },
    collections: {
        eyebrow: schematicsEyebrow?.textContent || 'Community',
        title: 'Collections Library',
        subtitle: 'Browse curated collections of schematics and discover themed build sets.'
    }
}
let schematicsState = {
    status: 'idle',
    error: null,
    items: [],
    total: 0,
    apiBase: null,
    query: '',
    sortKey: SCHEMATICS_SORT_DEFAULT,
    page: 1,
    pageSize: 24,
    filters: {
        tags: '',
        creator: ''
    }
}

function toggleSchematicsHitDebug(){
    schematicsHitDebugEnabled = !schematicsHitDebugEnabled
    document.body.classList.toggle('schematics-hit-debug', schematicsHitDebugEnabled)
    loggerLanding.info(`Schematics hit debug ${schematicsHitDebugEnabled ? 'enabled' : 'disabled'}.`)
}
function updateCommunityHeader(){
    if(!schematicsTitleGroup){
        return
    }
    if(schematicsCommunitySection === 'creators' && schematicsCreatorView === 'profile'){
        schematicsTitleGroup.hidden = true
        return
    }
    schematicsTitleGroup.hidden = false
    let copy = null
    if(schematicsCommunitySection === 'content'){
        copy = SCHEMATICS_VIEW_COPY.content?.[schematicsContentTab]
    } else if(schematicsCommunitySection === 'creators'){
        copy = SCHEMATICS_VIEW_COPY.creators?.[schematicsCreatorView || 'list']
    }
    if(!copy){
        copy = SCHEMATICS_VIEW_COPY.schematics
    }
    if(schematicsEyebrow && copy?.eyebrow){
        schematicsEyebrow.textContent = copy.eyebrow
    }
    if(schematicsTitle && copy?.title){
        schematicsTitle.textContent = copy.title
    }
    if(schematicsSubtitle && copy?.subtitle){
        schematicsSubtitle.textContent = copy.subtitle
    }
}

function computeGridPageSize(gridEl){
    if(!gridEl){
        return null
    }
    const width = gridEl.clientWidth || gridEl.getBoundingClientRect().width
    if(!width){
        return null
    }
    const columns = Math.max(1, Math.floor((width + SCHEMATICS_GRID_GAP) / (SCHEMATICS_GRID_CARD_WIDTH + SCHEMATICS_GRID_GAP)))
    return Math.max(columns * SCHEMATICS_GRID_ROWS, columns)
}

function scheduleCommunityPageSizeRefresh(){
    if(schematicsPageSizeTimer){
        clearTimeout(schematicsPageSizeTimer)
    }
    schematicsPageSizeTimer = setTimeout(() => {
        const nextSchematicsSize = computeGridPageSize(schematicsGrid)
        if(nextSchematicsSize && nextSchematicsSize !== schematicsState.pageSize){
            schematicsState = {
                ...schematicsState,
                pageSize: nextSchematicsSize,
                page: 1
            }
            if(schematicsActive && schematicsCommunitySection === 'content' && schematicsContentTab === 'schematics'){
                fetchSchematicsList({
                    query: schematicsSearchInput?.value || '',
                    sortKey: schematicsSortSelect?.value || SCHEMATICS_SORT_DEFAULT,
                    page: 1
                })
            } else {
                updateSchematicsPagination()
            }
        }

        const nextCollectionsSize = computeGridPageSize(schematicsCollectionsBrowseList)
        if(nextCollectionsSize && nextCollectionsSize !== schematicsCollectionsBrowseState.pageSize){
            schematicsCollectionsBrowseState = {
                ...schematicsCollectionsBrowseState,
                pageSize: nextCollectionsSize,
                page: 1
            }
            if(schematicsActive && schematicsCommunitySection === 'content' && schematicsContentTab === 'collections'){
                fetchCollectionsBrowse({ page: 1 })
            } else {
                updateCollectionsBrowsePager()
            }
        }

        const nextCreatorSize = computeGridPageSize(schematicsCreatorGrid)
        if(nextCreatorSize && nextCreatorSize !== schematicsCreatorState.pageSize){
            schematicsCreatorState = {
                ...schematicsCreatorState,
                pageSize: nextCreatorSize,
                page: 1
            }
            if(schematicsCreatorOpen && schematicsCreatorState.creator){
                fetchCreatorSchematics(schematicsCreatorState.creator, { page: 1, sortKey: schematicsCreatorState.sortKey })
            } else {
                updateCreatorPagination()
            }
        }
    }, 200)
}

function setCommunitySection(section, { skipFetch } = {}){
    const next = section === 'creators' ? 'creators' : 'content'
    schematicsCommunitySection = next
    if(schematicsContent){
        schematicsContent.setAttribute('data-community-section', next)
    }
    if(next === 'content'){
        schematicsCreatorView = 'list'
        setContentTab(schematicsContentTab, { skipFetch })
    } else {
        setCreatorView('list', { skipFetch })
        if(!skipFetch){
            fetchCreatorsBrowse()
        }
    }
    updateCommunityView()
}

function setContentTab(tab, { skipFetch } = {}){
    const next = tab === 'collections' ? 'collections' : 'schematics'
    schematicsContentTab = next
    if(schematicsContent){
        schematicsContent.setAttribute('data-content-tab', next)
    }
    if(!skipFetch){
        if(next === 'collections'){
            fetchCollectionsBrowse({ page: 1 })
        } else {
            fetchSchematicsList({ query: schematicsSearchInput?.value || '', sortKey: schematicsSortSelect?.value || SCHEMATICS_SORT_DEFAULT, page: 1 })
        }
    }
    updateCommunityView()
}

function setCreatorView(view, { skipFetch } = {}){
    const next = view === 'profile' ? 'profile' : 'list'
    schematicsCreatorView = next
    if(schematicsContent){
        schematicsContent.setAttribute('data-creator-view', next)
    }
    if(!skipFetch){
        if(next === 'list'){
            fetchCreatorsBrowse()
        } else if(schematicsCreatorState.creator){
            fetchCreatorSchematics(schematicsCreatorState.creator, { page: 1, sortKey: schematicsCreatorState.sortKey })
            fetchCreatorCollections(schematicsCreatorState.creator)
        }
    }
    updateCommunityView()
}

function updateCommunityView(){
    if(schematicsCategoryRow){
        schematicsCategoryRow.hidden = schematicsCommunitySection !== 'content'
    }
    if(schematicsBrowseSchematicsView){
        schematicsBrowseSchematicsView.hidden = !(schematicsCommunitySection === 'content' && schematicsContentTab === 'schematics')
    }
    if(schematicsBrowseCollectionsView){
        schematicsBrowseCollectionsView.hidden = !(schematicsCommunitySection === 'content' && schematicsContentTab === 'collections')
    }
    if(schematicsCreatorsBrowseView){
        schematicsCreatorsBrowseView.hidden = !(schematicsCommunitySection === 'creators' && schematicsCreatorView === 'list')
    }
    if(schematicsBrowseCreatorView){
        schematicsBrowseCreatorView.hidden = !(schematicsCommunitySection === 'creators' && schematicsCreatorView === 'profile')
    }
    if(schematicsCategorySelect){
        schematicsCategorySelect.value = schematicsContentTab
        schematicsCategorySelect.disabled = schematicsCommunitySection !== 'content'
    }
    updateCommunityHeader()
    scheduleCommunityPageSizeRefresh()
}
let schematicsFetchController = null
let schematicsFetchTimer = null
let schematicsInstallIndex = new Map()
let schematicsInstallManager = null
let schematicsCommunitySection = 'content'
let schematicsCommunityPreviousSection = 'content'
let schematicsCommunityPreviousContentTab = 'schematics'
let schematicsContentTab = 'schematics'
let schematicsCreatorView = 'list'
let schematicsCollectionsBrowseTimer = null
let schematicsPageSizeTimer = null
let schematicsCollectionsBrowseState = {
    status: 'idle',
    items: [],
    total: 0,
    error: null,
    query: '',
    sort: 'updated',
    mine: false,
    page: 1,
    pageSize: 24,
    detail: null,
    detailStatus: 'idle',
    detailError: null
}
let schematicsCreatorsBrowseState = {
    status: 'idle',
    items: [],
    total: 0,
    error: null
}

const SCHEMATICS_CACHE_DIR = pathUtil.join(ConfigManager.getLauncherDirectory(), 'schematics-cache')
const SCHEMATICS_INSTALL_DIR = pathUtil.join(SCHEMATICS_CACHE_DIR, 'installed')
const SCHEMATICS_INDEX_PATH = pathUtil.join(SCHEMATICS_CACHE_DIR, 'index.json')
const SCHEMATICS_ATLAS_CACHE_DIR = pathUtil.join(SCHEMATICS_CACHE_DIR, 'atlas')
const SCHEMATICS_ATLAS_CACHE_VERSION = 5
const SCHEMATICS_REBUILD_CACHE = ['1', 'true', 'yes'].includes(String(process.env.SCHEMATICS_REBUILD_CACHE || '').toLowerCase())
const SCHEMATICS_ATLAS_DISK_LIMIT = 8
const SCHEMATICS_MODS_JSON_PATH = pathUtil.resolve(process.cwd(), 'mods.json')
const SCHEMATICS_MOD_JAR_CACHE_DIR = pathUtil.join(SCHEMATICS_CACHE_DIR, 'mod-jars')
const SCHEMATICS_MOD_RESOLUTION_PATH = pathUtil.join(SCHEMATICS_CACHE_DIR, 'mod-resolutions.json')
const SCHEMATICS_CURSE_MAVEN_BASE = String(process.env.SCHEMATICS_CURSE_MAVEN_BASE || 'https://www.cursemaven.com/api/maven').replace(/\/+$/, '')
const SCHEMATICS_MODRINTH_BASE = String(process.env.SCHEMATICS_MODRINTH_BASE || 'https://api.modrinth.com/v2').replace(/\/+$/, '')
const SCHEMATICS_CURSEFORGE_BASE = String(process.env.SCHEMATICS_CURSEFORGE_BASE || 'https://api.curseforge.com/v1').replace(/\/+$/, '')
const SCHEMATICS_CURSEFORGE_API_KEY = process.env.SCHEMATICS_CURSEFORGE_API_KEY || process.env.CURSEFORGE_API_KEY || ''
const SCHEMATICS_PLATFORM_ORDER = String(process.env.SCHEMATICS_MOD_PLATFORM_ORDER || 'modrinth,curseforge')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
const SCHEMATICS_PLATFORM_TIMEOUT_MS = 10000
const SCHEMATICS_MOD_DEBUG = String(process.env.SCHEMATICS_MOD_DEBUG || '').toLowerCase() === '1'

let schematicsResourceStack = null
let schematicsResourceStackKey = null
let schematicsRemoteAssetsRevision = 0
let schematicsModsIndexLoaded = false
let schematicsModsByNamespace = new Map()
const schematicsModJarCache = new Map()
const schematicsModJarFailures = new Set()
const schematicsModDownloads = new Map()
let schematicsModResolutionLoaded = false
let schematicsModResolutionCache = new Map()
let schematicsRemoteModProvider = null
let schematicsRuntimeRegistry = {
    blockstates: { ...(schematicRegistryBase.blockstates || {}) },
    models: { ...(schematicRegistryBase.models || {}) }
}
let schematicsLoadedBlockstates = new Set(Object.keys(schematicsRuntimeRegistry.blockstates))
let schematicsLoadedModels = new Set(Object.keys(schematicsRuntimeRegistry.models))
let schematicsTextureAtlas = null
const SCHEMATICS_ATLAS_CACHE_LIMIT = 3
const schematicsTextureAtlasCache = new Map()
const SCHEMATICS_ALPHA_CACHE_LIMIT = 300
const schematicsTextureAlphaCache = new Map()
const SCHEMATICS_BLOCK_TRANSLATION_CACHE_LIMIT = 4000
const SCHEMATICS_MINECRAFT_LANG_DEFAULT = normalizeMinecraftLangCode(process.env.SCHEMATICS_MINECRAFT_LANG || '') || 'en_us'
const schematicsLangNamespaceCache = new Map()
const schematicsBlockDisplayNameCache = new Map()
let schematicsCacheRebuildDone = false
const SCHEMATICS_UPLOAD_MAX_BYTES = 5 * 1024 * 1024
let schematicsUploadState = {
    file: null,
    raw: null,
    canonical: null,
    normalized: null,
    warnings: [],
    status: 'idle'
}

function normalizeSchematicQuery(query){
    return (query || '').trim().toLowerCase()
}

function splitResourceId(id, defaultNamespace = 'minecraft'){
    if(!id){
        return { namespace: defaultNamespace, path: '' }
    }
    const parts = id.split(':')
    if(parts.length === 2){
        return { namespace: parts[0], path: parts[1] }
    }
    return { namespace: defaultNamespace, path: id }
}

function normalizeMinecraftLangCode(value){
    if(typeof value !== 'string'){
        return ''
    }
    return value.trim().replace(/-/g, '_').toLowerCase()
}

function resolvePreferredMinecraftLangCode(){
    const navLocale = typeof navigator !== 'undefined'
        ? normalizeMinecraftLangCode(navigator.language || '')
        : ''
    return navLocale || SCHEMATICS_MINECRAFT_LANG_DEFAULT
}

function buildMinecraftLangFallbacks(locale){
    const normalized = normalizeMinecraftLangCode(locale) || SCHEMATICS_MINECRAFT_LANG_DEFAULT
    const list = []
    const push = (value) => {
        const key = normalizeMinecraftLangCode(value)
        if(key && !list.includes(key)){
            list.push(key)
        }
    }
    push(normalized)
    const base = normalized.split('_')[0]
    if(base && base !== normalized){
        push(base)
    }
    push('en_us')
    return list
}

function parseLegacyMinecraftLang(content){
    const result = {}
    if(typeof content !== 'string' || !content){
        return result
    }
    const lines = content.split(/\r?\n/)
    for(const line of lines){
        const trimmed = line.trim()
        if(!trimmed || trimmed.startsWith('#')){
            continue
        }
        const divider = trimmed.indexOf('=')
        if(divider <= 0){
            continue
        }
        const key = trimmed.slice(0, divider).trim()
        const value = trimmed.slice(divider + 1).trim()
        if(key && value){
            result[key] = value
        }
    }
    return result
}

function setCachedBlockDisplayName(cacheKey, value){
    if(!cacheKey){
        return
    }
    schematicsBlockDisplayNameCache.set(cacheKey, value)
    if(schematicsBlockDisplayNameCache.size > SCHEMATICS_BLOCK_TRANSLATION_CACHE_LIMIT){
        const firstKey = schematicsBlockDisplayNameCache.keys().next().value
        schematicsBlockDisplayNameCache.delete(firstKey)
    }
}

function formatBlockIdFallbackName(blockId){
    if(typeof blockId !== 'string' || !blockId){
        return 'Unknown Block'
    }
    const { path } = splitResourceId(blockId)
    const source = (path || blockId).split('/').pop() || blockId
    return source
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\b([a-z])/g, (match, char) => char.toUpperCase())
}

async function loadNamespaceLanguageMap(stack, namespace, locale){
    const ns = normalizeNamespace(namespace)
    if(!stack || !ns){
        return null
    }
    const langCode = normalizeMinecraftLangCode(locale) || SCHEMATICS_MINECRAFT_LANG_DEFAULT
    const stackKey = schematicsResourceStackKey || 'default'
    const cacheKey = `${stackKey}|${ns}|${langCode}`
    if(schematicsLangNamespaceCache.has(cacheKey)){
        return schematicsLangNamespaceCache.get(cacheKey)
    }

    const merged = {}
    let found = false
    const fallbackOrder = buildMinecraftLangFallbacks(langCode).slice().reverse()
    for(const code of fallbackOrder){
        const jsonPath = `assets/${ns}/lang/${code}.json`
        let entries = await stack.getJson(jsonPath)
        if(!entries){
            const legacyPath = `assets/${ns}/lang/${code}.lang`
            const legacyText = await stack.getText(legacyPath)
            if(legacyText){
                entries = parseLegacyMinecraftLang(legacyText)
            }
        }
        if(entries && typeof entries === 'object'){
            Object.assign(merged, entries)
            found = true
        }
    }

    const result = found ? merged : null
    schematicsLangNamespaceCache.set(cacheKey, result)
    return result
}

async function resolveSchematicBlockDisplayName(blockId, { stack = null, locale = null } = {}){
    if(typeof blockId !== 'string' || !blockId){
        return formatBlockIdFallbackName(blockId)
    }
    const langCode = normalizeMinecraftLangCode(locale) || resolvePreferredMinecraftLangCode()
    const stackKey = schematicsResourceStackKey || 'default'
    const cacheKey = `${stackKey}|${langCode}|${blockId}`
    if(schematicsBlockDisplayNameCache.has(cacheKey)){
        const cached = schematicsBlockDisplayNameCache.get(cacheKey)
        schematicsBlockDisplayNameCache.delete(cacheKey)
        schematicsBlockDisplayNameCache.set(cacheKey, cached)
        return cached
    }

    const fallback = formatBlockIdFallbackName(blockId)
    const { namespace, path } = splitResourceId(blockId)
    if(!path){
        setCachedBlockDisplayName(cacheKey, fallback)
        return fallback
    }

    const activeStack = stack || await buildSchematicsResourceStack()
    if(!activeStack){
        setCachedBlockDisplayName(cacheKey, fallback)
        return fallback
    }

    const entries = await loadNamespaceLanguageMap(activeStack, namespace, langCode)
    const keyPath = path.replace(/\//g, '.')
    const blockKey = `block.${namespace}.${keyPath}`
    const itemKey = `item.${namespace}.${keyPath}`
    const translated = typeof entries?.[blockKey] === 'string'
        ? entries[blockKey]
        : (typeof entries?.[itemKey] === 'string' ? entries[itemKey] : null)
    const resolved = translated && translated.trim()
        ? translated.trim()
        : fallback
    setCachedBlockDisplayName(cacheKey, resolved)
    return resolved
}

async function resolvePaletteBlockDisplayNames(palette, { stack = null, locale = null } = {}){
    const labels = new Map()
    if(!Array.isArray(palette) || palette.length === 0){
        return labels
    }

    const uniqueIds = []
    const seen = new Set()
    for(const entry of palette){
        const blockId = typeof entry?.block === 'string' ? entry.block : null
        if(!blockId || seen.has(blockId)){
            continue
        }
        seen.add(blockId)
        uniqueIds.push(blockId)
    }
    if(uniqueIds.length === 0){
        return labels
    }

    const activeStack = stack || await buildSchematicsResourceStack()
    const activeLocale = normalizeMinecraftLangCode(locale) || resolvePreferredMinecraftLangCode()
    await Promise.all(uniqueIds.map(async (blockId) => {
        const displayName = await resolveSchematicBlockDisplayName(blockId, { stack: activeStack, locale: activeLocale })
        labels.set(blockId, displayName)
    }))
    return labels
}

function normalizeNamespace(value){
    return String(value || '').trim().toLowerCase()
}

function extractNamespaceFromResourcePath(resourcePath){
    if(!resourcePath){
        return null
    }
    const normalized = String(resourcePath).replace(/\\/g, '/')
    const match = normalized.match(/^assets\/([^/]+)\//)
    return match ? normalizeNamespace(match[1]) : null
}

function getModuleType(moduleEntry){
    if(!moduleEntry){
        return ''
    }
    const type = moduleEntry.rawModule?.type || moduleEntry.type || moduleEntry.raw?.type
    return String(type || '').toLowerCase()
}

function resolveServerLoader(server){
    const modules = Array.isArray(server?.modules) ? server.modules : []
    const types = modules.map(getModuleType)
    if(types.some((type) => type.includes('fabric'))){
        return 'fabric'
    }
    if(types.some((type) => type.includes('neoforge'))){
        return 'neoforge'
    }
    if(types.some((type) => type.includes('forge'))){
        return 'forge'
    }
    return null
}

async function getSchematicsServerContext(){
    try {
        const distro = await DistroAPI.getDistribution()
        const server = distro?.getServerById(ConfigManager.getSelectedServer())
        return {
            serverId: server?.rawServer?.id || null,
            mcVersion: server?.rawServer?.minecraftVersion || null,
            loader: resolveServerLoader(server)
        }
    } catch (err) {
        return { serverId: null, mcVersion: null, loader: null }
    }
}

function buildModResolutionKey(namespace, context){
    const serverId = context?.serverId || 'default'
    const mcVersion = context?.mcVersion || 'unknown'
    const loader = context?.loader || 'unknown'
    return `${serverId}:${mcVersion}:${loader}:${normalizeNamespace(namespace)}`
}

async function loadModResolutionCache(){
    if(schematicsModResolutionLoaded){
        return schematicsModResolutionCache
    }
    schematicsModResolutionLoaded = true
    schematicsModResolutionCache = new Map()
    try {
        if(await fs.pathExists(SCHEMATICS_MOD_RESOLUTION_PATH)){
            const data = await fs.readJson(SCHEMATICS_MOD_RESOLUTION_PATH)
            const entries = Array.isArray(data?.entries) ? data.entries : []
            for(const entry of entries){
                if(entry?.key && entry.value){
                    schematicsModResolutionCache.set(entry.key, entry.value)
                }
            }
        }
    } catch (err) {
        loggerLanding.warn('[schematics] Failed to load mod resolution cache.', err)
    }
    return schematicsModResolutionCache
}

async function saveModResolutionCache(){
    try {
        await fs.ensureDir(SCHEMATICS_CACHE_DIR)
        const entries = Array.from(schematicsModResolutionCache.entries()).map(([key, value]) => ({ key, value }))
        await fs.writeJson(SCHEMATICS_MOD_RESOLUTION_PATH, { entries }, { spaces: 0 })
    } catch (err) {
        loggerLanding.warn('[schematics] Failed to save mod resolution cache.', err)
    }
}

async function getCachedModResolution(key){
    await loadModResolutionCache()
    return schematicsModResolutionCache.get(key) || null
}

async function setCachedModResolution(key, value){
    await loadModResolutionCache()
    schematicsModResolutionCache.set(key, value)
    await saveModResolutionCache()
}

function sanitizeFileName(value){
    return String(value || '')
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
        .replace(/\s+/g, '_')
        .slice(0, 140)
}

function getPlatformJarCachePath(info){
    const source = info.source || 'platform'
    const projectId = sanitizeFileName(info.projectId || 'project')
    const fileId = sanitizeFileName(info.fileId || info.versionId || 'file')
    const name = sanitizeFileName(info.fileName || `${projectId}-${fileId}.jar`)
    return pathUtil.join(SCHEMATICS_MOD_JAR_CACHE_DIR, `${source}-${projectId}-${fileId}-${name}`)
}

async function fetchJsonWithTimeout(url, options = {}){
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), SCHEMATICS_PLATFORM_TIMEOUT_MS)
    try {
        const response = await fetch(url, { ...options, signal: controller.signal })
        if(!response.ok){
            return { ok: false, status: response.status, data: null }
        }
        const data = await response.json()
        return { ok: true, status: response.status, data }
    } catch (err) {
        return { ok: false, status: 0, data: null }
    } finally {
        clearTimeout(timeout)
    }
}

function schematicsModDebug(message, payload){
    if(!SCHEMATICS_MOD_DEBUG || !loggerLanding){
        return
    }
    loggerLanding.info(`[schematics][mods] ${message}`, payload || {})
}

async function resolveModrinthProject(namespace){
    const slug = normalizeNamespace(namespace)
    if(!slug){
        return null
    }
    const direct = await fetchJsonWithTimeout(`${SCHEMATICS_MODRINTH_BASE}/project/${encodeURIComponent(slug)}`)
    if(direct.ok && direct.data?.id){
        schematicsModDebug('modrinth project resolved (direct).', { namespace: slug, projectId: direct.data.id })
        return direct.data
    }
    const facets = encodeURIComponent(JSON.stringify([['project_type:mod']]))
    const searchUrl = `${SCHEMATICS_MODRINTH_BASE}/search?query=${encodeURIComponent(slug)}&limit=8&index=relevance&facets=${facets}`
    const search = await fetchJsonWithTimeout(searchUrl)
    const hits = Array.isArray(search.data?.hits) ? search.data.hits : []
    if(hits.length === 0){
        schematicsModDebug('modrinth project search returned no hits.', { namespace: slug })
        return null
    }
    const exact = hits.find((hit) => normalizeNamespace(hit.slug) === slug)
    const compact = slug.replace(/[^a-z0-9]/g, '')
    const fuzzy = exact ? null : hits.find((hit) => normalizeNamespace(hit.slug).replace(/[^a-z0-9]/g, '') === compact)
    const hit = exact || fuzzy || hits[0]
    if(hit){
        schematicsModDebug('modrinth project resolved (search).', { namespace: slug, projectId: hit.project_id || hit.id, slug: hit.slug })
    }
    return hit ? { id: hit.project_id || hit.id, slug: hit.slug } : null
}

function buildModrinthVersionQuery(context){
    const params = []
    if(context?.loader){
        params.push(`loaders=${encodeURIComponent(JSON.stringify([context.loader]))}`)
    }
    if(context?.mcVersion){
        params.push(`game_versions=${encodeURIComponent(JSON.stringify([context.mcVersion]))}`)
    }
    return params.length ? `?${params.join('&')}` : ''
}

async function resolveModFromModrinth(namespace, context){
    const project = await resolveModrinthProject(namespace)
    if(!project?.id){
        return null
    }
    const versionUrl = `${SCHEMATICS_MODRINTH_BASE}/project/${project.id}/version${buildModrinthVersionQuery(context)}`
    const versions = await fetchJsonWithTimeout(versionUrl)
    let list = Array.isArray(versions.data) ? versions.data : []
    if(list.length === 0 && (context?.loader || context?.mcVersion)){
        schematicsModDebug('modrinth no versions for context; retrying without filters.', {
            namespace,
            projectId: project.id,
            context
        })
        const fallbackVersions = await fetchJsonWithTimeout(`${SCHEMATICS_MODRINTH_BASE}/project/${project.id}/version`)
        list = Array.isArray(fallbackVersions.data) ? fallbackVersions.data : []
    }
    if(list.length === 0){
        schematicsModDebug('modrinth no versions available.', { namespace, projectId: project.id })
        return null
    }
    list.sort((a, b) => {
        const da = new Date(a.date_published || 0).getTime()
        const db = new Date(b.date_published || 0).getTime()
        return db - da
    })
    const version = list[0]
    const files = Array.isArray(version.files) ? version.files : []
    if(files.length === 0){
        schematicsModDebug('modrinth version has no files.', { namespace, projectId: project.id, versionId: version.id })
        return null
    }
    const file = files.find((entry) => entry.primary) || files[0]
    schematicsModDebug('modrinth resolved version file.', {
        namespace,
        projectId: project.id,
        versionId: version.id,
        fileName: file.filename || null,
        url: file.url || null
    })
    return {
        source: 'modrinth',
        projectId: project.id,
        versionId: version.id,
        fileId: file.hashes?.sha1 || file.hashes?.sha512 || version.id,
        fileName: file.filename || file.url?.split('/').pop() || `${project.slug || namespace}.jar`,
        url: file.url,
        sha1: file.hashes?.sha1 || null
    }
}

async function resolveCurseForgeProject(namespace){
    if(!SCHEMATICS_CURSEFORGE_API_KEY){
        schematicsModDebug('curseforge api key missing; skipping.', { namespace })
        return null
    }
    const slug = normalizeNamespace(namespace)
    const url = `${SCHEMATICS_CURSEFORGE_BASE}/mods/search?gameId=432&searchFilter=${encodeURIComponent(slug)}&pageSize=8`
    const res = await fetchJsonWithTimeout(url, {
        headers: { 'x-api-key': SCHEMATICS_CURSEFORGE_API_KEY }
    })
    const items = Array.isArray(res.data?.data) ? res.data.data : []
    if(items.length === 0){
        schematicsModDebug('curseforge search returned no hits.', { namespace: slug })
        return null
    }
    const exact = items.find((item) => normalizeNamespace(item.slug) === slug)
    const chosen = exact || items[0]
    if(chosen){
        schematicsModDebug('curseforge project resolved.', { namespace: slug, projectId: chosen.id, slug: chosen.slug })
    }
    return chosen
}

function pickCurseForgeSha1(hashes){
    if(!Array.isArray(hashes)){
        return null
    }
    const entry = hashes.find((hash) => hash.algo === 1 || hash.algo === 'sha1' || hash.hashType === 1 || hash.hashType === 'sha1')
    return entry?.value || null
}

function matchesCurseForgeLoader(gameVersions, loader){
    if(!loader || !Array.isArray(gameVersions)){
        return true
    }
    const needle = loader.toLowerCase()
    return gameVersions.some((entry) => String(entry || '').toLowerCase().includes(needle))
}

async function resolveModFromCurseForge(namespace, context){
    const project = await resolveCurseForgeProject(namespace)
    if(!project?.id){
        return null
    }
    const versionParam = context?.mcVersion ? `?gameVersion=${encodeURIComponent(context.mcVersion)}` : ''
    const url = `${SCHEMATICS_CURSEFORGE_BASE}/mods/${project.id}/files${versionParam}`
    const res = await fetchJsonWithTimeout(url, {
        headers: { 'x-api-key': SCHEMATICS_CURSEFORGE_API_KEY }
    })
    const files = Array.isArray(res.data?.data) ? res.data.data : []
    if(files.length === 0){
        schematicsModDebug('curseforge no files for project.', { namespace, projectId: project.id, context })
        return null
    }
    files.sort((a, b) => new Date(b.fileDate || 0).getTime() - new Date(a.fileDate || 0).getTime())
    let candidate = files.find((file) => matchesCurseForgeLoader(file.gameVersions, context?.loader)) || files[0]
    if(!candidate?.downloadUrl){
        schematicsModDebug('curseforge file missing download url.', { namespace, projectId: project.id, fileId: candidate?.id || null })
        return null
    }
    schematicsModDebug('curseforge resolved file.', {
        namespace,
        projectId: project.id,
        fileId: candidate.id,
        fileName: candidate.fileName || null
    })
    return {
        source: 'curseforge',
        projectId: String(project.id),
        fileId: String(candidate.id),
        fileName: candidate.fileName || candidate.downloadUrl.split('/').pop(),
        url: candidate.downloadUrl,
        sha1: pickCurseForgeSha1(candidate.hashes)
    }
}

async function resolveModFromPlatform(namespace){
    const allowed = await ensureSchematicsModAssetsPermission()
    if(!allowed){
        schematicsModDebug('platform resolution blocked by user.', { namespace })
        return null
    }
    const context = await getSchematicsServerContext()
    schematicsModDebug('platform resolution context.', { namespace, context, providers: SCHEMATICS_PLATFORM_ORDER })
    const key = buildModResolutionKey(namespace, context)
    const cached = await getCachedModResolution(key)
    if(cached){
        schematicsModDebug('platform resolution cache hit.', { namespace, key, source: cached?.source || null })
        return cached
    }
    for(const provider of SCHEMATICS_PLATFORM_ORDER){
        let resolved = null
        if(provider === 'modrinth'){
            resolved = await resolveModFromModrinth(namespace, context)
        } else if(provider === 'curseforge'){
            resolved = await resolveModFromCurseForge(namespace, context)
        }
        if(resolved?.url){
            const payload = { ...resolved, resolvedAt: new Date().toISOString() }
            await setCachedModResolution(key, payload)
            schematicsModDebug('platform resolved.', { namespace, provider, url: resolved.url })
            return payload
        }
    }
    schematicsModDebug('platform resolution failed.', { namespace })
    return null
}

function extractModIdsFromText(content, regex){
    const ids = new Set()
    if(!content){
        return ids
    }
    let match
    while((match = regex.exec(content))){
        const value = normalizeNamespace(match[1])
        if(value){
            ids.add(value)
        }
    }
    return ids
}

function extractModIdsFromJar(jarPath){
    const ids = new Set()
    try {
        // eslint-disable-next-line global-require
        const AdmZip = require('adm-zip')
        const zip = new AdmZip(jarPath)
        const entries = zip.getEntries()
        for(const entry of entries){
            const name = entry.entryName
            if(name === 'META-INF/mods.toml'){
                const content = entry.getData().toString('utf8')
                const found = extractModIdsFromText(content, /modId\s*=\s*"(.*?)"/g)
                found.forEach((id) => ids.add(id))
            } else if(name === 'fabric.mod.json'){
                try {
                    const json = JSON.parse(entry.getData().toString('utf8'))
                    if(json?.id){
                        ids.add(normalizeNamespace(json.id))
                    }
                    if(Array.isArray(json?.provides)){
                        json.provides.forEach((id) => ids.add(normalizeNamespace(id)))
                    }
                } catch (err) {
                    // ignore parse errors
                }
            } else if(name === 'quilt.mod.json'){
                try {
                    const json = JSON.parse(entry.getData().toString('utf8'))
                    const ql = json?.quilt_loader
                    if(ql?.id){
                        ids.add(normalizeNamespace(ql.id))
                    }
                    if(Array.isArray(ql?.provides)){
                        ql.provides.forEach((id) => ids.add(normalizeNamespace(id)))
                    }
                } catch (err) {
                    // ignore parse errors
                }
            } else if(name === 'mcmod.info'){
                try {
                    const json = JSON.parse(entry.getData().toString('utf8'))
                    const list = Array.isArray(json) ? json : (Array.isArray(json?.modList) ? json.modList : [])
                    for(const item of list){
                        if(item?.modid){
                            ids.add(normalizeNamespace(item.modid))
                        }
                    }
                } catch (err) {
                    // ignore parse errors
                }
            }
        }
    } catch (err) {
        // ignore
    }
    return ids
}

async function loadSchematicsModsIndex(){
    if(schematicsModsIndexLoaded){
        return schematicsModsByNamespace
    }
    schematicsModsIndexLoaded = true
    schematicsModsByNamespace = new Map()
    try {
        if(!(await fs.pathExists(SCHEMATICS_MODS_JSON_PATH))){
            return schematicsModsByNamespace
        }
        const data = await fs.readJson(SCHEMATICS_MODS_JSON_PATH)
        const mods = Array.isArray(data?.mods) ? data.mods : []
        for(const entry of mods){
            if(!entry){
                continue
            }
            const source = String(entry.source || '').toLowerCase()
            const namespaces = []
            const direct = entry.namespace || entry.modId || entry.modid
            if(direct){
                namespaces.push(direct)
            }
            if(Array.isArray(entry.namespaces)){
                namespaces.push(...entry.namespaces)
            }
            const normalizedNamespaces = namespaces.map(normalizeNamespace).filter(Boolean)
            if(normalizedNamespaces.length === 0){
                loggerLanding.warn('[schematics] mods.json entry missing namespace/modId', {
                    name: entry.name || entry.projectId || entry.project || entry.project_id || entry.id || ''
                })
                continue
            }

            if(source === 'cursemaven'){
                const projectId = entry.projectId || entry.project || entry.project_id
                const fileId = entry.fileId || entry.file || entry.file_id
                if(!projectId || !fileId){
                    continue
                }
                const info = {
                    name: entry.name || '',
                    source: 'cursemaven',
                    projectId: String(projectId),
                    fileId: String(fileId),
                    sha1: entry.sha1 || entry.hash || null,
                    url: entry.url || null
                }
                for(const key of normalizedNamespaces){
                    schematicsModsByNamespace.set(key, info)
                }
                continue
            }

            if(source === 'modrinth'){
                const projectId = entry.projectId || entry.project || entry.project_id || entry.slug
                if(!projectId){
                    continue
                }
                const info = {
                    name: entry.name || '',
                    source: 'modrinth',
                    projectId: String(projectId),
                    versionId: entry.versionId || entry.version || null,
                    fileId: entry.fileId || entry.file || null,
                    fileName: entry.fileName || null,
                    url: entry.url || null,
                    sha1: entry.sha1 || entry.hash || null
                }
                for(const key of normalizedNamespaces){
                    schematicsModsByNamespace.set(key, info)
                }
            }
        }
    } catch (err) {
        loggerLanding.warn('[schematics] Failed to load mods.json.', err)
    }
    return schematicsModsByNamespace
}

async function getSchematicsModInfo(namespace){
    const key = normalizeNamespace(namespace)
    if(!key || key === 'minecraft'){
        return null
    }
    const index = await loadSchematicsModsIndex()
    return index.get(key) || null
}

function buildCurseMavenJarUrl(info){
    const base = SCHEMATICS_CURSE_MAVEN_BASE
    const projectId = encodeURIComponent(info.projectId)
    const fileId = encodeURIComponent(info.fileId)
    const fileName = `${info.projectId}-${info.fileId}.jar`
    return `${base}/${projectId}/${fileId}/${encodeURIComponent(fileName)}`
}

function getModJarCachePath(info){
    return pathUtil.join(SCHEMATICS_MOD_JAR_CACHE_DIR, `${info.projectId}-${info.fileId}.jar`)
}

function getOverrideJarCachePath(info){
    const projectId = String(info.projectId || info.slug || 'mod')
    const fileId = String(info.fileId || info.versionId || 'override')
    const name = sanitizeFileName(info.fileName || `${projectId}.jar`)
    return pathUtil.join(SCHEMATICS_MOD_JAR_CACHE_DIR, `override-${projectId}-${fileId}-${name}`)
}

async function ensureSchematicsModAssetsPermission(){
    const current = ConfigManager.getSchematicsModAssetsAutoDownload()
    if(current === true){
        return true
    }
    if(current === false){
        return false
    }
    const confirmed = window.confirm('This schematic uses modded blocks. Allow the launcher to download mod assets from Curse Maven for previews?')
    ConfigManager.setSchematicsModAssetsAutoDownload(confirmed)
    ConfigManager.save()
    return confirmed
}

async function computeFileSha1(filePath){
    const buffer = await fs.readFile(filePath)
    return crypto.createHash('sha1').update(buffer).digest('hex')
}

async function validateModJar(jarPath, namespace){
    try {
        const stat = await fs.stat(jarPath)
        if(!stat || stat.size <= 0){
            return false
        }
        // eslint-disable-next-line global-require
        const AdmZip = require('adm-zip')
        const zip = new AdmZip(jarPath)
        const entries = zip.getEntries()
        if(!entries || entries.length === 0){
            return false
        }
        const ns = normalizeNamespace(namespace)
        if(!ns){
            return true
        }
        const prefix = `assets/${ns}/`
        return entries.some((entry) => entry.entryName && entry.entryName.startsWith(prefix))
    } catch (err) {
        return false
    }
}

async function downloadModJarToPath(info, jarPath, namespace){
    let url = info.url
    if(info.source === 'modrinth'){
        const projectId = info.projectId
        if(!projectId){
            throw new Error('Modrinth override missing projectId.')
        }
        const encodedProject = encodeURIComponent(projectId)
        if(!url){
            if(info.versionId){
                url = `${SCHEMATICS_MODRINTH_BASE}/project/${encodedProject}/version/${encodeURIComponent(info.versionId)}`
            } else if(info.fileId){
                url = `${SCHEMATICS_MODRINTH_BASE}/project/${encodedProject}/version/${encodeURIComponent(info.fileId)}`
            } else {
                url = `${SCHEMATICS_MODRINTH_BASE}/project/${encodedProject}/version`
            }
        }
    } else {
        url = url || buildCurseMavenJarUrl(info)
    }
    schematicsModDebug('downloading mod jar.', { namespace, url, jarPath })
    try {
        if(info.source === 'modrinth' && url.includes('/project/')){
            const versionResponse = await fetchJsonWithTimeout(url)
            if(!versionResponse.ok || !versionResponse.data){
                throw new Error(`Modrinth version lookup failed (${versionResponse.status || 'unknown'})`)
            }
            let versionData = versionResponse.data
            if(Array.isArray(versionData)){
                if(versionData.length === 0){
                    throw new Error('Modrinth project has no versions.')
                }
                versionData.sort((a, b) => {
                    const da = new Date(a.date_published || 0).getTime()
                    const db = new Date(b.date_published || 0).getTime()
                    return db - da
                })
                versionData = versionData[0]
            }
            const files = Array.isArray(versionData?.files) ? versionData.files : []
            const file = files.find((entry) => entry.primary) || files[0]
            if(!file?.url){
                throw new Error('Modrinth version missing download url.')
            }
            if(!info.sha1 && file.hashes?.sha1){
                info.sha1 = file.hashes.sha1
            }
            url = file.url
        }
        await downloadFile(url, jarPath)
    } catch (err) {
        schematicsModDebug('mod jar download failed.', { namespace, url, error: err?.message || String(err) })
        try {
            await fs.remove(jarPath)
        } catch (removeErr) {
            // ignore
        }
        throw err
    }
    if(!(await validateModJar(jarPath, namespace))){
        schematicsModDebug('mod jar failed validation.', { namespace, jarPath })
        await fs.remove(jarPath)
        throw new Error(`Downloaded mod jar is invalid for namespace ${namespace}`)
    }
    if(info.sha1){
        const actual = await computeFileSha1(jarPath)
        if(actual !== String(info.sha1).toLowerCase()){
            schematicsModDebug('mod jar SHA1 mismatch.', { namespace, jarPath, expected: info.sha1, actual })
            await fs.remove(jarPath)
            throw new Error(`SHA1 mismatch for ${info.projectId || info.id || 'mod'}:${info.fileId || info.versionId || 'file'}`)
        }
    }
    return jarPath
}

async function downloadModJarForNamespace(namespace){
    const key = normalizeNamespace(namespace)
    if(!key || key === 'minecraft'){
        return null
    }
    if(schematicsModJarCache.has(key)){
        return schematicsModJarCache.get(key)
    }
    if(schematicsModJarFailures.has(key)){
        return null
    }
    const existingDownload = schematicsModDownloads.get(key)
    if(existingDownload){
        return existingDownload
    }

    const downloadPromise = (async () => {
        const candidates = []
        const primary = await getSchematicsModInfo(key)
        if(primary){
            const jarPath = primary.source === 'modrinth'
                ? getOverrideJarCachePath(primary)
                : getModJarCachePath(primary)
            candidates.push({
                label: 'mods.json',
                info: primary,
                jarPath
            })
            const platformInfo = await resolveModFromPlatform(key)
            if(platformInfo){
                candidates.push({
                    label: platformInfo.source || 'platform',
                    info: platformInfo,
                    jarPath: getPlatformJarCachePath(platformInfo)
                })
            }
        } else {
            const platformInfo = await resolveModFromPlatform(key)
            if(platformInfo){
                candidates.push({
                    label: platformInfo.source || 'platform',
                    info: platformInfo,
                    jarPath: getPlatformJarCachePath(platformInfo)
                })
            }
        }
        schematicsModDebug('mod jar candidates prepared.', {
            namespace: key,
            candidates: candidates.map((entry) => ({ label: entry.label, jarPath: entry.jarPath, source: entry.info?.source || null }))
        })
        if(candidates.length === 0){
            if(ConfigManager.getSchematicsModAssetsAutoDownload() !== false){
                schematicsModJarFailures.add(key)
            }
            return null
        }

        await fs.ensureDir(SCHEMATICS_MOD_JAR_CACHE_DIR)
        const allowed = await ensureSchematicsModAssetsPermission()
        if(!allowed){
            return null
        }

        for(const candidate of candidates){
            const { info, jarPath, label } = candidate
            if(await fs.pathExists(jarPath)){
                if(await validateModJar(jarPath, key)){
                    schematicsModJarCache.set(key, jarPath)
                    return jarPath
                }
                await fs.remove(jarPath)
            }
            try {
                await downloadModJarToPath(info, jarPath, key)
                const modIds = extractModIdsFromJar(jarPath)
                if(modIds.size > 0 && !modIds.has(key)){
                    await fs.remove(jarPath)
                    throw new Error(`Downloaded mod jar does not match namespace ${key}`)
                }
                schematicsModJarCache.set(key, jarPath)
                schematicsRemoteAssetsRevision += 1
                schematicsTextureAtlas = null
                schematicsTextureAtlasCache.clear()
                return jarPath
            } catch (err) {
                loggerLanding.warn(`[schematics] Mod jar download failed (${label}) for ${key}.`, err)
            }
        }

        if(ConfigManager.getSchematicsModAssetsAutoDownload() !== false){
            schematicsModJarFailures.add(key)
        }
        return null
    })()

    schematicsModDownloads.set(key, downloadPromise)
    try {
        return await downloadPromise
    } catch (err) {
        loggerLanding.warn('[schematics] Failed to download mod assets.', err)
        schematicsModJarFailures.add(key)
        return null
    } finally {
        schematicsModDownloads.delete(key)
    }
}

class RemoteJarResourceProvider {
    constructor(){
        this.jarProviders = new Map()
        this.failedNamespaces = new Set()
    }

    async getProviderForNamespace(namespace){
        const key = normalizeNamespace(namespace)
        if(!key || key === 'minecraft'){
            return null
        }
        if(this.jarProviders.has(key)){
            const existing = this.jarProviders.get(key)
            if(existing?.jarPath && !(await validateModJar(existing.jarPath, key))){
                this.jarProviders.delete(key)
            } else {
                return existing
            }
        }
        if(this.failedNamespaces.has(key)){
            return null
        }
        const jarPath = await downloadModJarForNamespace(key)
        if(!jarPath){
            if(schematicsModJarFailures.has(key)){
                this.failedNamespaces.add(key)
            }
            return null
        }
        try {
            const provider = new JarResourceProvider(jarPath)
            this.jarProviders.set(key, provider)
            return provider
        } catch (err) {
            loggerLanding.warn('[schematics] Failed to open mod jar.', err)
            this.failedNamespaces.add(key)
            return null
        }
    }

    async getBuffer(resourcePath){
        const namespace = extractNamespaceFromResourcePath(resourcePath)
        if(!namespace){
            return null
        }
        const provider = await this.getProviderForNamespace(namespace)
        if(!provider){
            return null
        }
        try {
            return provider.getBuffer(resourcePath)
        } catch (err) {
            loggerLanding.warn('[schematics] Failed to read mod asset.', err)
            this.failedNamespaces.add(namespace)
            return null
        }
    }

    async getText(resourcePath){
        const buf = await this.getBuffer(resourcePath)
        return buf ? buf.toString('utf8') : null
    }

    async getJson(resourcePath){
        const text = await this.getText(resourcePath)
        if(!text){
            return null
        }
        try {
            return JSON.parse(text)
        } catch (err) {
            return null
        }
    }
}

async function buildSchematicsResourceStack(){
    try {
        await rebuildSchematicsCacheIfNeeded()
        const distro = await DistroAPI.getDistribution()
        const server = distro?.getServerById(ConfigManager.getSelectedServer())
        const serverId = server?.rawServer?.id || 'default'
        const mcVersion = server?.rawServer?.minecraftVersion
        const cacheKey = `${serverId}:${mcVersion || 'unknown'}`
        if(schematicsResourceStack && schematicsResourceStackKey === cacheKey){
            return schematicsResourceStack
        }

        const providers = []
        const sourceEntries = []
        const instanceDir = pathUtil.join(ConfigManager.getInstanceDirectory(), serverId)

        const resourcepacksDir = pathUtil.join(instanceDir, 'resourcepacks')
        if(await fs.pathExists(resourcepacksDir)){
            const entries = await fs.readdir(resourcepacksDir, { withFileTypes: true })
            for(const entry of entries){
                const entryPath = pathUtil.join(resourcepacksDir, entry.name)
                if(entry.isDirectory()){
                    providers.push(new DirectoryResourceProvider(entryPath))
                    sourceEntries.push({ type: 'dir', path: entryPath })
                } else if(entry.isFile() && (entry.name.endsWith('.zip') || entry.name.endsWith('.jar'))){
                    providers.push(new JarResourceProvider(entryPath))
                    sourceEntries.push({ type: 'jar', path: entryPath })
                }
            }
        }

        const modsDir = pathUtil.join(instanceDir, 'mods')
        if(await fs.pathExists(modsDir)){
            const entries = await fs.readdir(modsDir, { withFileTypes: true })
            for(const entry of entries){
                if(entry.isFile() && entry.name.endsWith('.jar')){
                    const modPath = pathUtil.join(modsDir, entry.name)
                    providers.push(new JarResourceProvider(modPath))
                    sourceEntries.push({ type: 'jar', path: modPath })
                }
            }
        }

        if(!schematicsRemoteModProvider){
            schematicsRemoteModProvider = new RemoteJarResourceProvider()
        }
        providers.push(schematicsRemoteModProvider)
        sourceEntries.push({ type: 'mods-json', path: SCHEMATICS_MODS_JSON_PATH })

        if(mcVersion){
            const versionJar = pathUtil.join(ConfigManager.getCommonDirectory(), 'versions', mcVersion, `${mcVersion}.jar`)
            if(await fs.pathExists(versionJar)){
                providers.push(new JarResourceProvider(versionJar))
                sourceEntries.push({ type: 'jar', path: versionJar })
            }
        }

        const signature = await computeResourceStackSignature(sourceEntries, cacheKey)
        if(schematicsResourceStackKey && schematicsResourceStackKey !== signature){
            resetSchematicsResourceCaches()
        }
        schematicsResourceStack = createResourceStack(providers)
        schematicsResourceStackKey = signature
        return schematicsResourceStack
    } catch (err) {
        loggerLanding.warn('Failed to build schematics resource stack.', err)
        schematicsResourceStack = null
        schematicsResourceStackKey = null
        return null
    }
}

async function computeResourceStackSignature(entries, cacheKey){
    const payload = []
    for(const entry of entries){
        try {
            const stat = await fs.stat(entry.path)
            payload.push({
                type: entry.type,
                path: entry.path,
                size: stat.size,
                mtime: stat.mtimeMs
            })
        } catch (err) {
            payload.push({
                type: entry.type,
                path: entry.path,
                size: 0,
                mtime: 0
            })
        }
    }
    const base = JSON.stringify({ cacheKey, entries: payload })
    return crypto.createHash('sha1').update(base).digest('hex')
}

function resetSchematicsResourceCaches(){
    schematicsTextureAtlas = null
    schematicsTextureAtlasCache.clear()
    schematicsTextureAlphaCache.clear()
    schematicsLangNamespaceCache.clear()
    schematicsBlockDisplayNameCache.clear()
    schematicsRemoteAssetsRevision += 1
    schematicsModJarCache.clear()
    schematicsModJarFailures.clear()
    schematicsModDownloads.clear()
    schematicsModResolutionCache.clear()
    schematicsModResolutionLoaded = false
    if(schematicsRemoteModProvider){
        if(schematicsRemoteModProvider.jarProviders){
            schematicsRemoteModProvider.jarProviders.clear()
        }
        if(schematicsRemoteModProvider.failedNamespaces){
            schematicsRemoteModProvider.failedNamespaces.clear()
        }
    }
    schematicsRuntimeRegistry = {
        blockstates: { ...(schematicRegistryBase.blockstates || {}) },
        models: { ...(schematicRegistryBase.models || {}) }
    }
    schematicsLoadedBlockstates = new Set(Object.keys(schematicsRuntimeRegistry.blockstates))
    schematicsLoadedModels = new Set(Object.keys(schematicsRuntimeRegistry.models))
}

async function rebuildSchematicsCacheIfNeeded(){
    if(!SCHEMATICS_REBUILD_CACHE || schematicsCacheRebuildDone){
        return
    }
    schematicsCacheRebuildDone = true
    try {
        await fs.remove(SCHEMATICS_ATLAS_CACHE_DIR)
        await fs.remove(SCHEMATICS_INDEX_PATH)
        await fs.remove(SCHEMATICS_MOD_JAR_CACHE_DIR)
        await fs.remove(SCHEMATICS_MOD_RESOLUTION_PATH)
        resetSchematicsResourceCaches()
        loggerLanding.info('Schematics cache rebuild requested. Atlas and mod cache cleared.')
    } catch (err) {
        loggerLanding.warn('Failed to clear schematics cache.', err)
    }
}

function collectModelIdsFromBlockstate(blockstate){
    const ids = new Set()
    if(blockstate?.variants){
        Object.values(blockstate.variants).forEach((variant) => {
            extractModelIds(variant, ids)
        })
    }
    if(Array.isArray(blockstate?.multipart)){
        blockstate.multipart.forEach((part) => {
            extractModelIds(part?.apply, ids)
        })
    }
    if(ids.size === 0){
        ids.add('block/cube_all')
    }
    return Array.from(ids)
}

function extractModelIds(apply, set){
    if(!apply){
        return
    }
    if(Array.isArray(apply)){
        apply.forEach((item) => extractModelIds(item, set))
        return
    }
    if(typeof apply === 'string'){
        set.add(apply)
        return
    }
    if(typeof apply === 'object' && typeof apply.model === 'string'){
        set.add(apply.model)
    }
}

const schematicsModelLoadPromises = new Map()

async function ensureModelLoaded(modelId, stack){
    if(!modelId){
        return
    }
    const { namespace, path } = splitResourceId(modelId)
    if(!path){
        return
    }
    const normalizedId = modelId.includes(':') ? modelId : `${namespace}:${path}`
    if(schematicsLoadedModels.has(modelId) || schematicsLoadedModels.has(normalizedId)){
        return
    }
    if(schematicsModelLoadPromises.has(normalizedId)){
        await schematicsModelLoadPromises.get(normalizedId)
        return
    }
    const loadPromise = (async () => {
        const model = await loadModel(stack, namespace, path)
        if(!model){
            return
        }
        schematicsRuntimeRegistry.models[modelId] = model
        if(!schematicsRuntimeRegistry.models[normalizedId]){
            schematicsRuntimeRegistry.models[normalizedId] = model
        }
        schematicsLoadedModels.add(modelId)
        schematicsLoadedModels.add(normalizedId)
        if(model.parent){
            await ensureModelLoaded(model.parent, stack)
        }
    })().finally(() => {
        schematicsModelLoadPromises.delete(normalizedId)
    })
    schematicsModelLoadPromises.set(normalizedId, loadPromise)
    await loadPromise
}

async function ensureRegistryForSchematic(schematic, resourceStack = null){
    if(!schematic || !Array.isArray(schematic.palette)){
        return
    }
    const stack = resourceStack || await buildSchematicsResourceStack()
    if(!stack){
        return
    }
    const paletteBlockIds = Array.from(new Set(
        schematic.palette
            .map(entry => entry?.block)
            .filter(Boolean)
    ))
    const modelIdsToLoad = new Set()

    await Promise.all(paletteBlockIds.map(async (blockId) => {
        const { namespace, path } = splitResourceId(blockId)
        if(!path){
            return
        }
        let blockstate = null
        try {
            blockstate = await loadBlockstate(stack, namespace, path)
        } catch (err) {
            blockstate = null
        }
        if(!blockstate && namespace !== 'minecraft'){
            const jarPath = await downloadModJarForNamespace(namespace)
            if(jarPath){
                try {
                    blockstate = await loadBlockstate(stack, namespace, path)
                } catch (err) {
                    blockstate = null
                }
            }
        }
        if(blockstate){
            schematicsRuntimeRegistry.blockstates[blockId] = blockstate
            schematicsLoadedBlockstates.add(blockId)
        } else if(!schematicsRuntimeRegistry.blockstates[blockId]) {
            return
        }
        const activeBlockstate = blockstate || schematicsRuntimeRegistry.blockstates[blockId]
        collectModelIdsFromBlockstate(activeBlockstate).forEach(modelId => modelIdsToLoad.add(modelId))
    }))

    await Promise.all(Array.from(modelIdsToLoad).map(modelId => ensureModelLoaded(modelId, stack)))
}

function resolveTextureIdParts(textureId){
    return splitResourceId(textureId, 'minecraft')
}

function buildAtlasKey(ids){
    return `v${SCHEMATICS_ATLAS_CACHE_VERSION}|${schematicsResourceStackKey || 'default'}|r${schematicsRemoteAssetsRevision}|${ids.slice().sort().join('|')}`
}

function getAtlasCacheKeyHash(key){
    return crypto.createHash('sha1').update(key).digest('hex')
}

function getAtlasCachePaths(key){
    const hash = getAtlasCacheKeyHash(key)
    return {
        hash,
        imagePath: pathUtil.join(SCHEMATICS_ATLAS_CACHE_DIR, `${hash}.png`),
        metaPath: pathUtil.join(SCHEMATICS_ATLAS_CACHE_DIR, `${hash}.json`)
    }
}

function getTextureAlphaMode(textureId){
    if(!textureId){
        return 'opaque'
    }
    if(schematicsTextureAlphaCache.has(textureId)){
        const cached = schematicsTextureAlphaCache.get(textureId)
        schematicsTextureAlphaCache.delete(textureId)
        schematicsTextureAlphaCache.set(textureId, cached)
        return cached
    }
    const id = String(textureId).toLowerCase()
    if(id.includes('glass') || id.includes('ice') || id.includes('water') || id.includes('lava') || id.includes('portal') || id.includes('slime') || id.includes('honey')){
        return 'translucent'
    }
    if(id.includes('leaves') || id.includes('vines') || id.includes('sapling') || id.includes('grass') || id.includes('fern')){
        return 'cutout'
    }
    return 'opaque'
}

function setTextureAlphaMode(textureId, mode){
    if(!textureId){
        return
    }
    schematicsTextureAlphaCache.set(textureId, mode)
    if(schematicsTextureAlphaCache.size > SCHEMATICS_ALPHA_CACHE_LIMIT){
        const firstKey = schematicsTextureAlphaCache.keys().next().value
        schematicsTextureAlphaCache.delete(firstKey)
    }
}

function analyzeTextureAlphaMode(image){
    if(!image){
        return 'opaque'
    }
    const size = 32
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, size, size)
    ctx.drawImage(image, 0, 0, size, size)
    const data = ctx.getImageData(0, 0, size, size).data
    let transparent = 0
    let semi = 0
    const total = size * size
    for(let i=0; i<data.length; i+=4){
        const a = data[i + 3]
        if(a === 0){
            transparent++
        } else if(a < 255){
            semi++
        }
    }
    if(semi > 0){
        return 'translucent'
    }
    if(transparent > total * 0.02){
        return 'cutout'
    }
    return 'opaque'
}

async function loadImageFromBuffer(buffer){
    if(!buffer){
        return null
    }
    if(typeof createImageBitmap === 'function'){
        const blob = new Blob([buffer], { type: 'image/png' })
        return createImageBitmap(blob)
    }
    return new Promise((resolve) => {
        const blob = new Blob([buffer], { type: 'image/png' })
        const url = URL.createObjectURL(blob)
        const img = new Image()
        img.onload = () => {
            URL.revokeObjectURL(url)
            resolve(img)
        }
        img.onerror = () => {
            URL.revokeObjectURL(url)
            resolve(null)
        }
        img.src = url
    })
}

async function buildTextureAtlas(textureIds, { skipAlphaAnalysis = false } = {}){
    if(!Array.isArray(textureIds) || textureIds.length === 0){
        schematicsTextureAtlas = null
        return null
    }
    const stack = await buildSchematicsResourceStack()
    if(!stack){
        schematicsTextureAtlas = null
        return null
    }
    const key = buildAtlasKey(textureIds)
    if(schematicsTextureAtlasCache.has(key)){
        const cached = schematicsTextureAtlasCache.get(key)
        schematicsTextureAtlasCache.delete(key)
        schematicsTextureAtlasCache.set(key, cached)
        schematicsTextureAtlas = cached
        return cached
    }
    if(skipAlphaAnalysis && schematicsTextureAtlas?.key === key){
        return schematicsTextureAtlas
    }

    const { imagePath, metaPath } = getAtlasCachePaths(key)
    await fs.ensureDir(SCHEMATICS_ATLAS_CACHE_DIR)
    if(await fs.pathExists(imagePath) && await fs.pathExists(metaPath)){
        try {
            const meta = await fs.readJson(metaPath)
            const buffer = await fs.readFile(imagePath)
            const image = await loadImageFromBuffer(buffer)
            if(image && meta?.mapping){
                const canvas = document.createElement('canvas')
                canvas.width = image.width
                canvas.height = image.height
                const ctx = canvas.getContext('2d')
                ctx.imageSmoothingEnabled = false
                ctx.drawImage(image, 0, 0)
                const atlas = { key, canvas, mapping: meta.mapping }
                schematicsTextureAtlas = atlas
                schematicsTextureAtlasCache.set(key, atlas)
                try {
                    await touchAtlasCacheFiles(imagePath, metaPath)
                } catch (err) {
                    loggerLanding.warn('Failed to touch atlas cache.', err)
                }
                return atlas
            }
        } catch (err) {
            loggerLanding.warn('Failed to load atlas cache.', err)
        }
    }

    const size = 16
    const padding = 1
    const cell = size + padding * 2
    const columns = Math.ceil(Math.sqrt(textureIds.length))
    const rows = Math.ceil(textureIds.length / columns)
    const canvas = document.createElement('canvas')
    canvas.width = columns * cell
    canvas.height = rows * cell
    const ctx = canvas.getContext('2d')
    ctx.imageSmoothingEnabled = false

    const mapping = {}
    for(let i=0; i<textureIds.length; i++){
        const textureId = textureIds[i]
        const col = i % columns
        const row = Math.floor(i / columns)
        const x = col * cell
        const y = row * cell
        const drawX = x + padding
        const drawY = y + padding

        const { namespace, path } = resolveTextureIdParts(textureId)
        let buffer = await loadTexture(stack, namespace, path)
        let image = await loadImageFromBuffer(buffer)
        if(!image && namespace !== 'minecraft'){
            const jarPath = await downloadModJarForNamespace(namespace)
            if(jarPath){
                buffer = await loadTexture(stack, namespace, path)
                image = await loadImageFromBuffer(buffer)
            }
        }
        if(image){
            let source = image
            if(image.height > image.width && image.height % image.width === 0){
                const frameSize = image.width
                const frameCanvas = document.createElement('canvas')
                frameCanvas.width = frameSize
                frameCanvas.height = frameSize
                const frameCtx = frameCanvas.getContext('2d')
                frameCtx.imageSmoothingEnabled = false
                frameCtx.drawImage(image, 0, 0, frameSize, frameSize, 0, 0, frameSize, frameSize)
                source = frameCanvas
            }
            ctx.drawImage(source, drawX, drawY, size, size)
            if(!skipAlphaAnalysis){
                const alphaMode = analyzeTextureAlphaMode(source)
                setTextureAlphaMode(textureId, alphaMode)
            }
        } else {
            ctx.fillStyle = 'rgba(255, 0, 255, 0.8)'
            ctx.fillRect(drawX, drawY, size, size)
            setTextureAlphaMode(textureId, 'cutout')
        }
        mapping[textureId] = {
            u0: drawX / canvas.width,
            v0: drawY / canvas.height,
            u1: (drawX + size) / canvas.width,
            v1: (drawY + size) / canvas.height,
            alphaMode: getTextureAlphaMode(textureId)
        }
    }

    const atlas = { key, canvas, mapping }
    schematicsTextureAtlas = atlas
    schematicsTextureAtlasCache.set(key, atlas)
    if(schematicsTextureAtlasCache.size > SCHEMATICS_ATLAS_CACHE_LIMIT){
        const firstKey = schematicsTextureAtlasCache.keys().next().value
        schematicsTextureAtlasCache.delete(firstKey)
    }
    try {
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
        if(!blob){
            throw new Error('Atlas encode failed.')
        }
        const arrayBuffer = await blob.arrayBuffer()
        const buffer = Buffer.from(arrayBuffer)
        await fs.writeFile(imagePath, buffer)
        await fs.writeJson(metaPath, { mapping }, { spaces: 0 })
        await touchAtlasCacheFiles(imagePath, metaPath)
        await evictAtlasCacheFiles()
    } catch (err) {
        loggerLanding.warn('Failed to persist atlas cache.', err)
    }
    return atlas
}

async function touchAtlasCacheFiles(imagePath, metaPath){
    const now = new Date()
    await fs.utimes(imagePath, now, now)
    await fs.utimes(metaPath, now, now)
}

async function evictAtlasCacheFiles(){
    try {
        const entries = await fs.readdir(SCHEMATICS_ATLAS_CACHE_DIR, { withFileTypes: true })
        const files = entries
            .filter(entry => entry.isFile() && (entry.name.endsWith('.png') || entry.name.endsWith('.json')))
            .map(entry => ({
                name: entry.name,
                path: pathUtil.join(SCHEMATICS_ATLAS_CACHE_DIR, entry.name)
            }))
        if(files.length <= SCHEMATICS_ATLAS_DISK_LIMIT * 2){
            return
        }
        const stats = await Promise.all(files.map(async (file) => {
            const stat = await fs.stat(file.path)
            return { ...file, mtime: stat.mtimeMs }
        }))
        const groups = new Map()
        for(const file of stats){
            const base = file.name.replace(/\\.(png|json)$/i, '')
            const group = groups.get(base) || []
            group.push(file)
            groups.set(base, group)
        }
        const groupList = Array.from(groups.values()).map((group) => {
            const newest = Math.max(...group.map(entry => entry.mtime))
            return { group, newest }
        })
        groupList.sort((a, b) => b.newest - a.newest)
        const keep = groupList.slice(0, SCHEMATICS_ATLAS_DISK_LIMIT)
        const keepNames = new Set()
        keep.forEach(entry => {
            entry.group.forEach(file => keepNames.add(file.name))
        })
        for(const file of stats){
            if(!keepNames.has(file.name)){
                await fs.unlink(file.path)
            }
        }
    } catch (err) {
        loggerLanding.warn('Failed to evict atlas cache files.', err)
    }
}

async function prepareTextureAtlasForSchematic(schematic, { skipAlphaAnalysis = false, preferExisting = false } = {}){
    if(!schematic){
        return null
    }
    const textureIds = Array.from(collectTextureIdsForSchematic(schematic, schematicsRuntimeRegistry))
    if(textureIds.length === 0){
        schematicsTextureAtlas = null
        return null
    }
    if(preferExisting && schematicsTextureAtlas?.key){
        const key = buildAtlasKey(textureIds)
        if(schematicsTextureAtlas.key === key){
            return schematicsTextureAtlas
        }
    }
    return buildTextureAtlas(textureIds, { skipAlphaAnalysis })
}

function updateSchematicIndex(entries){
    const incomingById = new Map(entries.filter(entry => entry?.id).map(entry => [entry.id, entry]))
    const incomingIds = new Set(incomingById.keys())
    for(const [id, current] of SCHEMATIC_INDEX){
        const incoming = incomingById.get(id)
        if(!incoming || incoming.revision?.sha256 !== current.revision?.sha256){
            SCHEMATIC_NORMALIZED_CACHE.delete(id)
            SCHEMATIC_DETAIL_CACHE.delete(id)
        }
    }
    for(const id of SCHEMATIC_NORMALIZED_CACHE.keys()){
        if(!incomingIds.has(id)) SCHEMATIC_NORMALIZED_CACHE.delete(id)
    }
    SCHEMATIC_INDEX.clear()
    entries.forEach(entry => {
        if(entry?.id){
            SCHEMATIC_INDEX.set(entry.id, entry)
        }
    })
}

async function loadSchematicsInstallIndex(){
    try {
        schematicsInstallManager = new SchematicInstallManager({
            instanceDirectory: ConfigManager.getInstanceDirectory(),
            launcherDirectory: ConfigManager.getLauncherDirectory(),
            core: schematicsFormatCore
        })
        schematicsInstallIndex = new Map(schematicsInstallManager.index.map(item => [item.key, item]))
        renderSchematics()
    } catch (err) {
        loggerLanding.warn('Failed to load schematics install index.', err)
        schematicsInstallIndex = new Map()
    }
}

async function saveSchematicsInstallIndex(){
    try {
        if(schematicsInstallManager){
            schematicsInstallManager.index = Array.from(schematicsInstallIndex.values())
            schematicsInstallManager.saveIndex()
        }
    } catch (err) {
        loggerLanding.warn('Failed to save schematics install index.', err)
    }
}

function renderInstalledList(){
    if(!schematicsInstalledList){
        return
    }
    schematicsInstalledList.innerHTML = ''
    const account = ConfigManager.getSelectedAccount()
    const profileId = ConfigManager.getSelectedServer()
    const items = Array.from(schematicsInstallIndex.values()).filter(item =>
        item.profileId === profileId && account?.uuid && item.playerUuid === schematicsFormatCore.normalizeUuid(account.uuid)
    )
    if(items.length === 0){
        const empty = document.createElement('div')
        empty.className = 'schematicsGridMessage'
        empty.textContent = 'No schematics installed yet.'
        schematicsInstalledList.appendChild(empty)
        return
    }
    items.sort((a, b) => new Date(b.installedAt).getTime() - new Date(a.installedAt).getTime())
    for(const item of items){
        const row = document.createElement('div')
        row.className = 'schematicsInstalledItem'

        const meta = document.createElement('div')
        meta.className = 'schematicsInstalledMeta'

        const name = document.createElement('div')
        name.className = 'schematicsInstalledName'
        name.textContent = item.name || 'Schematic'

        const date = document.createElement('div')
        date.className = 'schematicsInstalledDate'
        date.textContent = item.installedAt ? new Date(item.installedAt).toLocaleDateString('en-US') : '--'

        meta.appendChild(name)
        meta.appendChild(date)

        const remove = document.createElement('button')
        remove.type = 'button'
        remove.className = 'schematicsMiniButton'
        remove.textContent = 'Remove'
        remove.addEventListener('click', () => {
            removeInstalledSchematic({ id: item.schematicId })
            renderInstalledList()
        })

        row.appendChild(meta)
        row.appendChild(remove)
        schematicsInstalledList.appendChild(row)
    }
}

let schematicsInstalledOpen = false

function openInstalledPanel(){
    if(!schematicsInstalledPanel){
        return
    }
    renderInstalledList()
    schematicsInstalledOpen = true
    schematicsInstalledPanel.setAttribute('data-open', 'true')
    schematicsInstalledPanel.setAttribute('aria-hidden', 'false')
}

function closeInstalledPanel(){
    if(!schematicsInstalledPanel){
        return
    }
    schematicsInstalledOpen = false
    schematicsInstalledPanel.removeAttribute('data-open')
    schematicsInstalledPanel.setAttribute('aria-hidden', 'true')
}

function getInstalledSchematic(id){
    const account = ConfigManager.getSelectedAccount()
    const profileId = ConfigManager.getSelectedServer()
    if(!schematicsInstallManager || !account?.uuid || !profileId || !id) return null
    try {
        return schematicsInstallManager.get(profileId, account.uuid, id)
    } catch(_err) {
        return null
    }
}

async function resolveSchematicInstallContext(){
    const account = ConfigManager.getSelectedAccount()
    const profileId = ConfigManager.getSelectedServer()
    if(!account?.uuid) throw new Error('Select a Microsoft account before installing a schematic.')
    if(!profileId) throw new Error('Select a Cobble Power profile before installing a schematic.')
    const distro = await DistroAPI.getDistribution()
    const profile = distro?.getServerById(profileId)
    if(!profile || !moduleContainsCobblePower(profile.modules)){
        throw new Error('The selected profile does not contain Cobble Power.')
    }
    if(!schematicsInstallManager) await loadSchematicsInstallIndex()
    return { account, profileId, profile }
}

function updateInstallButtonState(entry){
    if(!schematicsDetailInstall){
        return
    }
    const account = ConfigManager.getSelectedAccount()
    const profileId = ConfigManager.getSelectedServer()
    const installed = entry?.id ? getInstalledSchematic(entry.id) : null
    const state = installed && schematicsInstallManager
        ? schematicsInstallManager.status(profileId, account.uuid, entry).state
        : 'install'
    schematicsDetailInstall.disabled = !account?.uuid || !profileId
    if(state === 'installed'){
        schematicsDetailInstall.textContent = 'Installed'
        schematicsDetailInstall.classList.add('is-installed')
        if(schematicsDetailRemove){
            schematicsDetailRemove.style.display = 'inline-flex'
        }
    } else {
        schematicsDetailInstall.textContent = state === 'update' ? 'Update available' : (state === 'repair' ? 'Repair install' : 'Install')
        schematicsDetailInstall.classList.remove('is-installed')
        if(schematicsDetailRemove){
            schematicsDetailRemove.style.display = installed ? 'inline-flex' : 'none'
        }
    }
}

async function installSchematicLegacy(entry){
    if(!entry || !entry.id || !schematicsDetailInstall){
        return
    }
    const existing = getInstalledSchematic(entry.id)
    if(existing){
        return
    }
    schematicsDetailInstall.disabled = true
    schematicsDetailInstall.textContent = 'Downloading...'

    try {
        let schematic = entry.schematic
        if(!schematic){
            const base = await resolveSchematicsApiBase()
            if(!base){
                throw new Error('Schematics service not configured.')
            }
            await ensureSchematicsAuthSession(base)
            const response = await fetch(`${base.replace(/\/+$/, '')}/v1/schematics/${encodeURIComponent(entry.id)}/download`, {
                method: 'GET',
                headers: { 'Accept': 'application/json', ...getSchematicsAuthHeaders() }
            })
            if(!response.ok){
                throw new Error(`HTTP ${response.status}`)
            }
            schematic = await response.json()
        }
        if(!schematic){
            throw new Error('No schematic data available.')
        }
        try {
            const { schematic: normalized } = await normalizeJsonSchematic(schematic, {})
            if(entry.hash && normalized?.meta?.hash && entry.hash !== normalized.meta.hash){
                throw new Error('Schematic hash mismatch.')
            }
            if(Number.isFinite(Number(entry.blockCount)) && normalized?.meta?.blockCount != null && Number(entry.blockCount) !== Number(normalized.meta.blockCount)){
                loggerLanding.warn('Schematic block count mismatch.', {
                    entryBlockCount: entry.blockCount,
                    normalizedBlockCount: normalized.meta.blockCount
                })
            }
        } catch (err) {
            loggerLanding.warn('Schematic integrity check failed.', err)
            throw err
        }

        await fs.ensureDir(SCHEMATICS_INSTALL_DIR)
        const filePath = pathUtil.join(SCHEMATICS_INSTALL_DIR, `${entry.id}.json`)
        await fs.writeJson(filePath, schematic, { spaces: 2 })
        schematicsInstallIndex.set(entry.id, {
            id: entry.id,
            name: entry.name || schematic.name || 'Schematic',
            filePath,
            installedAt: new Date().toISOString()
        })
        await saveSchematicsInstallIndex()
        schematicsDetailInstall.textContent = 'Installed'
        schematicsDetailInstall.classList.add('is-installed')
        renderSchematics()
    } catch (err) {
        loggerLanding.warn('Failed to install schematic.', err)
        schematicsDetailInstall.textContent = 'Install Failed'
        setTimeout(() => updateInstallButtonState(entry), 1200)
    } finally {
        schematicsDetailInstall.disabled = false
    }
}

async function installSchematic(entry){
    if(!entry?.id || !schematicsDetailInstall) return
    schematicsDetailInstall.disabled = true
    schematicsDetailInstall.textContent = 'Downloading...'
    try {
        const context = await resolveSchematicInstallContext()
        const detail = entry.revision ? entry : (await fetchSchematicDetail(entry.id) || entry)
        if(!detail.revision?.sha256) throw new Error('The schematic revision metadata is missing.')
        const canonical = await schematicApiRequest(`/v1/schematics/${encodeURIComponent(entry.id)}/download`, {
            method: 'GET',
            headers: { Accept: 'application/json' }
        })
        const record = schematicsInstallManager.install({
            profileId: context.profileId,
            playerUuid: context.account.uuid,
            entry: detail,
            canonical,
            confirmModified: filePath => window.confirm(`This schematic was modified locally:\n${filePath}\n\nReplace it with the community revision?`)
        })
        schematicsInstallIndex.set(record.key, record)
        updateInstallButtonState(detail)
        renderSchematics()
    } catch(err) {
        loggerLanding.warn('Failed to install schematic.', { message: String(err?.message || err).replace(/https?:\/\/[^\s]+/g, '[redacted-url]') })
        schematicsDetailInstall.textContent = err?.code === 'locally_modified' ? 'Local changes kept' : 'Install failed'
        setTimeout(() => updateInstallButtonState(entry), 1500)
    } finally {
        schematicsDetailInstall.disabled = false
    }
}

async function removeInstalledSchematicLegacy(entry){
    if(!entry?.id){
        return
    }
    const installed = getInstalledSchematic(entry.id)
    if(!installed){
        return
    }
    try {
        if(installed.filePath){
            await fs.remove(installed.filePath)
        }
        schematicsInstallIndex.delete(entry.id)
        await saveSchematicsInstallIndex()
        updateInstallButtonState(entry)
        renderSchematics()
    } catch (err) {
        loggerLanding.warn('Failed to remove installed schematic.', err)
    }
}

async function removeInstalledSchematic(entry){
    if(!entry?.id || !schematicsInstallManager) return
    try {
        const context = await resolveSchematicInstallContext()
        const removed = schematicsInstallManager.remove({
            profileId: context.profileId,
            playerUuid: context.account.uuid,
            schematicId: entry.id,
            confirmModified: filePath => window.confirm(`This schematic was modified locally:\n${filePath}\n\nDelete the modified file?`)
        })
        if(removed){
            schematicsInstallIndex = new Map(schematicsInstallManager.index.map(item => [item.key, item]))
            updateInstallButtonState(entry)
            renderInstalledList()
            renderSchematics()
        }
    } catch(err) {
        loggerLanding.warn('Failed to remove installed schematic.', { message: err?.message || String(err) })
    }
}
