import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

// Needs a reachable DATABASE_URL (docker-compose up) - booting AppModule connects Prisma.
// NODE_ENV=test also keeps SubscriptionCronService from scheduling its daily sweep.
describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('GET / is public and reports health', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect((res) => {
        expect((res.body as { status: string }).status).toBe('ok');
      });
  });

  it('GET /notifications requires a token (global JwtAuthGuard)', () => {
    return request(app.getHttpServer()).get('/notifications').expect(401);
  });

  afterAll(async () => {
    await app.close();
  });
});
