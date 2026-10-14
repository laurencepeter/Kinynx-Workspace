/**
 * Email provider abstraction.
 *
 * One interface, several drivers, chosen by EMAIL_DRIVER:
 *   - console : logs the email (default; zero-config for dev/self-host trials)
 *   - smtp    : any SMTP provider via nodemailer — Mailjet, SendGrid, Postmark,
 *               Amazon SES, Gmail, Mailgun, your own server. "Ease of setup"
 *               means: set 4 env vars and go.
 *   - mailjet : Mailjet Send API v3.1 (REST) for those who prefer API keys.
 *
 * Adding a provider = adding a driver here; nothing else in the app changes.
 */
import type { Config } from "../config.js";

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<void>;
}

class ConsoleProvider implements EmailProvider {
  readonly name = "console";
  async send(message: EmailMessage): Promise<void> {
    console.log(
      `\n──── EMAIL (console driver) ────\nTo: ${message.to}\nSubject: ${message.subject}\n${
        message.text ?? message.html
      }\n────────────────────────────────\n`,
    );
  }
}

class SmtpProvider implements EmailProvider {
  readonly name = "smtp";
  private transport: import("nodemailer").Transporter | null = null;
  constructor(private readonly config: Config) {}

  private async getTransport() {
    if (!this.transport) {
      const nodemailer = await import("nodemailer");
      this.transport = nodemailer.createTransport({
        host: this.config.SMTP_HOST,
        port: this.config.SMTP_PORT,
        secure: this.config.SMTP_PORT === 465,
        auth:
          this.config.SMTP_USER && this.config.SMTP_PASS
            ? { user: this.config.SMTP_USER, pass: this.config.SMTP_PASS }
            : undefined,
      });
    }
    return this.transport;
  }

  async send(message: EmailMessage): Promise<void> {
    const transport = await this.getTransport();
    await transport.sendMail({
      from: this.config.EMAIL_FROM,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
  }
}

class MailjetProvider implements EmailProvider {
  readonly name = "mailjet";
  constructor(private readonly config: Config) {}

  async send(message: EmailMessage): Promise<void> {
    const auth = Buffer.from(
      `${this.config.MAILJET_API_KEY}:${this.config.MAILJET_SECRET_KEY}`,
    ).toString("base64");
    const [fromName, fromEmail] = parseFrom(this.config.EMAIL_FROM);
    const res = await fetch("https://api.mailjet.com/v3.1/send", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Basic ${auth}` },
      body: JSON.stringify({
        Messages: [
          {
            From: { Email: fromEmail, Name: fromName },
            To: [{ Email: message.to }],
            Subject: message.subject,
            HTMLPart: message.html,
            TextPart: message.text ?? stripHtml(message.html),
          },
        ],
      }),
    });
    if (!res.ok) {
      throw new Error(`mailjet send failed: ${res.status} ${await res.text().catch(() => "")}`);
    }
  }
}

function parseFrom(from: string): [string, string] {
  const match = from.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/);
  return match ? [match[1]!.trim(), match[2]!.trim()] : ["Kinynx", from];
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

export function createEmailProvider(config: Config): EmailProvider {
  switch (config.EMAIL_DRIVER) {
    case "smtp":
      return new SmtpProvider(config);
    case "mailjet":
      return new MailjetProvider(config);
    default:
      return new ConsoleProvider();
  }
}
