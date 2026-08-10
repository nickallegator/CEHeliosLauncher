let schematicsApiBaseLogged = false

async function resolveSchematicsApiBase(){
    const envBase = process.env.HELIOS_SCHEMATICS_API_URL
    if(envBase){
        if(!schematicsApiBaseLogged && loggerLanding){
            loggerLanding.info('[schematics] apiBase resolved from env.', { apiBaseUrl: envBase })
            schematicsApiBaseLogged = true
        }
        return envBase
    }
    try {
        const distro = await DistroAPI.getDistribution()
        const raw = distro?.rawDistribution
        const distroBase = (raw?.schematics?.apiBaseUrl || '').trim() || null
        const accessBase = (AccessGate.getApiBaseUrl(distro) || '').trim() || null
        const resolved = distroBase || accessBase || null
        if(!schematicsApiBaseLogged && loggerLanding){
            loggerLanding.info('[schematics] apiBase resolution.', {
                distroHasSchematics: Boolean(raw?.schematics),
                distroBase,
                accessBase,
                resolved
            })
            schematicsApiBaseLogged = true
        }
        return resolved
    } catch (err) {
        loggerLanding.warn('Failed to resolve schematics api base.', err)
        return null
    }
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
    return profile?.username || profile?.id || 'Creator'
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
    const confirmed = window.confirm('Delete this schematic? This cannot be undone.')
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
    const reason = prompt('Report reason (optional):') || ''
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
        throw new Error('Schematics service not configured.')
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
        await fetchSchematicsList({ query: schematicsSearchInput?.value || '', sortKey: schematicsSortSelect?.value || SCHEMATICS_SORT_DEFAULT, page: schematicsState.page })
    } catch (err) {
        loggerLanding.warn('Failed to regenerate thumbnail.', err)
    }
}

async function fetchSchematicsList({ query, sortKey, page } = {}){
    const normalizedQuery = normalizeSchematicQuery(query ?? schematicsState.query)
    const nextSortKey = sortKey || schematicsState.sortKey
    const nextPage = Number.isFinite(Number(page)) ? Math.max(1, Number(page)) : schematicsState.page
    const filters = getSchematicsFilters()
    const calculatedPageSize = computeGridPageSize(schematicsGrid)
    const limit = calculatedPageSize || schematicsState.pageSize || SCHEMATICS_PAGE_SIZE_FALLBACK
    const effectivePage = calculatedPageSize && calculatedPageSize !== schematicsState.pageSize ? 1 : nextPage
    if(schematicsFetchController){
        schematicsFetchController.abort()
    }
    schematicsFetchController = new AbortController()
    schematicsState = {
        ...schematicsState,
        status: 'loading',
        error: null,
        query: normalizedQuery,
        sortKey: nextSortKey,
        page: effectivePage,
        pageSize: limit,
        filters
    }
    renderSchematics()

      const base = await resolveSchematicsApiBase()
      if(!base){
          schematicsState = {
              ...schematicsState,
              status: 'error',
              error: 'Schematics service not configured.',
              items: SCHEMATICS_FALLBACK.slice(),
              total: SCHEMATICS_FALLBACK.length
          }
          updateSchematicIndex(schematicsState.items)
          renderSchematics()
          return
      }
      await ensureSchematicsAuthSession(base)
      if(typeof updateSchematicsAdminVisibility === 'function'){
          updateSchematicsAdminVisibility()
      }

      schematicsState = {
          ...schematicsState,
          apiBase: base
      }

    const sortParam = nextSortKey.includes('release') ? 'release' : 'likes'
    const offset = (effectivePage - 1) * limit
    const params = new URLSearchParams()
    params.set('query', normalizedQuery)
    params.set('sort', sortParam)
    params.set('limit', String(limit))
    params.set('offset', String(offset))
    if(filters.tags){
        params.set('tags', filters.tags)
    }
    if(filters.creator){
        params.set('creator', filters.creator)
    }
    if(schematicsMineToggle?.checked){
        params.set('mine', 'true')
    }
    const url = `${base.replace(/\/+$/, '')}/v1/schematics?${params.toString()}`

      try {
          const response = await fetch(url, {
              method: 'GET',
              signal: schematicsFetchController.signal,
              headers: { 'Accept': 'application/json', ...getSchematicsAuthHeaders() }
          })
        if(!response.ok){
            throw new Error(`HTTP ${response.status}`)
        }
        const data = await response.json()
        const items = Array.isArray(data?.items) ? data.items : []
        schematicsState = {
            ...schematicsState,
            status: 'ready',
            error: null,
            items,
            total: Number.isFinite(Number(data?.total)) ? Number(data.total) : items.length,
            page: effectivePage,
            pageSize: limit
        }
        updateSchematicIndex(items)
        renderSchematics()
        updateSchematicsPagination()
    } catch (err) {
        if(err.name === 'AbortError'){
            return
        }
        loggerLanding.warn('Failed to load schematics list.', err)
        schematicsState = {
            ...schematicsState,
            status: 'error',
            error: 'Unable to load schematics. Showing cached set.',
            items: SCHEMATICS_FALLBACK.slice(),
            total: SCHEMATICS_FALLBACK.length
        }
        updateSchematicIndex(schematicsState.items)
        renderSchematics()
        updateSchematicsPagination()
    }
}

async function fetchSchematicDetail(id){
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
          const response = await fetch(`${base.replace(/\/+$/, '')}/v1/schematics/${encodeURIComponent(id)}`, {
              method: 'GET',
              headers: { 'Accept': 'application/json', ...getSchematicsAuthHeaders() }
          })
        if(!response.ok){
            throw new Error(`HTTP ${response.status}`)
        }
        const data = await response.json()
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
    return SCHEMATIC_INDEX.get(id)
}

async function fetchSchematicFromUrl(url){
    if(!url){
        return null
    }
    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: { 'Accept': 'application/json' }
        })
        if(!response.ok){
            throw new Error(`HTTP ${response.status}`)
        }
        return await response.json()
    } catch (err) {
        loggerLanding.warn('Failed to load schematic data from url.', err)
        return null
    }
}

async function getNormalizedSchematic(entry){
    if(!entry || !entry.id || !Array.isArray(entry.blocks)){
        if(!entry || !entry.id){
            return null
        }
    }
    if(SCHEMATIC_NORMALIZED_CACHE.has(entry.id)){
        return SCHEMATIC_NORMALIZED_CACHE.get(entry.id)
    }
    let rawBlocks = entry.blocks
    let base = entry
    if(!Array.isArray(rawBlocks) && entry.schematic){
        rawBlocks = entry.schematic.blocks
        base = entry.schematic
    }
    if(!Array.isArray(rawBlocks)){
        const detail = await fetchSchematicDetail(entry.id)
        if(detail?.schematic){
            rawBlocks = detail.schematic.blocks
            base = detail.schematic
        } else if(detail?.schematicUrl){
            const schematicData = await fetchSchematicFromUrl(detail.schematicUrl)
            if(schematicData?.blocks){
                rawBlocks = schematicData.blocks
                base = schematicData
            }
        }
    }
    if(!Array.isArray(rawBlocks)){
        return null
    }
    const { schematic } = await normalizeJsonSchematic({
        name: base.name || entry.name,
        category: base.category || entry.category,
        icon: base.icon || entry.icon,
        blocks: rawBlocks
    }, { id: entry.id })
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
