const fs = require('fs')
const path = require('path')
const { Client } = require('pg')
const dotenv = require('dotenv')

dotenv.config({ path: path.resolve(__dirname, '..', '.env') })

const args = process.argv.slice(2)
const flagAll = args.includes('--all')
const flagTest = args.includes('--test')
const urlArgIndex = args.findIndex(arg => arg === '--database-url')
const urlOverride = urlArgIndex >= 0 ? args[urlArgIndex + 1] : null

const databaseUrl = urlOverride || process.env.DATABASE_URL
const databaseUrlTest = process.env.DATABASE_URL_TEST
const migrationsDir = path.resolve(__dirname, '..', 'migrations')

function getMigrationFiles() {
    if(!fs.existsSync(migrationsDir)){
        return []
    }
    return fs.readdirSync(migrationsDir)
        .filter((file) => file.endsWith('.sql'))
        .sort()
}

async function ensureMigrationsTable(client) {
    await client.query(`
        create table if not exists schema_migrations (
            filename text primary key,
            applied_at timestamptz not null default now()
        )
    `)
}

async function getAppliedMigrations(client) {
    const result = await client.query('select filename from schema_migrations')
    return new Set(result.rows.map((row) => row.filename))
}

async function applyMigration(client, filename) {
    const filePath = path.join(migrationsDir, filename)
    const sql = fs.readFileSync(filePath, 'utf8')
    await client.query('begin')
    try{
        await client.query(sql)
        await client.query('insert into schema_migrations(filename) values ($1)', [filename])
        await client.query('commit')
        console.log(`[db:migrate] applied ${filename}`)
    }catch(err){
        await client.query('rollback')
        throw err
    }
}

async function migrateTarget(label, url) {
    if(!url){
        console.error(`[db:migrate] ${label} database URL is not set.`)
        return false
    }
    const files = getMigrationFiles()
    if(files.length === 0){
        console.log('[db:migrate] no migrations found')
        return true
    }

    const client = new Client({ connectionString: url })
    await client.connect()
    await ensureMigrationsTable(client)
    const applied = await getAppliedMigrations(client)

    for (const file of files){
        if(applied.has(file)){
            continue
        }
        await applyMigration(client, file)
    }

    await client.end()
    console.log(`[db:migrate] complete (${label})`)
    return true
}

async function run() {
    if(flagAll){
        const okMain = await migrateTarget('main', databaseUrl)
        const okTest = await migrateTarget('test', databaseUrlTest)
        if(!okMain || !okTest){
            process.exit(1)
        }
        return
    }

    if(flagTest){
        if(!databaseUrlTest){
            console.error('[db:migrate] DATABASE_URL_TEST is not set. Check backend/.env')
            process.exit(1)
        }
        await migrateTarget('test', databaseUrlTest)
        return
    }

    if(!databaseUrl){
        console.error('[db:migrate] DATABASE_URL is not set. Check backend/.env')
        process.exit(1)
    }
    await migrateTarget('main', databaseUrl)
}

run().catch((err) => {
    console.error('[db:migrate] failed', err)
    process.exit(1)
})
