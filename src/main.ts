// QUAN TRỌNG: `instrument.ts` (Sentry) phải được import ở dòng đầu tiên, trước mọi import khác.
import './instrument';

// Import đầu tiên để kiểm biến môi trường trước khi đọc `.env`.
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
  // Thiếu secret thì dừng ngay lúc khởi động.
  validateEnv();

  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Lắng nghe SIGTERM để đóng Prisma và Redis.
  app.enableShutdownHooks();

  // TRUST_PROXY là số proxy để lấy đúng IP từ X-Forwarded-For.
  const trustProxy = process.env.TRUST_PROXY?.trim();
  app.set('trust proxy', trustProxy ? Number(trustProxy) : false);

  app.use(
    helmet({
      // CSP cho Swagger UI.
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
  // Phục vụ docs ở cả /docs và /api-docs.
  SwaggerModule.setup('api-docs', app, document);

  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
