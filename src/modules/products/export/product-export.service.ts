import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { ErrorCode } from '../../../common/errors/error-codes';
import { ProductStatus } from '../../../common/constants/product-status';
import {
  IMPORT_ATTRIBUTE_SLOTS,
  NO,
  PRODUCT_TYPE_LABELS,
  STATUS_LABELS,
  YES,
} from '../import/product-import.columns';
import {
  ProductImportService,
  type ProductSheetRow,
} from '../import/product-import.service';
import {
  EXPORTABLE_PRODUCT_TYPES,
  type ExportProductsDto,
} from '../dto/export-products.dto';

/** Giới hạn số dòng (SKU) một file xuất. */
export const MAX_PRODUCT_EXPORT_ROWS = 20000;

/** Xuất hàng hoá ra Excel theo đúng khuôn file mẫu nhập: mỗi SKU một dòng, sửa xong nhập lại được. */
@Injectable()
export class ProductExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly importer: ProductImportService,
  ) {}

  async export(tenantId: string, dto: ExportProductsDto): Promise<Buffer> {
    const products = await this.prisma.product.findMany({
      where: {
        tenantId,
        status: { not: ProductStatus.DISCONTINUED },
        productType: { in: dto.productType ?? [...EXPORTABLE_PRODUCT_TYPES] },
        ...(dto.ids ? { id: { in: dto.ids } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      select: {
        name: true,
        productType: true,
        categoryId: true,
        status: true,
        isManufacturable: true,
        brand: { select: { name: true } },
        productItems: {
          // SKU riêng sinh ra khi làm riêng dòng đơn không phải hàng của danh mục.
          where: { orderItems: { none: { isCustom: true } } },
          orderBy: { createdAt: 'asc' },
          select: {
            productName: true,
            productCode: true,
            sku: true,
            barcode: true,
            retailPrice: true,
            costPrice: true,
            vat: true,
            warrantyPeriod: true,
            description: true,
            suppliers: {
              select: { supplier: { select: { supplierName: true } } },
            },
            details: {
              orderBy: { position: 'asc' },
              select: {
                name: true,
                value: true,
                attribute: { select: { name: true, unit: true } },
              },
            },
          },
        },
      },
    });

    const rowCount = products.reduce((n, p) => n + p.productItems.length, 0);
    if (rowCount > MAX_PRODUCT_EXPORT_ROWS) {
      throw new BadRequestException({
        code: ErrorCode.EXCEL_EXPORT_TOO_LARGE,
        message: `The export has ${rowCount} rows, the limit is ${MAX_PRODUCT_EXPORT_ROWS}`,
      });
    }

    const categories = new Map(
      (await this.importer.categoryLabels(tenantId)).map((c) => [c.id, c.path]),
    );
    const rows: ProductSheetRow[] = [];
    for (const product of products) {
      for (const item of product.productItems) {
        const row: ProductSheetRow = {
          name: product.name,
          productType: PRODUCT_TYPE_LABELS[product.productType],
          category: product.categoryId
            ? categories.get(product.categoryId)
            : undefined,
          brand: product.brand?.name,
          status: STATUS_LABELS[product.status],
          isManufacturable: product.isManufacturable ? YES : NO,
          itemName: item.productName,
          productCode: item.productCode,
          sku: item.sku,
          barcode: item.barcode,
          retailPrice: Number(item.retailPrice),
          costPrice: Number(item.costPrice),
          vat: item.vat === null ? undefined : Number(item.vat),
          warrantyPeriod: item.warrantyPeriod,
          suppliers: item.suppliers
            .map((s) => s.supplier.supplierName)
            .join('; '),
          description: item.description,
        };
        // Chỉ thuộc tính có tên và giá trị, như bộ đọc; dòng ghi tự do không có thuộc tính thì lấy tên đã chụp.
        const details = item.details.filter(
          (d) => (d.attribute?.name ?? d.name) && d.value,
        );
        details.slice(0, IMPORT_ATTRIBUTE_SLOTS).forEach((detail, i) => {
          row[`attrName${i + 1}`] = detail.attribute?.name ?? detail.name;
          row[`attrUnit${i + 1}`] = detail.attribute?.unit;
          row[`attrValue${i + 1}`] = detail.value;
        });
        rows.push(row);
      }
    }
    return this.importer.buildFile(tenantId, rows);
  }
}
