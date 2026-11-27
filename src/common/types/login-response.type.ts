/** Phần response đăng nhập mà AuditInterceptor đọc. */
export interface AuditableLoginResponse {
  accessToken: string;
  /** Khai báo để `satisfies` không báo thừa trường. */
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
