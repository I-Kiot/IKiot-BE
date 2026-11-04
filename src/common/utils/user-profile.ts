/** Thông tin cá nhân nhân viên: lưu phẳng trong các cột `profile_*` nhưng trả về lồng nhau, vì dashboard đọc `user.profile.firstName`. Chỉ phía đọc. */

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
