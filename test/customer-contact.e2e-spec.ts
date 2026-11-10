import 'dotenv/config';
import { randomUUID } from 'crypto';
import { Test } from '@nestjs/testing';
import { PrismaModule } from './../src/prisma/prisma.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { CustomerService } from './../src/modules/customers/customers.service';

/**
 * Liên hệ của khách trên Postgres thật: email được lưu (trước đây DTO không có trường này nên bị bỏ), PATCH xoá được email và SĐT đã lưu. Tự tạo một tenant riêng và dọn sạch.
 */
describe('Customer contact details – CustomerService', () => {
  let prisma: PrismaService;
  let customers: CustomerService;

  const tenantId = randomUUID();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [CustomerService],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    customers = moduleRef.get(CustomerService);

    await prisma.tenant.create({
      data: { id: tenantId, name: 'customer-contact-e2e' },
    });
  });

  afterAll(async () => {
    await prisma.customer.deleteMany({ where: { tenantId } });
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
    await prisma.$disconnect();
  });

  it('stores the email given at creation', async () => {
    const created = await customers.create(tenantId, {
      name: 'Anh Nam',
      phone: '0912345678',
      email: 'nam@example.com',
    });
    expect(created.email).toBe('nam@example.com');
    const stored = await prisma.customer.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(stored.email).toBe('nam@example.com');
  });

  it('changes the email on update and leaves it alone when it is not sent', async () => {
    const created = await customers.create(tenantId, {
      name: 'Chị Lan',
      email: 'lan@example.com',
    });
    const changed = await customers.update(tenantId, created.id, {
      email: 'lan.moi@example.com',
    });
    expect(changed.email).toBe('lan.moi@example.com');
    const untouched = await customers.update(tenantId, created.id, {
      address: '1 Lê Lợi',
    });
    expect(untouched.email).toBe('lan.moi@example.com');
  });

  it('clears the email with null and the phone with an empty string', async () => {
    const created = await customers.create(tenantId, {
      name: 'Anh Tuấn',
      phone: '0933000111',
      email: 'tuan@example.com',
    });
    const cleared = await customers.update(tenantId, created.id, {
      email: null,
      phone: '',
    });
    expect(cleared.email).toBeNull();
    expect(cleared.phone).toBeNull();
  });
});
