let schematicsCollectionsOpen = false
let schematicsCollectionsState = {
    status: 'idle',
    items: [],
    total: 0,
    view: 'list',
    filter: 'public',
    detail: null,
    error: null,
    pickerSchematicId: null
}
let schematicsCollectionsBrowseDetailOpen = false
let schematicsCollectionsBrowseDetailActiveId = null
let collectionViewRecorded = new Set()
let collectionsBrowseRequestId = 0
let collectionsBrowseFetchController = null
let collectionsBrowseDetailRequestId = 0
let collectionsBrowseDetailFetchController = null
let collectionsListRequestId = 0
let collectionsListFetchController = null
let collectionsDetailRequestId = 0
let collectionsDetailFetchController = null
try {
    const cached = sessionStorage.getItem('collectionsViewRecorded')
    if(cached){
        const parsed = JSON.parse(cached)
        if(Array.isArray(parsed)){
            collectionViewRecorded = new Set(parsed.filter(Boolean))
        }
    }
} catch (err) {
    collectionViewRecorded = new Set()
}

function markCollectionViewRecorded(id){
    if(!id){
        return
    }
    collectionViewRecorded.add(id)
    try {
        sessionStorage.setItem('collectionsViewRecorded', JSON.stringify(Array.from(collectionViewRecorded)))
    } catch (err) {
        // ignore storage errors
    }
}

function updateCollectionLikeButton(entry){
    if(!schematicsCollectionsBrowseDetailLike){
        return
    }
    const liked = Boolean(entry?.liked)
    schematicsCollectionsBrowseDetailLike.textContent = liked ? communityCopy('liked') : communityCopy('like')
    schematicsCollectionsBrowseDetailLike.classList.toggle('is-liked', liked)
    const hasToken = Boolean(AccessGate.getSessionToken())
    schematicsCollectionsBrowseDetailLike.disabled = !hasToken
}

function updateCollectionCaches(entry, patch){
    if(!entry?.id){
        return entry || null
    }
    const updated = { ...entry, ...patch }

    if(Array.isArray(schematicsCollectionsBrowseState?.items)){
        schematicsCollectionsBrowseState = {
            ...schematicsCollectionsBrowseState,
            items: schematicsCollectionsBrowseState.items.map((item) => (item?.id === entry.id ? { ...item, ...patch } : item))
        }
    }
    if(schematicsCollectionsBrowseState?.detail?.id === entry.id){
        schematicsCollectionsBrowseState = {
            ...schematicsCollectionsBrowseState,
            detail: { ...schematicsCollectionsBrowseState.detail, ...patch }
        }
    }

    if(Array.isArray(schematicsCollectionsState?.items)){
        schematicsCollectionsState = {
            ...schematicsCollectionsState,
            items: schematicsCollectionsState.items.map((item) => (item?.id === entry.id ? { ...item, ...patch } : item))
        }
    }
    if(schematicsCollectionsState?.detail?.id === entry.id){
        schematicsCollectionsState = {
            ...schematicsCollectionsState,
            detail: { ...schematicsCollectionsState.detail, ...patch }
        }
    }

    renderCollectionsBrowse()
    if(schematicsCollectionsBrowseDetailOpen){
        renderCollectionsBrowseDetail()
    }
    renderCollectionsPanel()
    if(schematicsCollectionsState.view === 'detail'){
        renderCollectionDetail()
    }
    return updated
}

async function toggleCollectionLike(entry){
    if(!entry?.id){
        return null
    }
    const base = await resolveSchematicsApiBase()
    if(!base){
        return null
    }
    await ensureSchematicsAuthSession(base)
    const hasToken = Boolean(AccessGate.getSessionToken())
    if(!hasToken){
        return null
    }
    const currentlyLiked = Boolean(entry.liked)
    try {
        const response = await fetch(`${base.replace(/\/+$/, '')}/v1/collections/${encodeURIComponent(entry.id)}/like`, {
            method: currentlyLiked ? 'DELETE' : 'POST',
            headers: {
                'Accept': 'application/json',
                ...getSchematicsAuthHeaders()
            }
        })
        if(!response.ok){
            throw new Error(`HTTP ${response.status}`)
        }
        const data = await response.json().catch(() => ({}))
        const likes = Number.isFinite(Number(data?.likes))
            ? Number(data.likes)
            : Math.max(0, Number(entry.likes || 0) + (currentlyLiked ? -1 : 1))
        const liked = typeof data?.liked === 'boolean' ? data.liked : !currentlyLiked
        return updateCollectionCaches(entry, { likes, liked })
    } catch (err) {
        loggerLanding.warn('Failed to toggle collection like.', err)
        return null
    }
}

