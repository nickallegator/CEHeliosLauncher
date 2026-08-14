function ensureSchematicsMeshWorker(){
    if(schematicsMeshWorker){
        return schematicsMeshWorker
    }
    try {
        const workerPath = pathUtil.resolve(process.cwd(), 'app', 'assets', 'js', 'schematics', 'mesh-worker.js')
        schematicsMeshWorker = new SchematicMeshWorker(workerPath)
        schematicsMeshWorker.on('message', (message) => {
            if(!message || typeof message !== 'object'){
                return
            }
            if(message.type === 'ready'){
                schematicsMeshWorkerReady = true
                return
            }
            if(message.type !== 'result'){
                return
            }
            const task = schematicsMeshWorkerTasks.get(message.id)
            if(!task){
                return
            }
            schematicsMeshWorkerTasks.delete(message.id)
            if(message.ok){
                task.resolve(message.mesh || null)
            } else {
                task.reject(message.error || new Error('Mesh worker failed.'))
            }
        })
        schematicsMeshWorker.on('error', (err) => {
            loggerLanding.warn('Schematics mesh worker failed.', err)
            schematicsMeshWorkerReady = false
            for(const [, task] of schematicsMeshWorkerTasks){
                task.reject(err)
            }
            schematicsMeshWorkerTasks.clear()
            schematicsMeshWorker = null
        })
        schematicsMeshWorker.on('exit', (code) => {
            if(code !== 0){
                loggerLanding.warn(`Schematics mesh worker exited with code ${code}`)
            }
            schematicsMeshWorkerReady = false
            schematicsMeshWorker = null
        })
        return schematicsMeshWorker
    } catch (err) {
        loggerLanding.warn('Unable to start schematics mesh worker.', err)
        schematicsMeshWorkerReady = false
        schematicsMeshWorker = null
        return null
    }
}

function collectRegistrySubset(schematic){
    const subset = { blockstates: {}, models: {} }
    if(!schematic || !Array.isArray(schematic.palette)){
        return subset
    }

    const modelCache = new Set()
    const addModel = (modelId) => {
        if(!modelId || modelCache.has(modelId)){
            return
        }
        const model = schematicsRuntimeRegistry.models?.[modelId]
        if(!model){
            return
        }
        modelCache.add(modelId)
        subset.models[modelId] = model
        if(model.parent){
            addModel(model.parent)
        }
    }

    for(const entry of schematic.palette){
        const blockId = entry?.block
        if(!blockId){
            continue
        }
        const blockstate = schematicsRuntimeRegistry.blockstates?.[blockId]
        if(!blockstate){
            continue
        }
        subset.blockstates[blockId] = blockstate
        const modelIds = collectModelIdsFromBlockstate(blockstate)
        modelIds.forEach(addModel)
    }
    return subset
}

async function requestSchematicMeshBuild(payload){
    const worker = ensureSchematicsMeshWorker()
    if(!worker){
        return null
    }
    const id = ++schematicsMeshWorkerTaskId
    return new Promise((resolve, reject) => {
        schematicsMeshWorkerTasks.set(id, { resolve, reject })
        worker.postMessage({
            type: 'build',
            id,
            schematic: payload.schematic,
            registry: payload.registry,
            options: payload.options,
            atlasMapping: payload.atlasMapping || null
        })
    })
}

function resizePreviewCanvas(){
    return resizeCanvasToContainer(schematicsDetailCanvas, schematicsDetailPreview)
}

function renderPreviewPlaceholder(text, state = 'loading'){
    if(!schematicsDetailCanvas || !schematicsDetailPreview){
        return
    }
    schematicsDetailPreview.removeAttribute('data-mesh')
    schematicsDetailPreview.removeAttribute('data-texture-source')
    schematicsDetailPreview.setAttribute('data-preview-state', state)
    schematicsDetailPreview.setAttribute('data-rendered', 'false')
    const renderer = ensureSchematicPreviewRenderer()
    if(renderer && renderer.isWebGL){
        renderer.clearMesh()
        renderer.requestRender()
        return
    }
    const ctx = schematicsDetailCanvas.getContext('2d')
    if(!ctx){
        return
    }
    const { width, height, scale } = resizePreviewCanvas()
    ctx.clearRect(0, 0, width, height)
    ctx.fillStyle = 'rgba(6, 8, 12, 0.85)'
    ctx.fillRect(0, 0, width, height)
    ctx.fillStyle = 'rgba(255, 255, 255, 0.55)'
    ctx.font = `${12 * scale}px Avenir Book`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, width / 2, height / 2)
}

function renderSchematicPreviewFallback(schematic){
    if(!schematic || !schematicsDetailCanvas || !schematicsDetailPreview){
        return
    }
    const ctx = schematicsDetailCanvas.getContext('2d')
    if(!ctx){
        return
    }
    const { width, height, scale } = resizePreviewCanvas()
    const accent = schematicsDetailPanel
        ? getComputedStyle(schematicsDetailPanel).getPropertyValue('--schematic-accent') || '92, 160, 255'
        : '92, 160, 255'

    ctx.clearRect(0, 0, width, height)
    ctx.fillStyle = 'rgba(8, 10, 12, 0.9)'
    ctx.fillRect(0, 0, width, height)

    const margin = 24 * scale
    const box = {
        x: margin,
        y: margin,
        w: width - margin * 2,
        h: height - margin * 2
    }

    ctx.strokeStyle = `rgba(${accent}, 0.5)`
    ctx.lineWidth = 2 * scale
    ctx.strokeRect(box.x, box.y, box.w, box.h)

    const size = schematic.bounds?.size || [0, 0, 0]
    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)'
    ctx.font = `${12 * scale}px Avenir Book`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    ctx.fillText(`${schematic.name}`, box.x, box.y + 6 * scale)
    ctx.fillText(`Size: ${size[0]} x ${size[1]} x ${size[2]}`, box.x, box.y + 26 * scale)
    ctx.fillText(`Blocks: ${schematic.meta.blockCount}`, box.x, box.y + 44 * scale)
    ctx.fillText(`Palette: ${schematic.palette.length}`, box.x, box.y + 62 * scale)

    schematicsDetailPreview.setAttribute('data-rendered', 'true')
    schematicsDetailPreview.setAttribute('data-preview-state', 'fallback')
}

function resizeUploadPreviewCanvas(){
    return resizeCanvasToContainer(schematicsUploadCanvas, schematicsUploadPreview)
}

function renderUploadPreviewPlaceholder(text){
    if(!schematicsUploadCanvas || !schematicsUploadPreview){
        return
    }
    schematicsUploadPreview.removeAttribute('data-mesh')
    schematicsUploadPreview.setAttribute('data-preview-state', 'loading')
    schematicsUploadPreview.setAttribute('data-rendered', 'false')
    const renderer = ensureUploadPreviewRenderer()
    if(renderer && renderer.isWebGL){
        renderer.clearMesh()
        renderer.requestRender()
        return
    }
    const ctx = schematicsUploadCanvas.getContext('2d')
    if(!ctx){
        return
    }
    const { width, height, scale } = resizeUploadPreviewCanvas()
    ctx.clearRect(0, 0, width, height)
    ctx.fillStyle = 'rgba(6, 8, 12, 0.85)'
    ctx.fillRect(0, 0, width, height)
    ctx.fillStyle = 'rgba(255, 255, 255, 0.55)'
    ctx.font = `${12 * scale}px Avenir Book`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, width / 2, height / 2)
}

function renderUploadSchematicPreviewFallback(schematic){
    if(!schematic || !schematicsUploadCanvas || !schematicsUploadPreview){
        return
    }
    schematicsUploadPreview.removeAttribute('data-mesh')
    const ctx = schematicsUploadCanvas.getContext('2d')
    if(!ctx){
        return
    }
    const { width, height, scale } = resizeUploadPreviewCanvas()
    ctx.clearRect(0, 0, width, height)
    ctx.fillStyle = 'rgba(8, 10, 12, 0.9)'
    ctx.fillRect(0, 0, width, height)

    const margin = 18 * scale
    const box = {
        x: margin,
        y: margin,
        w: width - margin * 2,
        h: height - margin * 2
    }

    ctx.strokeStyle = 'rgba(92, 160, 255, 0.55)'
    ctx.lineWidth = 2 * scale
    ctx.strokeRect(box.x, box.y, box.w, box.h)

    const size = schematic.bounds?.size || [0, 0, 0]
    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)'
    ctx.font = `${12 * scale}px Avenir Book`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    ctx.fillText(`${schematic.name || 'Schematic'}`, box.x, box.y + 6 * scale)
    ctx.fillText(`Size: ${size[0]} x ${size[1]} x ${size[2]}`, box.x, box.y + 24 * scale)
    ctx.fillText(`Blocks: ${schematic.meta.blockCount}`, box.x, box.y + 42 * scale)
    ctx.fillText(`Palette: ${schematic.palette.length}`, box.x, box.y + 60 * scale)

    schematicsUploadPreview.setAttribute('data-rendered', 'true')
    schematicsUploadPreview.setAttribute('data-preview-state', 'fallback')
}

