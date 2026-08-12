function filterSchematics(entries, query){
    if(!query){
        return entries
    }
    return entries.filter((entry) => {
        const name = (entry.name || '').toLowerCase()
        const creator = (entry.creator || '').toLowerCase()
        return name.includes(query) || creator.includes(query)
    })
}

function sortSchematics(entries, sortKey){
    const sorter = SCHEMATIC_SORTERS[sortKey] || SCHEMATIC_SORTERS[SCHEMATICS_SORT_DEFAULT]
    return entries.slice().sort(sorter)
}

function getLatestReleaseDate(entries){
    let latest = 0
    entries.forEach((entry) => {
        const ts = getReleaseTimestamp(entry)
        if(ts > latest){
            latest = ts
        }
    })
    return latest
}

function createSchematicCard(entry){
    const card = document.createElement('button')
    card.type = 'button'
    card.className = 'schematicCard'
    card.setAttribute('data-schematic-id', entry.id || '')
    card.setAttribute('aria-label', `${entry.name} by ${entry.creator}`)
    card.setAttribute('title', entry.name)
    if(entry.accent){
        card.style.setProperty('--schematic-accent', entry.accent)
    }

    const apiBase = (schematicsState.apiBase || '').replace(/\/+$/, '')
    const thumbPath = entry.thumbnailUrl || null
    const thumbUrl = thumbPath
        ? (thumbPath.startsWith('http') ? thumbPath : `${apiBase}${thumbPath}`)
        : null
    const preview = createGridEntryMedia({
        className: 'schematicPreview',
        imageUrl: thumbUrl,
        alt: `${entry.name || 'Schematic'} preview`,
        fallbackSvg: SCHEMATIC_PREVIEW_SVG,
        imageClass: 'schematicPreviewImage'
    })

    const details = document.createElement('div')
    details.className = 'schematicDetails'

    const name = document.createElement('span')
    name.className = 'schematicName'
    name.textContent = entry.name

    const metaRow = document.createElement('div')
    metaRow.className = 'schematicMetaRow'

    const creator = document.createElement('button')
    creator.type = 'button'
    creator.className = 'schematicCreatorButton'
    creator.textContent = `by ${entry.creator}`
    creator.addEventListener('click', (event) => {
        event.stopPropagation()
        event.preventDefault()
        if(schematicsCreatorInput) schematicsCreatorInput.value = entry.creator || ''
        fetchSchematicsList({ page: 1 })
    })

    metaRow.appendChild(creator)
    const userId = getCurrentUserId()
    const isOwner = Boolean(userId && entry.ownerId && Number(entry.ownerId) === Number(userId))
    if(isOwner){
        const edit = document.createElement('button')
        edit.type = 'button'
        edit.className = 'schematicCreatorButton schematicEditButton'
        edit.textContent = communityCopy('edit')
        edit.addEventListener('click', (event) => {
            event.stopPropagation()
            event.preventDefault()
            openSchematicEdit(entry)
        })
        metaRow.appendChild(edit)
    }

    details.appendChild(name)
    const installed = entry.id ? getInstalledSchematic(entry.id) : null
    if(installed){
        card.setAttribute('data-installed', 'true')
        const installedBadge = document.createElement('span')
        installedBadge.className = 'schematicInstalledBadge'
        const account = ConfigManager.getSelectedAccount()
        const status = schematicsInstallManager && account?.uuid
            ? schematicsInstallManager.status(ConfigManager.getSelectedServer(), account.uuid, entry).state
            : 'installed'
        installedBadge.textContent = status === 'update' ? communityCopy('updateAvailable') : (status === 'repair' ? communityCopy('repairNeeded') : communityCopy('installed'))
        details.appendChild(installedBadge)
    }
    details.appendChild(metaRow)
    const engagement = new CommunityEngagement(entry).createRow()
    details.appendChild(engagement)
    if(entry.release){
        const release = document.createElement('span')
        release.className = 'schematicRelease'
        release.textContent = communityCopy('released', { date: formatSchematicDate(entry.release) })
        details.appendChild(release)
    }
    card.appendChild(preview)
    card.appendChild(details)

    return card
}


