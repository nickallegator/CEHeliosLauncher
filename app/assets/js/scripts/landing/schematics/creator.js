let schematicsCreatorOpen = false
let schematicsCreatorState = {
    status: 'idle',
    creator: '',
    items: [],
    total: 0,
    error: null,
    sortKey: 'likes-desc',
    page: 1,
    pageSize: 24,
    collections: []
}
let creatorSchematicsFetchController = null
let creatorSchematicsRequestId = 0
let creatorCollectionsFetchController = null
let creatorCollectionsRequestId = 0

function openCreatorPanel(creator){
    if(!schematicsBrowseCreatorView || !creator){
        return
    }
    if(schematicDetailOpen){
        closeSchematicDetail()
    }
    schematicsCommunityPreviousSection = schematicsCommunitySection
    schematicsCommunityPreviousContentTab = schematicsContentTab
    schematicsCreatorOpen = true
    schematicsCreatorState = {
        ...schematicsCreatorState,
        status: 'loading',
        creator,
        items: [],
        total: 0,
        error: null,
        page: 1
    }
    setCommunitySection('creators', { skipFetch: true })
    setCreatorView('profile', { skipFetch: true })
    renderCreatorPanel()
    fetchCreatorSchematics(creator)
    fetchCreatorCollections(creator)
}

function closeCreatorPanel(){
    if(creatorSchematicsFetchController){
        creatorSchematicsFetchController.abort()
    }
    if(creatorCollectionsFetchController){
        creatorCollectionsFetchController.abort()
    }
    schematicsCreatorOpen = false
    setCreatorView('list', { skipFetch: true })
    if(schematicsCommunityPreviousSection === 'content'){
        schematicsContentTab = schematicsCommunityPreviousContentTab || 'schematics'
        setCommunitySection('content')
    } else {
        setCommunitySection('creators')
    }
    updateCommunityView()
}

function renderCreatorPanel(){
    if(!schematicsCreatorGrid || !schematicsCreatorTitle || !schematicsCreatorCount){
        return
    }
    schematicsCreatorTitle.textContent = schematicsCreatorState.creator || 'Creator'
    const total = schematicsCreatorState.total || schematicsCreatorState.items.length
    const shown = schematicsCreatorState.items.length
    schematicsCreatorCount.textContent = total ? `${shown} of ${total} creations` : '0 creations'
    if(schematicsCreatorAvatar){
        const initial = (schematicsCreatorState.creator || 'C').trim().charAt(0) || 'C'
        schematicsCreatorAvatar.textContent = initial.toUpperCase()
    }
    if(schematicsCreatorSort){
        schematicsCreatorSort.value = schematicsCreatorState.sortKey
    }
    schematicsCreatorGrid.innerHTML = ''
    if(schematicsCreatorCollectionsList){
        schematicsCreatorCollectionsList.innerHTML = ''
        const collections = schematicsCreatorState.collections || []
        if(collections.length === 0){
            const empty = document.createElement('span')
            empty.className = 'schematicsCollectionPill'
            empty.textContent = 'No collections'
            empty.setAttribute('aria-disabled', 'true')
            schematicsCreatorCollectionsList.appendChild(empty)
        } else {
            collections.forEach((collection) => {
                const pill = document.createElement('button')
                pill.type = 'button'
                pill.className = 'schematicsCollectionPill'
                pill.textContent = collection.name
                pill.addEventListener('click', () => {
                    openCollectionsPanel('public', collection.id)
                })
                schematicsCreatorCollectionsList.appendChild(pill)
            })
        }
    }

    const fragment = document.createDocumentFragment()
    if(schematicsCreatorState.status === 'loading'){
        fragment.appendChild(createSchematicsMessage('Loading creator schematics...'))
    } else if(schematicsCreatorState.status === 'error' && schematicsCreatorState.error){
        fragment.appendChild(createSchematicsMessage(schematicsCreatorState.error))
    } else if(schematicsCreatorState.items.length === 0){
        fragment.appendChild(createSchematicsMessage('No schematics found for this creator.'))
    } else {
        schematicsCreatorState.items.forEach((entry) => {
            fragment.appendChild(createSchematicCard(entry))
        })
    }
    schematicsCreatorGrid.appendChild(fragment)
    updateCreatorPagination()
}

function buildCreatorsIndex(entries){
    const map = new Map()
    entries.forEach((entry) => {
        const name = (entry.creator || '').trim()
        if(!name){
            return
        }
        if(!map.has(name)){
            map.set(name, {
                name,
                count: 0,
                likesTotal: 0,
                latestRelease: null
            })
        }
        const data = map.get(name)
        data.count += 1
        data.likesTotal += getLikesValue(entry)
        const release = entry.release ? new Date(entry.release).getTime() : null
        if(release && (!data.latestRelease || release > data.latestRelease)){
            data.latestRelease = release
        }
    })
    return Array.from(map.values()).map((creator) => ({
        ...creator,
        likes: creator.likesTotal
    }))
}

