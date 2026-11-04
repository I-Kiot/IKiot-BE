import { Injectable, Logger } from '@nestjs/common';
import { App, cert, getApps, initializeApp } from 'firebase-admin/app';
import { DecodedIdToken, getAuth } from 'firebase-admin/auth';
import { getMessaging, Messaging } from 'firebase-admin/messaging';

/** Firebase Admin, port từ config/firebase.js của iKiotMS-BE: khởi tạo lazy, chỉ cảnh báo một lần, và khi thiếu FIREBASE_* thì coi như "chưa cấu hình" thay vì crash. */
@Injectable()
export class FirebaseService {
  private readonly logger = new Logger(FirebaseService.name);
  private app: App | null = null;
  private initAttempted = false;

  private getApp(): App | null {
    if (this.initAttempted) return this.app;
    this.initAttempted = true;

    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY;

    if (!projectId || !clientEmail || !privateKey) {
      this.logger.warn(
        'Firebase Admin not configured (missing FIREBASE_* env vars). Firebase login is disabled.',
      );
      return null;
    }

    this.app =
      getApps()[0] ??
      initializeApp({
        credential: cert({
          projectId,
          clientEmail,
          privateKey: privateKey.replace(/\\n/g, '\n'),
        }),
      });
    this.logger.log('Firebase Admin initialized');
    return this.app;
  }

  isConfigured(): boolean {
    return this.getApp() !== null;
  }

  async verifyIdToken(idToken: string): Promise<DecodedIdToken> {
    const app = this.getApp();
    if (!app) throw new Error('Firebase Admin is not configured');
    return getAuth(app).verifyIdToken(idToken);
  }

  /** FCM sender, hoặc null khi Firebase chưa có credential. Push chỉ là kênh phụ, không được làm hỏng thao tác đã kích hoạt nó - khác với đăng nhập. */
  messaging(): Messaging | null {
    const app = this.getApp();
    return app ? getMessaging(app) : null;
  }
}
