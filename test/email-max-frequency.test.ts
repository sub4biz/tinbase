import { createClient } from '@supabase/supabase-js'
import { afterEach, describe, expect, it } from 'vitest'
import { createBackend, type MailMessage, type TinbaseBackend } from '../src/index.js'

/**
 * `max_frequency`: the shortest interval between auth emails to one address.
 *
 * Distinct from the per-client rate limit, which is keyed by caller and so says
 * nothing about how often a given mailbox can be made to receive mail.
 */
let backend: TinbaseBackend | undefined
afterEach(async () => {
  await backend?.close()
  backend = undefined
})

async function boot(seconds: number, outbox: MailMessage[]) {
  backend = await createBackend({
    mailer: { send: async (m) => void outbox.push(m) },
    authSettings: { maxEmailFrequencySeconds: seconds },
  })
  const supabase = createClient('http://localhost:54321', backend.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (i, init) => backend!.fetch(new Request(i, init)) },
  })
  return { supabase, anon: backend.anonKey }
}

const recover = (b: TinbaseBackend, anon: string, email: string) =>
  b.fetch(
    new Request('http://localhost:54321/auth/v1/recover', {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: anon },
      body: JSON.stringify({ email }),
    })
  )

describe('max_frequency', () => {
  it('refuses a second email to the same address inside the window', async () => {
    const outbox: MailMessage[] = []
    const { supabase, anon } = await boot(60, outbox)
    await supabase.auth.signUp({ email: 'freq@example.com', password: 'password123' })
    outbox.length = 0

    const first = await recover(backend!, anon, 'freq@example.com')
    expect(first.status).toBe(200)
    expect(outbox).toHaveLength(1)

    const second = await recover(backend!, anon, 'freq@example.com')
    expect(second.status).toBe(429)
    const body = (await second.json()) as { error_code: string }
    expect(body.error_code).toBe('over_email_send_rate_limit')
    // the point of the limit: no second message was produced
    expect(outbox).toHaveLength(1)
    // a client is told how long to wait rather than left guessing
    expect(Number(second.headers.get('retry-after'))).toBeGreaterThan(0)
  })

  it('does not hold up a different address', async () => {
    const outbox: MailMessage[] = []
    const { supabase, anon } = await boot(60, outbox)
    await supabase.auth.signUp({ email: 'a@example.com', password: 'password123' })
    await supabase.auth.signUp({ email: 'b@example.com', password: 'password123' })
    outbox.length = 0

    expect((await recover(backend!, anon, 'a@example.com')).status).toBe(200)
    expect((await recover(backend!, anon, 'b@example.com')).status).toBe(200)
    expect(outbox).toHaveLength(2)
  })

  it('answers the same for an address with no account, so the limit cannot be used to probe', async () => {
    // Checked before the account lookup on purpose: answering 429 only for real
    // addresses would hand back the enumeration that answering 200 for unknown
    // ones exists to prevent.
    const outbox: MailMessage[] = []
    const { anon } = await boot(60, outbox)
    expect((await recover(backend!, anon, 'ghost@example.com')).status).toBe(200)
    const second = await recover(backend!, anon, 'ghost@example.com')
    expect(second.status).toBe(429)
    expect(outbox).toHaveLength(0)
  })

  it('is off when set to zero', async () => {
    const outbox: MailMessage[] = []
    const { supabase, anon } = await boot(0, outbox)
    await supabase.auth.signUp({ email: 'off@example.com', password: 'password123' })
    outbox.length = 0
    expect((await recover(backend!, anon, 'off@example.com')).status).toBe(200)
    expect((await recover(backend!, anon, 'off@example.com')).status).toBe(200)
    expect(outbox).toHaveLength(2)
  })

  it('applies to magic links and OTPs too, not just recovery', async () => {
    const outbox: MailMessage[] = []
    const { supabase } = await boot(60, outbox)
    const first = await supabase.auth.signInWithOtp({ email: 'otpfreq@example.com' })
    expect(first.error).toBeNull()
    const second = await supabase.auth.signInWithOtp({ email: 'otpfreq@example.com' })
    expect(second.error).not.toBeNull()
    expect(outbox).toHaveLength(1)
  })
})
