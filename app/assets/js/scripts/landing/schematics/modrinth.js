let modrinthUiBound = false
let modrinthProjectsCache = []
let modrinthSourcesCache = []
let modrinthPollController = null

function modrinthElement(id){ return document.getElementById(id) }
function setModrinthStatus(message, error = false){
    const element = modrinthElement('communityModrinthStatus')
    if(element){ element.textContent = message || ''; element.toggleAttribute('error', error) }
}
function showModrinthModal(open){
    const modal = modrinthElement('communityModrinthModal')
    if(!modal) return
    modal.setAttribute('aria-hidden', open ? 'false' : 'true')
    if(open) modrinthElement('communityModrinthClose')?.focus()
    else modrinthPollController?.abort()
}

async function modrinthClient(){
    const client = await getCommunityApiClient()
    if(!client) throw new Error(communityCopy('notConfigured'))
    await ensureSchematicsAuthSession(client.baseUrl)
    if(!AccessGate.getSessionToken()) throw new Error('Sign in with Microsoft before connecting Modrinth.')
    return client
}

async function refreshModrinthAccount(){
    const client = await modrinthClient()
    const result = await client.modrinthAccount({ headers: getSchematicsAuthHeaders() })
    const account = result.account
    const connected = account?.connected === true
    const expiry = account?.expiresAt ? ` · expires ${new Date(account.expiresAt).toLocaleString()}` : ''
    const status = connected
        ? `${account.reconnectRequired ? 'Reconnect required' : 'Connected'} · ${account.displayName || account.username}${expiry}`
        : 'No Modrinth account connected.'
    for(const id of ['communityModrinthAccountStatus','settingsModrinthStatus']){
        const element = modrinthElement(id); if(element) element.textContent = status
    }
    modrinthElement('communityModrinthWorkspace').hidden = !connected || account.reconnectRequired
    modrinthElement('communityModrinthConnect').textContent = connected ? 'Reconnect Modrinth' : 'Connect Modrinth'
    if(modrinthElement('settingsModrinthConnect')) modrinthElement('settingsModrinthConnect').textContent = connected ? 'Reconnect' : 'Connect'
    if(modrinthElement('settingsModrinthDisconnect')) modrinthElement('settingsModrinthDisconnect').hidden = !connected
    const avatar = modrinthElement('settingsModrinthAvatar')
    if(avatar){ avatar.hidden = !connected || !account.avatarUrl; avatar.src = connected && account.avatarUrl ? account.avatarUrl : '' }
    if(connected && !account.reconnectRequired) await refreshModrinthSources()
    return account
}

async function beginModrinthOAuth(){
    const client = await modrinthClient()
    const started = await client.startModrinthOAuth({ headers: getSchematicsAuthHeaders() })
    shell.openExternal(started.authorizationUrl)
    modrinthPollController?.abort()
    modrinthPollController = new AbortController()
    setModrinthStatus('Complete authorization in your browser…')
    while(Date.now() < new Date(started.expiresAt).getTime() && !modrinthPollController.signal.aborted){
        await new Promise(resolve => setTimeout(resolve, 1200))
        const attempt = await client.modrinthOAuthAttempt(started.attemptId, { headers: getSchematicsAuthHeaders(), signal: modrinthPollController.signal })
        if(attempt.status === 'complete'){
            setModrinthStatus('Modrinth connected.')
            await refreshModrinthAccount()
            return
        }
        if(attempt.status === 'failed' && attempt.error){ throw new Error(`Modrinth connection failed: ${attempt.error}`) }
    }
    if(!modrinthPollController.signal.aborted) throw new Error('Modrinth connection expired. Please try again.')
}

async function refreshModrinthSources(){
    const client = await modrinthClient()
    const headers = getSchematicsAuthHeaders()
    const [projects, sources] = await Promise.all([client.modrinthProjects({ headers }), client.modrinthSources({ headers })])
    modrinthProjectsCache = projects.items || []
    modrinthSourcesCache = sources.items || []
    const projectSelect = modrinthElement('communityModrinthProject')
    if(projectSelect){
        projectSelect.replaceChildren(...modrinthProjectsCache.map(project => Object.assign(document.createElement('option'), { value: project.id, textContent: `${project.title} · ${project.license}` })))
    }
    const sourceSelect = modrinthElement('communityModrinthSource')
    if(sourceSelect){
        const selected = sourceSelect.value
        sourceSelect.replaceChildren(...modrinthSourcesCache.map(source => Object.assign(document.createElement('option'), { value: source.id, textContent: `${source.title}${source.pendingCount ? ` · ${source.pendingCount} pending` : ''}` })))
        if([...sourceSelect.options].some(option => option.value === selected)) sourceSelect.value = selected
    }
    await refreshModrinthCandidates()
}

