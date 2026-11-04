import { Module } from '@nestjs/common';
import { FirebaseService } from './firebase.service';

/** Firebase Admin app dùng chung - một module để `initializeApp` chỉ có đúng một caller, được inject vào `/auth/firebase-login` và PushService. */
@Module({
  providers: [FirebaseService],
  exports: [FirebaseService],
})
export class FirebaseModule {}
