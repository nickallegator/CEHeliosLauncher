'use strict'

const crypto = require('crypto')
const fs = require('fs')
const dns = require('dns').promises
const { Readable, Transform } = require('stream')
const { pipeline } = require('stream/promises')

const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024
const ALLOWED_DOWNLOAD_HOSTS = new Set(['cdn.modrinth.com'])

class ModrinthError extends Error {
    constructor(code, message, statusCode = 502, retryAfter = null) {
        super(message)
        this.name = 'ModrinthError'
        this.code = code
        this.statusCode = statusCode
        this.retryAfter = retryAfter
        this.upstreamStatus = null
    }
}

function validateDownloadUrl(value, { allowTestHosts = false } = {}) {
    let url
    try { url = new URL(value) } catch (_error) { throw new ModrinthError('modrinth_invalid_download_url', 'Modrinth returned an invalid download URL.') }
    const testHost = allowTestHosts && ['127.0.0.1', 'localhost'].includes(url.hostname)
    if((url.protocol !== 'https:' && !testHost) || (!ALLOWED_DOWNLOAD_HOSTS.has(url.hostname) && !testHost)) {
        throw new ModrinthError('modrinth_unsafe_download_url', 'Modrinth returned an unapproved download host.')
    }
    if(url.username || url.password) throw new ModrinthError('modrinth_unsafe_download_url', 'Authenticated download URLs are not supported.')
    return url
}

function isPrivateAddress(address) {
    const value = String(address || '').toLowerCase()
    if(value.startsWith('::ffff:')) return isPrivateAddress(value.slice(7))
    if(value === '::1' || value === '::' || value.startsWith('fe80:') || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('ff')) return true
    const match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(value)
    if(!match) return false
    const octets = match.slice(1).map(Number)
    return octets[0] === 10 || octets[0] === 127 || octets[0] === 0
        || (octets[0] === 169 && octets[1] === 254)
        || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
        || (octets[0] === 192 && octets[1] === 168)
        || (octets[0] >= 224)
}

