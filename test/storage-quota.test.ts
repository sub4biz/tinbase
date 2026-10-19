import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createBackend, type TinbaseBackend } from '../src/index.js'
import { formatBytes } from '../src/storage/handler.js'
import { testEngine } from './helpers.js'

const ORIGIN = 'http://localhost:54321'

interface Env {
  backend: TinbaseBackend
  anon: SupabaseClient
  admin: SupabaseClient
}

async function makeEnv(opts: Parameters<typeof createBackend>[0] = {}): Promise<Env> {
  const backend = await createBackend({ engine: await testEngine(), ...opts })
  const fetchAdapter: typeof fetch = (input, init) => backend.fetch(new Request(input, init))
  const clientOpts = { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: fetchAdapter } }
  return {
    backend,
    anon: createClient(ORIGIN, backend.anonKey, clientOpts),
    admin: createClient(ORIGIN, backend.serviceRoleKey, clientOpts),
  }
}

const svc = (b: TinbaseBackend) => ({ apikey: b.serviceRoleKey, authorization: `Bearer ${b.serviceRoleKey}` })

async function status(b: TinbaseBackend) {
  const res = await b.fetch(new Request(`${ORIGIN}/admin/v1/storage`, { headers: svc(b) }))
  expect(res.status).toBe(200)
  return (await res.json()) as {
    used_bytes: number
    quota_bytes: number | null
    objects: number
    last_refused_at: string | null
  }
}

async function setQuota(b: TinbaseBackend, quota: unknown) {
  return b.fetch(
    new Request(`${ORIGIN}/admin/v1/storage`, {
      method: 'PUT',
      headers: { ...svc(b), 'content-type': 'application/json' },
      body: JSON.stringify({ quota_bytes: quota }),
    })
  )
}

const bytes = (n: number, fill = 97) => new Blob([new Uint8Array(n).fill(fill)], { type: 'application/octet-stream' })

const tusMeta = (o: Record<string, string>) =>
  Object.entries(o)
    .map(([k, v]) => `${k} ${Buffer.from(v).toString('base64')}`)
    .join(',')

function tusCreate(b: TinbaseBackend, objectName: string, length: number, extra: Record<string, string> = {}) {
  return b.fetch(
    new Request(`${ORIGIN}/storage/v1/upload/resumable`, {
      method: 'POST',
      headers: {
        ...svc(b),
        'tus-resumable': '1.0.0',
        'upload-length': String(length),
        'upload-metadata': tusMeta({ bucketName: 'files', objectName }),
        ...extra,
      },
    })
  )
}

function tusPatch(b: TinbaseBackend, location: string, chunk: Uint8Array, offset: number) {
  return b.fetch(
    new Request(location, {
      method: 'PATCH',
      headers: {
        ...svc(b),
        'tus-resumable': '1.0.0',
        'content-type': 'application/offset+octet-stream',
        'upload-offset': String(offset),
      },
      body: chunk,
    })
  )
}