function waitForRendererMesh(renderer, timeoutMs = 4000){
    return new Promise((resolve) => {
        if(!renderer || !renderer.isWebGL){
            resolve(true)
            return
        }
        const start = Date.now()
        const check = () => {
            if(renderer.meshVertexCount > 0 || renderer.blocksCount > 0){
                resolve(true)
                return
            }
            if(Date.now() - start > timeoutMs){
                resolve(false)
                return
            }
            requestAnimationFrame(check)
        }
        check()
    })
}

function capturePreviewBlob(renderer, width, height, mime = 'image/png'){
    return new Promise((resolve) => {
        if(!renderer || !renderer.canvas){
            resolve(null)
            return
        }
        try {
            renderer.render()
        } catch (err) {
            resolve(null)
            return
        }
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d')
        if(!ctx){
            resolve(null)
            return
        }
        ctx.imageSmoothingEnabled = false
        ctx.fillStyle = '#0b0f14'
        ctx.fillRect(0, 0, width, height)
        const srcW = renderer.canvas.width
        const srcH = renderer.canvas.height
        if(srcW > 0 && srcH > 0){
            const srcAspect = srcW / srcH
            const dstAspect = width / height
            let sx = 0
            let sy = 0
            let sw = srcW
            let sh = srcH
            if(srcAspect > dstAspect){
                sw = Math.floor(srcH * dstAspect)
                sx = Math.floor((srcW - sw) / 2)
            } else if(srcAspect < dstAspect){
                sh = Math.floor(srcW / dstAspect)
                sy = Math.floor((srcH - sh) / 2)
            }
            ctx.drawImage(renderer.canvas, sx, sy, sw, sh, 0, 0, width, height)
        }
        canvas.toBlob((blob) => {
            resolve(blob || null)
        }, mime)
    })
}

function getUploadThumbnailSizes(){
    let aspect = 1.6
    if(schematicsUploadPreview){
        const rect = schematicsUploadPreview.getBoundingClientRect()
        if(rect.width > 0 && rect.height > 0){
            aspect = rect.width / rect.height
        }
    }
    const mediumW = 320
    const mediumH = Math.max(120, Math.round(mediumW / aspect))
    const tinyW = 160
    const tinyH = Math.max(60, Math.round(tinyW / aspect))
    return {
        medium: { width: mediumW, height: mediumH },
        tiny: { width: tinyW, height: tinyH }
    }
}

function blobToBase64(blob){
    return new Promise((resolve) => {
        if(!blob){
            resolve(null)
            return
        }
        const reader = new FileReader()
        reader.onloadend = () => {
            const result = typeof reader.result === 'string' ? reader.result : ''
            const comma = result.indexOf(',')
            resolve(comma >= 0 ? result.slice(comma + 1) : result)
        }
        reader.onerror = () => resolve(null)
        reader.readAsDataURL(blob)
    })
}

function createMat4(){
    return new Float32Array(16)
}

function mat4Identity(out){
    out[0] = 1; out[1] = 0; out[2] = 0; out[3] = 0
    out[4] = 0; out[5] = 1; out[6] = 0; out[7] = 0
    out[8] = 0; out[9] = 0; out[10] = 1; out[11] = 0
    out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 1
    return out
}

function mat4Perspective(out, fovy, aspect, near, far){
    const f = 1.0 / Math.tan(fovy / 2)
    out[0] = f / aspect
    out[1] = 0
    out[2] = 0
    out[3] = 0
    out[4] = 0
    out[5] = f
    out[6] = 0
    out[7] = 0
    out[8] = 0
    out[9] = 0
    out[10] = (far + near) / (near - far)
    out[11] = -1
    out[12] = 0
    out[13] = 0
    out[14] = (2 * far * near) / (near - far)
    out[15] = 0
    return out
}

function mat4LookAt(out, eye, center, up){
    let x0, x1, x2, y0, y1, y2, z0, z1, z2, len
    z0 = eye[0] - center[0]
    z1 = eye[1] - center[1]
    z2 = eye[2] - center[2]
    len = Math.hypot(z0, z1, z2)
    if(len === 0){
        z2 = 1
    } else {
        z0 /= len; z1 /= len; z2 /= len
    }
    x0 = up[1] * z2 - up[2] * z1
    x1 = up[2] * z0 - up[0] * z2
    x2 = up[0] * z1 - up[1] * z0
    len = Math.hypot(x0, x1, x2)
    if(len === 0){
        x0 = 0; x1 = 0; x2 = 0
    } else {
        x0 /= len; x1 /= len; x2 /= len
    }
    y0 = z1 * x2 - z2 * x1
    y1 = z2 * x0 - z0 * x2
    y2 = z0 * x1 - z1 * x0
    len = Math.hypot(y0, y1, y2)
    if(len !== 0){
        y0 /= len; y1 /= len; y2 /= len
    }
    out[0] = x0; out[1] = y0; out[2] = z0; out[3] = 0
    out[4] = x1; out[5] = y1; out[6] = z1; out[7] = 0
    out[8] = x2; out[9] = y2; out[10] = z2; out[11] = 0
    out[12] = -(x0 * eye[0] + x1 * eye[1] + x2 * eye[2])
    out[13] = -(y0 * eye[0] + y1 * eye[1] + y2 * eye[2])
    out[14] = -(z0 * eye[0] + z1 * eye[1] + z2 * eye[2])
    out[15] = 1
    return out
}

