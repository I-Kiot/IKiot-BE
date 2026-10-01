import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { HttpException, HttpStatus } from '@nestjs/common';
import { ErrorCode } from '../../common/errors/error-codes';

/** Ported from `geolocationConstants.js`. */
export const EARTH_RADIUS_METERS = 6_371_000;

export const VerificationStatus = {
  VERIFIED: 'VERIFIED',
  LOW_ACCURACY: 'LOW_ACCURACY',
  OUT_OF_RANGE: 'OUT_OF_RANGE',
  NO_LOCATION: 'NO_LOCATION',
} as const;

/** Defaults the old service applied when a location left them unset. */
const DEFAULT_ALLOWED_RADIUS_METERS = 100;
const DEFAULT_MAX_ACCURACY_METERS = 100;

export interface GeoPoint {
  latitude: number;
  longitude: number;
  accuracy: number;
}

/** The geofence configured on a branch or warehouse. */
export interface GeoFence {
  latitude: number | null;
  longitude: number | null;
  allowedRadiusMeters: number | null;
  maxAccuracyMeters: number | null;
}

export interface GeoVerdict {
  verificationStatus: string;
  distance: number;
  allowedRadiusMeters: number;
  maxAccuracyMeters: number;
}

/** Great-circle distance in metres (Haversine, ported verbatim) - straight-line is what a geofence radius means, not walking distance. */
export function distanceInMeters(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

  const deltaLat = toRadians(to.latitude - from.latitude);
  const deltaLong = toRadians(to.longitude - from.longitude);

  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(toRadians(from.latitude)) *
      Math.cos(toRadians(to.latitude)) *
      Math.sin(deltaLong / 2) ** 2;

  return EARTH_RADIUS_METERS * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Is this person close enough, and their fix trustworthy enough, to clock in? Accuracy is checked first, and the two failures stay apart: 422 for a vague fix, 403 for a good one somewhere else. */
export function verifyWithinFence(
  fence: GeoFence,
  point: GeoPoint,
): GeoVerdict {
  if (fence.latitude === null || fence.longitude === null) {
    throw new BadRequestException({
      code: ErrorCode.GEOFENCE_NOT_CONFIGURED,
      message: 'No attendance location has been configured',
    });
  }

  const allowedRadiusMeters =
    fence.allowedRadiusMeters ?? DEFAULT_ALLOWED_RADIUS_METERS;
  const maxAccuracyMeters =
    fence.maxAccuracyMeters ?? DEFAULT_MAX_ACCURACY_METERS;
  const distance = distanceInMeters(point, {
    latitude: fence.latitude,
    longitude: fence.longitude,
  });

  if (point.accuracy > maxAccuracyMeters) {
    throw new HttpException(
      {
        code: ErrorCode.GEOFENCE_LOW_ACCURACY,
        message: `The location fix is not accurate enough to take attendance (${point.accuracy}m)`,
        errors: {
          verificationStatus: VerificationStatus.LOW_ACCURACY,
          accuracy: point.accuracy,
          maxAccuracyMeters,
          distance,
          allowedRadiusMeters,
        },
      },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }

  if (distance > allowedRadiusMeters) {
    throw new ForbiddenException({
      code: ErrorCode.GEOFENCE_OUT_OF_RANGE,
      message: 'You are outside the allowed attendance area',
      errors: {
        verificationStatus: VerificationStatus.OUT_OF_RANGE,
        accuracy: point.accuracy,
        maxAccuracyMeters,
        distance,
        allowedRadiusMeters,
      },
    });
  }

  return {
    verificationStatus: VerificationStatus.VERIFIED,
    distance,
    allowedRadiusMeters,
    maxAccuracyMeters,
  };
}
