import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateWarehouseDto } from '../../warehouses/dto/create-warehouse.dto';
import { CreateBranchDto } from './create-branch.dto';
import { UpdateBranchDto } from './update-branch.dto';

async function phoneErrors(
  dto: new () => object,
  body: Record<string, unknown>,
) {
  const errors = await validate(plainToInstance(dto, body));
  return errors.filter((error) => error.property === 'phoneNumber');
}

describe('branch and warehouse phone numbers', () => {
  const base = { name: 'CN Hà Nội' };

  it('rejects a branch whose phone is "123"', async () => {
    expect(
      await phoneErrors(CreateBranchDto, { ...base, phoneNumber: ['123'] }),
    ).toHaveLength(1);
  });

  it('rejects the whole list when any entry is not a phone', async () => {
    expect(
      await phoneErrors(CreateBranchDto, {
        ...base,
        phoneNumber: ['0901234567', 'abc'],
      }),
    ).toHaveLength(1);
  });

  it('accepts mobile numbers, landlines and hotlines', async () => {
    expect(
      await phoneErrors(CreateBranchDto, {
        ...base,
        phoneNumber: ['0901234567', '(028) 3822 1234', '19001234'],
      }),
    ).toHaveLength(0);
  });

  it('applies the same rule when a branch is updated', async () => {
    expect(
      await phoneErrors(UpdateBranchDto, { phoneNumber: ['123'] }),
    ).toHaveLength(1);
    expect(await phoneErrors(UpdateBranchDto, { name: 'Mới' })).toHaveLength(0);
  });

  it('applies the same rule to a warehouse', async () => {
    expect(
      await phoneErrors(CreateWarehouseDto, { ...base, phoneNumber: ['123'] }),
    ).toHaveLength(1);
  });
});
