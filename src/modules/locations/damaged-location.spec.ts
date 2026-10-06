import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ErrorCode } from '../../common/errors/error-codes';
import { CreateBranchDto } from '../branches/dto/create-branch.dto';
import { UpdateWarehouseDto } from '../warehouses/dto/update-warehouse.dto';
import {
  assertCanBecomeSellable,
  assertDamagedLocationTarget,
} from './damaged-location';

/** A stand-in for `prisma.location` answering the given rows. */
function locations(
  found: { isSellable: boolean } | null,
  users: { name: string }[] = [],
) {
  const findFirst = jest.fn().mockResolvedValue(found);
  const findMany = jest.fn().mockResolvedValue(users);
  return {
    reader: { location: { findFirst, findMany } } as never,
    findFirst,
    findMany,
  };
}

const DAMAGED = '11111111-1111-4111-8111-111111111111';

describe('assertDamagedLocationTarget', () => {
  it('accepts another non-sellable location of the tenant', async () => {
    const { reader } = locations({ isSellable: false });
    await expect(
      assertDamagedLocationTarget(reader, 't1', 'self', DAMAGED),
    ).resolves.toBeUndefined();
  });

  it('lets null (clear) and undefined (leave alone) through without a query', async () => {
    const { reader, findFirst } = locations(null);
    await assertDamagedLocationTarget(reader, 't1', 'self', null);
    await assertDamagedLocationTarget(reader, 't1', 'self', undefined);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('refuses a location naming itself', async () => {
    const { reader } = locations({ isSellable: false });
    await expect(
      assertDamagedLocationTarget(reader, 't1', DAMAGED, DAMAGED),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.LOCATION_DAMAGED_INVALID },
    });
  });

  it('refuses a sellable location - damaged goods would land on a shelf', async () => {
    const { reader } = locations({ isSellable: true });
    await expect(
      assertDamagedLocationTarget(reader, 't1', null, DAMAGED),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.LOCATION_DAMAGED_INVALID },
    });
  });

  it('refuses a location it cannot find (missing, deleted or another tenant’s)', async () => {
    const { reader, findFirst } = locations(null);
    await expect(
      assertDamagedLocationTarget(reader, 't1', null, DAMAGED),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.LOCATION_DAMAGED_INVALID },
    });
    // Scoped by tenant and excluding deleted ones.
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: DAMAGED, tenantId: 't1', status: { not: 'DELETED' } },
      }),
    );
  });
});

describe('assertCanBecomeSellable', () => {
  it('passes when nothing points at the warehouse', async () => {
    const { reader } = locations(null, []);
    await expect(
      assertCanBecomeSellable(reader, 't1', DAMAGED),
    ).resolves.toBeUndefined();
  });

  it('refuses and names every location still pointing at it', async () => {
    const { reader } = locations(null, [
      { name: 'Showroom A' },
      { name: 'Kho B' },
    ]);
    const refusal = assertCanBecomeSellable(reader, 't1', DAMAGED);
    await expect(refusal).rejects.toMatchObject({
      response: { code: ErrorCode.LOCATION_DAMAGED_INVALID },
    });
    await expect(refusal).rejects.toThrow(/Showroom A, Kho B/);
  });
});

describe('location DTOs (D-4 fields)', () => {
  const errorsOf = async (cls: new () => object, body: object) =>
    (await validate(plainToInstance(cls, body))).map((e) => e.property);

  const branch = { name: 'CN', phoneNumber: ['0900000000'] };

  it('accepts a damagedLocationId, or null to clear it', async () => {
    expect(
      await errorsOf(CreateBranchDto, {
        ...branch,
        damagedLocationId: DAMAGED,
      }),
    ).toEqual([]);
    expect(
      await errorsOf(CreateBranchDto, { ...branch, damagedLocationId: null }),
    ).toEqual([]);
  });

  it('rejects a damagedLocationId that is not an id', async () => {
    expect(
      await errorsOf(CreateBranchDto, {
        ...branch,
        damagedLocationId: 'kho-hong',
      }),
    ).toEqual(['damagedLocationId']);
  });

  it('takes isSellable on a warehouse update, as a boolean only', async () => {
    expect(await errorsOf(UpdateWarehouseDto, { isSellable: false })).toEqual(
      [],
    );
    expect(await errorsOf(UpdateWarehouseDto, { isSellable: 'no' })).toEqual([
      'isSellable',
    ]);
  });
});