async function recordCollectionView(entry){
    if(!entry?.id){
        return null
    }
    const base = await resolveSchematicsApiBase()
    if(!base){
        return null
    }
    await ensureSchematicsAuthSession(base)
    const hasToken = Boolean(AccessGate.getSessionToken())
    if(!hasToken){
        return null
    }
    try {
        const response = await fetch(`${base.replace(/\/+$/, '')}/v1/collections/${encodeURIComponent(entry.id)}/view`, {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                ...getSchematicsAuthHeaders()
            }
        })
        if(!response.ok){
            throw new Error(`HTTP ${response.status}`)
        }
        const data = await response.json().catch(() => ({}))
        const views = Number.isFinite(Number(data?.views)) ? Number(data.views) : Number(entry.views || 0)
        return updateCollectionCaches(entry, { views })
    } catch (err) {
        loggerLanding.warn('Failed to record collection view.', err)
        return null
    }
}

function resolveCollectionCoverUrl(collection){
    const coverUrl = collection?.cover?.url
    if(!coverUrl){
        return null
    }
    const apiBase = (schematicsState.apiBase || '').replace(/\/+$/, '')
    return coverUrl.startsWith('http') ? coverUrl : `${apiBase}${coverUrl}`
}

function openCollectionsPanel(filter = 'public', collectionId = null, pickerSchematicId = null){
    if(!schematicsCollectionsPanel || !schematicsContent){
        return
    }
    if(schematicsCollectionsBrowseDetailOpen){
        closeCollectionsBrowseDetail()
    }
    if(schematicDetailOpen){
        closeSchematicDetail()
    }
    if(schematicsCreatorOpen){
        closeCreatorPanel()
    }
    schematicsCollectionsOpen = true
    schematicsCollectionsState = {
        ...schematicsCollectionsState,
        status: 'loading',
        filter,
        view: 'list',
        detail: null,
        error: null,
        pickerSchematicId
    }
    schematicsCollectionsPanel.setAttribute('data-open', 'true')
    schematicsCollectionsPanel.setAttribute('aria-hidden', 'false')
    schematicsContent.setAttribute('collections-open', '')
    if(schematicsCollectionsCreate){
        schematicsCollectionsCreate.hidden = true
    }
    if(schematicsCollectionsName){
        schematicsCollectionsName.value = ''
    }
    if(schematicsCollectionsDescription){
        schematicsCollectionsDescription.value = ''
    }
    renderCollectionsPanel()
    fetchCollectionsList(filter, collectionId)
}

function openCollectionsCreatePanel(){
    openCollectionsPanel('mine')
    if(schematicsCollectionsCreate){
        schematicsCollectionsCreate.hidden = false
    }
    if(schematicsCollectionsName){
        schematicsCollectionsName.focus()
    }
}

function openCollectionsBrowseDetailModal(){
    if(!schematicsCollectionsBrowseDetailModal){
        return false
    }
    schematicsCollectionsBrowseDetailOpen = true
    openModal(schematicsCollectionsBrowseDetailModal, schematicsCollectionsBrowseDetailPanel)
    return true
}

function closeCollectionsBrowseDetail(){
    if(!schematicsCollectionsBrowseDetailModal || !schematicsCollectionsBrowseDetailOpen){
        return
    }
    if(collectionsBrowseDetailFetchController){
        collectionsBrowseDetailFetchController.abort()
    }
    schematicsCollectionsBrowseDetailOpen = false
    schematicsCollectionsBrowseDetailActiveId = null
    schematicsCollectionsBrowseState = {
        ...schematicsCollectionsBrowseState,
        detail: null,
        detailStatus: 'idle',
        detailError: null
    }
    closeModal(schematicsCollectionsBrowseDetailModal)
}

