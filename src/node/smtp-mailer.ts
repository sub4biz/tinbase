/**
 * SMTP transport — the way a project sends its own auth email.
 *
 * This is the one that makes tinbase self-sufficient. A provider-specific
 * client (see {@link import('../auth/resend.js').ResendMailer}) makes our
 * choice of vendor everyone else's problem: to send real mail you would have to
 * open an account with the one provider we happened to implement. SMTP is a
 * protocol rather than a vendor, and every provider speaks it - SES, Postmark,
 * Mailgun, Resend, or a mail server the operator runs - so one implementation
 * covers all of them. It is also what GoTrue does, which keeps a project's
 * `[auth.email.smtp]` block portable between tinbase and Supabase.
 *
 * Node-only, and imported lazily: `nodemailer` reaches for `node:net`/`node:tls`,
 * which the browser build must never pull in.
 */
import type { MailMessage, Mailer } from '../types.js'

/** `[auth.email.smtp]`, using Supabase's key names. */
export interface SmtpConfig {
  host: string
  port: number
  user?: string
  pass?: string
  /** Address mail is sent from; GoTrue calls this admin_email. */
  adminEmail: string
  /** Display name shown beside the address. */
  senderName?: string
  /**
   * Implicit TLS from the first byte (port 465). Left unset, this follows the
   * port, and STARTTLS is negotiated on the usual submission ports - which is
   * what nearly every provider expects on 587.
   */
  secure?: boolean
}

/** Minimal shape we use from nodemailer, so the import stays type-safe without the dependency. */
interface Transporter {
  sendMail(opts: { from: string; to: string; subject: string; text: string; html?: string }): Promise<unknown>
}

export class SmtpMailer implements Mailer {
  private transporter: Transporter | undefined

  constructor(private readonly cfg: SmtpConfig) {
    if (!cfg.host) throw new Error('SMTP: host is required')
    if (!cfg.adminEmail) throw new Error('SMTP: admin_email is required (the address mail is sent from)')
    if (!Number.isFinite(cfg.port) || cfg.port <= 0) throw new Error(`SMTP: invalid port ${cfg.port}`)
  }

  /** `Display Name <address>` when a name is configured, otherwise the bare address. */
  get from(): string {
    return this.cfg.senderName ? `${this.cfg.senderName} <${this.cfg.adminEmail}>` : this.cfg.adminEmail
  }

  /**
   * Built on first send, not in the constructor: the process should start even
   * when the mail server is unreachable, and an unsendable email should fail
   * the request that asked for it rather than the whole server.
   */
  private async transport(): Promise<Transporter> {
    if (this.transporter) return this.transporter
    let nodemailer: { createTransport(opts: unknown): Transporter }
    try {
      nodemailer = (await import('nodemailer')) as unknown as { createTransport(opts: unknown): Transporter }
    } catch {
      throw new Error(
        'SMTP is configured but the `nodemailer` package is not installed. Install it, or remove [auth.email.smtp].'
      )
    }
    const { host, port, user, pass, secure } = this.cfg
    this.transporter = nodemailer.createTransport({
      host,
      port,
      // 465 is implicit TLS; everything else negotiates STARTTLS.
      secure: secure ?? port === 465,
      ...(user || pass ? { auth: { user, pass } } : {}),
    })
    return this.transporter
  }

  async send(msg: MailMessage): Promise<void> {
    const transporter = await this.transport()
    await transporter.sendMail({
      from: this.from,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      ...(msg.html ? { html: msg.html } : {}),
    })
  }
}