function formatBlockStateLabel(state){
    if(!state || typeof state !== 'object'){
        return ''
    }
    const entries = Object.entries(state).filter(([key]) => key).sort((a, b) => a[0].localeCompare(b[0]))
    if(entries.length === 0){
        return ''
    }
    const label = entries.map(([key, value]) => `${key}=${value}`).join(', ')
    return ` [${label}]`
}

function formatPaletteBlockLabel(entry, displayName = null){
    if(!entry || typeof entry.block !== 'string'){
        return 'unknown:block'
    }
    const baseLabel = displayName || entry.block
    return `${baseLabel}${formatBlockStateLabel(entry.state)}`
}

function renderBlockCountsPlaceholder(message, totalText = '--'){
    if(!schematicsDetailBlocksList || !schematicsDetailBlocksTotal){
        return
    }
    schematicsDetailBlocksTotal.textContent = totalText
    schematicsDetailBlocksList.innerHTML = ''
    const row = document.createElement('div')
    row.className = 'schematicsDetailBlockRow'
    const name = document.createElement('span')
    name.className = 'schematicsDetailBlockName'
    name.textContent = message
    const count = document.createElement('span')
    count.className = 'schematicsDetailBlockCount'
    count.textContent = '--'
    row.appendChild(name)
    row.appendChild(count)
    schematicsDetailBlocksList.appendChild(row)
}

function formatModNamespaceLabel(namespace){
    const key = normalizeNamespace(namespace)
    if(!key){
        return communityCopy('unknownMod')
    }
    return key
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\b([a-z])/g, (match, char) => char.toUpperCase())
}

function renderModListPlaceholder(message, totalText = '--'){
    if(!schematicsDetailModsList || !schematicsDetailModsTotal){
        return
    }
    schematicsDetailModsTotal.textContent = totalText
    schematicsDetailModsList.innerHTML = ''
    const row = document.createElement('div')
    row.className = 'schematicsDetailModRow'
    const labelWrap = document.createElement('div')
    labelWrap.className = 'schematicsDetailModNameWrap'
    const name = document.createElement('span')
    name.className = 'schematicsDetailModName'
    name.textContent = message
    labelWrap.appendChild(name)
    const count = document.createElement('span')
    count.className = 'schematicsDetailModCount'
    count.textContent = '--'
    row.appendChild(labelWrap)
    row.appendChild(count)
    schematicsDetailModsList.appendChild(row)
}

async function renderSchematicModsList(normalized){
    if(!schematicsDetailModsList || !schematicsDetailModsTotal){
        return
    }
    if(!normalized || !Array.isArray(normalized.blocks) || !Array.isArray(normalized.palette)){
        renderModListPlaceholder(communityCopy('noModData'))
        return
    }

    const namespaceCounts = new Map()
    for(const block of normalized.blocks){
        const paletteIndex = Number.isInteger(block?.p) ? block.p : -1
        if(paletteIndex < 0 || paletteIndex >= normalized.palette.length){
            continue
        }
        const blockId = normalized.palette[paletteIndex]?.block
        const namespace = normalizeNamespace(splitResourceId(blockId).namespace)
        if(!namespace || namespace === 'minecraft'){
            continue
        }
        namespaceCounts.set(namespace, (namespaceCounts.get(namespace) || 0) + 1)
    }

    const rows = Array.from(namespaceCounts.entries())
        .map(([namespace, count]) => ({ namespace, count }))
        .sort((a, b) => {
            if(b.count !== a.count){
                return b.count - a.count
            }
            return a.namespace.localeCompare(b.namespace)
        })

    schematicsDetailModsTotal.textContent = `${rows.length} mods`
    schematicsDetailModsList.innerHTML = ''
    if(rows.length === 0){
        renderModListPlaceholder(communityCopy('noModdedBlocks'), '0 mods')
        return
    }

    await Promise.all(rows.map(async (row) => {
        row.name = formatModNamespaceLabel(row.namespace)
        try {
            const info = await getSchematicsModInfo(row.namespace)
            if(info?.name && typeof info.name === 'string' && info.name.trim()){
                row.name = info.name.trim()
            }
        } catch (err) {
            loggerLanding.warn('Failed to resolve mod metadata for schematic detail.', err)
        }
    }))

    const fragment = document.createDocumentFragment()
    rows.forEach((row) => {
        const item = document.createElement('div')
        item.className = 'schematicsDetailModRow'

        const labelWrap = document.createElement('div')
        labelWrap.className = 'schematicsDetailModNameWrap'

        const name = document.createElement('span')
        name.className = 'schematicsDetailModName'
        name.textContent = row.name

        const namespace = document.createElement('span')
        namespace.className = 'schematicsDetailModNamespace'
        namespace.textContent = row.namespace

        const count = document.createElement('span')
        count.className = 'schematicsDetailModCount'
        count.textContent = `${row.count.toLocaleString()} blocks`

        labelWrap.appendChild(name)
        labelWrap.appendChild(namespace)
        item.appendChild(labelWrap)
        item.appendChild(count)
        fragment.appendChild(item)
    })
    schematicsDetailModsList.appendChild(fragment)
}