function updateCollectionsBrowsePager(){
    if(!schematicsCollectionsPageStatus){
        return
    }
    const total = Number.isFinite(Number(schematicsCollectionsBrowseState.total)) ? Number(schematicsCollectionsBrowseState.total) : 0
    const pages = Math.max(1, Math.ceil(total / schematicsCollectionsBrowseState.pageSize))
    const page = Math.min(Math.max(1, schematicsCollectionsBrowseState.page), pages)
    schematicsCollectionsPageStatus.textContent = `${page} / ${pages}`
    if(schematicsCollectionsPagePrev){
        schematicsCollectionsPagePrev.disabled = page <= 1
    }
    if(schematicsCollectionsPageNext){
        schematicsCollectionsPageNext.disabled = page >= pages
    }
}

function createCollectionBrowseCard(collection){
    const card = document.createElement('div')
    card.className = 'schematicsCollectionCard'
    card.setAttribute('data-collection-id', collection.id)
    card.setAttribute('role', 'listitem')
    card.addEventListener('click', () => {
        openCollectionsBrowseDetail(collection.id)
    })

    const coverUrl = resolveCollectionCoverUrl(collection)
    const cover = createGridEntryMedia({
        className: 'schematicsCollectionCover',
        imageUrl: coverUrl,
        alt: `${collection.name || 'Collection'} cover`,
        fallbackSvg: COLLECTION_PREVIEW_SVG,
        imageClass: 'schematicsCollectionCoverImage'
    })
    if(!coverUrl){
        cover.classList.add('empty')
    }

    const name = document.createElement('span')
    name.className = 'schematicsCollectionName'
    name.textContent = collection.name || communityCopy('collection')

    const meta = document.createElement('span')
    meta.className = 'schematicsCollectionMeta'
    meta.textContent = `${collection.itemCount || 0} schematics - ${collection.visibility || 'public'}`

    const engagement = new CommunityEngagement(collection).createRow({
        className: 'schematicEngagement schematicsCollectionEngagement'
    })

    const desc = document.createElement('span')
    desc.className = 'schematicsCollectionMeta'
    desc.textContent = collection.description || ''

    card.appendChild(cover)
    card.appendChild(name)
    card.appendChild(meta)
    card.appendChild(engagement)
    if(collection.description){
        card.appendChild(desc)
    }
    return card
}

function renderCollectionsBrowseDetail(){
    if(!schematicsCollectionsBrowseDetailGrid || !schematicsCollectionsBrowseDetailTitle || !schematicsCollectionsBrowseDetailMeta){
        return
    }
    const { detail, detailStatus, detailError } = schematicsCollectionsBrowseState
    const hasDetail = Boolean(detail && typeof detail === 'object')
    if(detail?.name){
        schematicsCollectionsBrowseDetailTitle.textContent = detail.name
    } else if(detailStatus === 'loading'){
        schematicsCollectionsBrowseDetailTitle.textContent = communityCopy('loadingCollection')
    } else {
        schematicsCollectionsBrowseDetailTitle.textContent = communityCopy('collection')
    }
    if(detailStatus === 'loading'){
        schematicsCollectionsBrowseDetailMeta.textContent = communityCopy('loading')
    } else if(detailStatus === 'error'){
        schematicsCollectionsBrowseDetailMeta.textContent = communityCopy('unableToLoad')
    } else if(hasDetail){
        const engagement = new CommunityEngagement(detail)
        const likesText = formatEngagementCount(engagement.getLikes())
        const viewsText = formatEngagementCount(engagement.getViews())
        schematicsCollectionsBrowseDetailMeta.textContent = `${detail.items?.length || 0} schematics - ${likesText} likes - ${viewsText} views`
    } else {
        schematicsCollectionsBrowseDetailMeta.textContent = '--'
    }
    if(hasDetail){
        updateCollectionLikeButton(detail)
    } else if(schematicsCollectionsBrowseDetailLike){
        schematicsCollectionsBrowseDetailLike.textContent = communityCopy('like')
        schematicsCollectionsBrowseDetailLike.classList.remove('is-liked')
        schematicsCollectionsBrowseDetailLike.disabled = true
    }
    schematicsCollectionsBrowseDetailGrid.innerHTML = ''
    const fragment = document.createDocumentFragment()
    if(detailStatus === 'loading'){
        fragment.appendChild(createSchematicsMessage(communityCopy('loadingCollection')))
    } else if(detailStatus === 'error'){
        fragment.appendChild(createSchematicsMessage(detailError || communityCopy('unableToLoadCollection')))
    } else if(hasDetail && Array.isArray(detail.items) && detail.items.length > 0){
        detail.items.forEach((entry) => fragment.appendChild(createSchematicCard(entry)))
    } else if(hasDetail){
        fragment.appendChild(createSchematicsMessage(communityCopy('noCollectionSchematics')))
    } else {
        fragment.appendChild(createSchematicsMessage(communityCopy('noCollectionSelected')))
    }
    schematicsCollectionsBrowseDetailGrid.appendChild(fragment)
}

