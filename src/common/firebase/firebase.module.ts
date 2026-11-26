import { Module } from '@nestjs/common';
import { FirebaseService } from './firebase.service';

/** Module Firebase Admin dùng chung, khởi tạo đúng một lần. */
@Module({
  providers: [FirebaseService],
  exports: [FirebaseService],
})
export class FirebaseModule {}
