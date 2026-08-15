'use strict'

const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const config = require('../config')
const db = require('../db')
const accounts = require('./modrinthAccounts')
const { getExternalProviderRegistry } = require('./externalProviders')
const { validateResourcePack } = require('./communityResourcePack')

function provider() {
    const value = getExternalProviderRegistry().get('modrinth')
    if(!value) throw Object.assign(new Error('Modrinth integration is disabled.'), { code: 'modrinth_integration_disabled', statusCode: 404 })
    return value
}

async function authenticatedContext(userId) {
    const account = await accounts.getAccount(userId, { includeToken: true })
    if(!account) throw Object.assign(new Error('Connect Modrinth before importing a project.'), { code: 'modrinth_account_required', statusCode: 409 })
    if(account.reconnectRequired || !account.token) throw Object.assign(new Error('Reconnect your Modrinth account.'), { code: 'modrinth_reconnect_required', statusCode: 401 })
    if(!['USER_READ','PROJECT_READ'].every(scope => account.scopes.includes(scope))) {
        throw Object.assign(new Error('Reconnect Modrinth with the required read permissions.'), { code: 'modrinth_scope_required', statusCode: 403 })
    }
    return { account, token: account.token, provider: provider() }
}

function validateProject(project) {
    if(project?.project_type !== 'resourcepack' || project?.status !== 'approved') {
        throw Object.assign(new Error('Only approved public Modrinth Resource Pack projects can be imported.'), { code: 'modrinth_project_ineligible', statusCode: 400 })
    }
    if(!Array.isArray(project.game_versions) || !project.game_versions.includes('1.21.1')) {
        throw Object.assign(new Error('The Modrinth project must support Minecraft 1.21.1.'), { code: 'modrinth_project_incompatible', statusCode: 400 })
    }
    const license = String(project.license?.id || '').trim()
    if(!config.community.allowedLicenses.some(value => value.toLowerCase() === license.toLowerCase())) {
        throw Object.assign(new Error(`The Modrinth project license ${license || '<unknown>'} is not enabled in AG Community.`), { code: 'modrinth_license_unsupported', statusCode: 400 })
    }
    return license
}

function normalizeChannels(value) {
    const requested = Array.isArray(value) ? value : ['release']
    const channels = [...new Set(requested.map(item => String(item).toLowerCase()).filter(item => ['release','beta','alpha'].includes(item)))]
    if(!channels.includes('release')) channels.unshift('release')
    return channels
}

async function listOwnedProjects(userId) {
    const context = await authenticatedContext(userId)
    const projects = await context.provider.projects(context.token)
    const result = []
    for(const project of projects) {
        try {
            validateProject(project)
            await context.provider.verifyOwnership(project, context.account.providerUserId, context.token)
            result.push({ id: project.id, slug: project.slug, title: project.title, description: project.description || '', iconUrl: project.icon_url || null, license: project.license?.id, teamId: project.team, gameVersions: project.game_versions || [] })
        } catch (_error) { /* omit projects that cannot be safely claimed */ }
    }
    return result.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id))
}

async function claimProject(userId, projectIdOrSlug, channels) {
    const context = await authenticatedContext(userId)
    const project = await context.provider.project(projectIdOrSlug, context.token)
    validateProject(project)
    await context.provider.verifyOwnership(project, context.account.providerUserId, context.token)
    const id = crypto.randomUUID()
    const { rows } = await db.query(
        `insert into community_external_sources
         (id,provider,owner_id,provider_project_id,project_slug,project_title,team_id,channels,status)
         values ($1,'modrinth',$2,$3,$4,$5,$6,$7,'active')
         on conflict (provider,provider_project_id) do update set
           project_slug=excluded.project_slug,project_title=excluded.project_title,team_id=excluded.team_id,
           channels=case when community_external_sources.owner_id=excluded.owner_id then excluded.channels else community_external_sources.channels end,
           status=case when community_external_sources.owner_id=excluded.owner_id then 'active' else community_external_sources.status end,
           updated_at=now()
         returning *`,
        [id, userId, project.id, project.slug || null, project.title, project.team, normalizeChannels(channels)])
    if(Number(rows[0].owner_id) !== Number(userId)) throw Object.assign(new Error('This Modrinth project is already claimed by another AG Community owner.'), { code: 'modrinth_project_already_claimed', statusCode: 409 })
    return rows[0]
}