async function openCollectionsBrowseDetail(id){
    if(!id){
        return
    }
    if(collectionsBrowseDetailFetchController){
        collectionsBrowseDetailFetchController.abort()
    }
    collectionsBrowseDetailFetchController = new AbortController()
    const requestId = ++collectionsBrowseDetailRequestId
    const opened = openCollectionsBrowseDetailModal()
    if(!opened){
        return
    }
    const activeId = String(id)
    schematicsCollectionsBrowseDetailActiveId = activeId
    schematicsCollectionsBrowseState = {
        ...schematicsCollectionsBrowseState,
        detail: null,
        detailStatus: 'loading',
        detailError: null
    }
    renderCollectionsBrowseDetail()
    const base = await resolveSchematicsApiBase()
    if(requestId !== collectionsBrowseDetailRequestId){
        return
    }
    if(!base){
        if(schematicsCollectionsBrowseDetailActiveId !== activeId){
            return
        }
        schematicsCollectionsBrowseState = {
            ...schematicsCollectionsBrowseState,
            detailStatus: 'error',
            detailError: communityCopy('notConfigured')
        }
        renderCollectionsBrowseDetail()
        return
    }
    await ensureSchematicsAuthSession(base)
    if(requestId !== collectionsBrowseDetailRequestId){
        return
    }
    try {
        const response = await fetch(`${base.replace(/\/+$/, '')}/v1/collections/${encodeURIComponent(id)}`, {
            method: 'GET',
            signal: collectionsBrowseDetailFetchController.signal,
            headers: { 'Accept': 'application/json', ...getSchematicsAuthHeaders() }
        })
        if(!response.ok){
            throw new Error(`HTTP ${response.status}`)
        }
        const data = await response.json()
        if(requestId !== collectionsBrowseDetailRequestId || schematicsCollectionsBrowseDetailActiveId !== activeId){
            return
        }
        schematicsCollectionsBrowseState = {
            ...schematicsCollectionsBrowseState,
            detail: data,
            detailStatus: 'ready',
            detailError: null
        }
        renderCollectionsBrowseDetail()
        if(data?.id && !collectionViewRecorded.has(data.id)){
            markCollectionViewRecorded(data.id)
            recordCollectionView(data).catch((err) => {
                loggerLanding.warn('Failed to record browse collection view.', err)
            })
        }
    } catch (err) {
        if(err.name === 'AbortError'){
            return
        }
        loggerLanding.warn('Failed to load collection detail.', err)
        if(requestId !== collectionsBrowseDetailRequestId || schematicsCollectionsBrowseDetailActiveId !== activeId){
            return
        }
        schematicsCollectionsBrowseState = {
            ...schematicsCollectionsBrowseState,
            detailStatus: 'error',
            detailError: communityCopy('unableToLoadCollection'),
            detail: null
        }
        renderCollectionsBrowseDetail()
    }
}

function renderCollectionsBrowse(){
    if(!schematicsCollectionsBrowseList){
        return
    }
    if(schematicsCollectionsBrowseCount){
        const total = schematicsCollectionsBrowseState.total || schematicsCollectionsBrowseState.items.length
        schematicsCollectionsBrowseCount.textContent = `${total}`
    }
    schematicsCollectionsBrowseList.innerHTML = ''
    const fragment = document.createDocumentFragment()
    if(schematicsCollectionsBrowseState.status === 'loading'){
        fragment.appendChild(createSchematicsMessage(communityCopy('loadingCollections')))
    } else if(schematicsCollectionsBrowseState.status === 'error' && schematicsCollectionsBrowseState.error){
        fragment.appendChild(createSchematicsMessage(schematicsCollectionsBrowseState.error))
    } else if(schematicsCollectionsBrowseState.items.length === 0){
        fragment.appendChild(createSchematicsMessage(communityCopy('noCollections')))
    } else {
        schematicsCollectionsBrowseState.items.forEach((collection) => {
            fragment.appendChild(createCollectionBrowseCard(collection))
        })
    }
    schematicsCollectionsBrowseList.appendChild(fragment)
    if(schematicsCollectionsBrowseDetailOpen){
        renderCollectionsBrowseDetail()
    }
    updateCollectionsBrowsePager()
}