async function renderSchematicBlockCounts(normalized, { stack = null } = {}){
    if(!schematicsDetailBlocksList || !schematicsDetailBlocksTotal){
        return
    }
    if(!normalized || !Array.isArray(normalized.blocks) || !Array.isArray(normalized.palette)){
        renderBlockCountsPlaceholder(communityCopy('noBlockData'))
        return
    }

    const counts = new Array(normalized.palette.length).fill(0)
    for(const block of normalized.blocks){
        if(block && Number.isInteger(block.p) && block.p >= 0 && block.p < counts.length){
            counts[block.p]++
        }
    }

    let localizedNames = new Map()
    try {
        localizedNames = await resolvePaletteBlockDisplayNames(normalized.palette, { stack })
    } catch (err) {
        loggerLanding.warn('Failed to resolve localized block names.', err)
        localizedNames = new Map()
    }

    const rows = normalized.palette
        .map((entry, index) => ({
            label: formatPaletteBlockLabel(entry, localizedNames.get(entry.block)),
            count: counts[index] || 0
        }))
        .filter((entry) => entry.count > 0)
        .sort((a, b) => {
            if(b.count !== a.count){
                return b.count - a.count
            }
            return a.label.localeCompare(b.label)
        })

    const total = Number.isFinite(normalized.meta?.blockCount)
        ? normalized.meta.blockCount
        : normalized.blocks.length
    schematicsDetailBlocksTotal.textContent = `${total} blocks`

    schematicsDetailBlocksList.innerHTML = ''
    if(rows.length === 0){
        renderBlockCountsPlaceholder(communityCopy('noBlocks'))
        return
    }
    const fragment = document.createDocumentFragment()
    rows.forEach((entry) => {
        const row = document.createElement('div')
        row.className = 'schematicsDetailBlockRow'
        const name = document.createElement('span')
        name.className = 'schematicsDetailBlockName'
        name.textContent = entry.label
        const count = document.createElement('span')
        count.className = 'schematicsDetailBlockCount'
        count.textContent = entry.count.toLocaleString()
        row.appendChild(name)
        row.appendChild(count)
        fragment.appendChild(row)
    })
    schematicsDetailBlocksList.appendChild(fragment)
}

function renderUploadBlockCountsPlaceholder(message, totalText = '--'){
    if(!schematicsUploadBlocksList || !schematicsUploadBlocksTotal){
        return
    }
    schematicsUploadBlocksTotal.textContent = totalText
    schematicsUploadBlocksList.innerHTML = ''
    const row = document.createElement('div')
    row.className = 'schematicsUploadBlockRow'
    const name = document.createElement('span')
    name.className = 'schematicsUploadBlockName'
    name.textContent = message
    const count = document.createElement('span')
    count.className = 'schematicsUploadBlockCount'
    count.textContent = '--'
    row.appendChild(name)
    row.appendChild(count)
    schematicsUploadBlocksList.appendChild(row)
}