function createModrinthProvider(settings, dependencies = {}) {
    const fetchImpl = dependencies.fetch || globalThis.fetch
    const allowTestHosts = dependencies.allowTestHosts === true
    const lookup = dependencies.lookup || dns.lookup
    const wait = dependencies.wait || (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)))
    let nextAllowedAt = 0
    async function request(pathname, { method = 'GET', token = null, body = null, timeoutMs = 10_000 } = {}) {
        for(let attempt = 0; attempt < 2; attempt++) {
            if(nextAllowedAt > Date.now()) await wait(Math.min(10_000, nextAllowedAt - Date.now()))
            const controller = new AbortController()
            const timeout = setTimeout(() => controller.abort(), timeoutMs)
            try {
                const response = await fetchImpl(new URL(pathname, settings.apiBase), {
                    method,
                    headers: {
                        Accept: 'application/json',
                        'Content-Type': 'application/json',
                        'User-Agent': settings.userAgent,
                        ...(token ? { Authorization: `Bearer ${token}` } : {})
                    },
                    body: body == null ? undefined : JSON.stringify(body),
                    signal: controller.signal,
                    redirect: 'error'
                })
                const remainingHeader = response.headers.get('x-ratelimit-remaining')
                const remaining = remainingHeader == null ? null : Number(remainingHeader)
                if(remaining != null && Number.isFinite(remaining) && remaining <= 0) {
                    const resetSeconds = Number(response.headers.get('x-ratelimit-reset') || 1)
                    nextAllowedAt = Date.now() + Math.min(10, Math.max(1, resetSeconds)) * 1000
                }
                if(!response.ok) {
                    const status = response.status
                    const retryable = method === 'GET' && (status === 429 || status >= 500) && attempt === 0
                    if(retryable) {
                        const seconds = Number(response.headers.get('retry-after') || 1)
                        await wait(Math.min(5, Math.max(1, seconds)) * 1000)
                        continue
                    }
                    const code = status === 401 ? 'modrinth_reconnect_required' : status === 429 ? 'modrinth_rate_limited' : 'modrinth_request_failed'
                    const error = new ModrinthError(code, `Modrinth request failed with HTTP ${status}.`, status === 401 ? 401 : status === 403 ? 403 : 502, response.headers.get('retry-after'))
                    error.upstreamStatus = status
                    throw error
                }
                return response.json()
            } catch(error) {
                if(error instanceof ModrinthError) throw error
                if(error?.name === 'AbortError') throw new ModrinthError('modrinth_timeout', 'Modrinth did not respond in time.')
                throw new ModrinthError('modrinth_unavailable', 'Modrinth is currently unavailable.')
            } finally { clearTimeout(timeout) }
        }
        throw new ModrinthError('modrinth_unavailable', 'Modrinth is currently unavailable.')
    }

    function authorizationUrl({ state }) {
        const url = new URL(settings.authorizeUrl)
        url.searchParams.set('client_id', settings.clientId)
        url.searchParams.set('redirect_uri', settings.redirectUri)
        url.searchParams.set('scope', settings.scopes.join(' '))
        url.searchParams.set('response_type', 'code')
        url.searchParams.set('state', state)
        return url.toString()
    }

    async function exchangeCode(code) {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 10_000)
        try {
            const response = await fetchImpl(settings.tokenUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json',
                    'User-Agent': settings.userAgent, Authorization: settings.clientSecret
                },
                body: new URLSearchParams({ client_id: settings.clientId, code, grant_type: 'authorization_code', redirect_uri: settings.redirectUri }),
                signal: controller.signal,
                redirect: 'error'
            })
            if(!response.ok) throw new ModrinthError('modrinth_oauth_exchange_failed', 'Modrinth rejected the authorization code.', 401)
            return response.json()
        } finally { clearTimeout(timeout) }
    }

    const identity = token => request('/v2/user', { token })
    const projects = token => request('/v2/user', { token }).then(user => request(`/v2/user/${encodeURIComponent(user.id)}/projects`, { token }))
    const project = (idOrSlug, token) => request(`/v2/project/${encodeURIComponent(idOrSlug)}`, { token })
    const teamMembers = (teamId, token) => request(`/v2/team/${encodeURIComponent(teamId)}/members`, { token })
    const versions = (projectId, token) => request(`/v2/project/${encodeURIComponent(projectId)}/version?game_versions=${encodeURIComponent(JSON.stringify(['1.21.1']))}&loaders=${encodeURIComponent(JSON.stringify(['minecraft']))}`, { token })
    const version = (versionId, token = null) => request(`/v2/version/${encodeURIComponent(versionId)}`, { token })

    async function verifyOwnership(projectValue, userId, token) {
        const members = await teamMembers(projectValue.team, token)
        const member = members.find(value => String(value.user?.id || value.user_id) === String(userId))
        const permissions = Number(member?.permissions || 0)
        // Modrinth documents UPLOAD_VERSION as the first bit in the team
        // permission bitfield. Read-only OAuth is sufficient to inspect it.
        if(!member || member.accepted !== true || (permissions & 1) === 0) {
            throw new ModrinthError('modrinth_project_permission_required', 'Your Modrinth account does not have permission to upload versions for this project.', 403)
        }
        return member
    }

    function selectVersionFile(versionValue, requestedSha512 = null) {
        const zipFiles = (versionValue.files || []).filter(file => /\.zip$/i.test(file.filename || ''))
        const candidates = requestedSha512 ? zipFiles.filter(file => file.hashes?.sha512 === requestedSha512) : zipFiles
        if(candidates.length === 1) return candidates[0]
        const primary = candidates.filter(file => file.primary === true)
        if(primary.length === 1) return primary[0]
        throw new ModrinthError('modrinth_file_selection_required', 'Select the Resource Pack ZIP for this Modrinth version.', 409)
    }

    async function resolveFile({ versionId, fileName, sha512 }, token = null) {
        const versionValue = await version(versionId, token)
        const file = (versionValue.files || []).find(value => value.filename === fileName && value.hashes?.sha512 === sha512)
        if(!file) throw new ModrinthError('modrinth_source_unavailable', 'The exact published Modrinth file is no longer available.', 410)
        return { version: versionValue, file, url: validateDownloadUrl(file.url, { allowTestHosts }).toString() }
    }

    async function downloadToFile(file, destination) {
        const url = validateDownloadUrl(file.url, { allowTestHosts })
        if(!allowTestHosts) {
            const addresses = await lookup(url.hostname, { all: true, verbatim: true })
            if(!Array.isArray(addresses) || !addresses.length || addresses.some(value => isPrivateAddress(value.address))) {
                throw new ModrinthError('modrinth_unsafe_download_address', 'Modrinth download host resolved to an unsafe network address.')
            }
        }
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 30_000)
        const sha512 = crypto.createHash('sha512')
        const sha256 = crypto.createHash('sha256')
        let size = 0
        try {
            const response = await fetchImpl(url, { headers: { 'User-Agent': settings.userAgent }, signal: controller.signal, redirect: 'error' })
            if(!response.ok || !response.body) throw new ModrinthError('modrinth_download_failed', `Modrinth download failed with HTTP ${response.status}.`)
            const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
            if(contentType && !['application/zip','application/octet-stream','binary/octet-stream','application/x-zip-compressed'].includes(contentType)) {
                throw new ModrinthError('modrinth_download_content_type', 'Modrinth returned an unexpected Resource Pack content type.')
            }
            const contentLength = Number(response.headers.get('content-length') || 0)
            if(contentLength > MAX_ARCHIVE_BYTES || Number(file.size || 0) > MAX_ARCHIVE_BYTES) throw new ModrinthError('modrinth_archive_too_large', 'The Modrinth Resource Pack exceeds the 100 MiB limit.', 400)
            const verifier = new Transform({ transform(chunk, _encoding, callback) {
                size += chunk.length
                if(size > MAX_ARCHIVE_BYTES) return callback(new ModrinthError('modrinth_archive_too_large', 'The Modrinth Resource Pack exceeds the 100 MiB limit.', 400))
                sha512.update(chunk); sha256.update(chunk); callback(null, chunk)
            } })
            await pipeline(Readable.fromWeb(response.body), verifier, fs.createWriteStream(destination, { flags: 'wx' }))
            const actualSha512 = sha512.digest('hex')
            if(actualSha512 !== file.hashes?.sha512 || (file.size != null && Number(file.size) !== size)) {
                throw new ModrinthError('modrinth_archive_drift', 'The Modrinth file did not match its published size and SHA-512.', 409)
            }
            return { sha512: actualSha512, sha256: sha256.digest('hex'), sizeBytes: size }
        } finally { clearTimeout(timeout) }
    }

    return { authorizationUrl, exchangeCode, identity, projects, project, teamMembers, versions, version, verifyOwnership, selectVersionFile, resolveFile, downloadToFile }
}

module.exports = { ALLOWED_DOWNLOAD_HOSTS, ModrinthError, createModrinthProvider, isPrivateAddress, validateDownloadUrl }
