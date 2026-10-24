import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBackend, MemoryStorageDriver, type TinbaseBackend } from '../src/index.js'
import { FsStorageDriver } from '../src/node/index.js'
import { parseByteRange } from '../src/storage/handler.js'
import type { StorageDriver } from '../src/types.js'
import { testEngine } from './helpers.js'

const ORIGIN = 'http://localhost:54321'

// 1000 bytes whose values differ from their neighbours, so a wrong offset shows.
const DATA = Uint8Array.from({ length: 1000 }, (_, i) => (i * 7 + 3) % 256)

/** A driver with only the required methods, to exercise the get()-and-slice fallback. */
class MinimalDriver implements StorageDriver {
  private inner = new MemoryStorageDriver()
  put(key: string, data: Uint8Array) {
    return this.inner.put(key, data)
  }
  get(key: string) {
    return this.inner.get(key)
  }
  delete(key: string) {
    return this.inner.delete(key)
  }
  deleteMany(keys: string[]) {
    return this.inner.deleteMany(keys)
  }
}

const tmp = mkdtempSync(join(tmpdir(), 'tinbase-range-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const drivers: [string, () => StorageDriver][] = [
  ['memory driver', () => new MemoryStorageDriver()],
  ['fs driver', () => new FsStorageDriver(join(tmp, 'fs'))],
  ['driver without ranged reads', () => new MinimalDriver()],
]

describe.each(drivers)('byte-range downloads (%s)', (_name, makeDriver) => {
  let backend: TinbaseBackend
  const svc = () => ({ apikey: backend.serviceRoleKey, authorization: `Bearer ${backend.serviceRoleKey}` })
  const url = `${ORIGIN}/storage/v1/object/public/media/clip.m4a`
  const get = (headers: Record<string, string> = {}, method = 'GET') =>
    backend.fetch(new Request(url, { method, headers }))

  beforeAll(async () => {
    backend = await createBackend({ engine: await testEngine(), storageDriver: makeDriver() })
    const bucket = await backend.fetch(
      new Request(`${ORIGIN}/storage/v1/bucket`, {
        method: 'POST',
        headers: { ...svc(), 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'media', name: 'media', public: true }),
      })
    )
    expect(bucket.status).toBe(200)
    const up = await backend.fetch(
      new Request(`${ORIGIN}/storage/v1/object/media/clip.m4a`, {
        method: 'POST',
        headers: { ...svc(), 'content-type': 'audio/mp4' },
        body: DATA,
      })
    )
    expect(up.status).toBe(200)
  })

  afterAll(async () => {
    await backend.close?.()
  })

  it('advertises Accept-Ranges on a full 200', async () => {
    const res = await get()
    expect(res.status).toBe(200)
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(res.headers.get('content-length')).toBe('1000')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(DATA)
  })

  it('reports length and Accept-Ranges on HEAD', async () => {
    const res = await get({}, 'HEAD')
    expect(res.status).toBe(200)
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(res.headers.get('content-length')).toBe('1000')
    expect(res.headers.get('content-type')).toBe('audio/mp4')
  })

  it('answers bytes=start-end with 206 and only those bytes', async () => {
    const full = await get()
    const res = await get({ range: 'bytes=0-99' })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 0-99/1000')
    expect(res.headers.get('content-length')).toBe('100')
    expect(res.headers.get('content-type')).toBe('audio/mp4')
    expect(res.headers.get('etag')).toBe(full.headers.get('etag'))
    expect(res.headers.get('cache-control')).toBe(full.headers.get('cache-control'))
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(DATA.subarray(0, 100))

    const mid = await get({ range: 'bytes=500-509' })
    expect(mid.headers.get('content-range')).toBe('bytes 500-509/1000')
    expect(new Uint8Array(await mid.arrayBuffer())).toEqual(DATA.subarray(500, 510))
  })

  it('answers an open-ended bytes=start- with the rest of the object', async () => {
    const res = await get({ range: 'bytes=990-' })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 990-999/1000')
    expect(res.headers.get('content-length')).toBe('10')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(DATA.subarray(990))
  })

  it('answers a suffix bytes=-n with the last n bytes', async () => {
    const res = await get({ range: 'bytes=-50' })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 950-999/1000')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(DATA.subarray(950))
  })

  it('clamps an end past the object to its last byte', async () => {
    const res = await get({ range: 'bytes=900-5000' })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 900-999/1000')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(DATA.subarray(900))
  })

  it('answers 416 with bytes */size when the range starts past the end', async () => {
    const res = await get({ range: 'bytes=1000-1100' })
    expect(res.status).toBe(416)
    expect(res.headers.get('content-range')).toBe('bytes */1000')
    expect((await res.arrayBuffer()).byteLength).toBe(0)
  })

  it('serves the whole object for several ranges or a malformed header', async () => {
    for (const range of ['bytes=0-1,5-6', 'bytes=9-3', 'items=0-1', 'bytes=abc']) {
      const res = await get({ range })
      expect(res.status, range).toBe(200)
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(DATA)
    }
  })

  it('applies to authenticated downloads and signed URLs too', async () => {
    const auth = await backend.fetch(
      new Request(`${ORIGIN}/storage/v1/object/authenticated/media/clip.m4a`, {
        headers: { ...svc(), range: 'bytes=10-19' },
      })
    )
    expect(auth.status).toBe(206)
    expect(new Uint8Array(await auth.arrayBuffer())).toEqual(DATA.subarray(10, 20))

    const sign = await backend.fetch(
      new Request(`${ORIGIN}/storage/v1/object/sign/media/clip.m4a`, {
        method: 'POST',
        headers: { ...svc(), 'content-type': 'application/json' },
        body: JSON.stringify({ expiresIn: 60 }),
      })
    )
    const { signedURL } = (await sign.json()) as { signedURL: string }
    const signed = await backend.fetch(
      new Request(`${ORIGIN}/storage/v1${signedURL}`, { headers: { range: 'bytes=-5' } })
    )
    expect(signed.status).toBe(206)
    expect(signed.headers.get('content-range')).toBe('bytes 995-999/1000')
    expect(new Uint8Array(await signed.arrayBuffer())).toEqual(DATA.subarray(995))
  })
})

describe('parseByteRange', () => {
  it('reads the three single-range forms', () => {
    expect(parseByteRange('bytes=0-99', 1000)).toEqual([0, 99])
    expect(parseByteRange('bytes=10-', 1000)).toEqual([10, 999])
    expect(parseByteRange('bytes=-100', 1000)).toEqual([900, 999])
    expect(parseByteRange('bytes=-5000', 1000)).toEqual([0, 999])
  })

  it('flags ranges that select no byte', () => {
    expect(parseByteRange('bytes=1000-', 1000)).toBe('unsatisfiable')
    expect(parseByteRange('bytes=-0', 1000)).toBe('unsatisfiable')
    expect(parseByteRange('bytes=0-', 0)).toBe('unsatisfiable')
  })

  it('ignores what it does not handle', () => {
    expect(parseByteRange('bytes=5-1', 1000)).toBeNull()
    expect(parseByteRange('bytes=0-1, 4-5', 1000)).toBeNull()
    expect(parseByteRange('bytes=-', 1000)).toBeNull()
    expect(parseByteRange('lines=0-1', 1000)).toBeNull()
  })
})
