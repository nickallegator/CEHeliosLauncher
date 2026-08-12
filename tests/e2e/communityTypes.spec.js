const { test, expect } = require('@playwright/test')
const { _electron: electron } = require('playwright')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

const appDir = path.resolve(__dirname, '..', '..')
const distributionPath = path.join(appDir, 'distribution_dev.json')
const playerUuid = '12345678123412341234123456789abc'

function json(res, status, value) {
    const bytes = Buffer.from(JSON.stringify(value))
    res.writeHead(status, {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json',
        'Content-Length': bytes.length
    })
    res.end(bytes)
}

function entry(type, index) {
    const id = `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`
    const typeData = {
        automation: { subtype: 'operation', nodeCount: 12, dependencyCount: 1 },
        'battle-trainers': { partySize: 3, minLevel: 20, maxLevel: 35, skill: 4 },
        'builder-presets': { gradientType: 'SMOOTH', nodeCount: 4, pinnedBlocks: ['minecraft:stone'] },
        'resource-packs': { namespaces: ['cobblepower'], entryCount: 24, packFormat: 34 }
    }[type]
    return {
        schemaVersion: 1,
        id,
        type,
        key: `${type}:${id}`,
        title: `${type} pilot`,
        description: `Portable ${type} fixture`,
        creator: { id: '1', name: 'Workshop Tester' },
        tags: ['pilot'],
        license: 'Community-Use-1.0',
        rightsAttestedAt: '2026-08-11T00:00:00.000Z',
        publishedAt: '2026-08-11T00:00:00.000Z',
        updatedAt: '2026-08-11T00:00:00.000Z',
        stats: { likes: index, views: index, downloads: index },
        compatibility: {
            minecraft: '1.21.1', loader: 'neoforge',
            cobblePower: '>=1.0.3-test.1 <1.1.0', cobblemon: '>=1.6.0 <1.7.0'
        },
        revision: {
            id: `22222222-2222-4222-8222-${String(index).padStart(12, '0')}`,
            number: 1,
            sha256: String(index).repeat(64).slice(0, 64),
            sizeBytes: 100,
            formatId: 'fixture',
            formatVersion: 1
        },
        dependencies: [],
        typeData
    }
}

async function startCommunityServer() {
    const types = ['automation', 'battle-trainers', 'builder-presets', 'resource-packs']
    const entries = types.map((type, index) => entry(type, index + 1))
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1')
        if(url.pathname === '/v1/community/capabilities') {
            json(res, 200, {
                schemaVersion: 1,
                defaultCategory: 'all',
                defaultSort: 'popular',
                categories: types.map(id => ({ id, readable: true, writable: true }))
            })
            return
        }
        if(url.pathname === '/v1/community/catalog') {
            const category = url.searchParams.get('category') || 'all'
            json(res, 200, {
                schemaVersion: 1,
                category,
                sort: 'popular',
                items: category === 'all' ? entries : entries.filter(value => value.type === category),
                nextCursor: null
            })
            return
        }
        const detail = url.pathname.match(/^\/v1\/community\/items\/([^/]+)\/([^/]+)$/)
        if(detail) {
            const value = entries.find(item => item.type === detail[1] && item.id === detail[2])
            json(res, value ? 200 : 404, value || { error: 'not_found' })
            return
        }
        json(res, 404, { error: 'not_found' })
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    return { server, baseUrl: `http://127.0.0.1:${server.address().port}` }
}

test('Community exposes all supported content categories and generic details', async () => {
    const api = await startCommunityServer()
    const userDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-community-types-e2e-'))
    fs.writeFileSync(path.join(userDataDirectory, 'config.json'), JSON.stringify({
        selectedServer: 'Cobble-Power-1.21.1',
        selectedAccount: playerUuid,
        authenticationDatabase: {
            [playerUuid]: {
                type: 'microsoft', accessToken: 'community-e2e-token', username: 'Workshop Tester',
                uuid: playerUuid, displayName: 'Workshop Tester', expiresAt: Date.now() + 3_600_000,
                microsoft: { access_token: 'ms-token', refresh_token: 'ms-refresh', expires_at: Date.now() + 3_600_000 }
            }
        }
    }))
    const application = await electron.launch({
        cwd: appDir,
        args: ['.', `--user-data-dir=${userDataDirectory}`],
        env: {
            ...process.env,
            NODE_ENV: 'test',
            HELIOS_DISTRO_DEV: '1',
            HELIOS_DISTRO_LOCAL_PATH: distributionPath,
            HELIOS_SCHEMATICS_API_URL: api.baseUrl
        }
    })
    try {
        const page = await application.firstWindow()
        await page.waitForLoadState('domcontentloaded')
        await expect(page.locator('#loadingContainer')).toBeHidden({ timeout: 10_000 })
        await page.locator('#shellNavCommunity').click()
        for(const type of ['automation', 'battle-trainers', 'builder-presets', 'resource-packs']) {
            await expect(page.locator(`[data-community-category="${type}"]`)).toBeVisible()
        }
        await expect(page.locator('.schematicCard')).toHaveCount(4)
        await expect(page.locator('.communityTypeSummary')).toHaveCount(4)
        await page.locator('[data-community-category="builder-presets"]').click()
        await expect(page.locator('.schematicCard')).toHaveCount(1)
        await page.locator('.schematicCard').click()
        await expect(page.locator('#communityContentDetail')).toHaveAttribute('aria-hidden', 'false')
        await expect(page.locator('#communityContentDetailType')).toContainText('Builder Presets')
        await expect(page.locator('#communityContentDetailLicense')).toHaveText('Community-Use-1.0')
    } finally {
        await application.close()
        await new Promise(resolve => api.server.close(resolve))
        fs.rmSync(userDataDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
})
