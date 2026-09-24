/**
 * Send Email Hook — hand the auth email off to an endpoint instead of sending it.
 *
 * This intercepts earlier than a mail transport. A transport receives a message
 * we have already written; the hook receives the raw material - the token, its
 * hash, where the link should land, which action it is - and composes and sends
 * the mail itself. That is what makes it an override rather than a destination:
 * the endpoint decides the wording, the format and the provider.
 *
 * The payload and the signing scheme are GoTrue's, so an endpoint written for
 * Supabase works here unchanged.
 */

/** `[auth.hook.send_email]`. */
export interface SendEmailHookConfig {
  /** Endpoint the payload is POSTed to. */
  uri: string
  /**
   * Shared secret, as GoTrue formats it: `v1,whsec_<base64>`. The base64 part
   * is the signing key. Absent means the request is sent unsigned, which is
   * only reasonable when the endpoint is unreachable from anywhere else.
   */
  secret?: string
}

/** The GoTrue action names an endpoint switches on. */
export type EmailActionType =
  | 'signup'
  | 'invite'
  | 'magiclink'
  | 'recovery'
  | 'email_change'
  | 'email_change_current'
  | 'email_change_new'
  | 'reauthentication'

/** The `email_data` half of the payload. */
export interface EmailData {
  token: string
  token_hash: string
  redirect_to: string
  email_action_type: EmailActionType
  site_url: string
  token_new: string
  token_hash_new: string
}

export interface SendEmailHookPayload {
  user: Record<string, unknown>
  email_data: EmailData
}

/** Strip the `v1,whsec_` prefix and decode to the raw signing key. */
function signingKey(secret: string): ArrayBuffer {
  const b64 = secret.replace(/^v1,\s*/, '').replace(/^whsec_/, '')
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out.buffer
}

function base64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

/**
 * Standard Webhooks signature: HMAC-SHA256 over `id.timestamp.body`.
 *
 * The id and timestamp are inside the signed string on purpose - a signature
 * over the body alone can be replayed verbatim, and the timestamp is what lets
 * the receiver bound how old a request it will accept.
 */
async function sign(secret: string, id: string, timestamp: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', signingKey(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ])
  const signed = new TextEncoder().encode(`${id}.${timestamp}.${body}`)
  const mac = await crypto.subtle.sign('HMAC', key, signed.buffer as ArrayBuffer)
  return `v1,${base64(new Uint8Array(mac))}`
}

/**
 * POST the payload and resolve only if the endpoint accepted it.
 *
 * A non-2xx is thrown rather than swallowed: the user asked for an email, and
 * an endpoint that refused the request did not send one. Reporting success
 * would leave them waiting for mail that was never going to arrive.
 */
export async function callSendEmailHook(
  cfg: SendEmailHookConfig,
  payload: SendEmailHookPayload,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const body = JSON.stringify(payload)
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (cfg.secret) {
    const id = `msg_${crypto.randomUUID()}`
    const timestamp = Math.floor(Date.now() / 1000)
    headers['webhook-id'] = id
    headers['webhook-timestamp'] = String(timestamp)
    headers['webhook-signature'] = await sign(cfg.secret, id, timestamp, body)
  }
  const res = await fetchImpl(cfg.uri, { method: 'POST', headers, body })
  if (!res.ok) {
    let detail = ''
    try {
      const parsed = (await res.json()) as { error?: { message?: string }; message?: string }
      detail = parsed.error?.message ?? parsed.message ?? ''
    } catch {
      /* non-JSON error body */
    }
    throw new Error(`send email hook rejected the message: HTTP ${res.status}${detail ? ` ${detail}` : ''}`)
  }
}
