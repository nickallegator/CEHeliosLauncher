const { normalizeJsonSchematic } = require('./index')

const example = {
    name: 'Watch Tower',
    category: 'utility',
    icon: 'minecraft:stone_bricks',
    blocks: [
        { pos: [0, 0, 0], block: 'minecraft:stone_bricks' },
        { pos: [1, 0, 0], block: 'minecraft:stone_bricks' },
        { pos: [0, 1, 0], block: 'minecraft:stone_bricks' },
        { pos: [1, 1, 0], block: 'minecraft:stone_bricks' },
        { pos: [0, 2, 0], block: 'minecraft:stone_bricks' },
        { pos: [1, 2, 0], block: 'minecraft:stone_bricks' },
        { pos: [0, 3, 0], block: 'minecraft:stone_bricks' },
        { pos: [1, 3, 0], block: 'minecraft:stone_bricks' },
        { pos: [0, 4, 0], block: 'minecraft:stone_bricks' },
        { pos: [1, 4, 0], block: 'minecraft:stone_bricks' },
        { pos: [1, 5, 0], block: 'minecraft:torch' }
    ]
}

async function run() {
    const { schematic, warnings } = await normalizeJsonSchematic(example)
    console.log('Warnings:', warnings)
    console.log('Normalized schematic:')
    console.dir(schematic, { depth: null })
}

run().catch((err) => {
    console.error(err)
    process.exitCode = 1
})