function renderCreatorsBrowse(){
    if(!schematicsCreatorsGrid){
        return
    }
    schematicsCreatorsGrid.innerHTML = ''
    const fragment = document.createDocumentFragment()
    if(schematicsCreatorsBrowseState.status === 'loading'){
        fragment.appendChild(createSchematicsMessage('Loading creators...'))
    } else if(schematicsCreatorsBrowseState.error){
        fragment.appendChild(createSchematicsMessage(schematicsCreatorsBrowseState.error))
    } else if(schematicsCreatorsBrowseState.items.length === 0){
        fragment.appendChild(createSchematicsMessage('No creators found.'))
    } else {
        schematicsCreatorsBrowseState.items.forEach((creator) => {
            const card = document.createElement('button')
            card.type = 'button'
            card.className = 'schematicCard'
            card.style.minHeight = '160px'
            card.setAttribute('data-creator', creator.name)

            const preview = document.createElement('div')
            preview.className = 'schematicPreview empty'
            preview.innerHTML = SchematicIcon

            const details = document.createElement('div')
            details.className = 'schematicDetails'

            const title = document.createElement('div')
            title.className = 'schematicName'
            title.textContent = creator.name

            const meta = document.createElement('div')
            meta.className = 'schematicMetaRow'
            meta.textContent = `${creator.count} schematics`

            details.appendChild(title)
            details.appendChild(meta)
            card.appendChild(preview)
            card.appendChild(details)
            card.addEventListener('click', () => openCreatorPanel(creator.name))
            fragment.appendChild(card)
        })
    }
    schematicsCreatorsGrid.appendChild(fragment)
    if(schematicsCreatorsBrowseCount){
        schematicsCreatorsBrowseCount.textContent = String(schematicsCreatorsBrowseState.total || 0)
    }
}

async function fetchCreatorsBrowse(){
    const base = await resolveSchematicsApiBase()
    if(!base){
        schematicsCreatorsBrowseState = {
            ...schematicsCreatorsBrowseState,
            status: 'error',
            error: 'Schematics service not configured.',
            items: [],
            total: 0
        }
        renderCreatorsBrowse()
        return
    }
    await ensureSchematicsAuthSession(base)
    schematicsCreatorsBrowseState = {
        ...schematicsCreatorsBrowseState,
        status: 'loading',
        error: null
    }
    renderCreatorsBrowse()
    const params = new URLSearchParams()
    params.set('limit', '120')
    params.set('offset', '0')
    params.set('sort', 'likes')
    try {
        const response = await fetch(`${base.replace(/\/+$/, '')}/v1/schematics?${params.toString()}`, {
            method: 'GET',
            headers: { 'Accept': 'application/json', ...getSchematicsAuthHeaders() }
        })
        if(!response.ok){
            throw new Error(`HTTP ${response.status}`)
        }
        const data = await response.json()
        const items = Array.isArray(data?.items) ? data.items : []
        const creators = buildCreatorsIndex(items).sort((a, b) => {
            if(b.count !== a.count){
                return b.count - a.count
            }
            return (b.latestRelease || 0) - (a.latestRelease || 0)
        })
        schematicsCreatorsBrowseState = {
            ...schematicsCreatorsBrowseState,
            status: 'ready',
            error: null,
            items: creators,
            total: creators.length
        }
        renderCreatorsBrowse()
    } catch (err) {
        loggerLanding.warn('Failed to load creators browse.', err)
        schematicsCreatorsBrowseState = {
            ...schematicsCreatorsBrowseState,
            status: 'error',
            error: 'Unable to load creators.',
            items: [],
            total: 0
        }
        renderCreatorsBrowse()
    }
}

function updateCreatorPagination(){
    if(!schematicsCreatorPageStatus){
        return
    }
    const total = Number.isFinite(Number(schematicsCreatorState.total)) ? Number(schematicsCreatorState.total) : 0
    const pages = Math.max(1, Math.ceil(total / schematicsCreatorState.pageSize))
    const page = Math.min(Math.max(1, schematicsCreatorState.page), pages)
    schematicsCreatorPageStatus.textContent = `${page} / ${pages}`
    if(schematicsCreatorPagePrev){
        schematicsCreatorPagePrev.disabled = page <= 1
    }
    if(schematicsCreatorPageNext){
        schematicsCreatorPageNext.disabled = page >= pages
    }
}