function mat4Multiply(out, a, b){
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3]
    const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7]
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11]
    const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15]

    let b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3]
    out[0] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30
    out[1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31
    out[2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32
    out[3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33

    b0 = b[4]; b1 = b[5]; b2 = b[6]; b3 = b[7]
    out[4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30
    out[5] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31
    out[6] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32
    out[7] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33

    b0 = b[8]; b1 = b[9]; b2 = b[10]; b3 = b[11]
    out[8] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30
    out[9] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31
    out[10] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32
    out[11] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33

    b0 = b[12]; b1 = b[13]; b2 = b[14]; b3 = b[15]
    out[12] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30
    out[13] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31
    out[14] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32
    out[15] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33
    return out
}

function computePreviewCameraRadius(boundsSize, aspect, fov = Math.PI / 4){
    const dimensions = Array.isArray(boundsSize) ? boundsSize.map(value => Math.max(1, Number(value) || 1)) : [1, 1, 1]
    const boundingRadius = Math.hypot(dimensions[0], dimensions[1], dimensions[2]) / 2
    const safeAspect = Math.max(0.2, Number(aspect) || 1)
    const horizontalFov = 2 * Math.atan(Math.tan(fov / 2) * safeAspect)
    const limitingFov = Math.max(0.2, Math.min(fov, horizontalFov))
    return Math.max(6, boundingRadius / Math.sin(limitingFov / 2) * 1.12)
}

class SchematicPreviewRenderer {
    constructor(canvas, container){
        this.canvas = canvas
        this.container = container
        this.gl = canvas.getContext('webgl2', { antialias: true, alpha: true })
        this.isWebGL = Boolean(this.gl)
        this.ctx2d = this.gl ? null : canvas.getContext('2d')
        this.program = null
        this.vao = null
        this.cubePositionBuffer = null
        this.cubeNormalBuffer = null
        this.instanceOffsetBuffer = null
        this.instanceColorBuffer = null
        this.meshVao = null
        this.meshPositionBuffer = null
        this.meshNormalBuffer = null
        this.meshColorBuffer = null
        this.meshUvBuffer = null
        this.meshEmissiveBuffer = null
        this.meshAoBuffer = null
        this.meshCutoutVao = null
        this.meshCutoutPositionBuffer = null
        this.meshCutoutNormalBuffer = null
        this.meshCutoutColorBuffer = null
        this.meshCutoutUvBuffer = null
        this.meshCutoutEmissiveBuffer = null
        this.meshCutoutAoBuffer = null
        this.meshCutoutTexturedVao = null
        this.meshTransVao = null
        this.meshTransPositionBuffer = null
        this.meshTransNormalBuffer = null
        this.meshTransColorBuffer = null
        this.meshTransUvBuffer = null
        this.meshTransEmissiveBuffer = null
        this.meshTransAoBuffer = null
        this.meshTransTexturedVao = null
        this.meshTexturedVao = null
        this.textureProgram = null
        this.textureUniforms = {}
        this.textureAtlas = null
        this.uniforms = {}
        this.blocksCount = 0
        this.meshVertexCount = 0
        this.meshCutoutVertexCount = 0
        this.meshTransVertexCount = 0
        this.meshHasUvs = false
        this.meshCutoutHasUvs = false
        this.meshTransHasUvs = false
        this.meshTransBase = null
        this.meshTransSorted = null
        this.meshTransSortDirty = true
        this.lastTransSortEye = null
        this.meshTaskId = 0
        this.boundsSize = [1, 1, 1]
        this.center = [0, 0, 0]
        this.radius = 10
        this.yaw = -0.8
        this.pitch = 0.5
        this.dragging = false
        this.panning = false
        this.lastX = 0
        this.lastY = 0
        this.needsRender = true
        this.isActive = true
        this.frameRequested = false
        this.view = createMat4()
        this.proj = createMat4()
        this.viewProj = createMat4()
        this._onPointerDown = this.onPointerDown.bind(this)
        this._onPointerMove = this.onPointerMove.bind(this)
        this._onPointerUp = this.onPointerUp.bind(this)
        this._onWheel = this.onWheel.bind(this)
        this._onContextMenu = (event) => event.preventDefault()
        this._onResize = () => this.requestRender()

        this.container.addEventListener('pointerdown', this._onPointerDown)
        window.addEventListener('pointermove', this._onPointerMove)
        window.addEventListener('pointerup', this._onPointerUp)
        this.container.addEventListener('wheel', this._onWheel, { passive: false })
        this.container.addEventListener('contextmenu', this._onContextMenu)
        window.addEventListener('resize', this._onResize)

        if(this.isWebGL){
            this.initGL()
            this.requestRender()
        }
    }

    resizeCanvas(){
        return resizeCanvasToContainer(this.canvas, this.container)
    }

    initGL(){
        const gl = this.gl
        if(!gl){
            return
        }
        const createProgram = (vertexSource, fragmentSource) => {
            const vert = gl.createShader(gl.VERTEX_SHADER)
            gl.shaderSource(vert, vertexSource)
            gl.compileShader(vert)
            const frag = gl.createShader(gl.FRAGMENT_SHADER)
            gl.shaderSource(frag, fragmentSource)
            gl.compileShader(frag)
            const program = gl.createProgram()
            gl.attachShader(program, vert)
            gl.attachShader(program, frag)
            gl.linkProgram(program)
            gl.deleteShader(vert)
            gl.deleteShader(frag)
            return program
        }

        const vertexSource = `#version 300 es
        in vec3 aPosition;
        in vec3 aNormal;
        in vec3 aOffset;
        in vec3 aColor;
        uniform mat4 uViewProj;
        uniform vec3 uLightDir;
        out vec3 vColor;
        void main() {
            vec3 pos = aPosition + aOffset;
            gl_Position = uViewProj * vec4(pos, 1.0);
            float light = max(dot(normalize(aNormal), normalize(uLightDir)), 0.2);
            vColor = aColor * light;
        }`
        const fragmentSource = `#version 300 es
        precision highp float;
        in vec3 vColor;
        out vec4 outColor;
        void main() {
            outColor = vec4(vColor, 0.94);
        }`
        const textureVertexSource = `#version 300 es
        in vec3 aPosition;
        in vec3 aNormal;
        in vec3 aColor;
        in vec2 aUv;
        in float aEmissive;
        in float aAo;
        uniform mat4 uViewProj;
        uniform vec3 uLightDir;
        uniform float uAmbient;
        out vec3 vColor;
        out float vEmissive;
        out vec2 vUv;
        void main() {
            gl_Position = uViewProj * vec4(aPosition, 1.0);
            float light = max(dot(normalize(aNormal), normalize(uLightDir)), uAmbient);
            vColor = aColor * light * aAo;
            vEmissive = aEmissive;
            vUv = aUv;
        }`
        const textureFragmentSource = `#version 300 es
        precision highp float;
        in vec3 vColor;
        in vec2 vUv;
        in float vEmissive;
        uniform sampler2D uAtlas;
        uniform float uAlphaCutoff;
        out vec4 outColor;
        void main() {
            vec4 tex = texture(uAtlas, vUv);
            if(uAlphaCutoff > 0.0 && tex.a < uAlphaCutoff){
                discard;
            }
            vec3 base = vColor * tex.rgb;
            vec3 glow = tex.rgb * vEmissive;
            outColor = vec4(base + glow, tex.a);
        }`

        this.program = createProgram(vertexSource, fragmentSource)
        this.textureProgram = createProgram(textureVertexSource, textureFragmentSource)

        this.vao = gl.createVertexArray()
        this.cubePositionBuffer = gl.createBuffer()
        this.cubeNormalBuffer = gl.createBuffer()
        this.instanceOffsetBuffer = gl.createBuffer()
        this.instanceColorBuffer = gl.createBuffer()
        this.meshVao = gl.createVertexArray()
        this.meshTexturedVao = gl.createVertexArray()
        this.meshPositionBuffer = gl.createBuffer()
        this.meshNormalBuffer = gl.createBuffer()
        this.meshColorBuffer = gl.createBuffer()
        this.meshUvBuffer = gl.createBuffer()
        this.meshEmissiveBuffer = gl.createBuffer()
        this.meshAoBuffer = gl.createBuffer()
        this.meshCutoutVao = gl.createVertexArray()
        this.meshCutoutTexturedVao = gl.createVertexArray()
        this.meshCutoutPositionBuffer = gl.createBuffer()
        this.meshCutoutNormalBuffer = gl.createBuffer()
        this.meshCutoutColorBuffer = gl.createBuffer()
        this.meshCutoutUvBuffer = gl.createBuffer()
        this.meshCutoutEmissiveBuffer = gl.createBuffer()
        this.meshCutoutAoBuffer = gl.createBuffer()
        this.meshTransVao = gl.createVertexArray()
        this.meshTransTexturedVao = gl.createVertexArray()
        this.meshTransPositionBuffer = gl.createBuffer()
        this.meshTransNormalBuffer = gl.createBuffer()
        this.meshTransColorBuffer = gl.createBuffer()
        this.meshTransUvBuffer = gl.createBuffer()
        this.meshTransEmissiveBuffer = gl.createBuffer()
        this.meshTransAoBuffer = gl.createBuffer()

        const cubeData = buildUnitCube()
        gl.bindVertexArray(this.vao)
        gl.bindBuffer(gl.ARRAY_BUFFER, this.cubePositionBuffer)
        gl.bufferData(gl.ARRAY_BUFFER, cubeData.positions, gl.STATIC_DRAW)
        const positionLoc = gl.getAttribLocation(this.program, 'aPosition')
        gl.enableVertexAttribArray(positionLoc)
        gl.vertexAttribPointer(positionLoc, 3, gl.FLOAT, false, 0, 0)

        gl.bindBuffer(gl.ARRAY_BUFFER, this.cubeNormalBuffer)
        gl.bufferData(gl.ARRAY_BUFFER, cubeData.normals, gl.STATIC_DRAW)
        const normalLoc = gl.getAttribLocation(this.program, 'aNormal')
        gl.enableVertexAttribArray(normalLoc)
        gl.vertexAttribPointer(normalLoc, 3, gl.FLOAT, false, 0, 0)

        gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceOffsetBuffer)
        const offsetLoc = gl.getAttribLocation(this.program, 'aOffset')
        gl.enableVertexAttribArray(offsetLoc)
        gl.vertexAttribPointer(offsetLoc, 3, gl.FLOAT, false, 0, 0)
        gl.vertexAttribDivisor(offsetLoc, 1)

        gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceColorBuffer)
        const colorLoc = gl.getAttribLocation(this.program, 'aColor')
        gl.enableVertexAttribArray(colorLoc)
        gl.vertexAttribPointer(colorLoc, 3, gl.FLOAT, false, 0, 0)
        gl.vertexAttribDivisor(colorLoc, 1)

        gl.bindVertexArray(null)

        gl.bindVertexArray(this.meshVao)
        gl.bindBuffer(gl.ARRAY_BUFFER, this.meshPositionBuffer)
        const meshPositionLoc = gl.getAttribLocation(this.program, 'aPosition')
        gl.enableVertexAttribArray(meshPositionLoc)
        gl.vertexAttribPointer(meshPositionLoc, 3, gl.FLOAT, false, 0, 0)

        gl.bindBuffer(gl.ARRAY_BUFFER, this.meshNormalBuffer)
        const meshNormalLoc = gl.getAttribLocation(this.program, 'aNormal')
        gl.enableVertexAttribArray(meshNormalLoc)
        gl.vertexAttribPointer(meshNormalLoc, 3, gl.FLOAT, false, 0, 0)

        gl.bindBuffer(gl.ARRAY_BUFFER, this.meshColorBuffer)
        const meshColorLoc = gl.getAttribLocation(this.program, 'aColor')
        gl.enableVertexAttribArray(meshColorLoc)
        gl.vertexAttribPointer(meshColorLoc, 3, gl.FLOAT, false, 0, 0)

        gl.bindVertexArray(null)

        gl.bindVertexArray(this.meshTexturedVao)
        gl.bindBuffer(gl.ARRAY_BUFFER, this.meshPositionBuffer)
        const meshTexPositionLoc = gl.getAttribLocation(this.textureProgram, 'aPosition')
        gl.enableVertexAttribArray(meshTexPositionLoc)
        gl.vertexAttribPointer(meshTexPositionLoc, 3, gl.FLOAT, false, 0, 0)

        gl.bindBuffer(gl.ARRAY_BUFFER, this.meshNormalBuffer)
        const meshTexNormalLoc = gl.getAttribLocation(this.textureProgram, 'aNormal')
        gl.enableVertexAttribArray(meshTexNormalLoc)
        gl.vertexAttribPointer(meshTexNormalLoc, 3, gl.FLOAT, false, 0, 0)

        gl.bindBuffer(gl.ARRAY_BUFFER, this.meshColorBuffer)
        const meshTexColorLoc = gl.getAttribLocation(this.textureProgram, 'aColor')
        gl.enableVertexAttribArray(meshTexColorLoc)
        gl.vertexAttribPointer(meshTexColorLoc, 3, gl.FLOAT, false, 0, 0)

        gl.bindBuffer(gl.ARRAY_BUFFER, this.meshUvBuffer)
        const meshTexUvLoc = gl.getAttribLocation(this.textureProgram, 'aUv')
        gl.enableVertexAttribArray(meshTexUvLoc)
        gl.vertexAttribPointer(meshTexUvLoc, 2, gl.FLOAT, false, 0, 0)

        gl.bindBuffer(gl.ARRAY_BUFFER, this.meshEmissiveBuffer)
        const meshTexEmissiveLoc = gl.getAttribLocation(this.textureProgram, 'aEmissive')
        gl.enableVertexAttribArray(meshTexEmissiveLoc)
        gl.vertexAttribPointer(meshTexEmissiveLoc, 1, gl.FLOAT, false, 0, 0)

        gl.bindBuffer(gl.ARRAY_BUFFER, this.meshAoBuffer)
        const meshTexAoLoc = gl.getAttribLocation(this.textureProgram, 'aAo')
        gl.enableVertexAttribArray(meshTexAoLoc)
        gl.vertexAttribPointer(meshTexAoLoc, 1, gl.FLOAT, false, 0, 0)

        gl.bindVertexArray(null)

        gl.bindVertexArray(this.meshTransVao)
        gl.bindBuffer(gl.ARRAY_BUFFER, this.meshTransPositionBuffer)
        const meshTransPositionLoc = gl.getAttribLocation(this.program, 'aPosition')
        gl.enableVertexAttribArray(meshTransPositionLoc)
        gl.vertexAttribPointer(meshTransPositionLoc, 3, gl.FLOAT, false, 0, 0)

        gl.bindBuffer(gl.ARRAY_BUFFER, this.meshTransNormalBuffer)
        const meshTransNormalLoc = gl.getAttribLocation(this.program, 'aNormal')
        gl.enableVertexAttribArray(meshTransNormalLoc)
        gl.vertexAttribPointer(meshTransNormalLoc, 3, gl.FLOAT, false, 0, 0)

        gl.bindBuffer(gl.ARRAY_BUFFER, this.meshTransColorBuffer)
        const meshTransColorLoc = gl.getAttribLocation(this.program, 'aColor')
        gl.enableVertexAttribArray(meshTransColorLoc)
        gl.vertexAttribPointer(meshTransColorLoc, 3, gl.FLOAT, false, 0, 0)

        gl.bindVertexArray(null)

        gl.bindVertexArray(this.meshCutoutVao)
        gl.bindBuffer(gl.ARRAY_BUFFER, this.meshCutoutPositionBuffer)
        const meshCutoutPositionLoc = gl.getAttribLocation(this.program, 'aPosition')
        gl.enableVertexAttribArray(meshCutoutPositionLoc)
        gl.vertexAttribPointer(meshCutoutPositionLoc, 3, gl.FLOAT, false, 0, 0)

        gl.bindBuffer(gl.ARRAY_BUFFER, this.meshCutoutNormalBuffer)
        const meshCutoutNormalLoc = gl.getAttribLocation(this.program, 'aNormal')
        gl.enableVertexAttribArray(meshCutoutNormalLoc)
        gl.vertexAttribPointer(meshCutoutNormalLoc, 3, gl.FLOAT, false, 0, 0)

        gl.bindBuffer(gl.ARRAY_BUFFER, this.meshCutoutColorBuffer)
        const meshCutoutColorLoc = gl.getAttribLocation(this.program, 'aColor')
        gl.enableVertexAttribArray(meshCutoutColorLoc)
        gl.vertexAttribPointer(meshCutoutColorLoc, 3, gl.FLOAT, false, 0, 0)

        gl.bindVertexArray(null)

        gl.bindVertexArray(this.meshCutoutTexturedVao)
        gl.bindBuffer(gl.ARRAY_BUFFER, this.meshCutoutPositionBuffer)
        const meshCutoutTexPositionLoc = gl.getAttribLocation(this.textureProgram, 'aPosition')
        gl.enableVertexAttribArray(meshCutoutTexPositionLoc)
        gl.vertexAttribPointer(meshCutoutTexPositionLoc, 3, gl.FLOAT, false, 0, 0)

        gl.bindBuffer(gl.ARRAY_BUFFER, this.meshCutoutNormalBuffer)
        const meshCutoutTexNormalLoc = gl.getAttribLocation(this.textureProgram, 'aNormal')
        gl.enableVertexAttribArray(meshCutoutTexNormalLoc)
        gl.vertexAttribPointer(meshCutoutTexNormalLoc, 3, gl.FLOAT, false, 0, 0)

        gl.bindBuffer(gl.ARRAY_BUFFER, this.meshCutoutColorBuffer)
        const meshCutoutTexColorLoc = gl.getAttribLocation(this.textureProgram, 'aColor')
        gl.enableVertexAttribArray(meshCutoutTexColorLoc)
        gl.vertexAttribPointer(meshCutoutTexColorLoc, 3, gl.FLOAT, false, 0, 0)

        gl.bindBuffer(gl.ARRAY_BUFFER, this.meshCutoutUvBuffer)
        const meshCutoutTexUvLoc = gl.getAttribLocation(this.textureProgram, 'aUv')
        gl.enableVertexAttribArray(meshCutoutTexUvLoc)
        gl.vertexAttribPointer(meshCutoutTexUvLoc, 2, gl.FLOAT, false, 0, 0)

        gl.bindBuffer(gl.ARRAY_BUFFER, this.meshCutoutEmissiveBuffer)
        const meshCutoutTexEmissiveLoc = gl.getAttribLocation(this.textureProgram, 'aEmissive')
        gl.enableVertexAttribArray(meshCutoutTexEmissiveLoc)
        gl.vertexAttribPointer(meshCutoutTexEmissiveLoc, 1, gl.FLOAT, false, 0, 0)

        gl.bindBuffer(gl.ARRAY_BUFFER, this.meshCutoutAoBuffer)
        const meshCutoutTexAoLoc = gl.getAttribLocation(this.textureProgram, 'aAo')
        gl.enableVertexAttribArray(meshCutoutTexAoLoc)
        gl.vertexAttribPointer(meshCutoutTexAoLoc, 1, gl.FLOAT, false, 0, 0)

        gl.bindVertexArray(null)

        gl.bindVertexArray(this.meshTransTexturedVao)
        gl.bindBuffer(gl.ARRAY_BUFFER, this.meshTransPositionBuffer)
        const meshTransTexPositionLoc = gl.getAttribLocation(this.textureProgram, 'aPosition')
        gl.enableVertexAttribArray(meshTransTexPositionLoc)
        gl.vertexAttribPointer(meshTransTexPositionLoc, 3, gl.FLOAT, false, 0, 0)

        gl.bindBuffer(gl.ARRAY_BUFFER, this.meshTransNormalBuffer)
        const meshTransTexNormalLoc = gl.getAttribLocation(this.textureProgram, 'aNormal')
        gl.enableVertexAttribArray(meshTransTexNormalLoc)
        gl.vertexAttribPointer(meshTransTexNormalLoc, 3, gl.FLOAT, false, 0, 0)

        gl.bindBuffer(gl.ARRAY_BUFFER, this.meshTransColorBuffer)
        const meshTransTexColorLoc = gl.getAttribLocation(this.textureProgram, 'aColor')
        gl.enableVertexAttribArray(meshTransTexColorLoc)
        gl.vertexAttribPointer(meshTransTexColorLoc, 3, gl.FLOAT, false, 0, 0)

        gl.bindBuffer(gl.ARRAY_BUFFER, this.meshTransUvBuffer)
        const meshTransTexUvLoc = gl.getAttribLocation(this.textureProgram, 'aUv')
        gl.enableVertexAttribArray(meshTransTexUvLoc)
        gl.vertexAttribPointer(meshTransTexUvLoc, 2, gl.FLOAT, false, 0, 0)

        gl.bindBuffer(gl.ARRAY_BUFFER, this.meshTransEmissiveBuffer)
        const meshTransTexEmissiveLoc = gl.getAttribLocation(this.textureProgram, 'aEmissive')
        gl.enableVertexAttribArray(meshTransTexEmissiveLoc)
        gl.vertexAttribPointer(meshTransTexEmissiveLoc, 1, gl.FLOAT, false, 0, 0)

        gl.bindBuffer(gl.ARRAY_BUFFER, this.meshTransAoBuffer)
        const meshTransTexAoLoc = gl.getAttribLocation(this.textureProgram, 'aAo')
        gl.enableVertexAttribArray(meshTransTexAoLoc)
        gl.vertexAttribPointer(meshTransTexAoLoc, 1, gl.FLOAT, false, 0, 0)

        gl.bindVertexArray(null)

        this.uniforms.uViewProj = gl.getUniformLocation(this.program, 'uViewProj')
        this.uniforms.uLightDir = gl.getUniformLocation(this.program, 'uLightDir')
        this.textureUniforms.uViewProj = gl.getUniformLocation(this.textureProgram, 'uViewProj')
        this.textureUniforms.uLightDir = gl.getUniformLocation(this.textureProgram, 'uLightDir')
        this.textureUniforms.uAtlas = gl.getUniformLocation(this.textureProgram, 'uAtlas')
        this.textureUniforms.uAlphaCutoff = gl.getUniformLocation(this.textureProgram, 'uAlphaCutoff')
        this.textureUniforms.uAmbient = gl.getUniformLocation(this.textureProgram, 'uAmbient')

        gl.enable(gl.DEPTH_TEST)
        gl.enable(gl.BLEND)
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    }

    requestRender(){
        this.needsRender = true
        if(!this.isWebGL || !this.isActive || this.frameRequested){
            return
        }
        this.frameRequested = true
        requestAnimationFrame(() => {
            this.frameRequested = false
            if(!this.isActive){
                return
            }
            if(!this.needsRender){
                return
            }
            this.render()
            this.needsRender = false
            if(this.needsRender){
                this.requestRender()
            }
        })
    }

    setActive(active){
        this.isActive = Boolean(active)
        if(this.isActive){
            this.requestRender()
        }
    }

    destroy(){
        this.setActive(false)
        this.meshTaskId += 1
        this.container?.removeEventListener('pointerdown', this._onPointerDown)
        window.removeEventListener('pointermove', this._onPointerMove)
        window.removeEventListener('pointerup', this._onPointerUp)
        this.container?.removeEventListener('wheel', this._onWheel)
        this.container?.removeEventListener('contextmenu', this._onContextMenu)
        window.removeEventListener('resize', this._onResize)
        this.gl?.getExtension('WEBGL_lose_context')?.loseContext()
        this.canvas = null
        this.container = null
    }

    clearMesh(){
        if(!this.isWebGL){
            return
        }
        this.blocksCount = 0
        this.meshVertexCount = 0
        this.meshCutoutVertexCount = 0
        this.meshTransVertexCount = 0
        this.meshHasUvs = false
        this.meshCutoutHasUvs = false
        this.meshTransHasUvs = false
        this.meshTransBase = null
        this.meshTransSorted = null
        this.meshTransSortDirty = true
        this.lastTransSortEye = null
        this.container?.removeAttribute('data-preview-vertices')
        this.requestRender()
    }

    setTextureAtlas(canvas){
        if(!this.gl || !this.textureProgram){
            return
        }
        if(!canvas){
            this.textureAtlas = null
            return
        }
        const gl = this.gl
        if(!this.textureAtlas){
            this.textureAtlas = gl.createTexture()
        }
        gl.bindTexture(gl.TEXTURE_2D, this.textureAtlas)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_NEAREST)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas)
        gl.generateMipmap(gl.TEXTURE_2D)
        gl.bindTexture(gl.TEXTURE_2D, null)
        this.requestRender()
    }

    onPointerDown(event){
        if(!this.isWebGL){
            return
        }
        if(event.button === 2){
            this.panning = true
        } else {
            this.dragging = true
        }
        this.lastX = event.clientX
        this.lastY = event.clientY
        this.container.setPointerCapture?.(event.pointerId)
    }

    onPointerMove(event){
        if((!this.dragging && !this.panning) || !this.isWebGL){
            return
        }
        const deltaX = event.clientX - this.lastX
        const deltaY = event.clientY - this.lastY
        this.lastX = event.clientX
        this.lastY = event.clientY
        if(this.dragging){
            const speed = 0.005
            this.yaw += deltaX * speed
            this.pitch += deltaY * speed
            this.pitch = Math.max(-1.35, Math.min(1.35, this.pitch))
            this.requestRender()
            return
        }
        if(this.panning){
            const cp = Math.cos(this.pitch)
            const sp = Math.sin(this.pitch)
            const cy = Math.cos(this.yaw)
            const sy = Math.sin(this.yaw)
            const forward = [-cp * cy, -sp, -cp * sy]
            const up = [0, 1, 0]
            let right = [
                forward[1] * up[2] - forward[2] * up[1],
                forward[2] * up[0] - forward[0] * up[2],
                forward[0] * up[1] - forward[1] * up[0]
            ]
            const rightLen = Math.hypot(right[0], right[1], right[2]) || 1
            right = [right[0] / rightLen, right[1] / rightLen, right[2] / rightLen]
            let camUp = [
                right[1] * forward[2] - right[2] * forward[1],
                right[2] * forward[0] - right[0] * forward[2],
                right[0] * forward[1] - right[1] * forward[0]
            ]
            const upLen = Math.hypot(camUp[0], camUp[1], camUp[2]) || 1
            camUp = [camUp[0] / upLen, camUp[1] / upLen, camUp[2] / upLen]

            const panScale = this.radius * 0.002
            const panX = -deltaX * panScale
            const panY = deltaY * panScale
            this.center = [
                this.center[0] + right[0] * panX + camUp[0] * panY,
                this.center[1] + right[1] * panX + camUp[1] * panY,
                this.center[2] + right[2] * panX + camUp[2] * panY
            ]
            this.requestRender()
        }
    }

    onPointerUp(event){
        if(!this.isWebGL){
            return
        }
        this.dragging = false
        this.panning = false
        this.container.releasePointerCapture?.(event.pointerId)
    }

    onWheel(event){
        if(!this.isWebGL){
            return
        }
        event.preventDefault()
        const delta = Math.sign(event.deltaY)
        this.radius = Math.max(2, this.radius + delta * 1.5)
        this.requestRender()
    }

    applyMeshResult(mesh, schematic, paletteColors, center){
        const gl = this.gl
        this.container?.removeAttribute('data-mesh')
        this.meshHasCoplanar = Boolean(mesh?.hasCoplanar)
        if(mesh && mesh.opaque?.positions?.length > 0){
            const opaque = mesh.opaque
            gl.bindBuffer(gl.ARRAY_BUFFER, this.meshPositionBuffer)
            gl.bufferData(gl.ARRAY_BUFFER, opaque.positions, gl.DYNAMIC_DRAW)
            gl.bindBuffer(gl.ARRAY_BUFFER, this.meshNormalBuffer)
            gl.bufferData(gl.ARRAY_BUFFER, opaque.normals, gl.DYNAMIC_DRAW)
            gl.bindBuffer(gl.ARRAY_BUFFER, this.meshColorBuffer)
            gl.bufferData(gl.ARRAY_BUFFER, opaque.colors, gl.DYNAMIC_DRAW)
            gl.bindBuffer(gl.ARRAY_BUFFER, this.meshUvBuffer)
            gl.bufferData(gl.ARRAY_BUFFER, opaque.uvs || new Float32Array(), gl.DYNAMIC_DRAW)
            gl.bindBuffer(gl.ARRAY_BUFFER, this.meshEmissiveBuffer)
            gl.bufferData(gl.ARRAY_BUFFER, opaque.emissive || new Float32Array(), gl.DYNAMIC_DRAW)
            gl.bindBuffer(gl.ARRAY_BUFFER, this.meshAoBuffer)
            gl.bufferData(gl.ARRAY_BUFFER, opaque.ao || new Float32Array(), gl.DYNAMIC_DRAW)
            gl.bindBuffer(gl.ARRAY_BUFFER, null)
            this.meshVertexCount = opaque.positions.length / 3
            this.blocksCount = 0
            this.meshHasUvs = Boolean(opaque.uvs && opaque.uvs.length > 0)
            const cutout = mesh.cutout
            if(cutout && cutout.positions.length > 0){
                gl.bindBuffer(gl.ARRAY_BUFFER, this.meshCutoutPositionBuffer)
                gl.bufferData(gl.ARRAY_BUFFER, cutout.positions, gl.DYNAMIC_DRAW)
                gl.bindBuffer(gl.ARRAY_BUFFER, this.meshCutoutNormalBuffer)
                gl.bufferData(gl.ARRAY_BUFFER, cutout.normals, gl.DYNAMIC_DRAW)
                gl.bindBuffer(gl.ARRAY_BUFFER, this.meshCutoutColorBuffer)
                gl.bufferData(gl.ARRAY_BUFFER, cutout.colors, gl.DYNAMIC_DRAW)
                gl.bindBuffer(gl.ARRAY_BUFFER, this.meshCutoutUvBuffer)
                gl.bufferData(gl.ARRAY_BUFFER, cutout.uvs || new Float32Array(), gl.DYNAMIC_DRAW)
                gl.bindBuffer(gl.ARRAY_BUFFER, this.meshCutoutEmissiveBuffer)
                gl.bufferData(gl.ARRAY_BUFFER, cutout.emissive || new Float32Array(), gl.DYNAMIC_DRAW)
                gl.bindBuffer(gl.ARRAY_BUFFER, this.meshCutoutAoBuffer)
                gl.bufferData(gl.ARRAY_BUFFER, cutout.ao || new Float32Array(), gl.DYNAMIC_DRAW)
                gl.bindBuffer(gl.ARRAY_BUFFER, null)
                this.meshCutoutVertexCount = cutout.positions.length / 3
                this.meshCutoutHasUvs = Boolean(cutout.uvs && cutout.uvs.length > 0)
            } else {
                this.meshCutoutVertexCount = 0
                this.meshCutoutHasUvs = false
            }
            const translucent = mesh.translucent
            if(translucent && translucent.positions.length > 0){
                gl.bindBuffer(gl.ARRAY_BUFFER, this.meshTransPositionBuffer)
                gl.bufferData(gl.ARRAY_BUFFER, translucent.positions, gl.DYNAMIC_DRAW)
                gl.bindBuffer(gl.ARRAY_BUFFER, this.meshTransNormalBuffer)
                gl.bufferData(gl.ARRAY_BUFFER, translucent.normals, gl.DYNAMIC_DRAW)
                gl.bindBuffer(gl.ARRAY_BUFFER, this.meshTransColorBuffer)
                gl.bufferData(gl.ARRAY_BUFFER, translucent.colors, gl.DYNAMIC_DRAW)
                gl.bindBuffer(gl.ARRAY_BUFFER, this.meshTransUvBuffer)
                gl.bufferData(gl.ARRAY_BUFFER, translucent.uvs || new Float32Array(), gl.DYNAMIC_DRAW)
                gl.bindBuffer(gl.ARRAY_BUFFER, this.meshTransEmissiveBuffer)
                gl.bufferData(gl.ARRAY_BUFFER, translucent.emissive || new Float32Array(), gl.DYNAMIC_DRAW)
                gl.bindBuffer(gl.ARRAY_BUFFER, this.meshTransAoBuffer)
                gl.bufferData(gl.ARRAY_BUFFER, translucent.ao || new Float32Array(), gl.DYNAMIC_DRAW)
                gl.bindBuffer(gl.ARRAY_BUFFER, null)
                this.meshTransVertexCount = translucent.positions.length / 3
                this.meshTransHasUvs = Boolean(translucent.uvs && translucent.uvs.length > 0)
                this.meshTransBase = {
                    positions: translucent.positions,
                    normals: translucent.normals,
                    colors: translucent.colors,
                    uvs: translucent.uvs || new Float32Array(),
                    emissive: translucent.emissive || new Float32Array(),
                    ao: translucent.ao || new Float32Array()
                }
                this.meshTransSortDirty = true
                this.lastTransSortEye = null
            } else {
                this.meshTransVertexCount = 0
                this.meshTransHasUvs = false
                this.meshTransBase = null
                this.meshTransSortDirty = true
                this.lastTransSortEye = null
            }
        } else {
            const positions = new Float32Array(schematic.blocks.length * 3)
            const colors = new Float32Array(schematic.blocks.length * 3)
            let idx = 0
            for(const block of schematic.blocks){
                const x = block.x - center[0]
                const y = block.y - center[1]
                const z = block.z - center[2]
                positions[idx * 3] = x
                positions[idx * 3 + 1] = y
                positions[idx * 3 + 2] = z
                const color = paletteColors[block.p] || [0.7, 0.7, 0.7]
                colors[idx * 3] = color[0]
                colors[idx * 3 + 1] = color[1]
                colors[idx * 3 + 2] = color[2]
                idx++
            }
            gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceOffsetBuffer)
            gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW)
            gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceColorBuffer)
            gl.bufferData(gl.ARRAY_BUFFER, colors, gl.DYNAMIC_DRAW)
            gl.bindBuffer(gl.ARRAY_BUFFER, null)
            this.blocksCount = schematic.blocks.length
            this.meshVertexCount = 0
            this.meshHasUvs = false
            this.meshCutoutVertexCount = 0
            this.meshCutoutHasUvs = false
            this.meshTransVertexCount = 0
            this.meshTransHasUvs = false
            this.meshTransBase = null
            this.meshTransSortDirty = true
            this.lastTransSortEye = null
        }
        this.requestRender()
    }

    setSchematic(schematic){
        if(!this.isWebGL || !schematic || !Array.isArray(schematic.blocks)){
            return
        }
        if(SCHEMATICS_DEBUG_MODELS && !schematicsDebugLogged){
            console.log('[schematics-debug] enabled', { blocks: SCHEMATICS_DEBUG_BLOCKS })
            schematicsDebugLogged = true
        }
        if(SCHEMATICS_DEBUG_MODELS){
            const paletteBlocks = Array.isArray(schematic.palette)
                ? schematic.palette.map(entry => entry?.block).filter(Boolean)
                : []
            const paletteSet = new Set(paletteBlocks)
            const matches = SCHEMATICS_DEBUG_BLOCKS.filter(id => paletteSet.has(id))
            console.log('[schematics-debug] palette blocks', {
                paletteCount: paletteSet.size,
                matches,
                missing: SCHEMATICS_DEBUG_BLOCKS.filter(id => !paletteSet.has(id))
            })
        }
        const bounds = schematic.bounds || { min: [0, 0, 0], max: [0, 0, 0], size: [1, 1, 1] }
        const meshCenter = [
            (bounds.min[0] + bounds.max[0]) / 2,
            (bounds.min[1] + bounds.max[1]) / 2,
            (bounds.min[2] + bounds.max[2]) / 2
        ]
        // Mesh vertices are normalized around the schematic bounds before upload.
        // Keep the camera target in that same local coordinate system.
        this.center = [0, 0, 0]
        this.boundsSize = bounds.size || [1, 1, 1]
        const previewRect = this.container?.getBoundingClientRect()
        const aspect = previewRect?.height > 0 ? previewRect.width / previewRect.height : 1
        this.radius = computePreviewCameraRadius(this.boundsSize, aspect)

        const paletteColors = buildPaletteColors(schematic)
        this.container?.setAttribute('data-mesh', 'building')
        this.container?.setAttribute('data-preview-state', 'building')
        this.container?.setAttribute('data-rendered', 'false')
        const taskId = ++this.meshTaskId
        const atlasMapping = schematicsTextureAtlas?.mapping || null
        const registrySubset = collectRegistrySubset(schematic)
        const workerPayload = {
            schematic,
            registry: registrySubset,
            atlasMapping,
            options: {
                center: meshCenter,
                paletteColors,
                cullFaces: true,
                coplanarBias: true
            }
        }

        const worker = ensureSchematicsMeshWorker()
        if(worker){
            requestSchematicMeshBuild(workerPayload)
                .then((mesh) => {
                    if(taskId !== this.meshTaskId){
                        return
                    }
                    this.applyMeshResult(mesh, schematic, paletteColors, meshCenter)
                })
                .catch((err) => {
                    loggerLanding.warn('Mesh worker build failed, falling back to main thread.', err)
                    if(taskId !== this.meshTaskId){
                        return
                    }
                    const mesh = buildSchematicMesh(schematic, schematicsRuntimeRegistry, {
                        center: meshCenter,
                        paletteColors,
                        usePaletteColors: !schematicsTextureAtlas?.mapping,
                        cullFaces: true,
                        tintProvider: getTintColor,
                        variantSeedFn: (block, paletteEntry) => computeVariantSeed(paletteEntry?.block || 'minecraft:stone', block),
                        coplanarBias: true,
                        debug: SCHEMATICS_DEBUG_MODELS ? {
                            enabled: true,
                            blocks: SCHEMATICS_DEBUG_BLOCKS,
                            log: (label, payload) => console.log(label, JSON.stringify(payload))
                        } : null,
                        alphaResolver: (textureId) => {
                            return schematicsTextureAtlas?.mapping?.[textureId]?.alphaMode || 'opaque'
                        },
                        textureResolver: (textureId) => {
                            if(!schematicsTextureAtlas?.mapping){
                                return null
                            }
                            const entry = schematicsTextureAtlas.mapping[textureId]
                            if(!entry){
                                if(SCHEMATICS_DEBUG_MODELS && String(textureId).includes('torch')){
                                    console.log('[schematics-debug] missing atlas entry', textureId)
                                }
                                return null
                            }
                            return {
                                uv: [entry.u0, entry.v0, entry.u1, entry.v1],
                                alphaMode: entry.alphaMode || 'opaque'
                            }
                        }
                    })
                    this.applyMeshResult(mesh, schematic, paletteColors, meshCenter)
                })
            return
        }

        const mesh = buildSchematicMesh(schematic, schematicsRuntimeRegistry, {
            center: meshCenter,
            paletteColors,
            usePaletteColors: !schematicsTextureAtlas?.mapping,
            cullFaces: true,
            tintProvider: getTintColor,
            variantSeedFn: (block, paletteEntry) => computeVariantSeed(paletteEntry?.block || 'minecraft:stone', block),
            coplanarBias: true,
            debug: SCHEMATICS_DEBUG_MODELS ? {
                enabled: true,
                blocks: SCHEMATICS_DEBUG_BLOCKS,
                log: (label, payload) => console.log(label, JSON.stringify(payload))
            } : null,
            alphaResolver: (textureId) => {
                return schematicsTextureAtlas?.mapping?.[textureId]?.alphaMode || 'opaque'
            },
            textureResolver: (textureId) => {
                if(!schematicsTextureAtlas?.mapping){
                    return null
                }
                const entry = schematicsTextureAtlas.mapping[textureId]
                if(!entry){
                    if(SCHEMATICS_DEBUG_MODELS && String(textureId).includes('torch')){
                        console.log('[schematics-debug] missing atlas entry', textureId)
                    }
                    return null
                }
                return {
                    uv: [entry.u0, entry.v0, entry.u1, entry.v1],
                    alphaMode: entry.alphaMode || 'opaque'
                }
            }
        })
        this.applyMeshResult(mesh, schematic, paletteColors, meshCenter)
    }

    render(){
        const gl = this.gl
        if(!gl || !this.program){
            return
        }
        const { width, height } = this.resizeCanvas()
        gl.viewport(0, 0, width, height)
        gl.clearColor(0.05, 0.06, 0.07, 0.9)
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)

        if(this.blocksCount === 0 && this.meshVertexCount === 0){
            return
        }
        const aspect = width / height
        const fov = Math.PI / 4
        mat4Perspective(this.proj, fov, aspect, 0.1, 2000)
        const cp = Math.cos(this.pitch)
        const sp = Math.sin(this.pitch)
        const cy = Math.cos(this.yaw)
        const sy = Math.sin(this.yaw)
        const eye = [
            this.center[0] + this.radius * cp * cy,
            this.center[1] + this.radius * sp,
            this.center[2] + this.radius * cp * sy
        ]
        mat4LookAt(this.view, eye, this.center, [0, 1, 0])
        mat4Multiply(this.viewProj, this.proj, this.view)

        if(this.meshVertexCount > 0){
            if(this.textureAtlas && this.meshHasUvs){
                if(this.meshHasCoplanar){
                    gl.enable(gl.POLYGON_OFFSET_FILL)
                    gl.polygonOffset(-0.35, -0.35)
                }
                gl.useProgram(this.textureProgram)
                gl.uniformMatrix4fv(this.textureUniforms.uViewProj, false, this.viewProj)
                gl.uniform3f(this.textureUniforms.uLightDir, -0.6, 0.9, 0.45)
                gl.uniform1f(this.textureUniforms.uAlphaCutoff, 0.0)
                gl.uniform1f(this.textureUniforms.uAmbient, 0.8)
                gl.activeTexture(gl.TEXTURE0)
                gl.bindTexture(gl.TEXTURE_2D, this.textureAtlas)
                gl.uniform1i(this.textureUniforms.uAtlas, 0)
                gl.bindVertexArray(this.meshTexturedVao)
                gl.drawArrays(gl.TRIANGLES, 0, this.meshVertexCount)
                gl.bindTexture(gl.TEXTURE_2D, null)
                if(this.meshHasCoplanar){
                    gl.disable(gl.POLYGON_OFFSET_FILL)
                }
            } else {
                if(this.meshHasCoplanar){
                    gl.enable(gl.POLYGON_OFFSET_FILL)
                    gl.polygonOffset(-0.35, -0.35)
                }
                gl.useProgram(this.program)
                gl.uniformMatrix4fv(this.uniforms.uViewProj, false, this.viewProj)
                gl.uniform3f(this.uniforms.uLightDir, -0.6, 0.9, 0.45)
                gl.bindVertexArray(this.meshVao)
                gl.drawArrays(gl.TRIANGLES, 0, this.meshVertexCount)
                if(this.meshHasCoplanar){
                    gl.disable(gl.POLYGON_OFFSET_FILL)
                }
            }
        } else {
            gl.useProgram(this.program)
            gl.uniformMatrix4fv(this.uniforms.uViewProj, false, this.viewProj)
            gl.uniform3f(this.uniforms.uLightDir, -0.6, 0.9, 0.45)
            gl.bindVertexArray(this.vao)
            gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, this.blocksCount)
        }
        if(this.meshCutoutVertexCount > 0){
            gl.enable(gl.POLYGON_OFFSET_FILL)
            gl.polygonOffset(-0.6, -0.6)
            if(this.textureAtlas && this.meshCutoutHasUvs){
                gl.useProgram(this.textureProgram)
                gl.uniformMatrix4fv(this.textureUniforms.uViewProj, false, this.viewProj)
                gl.uniform3f(this.textureUniforms.uLightDir, -0.6, 0.9, 0.45)
                gl.uniform1f(this.textureUniforms.uAlphaCutoff, 0.5)
                gl.uniform1f(this.textureUniforms.uAmbient, 0.55)
                gl.activeTexture(gl.TEXTURE0)
                gl.bindTexture(gl.TEXTURE_2D, this.textureAtlas)
                gl.uniform1i(this.textureUniforms.uAtlas, 0)
                gl.bindVertexArray(this.meshCutoutTexturedVao)
                gl.drawArrays(gl.TRIANGLES, 0, this.meshCutoutVertexCount)
                gl.bindTexture(gl.TEXTURE_2D, null)
            } else {
                gl.useProgram(this.program)
                gl.uniformMatrix4fv(this.uniforms.uViewProj, false, this.viewProj)
                gl.uniform3f(this.uniforms.uLightDir, -0.6, 0.9, 0.45)
                gl.bindVertexArray(this.meshCutoutVao)
                gl.drawArrays(gl.TRIANGLES, 0, this.meshCutoutVertexCount)
            }
            gl.disable(gl.POLYGON_OFFSET_FILL)
        }
        if(this.meshTransVertexCount > 0){
            gl.enable(gl.POLYGON_OFFSET_FILL)
            gl.polygonOffset(-1, -1)
            this.sortTranslucent(eye)
            gl.depthMask(false)
            if(this.textureAtlas && this.meshTransHasUvs){
                gl.useProgram(this.textureProgram)
                gl.uniformMatrix4fv(this.textureUniforms.uViewProj, false, this.viewProj)
                gl.uniform3f(this.textureUniforms.uLightDir, -0.6, 0.9, 0.45)
                gl.uniform1f(this.textureUniforms.uAlphaCutoff, 0.0)
                gl.uniform1f(this.textureUniforms.uAmbient, 0.55)
                gl.activeTexture(gl.TEXTURE0)
                gl.bindTexture(gl.TEXTURE_2D, this.textureAtlas)
                gl.uniform1i(this.textureUniforms.uAtlas, 0)
                gl.bindVertexArray(this.meshTransTexturedVao)
                gl.drawArrays(gl.TRIANGLES, 0, this.meshTransVertexCount)
                gl.bindTexture(gl.TEXTURE_2D, null)
            } else {
                gl.useProgram(this.program)
                gl.uniformMatrix4fv(this.uniforms.uViewProj, false, this.viewProj)
                gl.uniform3f(this.uniforms.uLightDir, -0.6, 0.9, 0.45)
                gl.bindVertexArray(this.meshTransVao)
                gl.drawArrays(gl.TRIANGLES, 0, this.meshTransVertexCount)
            }
            gl.depthMask(true)
            gl.disable(gl.POLYGON_OFFSET_FILL)
        }
        gl.bindVertexArray(null)
        const renderedVertices = this.meshVertexCount + this.meshCutoutVertexCount + this.meshTransVertexCount
            + (this.blocksCount * 36)
        if(renderedVertices > 0){
            this.container?.setAttribute('data-preview-vertices', String(renderedVertices))
            this.container?.setAttribute('data-rendered', 'true')
            this.container?.setAttribute('data-preview-state', 'ready')
        }
    }

    sortTranslucent(eye){
        if(!this.meshTransBase || this.meshTransVertexCount === 0){
            return
        }
        if(this.lastTransSortEye && !this.meshTransSortDirty){
            const dx = eye[0] - this.lastTransSortEye[0]
            const dy = eye[1] - this.lastTransSortEye[1]
            const dz = eye[2] - this.lastTransSortEye[2]
            const movementSq = dx * dx + dy * dy + dz * dz
            const threshold = Math.max(0.45, this.radius * 0.02)
            if(movementSq < (threshold * threshold)){
                return
            }
        }
        const positions = this.meshTransBase.positions
        const normals = this.meshTransBase.normals
        const colors = this.meshTransBase.colors
        const uvs = this.meshTransBase.uvs
        const emissive = this.meshTransBase.emissive || new Float32Array()
        const ao = this.meshTransBase.ao || new Float32Array()
        const triCount = positions.length / 9
        if(triCount === 0){
            return
        }

        const distances = new Float32Array(triCount)
        const indices = new Array(triCount)
        for(let i=0; i<triCount; i++){
            const base = i * 9
            const cx = (positions[base] + positions[base + 3] + positions[base + 6]) / 3
            const cy = (positions[base + 1] + positions[base + 4] + positions[base + 7]) / 3
            const cz = (positions[base + 2] + positions[base + 5] + positions[base + 8]) / 3
            const dx = cx - eye[0]
            const dy = cy - eye[1]
            const dz = cz - eye[2]
            distances[i] = dx * dx + dy * dy + dz * dz
            indices[i] = i
        }
        indices.sort((a, b) => distances[b] - distances[a])

        if(!this.meshTransSorted || this.meshTransSorted.triCount !== triCount){
            this.meshTransSorted = {
                triCount,
                positions: new Float32Array(positions.length),
                normals: new Float32Array(normals.length),
                colors: new Float32Array(colors.length),
                uvs: new Float32Array(uvs.length),
                emissive: new Float32Array(emissive.length),
                ao: new Float32Array(ao.length)
            }
        }
        const target = this.meshTransSorted
        for(let i=0; i<indices.length; i++){
            const tri = indices[i]
            const srcPos = tri * 9
            const dstPos = i * 9
            target.positions.set(positions.subarray(srcPos, srcPos + 9), dstPos)
            target.normals.set(normals.subarray(srcPos, srcPos + 9), dstPos)
            target.colors.set(colors.subarray(srcPos, srcPos + 9), dstPos)
            const srcUv = tri * 6
            const dstUv = i * 6
            target.uvs.set(uvs.subarray(srcUv, srcUv + 6), dstUv)
            if(emissive.length){
                const srcEm = tri * 3
                const dstEm = i * 3
                target.emissive.set(emissive.subarray(srcEm, srcEm + 3), dstEm)
            }
            if(ao.length){
                const srcAo = tri * 3
                const dstAo = i * 3
                target.ao.set(ao.subarray(srcAo, srcAo + 3), dstAo)
            }
        }

        const gl = this.gl
        gl.bindBuffer(gl.ARRAY_BUFFER, this.meshTransPositionBuffer)
        gl.bufferData(gl.ARRAY_BUFFER, target.positions, gl.DYNAMIC_DRAW)
        gl.bindBuffer(gl.ARRAY_BUFFER, this.meshTransNormalBuffer)
        gl.bufferData(gl.ARRAY_BUFFER, target.normals, gl.DYNAMIC_DRAW)
        gl.bindBuffer(gl.ARRAY_BUFFER, this.meshTransColorBuffer)
        gl.bufferData(gl.ARRAY_BUFFER, target.colors, gl.DYNAMIC_DRAW)
        gl.bindBuffer(gl.ARRAY_BUFFER, this.meshTransUvBuffer)
        gl.bufferData(gl.ARRAY_BUFFER, target.uvs, gl.DYNAMIC_DRAW)
        gl.bindBuffer(gl.ARRAY_BUFFER, this.meshTransEmissiveBuffer)
        gl.bufferData(gl.ARRAY_BUFFER, target.emissive, gl.DYNAMIC_DRAW)
        gl.bindBuffer(gl.ARRAY_BUFFER, this.meshTransAoBuffer)
        gl.bufferData(gl.ARRAY_BUFFER, target.ao, gl.DYNAMIC_DRAW)
        gl.bindBuffer(gl.ARRAY_BUFFER, null)
        this.meshTransSortDirty = false
        this.lastTransSortEye = [eye[0], eye[1], eye[2]]
    }
}

