import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { APP_VERSION, PROTOCOL_VERSION } from './version.js'

describe('version constants', () => {
  it('APP_VERSION matches package.json and PROTOCOL_VERSION is a positive integer', () => {
    const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
    assert.equal(APP_VERSION, pkg.version)
    assert.ok(Number.isInteger(PROTOCOL_VERSION) && PROTOCOL_VERSION > 0)
  })
})
