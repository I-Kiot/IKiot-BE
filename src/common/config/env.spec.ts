import { Logger } from '@nestjs/common';
import {
  accessTokenSecret,
  corsOrigins,
  refreshTokenSecret,
  socketCorsOrigins,
  validateEnv,
} from './env';

/** Mỗi test có một bản sao `process.env` sạch; nếu không, test đầu tiên set biến sẽ quyết định các test sau. */
const ORIGINAL = process.env;

beforeEach(() => {
  process.env = { ...ORIGINAL };
  delete process.env.CORS_ORIGIN;
  delete process.env.FRONTEND_URL;
  delete process.env.ACCESS_TOKEN_SECRET;
  delete process.env.REFRESH_TOKEN_SECRET;
});

afterAll(() => {
  process.env = ORIGINAL;
});

/** Im lặng, để lần chạy pass không bị lấp bởi cảnh báo "thiếu biến tuỳ chọn". */
const quiet = () => {
  const logger = new Logger('EnvSpec');
  jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  return logger;
};

describe('accessTokenSecret', () => {
  // Thứ tự ưu tiên của iKiotMS-BE: đảo ngược thì deploy vẫn xanh nhưng mọi lần đăng nhập đều bị từ chối.
  it('prefers ACCESS_TOKEN_SECRET over JWT_SECRET', () => {
    process.env.ACCESS_TOKEN_SECRET = 'from-access';
    process.env.JWT_SECRET = 'from-jwt';
    expect(accessTokenSecret()).toBe('from-access');
  });

  it('falls back to JWT_SECRET', () => {
    process.env.JWT_SECRET = 'from-jwt';
    expect(accessTokenSecret()).toBe('from-jwt');
  });

  // Khoảng trắng không phải secret: giá trị rỗng không được tính là đã set và đè lên JWT_SECRET thật.
  it('treats a blank value as unset', () => {
    process.env.ACCESS_TOKEN_SECRET = '   ';
    process.env.JWT_SECRET = 'from-jwt';
    expect(accessTokenSecret()).toBe('from-jwt');
  });
});

describe('refreshTokenSecret', () => {
  it('uses its own key when given one', () => {
    process.env.JWT_SECRET = 'access';
    process.env.REFRESH_TOKEN_SECRET = 'refresh';
    expect(refreshTokenSecret()).toBe('refresh');
  });

  it('otherwise shares the access-token key', () => {
    process.env.JWT_SECRET = 'access';
    expect(refreshTokenSecret()).toBe('access');
  });
});

describe('corsOrigins', () => {
  it('is `true` - reflect any origin - when nothing is configured', () => {
    expect(corsOrigins()).toBe(true);
    expect(socketCorsOrigins()).toBe('*');
  });

  it('splits and trims a comma-separated list', () => {
    process.env.CORS_ORIGIN = 'https://a.example.com, https://b.example.com';
    expect(corsOrigins()).toEqual([
      'https://a.example.com',
      'https://b.example.com',
    ]);
  });

  it('accepts FRONTEND_URL, the name already set in production', () => {
    process.env.FRONTEND_URL = 'https://app.example.com';
    expect(corsOrigins()).toEqual(['https://app.example.com']);
  });
});

describe('validateEnv', () => {
  it('passes with the required pair set', () => {
    process.env.DATABASE_URL = 'postgresql://localhost/db';
    process.env.JWT_SECRET = 'secret';
    expect(() => validateEnv(quiet())).not.toThrow();
  });

  it('names the missing variable rather than failing later', () => {
    delete process.env.DATABASE_URL;
    process.env.JWT_SECRET = 'secret';
    expect(() => validateEnv(quiet())).toThrow('DATABASE_URL');
  });

  // Khoá ký rỗng sẽ xác thực những token mà không ai hợp lệ đã cấp.
  it('refuses to start with no token secret at all', () => {
    process.env.DATABASE_URL = 'postgresql://localhost/db';
    delete process.env.JWT_SECRET;
    expect(() => validateEnv(quiet())).toThrow('ACCESS_TOKEN_SECRET');
  });

  describe('in production', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'production';
      process.env.DATABASE_URL = 'postgresql://localhost/db';
      process.env.JWT_SECRET = 'secret';
    });

    // CORS mở kèm credentials cho phép mọi site gọi API này bằng phiên của khách truy cập.
    it('refuses an open CORS policy', () => {
      expect(() => validateEnv(quiet())).toThrow('CORS_ORIGIN');
    });

    it('is satisfied by either CORS variable', () => {
      process.env.CORS_ORIGIN = 'https://app.example.com';
      expect(() => validateEnv(quiet())).not.toThrow();

      delete process.env.CORS_ORIGIN;
      process.env.FRONTEND_URL = 'https://app.example.com';
      expect(() => validateEnv(quiet())).not.toThrow();
    });
  });

  it('only warns about optional variables', () => {
    process.env.DATABASE_URL = 'postgresql://localhost/db';
    process.env.JWT_SECRET = 'secret';
    delete process.env.REDIS_URL;
    delete process.env.MAIL_HOST;

    const logger = new Logger('EnvSpec');
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);

    expect(() => validateEnv(logger)).not.toThrow();
    expect(warn.mock.calls.flat().join('\n')).toContain('REDIS_URL');
  });
});
