import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

// eSMS SendMultipleMessage V4 (JSON) endpoint - ported 1:1 from iKiotMS-BE's esmsService.js.
const ESMS_ENDPOINT =
  'https://rest.esms.vn/MainService.svc/json/SendMultipleMessage_V4_post_json/';

interface EsmsResponse {
  CodeResult?: string;
  ErrorMessage?: string;
  SMSID?: string;
}

@Injectable()
export class EsmsService {
  private readonly logger = new Logger(EsmsService.name);

  isConfigured(): boolean {
    return Boolean(process.env.ESMS_API_KEY && process.env.ESMS_SECRET_KEY);
  }

  /** Converts any VN phone form (+84…, 84…, 0…) to the local 0-prefixed form eSMS expects. */
  toLocalVN(phone: string): string {
    const p = String(phone || '')
      .trim()
      .replace(/[\s\-().]/g, '');
    if (p.startsWith('+84')) return '0' + p.slice(3);
    if (p.startsWith('84')) return '0' + p.slice(2);
    return p;
  }

  private buildContent(code: string): string {
    const brandname = process.env.ESMS_BRANDNAME || 'Baotrixemay';
    return `${code} la ma xac minh dang ky ${brandname} cua ban`;
  }

  async sendOtpSms(phone: string, code: string): Promise<{ smsId?: string }> {
    const payload = {
      ApiKey: process.env.ESMS_API_KEY,
      SecretKey: process.env.ESMS_SECRET_KEY,
      Phone: this.toLocalVN(phone),
      Content: this.buildContent(code),
      Brandname: process.env.ESMS_BRANDNAME || 'Baotrixemay',
      SmsType: '2',
      IsUnicode: '0',
      RequestId: randomUUID(),
    };

    const res = await fetch(ESMS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = (await res.json().catch(() => ({}))) as EsmsResponse;

    if (!res.ok || String(data.CodeResult) !== '100') {
      this.logger.error(
        `eSMS send failed (CodeResult=${data.CodeResult ?? '?'})`,
      );
      throw new Error(
        `eSMS send failed (CodeResult=${data.CodeResult ?? '?'}${data.ErrorMessage ? `: ${data.ErrorMessage}` : ''})`,
      );
    }

    return { smsId: data.SMSID };
  }
}
