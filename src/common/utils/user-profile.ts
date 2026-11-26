/** Trả thông tin cá nhân nhân viên dạng lồng trong `profile`. */

/** Các cột phẳng được map. Kiểu structural nên select nào có đủ các cột này đều khớp. */
export interface FlatUserProfile {
  profileFirstName?: string | null;
  profileLastName?: string | null;
  profileAvatarUrl?: string | null;
  profileDob?: Date | null;
  profileTaxNumber?: string | null;
  profileIdentificationId?: string | null;
  profileAddress?: string | null;
  profileGender?: string | null;
}

export interface NestedUserProfile {
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
  dob: Date | null;
  taxNumber: string | null;
  identificationId: string | null;
  address: string | null;
  gender: string | null;
}

/** Đổi các cột `profile*` thành một object `profile` lồng nhau. */
export function withNestedProfile<T extends FlatUserProfile>(
  row: T,
): Omit<T, keyof FlatUserProfile> & {
  profile: NestedUserProfile;
} {
  const {
    profileFirstName,
    profileLastName,
    profileAvatarUrl,
    profileDob,
    profileTaxNumber,
    profileIdentificationId,
    profileAddress,
    profileGender,
    ...rest
  } = row;

  return {
    ...rest,
    profile: {
      firstName: profileFirstName ?? null,
      lastName: profileLastName ?? null,
      avatarUrl: profileAvatarUrl ?? null,
      dob: profileDob ?? null,
      taxNumber: profileTaxNumber ?? null,
      identificationId: profileIdentificationId ?? null,
      address: profileAddress ?? null,
      gender: profileGender ?? null,
    },
  };
}

/** Họ tên kiểu Việt ("Ngô Văn Tài"); chưa có phần nào thì null. */
export function profileFullName(
  row: {
    profileLastName?: string | null;
    profileFirstName?: string | null;
  } | null,
): string | null {
  if (!row) return null;
  return (
    [row.profileLastName, row.profileFirstName]
      .filter((part) => part && part.trim())
      .join(' ')
      .trim() || null
  );
}

/** Tên hiển thị: họ tên, chưa có thì số điện thoại. */
export function personName(row: {
  profileLastName?: string | null;
  profileFirstName?: string | null;
  phoneNumber: string;
}): string {
  return profileFullName(row) ?? row.phoneNumber;
}