function renderUploadBlockCounts(normalized){
    if(!schematicsUploadBlocksList || !schematicsUploadBlocksTotal){
        return
    }
    if(!normalized || !Array.isArray(normalized.blocks) || !Array.isArray(normalized.palette)){
        renderUploadBlockCountsPlaceholder(communityCopy('noBlockData'))
        return
    }

    const counts = new Array(normalized.palette.length).fill(0)
    for(const block of normalized.blocks){
        if(block && Number.isInteger(block.p) && block.p >= 0 && block.p < counts.length){
            counts[block.p]++
        }
    }

    const rows = normalized.palette
        .map((entry, index) => ({
            label: formatPaletteBlockLabel(entry),
            count: counts[index] || 0
        }))
        .filter((entry) => entry.count > 0)
        .sort((a, b) => {
            if(b.count !== a.count){
                return b.count - a.count
            }
            return a.label.localeCompare(b.label)
        })

    const total = rows.reduce((acc, entry) => acc + entry.count, 0)
    schematicsUploadBlocksTotal.textContent = `${total} blocks`
    schematicsUploadBlocksList.innerHTML = ''
    const fragment = document.createDocumentFragment()
    rows.forEach((entry) => {
        const row = document.createElement('div')
        row.className = 'schematicsUploadBlockRow'
        const name = document.createElement('span')
        name.className = 'schematicsUploadBlockName'
        name.textContent = entry.label
        const count = document.createElement('span')
        count.className = 'schematicsUploadBlockCount'
        count.textContent = `${entry.count}`
        row.appendChild(name)
        row.appendChild(count)
        fragment.appendChild(row)
    })
    schematicsUploadBlocksList.appendChild(fragment)
}

function renderSchematics(options = {}){
    if(!schematicsGrid){
        return
    }

    if(!options.keepDetailOpen && schematicDetailOpen){
        closeSchematicDetail()
    }

    const query = normalizeSchematicQuery(schematicsSearchInput?.value)
    const sortKey = schematicsSortSelect?.value || SCHEMATICS_SORT_DEFAULT
    const sourceItems = schematicsState.items
    let filtered = filterSchematics(sourceItems, query)
    if(schematicsInstalledToggle?.checked){
        filtered = filtered.filter(entry => entry?.id && getInstalledSchematic(entry.id))
    }
    const sorted = sortSchematics(filtered, sortKey)

    schematicsGrid.innerHTML = ''
    const fragment = document.createDocumentFragment()
    if(schematicsState.status === 'loading'){
        fragment.appendChild(createSchematicsMessage(communityCopy('loadingSchematics')))
    } else if(schematicsState.status === 'error' && schematicsState.error){
        fragment.appendChild(createSchematicsMessage(schematicsState.error))
    } else if(sorted.length === 0){
        fragment.appendChild(createSchematicsMessage(schematicsInstalledToggle?.checked ? communityCopy('noInstalledSchematics') : communityCopy('noSchematics')))
    }
    sorted.forEach((entry) => {
        fragment.appendChild(createSchematicCard(entry))
    })
    schematicsGrid.appendChild(fragment)

    if(schematicsCount){
        const total = schematicsState.total || sourceItems.length
        schematicsCount.textContent = sorted.length === total ? `${sorted.length}` : `${sorted.length} / ${total}`
    }
    if(schematicsUpdated){
        const latestRelease = getLatestReleaseDate(sorted)
        schematicsUpdated.textContent = latestRelease ? formatSchematicDate(latestRelease) : '--'
    }
    updateSchematicsPagination()
}

function createSchematicsMessage(message){
    const card = document.createElement('div')
    card.className = 'schematicsGridMessage'
    card.textContent = message
    return card
}

function scheduleSchematicsFetch(){
    if(schematicsFetchTimer){
        clearTimeout(schematicsFetchTimer)
    }
    schematicsFetchTimer = setTimeout(() => {
        fetchSchematicsList({
            query: schematicsSearchInput?.value || '',
            sortKey: schematicsSortSelect?.value || SCHEMATICS_SORT_DEFAULT,
            page: 1
        })
    }, 200)
}

function updateSchematicsPagination(){
    if(schematicsPageStatus){
        const loaded = schematicsState.items.length
        schematicsPageStatus.textContent = schematicsState.offline
            ? `${loaded} · ${communityCopy('offlineCatalog')}`
            : `${loaded} ${loaded === 1 ? 'creation' : 'creations'}`
    }
    if(communityLoadMoreButton){
        communityLoadMoreButton.hidden = !schematicsState.nextCursor
        communityLoadMoreButton.disabled = schematicsState.loadingMore
        communityLoadMoreButton.setAttribute('aria-busy', String(schematicsState.loadingMore))
    }
}
