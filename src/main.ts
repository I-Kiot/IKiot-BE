// QUAN TRỌNG: `instrument.ts` (Sentry) phải được import ở dòng đầu tiên, trước mọi import khác.
import './instrument';

// Import đầu tiên có chủ đích: `validateEnv()` chạy trước khi ConfigModule đọc `.env`; dotenv không ghi đè biến môi trường thật.
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { corsOrigins, validateEnv } from './common/config/env';

async function bootstrap() {
  // Deploy thiếu JWT_SECRET phải lỗi ngay tại đây, không phải ở lần đăng nhập đầu tiên sau khi load balancer đã chuyển traffic.
  validateEnv();

  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // PrismaService và RedisService implement OnModuleDestroy; thiếu dòng này Nest không lắng nghe SIGTERM mà mỗi lần deploy đều gửi.
  app.enableShutdownHooks();

  // Express bỏ qua X-Forwarded-For nếu chưa bảo tin proxy, mà AuditInterceptor ghi đúng header này. TRUST_PROXY là số hop; không đặt nghĩa là không có proxy.
  const trustProxy = process.env.TRUST_PROXY?.trim();
  app.set('trust proxy', trustProxy ? Number(trustProxy) : false);

  app.use(
    helmet({
      // Swagger UI ở /docs được inline nên CSP mặc định sẽ chặn; các directive này là riêng cho helmet + Swagger.
      contentSecurityPolicy: {
        directives: {
          defaultSrc: [`'self'`],
          styleSrc: [`'self'`, `'unsafe-inline'`],
          imgSrc: [`'self'`, 'data:', 'validator.swagger.io'],
          scriptSrc: [`'self'`, `https: 'unsafe-inline'`],
        },
      },
    }),
  );

  app.enableCors({
    origin: corsOrigins(),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter());

  const config = new DocumentBuilder()
    .setTitle('iKiotMS API')
    .setDescription(
      'NestJS/Prisma rewrite of iKiotMS-BE - see CLAUDE.md for scope and what is still unported.',
    )
    .setVersion('0.1')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      'bearer',
    )
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document);
  // Mount cả hai đường dẫn vì iKiotMS-BE luôn phục vụ docs ở /api-docs; việc chặn công khai là quyết định riêng, không thuộc phần port.
  SwaggerModule.setup('api-docs', app, document);

  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
