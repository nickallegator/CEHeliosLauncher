'use strict'

/* global Image, window */

const activeViewers = new Set()

function perspective(fov, aspect, near, far) {
    const f = 1 / Math.tan(fov / 2); const nf = 1 / (near - far)
    return new Float32Array([f / aspect,0,0,0, 0,f,0,0, 0,0,(far + near) * nf,-1, 0,0,2 * far * near * nf,0])
}

function multiply(a, b) {
    const out = new Float32Array(16)
    for(let column = 0; column < 4; column += 1) for(let row = 0; row < 4; row += 1) {
        out[column * 4 + row] = a[row] * b[column * 4] + a[4 + row] * b[column * 4 + 1] + a[8 + row] * b[column * 4 + 2] + a[12 + row] * b[column * 4 + 3]
    }
    return out
}

function normalize(value) {
    const length = Math.hypot(...value) || 1
    return value.map(component => component / length)
}

function cross(left, right) {
    return [
        left[1] * right[2] - left[2] * right[1],
        left[2] * right[0] - left[0] * right[2],
        left[0] * right[1] - left[1] * right[0]
    ]
}

function dot(left, right) { return left[0] * right[0] + left[1] * right[1] + left[2] * right[2] }

function orbitEye(yaw, pitch, distance) {
    const cp = Math.cos(pitch)
    return [distance * cp * Math.cos(yaw), distance * Math.sin(pitch), distance * cp * Math.sin(yaw)]
}

function lookAt(eye, center = [0, 0, 0], up = [0, 1, 0]) {
    const forward = normalize(center.map((value, axis) => value - eye[axis]))
    const right = normalize(cross(forward, up))
    const cameraUp = cross(right, forward)
    return new Float32Array([
        right[0], cameraUp[0], -forward[0], 0,
        right[1], cameraUp[1], -forward[1], 0,
        right[2], cameraUp[2], -forward[2], 0,
        -dot(right, eye), -dot(cameraUp, eye), dot(forward, eye), 1
    ])
}

function orbitFromDrag(startYaw, startPitch, deltaX, deltaY, sensitivity = 0.005) {
    return {
        yaw: startYaw + deltaX * sensitivity,
        pitch: Math.max(-1.35, Math.min(1.35, startPitch + deltaY * sensitivity))
    }
}

function compile(gl, type, source) {
    const shader = gl.createShader(type); gl.shaderSource(shader, source); gl.compileShader(shader)
    if(!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || 'WebGL shader compilation failed.')
    return shader
}

function createProgram(gl) {
    const program = gl.createProgram()
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, `#version 300 es
        in vec3 aPosition; in vec3 aNormal; in vec2 aUv; uniform mat4 uMatrix;
        out vec3 vNormal; out vec2 vUv; void main(){ gl_Position=uMatrix*vec4(aPosition,1.0); vNormal=aNormal; vUv=aUv; }`))
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, `#version 300 es
        precision mediump float; in vec3 vNormal; in vec2 vUv; uniform sampler2D uTexture; out vec4 outColor;
        void main(){ vec4 tex=texture(uTexture,vUv); if(tex.a<0.05) discard; float light=.48+.52*max(dot(normalize(vNormal),normalize(vec3(.35,.8,.55))),0.0); outColor=vec4(tex.rgb*light,tex.a); }`))
    gl.linkProgram(program)
    if(!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'WebGL program linking failed.')
    return program
}

function loadTextureImage(bytes) {
    return new Promise((resolve, reject) => {
        const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error('Unable to decode model texture.'))
        image.src = `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`
    })
}

function configureTextureUpload(gl) {
    // Bedrock UVs use the image's upper-left as their origin. HTML image
    // uploads already map their first row to v=0, so flipping here would
    // make models sample unrelated (often transparent) atlas regions.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
}

class CommunityModelViewer {
    constructor(canvas, options = {}) {
        this.allowConcurrent = options.allowConcurrent === true
        this.maxConcurrent = Math.max(1, Number(options.maxConcurrent) || 2)
        if(!this.allowConcurrent) {
            for(const viewer of [...activeViewers]) viewer.destroy()
        } else {
            while(activeViewers.size >= this.maxConcurrent) activeViewers.values().next().value?.destroy()
        }
        this.canvas = canvas
        this.gl = canvas.getContext('webgl2', { alpha: true, antialias: true, preserveDrawingBuffer: false })
        if(!this.gl) throw new Error('WebGL2 is not available.')
        try {
            this.program = createProgram(this.gl)
        } catch(error) {
            this.gl.getExtension('WEBGL_lose_context')?.loseContext()
            throw error
        }
        activeViewers.add(this)
        this.defaultYaw = Number.isFinite(options.defaultYaw) ? options.defaultYaw : -1.15
        this.defaultPitch = Number.isFinite(options.defaultPitch) ? options.defaultPitch : 0.12
        this.fitPadding = Number.isFinite(options.fitPadding) ? Math.max(1.25, options.fitPadding) : 2.5
        this.yaw = this.defaultYaw; this.pitch = this.defaultPitch; this.distance = 4.5; this.drag = null; this.destroyed = false
        this.buffers = []
        this.meshBuffers = []
        this.listeners = []
        this.bind()
    }

