import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService, pendingMigrations } from './app.service';
import { PrismaService } from './prisma/prisma.service';

describe('AppController', () => {
  let appController: AppController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService, { provide: PrismaService, useValue: {} }],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('health', () => {
    it('reports ok', () => {
      expect(appController.health()).toEqual({
        status: 'ok',
        uptime: expect.any(Number) as number,
      });
    });
  });
});

describe('pendingMigrations', () => {
  it('lists shipped migrations the database has not finished, in order', () => {
    expect(
      pendingMigrations(['1_init', '2_lots', '3_journey'], ['1_init']),
    ).toEqual(['2_lots', '3_journey']);
  });

  it('ignores migrations the database has but this build does not ship', () => {
    // An older image talking to a newer database is a rollback, not a missing migration.
    expect(pendingMigrations(['1_init'], ['1_init', '2_lots'])).toEqual([]);
  });
});