function candidateFileSummary(version) {
    return (version.files || []).filter(file => /\.zip$/i.test(file.filename || '')).map(file => ({ fileName: file.filename, sizeBytes: Number(file.size), sha512: file.hashes?.sha512, primary: file.primary === true }))
}

async function detectSource(source, suppliedContext = null) {
    const context = suppliedContext || await authenticatedContext(source.owner_id)
    const project = await context.provider.project(source.provider_project_id, context.token)
    validateProject(project)
    await context.provider.verifyOwnership(project, context.account.providerUserId, context.token)
    const versions = await context.provider.versions(project.id, context.token)
    let detected = 0
    for(const version of versions.sort((a, b) => new Date(b.date_published) - new Date(a.date_published) || String(a.id).localeCompare(String(b.id)))) {
        const channel = String(version.version_type || 'release').toLowerCase()
        if(!source.channels.includes(channel) || !version.game_versions?.includes('1.21.1') || !version.loaders?.includes('minecraft')) continue
        const files = candidateFileSummary(version)
        if(files.length < 1) continue
        let selected = files.length === 1 ? files[0] : files.find(file => file.primary) || null
        const id = crypto.randomUUID()
        const result = await db.query(
            `insert into community_external_candidates
             (id,source_id,provider_version_id,version_number,release_channel,file_name,file_size,file_sha512,state,prepared_data)
             values ($1,$2,$3,$4,$5,$6,$7,$8,'detected',$9)
             on conflict (source_id,provider_version_id) do nothing`,
            [id, source.id, version.id, version.version_number, channel, selected?.fileName || null, selected?.sizeBytes || null, selected?.sha512 || null,
                { versionName: version.name, publishedAt: version.date_published, files, changelog: String(version.changelog || '').slice(0, 20_000) }])
        detected += result.rowCount
    }
    await db.query('update community_external_sources set status=\'active\',last_checked_at=now(),last_error=null,updated_at=now() where id=$1', [source.id])
    return detected
}

async function checkSource(userId, sourceId) {
    const sourceResult = await db.query('select * from community_external_sources where id=$1 and owner_id=$2 and provider=\'modrinth\'', [sourceId, userId])
    if(!sourceResult.rows.length) throw Object.assign(new Error('Tracked Modrinth project was not found.'), { code: 'modrinth_source_not_found', statusCode: 404 })
    return { detected: await detectSource(sourceResult.rows[0]) }
}

async function withDownloadedCandidate(userId, sourceId, candidateId, requestedSha512, callback) {
    const result = await db.query(
        `select c.*,s.owner_id,s.provider_project_id,s.team_id,s.item_id,s.project_title,s.project_slug,s.channels
         from community_external_candidates c join community_external_sources s on s.id=c.source_id
         where c.id=$1 and s.id=$2 and s.owner_id=$3 and s.provider='modrinth' and s.status='active'`,
        [candidateId, sourceId, userId])
    if(!result.rows.length) throw Object.assign(new Error('Modrinth release candidate was not found.'), { code: 'modrinth_candidate_not_found', statusCode: 404 })
    const row = result.rows[0]
    const context = await authenticatedContext(userId)
    const project = await context.provider.project(row.provider_project_id, context.token)
    validateProject(project)
    await context.provider.verifyOwnership(project, context.account.providerUserId, context.token)
    const version = await context.provider.version(row.provider_version_id, context.token)
    const file = context.provider.selectVersionFile(version, requestedSha512 || row.file_sha512)
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ag-modrinth-'))
    const filePath = path.join(directory, 'resource-pack.zip')
    try {
        const hashes = await context.provider.downloadToFile(file, filePath)
        const validated = await validateResourcePack(filePath, { indexComponents: true })
        if(validated.sha256 !== hashes.sha256) throw Object.assign(new Error('Resource Pack validation checksum drifted.'), { code: 'modrinth_archive_drift', statusCode: 409 })
        return await callback({ row, context, project, version, file, filePath, hashes, validated })
    } finally { await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => {}) }
}

function serializableValidation(value) {
    return {
        typeData: value.typeData,
        dependencies: value.dependencies,
        compositionIndex: value.compositionIndex,
        previewAvailable: Buffer.isBuffer(value.previewBuffer)
    }
}

