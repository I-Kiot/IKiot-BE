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

export interface FlatLeaveBalance {
  leaveBalanceAnnualDays?: number | null;
  leaveBalanceRemainingDays?: number | null;
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

/** Swaps the `profile*` columns for one nested `profile` object, and the `leaveBalance*` pair likewise when the row carries them. */
export function withNestedProfile<T extends FlatUserProfile>(
  row: T,
): Omit<T, keyof FlatUserProfile | keyof FlatLeaveBalance> & {
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

  const {
    leaveBalanceAnnualDays,
    leaveBalanceRemainingDays,
    ...withoutBalance
  } = rest as typeof rest & FlatLeaveBalance;

  return {
    ...(withoutBalance as Omit<
      T,
      keyof FlatUserProfile | keyof FlatLeaveBalance
    >),
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
    // Only when the caller selected it: an always-null key would read as "they have no allowance".
    ...(leaveBalanceAnnualDays === undefined &&
    leaveBalanceRemainingDays === undefined
      ? {}
      : {
          leaveBalance: {
            annualLeaveDays: leaveBalanceAnnualDays ?? 0,
            remainingDays: leaveBalanceRemainingDays ?? 0,
          },
        }),
  };
}