async function fetchCreatorSchematics(creator, { page, sortKey } = {}){
    const targetCreator = String(creator || '').trim()
    if(!targetCreator){
        return
    }
    if(creatorSchematicsFetchController){
        creatorSchematicsFetchController.abort()
    }
    creatorSchematicsFetchController = new AbortController()
    const requestId = ++creatorSchematicsRequestId
    schematicsCreatorState = {
        ...schematicsCreatorState,
        status: 'loading',
        error: null,
        creator: targetCreator
    }
    renderCreatorPanel()

    const base = await resolveSchematicsApiBase()
    if(requestId !== creatorSchematicsRequestId || schematicsCreatorState.creator !== targetCreator){
        return
    }
    if(!base){
        schematicsCreatorState = {
            ...schematicsCreatorState,
            status: 'error',
            error: 'Schematics service not configured.',
            items: []
        }
        renderCreatorPanel()
        return
    }
    await ensureSchematicsAuthSession(base)
    if(requestId !== creatorSchematicsRequestId || schematicsCreatorState.creator !== targetCreator){
        return
    }
    const nextPage = Number.isFinite(Number(page)) ? Math.max(1, Number(page)) : schematicsCreatorState.page
    const nextSortKey = sortKey || schematicsCreatorState.sortKey
    const sortParam = nextSortKey.includes('release') ? 'release' : 'likes'
    const calculatedPageSize = computeGridPageSize(schematicsCreatorGrid)
    const limit = calculatedPageSize || schematicsCreatorState.pageSize || SCHEMATICS_PAGE_SIZE_FALLBACK
    const effectivePage = calculatedPageSize && calculatedPageSize !== schematicsCreatorState.pageSize ? 1 : nextPage
    const offset = (effectivePage - 1) * limit

    const params = new URLSearchParams()
    params.set('creator', targetCreator)
    params.set('limit', String(limit))
    params.set('offset', String(offset))
    params.set('sort', sortParam)
    try {
        const response = await fetch(`${base.replace(/\/+$/, '')}/v1/schematics?${params.toString()}`, {
            method: 'GET',
            signal: creatorSchematicsFetchController.signal,
            headers: { 'Accept': 'application/json', ...getSchematicsAuthHeaders() }
        })
        if(!response.ok){
            throw new Error(`HTTP ${response.status}`)
        }
        const data = await response.json()
        if(requestId !== creatorSchematicsRequestId || schematicsCreatorState.creator !== targetCreator){
            return
        }
        let items = Array.isArray(data?.items) ? data.items : []
        if(nextSortKey.startsWith('name-')){
            items = items.slice().sort((a, b) => compareSchematicName(a, b))
            if(nextSortKey === 'name-desc'){
                items.reverse()
            }
        }
        schematicsCreatorState = {
            ...schematicsCreatorState,
            status: 'ready',
            error: null,
            items,
            total: Number.isFinite(Number(data?.total)) ? Number(data.total) : items.length,
            page: effectivePage,
            pageSize: limit,
            sortKey: nextSortKey
        }
        updateSchematicIndex(items)
        renderCreatorPanel()
    } catch (err) {
        if(err.name === 'AbortError'){
            return
        }
        loggerLanding.warn('Failed to load creator schematics.', err)
        if(requestId !== creatorSchematicsRequestId || schematicsCreatorState.creator !== targetCreator){
            return
        }
        schematicsCreatorState = {
            ...schematicsCreatorState,
            status: 'error',
            error: 'Unable to load creator schematics.',
            items: []
        }
        renderCreatorPanel()
    }
}

async function fetchCreatorCollections(creator){
    const targetCreator = String(creator || '').trim()
    if(!targetCreator){
        return
    }
    if(creatorCollectionsFetchController){
        creatorCollectionsFetchController.abort()
    }
    creatorCollectionsFetchController = new AbortController()
    const requestId = ++creatorCollectionsRequestId
    const base = await resolveSchematicsApiBase()
    if(requestId !== creatorCollectionsRequestId || schematicsCreatorState.creator !== targetCreator){
        return
    }
    if(!base){
        return
    }
    await ensureSchematicsAuthSession(base)
    if(requestId !== creatorCollectionsRequestId || schematicsCreatorState.creator !== targetCreator){
        return
    }
    const params = new URLSearchParams()
    params.set('creator', targetCreator)
    params.set('visibility', 'public')
    params.set('limit', '24')
    params.set('offset', '0')
    try {
        const response = await fetch(`${base.replace(/\/+$/, '')}/v1/collections?${params.toString()}`, {
            method: 'GET',
            signal: creatorCollectionsFetchController.signal,
            headers: { 'Accept': 'application/json', ...getSchematicsAuthHeaders() }
        })
        if(!response.ok){
            throw new Error(`HTTP ${response.status}`)
        }
        const data = await response.json()
        if(requestId !== creatorCollectionsRequestId || schematicsCreatorState.creator !== targetCreator){
            return
        }
        schematicsCreatorState = {
            ...schematicsCreatorState,
            collections: Array.isArray(data?.items) ? data.items : []
        }
        renderCreatorPanel()
    } catch (err) {
        if(err.name === 'AbortError'){
            return
        }
        loggerLanding.warn('Failed to load creator collections.', err)
    }
}