function scheduleCollectionsBrowseFetch(){
    if(schematicsCollectionsBrowseTimer){
        clearTimeout(schematicsCollectionsBrowseTimer)
    }
    schematicsCollectionsBrowseTimer = setTimeout(() => {
        fetchCollectionsBrowse({ page: 1 })
    }, 180)
}

async function fetchCollectionsBrowse({ page, query, sort, mine } = {}){
    if(collectionsBrowseFetchController){
        collectionsBrowseFetchController.abort()
    }
    collectionsBrowseFetchController = new AbortController()
    const requestId = ++collectionsBrowseRequestId
    schematicsCollectionsBrowseState = {
        ...schematicsCollectionsBrowseState,
        status: 'loading',
        error: null
    }
    renderCollectionsBrowse()

    const base = await resolveSchematicsApiBase()
    if(requestId !== collectionsBrowseRequestId){
        return
    }
    if(!base){
        schematicsCollectionsBrowseState = {
            ...schematicsCollectionsBrowseState,
            status: 'error',
            error: communityCopy('notConfigured'),
            items: []
        }
        renderCollectionsBrowse()
        return
    }
    await ensureSchematicsAuthSession(base)
    if(requestId !== collectionsBrowseRequestId){
        return
    }
    const nextPage = Number.isFinite(Number(page)) ? Math.max(1, Number(page)) : schematicsCollectionsBrowseState.page
    const nextQuery = typeof query === 'string' ? query : (schematicsCollectionsSearchInput?.value?.trim() || '')
    const nextSort = sort || schematicsCollectionsBrowseState.sort
    const nextMine = typeof mine === 'boolean' ? mine : Boolean(schematicsCollectionsMineToggle?.checked)
    const nextCreator = schematicsCollectionsCreatorInput?.value?.trim() || ''
    const calculatedPageSize = computeGridPageSize(schematicsCollectionsBrowseList)
    const limit = calculatedPageSize || schematicsCollectionsBrowseState.pageSize || SCHEMATICS_PAGE_SIZE_FALLBACK
    const effectivePage = calculatedPageSize && calculatedPageSize !== schematicsCollectionsBrowseState.pageSize ? 1 : nextPage
    const offset = (effectivePage - 1) * limit
    const params = new URLSearchParams()
    params.set('limit', String(limit))
    params.set('offset', String(offset))
    if(nextQuery){
        params.set('query', nextQuery)
    }
    if(nextSort){
        params.set('sort', nextSort)
    }
    if(nextMine){
        params.set('mine', 'true')
    } else {
        params.set('visibility', 'public')
    }
    if(nextCreator){
        params.set('creator', nextCreator)
    }
    try {
        const response = await fetch(`${base.replace(/\/+$/, '')}/v1/collections?${params.toString()}`, {
            method: 'GET',
            signal: collectionsBrowseFetchController.signal,
            headers: { 'Accept': 'application/json', ...getSchematicsAuthHeaders() }
        })
        if(!response.ok){
            throw new Error(`HTTP ${response.status}`)
        }
        const data = await response.json()
        if(requestId !== collectionsBrowseRequestId){
            return
        }
        const items = Array.isArray(data?.items) ? data.items : []
        schematicsCollectionsBrowseState = {
            ...schematicsCollectionsBrowseState,
            status: 'ready',
            error: null,
            items,
            total: Number.isFinite(Number(data?.total)) ? Number(data.total) : items.length,
            page: effectivePage,
            pageSize: limit,
            query: nextQuery,
            sort: nextSort,
            mine: nextMine
        }
        renderCollectionsBrowse()
    } catch (err) {
        if(err.name === 'AbortError'){
            return
        }
        loggerLanding.warn('Failed to load collections browse.', err)
        if(requestId !== collectionsBrowseRequestId){
            return
        }
        schematicsCollectionsBrowseState = {
            ...schematicsCollectionsBrowseState,
            status: 'error',
            error: communityCopy('unableToLoadCollection'),
            items: []
        }
        renderCollectionsBrowse()
    }
}

