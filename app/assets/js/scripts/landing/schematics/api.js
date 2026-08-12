let schematicsApiBaseLogged = false
let schematicsServiceConfig = null
let schematicsApiClient = null
let communityServiceConfig = null
let communityApiClient = null
let communityCapabilities = null

async function resolveSchematicsServiceConfig(){
    const envBase = String(process.env.HELIOS_SCHEMATICS_API_URL || '').trim()
    const distro = await DistroAPI.getDistribution()
    const raw = distro?.rawDistribution?.schematics || {}
    schematicsServiceConfig = {
        schemaVersion: Number(raw.schemaVersion || 2),
        enabled: envBase ? true : raw.enabled === true,
        apiBaseUrl: (envBase || raw.apiBaseUrl || '').replace(/\/+$/, ''),
        features: {
            core: raw.features?.core !== false,
            collections: raw.features?.collections === true,
            creators: raw.features?.creators === true
        },
        allowedVisibilities: Array.isArray(raw.allowedVisibilities) ? raw.allowedVisibilities : ['public']
    }
    return schematicsServiceConfig
}

async function resolveCommunityServiceConfig(){
    const envBase = String(process.env.HELIOS_SCHEMATICS_API_URL || '').trim()
    const distro = await DistroAPI.getDistribution()
    const rawDistribution = distro?.rawDistribution || {}
    const raw = rawDistribution.community || {}
    const fallback = rawDistribution.schematics || {}
    communityServiceConfig = {
        schemaVersion: Number(raw.schemaVersion || 1),
        enabled: envBase ? true : (raw.enabled === true || (!rawDistribution.community && fallback.enabled === true)),
        apiBaseUrl: (envBase || raw.apiBaseUrl || fallback.apiBaseUrl || '').replace(/\/+$/, '')
    }
    return communityServiceConfig
}

async function getCommunityApiClient(){
    const service = await resolveCommunityServiceConfig()
    const base = service.enabled && service.schemaVersion === 1 ? service.apiBaseUrl : null
    if(!base) return null
    if(!communityApiClient || communityApiClient.baseUrl !== base){
        communityApiClient = new CommunityApiClient({
            baseUrl: base,
            cachePath: pathUtil.join(SCHEMATICS_CACHE_DIR, 'community-catalog-v1.json'),
            timeoutMs: 10000
        })
        communityCapabilities = null
    }
    return communityApiClient
}

async function resolveCommunityCapabilities(options = {}){
    if(communityCapabilities && !options.force) return communityCapabilities
    const client = await getCommunityApiClient()
    if(!client) return null
    communityCapabilities = await client.capabilities({ signal: options.signal })
    return communityCapabilities
}

function schematicsFeatureEnabled(name){
    return schematicsServiceConfig?.enabled === true && schematicsServiceConfig?.features?.[name] === true
}

async function resolveSchematicsApiBase(){
    try {
        const service = await resolveSchematicsServiceConfig()
        const resolved = service.enabled && service.schemaVersion === 2 ? service.apiBaseUrl || null : null
        if(!schematicsApiBaseLogged && loggerLanding){
            loggerLanding.info('[schematics] apiBase resolution.', {
                enabled: service.enabled,
                schemaVersion: service.schemaVersion,
                configured: Boolean(resolved)
            })
            schematicsApiBaseLogged = true
        }
        return resolved
    } catch (err) {
        loggerLanding.warn('Failed to resolve schematics api base.', err)
        return null
    }
}

async function getSchematicsApiClient(){
    const base = await resolveSchematicsApiBase()
    if(!base) return null
    if(!schematicsApiClient || schematicsApiClient.baseUrl !== base){
        schematicsApiClient = new SchematicApiClient({
            baseUrl: base,
            cachePath: pathUtil.join(SCHEMATICS_CACHE_DIR, 'catalog-v2.json'),
            timeoutMs: 10000
        })
    }
    return schematicsApiClient
}

async function schematicApiRequest(pathname, options = {}){
    const client = await getSchematicsApiClient()
    if(!client) throw new SchematicApiError(communityCopy('notConfigured'), { code: 'not_configured' })
    const headers = { ...(options.headers || {}), ...getSchematicsAuthHeaders() }
    return (await client.request(pathname, { ...options, headers })).data
}

