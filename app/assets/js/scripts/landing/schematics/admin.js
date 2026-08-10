let schematicsAdminOpen = false

function parseCsv(value){
    if(!value){
        return []
    }
    return String(value)
        .split(',')
        .map(item => item.trim())
        .filter(Boolean)
}

function setAdminStatus(message, tone = 'info'){
    if(!schematicsAdminStatus){
        return
    }
    schematicsAdminStatus.textContent = message
    schematicsAdminStatus.setAttribute('data-tone', tone)
}

function resetAdminDefaults(){
    if(schematicsAdminLabels && !schematicsAdminLabels.value){
        schematicsAdminLabels.value = 'tiny, medium'
    }
    if(schematicsAdminMimes && !schematicsAdminMimes.value){
        schematicsAdminMimes.value = 'image/webp, image/png'
    }
    if(schematicsAdminLimit && !schematicsAdminLimit.value){
        schematicsAdminLimit.value = '25'
    }
    if(schematicsAdminOffset && !schematicsAdminOffset.value){
        schematicsAdminOffset.value = '0'
    }
    if(schematicsAdminVerifyObjects){
        schematicsAdminVerifyObjects.checked = schematicsAdminVerifyObjects.checked !== false
    }
    if(schematicsAdminRepair){
        schematicsAdminRepair.checked = schematicsAdminRepair.checked !== false
    }
    if(schematicsAdminIncludeExisting){
        schematicsAdminIncludeExisting.checked = Boolean(schematicsAdminIncludeExisting.checked)
    }
}

function renderAdminResults(items){
    if(!schematicsAdminResults){
        return
    }
    schematicsAdminResults.innerHTML = ''
    if(!Array.isArray(items) || items.length === 0){
        const empty = document.createElement('div')
        empty.className = 'schematicsAdminResultEmpty'
        empty.textContent = 'No missing thumbnails found.'
        schematicsAdminResults.appendChild(empty)
        return
    }
    for(const item of items){
        const card = document.createElement('div')
        card.className = 'schematicsAdminResultCard'

        const header = document.createElement('div')
        header.className = 'schematicsAdminResultHeader'

        const title = document.createElement('div')
        title.className = 'schematicsAdminResultTitle'
        title.textContent = item.id || 'Schematic'

        const meta = document.createElement('div')
        meta.className = 'schematicsAdminResultMeta'
        const missingCount = Array.isArray(item.missing) ? item.missing.length : 0
        const staleCount = Array.isArray(item.stale) ? item.stale.length : 0
        meta.textContent = `${missingCount} missing · ${staleCount} stale`

        header.appendChild(title)
        header.appendChild(meta)
        card.appendChild(header)

        const list = document.createElement('div')
        list.className = 'schematicsAdminResultList'
        const missing = Array.isArray(item.missing) ? item.missing : []
        missing.forEach((entry) => {
            const row = document.createElement('div')
            row.className = 'schematicsAdminResultRow'
            const label = document.createElement('span')
            label.textContent = entry.label || '--'
            const mime = document.createElement('span')
            mime.textContent = entry.mime || '--'
            row.appendChild(label)
            row.appendChild(mime)
            list.appendChild(row)
        })
        if(missing.length === 0){
            const row = document.createElement('div')
            row.className = 'schematicsAdminResultRow empty'
            row.textContent = 'No missing variants.'
            list.appendChild(row)
        }
        card.appendChild(list)
        schematicsAdminResults.appendChild(card)
    }
}

function updateSchematicsAdminVisibility(){
    const visible = isSchematicsAdmin()
    if(schematicsAdminControlGroup){
        schematicsAdminControlGroup.hidden = !visible
    }
    if(!visible && schematicsAdminOpen){
        closeSchematicsAdminPanel()
    }
}

function openSchematicsAdminPanel(){
    if(!schematicsAdminModal || !schematicsAdminPanel){
        return
    }
    resetAdminDefaults()
    schematicsAdminOpen = true
    setAdminStatus('Ready.', 'info')
    if(schematicsAdminResults){
        schematicsAdminResults.innerHTML = ''
    }
    openModal(schematicsAdminModal, schematicsAdminPanel)
}

function closeSchematicsAdminPanel(){
    if(!schematicsAdminModal){
        return
    }
    schematicsAdminOpen = false
    closeModal(schematicsAdminModal)
}

async function runSchematicsAdminRegeneration(){
    if(!schematicsAdminRun){
        return
    }
    schematicsAdminRun.disabled = true
    setAdminStatus('Running regeneration...', 'info')
    try {
        const payload = {
            ids: parseCsv(schematicsAdminIds?.value),
            limit: schematicsAdminLimit?.value ? Number(schematicsAdminLimit.value) : undefined,
            offset: schematicsAdminOffset?.value ? Number(schematicsAdminOffset.value) : undefined,
            labels: parseCsv(schematicsAdminLabels?.value),
            mimes: parseCsv(schematicsAdminMimes?.value),
            verifyObjects: Boolean(schematicsAdminVerifyObjects?.checked),
            repair: Boolean(schematicsAdminRepair?.checked),
            includeExisting: Boolean(schematicsAdminIncludeExisting?.checked)
        }
        const result = await regenerateMissingThumbnails(payload)
        renderAdminResults(result?.items || [])
        setAdminStatus(`Done. ${result?.count || 0} schematics returned.`, 'success')
    } catch (err) {
        loggerLanding.warn('Failed to regenerate thumbnails.', err)
        setAdminStatus('Failed to run regeneration.', 'error')
    } finally {
        if(schematicsAdminRun){
            schematicsAdminRun.disabled = false
        }
    }
}
