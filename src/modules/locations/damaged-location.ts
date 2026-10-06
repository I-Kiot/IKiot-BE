import { BadRequestException } from '@nestjs/common';
import { LocationStatus } from '../../common/constants/location-status';
import { ErrorCode } from '../../common/errors/error-codes';
import type { Prisma } from '../../../generated/prisma/client';

// Damaged-goods locations (D-4, contract §3): a warehouse with `isSellable = false` takes the
// defective units of a workshop delivery (B-5) and the damaged half of a return (D-5). Each
// branch / warehouse names its own in `damagedLocationId`. The two rules below keep that link
// meaningful; the database only has the foreign key.

/** Anything that can read locations - `this.prisma` or a transaction client alike. */
type LocationReader = Pick<Prisma.TransactionClient, 'location'>;

/**
 * `damagedLocationId` must name another location of the same tenant, not deleted, that sells
 * nothing - otherwise damaged goods would land back on a shelf someone sells from.
 * `null` / `undefined` (clear / leave alone) always pass. `selfId` is null on create.
 */
export async function assertDamagedLocationTarget(
  reader: LocationReader,
  tenantId: string,
  selfId: string | null,
  damagedLocationId: string | null | undefined,
): Promise<void> {
  if (!damagedLocationId) return;

  const invalid = (message: string) =>
    new BadRequestException({
      code: ErrorCode.LOCATION_DAMAGED_INVALID,
      message,
    });

  if (damagedLocationId === selfId) {
    throw invalid('A location cannot be its own damaged-goods location');
  }
  const target = await reader.location.findFirst({
    where: {
      id: damagedLocationId,
      tenantId,
      status: { not: LocationStatus.DELETED },
    },
    select: { isSellable: true },
  });
  // Another tenant's location reads exactly like a missing one.
  if (!target) {
    throw invalid('The damaged-goods location does not exist');
  }
  if (target.isSellable) {
    throw invalid(
      'The damaged-goods location must be a non-sellable warehouse (isSellable = false)',
    );
  }
}

/**
 * Turning a damaged-goods location back into a sellable one would silently break the rule above
 * for every location still pointing at it, so it is refused until they point elsewhere.
 */
export async function assertCanBecomeSellable(
  reader: LocationReader,
  tenantId: string,
  id: string,
): Promise<void> {
  const users = await reader.location.findMany({
    where: {
      tenantId,
      damagedLocationId: id,
      status: { not: LocationStatus.DELETED },
    },
    select: { name: true },
  });
  if (users.length > 0) {
    throw new BadRequestException({
      code: ErrorCode.LOCATION_DAMAGED_INVALID,
      message: `This warehouse is still the damaged-goods location of: ${users
        .map((location) => location.name)
        .join(', ')}. Point them elsewhere before making it sellable.`,
    });
  }
}
