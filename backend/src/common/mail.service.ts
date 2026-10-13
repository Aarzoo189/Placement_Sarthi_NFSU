import { Injectable, Logger } from '@nestjs/common';
import { createTransport, Transporter } from 'nodemailer';
import { env } from '../config/env';

/**
 * Transactional e-mail: OTP codes, activation links, security alerts, deadline reminders.
 * Dev: SMTP goes to Mailpit (http://localhost:8025). Production: the university SMTP relay or a transactional service.
 * Mail failures never break the request that triggered them (an alert must not become a way to deny service).
 */
@Injectable()
export class MailService {
  private readonly log = new Logger('Mail');
  private readonly transport: Transporter = createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: false,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    connectionTimeout: 5000,
    greetingTimeout: 5000,
  });

  async send(to: string, subject: string, text: string): Promise<void> {
    try {
      await this.transport.sendMail({ from: env.MAIL_FROM, to, subject, text });
    } catch (err) {
      this.log.warn(`Could not send "${subject}" to ${to.replace(/(.).+(@.+)/, '$1***$2')}: ${(err as Error).message}`);
    }
  }
}
