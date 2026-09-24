import { createServer, type Server, type Socket } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SmtpMailer } from '../src/node/smtp-mailer.js'

/**
 * A minimal SMTP server, so these tests exercise a real SMTP conversation
 * rather than a mocked client. Enough of the protocol for a submission:
 * greeting, EHLO, AUTH LOGIN, MAIL FROM, RCPT TO, DATA.
 */
class FakeSmtp {
  private server: Server
  port = 0
  received: { mailFrom?: string; rcptTo?: string; data: string }[] = []
  authSeen: { user?: string; pass?: string } = {}

  constructor() {
    this.server = createServer((sock: Socket) => this.handle(sock))
  }

  private handle(sock: Socket): void {
    let buf = ''
    let inData = false
    let msg: { mailFrom?: string; rcptTo?: string; data: string } = { data: '' }
    let authStep: 'user' | 'pass' | null = null
    sock.write('220 fake ESMTP\r\n')
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      let i: number
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 2)
        if (inData) {
          if (line === '.') {
            inData = false
            this.received.push(msg)
            msg = { data: '' }
            sock.write('250 OK queued\r\n')
          } else {
            // undo dot-stuffing, as a real server does
            msg.data += (line.startsWith('..') ? line.slice(1) : line) + '\n'
          }
          continue
        }
        if (authStep) {
          const decoded = Buffer.from(line, 'base64').toString('utf8')
          if (authStep === 'user') {
            this.authSeen.user = decoded
            authStep = 'pass'
            sock.write('334 UGFzc3dvcmQ6\r\n')
          } else {
            this.authSeen.pass = decoded
            authStep = null
            sock.write('235 authenticated\r\n')
          }
          continue
        }
        const cmd = line.toUpperCase()
        if (cmd.startsWith('EHLO') || cmd.startsWith('HELO')) {
          sock.write('250-fake\r\n250-AUTH LOGIN PLAIN\r\n250 OK\r\n')
        } else if (cmd.startsWith('AUTH PLAIN')) {
          // one-shot form: base64 of "\0user\0pass"
          const b64 = line.slice('AUTH PLAIN'.length).trim()
          const [, user, pass] = Buffer.from(b64, 'base64').toString('utf8').split('\0')
          this.authSeen = { user, pass }
          sock.write('235 authenticated\r\n')
        } else if (cmd.startsWith('AUTH LOGIN')) {
          authStep = 'user'
          sock.write('334 VXNlcm5hbWU6\r\n')
        } else if (cmd.startsWith('MAIL FROM')) {
          msg.mailFrom = line.slice(line.indexOf(':') + 1).trim()
          sock.write('250 OK\r\n')
        } else if (cmd.startsWith('RCPT TO')) {
          msg.rcptTo = line.slice(line.indexOf(':') + 1).trim()
          sock.write('250 OK\r\n')
        } else if (cmd === 'DATA') {
          inData = true
          sock.write('354 end with .\r\n')
        } else if (cmd === 'QUIT') {
          sock.write('221 bye\r\n')
          sock.end()
        } else {
          sock.write('250 OK\r\n')
        }
      }
    })
    sock.on('error', () => {})
  }

  listen(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        this.port = (this.server.address() as { port: number }).port
        resolve()
      })
    })
  }
  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()))
  }
}

describe('SmtpMailer', () => {
  let smtp: FakeSmtp

  beforeAll(async () => {
    smtp = new FakeSmtp()
    await smtp.listen()
  })
  afterAll(async () => {
    await smtp.close()
  })

  it('delivers a message over a real SMTP conversation', async () => {
    const mailer = new SmtpMailer({
      host: '127.0.0.1',
      port: smtp.port,
      user: 'someone',
      pass: 'secret',
      adminEmail: 'noreply@acme.com',
      senderName: 'Acme',
      secure: false,
    })
    await mailer.send({
      to: 'user@example.com',
      subject: 'Reset your password',
      text: 'Reset here: https://acme.com/reset?token=abc',
      html: '<a href="https://acme.com/reset?token=abc">Reset</a>',
    })

    expect(smtp.received).toHaveLength(1)
    const got = smtp.received[0]
    expect(got.mailFrom).toBe('<noreply@acme.com>')
    expect(got.rcptTo).toBe('<user@example.com>')
    expect(got.data).toContain('Subject: Reset your password')
    expect(got.data).toContain('Acme <noreply@acme.com>')
    // both parts travel, so a text-only client still gets the link
    expect(got.data.toLowerCase()).toContain('multipart/alternative')
    expect(smtp.authSeen).toEqual({ user: 'someone', pass: 'secret' })
  })

  it('sends the bare address when no sender name is configured', () => {
    const m = new SmtpMailer({ host: 'h', port: 587, adminEmail: 'noreply@acme.com' })
    expect(m.from).toBe('noreply@acme.com')
  })

  it('formats the sender name into the from header', () => {
    const m = new SmtpMailer({ host: 'h', port: 587, adminEmail: 'noreply@acme.com', senderName: 'Acme' })
    expect(m.from).toBe('Acme <noreply@acme.com>')
  })

  it('refuses a configuration that could not possibly send', () => {
    // caught at construction, i.e. at startup, rather than on the first
    // password reset a user asks for
    expect(() => new SmtpMailer({ host: '', port: 587, adminEmail: 'a@b.com' })).toThrow(/host/)
    expect(() => new SmtpMailer({ host: 'h', port: 587, adminEmail: '' })).toThrow(/admin_email/)
    expect(() => new SmtpMailer({ host: 'h', port: 0, adminEmail: 'a@b.com' })).toThrow(/port/)
  })

  it('surfaces a connection failure to the caller', async () => {
    const mailer = new SmtpMailer({ host: '127.0.0.1', port: 1, adminEmail: 'a@b.com', secure: false })
    await expect(mailer.send({ to: 'x@y.com', subject: 's', text: 't' })).rejects.toThrow()
  })
})
