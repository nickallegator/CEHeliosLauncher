'use strict'

const crypto = require('crypto')

function decodeKey(value) {
    const text = String(value || '').trim()
    if(/^[a-f0-9]{64}$/i.test(text)) return Buffer.from(text, 'hex')
    const key = Buffer.from(text, 'base64')
    if(key.length !== 32) throw new Error('EXTERNAL_TOKEN_ENCRYPTION_KEY must be 32 bytes encoded as base64 or 64 hexadecimal characters')
    return key
}

function createExternalTokenEncryption(value, keyId = 'v1') {
    const key = decodeKey(value)
    return {
        encrypt(plaintext) {
            const iv = crypto.randomBytes(12)
            const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
            const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()])
            return {
                ciphertext: ciphertext.toString('base64'),
                iv: iv.toString('base64'),
                tag: cipher.getAuthTag().toString('base64'),
                keyId
            }
        },
        decrypt(record) {
            if(record.token_key_id !== keyId && record.keyId !== keyId) throw new Error('External token encryption key is unavailable')
            const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(record.token_iv || record.iv, 'base64'))
            decipher.setAuthTag(Buffer.from(record.token_tag || record.tag, 'base64'))
            return Buffer.concat([
                decipher.update(Buffer.from(record.token_ciphertext || record.ciphertext, 'base64')),
                decipher.final()
            ]).toString('utf8')
        }
    }
}

module.exports = { createExternalTokenEncryption, decodeKey }
