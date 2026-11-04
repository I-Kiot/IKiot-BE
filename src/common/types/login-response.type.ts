/** Phần của response đăng nhập mà AuditInterceptor đọc; AuthService khai báo qua `satisfies`, nên đổi response sẽ thành lỗi build thay vì một dòng audit trống. */
export interface AuditableLoginResponse {
  accessToken: string;
  /** Interceptor không đọc trường này, nhưng `satisfies` kiểm tra excess property trên literal, nên mọi key trả về phải được khai báo. */
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
