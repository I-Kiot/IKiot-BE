import { Injectable, Logger } from '@nestjs/common';
import { createTransport, Transporter } from 'nodemailer';
import { VIETNAM_TIMEZONE } from '../constants/timezone';

interface SubscriptionReminderData {
  tenantName: string;
  planName: string;
  daysLeft: number;
  endDate: Date;
}

interface AnnouncementData {
  title: string;
  description: string;
  category: string;
}

// Ported from iKiotMS-BE's emailService.js; both senders keep the original HTML and swallow their own failures.
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private transporter: Transporter | null = null;

  private getTransporter(): Transporter {
    if (!this.transporter) {
      this.transporter = createTransport({
        host: process.env.MAIL_HOST,
        port: Number(process.env.MAIL_PORT) || 587,
        secure: process.env.MAIL_PORT === '465',
        auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS },
      });
    }
    return this.transporter;
  }

  async sendSubscriptionReminder(
    to: string,
    data: SubscriptionReminderData,
  ): Promise<void> {
    if (!process.env.MAIL_HOST || !process.env.MAIL_USER) {
      this.logger.warn('MAIL_HOST/MAIL_USER not configured, skipping email');
      return;
    }

    const formattedDate = data.endDate.toLocaleDateString('vi-VN', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      timeZone: VIETNAM_TIMEZONE,
    });

    const subject =
      data.daysLeft === 1
        ? `[iKiot] Gói ${data.planName} của bạn sẽ hết hạn vào NGÀY MAI`
        : `[iKiot] Gói ${data.planName} của bạn sẽ hết hạn sau ${data.daysLeft} ngày`;

    try {
      await this.getTransporter().sendMail({
        from: `"iKiot" <${process.env.MAIL_FROM || process.env.MAIL_USER}>`,
        to,
        subject,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto;">
            <h2 style="color: #1a1a1a;">Nhắc nhở gia hạn dịch vụ</h2>
            <p>Xin chào <strong>${data.tenantName}</strong>,</p>
            <p>
              Gói dịch vụ <strong>${data.planName}</strong> của bạn sẽ hết hạn vào ngày
              <strong>${formattedDate}</strong>
              ${data.daysLeft === 1 ? '(ngày mai)' : `(còn ${data.daysLeft} ngày)`}.
            </p>
            <p>Vui lòng đăng nhập vào hệ thống và gia hạn để tiếp tục sử dụng đầy đủ tính năng mà không bị gián đoạn.</p>
            <p style="color: #666; font-size: 13px;">Nếu bạn đã gia hạn, vui lòng bỏ qua email này.</p>
            <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
            <p style="color: #999; font-size: 12px;">Trân trọng,<br/>Đội ngũ iKiot</p>
          </div>
        `,
      });
    } catch (error) {
      // A reminder email failing must never break the cron run for the other tenants.
      this.logger.error(
        `Failed to send subscription reminder to ${to}`,
        error instanceof Error ? error.stack : error,
      );
    }
  }

  /** One operator-composed announcement to one shop owner; `category` is free text that lands in the subject line. */
  async sendSystemNotificationEmail(
    to: string,
    data: AnnouncementData,
  ): Promise<void> {
    if (!process.env.MAIL_HOST || !process.env.MAIL_USER) {
      this.logger.warn('MAIL_HOST/MAIL_USER not configured, skipping email');
      return;
    }

    try {
      await this.getTransporter().sendMail({
        from: `"iKiot Admin" <${process.env.MAIL_FROM || process.env.MAIL_USER}>`,
        to,
        subject: `[iKiot System - ${data.category}] ${data.title}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 8px; padding: 24px;">
            <h2 style="color: #0f172a; border-bottom: 2px solid #e2e8f0; padding-bottom: 12px; margin-top: 0;">Thông báo từ hệ thống iKiot</h2>
            <p style="font-size: 14px; color: #64748b; margin-top: 4px;">Danh mục: <strong>${data.category}</strong></p>
            <div style="background-color: #f8fafc; border-left: 4px solid #3b82f6; padding: 16px; margin: 20px 0; border-radius: 4px;">
              <h3 style="color: #1e293b; margin: 0 0 8px 0;">${data.title}</h3>
              <p style="color: #334155; line-height: 1.5; margin: 0; font-size: 15px;">${data.description}</p>
            </div>
            <p style="color: #64748b; font-size: 13px;">
              Đây là email tự động thông báo từ ban quản trị hệ thống iKiot. Vui lòng không trả lời trực tiếp email này.
            </p>
            <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
            <p style="color: #94a3b8; font-size: 12px;">
              Trân trọng,<br/>Đội ngũ iKiot Admin
            </p>
          </div>
        `,
      });
    } catch (error) {
      // One bad address must not stop the batch - the caller doesn't await, so a rejection would go unhandled.
      this.logger.error(
        `Failed to send announcement email to ${to}`,
        error instanceof Error ? error.stack : error,
      );
    }
  }
}