function closeCollectionsPanel(){
    if(!schematicsCollectionsPanel || !schematicsContent){
        return
    }
    if(collectionsListFetchController){
        collectionsListFetchController.abort()
    }
    if(collectionsDetailFetchController){
        collectionsDetailFetchController.abort()
    }
    schematicsCollectionsOpen = false
    schematicsCollectionsState = {
        ...schematicsCollectionsState,
        pickerSchematicId: null,
        view: 'list',
        detail: null
    }
    schematicsCollectionsPanel.removeAttribute('data-open')
    schematicsCollectionsPanel.setAttribute('aria-hidden', 'true')
    schematicsContent.removeAttribute('collections-open')
}

function renderCollectionsPanel(){
    if(!schematicsCollectionsList || !schematicsCollectionsCount || !schematicsCollectionsTitle){
        return
    }
    const total = schematicsCollectionsState.total || schematicsCollectionsState.items.length
    schematicsCollectionsCount.textContent = `${total} collections`
    if(schematicsCollectionsTabPublic){
        schematicsCollectionsTabPublic.classList.toggle('primary', schematicsCollectionsState.filter === 'public')
    }
    if(schematicsCollectionsTabMine){
        schematicsCollectionsTabMine.classList.toggle('primary', schematicsCollectionsState.filter === 'mine')
    }
    if(schematicsCollectionsDetail){
        schematicsCollectionsDetail.hidden = schematicsCollectionsState.view !== 'detail'
    }
    if(schematicsCollectionsList){
        schematicsCollectionsList.hidden = schematicsCollectionsState.view === 'detail'
    }
    if(schematicsCollectionsList){
        schematicsCollectionsList.innerHTML = ''
    }
    const fragment = document.createDocumentFragment()
    if(schematicsCollectionsState.status === 'loading'){
        fragment.appendChild(createSchematicsMessage(communityCopy('loadingCollections')))
    } else if(schematicsCollectionsState.status === 'error' && schematicsCollectionsState.error){
        fragment.appendChild(createSchematicsMessage(schematicsCollectionsState.error))
    } else if(schematicsCollectionsState.items.length === 0){
        fragment.appendChild(createSchematicsMessage(communityCopy('noCollections')))
    } else {
        schematicsCollectionsState.items.forEach((collection) => {
            fragment.appendChild(createCollectionCard(collection))
        })
    }
    if(schematicsCollectionsList){
        schematicsCollectionsList.appendChild(fragment)
    }
}

function renderCollectionDetail(){
    if(!schematicsCollectionsDetail || !schematicsCollectionsDetailGrid || !schematicsCollectionsDetailTitle || !schematicsCollectionsDetailMeta){
        return
    }
    const detail = schematicsCollectionsState.detail
    if(!detail){
        schematicsCollectionsDetail.hidden = true
        return
    }
    schematicsCollectionsDetail.hidden = false
    schematicsCollectionsDetailTitle.textContent = detail.name || communityCopy('collection')
    const engagement = new CommunityEngagement(detail)
    const likesText = formatEngagementCount(engagement.getLikes())
    const viewsText = formatEngagementCount(engagement.getViews())
    schematicsCollectionsDetailMeta.textContent = `${detail.items?.length || 0} schematics - ${likesText} likes - ${viewsText} views`
    if(schematicsCollectionsDetailDelete){
        const userId = getCurrentUserId()
        const isOwner = Boolean(userId && detail.ownerId && Number(detail.ownerId) === Number(userId))
        schematicsCollectionsDetailDelete.style.display = isOwner ? 'inline-flex' : 'none'
    }
    schematicsCollectionsDetailGrid.innerHTML = ''
    const fragment = document.createDocumentFragment()
    if(Array.isArray(detail.items) && detail.items.length > 0){
        detail.items.forEach((entry) => {
            fragment.appendChild(createSchematicCard(entry))
        })
    } else {
        fragment.appendChild(createSchematicsMessage(communityCopy('noCollectionSchematics')))
    }
    schematicsCollectionsDetailGrid.appendChild(fragment)
}