function getSchematicsAuthHeaders(){
    const token = AccessGate.getSessionToken()
    if(!token){
        return {}
    }
    return { Authorization: `Bearer ${token}` }
}

function getCurrentUserId(){
    const profile = AccessGate.getProfile()
    return profile?.id ?? null
}

function getCurrentCreatorName(){
    const account = ConfigManager.getSelectedAccount()
    if(account?.displayName){
        return account.displayName
    }
    if(account?.username){
        return account.username
    }
    const profile = AccessGate.getProfile()
    if(profile?.displayName){
        return profile.displayName
    }
    if(profile?.name){
        return profile.name
    }
    return profile?.username || profile?.id || communityCopy('creator')
}

function isSchematicsAdmin(){
    return AccessGate.hasAccess({ entitlement: 'schematics:admin' })
        || AccessGate.hasAccess({ entitlement: 'admin' })
}

let schematicsAuthExchangePromise = null

async function ensureSchematicsAuthSession(baseOverride){
    if(AccessGate.getSessionToken()){
        return
    }
    if(schematicsAuthExchangePromise){
        return schematicsAuthExchangePromise
    }
    const authUser = ConfigManager.getSelectedAccount()
    const accessToken = authUser?.accessToken
    if(!accessToken){
        return
    }
    schematicsAuthExchangePromise = (async () => {
        try {
            const base = baseOverride || await resolveSchematicsApiBase()
            if(!base){
                return
            }
            const response = await fetch(`${base.replace(/\/+$/, '')}/v1/auth/minecraft`, {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ accessToken })
            })
            if(!response.ok){
                return
            }
            const data = await response.json()
            if(data?.token){
                AccessGate.setSessionToken(data.token)
            }
            if(Array.isArray(data?.entitlements)){
                AccessGate.setEntitlements(data.entitlements)
            }
            if(data?.profile){
                AccessGate.setProfile({
                    id: data.userId || null,
                    displayName: data.profile.displayName || null,
                    avatarUrl: data.profile.avatarUrl || null
                })
            }
        } catch (err) {
            loggerLanding.warn('Failed to exchange Minecraft token for session.', err)
        } finally {
            if(typeof updateSchematicsAdminVisibility === 'function'){
                updateSchematicsAdminVisibility()
            }
            schematicsAuthExchangePromise = null
        }
    })()
    return schematicsAuthExchangePromise
}

function getSchematicsFilters(){
    return {
        tags: schematicsTagsInput?.value?.trim() || '',
        creator: schematicsCreatorInput?.value?.trim() || ''
    }
}

function getDetailThumbnailSize(){
    let aspect = 1.6
    if(schematicsDetailPreview){
        const rect = schematicsDetailPreview.getBoundingClientRect()
        if(rect.width > 0 && rect.height > 0){
            aspect = rect.width / rect.height
        }
    }
    const width = 320
    const height = Math.max(120, Math.round(width / aspect))
    return { width, height }
}

function getDetailThumbnailSizes(){
    const medium = getDetailThumbnailSize()
    const tinyWidth = Math.max(120, Math.round(medium.width / 2))
    const tinyHeight = Math.max(60, Math.round(medium.height / 2))
    return {
        medium,
        tiny: { width: tinyWidth, height: tinyHeight }
    }
}

async function saveSchematicEdits(entry, edits = null){
    if(!entry?.id){
        return null
    }
    const base = await resolveSchematicsApiBase()
    if(!base){
        return null
    }
    await ensureSchematicsAuthSession(base)

    const source = edits && typeof edits === 'object' ? edits : entry
    let tags = null
    if(Array.isArray(source.tags)){
        tags = source.tags.join(', ')
    } else if(typeof source.tags === 'string'){
        tags = source.tags.trim() || null
    }
    const payload = {
        name: typeof source.name === 'string' ? source.name.trim() || null : null,
        description: typeof source.description === 'string' ? source.description.trim() : null,
        tags,
        visibility: typeof source.visibility === 'string' ? source.visibility : null,
        version: typeof source.version === 'string' ? source.version.trim() || null : null
    }
    try {
        const response = await fetch(`${base.replace(/\/+$/, '')}/v1/schematics/${encodeURIComponent(entry.id)}`, {
            method: 'PATCH',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                ...getSchematicsAuthHeaders()
            },
            body: JSON.stringify(payload)
        })
        if(!response.ok){
            throw new Error(`HTTP ${response.status}`)
        }
        const patchData = await response.json().catch(() => ({}))
        await fetchSchematicsList({
            query: schematicsSearchInput?.value || '',
            sortKey: schematicsSortSelect?.value || SCHEMATICS_SORT_DEFAULT,
            page: schematicsState.page
        })
        const detailData = await fetchSchematicDetail(entry.id)
        const mergedPatch = { ...patchData, ...(detailData || {}) }
        return updateSchematicCaches(entry, mergedPatch)
    } catch (err) {
        loggerLanding.warn('Failed to update schematic.', err)
        return null
    }
}