describe('storage quota', () => {
  let env: Env

  beforeAll(async () => {
    env = await makeEnv()
    await env.admin.storage.createBucket('files', { public: false })
    await env.admin.storage.createBucket('small', { public: false, fileSizeLimit: 100 })
  })

  afterAll(async () => {
    await env.backend.close()
  })

  afterEach(async () => {
    // every test starts with an empty, unlimited project
    await env.admin.storage.emptyBucket('files')
    await env.admin.storage.emptyBucket('small')
    expect((await setQuota(env.backend, null)).status).toBe(200)
  })

  it('reports usage and an unlimited quota by default, to the service role only', async () => {
    const anon = await env.backend.fetch(
      new Request(`${ORIGIN}/admin/v1/storage`, { headers: { apikey: env.backend.anonKey } })
    )
    expect(anon.status).toBe(403)

    await env.admin.storage.from('files').upload('a.bin', bytes(300))
    const s = await status(env.backend)
    expect(s).toMatchObject({ used_bytes: 300, quota_bytes: null, objects: 1 })
  })

  it('validates PUT /admin/v1/storage', async () => {
    expect((await setQuota(env.backend, -1)).status).toBe(400)
    expect((await setQuota(env.backend, 1.5)).status).toBe(400)
    expect((await setQuota(env.backend, '2MB')).status).toBe(400)
    const missing = await env.backend.fetch(
      new Request(`${ORIGIN}/admin/v1/storage`, {
        method: 'PUT',
        headers: { ...svc(env.backend), 'content-type': 'application/json' },
        body: '{}',
      })
    )
    expect(missing.status).toBe(400)
    const anon = await env.backend.fetch(
      new Request(`${ORIGIN}/admin/v1/storage`, {
        method: 'PUT',
        headers: { apikey: env.backend.anonKey, 'content-type': 'application/json' },
        body: JSON.stringify({ quota_bytes: 0 }),
      })
    )
    expect(anon.status).toBe(403)

    const ok = await setQuota(env.backend, 1000)
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ quota_bytes: 1000, used_bytes: 0 })
  })

  it('refuses an upload past the quota with a 413 supabase-js surfaces', async () => {
    await setQuota(env.backend, 1000)
    const first = await env.admin.storage.from('files').upload('one.bin', bytes(600))
    expect(first.error).toBeNull()

    const second = await env.admin.storage.from('files').upload('two.bin', bytes(600))
    expect(second.data).toBeNull()
    const err = second.error as unknown as { message: string; status: number; statusCode: string }
    expect(err.status).toBe(413)
    expect(err.statusCode).toBe('413')
    expect(err.message).toBe(
      'This app has reached its storage limit (600 bytes of 1000 bytes). ' +
        'The project owner can free up space or upgrade their plan.'
    )

    const s = await status(env.backend)
    expect(s.used_bytes).toBe(600)
    expect(s.objects).toBe(1)
    expect(s.last_refused_at).not.toBeNull()

    // an upload that still fits goes through
    const fits = await env.admin.storage.from('files').upload('three.bin', bytes(400))
    expect(fits.error).toBeNull()
    expect((await status(env.backend)).used_bytes).toBe(1000)
  })

  it('returns the documented error body', async () => {
    await setQuota(env.backend, 10)
    const res = await env.backend.fetch(
      new Request(`${ORIGIN}/storage/v1/object/files/raw.txt`, {
        method: 'POST',
        headers: { ...svc(env.backend), 'content-type': 'text/plain' },
        body: 'more than ten bytes',
      })
    )
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({
      statusCode: '413',
      error: 'storage_quota_exceeded',
      message:
        'This app has reached its storage limit (0 bytes of 10 bytes). ' +
        'The project owner can free up space or upgrade their plan.',
    })
  })

  it('refuses from Content-Length before reading the body', async () => {
    await setQuota(env.backend, 1000)
    let pulled = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++
        controller.enqueue(new Uint8Array(100))
        if (pulled >= 50) controller.close()
      },
    })
    const res = await env.backend.fetch(
      new Request(`${ORIGIN}/storage/v1/object/files/stream.bin`, {
        method: 'POST',
        headers: { ...svc(env.backend), 'content-type': 'application/octet-stream', 'content-length': '5000' },
        body,
        // @ts-expect-error node's fetch needs duplex for a stream body
        duplex: 'half',
      })
    )
    expect(res.status).toBe(413)
    expect(((await res.json()) as { error: string }).error).toBe('storage_quota_exceeded')
    // nothing (or at most the first buffered chunk) was consumed
    expect(pulled).toBeLessThanOrEqual(2)
  })

  it('counts only the growth when an upsert replaces an object', async () => {
    await setQuota(env.backend, 1000)
    expect((await env.admin.storage.from('files').upload('doc.bin', bytes(900))).error).toBeNull()

    // replacing 900 with 1000 needs 100 more: fits exactly
    const bigger = await env.admin.storage.from('files').upload('doc.bin', bytes(1000), { upsert: true })
    expect(bigger.error).toBeNull()
    expect((await status(env.backend)).used_bytes).toBe(1000)

    // replacing with 1001 does not
    const tooBig = await env.admin.storage.from('files').upload('doc.bin', bytes(1001), { upsert: true })
    expect((tooBig.error as unknown as { status: number }).status).toBe(413)

    // shrinking is always allowed, even when the project is over a lowered quota
    await setQuota(env.backend, 500)
    const smaller = await env.admin.storage.from('files').upload('doc.bin', bytes(800), { upsert: true })
    expect(smaller.error).toBeNull()
    expect((await status(env.backend)).used_bytes).toBe(800)
  })

  it('lowering the quota keeps existing objects and refuses only growth', async () => {
    await env.admin.storage.from('files').upload('keep.bin', bytes(700))
    await setQuota(env.backend, 500)
    const s = await status(env.backend)
    expect(s.used_bytes).toBe(700)
    const down = await env.admin.storage.from('files').download('keep.bin')
    expect(down.error).toBeNull()
    const more = await env.admin.storage.from('files').upload('more.bin', bytes(1))
    expect((more.error as unknown as { status: number }).status).toBe(413)
  })

  it('frees space when objects are removed', async () => {
    await setQuota(env.backend, 1000)
    await env.admin.storage.from('files').upload('a.bin', bytes(800))
    expect((await env.admin.storage.from('files').upload('b.bin', bytes(800))).error).not.toBeNull()
    await env.admin.storage.from('files').remove(['a.bin'])
    expect((await env.admin.storage.from('files').upload('b.bin', bytes(800))).error).toBeNull()
  })

  it('applies to signed upload URLs', async () => {
    await setQuota(env.backend, 1000)
    await env.admin.storage.from('files').upload('base.bin', bytes(900))
    const signed = await env.admin.storage.from('files').createSignedUploadUrl('signed.bin')
    expect(signed.error).toBeNull()
    const up = await env.anon.storage.from('files').uploadToSignedUrl('signed.bin', signed.data!.token, bytes(200))
    expect((up.error as unknown as { status: number; message: string }).status).toBe(413)
    expect((up.error as unknown as { message: string }).message).toContain('storage limit')
  })

  it('applies to copies but not moves', async () => {
    await setQuota(env.backend, 1000)
    await env.admin.storage.from('files').upload('src.bin', bytes(600))

    const mv = await env.admin.storage.from('files').move('src.bin', 'moved.bin')
    expect(mv.error).toBeNull()

    const cp = await env.admin.storage.from('files').copy('moved.bin', 'copy.bin')
    expect((cp.error as unknown as { status: number }).status).toBe(413)
    expect((await status(env.backend)).objects).toBe(1)
  })

  it('applies the destination bucket size limit to copies', async () => {
    await env.admin.storage.from('files').upload('big.bin', bytes(500))
    const cp = await env.admin.storage.from('files').copy('big.bin', 'big.bin', { destinationBucket: 'small' })
    expect((cp.error as unknown as { status: number }).status).toBe(413)
  })

  it('refuses a resumable (TUS) upload whose declared length is past the quota', async () => {
    await setQuota(env.backend, 1000)
    const create = await tusCreate(env.backend, 'tus/too-big.bin', 1001)
    expect(create.status).toBe(413)
    expect(((await create.json()) as { error: string }).error).toBe('storage_quota_exceeded')
  })

  it('re-checks the quota when a resumable upload completes', async () => {
    await setQuota(env.backend, 1000)
    const create = await tusCreate(env.backend, 'tus/late.bin', 600)
    expect(create.status).toBe(201)
    const location = create.headers.get('location')!

    // another write takes the space while the resumable upload is in flight
    expect((await env.admin.storage.from('files').upload('other.bin', bytes(600))).error).toBeNull()

    const first = await tusPatch(env.backend, location, new Uint8Array(300), 0)
    expect(first.status).toBe(204)
    const last = await tusPatch(env.backend, location, new Uint8Array(300), 300)
    expect(last.status).toBe(413)
    expect((await status(env.backend)).used_bytes).toBe(600)
  })

  it('completes a resumable upload that fits', async () => {
    await setQuota(env.backend, 1000)
    const create = await tusCreate(env.backend, 'tus/fits.bin', 600)
    const location = create.headers.get('location')!
    expect((await tusPatch(env.backend, location, new Uint8Array(600), 0)).status).toBe(204)
    expect((await status(env.backend)).used_bytes).toBe(600)
  })

  it('does not let concurrent uploads together exceed the quota', async () => {
    await setQuota(env.backend, 1000)
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => env.admin.storage.from('files').upload(`race/${i}.bin`, bytes(400)))
    )
    expect(results.filter((r) => r.error === null)).toHaveLength(2)
    expect((await status(env.backend)).used_bytes).toBe(800)
  })
})

