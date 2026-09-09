import { Injectable, Logger } from '@nestjs/common';
import { App, cert, getApps, initializeApp } from 'firebase-admin/app';
import { DecodedIdToken, getAuth } from 'firebase-admin/auth';
import { getMessaging, Messaging } from 'firebase-admin/messaging';

/** Firebase Admin, ported from iKiotMS-BE's config/firebase.js: lazy init, warns once, and degrades to "not configured" instead of crashing when FIREBASE_* is unset. */
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

  /** The FCM sender, or null when Firebase has no credentials - push is a side-channel and must not fail the operation that triggered it, unlike login. */
  messaging(): Messaging | null {
    const app = this.getApp();
    return app ? getMessaging(app) : null;
  }
}