async function refreshModrinthCandidates(){
    const sourceId = modrinthElement('communityModrinthSource')?.value
    const host = modrinthElement('communityModrinthCandidates')
    if(!host) return
    host.replaceChildren()
    if(!sourceId){ host.textContent = 'Track a project to review detected releases.'; return }
    const client = await modrinthClient()
    const result = await client.modrinthCandidates(sourceId, { headers: getSchematicsAuthHeaders() })
    const source = modrinthSourcesCache.find(value => value.id === sourceId)
    const project = modrinthProjectsCache.find(value => value.id === source?.projectId)
    if(project){
        const titleInput = modrinthElement('communityModrinthTitleInput')
        const descriptionInput = modrinthElement('communityModrinthDescription')
        if(titleInput && !titleInput.dataset.edited) titleInput.value = project.title || ''
        if(descriptionInput && !descriptionInput.dataset.edited) descriptionInput.value = project.description || ''
    }
    for(const candidate of result.items || []) host.appendChild(renderModrinthCandidate(sourceId, candidate, project))
    if(!host.children.length) host.textContent = 'No releases are waiting for review.'
}

function renderModrinthCandidate(sourceId, candidate, project){
    const card = document.createElement('article')
    card.className = 'communityModrinthCandidate'
    const title = document.createElement('h4'); title.textContent = `${candidate.versionNumber} · ${candidate.channel}`; card.appendChild(title)
    const summary = document.createElement('p'); summary.textContent = `${candidate.fileName || 'File selection required'}${candidate.sizeBytes ? ` · ${(candidate.sizeBytes / 1048576).toFixed(1)} MiB` : ''}`; card.appendChild(summary)
    if(candidate.details?.diff){
        const diff = candidate.details.diff
        const changes = ['files','components'].map(kind => `${kind}: +${diff[kind]?.added?.length || 0} / −${diff[kind]?.removed?.length || 0} / Δ${diff[kind]?.changed?.length || 0}`).join(' · ')
        const diffSummary = document.createElement('p'); diffSummary.className = 'communityModrinthDiff'; diffSummary.textContent = changes; card.appendChild(diffSummary)
    }
    let fileSelect = null
    const files = candidate.details?.files || []
    if(!candidate.fileName && files.length){
        fileSelect = document.createElement('select')
        for(const file of files) fileSelect.appendChild(Object.assign(document.createElement('option'), { value: file.sha512, textContent: `${file.fileName} · ${(file.sizeBytes / 1048576).toFixed(1)} MiB` }))
        card.appendChild(fileSelect)
    }
    const actions = document.createElement('div'); actions.className = 'communityModrinthCandidateActions'
    const prepare = document.createElement('button'); prepare.type = 'button'; prepare.className = 'schematicsDetailButton'; prepare.textContent = candidate.state === 'prepared' ? 'Prepare again' : 'Prepare and validate'
    prepare.onclick = async () => runModrinthAction(prepare, async client => { await client.prepareModrinthCandidate(sourceId, candidate.id, fileSelect?.value || candidate.sha512, { headers: getSchematicsAuthHeaders() }); await refreshModrinthCandidates() }, 'Validating the exact Modrinth ZIP…')
    actions.appendChild(prepare)
    if(candidate.state === 'prepared'){
        const publish = document.createElement('button'); publish.type = 'button'; publish.className = 'schematicsDetailButton primary'; publish.textContent = 'Review and publish'
        publish.onclick = async () => {
            const titleValue = modrinthElement('communityModrinthTitleInput')?.value.trim() || sourceTitle(project, candidate)
            if(!modrinthElement('communityModrinthRights')?.checked){ setModrinthStatus('Confirm your distribution rights before publishing.', true); return }
            if(!modrinthElement('communityModrinthLicense')?.checked){ setModrinthStatus('Accept the Modrinth project license before publishing.', true); return }
            const confirmed = window.confirm(`Publish ${candidate.versionNumber} from Modrinth? The ZIP remains hosted by Modrinth and will be verified again.`)
            if(!confirmed) return
            await runModrinthAction(publish, async client => {
                await client.publishModrinthCandidate(sourceId, candidate.id, {
                    expectedSha256: candidate.preparedSha256, title: titleValue,
                    description: modrinthElement('communityModrinthDescription')?.value.trim() || project?.description || '',
                    tags: modrinthElement('communityModrinthTags')?.value || 'Modrinth',
                    license: project?.license, rightsAttested: true, licenseAccepted: true,
                    packStudioOptIn: modrinthElement('communityModrinthComposition')?.checked === true,
                    packStudioTermsAccepted: modrinthElement('communityModrinthComposition')?.checked === true
                }, { headers: getSchematicsAuthHeaders() })
                await refreshModrinthSources()
                if(typeof fetchSchematicsList === 'function') await fetchSchematicsList({ page: 1 })
            }, 'Re-verifying and publishing…')
        }
        actions.appendChild(publish)
    }
    card.appendChild(actions)
    return card
}
function sourceTitle(project, candidate){ return project?.title || `Modrinth Resource Pack ${candidate.versionNumber}` }
async function runModrinthAction(button, action, pending){
    button.disabled = true; setModrinthStatus(pending)
    try { await action(await modrinthClient()); setModrinthStatus('Ready.') }
    catch(error){ setModrinthStatus(error.message, true) }
    finally { button.disabled = false }
}

