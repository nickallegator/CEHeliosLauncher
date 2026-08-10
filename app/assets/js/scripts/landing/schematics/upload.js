let schematicsUploadOpen = false

function formatSchematicBytes(bytes){
    if(!Number.isFinite(bytes)){
        return '--'
    }
    if(bytes < 1024){
        return `${bytes} B`
    }
    if(bytes < 1024 * 1024){
        return `${(bytes / 1024).toFixed(1)} KB`
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function updateSchematicUploadStatus(message, tone = 'info'){
    if(!schematicsUploadStatus){
        return
    }
    schematicsUploadStatus.textContent = message
    schematicsUploadStatus.setAttribute('data-tone', tone)
}

function renderSchematicUploadWarnings(warnings){
    if(!schematicsUploadWarnings){
        return
    }
    if(!Array.isArray(warnings) || warnings.length === 0){
        schematicsUploadWarnings.style.display = 'none'
        schematicsUploadWarnings.innerHTML = ''
        return
    }
    schematicsUploadWarnings.style.display = 'block'
    schematicsUploadWarnings.innerHTML = '<strong>Warnings</strong>'
    const list = document.createElement('ul')
    warnings.forEach((warning) => {
        const item = document.createElement('li')
        item.textContent = warning
        list.appendChild(item)
    })
    schematicsUploadWarnings.appendChild(list)
}


function resetSchematicUpload(){
    schematicsUploadState = {
        file: null,
        raw: null,
        normalized: null,
        warnings: [],
        status: 'idle'
    }
    if(schematicsUploadInput){
        schematicsUploadInput.value = ''
    }
    if(schematicsUploadTitleInput){
        schematicsUploadTitleInput.value = ''
    }
    if(schematicsUploadDescription){
        schematicsUploadDescription.value = ''
    }
    if(schematicsUploadTagsInput){
        schematicsUploadTagsInput.value = ''
    }
    if(schematicsUploadFileName){
        schematicsUploadFileName.textContent = '--'
    }
    if(schematicsUploadBlockCount){
        schematicsUploadBlockCount.textContent = '--'
    }
    if(schematicsUploadPaletteCount){
        schematicsUploadPaletteCount.textContent = '--'
    }
    if(schematicsUploadBounds){
        schematicsUploadBounds.textContent = '--'
    }
    if(schematicsUploadHash){
        schematicsUploadHash.textContent = '--'
    }
    if(schematicsUploadSubmit){
        schematicsUploadSubmit.disabled = true
    }
    renderSchematicUploadWarnings([])
    updateSchematicUploadStatus('Select a schematic to begin.', 'info')
    if(schematicsUploadPreview){
        schematicsUploadPreview.setAttribute('data-rendered', 'false')
    }
    renderUploadPreviewPlaceholder('Select a schematic to preview.')
    renderUploadBlockCountsPlaceholder('Select a schematic to see blocks.')
    if(schematicsUploadPreviewTimer){
        clearTimeout(schematicsUploadPreviewTimer)
        schematicsUploadPreviewTimer = null
    }
    schematicsUploadPreviewTask += 1
}

async function handleSchematicUploadFile(file){
    if(!file){
        return
    }
    if(file.size > SCHEMATICS_UPLOAD_MAX_BYTES){
        updateSchematicUploadStatus(`File too large (${formatSchematicBytes(file.size)}). Max ${formatSchematicBytes(SCHEMATICS_UPLOAD_MAX_BYTES)}.`, 'error')
        if(schematicsUploadSubmit){
            schematicsUploadSubmit.disabled = true
        }
        return
    }
    try {
        updateSchematicUploadStatus('Reading schematic...', 'info')
        const text = await file.text()
        const raw = JSON.parse(text)
        const { schematic, warnings } = await normalizeJsonSchematic(raw, {})
        if(schematicsUploadPreview){
            schematicsUploadPreview.setAttribute('data-rendered', 'false')
        }
        renderUploadPreviewPlaceholder('Preparing preview...')
        renderUploadBlockCountsPlaceholder('Loading block list...')
        schematicsUploadState = {
            file,
            raw,
            normalized: schematic,
            warnings,
            status: 'ready'
        }
        if(schematicsUploadFileName){
            schematicsUploadFileName.textContent = `${file.name} - ${formatSchematicBytes(file.size)}`
        }
        if(schematicsUploadBlockCount){
            schematicsUploadBlockCount.textContent = `${schematic.meta?.blockCount ?? schematic.blocks?.length ?? 0}`
        }
        if(schematicsUploadPaletteCount){
            schematicsUploadPaletteCount.textContent = `${schematic.palette?.length ?? 0}`
        }
        if(schematicsUploadBounds){
            const size = schematic.bounds?.size || [0, 0, 0]
            schematicsUploadBounds.textContent = `${size[0]} x ${size[1]} x ${size[2]}`
        }
        if(schematicsUploadHash){
            schematicsUploadHash.textContent = schematic.meta?.hash ? schematic.meta.hash.slice(0, 12) : '--'
        }
        if(schematicsUploadTitleInput && !schematicsUploadTitleInput.value){
            schematicsUploadTitleInput.value = schematic.name || file.name.replace(/\.[^/.]+$/, '')
        }
        renderSchematicUploadWarnings(warnings)
        updateSchematicUploadStatus('Ready to upload.', 'success')
        if(schematicsUploadSubmit){
            schematicsUploadSubmit.disabled = false
        }
        renderUploadBlockCounts(schematic)

        // Fast preview first (geometry only), then refine with textures.
        const previewRenderer = ensureUploadPreviewRenderer()
        if(previewRenderer && previewRenderer.isWebGL){
            previewRenderer.setTextureAtlas(null)
        }
        renderUploadSchematicPreview(schematic)

        if(schematicsUploadPreviewTimer){
            clearTimeout(schematicsUploadPreviewTimer)
        }
        const taskId = ++schematicsUploadPreviewTask
        schematicsUploadPreviewTimer = setTimeout(async () => {
            try {
                await ensureRegistryForSchematic(schematic)
                const atlas = await prepareTextureAtlasForSchematic(schematic, {
                    skipAlphaAnalysis: true,
                    preferExisting: true
                })
                if(taskId !== schematicsUploadPreviewTask){
                    return
                }
                const renderer = ensureUploadPreviewRenderer()
                if(renderer && renderer.isWebGL){
                    renderer.setTextureAtlas(atlas?.canvas || null)
                }
                renderUploadSchematicPreview(schematic)
            } catch (err) {
                loggerLanding.warn('Failed to build upload preview textures.', err)
            }
        }, 120)
    } catch (err) {
        loggerLanding.warn('Failed to parse upload schematic.', err)
        updateSchematicUploadStatus('Unable to parse schematic JSON. Please check the file.', 'error')
        if(schematicsUploadSubmit){
            schematicsUploadSubmit.disabled = true
        }
        renderUploadPreviewPlaceholder('Preview unavailable.')
        renderUploadBlockCountsPlaceholder('No block data available.')
    }
}

function openSchematicUpload(){
    if(!schematicsUpload){
        return
    }
    if(schematicsEditOpen){
        closeSchematicEdit()
    }
    if(schematicDetailOpen){
        closeSchematicDetail()
    }
    resetSchematicUpload()
    schematicsUploadOpen = true
    openModal(schematicsUpload, schematicsUploadPanel)
    setUploadPreviewRendererActive(true)
}

function closeSchematicUpload(){
    if(!schematicsUpload){
        return
    }
    schematicsUploadOpen = false
    closeModal(schematicsUpload)
    setUploadPreviewRendererActive(false)
}

async function submitSchematicUpload(){
    if(!schematicsUploadState?.normalized){
        updateSchematicUploadStatus('Please select a schematic before uploading.', 'error')
        return
    }
    const title = schematicsUploadTitleInput?.value?.trim()
    if(!title){
        updateSchematicUploadStatus('Please provide a title for the schematic.', 'error')
        return
    }
    const base = await resolveSchematicsApiBase()
    if(!base){
        updateSchematicUploadStatus('Schematics service is not configured.', 'error')
        return
    }

    const file = schematicsUploadState.file
    if(!file){
        updateSchematicUploadStatus('Missing schematic file data.', 'error')
        return
    }

    const account = ConfigManager.getSelectedAccount()
    const creator = account?.displayName || account?.username || 'Unknown'
    const description = schematicsUploadDescription?.value?.trim() || null
    const tags = schematicsUploadTagsInput?.value?.trim() || null
    const visibility = schematicsUploadVisibility?.value?.trim() || 'public'
    const bounds = schematicsUploadState.normalized?.bounds?.size || [0, 0, 0]
    const sizeText = `${bounds[0]} x ${bounds[1]} x ${bounds[2]}`
    const version = schematicsUploadState.normalized?.meta?.version || null

    const baseUrl = base.replace(/\/+$/, '')
    const sizeBytes = file.size

    if(schematicsUploadSubmit){
        schematicsUploadSubmit.disabled = true
    }

    try {
        updateSchematicUploadStatus('Capturing thumbnails...', 'info')
        let thumbnails = []
        let thumbnailBlobs = []
        const uploadRenderer = ensureUploadPreviewRenderer()
        const meshReady = await waitForRendererMesh(uploadRenderer, 4500)
        if(meshReady){
            const sizes = getUploadThumbnailSizes()
            const variants = [
                { label: 'medium', size: sizes.medium },
                { label: 'tiny', size: sizes.tiny }
            ]
            const mimes = ['image/webp', 'image/png']
            for(const variant of variants){
                for(const mime of mimes){
                    const blob = await capturePreviewBlob(uploadRenderer, variant.size.width, variant.size.height, mime)
                    if(!blob){
                        continue
                    }
                    const actualMime = blob.type || mime
                    if(mime === 'image/webp' && actualMime !== 'image/webp'){
                        continue
                    }
                    thumbnails.push({
                        label: variant.label,
                        mime: actualMime,
                        width: variant.size.width,
                        height: variant.size.height,
                        sizeBytes: blob.size || null
                    })
                    thumbnailBlobs.push({ label: variant.label, mime: actualMime, blob })
                }
            }
        }
        if(thumbnails.length === 0){
            updateSchematicUploadStatus('Unable to capture thumbnails. Please try again.', 'error')
            return
        }

        if(schematicsUploadPreviewTimer){
            clearTimeout(schematicsUploadPreviewTimer)
            schematicsUploadPreviewTimer = null
        }
        schematicsUploadPreviewTask += 1
        updateSchematicUploadStatus('Requesting upload slot...', 'info')
        await ensureSchematicsAuthSession(baseUrl)
        const uploadHash = schematicsUploadState?.normalized?.meta?.hash || null
        const preflightResponse = await fetch(`${baseUrl}/v1/schematics/preflight`, {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                ...getSchematicsAuthHeaders()
            },
            body: JSON.stringify({
                sizeBytes,
                thumbnails,
                hash: uploadHash,
                format: 'json',
                visibility
            })
        })

        if(!preflightResponse.ok){
            const preflightData = await preflightResponse.json().catch(() => ({}))
            const maxBytes = preflightData?.maxBytes
            if(preflightResponse.status === 413 && maxBytes){
                updateSchematicUploadStatus(`File too large. Max ${formatSchematicBytes(maxBytes)}.`, 'error')
            } else {
                updateSchematicUploadStatus('Unable to start upload. Please try again.', 'error')
            }
            return
        }

        const preflight = await preflightResponse.json()
        const uploadToken = preflight?.token
        if(!uploadToken){
            updateSchematicUploadStatus('Upload slot unavailable. Please try again.', 'error')
            return
        }

        // New signed-upload flow (object storage)
        if(preflight?.schematic){
            const uploadSchematic = preflight.schematic
            if(uploadSchematic.uploadUrl){
                updateSchematicUploadStatus('Uploading schematic...', 'info')
                const schematicPutResponse = await fetch(uploadSchematic.uploadUrl, {
                    method: 'PUT',
                    headers: {
                        'Content-Type': uploadSchematic.mime || 'application/json'
                    },
                    body: file
                })
                if(!schematicPutResponse.ok){
                    updateSchematicUploadStatus('Schematic upload failed. Please try again.', 'error')
                    return
                }
            } else {
                updateSchematicUploadStatus('Using existing schematic upload...', 'info')
            }

            const uploadedThumbs = []
            for(const thumb of preflight.thumbnails || []){
                const blobEntry = thumbnailBlobs.find(item => item.label === thumb.label && item.mime === thumb.mime)
                if(!blobEntry?.blob || !thumb.uploadUrl){
                    updateSchematicUploadStatus('Thumbnail upload failed. Please try again.', 'error')
                    return
                }
                const thumbResponse = await fetch(thumb.uploadUrl, {
                    method: 'PUT',
                    headers: {
                        'Content-Type': thumb.mime || blobEntry.mime || 'image/png'
                    },
                    body: blobEntry.blob
                })
                if(!thumbResponse.ok){
                    updateSchematicUploadStatus('Thumbnail upload failed. Please try again.', 'error')
                    return
                }
                uploadedThumbs.push({
                    label: thumb.label,
                    mime: thumb.mime,
                    width: thumb.width,
                    height: thumb.height,
                    sizeBytes: thumb.sizeBytes,
                    objectKey: thumb.objectKey
                })
            }

            const finalizeResponse = await fetch(`${baseUrl}/v1/schematics/upload/${encodeURIComponent(uploadToken)}`, {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    ...getSchematicsAuthHeaders()
                },
                body: JSON.stringify({
                    name: title,
                    creator,
                    description,
                    tags,
                    visibility,
                    version,
                    sizeText,
                    format: 'json',
                    hash: uploadHash,
                    sizeBytes: sizeBytes || file.size || null,
                    blockCount: schematicsUploadState?.normalized?.meta?.blockCount || null,
                    objectKey: uploadSchematic.objectKey,
                    thumbnails: uploadedThumbs
                })
            })

            if(!finalizeResponse.ok){
                updateSchematicUploadStatus('Upload failed. Please check the file and try again.', 'error')
                return
            }
        } else {
            // Legacy local-storage flow
            const uploadUrl = preflight?.uploadUrl
            if(!uploadUrl){
                updateSchematicUploadStatus('Upload slot unavailable. Please try again.', 'error')
                return
            }
            updateSchematicUploadStatus('Uploading schematic...', 'info')
            const uploadEndpoint = uploadUrl.startsWith('http') ? uploadUrl : `${baseUrl}${uploadUrl}`
            const uploadResponse = await fetch(uploadEndpoint, {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    name: title,
                    creator,
                    description,
                    tags,
                    visibility,
                    version,
                    sizeText,
                    thumbnails,
                    format: 'json',
                    hash: uploadHash,
                    sizeBytes: sizeBytes || file.size || null,
                    blockCount: schematicsUploadState?.normalized?.meta?.blockCount || null,
                    schematic: schematicsUploadState.raw
                })
            })
            if(!uploadResponse.ok){
                updateSchematicUploadStatus('Upload failed. Please check the file and try again.', 'error')
                return
            }
        }

        updateSchematicUploadStatus('Upload complete. Refreshing list...', 'success')
        await fetchSchematicsList({ query: schematicsState.query, sortKey: schematicsState.sortKey })
        closeSchematicUpload()
    } catch (err) {
        loggerLanding.warn('Failed to upload schematic.', err)
        updateSchematicUploadStatus('Upload failed due to a network error.', 'error')
    } finally {
        if(schematicsUploadSubmit){
            schematicsUploadSubmit.disabled = false
        }
    }
}
