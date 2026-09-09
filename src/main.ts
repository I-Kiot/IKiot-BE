// First import, deliberately: `validateEnv()` runs before ConfigModule reads `.env`, and dotenv never overwrites a real environment variable.
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
  // A deploy missing JWT_SECRET must fail here, not on the first login after the load balancer has cut over.
  validateEnv();

  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // PrismaService and RedisService implement OnModuleDestroy; without this Nest never listens for the SIGTERM every deploy sends.
  app.enableShutdownHooks();

  // Express ignores X-Forwarded-For until told to trust the proxy, and that header is what AuditInterceptor records - TRUST_PROXY is the hop count, unset meaning no proxy.
  const trustProxy = process.env.TRUST_PROXY?.trim();
  app.set('trust proxy', trustProxy ? Number(trustProxy) : false);

  app.use(
    helmet({
      // Swagger UI at /docs is served inline, so the default CSP blocks it; these are Nest's own helmet + Swagger directives.
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
  // Turns Prisma errors into real 4xx responses instead of bare 500s - see the filter.
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
  // Both paths are mounted because iKiotMS-BE served its docs at /api-docs unconditionally; making them non-public is a deliberate decision, not part of the port.
  SwaggerModule.setup('api-docs', app, document);

  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