function buildPaletteColors(schematic){
    const palette = schematic?.palette || []
    return palette.map((item, index) => {
        const hex = schematicPreviewColorForState(item?.block || `block-${index}`)
        const value = Number.parseInt(hex.slice(1), 16)
        return [(value >> 16) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255]
    })
}

function buildUnitCube(){
    const positions = new Float32Array([
        // Front
        -0.5, -0.5,  0.5,  0.5, -0.5,  0.5,  0.5,  0.5,  0.5,
        -0.5, -0.5,  0.5,  0.5,  0.5,  0.5, -0.5,  0.5,  0.5,
        // Back
        0.5, -0.5, -0.5, -0.5, -0.5, -0.5, -0.5,  0.5, -0.5,
        0.5, -0.5, -0.5, -0.5,  0.5, -0.5,  0.5,  0.5, -0.5,
        // Left
        -0.5, -0.5, -0.5, -0.5, -0.5,  0.5, -0.5,  0.5,  0.5,
        -0.5, -0.5, -0.5, -0.5,  0.5,  0.5, -0.5,  0.5, -0.5,
        // Right
        0.5, -0.5,  0.5,  0.5, -0.5, -0.5,  0.5,  0.5, -0.5,
        0.5, -0.5,  0.5,  0.5,  0.5, -0.5,  0.5,  0.5,  0.5,
        // Top
        -0.5,  0.5,  0.5,  0.5,  0.5,  0.5,  0.5,  0.5, -0.5,
        -0.5,  0.5,  0.5,  0.5,  0.5, -0.5, -0.5,  0.5, -0.5,
        // Bottom
        -0.5, -0.5, -0.5,  0.5, -0.5, -0.5,  0.5, -0.5,  0.5,
        -0.5, -0.5, -0.5,  0.5, -0.5,  0.5, -0.5, -0.5,  0.5
    ])
    const normals = new Float32Array([
        // Front
        0, 0, 1,  0, 0, 1,  0, 0, 1,
        0, 0, 1,  0, 0, 1,  0, 0, 1,
        // Back
        0, 0, -1,  0, 0, -1,  0, 0, -1,
        0, 0, -1,  0, 0, -1,  0, 0, -1,
        // Left
        -1, 0, 0, -1, 0, 0, -1, 0, 0,
        -1, 0, 0, -1, 0, 0, -1, 0, 0,
        // Right
        1, 0, 0, 1, 0, 0, 1, 0, 0,
        1, 0, 0, 1, 0, 0, 1, 0, 0,
        // Top
        0, 1, 0, 0, 1, 0, 0, 1, 0,
        0, 1, 0, 0, 1, 0, 0, 1, 0,
        // Bottom
        0, -1, 0, 0, -1, 0, 0, -1, 0,
        0, -1, 0, 0, -1, 0, 0, -1, 0
    ])
    return { positions, normals }
}