function compareIndex(previousRows, nextValues, keyField, hashField) {
    const previous = new Map(previousRows.map(value => [String(value[keyField]).toLowerCase(), String(value[hashField] || '').toLowerCase()]))
    const next = new Map(nextValues.map(value => [String(value[keyField]).toLowerCase(), String(value[hashField] || '').toLowerCase()]))
    return {
        added: [...next.keys()].filter(key => !previous.has(key)).sort(),
        removed: [...previous.keys()].filter(key => !next.has(key)).sort(),
        changed: [...next.keys()].filter(key => previous.has(key) && previous.get(key) !== next.get(key)).sort()
    }
}

async function compositionDiff(itemId, index) {
    if(!itemId) return {
        files: { added: (index.files || []).map(value => value.path.toLowerCase()).sort(), removed: [], changed: [] },
        components: { added: (index.components || []).map(value => value.key.toLowerCase()).sort(), removed: [], changed: [] }
    }
    const [files, components] = await Promise.all([
        db.query('select f.path,f.sha256 from community_items i join community_resource_pack_files f on f.revision_id=i.current_revision_id where i.id=$1', [itemId]),
        db.query('select c.component_key,c.content_sha256 from community_items i join community_resource_components c on c.revision_id=i.current_revision_id where i.id=$1', [itemId])
    ])
    return {
        files: compareIndex(files.rows, index.files || [], 'path', 'sha256'),
        components: compareIndex(components.rows, (index.components || []).map(value => ({ component_key: value.key, content_sha256: value.contentSha256 })), 'component_key', 'content_sha256')
    }
}

async function prepareCandidate(userId, sourceId, candidateId, fileSha512 = null) {
    return withDownloadedCandidate(userId, sourceId, candidateId, fileSha512, async ({ row, file, hashes, validated }) => {
        if(row.state === 'published') throw Object.assign(new Error('This Modrinth release is already published.'), { code: 'modrinth_candidate_published', statusCode: 409 })
        const diff = await compositionDiff(row.item_id, validated.compositionIndex || { files: [], components: [] })
        await db.query(
            `update community_external_candidates set file_name=$2,file_size=$3,file_sha512=$4,state='prepared',
             prepared_sha256=$5,prepared_data=$6,prepared_at=now() where id=$1`,
            [candidateId, file.filename, hashes.sizeBytes, hashes.sha512, hashes.sha256,
                { ...(row.prepared_data || {}), validation: serializableValidation(validated), diff }])
        return { candidateId, state: 'prepared', sha256: hashes.sha256, sha512: hashes.sha512, sizeBytes: hashes.sizeBytes, fileName: file.filename, typeData: validated.typeData, componentCount: validated.compositionIndex?.components?.length || 0, fileCount: validated.compositionIndex?.files?.length || 0, diff }
    })
}

async function syncAllSources({ concurrency = config.modrinth.syncConcurrency } = {}) {
    const { rows } = await db.query('select * from community_external_sources where provider=\'modrinth\' and status=\'active\' order by last_checked_at nulls first,id')
    const results = []
    let cursor = 0
    async function worker() {
        while(cursor < rows.length) {
            const source = rows[cursor++]
            try { results.push({ sourceId: source.id, detected: await detectSource(source) }) }
            catch(error) {
                const status = error.code === 'modrinth_project_permission_required' ? 'ownership_lost'
                    : (['modrinth_project_ineligible','modrinth_project_incompatible'].includes(error.code) ? 'unavailable' : source.status)
                await db.query('update community_external_sources set status=$3,last_checked_at=now(),last_error=$2,updated_at=now() where id=$1', [source.id, String(error.code || 'sync_failed').slice(0, 120), status])
                results.push({ sourceId: source.id, error: error.code || 'sync_failed' })
            }
        }
    }
    await Promise.all(Array.from({ length: Math.max(1, Math.min(8, Number(concurrency) || 1)) }, worker))
    return results
}

module.exports = { authenticatedContext, checkSource, claimProject, compareIndex, compositionDiff, detectSource, listOwnedProjects, normalizeChannels, prepareCandidate, syncAllSources, validateProject, withDownloadedCandidate }
