import { Module } from '@nestjs/common';
import { FirebaseService } from './firebase.service';

/** The shared Firebase Admin app - one module so `initializeApp` has exactly one caller, injected by `/auth/firebase-login` and PushService. */
@Module({
  providers: [FirebaseService],
  exports: [FirebaseService],
})
export class FirebaseModule {}