let schematicsPreviewRenderer = null
let schematicsUploadPreviewRenderer = null
let schematicsUploadPreviewTimer = null
let schematicsUploadPreviewTask = 0
let schematicsMeshWorker = null
let schematicsMeshWorkerReady = false
let schematicsMeshWorkerTaskId = 0
const schematicsMeshWorkerTasks = new Map()

function ensureSchematicPreviewRenderer(){
    if(!schematicsDetailCanvas || !schematicsDetailPreview){
        return null
    }
    if(!schematicsPreviewRenderer){
        schematicsPreviewRenderer = new SchematicPreviewRenderer(schematicsDetailCanvas, schematicsDetailPreview)
    }
    return schematicsPreviewRenderer
}

function ensureUploadPreviewRenderer(){
    if(!schematicsUploadCanvas || !schematicsUploadPreview){
        return null
    }
    if(!schematicsUploadPreviewRenderer){
        schematicsUploadPreviewRenderer = new SchematicPreviewRenderer(schematicsUploadCanvas, schematicsUploadPreview)
    }
    return schematicsUploadPreviewRenderer
}

function setSchematicPreviewRendererActive(active){
    if(schematicsPreviewRenderer && schematicsPreviewRenderer.isWebGL){
        schematicsPreviewRenderer.setActive(active)
    }
}

