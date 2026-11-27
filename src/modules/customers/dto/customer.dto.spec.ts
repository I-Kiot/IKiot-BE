import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateCustomerDto, UpdateCustomerDto } from './customer.dto';

async function errorsOn(
  dto: new () => object,
  body: Record<string, unknown>,
  property: string,
) {
  const errors = await validate(plainToInstance(dto, body));
  return errors.filter((error) => error.property === property);
}

describe('customer phone', () => {
  const base = { name: 'Anh Nam' };

  it('rejects "123" and text', async () => {
    expect(
      await errorsOn(CreateCustomerDto, { ...base, phone: '123' }, 'phone'),
    ).toHaveLength(1);
    expect(
      await errorsOn(CreateCustomerDto, { ...base, phone: 'abc' }, 'phone'),
    ).toHaveLength(1);
  });

  it('accepts a mobile number, a landline and a spaced number', async () => {
    for (const phone of ['0912345678', '028 3822 1234', '+84 912 345 678']) {
      expect(
        await errorsOn(CreateCustomerDto, { ...base, phone }, 'phone'),
      ).toHaveLength(0);
    }
  });

  it('still lets a customer be created without a phone', async () => {
    expect(await errorsOn(CreateCustomerDto, base, 'phone')).toHaveLength(0);
  });

  it('lets an update clear the phone with an empty string, but not set junk', async () => {
    expect(
      await errorsOn(UpdateCustomerDto, { phone: '' }, 'phone'),
    ).toHaveLength(0);
    expect(
      await errorsOn(UpdateCustomerDto, { phone: '123' }, 'phone'),
    ).toHaveLength(1);
  });
});

describe('customer email', () => {
  const base = { name: 'Anh Nam' };

  it('rejects an email that is not an address', async () => {
    for (const email of ['bad-email', 'a@', '@b.com', 'a b@c.com']) {
      expect(
        await errorsOn(CreateCustomerDto, { ...base, email }, 'email'),
      ).toHaveLength(1);
    }
  });

  it('accepts an address and lower-cases it', async () => {
    const dto = plainToInstance(CreateCustomerDto, {
      ...base,
      email: ' Nam.Nguyen@Example.COM ',
    });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.email).toBe('nam.nguyen@example.com');
  });

  it('lets a customer be created without an email', async () => {
    expect(await errorsOn(CreateCustomerDto, base, 'email')).toHaveLength(0);
  });

  it('lets an update clear the email with null, but not set junk', async () => {
    expect(
      await errorsOn(UpdateCustomerDto, { email: null }, 'email'),
    ).toHaveLength(0);
    expect(
      await errorsOn(UpdateCustomerDto, { email: 'bad-email' }, 'email'),
    ).toHaveLength(1);
  });
});
