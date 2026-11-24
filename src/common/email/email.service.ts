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

// Port từ emailService.js của iKiotMS-BE; cả hai hàm gửi giữ nguyên HTML gốc và tự nuốt lỗi của mình.
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

  /** MAIL_* đã đủ để gửi thật chưa. */
  isConfigured(): boolean {
    return Boolean(process.env.MAIL_HOST && process.env.MAIL_USER);
  }

  /** Gửi mã OTP. Khác hai hàm gửi còn lại: KHÔNG nuốt lỗi, vì người dùng đang chờ mã và caller phải trả 503 thay vì báo "đã gửi". */
  async sendOtpEmail(
    to: string,
    code: string,
    opts: { purpose: 'verify-email' | 'reset-password'; ttlMinutes: number },
  ): Promise<void> {
    const reset = opts.purpose === 'reset-password';
    const subject = reset
      ? `[iKiot] Mã đặt lại mật khẩu: ${code}`
      : `[iKiot] Mã xác minh tài khoản: ${code}`;
    const intro = reset
      ? 'Bạn vừa yêu cầu đặt lại mật khẩu iKiot.'
      : 'Bạn vừa đăng ký hoặc đăng nhập tài khoản iKiot.';
    const text = [
      intro,
      `Mã xác minh của bạn: ${code}`,
      `Mã có hiệu lực trong ${opts.ttlMinutes} phút và chỉ dùng được một lần.`,
      'Không chia sẻ mã này cho bất kỳ ai, kể cả nhân viên iKiot.',
      'Nếu không phải bạn yêu cầu, hãy bỏ qua email này.',
    ].join('\n');
    await this.getTransporter().sendMail({
      from: `"iKiot" <${process.env.MAIL_FROM || process.env.MAIL_USER}>`,
      to,
      subject,
      text,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto;">
          <h2 style="color: #1a1a1a;">${reset ? 'Đặt lại mật khẩu' : 'Xác minh tài khoản'}</h2>
          <p>${intro}</p>
          <p style="font-size: 32px; letter-spacing: 8px; font-weight: bold; margin: 24px 0;">${code}</p>
          <p>Mã có hiệu lực trong <strong>${opts.ttlMinutes} phút</strong> và chỉ dùng được một lần.</p>
          <p style="color: #666; font-size: 13px;">Không chia sẻ mã này cho bất kỳ ai, kể cả nhân viên iKiot. Nếu không phải bạn yêu cầu, hãy bỏ qua email này.</p>
          <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
          <p style="color: #999; font-size: 12px;">Trân trọng,<br/>Đội ngũ iKiot</p>
        </div>
      `,
    });
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
      // Email nhắc gia hạn lỗi không được làm hỏng lượt cron của các tenant khác.
      this.logger.error(
        `Failed to send subscription reminder to ${to}`,
        error instanceof Error ? error.stack : error,
      );
    }
  }

  /** Một thông báo do vận hành soạn, gửi cho một chủ shop; `category` là chữ tự do và nằm trong tiêu đề email. */
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
      // Một địa chỉ lỗi không được dừng cả đợt - người gọi không await, nên lỗi sẽ không được xử lý.
      this.logger.error(
        `Failed to send announcement email to ${to}`,
        error instanceof Error ? error.stack : error,
      );
    }
  }
}