function setUploadPreviewRendererActive(active){
    if(schematicsUploadPreviewRenderer && schematicsUploadPreviewRenderer.isWebGL){
        schematicsUploadPreviewRenderer.setActive(active)
    }
}

function renderSchematicPreview(schematic){
    const renderer = ensureSchematicPreviewRenderer()
    if(renderer && renderer.isWebGL){
        renderer.setSchematic(schematic)
        return
    }
    renderSchematicPreviewFallback(schematic)
}

function renderUploadSchematicPreview(schematic){
    const renderer = ensureUploadPreviewRenderer()
    if(renderer && renderer.isWebGL){
        renderer.setSchematic(schematic)
        return
    }
    renderUploadSchematicPreviewFallback(schematic)
}

function computeVariantSeed(blockId, block){
    let hash = 2166136261
    const str = `${blockId}:${block.x},${block.y},${block.z}`
    for(let i=0; i<str.length; i++){
        hash ^= str.charCodeAt(i)
        hash = Math.imul(hash, 16777619)
    }
    return hash >>> 0
}

function getTintColor(blockId, _state, tintIndex){
    if(tintIndex == null){
        return null
    }
    const id = String(blockId || '').toLowerCase()
    if(id.includes('water')){
        return [0.25, 0.46, 0.89]
    }
    if(id.includes('grass')){
        return tintIndex === 1 ? [0.4, 0.65, 0.3] : [0.56, 0.74, 0.35]
    }
    if(id.includes('leaves') || id.includes('vine')){
        return [0.47, 0.72, 0.32]
    }
    if(id.includes('fern') || id.includes('tall_grass') || id.includes('seagrass')){
        return [0.48, 0.74, 0.34]
    }
    return null
}