function createCollectionCard(collection){
    const card = document.createElement('button')
    card.type = 'button'
    card.className = 'schematicsCollectionCard'
    card.setAttribute('data-collection-id', collection.id)

    const coverUrl = resolveCollectionCoverUrl(collection)
    const cover = createGridEntryMedia({
        className: 'schematicsCollectionCover',
        imageUrl: coverUrl,
        alt: `${collection.name || 'Collection'} cover`,
        fallbackSvg: COLLECTION_PREVIEW_SVG,
        imageClass: 'schematicsCollectionCoverImage'
    })
    if(!coverUrl){
        cover.classList.add('empty')
    }

    const name = document.createElement('span')
    name.className = 'schematicsCollectionName'
    name.textContent = collection.name || communityCopy('collection')

    const meta = document.createElement('span')
    meta.className = 'schematicsCollectionMeta'
    meta.textContent = `${collection.itemCount || 0} schematics - ${collection.visibility || 'public'}`

    const engagement = new CommunityEngagement(collection).createRow({
        className: 'schematicEngagement schematicsCollectionEngagement'
    })

    const desc = document.createElement('span')
    desc.className = 'schematicsCollectionMeta'
    desc.textContent = collection.description || ''

    card.appendChild(cover)
    card.appendChild(name)
    card.appendChild(meta)
    card.appendChild(engagement)
    if(collection.description){
        card.appendChild(desc)
    }

    card.addEventListener('click', async () => {
        if(schematicsCollectionsState.pickerSchematicId){
            await addSchematicToCollection(collection.id, schematicsCollectionsState.pickerSchematicId)
            closeCollectionsPanel()
            return
        }
        openCollectionDetail(collection.id)
    })
    return card
}

async function fetchCollectionsList(filter, openCollectionId){
    if(collectionsListFetchController){
        collectionsListFetchController.abort()
    }
    collectionsListFetchController = new AbortController()
    const requestId = ++collectionsListRequestId
    schematicsCollectionsState = {
        ...schematicsCollectionsState,
        status: 'loading',
        error: null,
        filter
    }
    renderCollectionsPanel()

    const base = await resolveSchematicsApiBase()
    if(requestId !== collectionsListRequestId){
        return
    }
    if(!base){
        schematicsCollectionsState = {
            ...schematicsCollectionsState,
            status: 'error',
            error: communityCopy('notConfigured'),
            items: [],
            total: 0
        }
        renderCollectionsPanel()
        return
    }
    await ensureSchematicsAuthSession(base)
    if(requestId !== collectionsListRequestId){
        return
    }
    const params = new URLSearchParams()
    if(filter === 'mine'){
        params.set('mine', 'true')
    } else {
        params.set('visibility', 'public')
    }
    params.set('limit', '60')
    params.set('offset', '0')
    try {
        const response = await fetch(`${base.replace(/\/+$/, '')}/v1/collections?${params.toString()}`, {
            method: 'GET',
            signal: collectionsListFetchController.signal,
            headers: { 'Accept': 'application/json', ...getSchematicsAuthHeaders() }
        })
        if(!response.ok){
            throw new Error(`HTTP ${response.status}`)
        }
        const data = await response.json()
        if(requestId !== collectionsListRequestId){
            return
        }
        const items = Array.isArray(data?.items) ? data.items : []
        schematicsCollectionsState = {
            ...schematicsCollectionsState,
            status: 'ready',
            error: null,
            items,
            total: Number.isFinite(Number(data?.total)) ? Number(data.total) : items.length
        }
        renderCollectionsPanel()
        if(openCollectionId){
            openCollectionDetail(openCollectionId)
        }
    } catch (err) {
        if(err.name === 'AbortError'){
            return
        }
        loggerLanding.warn('Failed to load collections.', err)
        if(requestId !== collectionsListRequestId){
            return
        }
        schematicsCollectionsState = {
            ...schematicsCollectionsState,
            status: 'error',
            error: communityCopy('unableToLoadCollection'),
            items: [],
            total: 0
        }
        renderCollectionsPanel()
    }
}

async function openCollectionDetail(id){
    if(!id){
        return
    }
    if(collectionsDetailFetchController){
        collectionsDetailFetchController.abort()
    }
    collectionsDetailFetchController = new AbortController()
    const requestId = ++collectionsDetailRequestId
    const base = await resolveSchematicsApiBase()
    if(requestId !== collectionsDetailRequestId){
        return
    }
    if(!base){
        return
    }
    await ensureSchematicsAuthSession(base)
    if(requestId !== collectionsDetailRequestId){
        return
    }
    try {
        const response = await fetch(`${base.replace(/\/+$/, '')}/v1/collections/${encodeURIComponent(id)}`, {
            method: 'GET',
            signal: collectionsDetailFetchController.signal,
            headers: { 'Accept': 'application/json', ...getSchematicsAuthHeaders() }
        })
        if(!response.ok){
            throw new Error(`HTTP ${response.status}`)
        }
        const data = await response.json()
        if(requestId !== collectionsDetailRequestId){
            return
        }
        schematicsCollectionsState = {
            ...schematicsCollectionsState,
            view: 'detail',
            detail: data,
            pickerSchematicId: null
        }
        renderCollectionsPanel()
        renderCollectionDetail()
        if(data?.id && !collectionViewRecorded.has(data.id)){
            markCollectionViewRecorded(data.id)
            recordCollectionView(data).catch((err) => {
                loggerLanding.warn('Failed to record collection detail view.', err)
            })
        }
    } catch (err) {
        if(err.name === 'AbortError'){
            return
        }
        loggerLanding.warn('Failed to load collection detail.', err)
    }
}

