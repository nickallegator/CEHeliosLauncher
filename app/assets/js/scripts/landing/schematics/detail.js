let schematicDetailOpen = false
let schematicDetailActiveId = null
let schematicDetailTaskToken = 0
let schematicDetailController = null
let schematicViewRecorded = new Set()
let schematicDetailShareMenuOpen = false
let schematicDetailShareEntry = null
let schematicDetailShareEventsBound = false
try {
    const cached = sessionStorage.getItem('schematicsViewRecorded')
    if(cached){
        const parsed = JSON.parse(cached)
        if(Array.isArray(parsed)){
            schematicViewRecorded = new Set(parsed.filter(Boolean))
        }
    }
} catch (err) {
    schematicViewRecorded = new Set()
}

function markViewRecorded(id){
    if(!id){
        return
    }
    schematicViewRecorded.add(id)
    try {
        sessionStorage.setItem('schematicsViewRecorded', JSON.stringify(Array.from(schematicViewRecorded)))
    } catch (err) {
        // ignore storage errors
    }
}

function setSchematicDetailShareMenuState(open){
    schematicDetailShareMenuOpen = Boolean(open)
    if(schematicsDetailShareMenu){
        schematicsDetailShareMenu.hidden = !schematicDetailShareMenuOpen
    }
    if(schematicsDetailShareButton){
        schematicsDetailShareButton.setAttribute('aria-expanded', schematicDetailShareMenuOpen ? 'true' : 'false')
        schematicsDetailShareButton.classList.toggle('is-open', schematicDetailShareMenuOpen)
    }
}

function closeSchematicShareMenu(){
    setSchematicDetailShareMenuState(false)
}

function updateSchematicShareContext(entry){
    schematicDetailShareEntry = entry || null
    if(schematicsDetailShareButton){
        const canShare = Boolean(entry?.id)
        schematicsDetailShareButton.style.display = canShare ? 'inline-flex' : 'none'
        schematicsDetailShareButton.disabled = !canShare
        if(!canShare){
            closeSchematicShareMenu()
        }
    }
    if(schematicsDetailShareMenuSubtitle){
        const fallback = schematicsDetailShareMenuSubtitle.dataset.default || communityCopy('choosePlatform')
        const name = String(entry?.name || '').trim()
        schematicsDetailShareMenuSubtitle.textContent = name || fallback
    }
}

function bindSchematicDetailShareEvents(){
    if(schematicDetailShareEventsBound){
        return
    }
    schematicDetailShareEventsBound = true

    if(schematicsDetailShareButton){
        schematicsDetailShareButton.onclick = (event) => {
            event.preventDefault()
            event.stopPropagation()
            if(!schematicDetailOpen){
                return
            }
            setSchematicDetailShareMenuState(!schematicDetailShareMenuOpen)
        }
    }

    if(schematicsDetailShareOptions && schematicsDetailShareOptions.length > 0){
        schematicsDetailShareOptions.forEach((option) => {
            option.onclick = (event) => {
                event.preventDefault()
                event.stopPropagation()
                const platform = option.getAttribute('data-schematic-share-option') || 'unknown'
                loggerLanding.info('[SchematicsShare] Placeholder option selected.', {
                    platform,
                    schematicId: schematicDetailShareEntry?.id || null
                })
                closeSchematicShareMenu()
            }
        })
    }

    if(typeof document !== 'undefined'){
        document.addEventListener('pointerdown', (event) => {
            if(!schematicDetailShareMenuOpen){
                return
            }
            const target = event.target
            if(schematicsDetailShareMenu?.contains(target) || schematicsDetailShareButton?.contains(target)){
                return
            }
            closeSchematicShareMenu()
        }, true)

        document.addEventListener('keydown', (event) => {
            if(event.key !== 'Escape' || !schematicDetailShareMenuOpen){
                return
            }
            event.preventDefault()
            event.stopPropagation()
            closeSchematicShareMenu()
        }, true)
    }
}

function updateLikeButton(entry){
    if(!schematicsDetailLike){
        return
    }
    const liked = Boolean(entry?.liked)
    schematicsDetailLike.textContent = liked ? communityCopy('liked') : communityCopy('like')
    schematicsDetailLike.classList.toggle('is-liked', liked)
    const hasToken = Boolean(AccessGate.getSessionToken())
    schematicsDetailLike.disabled = !hasToken
}

