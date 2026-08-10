const { test, expect } = require('@playwright/test')
const { _electron: electron } = require('playwright')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

test('packaged channel authorizes, installs a release, and clears it on explicit denial', async () => {
    test.setTimeout(60000)
    test.skip(!process.env.E2E_CHANNEL_EXE || process.env.E2E_CHANNEL_AUTH !== '1', 'Set E2E_CHANNEL_EXE and E2E_CHANNEL_AUTH=1 to run channel authorization E2E.')
    const executablePath = path.resolve(process.env.E2E_CHANNEL_EXE)
    const testerRoot = path.join(path.dirname(executablePath), 'resources', 'tester')
    const channel = JSON.parse(fs.readFileSync(path.join(testerRoot, 'tester-channel.json'), 'utf8'))
    const remoteUrl = new URL(channel.remoteDistributionUrl)
    test.skip(!['localhost', '127.0.0.1'].includes(remoteUrl.hostname), 'Authorization E2E requires a launcher built for a local API.')

    const distribution = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'distribution_dev.json'), 'utf8'))
    distribution.servers = distribution.servers.filter(server => server.id === 'Cobble-Power-1.21.1')
    distribution.servers[0].version = 'e2e-authorized-release'
    let allowDistribution = true
    const requests = []
    const server = http.createServer((req, res) => {
        requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization || null })
        if(req.method === 'POST' && req.url === '/v1/auth/minecraft') {
            const chunks = []
            req.on('data', chunk => chunks.push(chunk))
            req.on('end', () => {
                const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
                if(body.accessToken !== 'fake-minecraft-access-token') {
                    res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"error":"invalid_access_token"}')
                    return
                }
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({
                    token: 'backend-test-session',
                    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
                    userId: 'e2e-user',
                    profile: { uuid: '12345678123412341234123456789abc', displayName: 'E2E Tester', avatarUrl: null },
                    entitlements: ['minecraft:player', 'cobblepower:test']
                }))
            })
            return
        }
        if(req.method === 'GET' && req.url === remoteUrl.pathname) {
            if(req.headers.authorization !== 'Bearer backend-test-session') {
                res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"error":"invalid_token"}')
                return
            }
            if(!allowDistribution) {
                res.writeHead(403, { 'Content-Type': 'application/json' }).end('{"error":"channel_access_denied"}')
                return
            }
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Cache-Control': 'private, no-store',
                'X-CobblePower-Release': 'e2e-release-1'
            })
            res.end(JSON.stringify(distribution))
            return
        }
        res.writeHead(404).end()
    })
    await new Promise((resolve, reject) => server.listen(Number(remoteUrl.port), remoteUrl.hostname, err => err ? reject(err) : resolve()))

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cobblepower-channel-auth-'))
    const appData = path.join(tempRoot, 'appdata')
    const userData = path.join(tempRoot, 'user-data')
    const dataDirectory = path.join(appData, '.cobblepower-test-launcher')
    fs.mkdirSync(userData, { recursive: true })
    const uuid = '12345678123412341234123456789abc'
    fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
        settings: { launcher: { dataDirectory } },
        selectedServer: 'Cobble-Power-1.21.1',
        selectedAccount: uuid,
        authenticationDatabase: {
            [uuid]: {
                type: 'microsoft',
                accessToken: 'fake-minecraft-access-token',
                username: 'E2E Tester',
                uuid,
                displayName: 'E2E Tester',
                expiresAt: Date.now() + 3600_000,
                microsoft: { access_token: 'fake-ms-token', refresh_token: 'fake-refresh', expires_at: Date.now() + 3600_000 }
            }
        }
    }))
    const app = await electron.launch({
        executablePath,
        cwd: path.dirname(executablePath),
        args: [`--user-data-dir=${userData}`],
        env: { ...process.env, APPDATA: appData, LOCALAPPDATA: path.join(tempRoot, 'local-appdata') }
    })
    try {
        const page = await app.firstWindow()
        await page.locator('#loadingContainer').waitFor({ state: 'hidden', timeout: 25000 })
        const distributionPath = path.join(userData, 'distribution_dev.json')
        await expect.poll(() => JSON.parse(fs.readFileSync(distributionPath, 'utf8')).servers[0].version, { timeout: 5000 }).toBe('e2e-authorized-release')
        const cached = JSON.parse(fs.readFileSync(distributionPath, 'utf8'))
        expect(cached.servers[0].version, JSON.stringify(requests)).toBe('e2e-authorized-release')
        expect(requests.some(request => request.method === 'POST' && request.url === '/v1/auth/minecraft')).toBe(true)
        expect(requests.some(request => request.method === 'GET' && request.authorization === 'Bearer backend-test-session')).toBe(true)

        allowDistribution = false
        const session = await app.context().newCDPSession(page)
        await session.send('Runtime.enable')
        const evaluation = await session.send('Runtime.evaluate', {
            expression: `(async () => {
                const manager = require('./assets/js/channelmanager')
                const configManager = require('./assets/js/configmanager')
                try {
                    await manager.refreshAuthorizedDistribution({ allowOffline: false })
                    return { code: null }
                } catch(err) {
                    return { code: err.code, grant: configManager.getAccessChannelGrant() }
                }
            })()`,
            awaitPromise: true,
            returnByValue: true
        })
        expect(evaluation.exceptionDetails).toBeUndefined()
        const denial = evaluation.result.value
        expect(denial.code).toBe('access_denied')
        expect(denial.grant.releaseId).toBeNull()
        const reset = JSON.parse(fs.readFileSync(distributionPath, 'utf8'))
        expect(reset.servers[0].version).toBe('bootstrap')
    } finally {
        await app.close()
        await new Promise(resolve => server.close(resolve))
        fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
})
