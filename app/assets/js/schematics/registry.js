module.exports = {
    blockstates: {
        'minecraft:stone_bricks': {
            variants: {
                normal: { model: 'block/stone_bricks' }
            }
        },
        'minecraft:torch': {
            variants: {
                normal: { model: 'block/torch' }
            }
        }
    },
    models: {
        'block/cube_all': {
            elements: [
                { from: [0, 0, 0], to: [16, 16, 16] }
            ]
        },
        'block/stone_bricks': {
            parent: 'block/cube_all',
            textures: { all: 'block/stone_bricks' }
        },
        'block/torch': {
            elements: [
                { from: [6, 0, 6], to: [10, 10, 10] }
            ]
        }
    }
}