function renderSchematicTags(tags){
    if(!schematicsDetailTags){
        return
    }
    schematicsDetailTags.innerHTML = ''
    if(!Array.isArray(tags) || tags.length === 0){
        schematicsDetailTags.style.display = 'none'
        return
    }
    schematicsDetailTags.style.display = 'flex'
    tags.forEach((tag) => {
        const tagEl = document.createElement('span')
        tagEl.className = 'schematicsDetailTag'
        tagEl.textContent = tag
        schematicsDetailTags.appendChild(tagEl)
    })
}

async function openSchematicDetail(entry){
    if(!entry || !schematicsDetail){
        return
    }
    if(schematicsEditOpen){
        closeSchematicEdit()
    }
    bindSchematicDetailShareEvents()
    closeSchematicShareMenu()
    updateSchematicShareContext(entry)
    schematicDetailOpen = true
    schematicDetailActiveId = entry.id || null
    const detailTaskToken = ++schematicDetailTaskToken
    if(schematicDetailController) schematicDetailController.abort()
    schematicDetailController = new AbortController()
    const detailSignal = schematicDetailController.signal

    const applyDetail = (detailEntry) => {
        if(!detailEntry){
            return
        }
        if(schematicsDetailPanel){
            schematicsDetailPanel.style.setProperty('--schematic-accent', detailEntry.accent || '92, 160, 255')
        }
        if(schematicsDetailTitle){
            schematicsDetailTitle.textContent = detailEntry.name || communityCopy('schematic')
        }
        if(schematicsDetailCreator){
            schematicsDetailCreator.textContent = detailEntry.creator ? `by ${detailEntry.creator}` : 'by --'
            schematicsDetailCreator.onclick = null
            schematicsDetailCreator.style.cursor = ''
        }
        if(schematicsDetailRelease){
            schematicsDetailRelease.textContent = formatSchematicDate(detailEntry.release)
        }
        if(schematicsDetailSize){
            schematicsDetailSize.textContent = detailEntry.size || '--'
        }
        if(schematicsDetailDownloads){
            schematicsDetailDownloads.textContent = formatDownloadCount(detailEntry.downloads)
        }
        const engagement = new CommunityEngagement(detailEntry)
        if(schematicsDetailLikes){
            schematicsDetailLikes.textContent = formatEngagementCount(engagement.getLikes())
        }
        if(schematicsDetailViews){
            schematicsDetailViews.textContent = formatEngagementCount(engagement.getViews())
        }
        if(schematicsDetailVersion){
            schematicsDetailVersion.textContent = detailEntry.version || '--'
        }
        if(schematicsDetailDescription){
            schematicsDetailDescription.textContent = detailEntry.description || ''
            schematicsDetailDescription.style.display = detailEntry.description ? 'block' : 'none'
        }
        renderSchematicTags(detailEntry.tags)
        const userId = getCurrentUserId()
        const isOwner = Boolean(userId && detailEntry.ownerId && Number(detailEntry.ownerId) === Number(userId))
        if(schematicsDetailEdit){
            schematicsDetailEdit.style.display = isOwner ? 'inline-flex' : 'none'
        }
        if(schematicsDetailDelete){
            schematicsDetailDelete.style.display = isOwner ? 'inline-flex' : 'none'
        }
        if(schematicsDetailReport){
            schematicsDetailReport.style.display = isOwner ? 'none' : 'inline-flex'
        }
        updateSchematicShareContext(detailEntry)
        updateInstallButtonState(detailEntry)
        updateLikeButton(detailEntry)
    }

    applyDetail(entry)

    if(schematicsDetailPreview){
        schematicsDetailPreview.setAttribute('data-rendered', 'false')
    }
    renderPreviewPlaceholder(communityCopy('preparingPreview'))
    if(schematicsDetailBlocks){
        renderBlockCountsPlaceholder(communityCopy('loadingBlockList'))
    }
    if(schematicsDetailMods){
        renderModListPlaceholder(communityCopy('scanningMods'))
    }

    if(schematicsDetailInstall){
        schematicsDetailInstall.onclick = () => {
            installSchematic(entry)
        }
    }
    if(schematicsDetailRemove){
        schematicsDetailRemove.onclick = () => {
            removeInstalledSchematic(entry)
        }
    }
    if(schematicsDetailAddToCollection){
        schematicsDetailAddToCollection.onclick = () => {
            openCollectionsPanel('mine', null, entry.id)
        }
    }
    if(schematicsDetailLike){
        schematicsDetailLike.onclick = async () => {
            const updated = await toggleSchematicLike(entry)
            if(updated){
                entry = { ...entry, ...updated }
                if(schematicDetailActiveId === entry.id){
                    applyDetail(entry)
                }
            }
        }
    }
    if(schematicsDetailEdit){
        schematicsDetailEdit.onclick = () => {
            if(typeof openSchematicEdit === 'function'){
                openSchematicEdit(entry)
            }
        }
    }
    if(schematicsDetailDelete){
        schematicsDetailDelete.onclick = () => {
            deleteSchematic(entry)
        }
    }
    if(schematicsDetailReport){
        schematicsDetailReport.onclick = () => {
            reportSchematic(entry)
        }
    }
    updateInstallButtonState(entry)

    openModal(schematicsDetail, schematicsDetailPanel)
    setSchematicPreviewRendererActive(true)
    if(schematicsContent){
        schematicsContent.setAttribute('detail-open', '')
    }

    try {
        if(entry.id && !schematicViewRecorded.has(entry.id)){
            markViewRecorded(entry.id)
            const viewId = entry.id
            recordSchematicView(entry)
                .then((viewUpdate) => {
                    if(!viewUpdate){
                        return
                    }
                    if(detailTaskToken !== schematicDetailTaskToken || schematicDetailActiveId !== viewId){
                        return
                    }
                    entry = { ...entry, ...viewUpdate }
                    applyDetail(entry)
                })
                .catch((err) => {
                    loggerLanding.warn('Failed to record schematic view.', err)
                })
        }
        if(!entry.blocks && !entry.schematic){
            const detail = await fetchSchematicDetail(entry.id, { signal: detailSignal })
            if(detailTaskToken !== schematicDetailTaskToken || schematicDetailActiveId !== entry.id){
                return
            }
            if(detail){
                entry = { ...entry, ...detail }
            }
            applyDetail(entry)
        }
        const normalizedPromise = getNormalizedSchematic(entry, { signal: detailSignal })
        const resourceStackPromise = buildSchematicsResourceStack()
        const normalized = await normalizedPromise
        if(detailTaskToken !== schematicDetailTaskToken || schematicDetailActiveId !== entry.id){
            return
        }
        if(!normalized){
            renderPreviewPlaceholder(communityCopy('noSchematicData'), 'unavailable')
            renderBlockCountsPlaceholder(communityCopy('noBlockData'))
            renderModListPlaceholder(communityCopy('noModData'))
            return
        }
        if(schematicDetailActiveId !== entry.id){
            return
        }
        if(schematicsDetailSize && (!entry.size || entry.size === '--')){
            const size = normalized.bounds?.size || [0, 0, 0]
            schematicsDetailSize.textContent = `${size[0]} x ${size[1]} x ${size[2]}`
        }
        const resourceStack = await resourceStackPromise
        if(detailTaskToken !== schematicDetailTaskToken || schematicDetailActiveId !== entry.id){
            return
        }
        const blockListRenderTask = renderSchematicBlockCounts(normalized, { stack: resourceStack })
        const modsListRenderTask = renderSchematicModsList(normalized)
        const atlasTask = (async () => {
            await ensureRegistryForSchematic(normalized, resourceStack)
            return prepareTextureAtlasForSchematic(normalized)
        })()
        const atlas = await atlasTask
        if(detailTaskToken !== schematicDetailTaskToken || schematicDetailActiveId !== entry.id){
            return
        }
        const renderer = ensureSchematicPreviewRenderer()
        if(renderer && renderer.isWebGL){
            renderer.setTextureAtlas(atlas?.canvas || null)
        }
        renderSchematicPreview(normalized)
        await Promise.all([blockListRenderTask, modsListRenderTask])
    } catch (err) {
        loggerLanding.warn('Failed to normalize schematic for preview.', err)
        renderPreviewPlaceholder(communityCopy('previewUnavailable'), 'error')
        renderBlockCountsPlaceholder(communityCopy('noBlockData'))
        renderModListPlaceholder(communityCopy('noModData'))
    }
}

function closeSchematicDetail(){
    if(!schematicsDetail || !schematicDetailOpen){
        return
    }
    schematicDetailOpen = false
    schematicDetailActiveId = null
    schematicDetailTaskToken += 1
    if(schematicDetailController) schematicDetailController.abort()
    schematicDetailController = null
    schematicDetailShareEntry = null
    closeSchematicShareMenu()
    closeModal(schematicsDetail)
    setSchematicPreviewRendererActive(false)
    if(schematicsContent){
        schematicsContent.removeAttribute('detail-open')
    }
}
