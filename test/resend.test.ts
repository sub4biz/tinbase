import { describe, expect, it } from 'vitest'
import { ResendMailer, isValidFrom } from '../src/auth/resend.js'

type Call = { url: string; init: RequestInit }

function fakeFetch(status: number, body: unknown = {}): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { fetch: f, calls }
}

describe('ResendMailer', () => {
  it('posts the message to Resend with the bearer key and configured sender', async () => {
    const { fetch, calls } = fakeFetch(200, { id: 'msg_1' })
    const mailer = new ResendMailer({ apiKey: 're_test', from: 'Acme <noreply@acme.com>', fetch })

    await mailer.send({ to: 'riya@example.com', subject: 'Reset your password', text: 'link + code' })

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api.resend.com/emails')
    expect(calls[0].init.method).toBe('POST')
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer re_test')
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      from: 'Acme <noreply@acme.com>',
      to: ['riya@example.com'],
      subject: 'Reset your password',
      text: 'link + code',
    })
  })

  it("surfaces Resend's error without the message body", async () => {
    const { fetch } = fakeFetch(403, { name: 'validation_error', message: 'The acme.com domain is not verified' })
    const mailer = new ResendMailer({ apiKey: 're_test', from: 'noreply@acme.com', fetch })

    await expect(
      mailer.send({ to: 'riya@example.com', subject: 'Reset your password', text: 'SECRET-CODE-123456' })
    ).rejects.toThrow(/HTTP 403 The acme.com domain is not verified/)
    await expect(
      mailer.send({ to: 'riya@example.com', subject: 'Reset your password', text: 'SECRET-CODE-123456' })
    ).rejects.not.toThrow(/SECRET-CODE/)
  })

  it('refuses to construct without a key or with an unusable sender', () => {
    expect(() => new ResendMailer({ apiKey: '', from: 'noreply@acme.com' })).toThrow(/apiKey/)
    expect(() => new ResendMailer({ apiKey: 're_test', from: 'Acme' })).toThrow(/invalid from/)
  })

  it('isValidFrom accepts bare and display-name senders', () => {
    expect(isValidFrom('noreply@acme.com')).toBe(true)
    expect(isValidFrom('Acme <noreply@acme.com>')).toBe(true)
    expect(isValidFrom('noreply@localhost')).toBe(false)
    expect(isValidFrom('<>')).toBe(false)
  })
})

describe('html bodies', () => {
  it('sends html alongside text when the message has one', async () => {
    const { fetch, calls } = fakeFetch(200, { id: 'msg_2' })
    const mailer = new ResendMailer({ apiKey: 're_test', from: 'noreply@example.com', fetch })
    await mailer.send({ to: 'a@example.com', subject: 'Reset your password', text: 'link', html: '<a href="x">Reset</a>' })
    const sent = JSON.parse(calls[0].init.body as string)
    expect(sent.text).toBe('link')
    expect(sent.html).toBe('<a href="x">Reset</a>')
  })

  it('omits the html key entirely for a text-only message', async () => {
    const { fetch, calls } = fakeFetch(200, { id: 'msg_3' })
    const mailer = new ResendMailer({ apiKey: 're_test', from: 'noreply@example.com', fetch })
    await mailer.send({ to: 'a@example.com', subject: 's', text: 'only text' })
    expect(JSON.parse(calls[0].init.body as string)).not.toHaveProperty('html')
  })
})

describe('endpoint override', () => {
  it('posts to a configured gateway instead of Resend', async () => {
    const { fetch, calls } = fakeFetch(200, { id: 'msg_4' })
    // what a platform sets: its own gateway, and a per-tenant key rather than
    // the provider credential
    const mailer = new ResendMailer({
      apiKey: 'rn_svc_abc',
      from: 'App <noreply@example.com>',
      endpoint: 'https://global-services.example/resend/emails',
      fetch,
    })
    await mailer.send({ to: 'a@example.com', subject: 's', text: 't' })
    expect(calls[0].url).toBe('https://global-services.example/resend/emails')
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer rn_svc_abc')
  })

  it('defaults to Resend when no endpoint is given', async () => {
    const { fetch, calls } = fakeFetch(200, { id: 'msg_5' })
    await new ResendMailer({ apiKey: 're_x', from: 'a@example.com', fetch }).send({
      to: 'b@example.com', subject: 's', text: 't',
    })
    expect(calls[0].url).toBe('https://api.resend.com/emails')
  })

  it("surfaces the gateway's rejection, not a generic failure", async () => {
    const { fetch } = fakeFetch(401, { error: 'Missing API key. Use: Authorization: Bearer rn_svc_...' })
    const mailer = new ResendMailer({
      apiKey: 'wrong', from: 'a@example.com', endpoint: 'https://gs.example/resend/emails', fetch,
    })
    await expect(mailer.send({ to: 'b@example.com', subject: 's', text: 't' })).rejects.toThrow(/HTTP 401/)
  })
})
