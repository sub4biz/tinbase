import { createClient } from '@supabase/supabase-js'
import { afterEach, describe, expect, it } from 'vitest'
import { createBackend, type MailMessage, type TinbaseBackend } from '../src/index.js'

/**
 * The Send Email Hook: an endpoint receives the token material and composes and
 * sends the mail itself. Payload and signing follow GoTrue's, so an endpoint
 * written against Supabase works here unchanged.
 */
let backend: TinbaseBackend | undefined
afterEach(async () => {
  await backend?.close()
  backend = undefined
})

interface Call {
  url: string
  headers: Record<string, string>
  body: { user: Record<string, unknown>; email_data: Record<string, string> }
}

function capture(status = 200, payload: unknown = { ok: true }) {
  const calls: Call[] = []
  const hookFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body)),
    })
    return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { hookFetch, calls }
}

async function boot(opts: { secret?: string; hookFetch: typeof fetch; outbox: MailMessage[] }) {
  backend = await createBackend({
    mailer: { send: async (m) => void opts.outbox.push(m) },
    siteUrl: 'https://db.example.dev',
    sendEmailHook: { uri: 'https://hook.example/send', ...(opts.secret ? { secret: opts.secret } : {}) },
    hookFetch: opts.hookFetch,
  })
  return createClient('http://localhost:54321', backend.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (i, init) => backend!.fetch(new Request(i, init)) },
  })
}

describe('send email hook', () => {
  it('posts GoTrue\'s payload and sends nothing itself', async () => {
    const outbox: MailMessage[] = []
    const { hookFetch, calls } = capture()
    const supabase = await boot({ hookFetch, outbox })

    await supabase.auth.signUp({ email: 'hook@example.com', password: 'password123' })
    await supabase.auth.signOut()
    await supabase.auth.resetPasswordForEmail('hook@example.com', { redirectTo: 'https://app.example.dev/reset' })

    expect(calls).toHaveLength(1)
    const { url, body } = calls[0]
    expect(url).toBe('https://hook.example/send')

    // the endpoint gets the material, not a finished message
    expect(body.email_data.email_action_type).toBe('recovery')
    expect(body.email_data.token).toMatch(/^\d{6}$/)
    expect(body.email_data.token_hash).toBeTruthy()
    expect(body.email_data.redirect_to).toBe('https://app.example.dev/reset')
    expect(body.email_data.site_url).toBe('https://db.example.dev')
    expect(body.user.email).toBe('hook@example.com')

    // and the transport is bypassed entirely — the hook replaces it
    expect(outbox).toHaveLength(0)
  })

  it('names the action so an endpoint can switch on it', async () => {
    const outbox: MailMessage[] = []
    const { hookFetch, calls } = capture()
    const supabase = await boot({ hookFetch, outbox })
    await supabase.auth.signInWithOtp({ email: 'magic@example.com' })
    expect(calls[0].body.email_data.email_action_type).toBe('magiclink')
  })

  it('signs the request the way Standard Webhooks does, so a receiver can verify it', async () => {
    const outbox: MailMessage[] = []
    const { hookFetch, calls } = capture()
    // "v1,whsec_<base64>" — GoTrue's format
    const secret = 'v1,whsec_' + btoa('supersecretkey')
    const supabase = await boot({ secret, hookFetch, outbox })
    await supabase.auth.signInWithOtp({ email: 'signed@example.com' })

    const { headers, body } = calls[0]
    const id = headers['webhook-id']
    const timestamp = headers['webhook-timestamp']
    expect(id).toMatch(/^msg_/)
    expect(Number(timestamp)).toBeGreaterThan(0)

    // recompute the signature over id.timestamp.body, as a receiver would
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode('supersecretkey'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    )
    const signed = new TextEncoder().encode(`${id}.${timestamp}.${JSON.stringify(body)}`)
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, signed))
    let bin = ''
    for (const b of mac) bin += String.fromCharCode(b)
    expect(headers['webhook-signature']).toBe(`v1,${btoa(bin)}`)
  })

  it('sends unsigned when no secret is configured', async () => {
    const outbox: MailMessage[] = []
    const { hookFetch, calls } = capture()
    const supabase = await boot({ hookFetch, outbox })
    await supabase.auth.signInWithOtp({ email: 'unsigned@example.com' })
    expect(calls[0].headers['webhook-signature']).toBeUndefined()
  })

  it('fails the request when the endpoint refuses, rather than reporting success', async () => {
    const outbox: MailMessage[] = []
    const { hookFetch } = capture(500, { error: { message: 'downstream provider is down' } })
    backend = await createBackend({
      mailer: { send: async (m) => void outbox.push(m) },
      sendEmailHook: { uri: 'https://hook.example/send' },
      hookFetch,
    })
    const res = await backend.fetch(
      new Request('http://localhost:54321/auth/v1/otp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', apikey: backend.anonKey },
        body: JSON.stringify({ email: 'fails@example.com' }),
      })
    )
    // the user asked for an email; an endpoint that refused did not send one
    expect(res.status).toBe(500)
    const body = (await res.json()) as { msg: string }
    expect(body.msg).toContain('downstream provider is down')
  })
})