async function deleteSchematic(entry){
    if(!entry?.id){
        return
    }
    const confirmed = window.confirm(communityCopy('deleteConfirm'))
    if(!confirmed){
        return
    }
    const base = await resolveSchematicsApiBase()
    if(!base){
        return
    }
    await ensureSchematicsAuthSession(base)
    try {
        const response = await fetch(`${base.replace(/\/+$/, '')}/v1/schematics/${encodeURIComponent(entry.id)}`, {
            method: 'DELETE',
            headers: {
                'Accept': 'application/json',
                ...getSchematicsAuthHeaders()
            }
        })
        if(!response.ok){
            throw new Error(`HTTP ${response.status}`)
        }
        closeSchematicDetail()
        await fetchSchematicsList({ query: schematicsSearchInput?.value || '', sortKey: schematicsSortSelect?.value || SCHEMATICS_SORT_DEFAULT, page: 1 })
    } catch (err) {
        loggerLanding.warn('Failed to delete schematic.', err)
    }
}

async function reportSchematic(entry){
    if(!entry?.id){
        return
    }
    const reason = prompt(communityCopy('reportPrompt')) || ''
    const detail = reason.trim()
    const base = await resolveSchematicsApiBase()
    if(!base){
        return
    }
    await ensureSchematicsAuthSession(base)
    try {
        await fetch(`${base.replace(/\/+$/, '')}/v1/schematics/${encodeURIComponent(entry.id)}/report`, {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                ...getSchematicsAuthHeaders()
            },
            body: JSON.stringify({ reason: detail })
        })
    } catch (err) {
        loggerLanding.warn('Failed to report schematic.', err)
    }
}

async function regenerateMissingThumbnails(options){
    const base = await resolveSchematicsApiBase()
    if(!base){
        throw new Error(communityCopy('notConfigured'))
    }
    await ensureSchematicsAuthSession(base)
    const payload = {
        ids: options?.ids?.length ? options.ids : undefined,
        limit: options?.limit,
        offset: options?.offset,
        labels: options?.labels,
        mimes: options?.mimes,
        verifyObjects: options?.verifyObjects,
        repair: options?.repair,
        includeExisting: options?.includeExisting
    }
    const response = await fetch(`${base.replace(/\/+$/, '')}/v1/schematics/thumbnails/regenerate`, {
        method: 'POST',
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            ...getSchematicsAuthHeaders()
        },
        body: JSON.stringify(payload)
    })
    if(!response.ok){
        throw new Error(`HTTP ${response.status}`)
    }
    return response.json()
}

function updateSchematicCaches(entry, patch){
    if(!entry?.id){
        return entry || null
    }
    if(Array.isArray(schematicsState?.items)){
        const nextItems = schematicsState.items.map((item) => {
            if(item?.id !== entry.id){
                return item
            }
            return { ...item, ...patch }
        })
        schematicsState = {
            ...schematicsState,
            items: nextItems
        }
        renderSchematics({ keepDetailOpen: true })
    }
    const current = SCHEMATIC_INDEX.get(entry.id) || entry
    const updated = { ...current, ...patch }
    SCHEMATIC_INDEX.set(entry.id, updated)
    if(SCHEMATIC_DETAIL_CACHE.has(entry.id)){
        const cached = SCHEMATIC_DETAIL_CACHE.get(entry.id)
        SCHEMATIC_DETAIL_CACHE.set(entry.id, { ...cached, ...patch })
    }
    return updated
}