async function createCollection(){
    const name = schematicsCollectionsName?.value?.trim()
    if(!name){
        return
    }
    const description = schematicsCollectionsDescription?.value?.trim() || ''
    const visibility = schematicsCollectionsVisibility?.value || 'public'
    const creatorName = getCurrentCreatorName()
    const base = await resolveSchematicsApiBase()
    if(!base){
        return
    }
    await ensureSchematicsAuthSession(base)
    try {
        const response = await fetch(`${base.replace(/\/+$/, '')}/v1/collections`, {
            method: 'POST',
            headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', ...getSchematicsAuthHeaders() },
            body: JSON.stringify({
                name,
                description,
                visibility,
                creator: creatorName
            })
        })
        if(!response.ok){
            throw new Error(`HTTP ${response.status}`)
        }
        const created = await response.json()
        schematicsCollectionsName.value = ''
        schematicsCollectionsDescription.value = ''
        if(schematicsCollectionsCreate){
            schematicsCollectionsCreate.hidden = true
        }
        if(schematicsCollectionsState.pickerSchematicId && created?.id){
            await addSchematicToCollection(created.id, schematicsCollectionsState.pickerSchematicId)
            closeCollectionsPanel()
            return
        }
        fetchCollectionsList('mine')
        if(schematicsCreatorOpen && schematicsCreatorState.creator){
            const current = schematicsCreatorState.creator.trim().toLowerCase()
            const createdFor = String(creatorName || '').trim().toLowerCase()
            if(current && createdFor && current === createdFor){
                fetchCreatorCollections(schematicsCreatorState.creator)
            }
        }
    } catch (err) {
        loggerLanding.warn('Failed to create collection.', err)
    }
}

async function deleteCollectionById(id){
    if(!id){
        return
    }
    const base = await resolveSchematicsApiBase()
    if(!base){
        return
    }
    await ensureSchematicsAuthSession(base)
    try {
        const response = await fetch(`${base.replace(/\/+$/, '')}/v1/collections/${encodeURIComponent(id)}`, {
            method: 'DELETE',
            headers: { 'Accept': 'application/json', ...getSchematicsAuthHeaders() }
        })
        if(!response.ok){
            throw new Error(`HTTP ${response.status}`)
        }
        schematicsCollectionsState = {
            ...schematicsCollectionsState,
            view: 'list',
            detail: null
        }
        fetchCollectionsList(schematicsCollectionsState.filter)
    } catch (err) {
        loggerLanding.warn('Failed to delete collection.', err)
    }
}

async function addSchematicToCollection(collectionId, schematicId){
    if(!collectionId || !schematicId){
        return
    }
    const base = await resolveSchematicsApiBase()
    if(!base){
        return
    }
    await ensureSchematicsAuthSession(base)
    try {
        const response = await fetch(`${base.replace(/\/+$/, '')}/v1/collections/${encodeURIComponent(collectionId)}/items`, {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                ...getSchematicsAuthHeaders()
            },
            body: JSON.stringify({ schematicId })
        })
        if(!response.ok){
            throw new Error(`HTTP ${response.status}`)
        }
        if(schematicsCollectionsOpen){
            fetchCollectionsList(schematicsCollectionsState.filter)
        }
        if(schematicsCollectionsState.view === 'detail' && schematicsCollectionsState.detail?.id === collectionId){
            await openCollectionDetail(collectionId)
        }
        if(schematicsCollectionsBrowseDetailOpen && schematicsCollectionsBrowseState.detail?.id === collectionId){
            await openCollectionsBrowseDetail(collectionId)
        }
    } catch (err) {
        loggerLanding.warn('Failed to add schematic to collection.', err)
    }
}

