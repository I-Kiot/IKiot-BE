import { BadRequestException } from '@nestjs/common';
import { ErrorCode } from '../../common/errors/error-codes';

/** Đầu số di động thực tế được cấp ở Việt Nam sau đợt đổi số 2018: Viettel 03x, Vietnamobile 05x, Mobifone 07x, Vinaphone 08x và dải 09x cũ. */
const VIETNAM_MOBILE_PHONE_REGEX =
  /^(?:03[2-9]|05[25689]|07[06789]|08[1-9]|09\d)\d{7}$/;

/** Các dải trông như số di động nhưng không bao giờ là số di động. Mỗi dải có message riêng, vì "số không hợp lệ" vô nghĩa khi đó là một đường dây đang hoạt động. */
const RESERVED_RANGES: readonly { pattern: RegExp; reason: string }[] = [
  {
    pattern: /^065\d{7}$/,
    reason:
      'The 065 prefix is reserved for internet telephony (VoIP) and cannot be an employee mobile number',
  },
  {
    pattern: /^067\d{7}$/,
    reason:
      'The 067 prefix is reserved for satellite telephony (VSAT) and cannot be an employee mobile number',
  },
  {
    pattern: /^069[2-9]\d{6}$/,
    reason:
      'The 069 prefix is reserved for government, police and military private networks and cannot be an employee mobile number',
  },
  {
    pattern: /^080\d{7}$/,
    reason:
      'The 080 prefix is reserved for the Central Post Office and cannot be an employee mobile number',
  },
  {
    pattern: /^111$/,
    reason:
      '111 is the national child protection hotline and cannot be an employee mobile number',
  },
  {
    pattern: /^112$/,
    reason:
      '112 is the emergency rescue and search hotline and cannot be an employee mobile number',
  },
  {
    pattern: /^113$/,
    reason:
      '113 is the police emergency number and cannot be an employee mobile number',
  },
  {
    pattern: /^114$/,
    reason:
      '114 is the fire and rescue emergency number and cannot be an employee mobile number',
  },
  {
    pattern: /^115$/,
    reason:
      '115 is the medical emergency number and cannot be an employee mobile number',
  },
];

/** Kiểm tra số di động cho tài khoản nhân viên. Số điện thoại là login và nơi nhận OTP, nên số không nhận được SMS sẽ tạo ra tài khoản không ai vào được. Trả về số đã trim. */
export function validateVietnamPhoneNumber(phoneNumber: string): string {
  const value = phoneNumber.trim();

  if (!value) {
    throw new BadRequestException({
      code: ErrorCode.PHONE_REQUIRED,
      message: 'The phone number is required',
    });
  }

  // Cố ý kiểm tra trước quy tắc định dạng: số khẩn cấp chỉ có 3 chữ số, nếu "phải đủ 10 số" chạy trước thì báo lỗi vô nghĩa.
  const reserved = RESERVED_RANGES.find(({ pattern }) => pattern.test(value));
  if (reserved)
    throw new BadRequestException({
      code: ErrorCode.PHONE_RESERVED_RANGE,
      message: reserved.reason,
    });

  if (!/^\d{10}$/.test(value)) {
    throw new BadRequestException({
      code: ErrorCode.PHONE_LENGTH_INVALID,
      message: 'The phone number must be exactly 10 digits',
    });
  }
  if (!VIETNAM_MOBILE_PHONE_REGEX.test(value)) {
    throw new BadRequestException({
      code: ErrorCode.PHONE_PREFIX_INVALID,
      message: 'This is not a valid Vietnamese mobile prefix',
    });
  }

  return value;
}
