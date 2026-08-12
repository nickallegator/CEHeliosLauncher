let schematicsEditOpen = false
let schematicsEditEntry = null
let schematicsEditSubmitting = false

function updateSchematicEditStatus(message, tone = 'info'){
    if(!schematicsEditStatus){
        return
    }
    schematicsEditStatus.textContent = message
    schematicsEditStatus.setAttribute('data-tone', tone)
}

function resolveSchematicEditThumbnailUrl(entry){
    if(!entry?.thumbnailUrl){
        return null
    }
    const apiBase = (schematicsState.apiBase || '').replace(/\/+$/, '')
    if(entry.thumbnailUrl.startsWith('http')){
        return entry.thumbnailUrl
    }
    return `${apiBase}${entry.thumbnailUrl}`
}

function renderSchematicEditSummary(entry){
    if(schematicsEditCreatorValue){
        schematicsEditCreatorValue.textContent = entry?.creator || '--'
    }
    if(schematicsEditReleaseValue){
        schematicsEditReleaseValue.textContent = formatSchematicDate(entry?.release)
    }
    if(schematicsEditDownloadsValue){
        schematicsEditDownloadsValue.textContent = formatDownloadCount(entry?.downloads)
    }
    if(schematicsEditLikesValue){
        schematicsEditLikesValue.textContent = formatEngagementCount(entry?.likes)
    }
    if(schematicsEditViewsValue){
        schematicsEditViewsValue.textContent = formatEngagementCount(entry?.views)
    }

    const thumbUrl = resolveSchematicEditThumbnailUrl(entry)
    if(schematicsEditPreview){
        schematicsEditPreview.setAttribute('data-rendered', thumbUrl ? 'true' : 'false')
    }
    if(schematicsEditPreviewImage){
        if(thumbUrl){
            schematicsEditPreviewImage.hidden = false
            schematicsEditPreviewImage.src = thumbUrl
            schematicsEditPreviewImage.onerror = () => {
                schematicsEditPreviewImage.hidden = true
                schematicsEditPreviewImage.removeAttribute('src')
                if(schematicsEditPreview){
                    schematicsEditPreview.setAttribute('data-rendered', 'false')
                }
            }
            schematicsEditPreviewImage.onload = () => {
                if(schematicsEditPreview){
                    schematicsEditPreview.setAttribute('data-rendered', 'true')
                }
            }
        } else {
            schematicsEditPreviewImage.hidden = true
            schematicsEditPreviewImage.removeAttribute('src')
        }
    }
}

function populateSchematicEditForm(entry){
    if(schematicsEditNameInput){
        schematicsEditNameInput.value = entry?.name || ''
    }
    if(schematicsEditDescriptionInput){
        schematicsEditDescriptionInput.value = entry?.description || ''
    }
    if(schematicsEditTagsInput){
        schematicsEditTagsInput.value = Array.isArray(entry?.tags) ? entry.tags.join(', ') : ''
    }
    if(schematicsEditVisibility){
        schematicsEditVisibility.value = entry?.visibility || 'public'
    }
    if(schematicsEditVersionInput){
        schematicsEditVersionInput.value = entry?.version || ''
    }
    if(schematicsEditSubmit){
        schematicsEditSubmit.disabled = false
    }
    updateSchematicEditStatus(communityCopy('readyToEdit'), 'info')
    renderSchematicEditSummary(entry)
}

async function openSchematicEdit(entry){
    if(!entry || !schematicsEdit){
        return
    }
    if(schematicsUploadOpen){
        closeSchematicUpload()
    }

    let detailEntry = entry
    try {
        const detail = await fetchSchematicDetail(entry.id)
        if(detail){
            detailEntry = { ...entry, ...detail }
        }
    } catch (err) {
        loggerLanding.warn('Failed to load schematic detail for edit.', err)
    }

    schematicsEditEntry = detailEntry
    populateSchematicEditForm(detailEntry)
    schematicsEditOpen = true
    openModal(schematicsEdit, schematicsEditPanel)
}

function closeSchematicEdit(){
    if(!schematicsEdit){
        return
    }
    schematicsEditOpen = false
    schematicsEditEntry = null
    schematicsEditSubmitting = false
    closeModal(schematicsEdit)
}

async function submitSchematicEdit(){
    if(schematicsEditSubmitting){
        return
    }
    if(!schematicsEditEntry?.id){
        updateSchematicEditStatus(communityCopy('noEditSelection'), 'error')
        return
    }

    const name = schematicsEditNameInput?.value?.trim()
    if(!name){
        updateSchematicEditStatus(communityCopy('titleRequired'), 'error')
        return
    }

    const payload = {
        name,
        description: typeof schematicsEditDescriptionInput?.value === 'string' ? schematicsEditDescriptionInput.value.trim() : '',
        tags: typeof schematicsEditTagsInput?.value === 'string' ? schematicsEditTagsInput.value.trim() : '',
        visibility: schematicsEditVisibility?.value || 'public',
        version: schematicsEditVersionInput?.value?.trim() || ''
    }

    schematicsEditSubmitting = true
    if(schematicsEditSubmit){
        schematicsEditSubmit.disabled = true
    }
    updateSchematicEditStatus(communityCopy('savingChanges'), 'info')

    try {
        const updated = await saveSchematicEdits(schematicsEditEntry, payload)
        if(!updated){
            throw new Error('save_failed')
        }
        closeSchematicEdit()
        openSchematicDetail(updated)
    } catch (err) {
        loggerLanding.warn('Failed to save schematic edits.', err)
        updateSchematicEditStatus(communityCopy('saveFailed'), 'error')
    } finally {
        schematicsEditSubmitting = false
        if(schematicsEditSubmit){
            schematicsEditSubmit.disabled = false
        }
    }
}

function openSchematicRevisionUpload(){
    if(!schematicsEditEntry?.id){
        updateSchematicEditStatus(communityCopy('noRevisionSelection'), 'error')
        return
    }
    const target = schematicsEditEntry
    closeSchematicEdit()
    openSchematicUpload(target)
}
