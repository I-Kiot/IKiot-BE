import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class OrderReturnService {
  constructor(private readonly prisma: PrismaService) {}
}
