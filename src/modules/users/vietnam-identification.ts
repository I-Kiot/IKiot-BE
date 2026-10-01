import { BadRequestException } from '@nestjs/common';
import { ErrorCode } from '../../common/errors/error-codes';

/** The three-digit province-of-birth prefixes a Vietnamese citizen ID may start with, ported verbatim from StaffIdentificationValidator. */
// prettier-ignore
export const VIETNAM_PROVINCE_CODES: ReadonlySet<string> = new Set([
  '001', '002', '004', '006', '008', '010', '011', '012', '014',
  '015', '017', '019', '020', '022', '024', '025', '026', '027',
  '030', '031', '033', '034', '035', '036', '037', '038', '040',
  '042', '044', '045', '046', '048', '049', '051', '052', '054',
  '056', '058', '060', '062', '064', '066', '067', '068', '070',
  '072', '074', '075', '077', '079', '080', '082', '083', '084',
  '086', '087', '089', '091', '092', '093', '094', '095', '096',
]);

/** Digit 4 encodes century *and* sex: even = male, odd = female, pair per century. */
function birthYearOf(centurySexCode: number, yearSuffix: string): number {
  return 1900 + Math.floor(centurySexCode / 2) * 100 + Number(yearSuffix);
}

/** Validates a 12-digit Vietnamese citizen ID and cross-checks it against the profile it is attached to: digits 1–3 are the province, digit 4 the century and sex, digits 5–6 the birth year - so a CCCD disagreeing with `dob` or `gender` means one of them was typed wrong, which is worth catching before payroll and social-insurance exports trust all three. Returns the trimmed, normalised number. */
export function validateVietnamIdentificationId(
  identificationId: string,
  profile: { dob?: Date | string | null; gender?: string | null } = {},
): string {
  const value = identificationId.trim();

  if (!value) {
    throw new BadRequestException({
      code: ErrorCode.IDENTIFICATION_REQUIRED,
      message: 'The citizen ID is required',
    });
  }
  if (!/^\d+$/.test(value)) {
    throw new BadRequestException({
      code: ErrorCode.IDENTIFICATION_NOT_NUMERIC,
      message: 'The citizen ID may contain digits only',
    });
  }
  if (value.length !== 12) {
    throw new BadRequestException({
      code: ErrorCode.IDENTIFICATION_LENGTH_INVALID,
      message: 'The citizen ID must be exactly 12 digits',
    });
  }
  if (!VIETNAM_PROVINCE_CODES.has(value.slice(0, 3))) {
    throw new BadRequestException({
      code: ErrorCode.IDENTIFICATION_PROVINCE_INVALID,
      message: 'The province code on the citizen ID is not valid',
    });
  }

  const centurySexCode = Number(value[3]);
  const birthYear = birthYearOf(centurySexCode, value.slice(4, 6));

  if (profile.dob !== undefined && profile.dob !== null && profile.dob !== '') {
    const dob = new Date(profile.dob);
    if (Number.isNaN(dob.getTime())) {
      throw new BadRequestException({
        code: ErrorCode.IDENTIFICATION_DOB_INVALID,
        message: 'The date of birth is not valid',
      });
    }
    if (dob.getUTCFullYear() !== birthYear) {
      throw new BadRequestException({
        code: ErrorCode.IDENTIFICATION_YEAR_MISMATCH,
        message:
          'The birth year on the citizen ID does not match the date of birth',
      });
    }
  }

  if (profile.gender === 'MALE' && centurySexCode % 2 !== 0) {
    throw new BadRequestException({
      code: ErrorCode.IDENTIFICATION_GENDER_MISMATCH,
      message: 'The sex on the citizen ID does not match the employee record',
    });
  }
  if (profile.gender === 'FEMALE' && centurySexCode % 2 !== 1) {
    throw new BadRequestException({
      code: ErrorCode.IDENTIFICATION_GENDER_MISMATCH,
      message: 'The sex on the citizen ID does not match the employee record',
    });
  }

  return value;
}
