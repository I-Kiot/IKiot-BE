/** A staff member's personal details: stored flat in `profile_*` columns and answered nested, because the dashboard reads `user.profile.firstName`. Read side only. */

/** The flat columns this maps. Structural, so any `select` carrying them satisfies it. */
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

/** Swaps the `profile*` columns for one nested `profile` object. */
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