async function toggleSchematicLike(entry){
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
        const response = await fetch(`${base.replace(/\/+$/, '')}/v1/schematics/${encodeURIComponent(entry.id)}/like`, {
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
        return updateSchematicCaches(entry, { likes, liked })
    } catch (err) {
        loggerLanding.warn('Failed to toggle schematic like.', err)
        return null
    }
}

async function recordSchematicView(entry){
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
        const response = await fetch(`${base.replace(/\/+$/, '')}/v1/schematics/${encodeURIComponent(entry.id)}/view`, {
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
        return updateSchematicCaches(entry, { views })
    } catch (err) {
        loggerLanding.warn('Failed to record schematic view.', err)
        return null
    }
}

async function regenerateSchematicThumbnail(entry){
    if(!entry?.id){
        return
    }
    const base = await resolveSchematicsApiBase()
    if(!base){
        return
    }
    await ensureSchematicsAuthSession(base)
    try {
        const renderer = ensureSchematicPreviewRenderer()
        const sizes = getDetailThumbnailSizes()
        const variants = []
        const mimes = ['image/webp', 'image/png']
        for(const [label, size] of Object.entries(sizes)){
            for(const mime of mimes){
                const blob = await capturePreviewBlob(renderer, size.width, size.height, mime)
                if(!blob){
                    continue
                }
                const actualMime = blob.type || mime
                if(mime === 'image/webp' && actualMime !== 'image/webp'){
                    continue
                }
                variants.push({
                    label,
                    mime: actualMime,
                    width: size.width,
                    height: size.height,
                    blob
                })
            }
        }
        if(variants.length === 0){
            throw new Error('Thumbnail capture failed')
        }
        for(const variant of variants){
            const preflight = await fetch(`${base.replace(/\/+$/, '')}/v1/schematics/${encodeURIComponent(entry.id)}/thumbnail/preflight`, {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    ...getSchematicsAuthHeaders()
                },
                body: JSON.stringify({
                    label: variant.label,
                    mime: variant.mime,
                    width: variant.width,
                    height: variant.height,
                    sizeBytes: variant.blob.size
                })
            }).then(res => res.ok ? res.json() : null)
            if(!preflight){
                throw new Error('Thumbnail preflight failed')
            }
            if(preflight.uploadUrl){
                const putRes = await fetch(preflight.uploadUrl, {
                    method: 'PUT',
                    headers: { 'Content-Type': variant.mime },
                    body: variant.blob
                })
                if(!putRes.ok){
                    throw new Error('Thumbnail upload failed')
                }
                await fetch(`${base.replace(/\/+$/, '')}/v1/schematics/${encodeURIComponent(entry.id)}/thumbnail/commit`, {
                    method: 'POST',
                    headers: {
                        'Accept': 'application/json',
                        'Content-Type': 'application/json',
                        ...getSchematicsAuthHeaders()
                    },
                    body: JSON.stringify({
                        label: variant.label,
                        mime: variant.mime,
                        objectKey: preflight.objectKey,
                        width: variant.width,
                        height: variant.height,
                        sizeBytes: variant.blob.size
                    })
                })
            } else {
                const buffer = await variant.blob.arrayBuffer()
                const base64 = Buffer.from(buffer).toString('base64')
                await fetch(`${base.replace(/\/+$/, '')}/v1/schematics/${encodeURIComponent(entry.id)}/thumbnail/commit`, {
                    method: 'POST',
                    headers: {
                        'Accept': 'application/json',
                        'Content-Type': 'application/json',
                        ...getSchematicsAuthHeaders()
                    },
                    body: JSON.stringify({
                        label: variant.label,
                        mime: variant.mime,
                        data: base64,
                        width: variant.width,
                        height: variant.height,
                        sizeBytes: variant.blob.size
                    })
                })
            }
        }
        await fetchSchematicsList({ query: schematicsSearchInput?.value || '', sortKey: schematicsSortSelect?.value || SCHEMATICS_SORT_DEFAULT, page: 1 })
    } catch (err) {
        loggerLanding.warn('Failed to regenerate thumbnail.', err)
    }
}

async function fetchSchematicsList({ query, sortKey, page, append = false } = {}){
    const requestedPage = Number.isFinite(Number(page)) ? Math.max(1, Number(page)) : 1
    const shouldAppend = append === true || requestedPage > 1
    if(shouldAppend && (!schematicsState.nextCursor || schematicsState.loadingMore)) return

    const normalizedQuery = normalizeSchematicQuery(query ?? schematicsSearchInput?.value ?? schematicsState.query)
    const requestedSort = sortKey || schematicsSortSelect?.value || schematicsState.sortKey
    const nextSortKey = requestedSort === 'recent' || String(requestedSort).includes('release') ? 'recent' : 'popular'
    const filters = getSchematicsFilters()
    const calculatedPageSize = computeGridPageSize(schematicsGrid)
    const limit = Math.max(12, calculatedPageSize || schematicsState.pageSize || SCHEMATICS_PAGE_SIZE_FALLBACK)

    if(!shouldAppend && schematicsFetchController) schematicsFetchController.abort()
    schematicsFetchController = new AbortController()
    const controller = schematicsFetchController
    schematicsState = {
        ...schematicsState,
        status: shouldAppend ? schematicsState.status : 'loading',
        loadingMore: shouldAppend,
        error: null,
        items: shouldAppend ? schematicsState.items : [],
        total: shouldAppend ? schematicsState.total : 0,
        query: normalizedQuery,
        sortKey: nextSortKey,
        pageSize: limit,
        filters,
        nextCursor: shouldAppend ? schematicsState.nextCursor : null
    }
    renderSchematics()

    const client = await getCommunityApiClient()
    if(!client){
        schematicsState = {
            ...schematicsState,
            status: 'error',
            loadingMore: false,
            error: communityCopy('notConfigured')
        }
        renderSchematics()
        return
    }
    const base = client.baseUrl
    await ensureSchematicsAuthSession(base)
    if(typeof updateSchematicsAdminVisibility === 'function') updateSchematicsAdminVisibility()

    const params = new URLSearchParams()
    params.set('category', schematicsState.category)
    params.set('sort', nextSortKey)
    params.set('limit', String(limit))
    if(normalizedQuery) params.set('query', normalizedQuery)
    if(filters.tags) params.set('tags', filters.tags)
    if(filters.creator) params.set('creator', filters.creator)
    if(shouldAppend && schematicsState.nextCursor) params.set('cursor', schematicsState.nextCursor)
    if(schematicsState.category === 'schematics' && schematicsMineToggle?.checked) params.set('mine', 'true')

    try {
        const capabilities = await resolveCommunityCapabilities({ signal: controller.signal }).catch(() => null)
        const distro = await DistroAPI.getDistribution()
        const enabledTypes = communityContentRegistry
            ? await communityContentRegistry.enabled({ rawDistribution: distro?.rawDistribution || {}, capabilities })
            : []
        syncCommunityCategoryFilters(enabledTypes)
        const enabledById = new Map(enabledTypes.map(definition => [definition.id, definition]))
        const data = await client.catalog(params, {
            signal: controller.signal,
            headers: getSchematicsAuthHeaders()
        })
        const incoming = (Array.isArray(data?.items) ? data.items : [])
            .map(entry => enabledById.get(entry.type)?.normalize(entry))
            .filter(Boolean)
        const combined = shouldAppend ? [...schematicsState.items, ...incoming] : incoming
        const items = [...new Map(combined.map(entry => [entry.communityKey || `schematics:${entry.id}`, entry])).values()]
        schematicsState = {
            ...schematicsState,
            status: 'ready',
            loadingMore: false,
            error: data.offline ? communityCopy('offlineCatalog') : null,
            items,
            total: items.length,
            nextCursor: data?.nextCursor || null,
            offline: data?.offline === true,
            cached: data?.cached === true,
            page: shouldAppend ? schematicsState.page + 1 : 1,
            apiBase: base
        }
        updateSchematicIndex(items)
        renderSchematics()
        scheduleCommunityProgressiveLoad()
    } catch (err) {
        if(err.name === 'AbortError' || controller.signal.aborted) return
        loggerLanding.warn('Failed to load Community catalog.', err)
        schematicsState = {
            ...schematicsState,
            status: schematicsState.items.length > 0 ? 'ready' : 'error',
            loadingMore: false,
            error: schematicsState.items.length > 0 ? communityCopy('offlineCatalog') : communityCopy('unavailableNoCache')
        }
        renderSchematics()
    }
}

async function fetchSchematicDetail(id, options = {}){
    if(!id){
        return null
    }
    if(SCHEMATIC_DETAIL_CACHE.has(id)){
        return SCHEMATIC_DETAIL_CACHE.get(id)
    }
    const base = await resolveSchematicsApiBase()
    if(!base){
        return null
    }
    await ensureSchematicsAuthSession(base)
    try {
        const data = await schematicApiRequest(`/v1/schematics/${encodeURIComponent(id)}`, {
            method: 'GET',
            headers: { Accept: 'application/json' },
            signal: options.signal
        })
        if(data?.id){
            SCHEMATIC_DETAIL_CACHE.set(id, data)
            SCHEMATIC_INDEX.set(id, data)
        }
        return data
    } catch (err) {
        loggerLanding.warn('Failed to load schematic detail.', err)
        return null
    }
}

function getLikesValue(entry){
    return CommunityEngagement.parseValue(CommunityEngagement.resolveMetric(entry, 'likes'))
}

function getReleaseTimestamp(entry){
    if(!entry?.release){
        return 0
    }
    const ts = new Date(entry.release).getTime()
    return Number.isNaN(ts) ? 0 : ts
}

function compareSchematicName(a, b){
    return (a.name || '').localeCompare(b.name || '')
}

function formatSchematicDate(value){
    if(!value){
        return '--'
    }
    const date = new Date(value)
    if(Number.isNaN(date.getTime())){
        return '--'
    }
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function formatDownloadCount(value){
    if(value == null || Number.isNaN(Number(value))){
        return '--'
    }
    const num = Number(value)
    if(num >= 1000000){
        return `${(num / 1000000).toFixed(1)}M`
    }
    if(num >= 1000){
        return `${(num / 1000).toFixed(1)}K`
    }
    return num.toString()
}

function getSchematicById(id){
    return SCHEMATIC_INDEX.get(id) || SCHEMATIC_INDEX.get(`schematics:${id}`)
}

function getCommunityEntryByKey(key){
    return SCHEMATIC_INDEX.get(key) || null
}

async function fetchSchematicFromUrl(url, options = {}){
    if(!url){
        return null
    }
    try {
        const parsed = new URL(url, await resolveSchematicsApiBase())
        const base = new URL(await resolveSchematicsApiBase())
        if(parsed.origin !== base.origin) throw new Error('Refusing schematic URL from an untrusted origin.')
        return await schematicApiRequest(`${parsed.pathname}${parsed.search}`, {
            method: 'GET', headers: { Accept: 'application/json' }, signal: options.signal
        })
    } catch (err) {
        loggerLanding.warn('Failed to load schematic data from url.', err)
        return null
    }
}

async function getNormalizedSchematic(entry, options = {}){
    if(!entry || !entry.id || !Array.isArray(entry.blocks)){
        if(!entry || !entry.id){
            return null
        }
    }
    if(SCHEMATIC_NORMALIZED_CACHE.has(entry.id)){
        return SCHEMATIC_NORMALIZED_CACHE.get(entry.id)
    }
    let rawSchematic = Array.isArray(entry.blocks) ? entry : null
    if(!rawSchematic && entry.schematic){
        rawSchematic = entry.schematic
    }
    if(!rawSchematic){
        const detail = await fetchSchematicDetail(entry.id, options)
        if(detail?.schematic){
            rawSchematic = detail.schematic
        } else if(detail?.schematicUrl){
            const schematicData = await fetchSchematicFromUrl(detail.schematicUrl, options)
            if(schematicData?.blocks){
                rawSchematic = schematicData
            }
        }
    }
    if(!rawSchematic?.blocks){
        return null
    }
    const { schematic } = await normalizeJsonSchematic(rawSchematic, { id: entry.id })
    SCHEMATIC_NORMALIZED_CACHE.set(entry.id, schematic)
    return schematic
}

function resizeCanvasToContainer(canvas, container){
    if(!canvas || !container){
        return { width: 1, height: 1, scale: window.devicePixelRatio || 1 }
    }
    const rect = container.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    const width = Math.max(1, Math.floor(rect.width * dpr))
    const height = Math.max(1, Math.floor(rect.height * dpr))
    if(canvas.width !== width){
        canvas.width = width
    }
    if(canvas.height !== height){
        canvas.height = height
    }
    return { width, height, scale: dpr }
}
