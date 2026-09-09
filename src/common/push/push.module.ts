import { Module } from '@nestjs/common';
import { PushService } from './push.service';
import { FirebaseModule } from '../firebase/firebase.module';

@Module({
  imports: [FirebaseModule],
  providers: [PushService],
  exports: [PushService],
})
export class PushModule {}