describe('resumable uploads honour the default file size limit', () => {
  let env: Env

  beforeAll(async () => {
    env = await makeEnv({ storageFileSizeLimit: 100 })
    await env.admin.storage.createBucket('files', { public: false })
  })

  afterAll(async () => {
    await env.backend.close()
  })

  it('refuses a TUS upload larger than storage.file_size_limit when the bucket sets none', async () => {
    const create = await tusCreate(env.backend, 'tus/over.bin', 101)
    expect(create.status).toBe(413)
    const ok = await tusCreate(env.backend, 'tus/ok.bin', 100)
    expect(ok.status).toBe(201)
  })
})

describe('storage quota persistence', () => {
  it('uses the configured quota until one is set at runtime, then keeps that across restarts', async () => {
    // PGlite on a data directory, so the second backend sees the first one's data
    const dataDir = join(mkdtempSync(join(tmpdir(), 'tinbase-quota-')), 'db')

    const first = await makeEnv({ engine: undefined, dataDir, storageQuotaBytes: 2048 })
    expect((await status(first.backend)).quota_bytes).toBe(2048)
    expect((await setQuota(first.backend, 4096)).status).toBe(200)
    await first.admin.storage.createBucket('files', { public: false })
    await first.admin.storage.from('files').upload('x.bin', bytes(5000)).then((r) => {
      expect((r.error as unknown as { status: number }).status).toBe(413)
    })
    const refusedAt = (await status(first.backend)).last_refused_at
    expect(refusedAt).not.toBeNull()
    await first.backend.close()

    // restarted with a different configured value: the runtime setting wins
    const second = await makeEnv({ engine: undefined, dataDir, storageQuotaBytes: 2048 })
    const s = await status(second.backend)
    expect(s.quota_bytes).toBe(4096)
    expect(s.last_refused_at).toBe(refusedAt)

    // clearing it at runtime is also kept: null means unlimited, not "use the config"
    await setQuota(second.backend, null)
    await second.backend.close()
    const third = await makeEnv({ engine: undefined, dataDir, storageQuotaBytes: 2048 })
    expect((await status(third.backend)).quota_bytes).toBeNull()
    await third.backend.close()
  })
})

describe('formatBytes', () => {
  it('formats with 1024-based units', () => {
    expect(formatBytes(0)).toBe('0 bytes')
    expect(formatBytes(1000)).toBe('1000 bytes')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(2 * 1024 * 1024)).toBe('2 MB')
    expect(formatBytes(1.94 * 1024 * 1024)).toBe('1.9 MB')
    expect(formatBytes(165 * 1024 * 1024)).toBe('165 MB')
    expect(formatBytes(3 * 1024 ** 3)).toBe('3 GB')
  })
})