async function initModrinthIntegration(){
    const capabilities = await resolveCommunityCapabilities().catch(() => null)
    const enabled = capabilities?.features?.modrinth === true
    const open = modrinthElement('communityModrinthImportOpen')
    if(open) open.hidden = !enabled
    const settings = modrinthElement('settingsModrinthContainer')
    if(settings) settings.hidden = !enabled
    if(!enabled || modrinthUiBound) return
    modrinthUiBound = true
    open?.addEventListener('click', () => { showModrinthModal(true); refreshModrinthAccount().catch(error => setModrinthStatus(error.message, true)) })
    modrinthElement('communityModrinthClose')?.addEventListener('click', () => showModrinthModal(false))
    modrinthElement('communityModrinthScrim')?.addEventListener('click', () => showModrinthModal(false))
    for(const buttonId of ['communityModrinthConnect','settingsModrinthConnect']){
        const button = modrinthElement(buttonId)
        if(button) button.onclick = () => beginModrinthOAuth().catch(error => setModrinthStatus(error.message, true))
    }
    if(modrinthElement('settingsModrinthDisconnect')) modrinthElement('settingsModrinthDisconnect').onclick = async () => { const client = await modrinthClient(); await client.disconnectModrinth({ headers: getSchematicsAuthHeaders() }); await refreshModrinthAccount() }
    modrinthElement('communityModrinthTrack')?.addEventListener('click', () => runModrinthAction(modrinthElement('communityModrinthTrack'), async client => {
        const channels = ['release', ...(modrinthElement('communityModrinthBeta').checked ? ['beta'] : []), ...(modrinthElement('communityModrinthAlpha').checked ? ['alpha'] : [])]
        await client.trackModrinthProject(modrinthElement('communityModrinthProject').value, channels, { headers: getSchematicsAuthHeaders() }); await refreshModrinthSources()
    }, 'Claiming and checking the project…'))
    modrinthElement('communityModrinthCheck')?.addEventListener('click', () => runModrinthAction(modrinthElement('communityModrinthCheck'), async client => { await client.checkModrinthSource(modrinthElement('communityModrinthSource').value, { headers: getSchematicsAuthHeaders() }); await refreshModrinthSources() }, 'Checking Modrinth for releases…'))
    modrinthElement('communityModrinthSource')?.addEventListener('change', () => {
        for(const fieldId of ['communityModrinthTitleInput','communityModrinthDescription']){
            const field = modrinthElement(fieldId)
            if(field) delete field.dataset.edited
        }
        refreshModrinthCandidates().catch(error => setModrinthStatus(error.message, true))
    })
    for(const fieldId of ['communityModrinthTitleInput','communityModrinthDescription']) modrinthElement(fieldId)?.addEventListener('input', event => { event.currentTarget.dataset.edited = 'true' })
    await refreshModrinthAccount().catch(() => {})
}

window.initModrinthIntegration = initModrinthIntegration
