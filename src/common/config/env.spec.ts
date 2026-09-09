import { Logger } from '@nestjs/common';
import {
  accessTokenSecret,
  corsOrigins,
  refreshTokenSecret,
  socketCorsOrigins,
  validateEnv,
} from './env';

/** Each test gets a clean copy of `process.env`, or the first test to set a variable decides the rest. */
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

/** Silent, so a passing run isn't buried in the "optional variable missing" warnings. */
const quiet = () => {
  const logger = new Logger('EnvSpec');
  jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  return logger;
};

describe('accessTokenSecret', () => {
  // The precedence iKiotMS-BE used: reversing it deploys green and then rejects every login.
  it('prefers ACCESS_TOKEN_SECRET over JWT_SECRET', () => {
    process.env.ACCESS_TOKEN_SECRET = 'from-access';
    process.env.JWT_SECRET = 'from-jwt';
    expect(accessTokenSecret()).toBe('from-access');
  });

  it('falls back to JWT_SECRET', () => {
    process.env.JWT_SECRET = 'from-jwt';
    expect(accessTokenSecret()).toBe('from-jwt');
  });

  // Whitespace is not a secret: a blank value must not count as set and win over a real JWT_SECRET.
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

  // An empty signing key verifies tokens nobody legitimate issued.
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

    // Open CORS plus credentials lets any site on the internet call this API with a visitor's session.
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
