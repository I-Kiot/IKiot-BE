/** The part of a login response AuditInterceptor reads; AuthService declares it via `satisfies`, so changing the response is a build error rather than a blank audit row. */
export interface AuditableLoginResponse {
  accessToken: string;
  /** Not read by the interceptor, but `satisfies` excess-property-checks the literal, so every returned key has to be declared. */
  refreshToken: string;
  user: {
    id: string;
    email: string | null;
    phoneNumber: string;
    systemRole: string;
    tenantId: string | null;
    profile: { firstName: string | null; lastName: string | null };
  };
}
