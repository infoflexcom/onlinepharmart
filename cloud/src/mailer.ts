import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import { connect as netConnect, type Socket } from 'node:net'
import type { SmtpConfig } from './config'

/**
 * A deliberately small SMTP sender — enough for "your licence expires in seven days" and nothing else.
 *
 * Pulling in a full mail library would add a dependency, a parser and an attachment surface for the sake of
 * two message kinds; the vendor's own mail host is a plain one. Everything is written as plain text (no HTML
 * e-mail, no tracking pixels) and every address is refused if it contains a newline, which is the whole of
 * header injection.
 *
 * When SMTP is not configured the server passes `null` around instead of a sender, and the portal says so
 * rather than silently swallowing mail.
 */
export interface Mailer {
  send(to: string, subject: string, body: string): Promise<boolean>
}

const MAX_MESSAGE_BYTES = 64 * 1024

export function createMailer(config: SmtpConfig): Mailer {
  return {
    async send(to: string, subject: string, body: string): Promise<boolean> {
      try {
        const recipient = singleAddress(to)
        const message = buildMessage(config, recipient, subject, body)
        if (Buffer.byteLength(message, 'utf8') > MAX_MESSAGE_BYTES) return false
        await deliver(config, recipient, message)
        return true
      } catch {
        // A failed reminder must never break the page the vendor is looking at; the audit log records it.
        return false
      }
    },
  }
}

function buildMessage(config: SmtpConfig, recipient: string, subject: string, body: string): string {
  const sender = singleAddress(config.from)
  const headers = [
    `From: ${sender}`,
    `To: ${recipient}`,
    `Subject: ${cleanHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
  ]
  // Dot-stuffing: a line that starts with "." would otherwise end the DATA section early.
  const lines = body.replace(/\r\n/gu, '\n').split('\n').map((line) => (line.startsWith('.') ? `.${line}` : line))
  return `${headers.join('\r\n')}\r\n\r\n${lines.join('\r\n')}\r\n`
}

function singleAddress(value: string): string {
  const text = String(value ?? '').trim()
  if (!text || /[\r\n<>]/u.test(text)) throw new Error('Invalid email address')
  return text
}

function cleanHeader(value: string): string {
  return String(value ?? '').replace(/[\r\n]+/gu, ' ').slice(0, 200)
}

async function deliver(config: SmtpConfig, recipient: string, message: string): Promise<void> {
  const socket: Socket | TLSSocket = config.secure
    ? tlsConnect({ host: config.host, port: config.port, servername: config.host })
    : netConnect({ host: config.host, port: config.port })

  const session = new SmtpSession(socket)
  await session.open()
  try {
    await session.expect(220)
    const name = 'infoflex-cloud.local'
    await session.command(`EHLO ${name}`, 250)
    if (!config.secure) {
      // STARTTLS is preferred whenever the server offers it; a plain host without it is still allowed, because
      // a vendor running mail on their own LAN should not be blocked, but the config documents the risk.
      const features = session.lastReply.join('\n').toUpperCase()
      if (features.includes('STARTTLS')) {
        await session.command('STARTTLS', 220)
        await session.upgrade(config.host)
        await session.command(`EHLO ${name}`, 250)
      }
    }
    if (config.user) {
      await session.command('AUTH LOGIN', 334)
      await session.command(Buffer.from(config.user, 'utf8').toString('base64'), 334)
      await session.command(Buffer.from(config.password, 'utf8').toString('base64'), 235)
    }
    await session.command(`MAIL FROM:<${singleAddress(config.from)}>`, 250)
    await session.command(`RCPT TO:<${recipient}>`, [250, 251])
    await session.command('DATA', 354)
    await session.command(`${message}\r\n.`, 250)
    await session.command('QUIT', 221, { optional: true })
  } finally {
    session.close()
  }
}

interface CommandOptions { optional?: boolean }

/**
 * A line-oriented SMTP client. Each command waits for a final reply (a three-digit code followed by a space),
 * which is what keeps multi-line greetings and pipelined banners from being confused with an answer.
 */
class SmtpSession {
  private buffer = ''
  private pending: { resolve: () => void; reject: (error: Error) => void; codes: number[]; optional: boolean } | null = null
  lastReply: string[] = []

  constructor(private socket: Socket | TLSSocket) {
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      this.buffer += chunk
      this.drain()
    })
    socket.on('error', (error: Error) => this.fail(error))
    socket.on('close', () => this.fail(new Error('The mail server closed the connection.')))
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The mail server did not answer in time.')), 15_000)
      this.socket.once('connect', () => {
        clearTimeout(timer)
        resolve()
      })
      this.socket.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
    })
  }

  upgrade(servername: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const upgraded = tlsConnect({ socket: this.socket as Socket, servername }, () => resolve())
      upgraded.on('error', reject)
      this.socket = upgraded
      this.socket.setEncoding('utf8')
      this.socket.on('data', (chunk: string) => {
        this.buffer += chunk
        this.drain()
      })
    })
  }

  expect(...codes: number[]): Promise<void> {
    return this.wait(codes, false)
  }

  async command(text: string, codes: number | number[], options: CommandOptions = {}): Promise<void> {
    const accepted = Array.isArray(codes) ? codes : [codes]
    this.socket.write(`${text}\r\n`)
    await this.wait(accepted, options.optional === true)
  }

  close(): void {
    this.socket.destroy()
  }

  private wait(codes: number[], optional: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject, codes, optional }
      this.drain()
    })
  }

  private fail(error: Error): void {
    const pending = this.pending
    this.pending = null
    if (pending) {
      if (pending.optional) pending.resolve()
      else pending.reject(error)
    }
  }

  private drain(): void {
    // Replies are "<code><space>text" for the last line and "<code>-text" for continuation lines.
    let index = this.buffer.indexOf('\n')
    while (index !== -1) {
      const line = this.buffer.slice(0, index).replace(/\r$/u, '')
      this.buffer = this.buffer.slice(index + 1)
      this.lastReply.push(line)
      const continued = line.length > 3 && line[3] === '-'
      if (!continued) {
        const code = Number(line.slice(0, 3))
        const pending = this.pending
        this.pending = null
        this.buffer = ''
        if (!pending) return
        if (pending.optional || pending.codes.includes(code)) pending.resolve()
        else pending.reject(new Error(`The mail server refused a step (${line.slice(0, 160)}).`))
        return
      }
      index = this.buffer.indexOf('\n')
    }
  }
}
