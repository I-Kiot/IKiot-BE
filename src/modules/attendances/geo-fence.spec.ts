import { distanceInMeters, verifyWithinFence } from './geo-fence';

/** Bến Thành market, Ho Chi Minh City - a real pair of coordinates to reason about. */
const SHOP = { latitude: 10.772, longitude: 106.698 };

const fence = (
  over: Partial<Parameters<typeof verifyWithinFence>[0]> = {},
) => ({
  latitude: SHOP.latitude,
  longitude: SHOP.longitude,
  allowedRadiusMeters: 100,
  maxAccuracyMeters: 100,
  ...over,
});

describe('distanceInMeters', () => {
  it('is zero at the same point', () => {
    expect(distanceInMeters(SHOP, SHOP)).toBe(0);
  });

  // 0.001° of latitude is ~111m anywhere on Earth - a fixed, checkable quantity.
  it('measures roughly 111m per 0.001° of latitude', () => {
    const north = {
      latitude: SHOP.latitude + 0.001,
      longitude: SHOP.longitude,
    };
    expect(distanceInMeters(SHOP, north)).toBeCloseTo(111, 0);
  });

  it('is symmetric', () => {
    const other = { latitude: 10.78, longitude: 106.71 };
    expect(distanceInMeters(SHOP, other)).toBeCloseTo(
      distanceInMeters(other, SHOP),
      6,
    );
  });
});

/** The two failures mean different things and the status codes say so: a vague fix is the phone's fault (422), a good fix somewhere else is the employee's (403). */
describe('verifyWithinFence', () => {
  it('accepts an accurate fix inside the radius', () => {
    const verdict = verifyWithinFence(fence(), {
      ...SHOP,
      accuracy: 10,
    });
    expect(verdict.verificationStatus).toBe('VERIFIED');
    expect(verdict.distance).toBe(0);
  });

  it('rejects a fix too vague to judge with 422', () => {
    expect.assertions(2);
    try {
      verifyWithinFence(fence(), { ...SHOP, accuracy: 500 });
    } catch (error) {
      const e = error as { status: number; response: { errors: unknown } };
      expect(e.status).toBe(422);
      expect(e.response.errors).toMatchObject({
        verificationStatus: 'LOW_ACCURACY',
      });
    }
  });

  it('rejects an accurate fix outside the radius with 403', () => {
    expect.assertions(2);
    try {
      // ~333m north of the shop, well outside a 100m radius.
      verifyWithinFence(fence(), {
        latitude: SHOP.latitude + 0.003,
        longitude: SHOP.longitude,
        accuracy: 5,
      });
    } catch (error) {
      const e = error as { status: number; response: { errors: unknown } };
      expect(e.status).toBe(403);
      expect(e.response.errors).toMatchObject({
        verificationStatus: 'OUT_OF_RANGE',
      });
    }
  });

  // Accuracy first, deliberately: a vague fix that happens to land far away is a bad fix, not a distant employee.
  it('reports low accuracy rather than out of range when both are true', () => {
    expect.assertions(1);
    try {
      verifyWithinFence(fence(), {
        latitude: SHOP.latitude + 0.003,
        longitude: SHOP.longitude,
        accuracy: 500,
      });
    } catch (error) {
      expect((error as { status: number }).status).toBe(422);
    }
  });

  it('refuses when the location has no geofence configured', () => {
    expect(() =>
      verifyWithinFence(fence({ latitude: null }), { ...SHOP, accuracy: 5 }),
    ).toThrow('No attendance location has been configured');
  });

  it('falls back to 100m radius and 100m accuracy when unset', () => {
    const verdict = verifyWithinFence(
      fence({ allowedRadiusMeters: null, maxAccuracyMeters: null }),
      { ...SHOP, accuracy: 99 },
    );
    expect(verdict.allowedRadiusMeters).toBe(100);
    expect(verdict.maxAccuracyMeters).toBe(100);
  });
});