    listen(target, event, fn, options) { target.addEventListener(event, fn, options); this.listeners.push(() => target.removeEventListener(event, fn, options)) }
    bind() {
        this.listen(this.canvas, 'pointerdown', event => { this.drag = { x: event.clientX, y: event.clientY, yaw: this.yaw, pitch: this.pitch }; this.canvas.setPointerCapture?.(event.pointerId) })
        this.listen(this.canvas, 'pointermove', event => {
            if(!this.drag) return
            const rotation = orbitFromDrag(this.drag.yaw, this.drag.pitch, event.clientX - this.drag.x, event.clientY - this.drag.y)
            this.yaw = rotation.yaw; this.pitch = rotation.pitch; this.render()
        })
        this.listen(this.canvas, 'pointerup', () => { this.drag = null })
        this.listen(this.canvas, 'pointercancel', () => { this.drag = null })
        this.listen(this.canvas, 'wheel', event => { event.preventDefault(); this.distance = Math.max(1.5, Math.min(12, this.distance * (event.deltaY < 0 ? .9 : 1.1))); this.render() }, { passive: false })
        this.listen(this.canvas, 'keydown', event => { if(event.key === 'ArrowLeft') this.yaw -= .12; else if(event.key === 'ArrowRight') this.yaw += .12; else if(event.key === '+' || event.key === '=') this.distance *= .9; else if(event.key === '-') this.distance *= 1.1; else if(event.key.toLowerCase() === 'f') this.fit(); else return; event.preventDefault(); this.render() })
    }

    async setModel(mesh, textureBytes) {
        const gl = this.gl
        for(const buffer of this.buffers) gl.deleteBuffer(buffer)
        this.buffers = []
        this.meshBuffers = []
        const bind = (name, data, size) => {
            const buffer = gl.createBuffer(); this.buffers.push(buffer); this.meshBuffers.push({ buffer, name, size })
            gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW)
            const location = gl.getAttribLocation(this.program, name); gl.enableVertexAttribArray(location); gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0)
        }
        gl.useProgram(this.program); bind('aPosition', mesh.positions, 3); bind('aNormal', mesh.normals, 3); bind('aUv', mesh.uvs, 2)
        if(this.texture) gl.deleteTexture(this.texture)
        this.texture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.texture)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
        configureTextureUpload(gl)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, await loadTextureImage(textureBytes))
        this.vertexCount = mesh.positions.length / 3
        this.bounds = mesh.bounds
        this.fit(); this.render()
    }

    updateMesh(mesh) {
        if(this.destroyed || this.meshBuffers.length !== 3) return
        const gl = this.gl
        const values = [mesh.positions, mesh.normals, mesh.uvs]
        for(let index = 0; index < this.meshBuffers.length; index += 1) {
            gl.bindBuffer(gl.ARRAY_BUFFER, this.meshBuffers[index].buffer)
            gl.bufferData(gl.ARRAY_BUFFER, values[index], gl.DYNAMIC_DRAW)
        }
        this.vertexCount = mesh.positions.length / 3
        this.bounds = mesh.bounds
        this.render()
    }

    fit() {
        const size = Math.max(...(this.bounds?.size || [2, 2, 2]))
        this.distance = Math.max(2.5, size * this.fitPadding)
        this.yaw = this.defaultYaw; this.pitch = this.defaultPitch
    }

    render() {
        if(this.destroyed || !this.vertexCount) return
        const gl = this.gl; const scale = Math.min(2, window.devicePixelRatio || 1)
        const width = Math.max(1, Math.round(this.canvas.clientWidth * scale)); const height = Math.max(1, Math.round(this.canvas.clientHeight * scale))
        if(this.canvas.width !== width || this.canvas.height !== height) { this.canvas.width = width; this.canvas.height = height }
        gl.viewport(0, 0, width, height); gl.clearColor(.035, .06, .055, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
        gl.enable(gl.DEPTH_TEST); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.useProgram(this.program)
        const view = lookAt(orbitEye(this.yaw, this.pitch, this.distance))
        this.canvas.dataset.cameraYaw = this.yaw.toFixed(6)
        this.canvas.dataset.cameraPitch = this.pitch.toFixed(6)
        this.canvas.dataset.cameraDistance = this.distance.toFixed(6)
        gl.uniformMatrix4fv(gl.getUniformLocation(this.program, 'uMatrix'), false, multiply(perspective(Math.PI / 4, width / height, .05, 100), view))
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.texture); gl.uniform1i(gl.getUniformLocation(this.program, 'uTexture'), 0)
        gl.drawArrays(gl.TRIANGLES, 0, this.vertexCount)
    }

    resize() { this.render() }

    destroy() {
        if(this.destroyed) return
        this.destroyed = true; this.listeners.splice(0).forEach(remove => remove())
        for(const buffer of this.buffers) this.gl.deleteBuffer(buffer)
        if(this.texture) this.gl.deleteTexture(this.texture)
        if(this.program) this.gl.deleteProgram(this.program)
        this.gl.getExtension('WEBGL_lose_context')?.loseContext()
        activeViewers.delete(this)
    }
}

module.exports = { CommunityModelViewer, configureTextureUpload, lookAt, orbitEye, orbitFromDrag }
