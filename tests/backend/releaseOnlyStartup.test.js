const assert = require('node:assert/strict')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const test = require('node:test')

const rootDir = path.resolve(__dirname, '..', '..')
const backendDir = path.join(rootDir, 'backend')

async function reservePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer()
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address()
            server.close(error => error ? reject(error) : resolve(port))
        })
    })
}

async function waitForHealth(port, child, getOutput) {
    const deadline = Date.now() + 10_000
    while(Date.now() < deadline) {
        if(child.exitCode != null) {
            throw new Error(`backend exited before health check\n${getOutput()}`)
        }
        try {
            const response = await fetch(`http://127.0.0.1:${port}/health`)
            if(response.ok) {
                return response.json()
            }
        } catch(_err) {
            // Startup is still in progress.
        }
        await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error(`backend health check timed out\n${getOutput()}`)
}

test('release-only backend does not load schematics runtime modules', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cehelios-release-only-'))
    const denyHook = path.join(tempDir, 'deny-schematics.cjs')
    fs.writeFileSync(denyHook, `
const Module = require('node:module')
const originalLoad = Module._load
Module._load = function(request, parent, isMain) {
    const denied = [
        './routes/schematics',
        './routes/collections',
        './services/schematicsUploadTokens'
    ]
    if(denied.includes(request) || String(request).includes('schematics-core')) {
        throw new Error('release-only startup attempted to load schematics runtime: ' + request)
    }
    return originalLoad.call(this, request, parent, isMain)
}
`)

    const port = await reservePort()
    let stdout = ''
    let stderr = ''
    const child = spawn(process.execPath, ['src/index.js'], {
        cwd: backendDir,
        env: {
            ...process.env,
            PORT: String(port),
            DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/unused',
            RELEASES_ENABLED: 'false',
            SCHEMATICS_ENABLED: 'false',
            NODE_OPTIONS: `--require=${denyHook}`
        },
        stdio: ['ignore', 'pipe', 'pipe']
    })
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })

    try {
        const health = await waitForHealth(port, child, () => `${stdout}\n${stderr}`)
        assert.deepEqual(health, { ok: true })
    } finally {
        if(child.exitCode == null) {
            child.kill()
        }
        fs.rmSync(tempDir, { recursive: true, force: true })
    }
})
