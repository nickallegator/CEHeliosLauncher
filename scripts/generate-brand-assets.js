'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const { Resvg } = require('@resvg/resvg-js')
const { appBuilderPath } = require('app-builder-bin')
const { optimize } = require('svgo')

const root = path.resolve(__dirname, '..')
const sourcePath = path.join(root, 'build', 'branding', 'allegator-games-logo-source.svg')
const rendererLogoPath = path.join(root, 'app', 'assets', 'brand', 'allegator-games-logo.svg')
const rendererIconPath = path.join(root, 'app', 'assets', 'brand', 'allegator-games-app-icon.png')
const buildDirectory = path.join(root, 'build')
const buildIconPath = path.join(buildDirectory, 'icon.png')

function writeIfChanged(filePath, value) {
    const next = Buffer.isBuffer(value) ? value : Buffer.from(value)
    if(fs.existsSync(filePath) && fs.readFileSync(filePath).equals(next)) return false
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, next)
    return true
}

function runIconBuilder(format) {
    const result = spawnSync(appBuilderPath, [
        'icon',
        '--format', format,
        '--out', buildDirectory,
        '--input', buildIconPath
    ], {
        cwd: root,
        encoding: 'utf8'
    })
    if(result.error) throw result.error
    if(result.status !== 0) {
        throw new Error(`Unable to generate ${format.toUpperCase()} icon: ${result.stderr || result.stdout}`)
    }
}

function generate() {
    if(!fs.existsSync(sourcePath)) {
        throw new Error(`Brand source is missing: ${sourcePath}`)
    }

    const source = fs.readFileSync(sourcePath, 'utf8')
    // The Inkscape master retains a hidden 4096px tracing reference. It is not
    // part of the logo and would add more than a megabyte to every launcher.
    const rendererSource = source.replace(
        /<image\b[\s\S]*?xlink:href="data:image\/[^;]+;base64,[^"]+"[\s\S]*?style="display:none[^"]*"\s*\/>/g,
        ''
    )
    if(/xlink:href="data:image\//.test(rendererSource)) {
        throw new Error('Optimized logo still contains an embedded raster image')
    }
    const optimized = optimize(rendererSource, {
        path: sourcePath,
        multipass: true,
        plugins: [
            'preset-default',
            'removeDimensions'
        ]
    })
    if(optimized.error) throw new Error(optimized.error)
    writeIfChanged(rendererLogoPath, `${optimized.data.trim()}\n`)

    const encodedLogo = Buffer.from(optimized.data).toString('base64')
    const squareSvg = [
        '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">',
        `<image href="data:image/svg+xml;base64,${encodedLogo}" x="32" y="32" width="960" height="960" preserveAspectRatio="xMidYMid meet"/>`,
        '</svg>'
    ].join('')
    const rendered = new Resvg(squareSvg, {
        fitTo: { mode: 'width', value: 1024 }
    }).render()
    const png = rendered.asPng()
    writeIfChanged(rendererIconPath, png)
    writeIfChanged(buildIconPath, png)

    runIconBuilder('ico')
    runIconBuilder('icns')

    for(const required of [rendererLogoPath, rendererIconPath, buildIconPath, path.join(buildDirectory, 'icon.ico'), path.join(buildDirectory, 'icon.icns')]) {
        if(!fs.existsSync(required) || fs.statSync(required).size === 0) {
            throw new Error(`Generated brand asset is missing or empty: ${required}`)
        }
    }

    console.log(`Optimized logo: ${path.relative(root, rendererLogoPath)} (${fs.statSync(rendererLogoPath).size} bytes)`)
    console.log(`Application icon: ${path.relative(root, buildIconPath)} (${fs.statSync(buildIconPath).size} bytes)`)
}

if(require.main === module) {
    try {
        generate()
    } catch(error) {
        console.error(error.message || error)
        process.exitCode = 1
    }
}

module.exports = { generate, sourcePath }
