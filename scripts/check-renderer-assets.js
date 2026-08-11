'use strict'

const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const assetsRoot = path.join(root, 'app', 'assets')
const requiredBrandAssets = [
    'brand/allegator-games-intro.svg',
    'brand/allegator-games-loading-chomp.svg',
    'brand/allegator-games-mark.svg',
    'brand/allegator-icons.svg',
    'fonts/PixelifySans-Variable.ttf',
    'fonts/AtkinsonHyperlegible-Regular.ttf',
    'fonts/AtkinsonHyperlegible-Bold.ttf',
    'fonts/licenses/PixelifySans-OFL.txt',
    'fonts/licenses/AtkinsonHyperlegible-OFL.txt'
]
const forbiddenExtensions = new Set(['.jpg', '.jpeg', '.webp'])
const maximumSingleAssetBytes = 512 * 1024
const maximumBrandPackageBytes = 400 * 1024

function walk(directory){
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const absolute = path.join(directory, entry.name)
        return entry.isDirectory() ? walk(absolute) : [absolute]
    })
}

function checkRendererAssets(){
    const failures = []
    const files = walk(assetsRoot)
    for(const relative of requiredBrandAssets){
        if(!fs.existsSync(path.join(assetsRoot, relative))) failures.push(`Missing required asset: ${relative}`)
    }
    if(fs.existsSync(path.join(assetsRoot, 'images', 'backgrounds'))){
        failures.push('The obsolete raster background directory must not be packaged.')
    }
    for(const file of files){
        const relative = path.relative(assetsRoot, file).replaceAll('\\', '/')
        const extension = path.extname(file).toLowerCase()
        const bytes = fs.statSync(file).size
        if(forbiddenExtensions.has(extension)) failures.push(`Unexpected raster artwork: ${relative}`)
        if(bytes > maximumSingleAssetBytes && !relative.startsWith('fonts/')){
            failures.push(`Renderer asset exceeds 512 KiB: ${relative} (${bytes} bytes)`)
        }
    }
    const brandBytes = requiredBrandAssets.reduce((total, relative) => {
        const file = path.join(assetsRoot, relative)
        return total + (fs.existsSync(file) ? fs.statSync(file).size : 0)
    }, 0)
    if(brandBytes > maximumBrandPackageBytes){
        failures.push(`Brand and font package exceeds 400 KiB (${brandBytes} bytes).`)
    }
    return { failures, brandBytes, assetCount: files.length }
}

if(require.main === module){
    const result = checkRendererAssets()
    if(result.failures.length > 0){
        result.failures.forEach((failure) => console.error(`- ${failure}`))
        process.exitCode = 1
    } else {
        console.log(`Renderer asset budget passed: ${result.assetCount} assets, ${result.brandBytes} brand bytes.`)
    }
}

module.exports = { checkRendererAssets }
