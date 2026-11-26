/** Hàng mẫu của hai shop demo, lấy từ trang bán hàng công khai; giá vốn là ước tính. */

export interface DemoVariant {
  sku: string;
  name: string;
  details: [string, string][];
  retailPrice: number;
  costPrice: number;
}

export interface DemoProduct {
  key: string;
  name: string;
  category: string;
  brand: string;
  supplier: string;
  warranty?: string;
  manufacturable?: boolean;
  /** Biến thể đoán, không có trên trang nguồn. */
  assumed?: boolean;
  sourceUrl: string;
  imageUrl?: string;
  variants: DemoVariant[];
}

export interface DemoCombo {
  key: string;
  name: string;
  category: string;
  brand: string;
  sku: string;
  retailPrice: number;
  components: { sku: string; quantity: number }[];
}

const cost = (price: number, ratio: number) =>
  Math.round((price * ratio) / 1000) * 1000;

/** Biến thể theo các cặp thuộc tính; giá giống nhau. */
function grid(
  prefix: string,
  baseName: string,
  axes: { name: string; values: { code: string; label: string }[] }[],
  price: number,
  ratio: number,
): DemoVariant[] {
  let combos: { code: string; label: string; name: string }[][] = [[]];
  for (const axis of axes) {
    combos = combos.flatMap((c) =>
      axis.values.map((v) => [...c, { ...v, name: axis.name }]),
    );
  }
  return combos.map((parts) => ({
    sku: [prefix, ...parts.map((p) => p.code)].join('-'),
    name: `${baseName} - ${parts.map((p) => p.label).join(' / ')}`,
    details: parts.map((p) => [p.name, p.label] as [string, string]),
    retailPrice: price,
    costPrice: cost(price, ratio),
  }));
}

const v = (code: string, label: string) => ({ code, label });
const SIZES_SHIRT = [v('M', 'M'), v('L', 'L'), v('XL', 'XL')];
const SIZES_PANTS = [
  v('29', '29'),
  v('30', '30'),
  v('31', '31'),
  v('32', '32'),
];
const F = 0.6; // tỷ lệ giá vốn nội thất (ước tính)
const M = 0.45; // tỷ lệ giá vốn thời trang (ước tính)

// ---------------------------------------------------------------- Nội thất IGM

export const IGM_PRODUCTS: DemoProduct[] = [
  {
    key: 'mht',
    name: 'Bàn làm việc IGM MHT 1 hộc tủ',
    category: 'Bàn làm việc',
    brand: 'IGM',
    supplier: 'Công ty TNHH Nội thất Phương Nam',
    warranty: '12 tháng',
    manufacturable: true,
    sourceUrl: 'https://igm.vn/products/ban-lam-viec-igm-mht-1-hoc-tu',
    imageUrl:
      'https://cdn.hstatic.net/products/200000506121/den-tr_ng_409765da385c41ab8f8f1e8c772e38db_grande.png',
    variants: [
      ['120', '1m2', 'Trắng - Đen', 2_300_000],
      ['140', '1m4', 'Sồi - Trắng', 2_350_000],
      ['160', '1m6', 'Nâu - Đen', 2_400_000],
    ].map(([code, length, color, price]) => ({
      sku: `MHT11011-${code}`,
      name: `Bàn làm việc IGM MHT 1 hộc tủ ${length} - ${color}`,
      details: [
        ['Kích thước', `${length} x 70 x 75 cm`],
        ['Màu', color as string],
        ['Chất liệu', 'MDF cốt nâu phủ Melamine'],
      ],
      retailPrice: price as number,
      costPrice: cost(price as number, F),
    })),
  },
  {
    key: 'lht',
    name: 'Bàn IGM chữ L 2 hộc tủ 5 ngăn',
    category: 'Bàn làm việc',
    brand: 'IGM',
    supplier: 'Công ty TNHH Nội thất Phương Nam',
    warranty: '12 tháng',
    sourceUrl: 'https://igm.vn/products/ban-gaming-igm-chu-l-2-hoc-tu-5-ngan-2',
    variants: [
      {
        sku: 'LHT013-3',
        name: 'Bàn IGM chữ L 2 hộc tủ 5 ngăn - Trắng',
        details: [
          ['Màu', 'Trắng'],
          ['Chất liệu', 'MDF phủ Melamine'],
        ],
        retailPrice: 3_400_000,
        costPrice: cost(3_400_000, F),
      },
    ],
  },
  {
    key: 'hth',
    name: 'Bàn làm việc IGM HTH 2 hộc tủ cho 2 người',
    category: 'Bàn làm việc',
    brand: 'IGM',
    supplier: 'Công ty TNHH Nội thất Phương Nam',
    warranty: '12 tháng',
    sourceUrl: 'https://igm.vn/products/ban-lam-viec-igm-hth-2-hoc-tu',
    variants: [
      {
        sku: 'HTH11011',
        name: 'Bàn làm việc IGM HTH 2 hộc tủ cho 2 người',
        details: [['Chất liệu', 'MDF phủ Melamine']],
        retailPrice: 3_600_000,
        costPrice: cost(3_600_000, F),
      },
    ],
  },
  {
    key: 'igm900',
    name: 'Ghế công thái học IGM 900',
    category: 'Ghế',
    brand: 'IGM',
    supplier: 'Sihoo Việt Nam',
    warranty: '12 tháng',
    sourceUrl: 'https://igm.vn/products/ghe-cong-thai-hoc-igm-900-cao-cap',
    imageUrl:
      'https://product.hstatic.net/200000506121/product/1_929f7b9fe2554be4a938758a8eafb01a_grande.png',
    variants: grid(
      'IGM90055',
      'Ghế công thái học IGM 900',
      [{ name: 'Màu', values: [v('XAM', 'Xám'), v('DEN', 'Đen')] }],
      3_000_000,
      F,
    ),
  },
  {
    key: 'sihoo',
    name: 'Ghế công thái học Sihoo M90C',
    category: 'Ghế',
    brand: 'Sihoo',
    supplier: 'Sihoo Việt Nam',
    warranty: '12 tháng',
    sourceUrl: 'https://igm.vn/products/ghe-cong-thai-hoc-sihoo-m90c-cao-cap',
    variants: [
      {
        sku: 'SH005-1',
        name: 'Ghế công thái học Sihoo M90C',
        details: [['Chất liệu', 'Lưới, khung nhựa ABS']],
        retailPrice: 5_000_000,
        costPrice: cost(5_000_000, F),
      },
    ],
  },
  {
    key: 'kmh005',
    name: 'Tủ đầu giường IGM KMH005',
    category: 'Tủ',
    brand: 'IGM',
    supplier: 'Công ty TNHH Nội thất Phương Nam',
    warranty: '12 tháng',
    sourceUrl: 'https://igm.vn/products/tu-dau-giuong-igm-kmh005',
    imageUrl:
      'https://product.hstatic.net/200000506121/product/tu_dau_giuong_1_41dd682fbafb406a970bf08f8889d517_grande.jpg',
    variants: grid(
      'KMH005',
      'Tủ đầu giường IGM KMH005',
      [
        {
          name: 'Màu',
          values: [v('TRANG', 'Trắng Ngọc'), v('WALNUT', 'Nâu Walnut')],
        },
      ],
      850_000,
      F,
    ),
  },
  {
    key: 'tvp',
    name: 'Tủ kệ văn phòng IGM TVP',
    category: 'Tủ',
    brand: 'IGM',
    supplier: 'Công ty TNHH Nội thất Phương Nam',
    warranty: '12 tháng',
    manufacturable: true,
    sourceUrl: 'https://igm.vn/products/tu-ke-van-phong-igm-tvp',
    imageUrl:
      'https://cdn.hstatic.net/products/200000506121/8_213ef3fe842d4bb48aa07c04849408b4_grande.jpg',
    variants: [
      ['1218', '1m2 x 1m8', 3_990_000],
      ['12215', '1m2 x 2m15', 4_650_000],
    ].map(([code, size, price]) => ({
      sku: `TVP11011-${code}`,
      name: `Tủ kệ văn phòng IGM TVP ${size}`,
      details: [
        ['Kích thước', `${size} x 30 cm`],
        ['Chất liệu', 'MDF cốt nâu phủ Melamine'],
      ],
      retailPrice: price as number,
      costPrice: cost(price as number, F),
    })),
  },
  {
    key: 'billy',
    name: 'Kệ sách Billy IGM 6 tầng',
    category: 'Kệ',
    brand: 'IGM',
    supplier: 'Công ty TNHH Nội thất Phương Nam',
    warranty: '12 tháng',
    sourceUrl:
      'https://igm.vn/products/ke-sach-billy-igm-6-tang-cao-2m15-rong-90cm-sau-28cm',
    variants: [
      {
        sku: 'BILLY-6T',
        name: 'Kệ sách Billy IGM 6 tầng 2m15 x 90 x 28 cm',
        details: [['Kích thước', '90 x 28 x 215 cm']],
        retailPrice: 2_050_000,
        costPrice: cost(2_050_000, F),
      },
    ],
  },
  {
    key: 'ht001',
    name: 'Hộc tủ IGM 5 ngăn có ray kéo',
    category: 'Tủ',
    brand: 'IGM',
    supplier: 'Công ty TNHH Nội thất Phương Nam',
    warranty: '12 tháng',
    sourceUrl: 'https://igm.vn/products/hoc-tu-5-ngan-co-ray-keo',
    variants: [
      {
        sku: 'HT001-1',
        name: 'Hộc tủ IGM 5 ngăn có ray kéo',
        details: [['Chất liệu', 'MDF phủ Melamine']],
        retailPrice: 1_090_000,
        costPrice: cost(1_090_000, F),
      },
    ],
  },
  {
    key: 'kmh004',
    name: 'Kệ để màn hình máy tính 2 tầng IGM KMH004',
    category: 'Phụ kiện',
    brand: 'IGM',
    supplier: 'Công ty TNHH Nội thất Phương Nam',
    warranty: '6 tháng',
    sourceUrl:
      'https://igm.vn/products/ke-de-man-hinh-may-tinh-2-tang-igm-kmh004',
    imageUrl:
      'https://product.hstatic.net/200000506121/product/6_b1f9397dbda046eea229edf6c9a2753e_grande.jpg',
    variants: grid(
      'KMH004',
      'Kệ để màn hình 2 tầng IGM KMH004',
      [{ name: 'Màu', values: [v('DEN', 'Đen Mờ'), v('TRANG', 'Trắng Ngọc')] }],
      350_000,
      F,
    ),
  },
];

/** Combo tự đặt của shop mẫu (không có trên igm.vn): bàn MHT 1m2 + ghế IGM 900, rẻ hơn mua lẻ 310.000. */
export const IGM_COMBOS: DemoCombo[] = [
  {
    key: 'combo-work',
    name: 'Combo góc làm việc MHT + IGM 900',
    category: 'Combo',
    brand: 'IGM',
    sku: 'COMBO-MHT-IGM900',
    retailPrice: 4_990_000,
    components: [
      { sku: 'MHT11011-120', quantity: 1 },
      { sku: 'IGM90055-XAM', quantity: 1 },
    ],
  },
];

// ─── 360 Boutique ───

const SOSANHGIA = 'https://sosanhgia.vn';

export const B360_PRODUCTS: DemoProduct[] = [
  {
    key: 'pohtk227',
    name: 'Áo polo nam thêu họa tiết ngực POHTK227',
    category: 'Áo polo',
    brand: '360 Boutique',
    supplier: 'Xưởng may Hà Đông',
    sourceUrl: `${SOSANHGIA}/ao-polo-nam-local-brand-360-nsh3489912508.html`,
    imageUrl: 'https://cf.shopee.vn/file/0c36d8784097f4a570981a39b0d0f29b',
    variants: grid(
      'POHTK227',
      'Áo polo POHTK227',
      [
        { name: 'Màu', values: [v('TRANG', 'Trắng'), v('BE', 'Be')] },
        { name: 'Size', values: SIZES_SHIRT },
      ],
      325_000,
      M,
    ),
  },
  {
    key: 'poktk239',
    name: 'Áo polo nam kẻ ngang POKTK239',
    category: 'Áo polo',
    brand: '360 Boutique',
    supplier: 'Xưởng may Hà Đông',
    assumed: true,
    sourceUrl: `${SOSANHGIA}/ao-polo-nam-ke-ngang-local-nsh8264709655.html`,
    variants: grid(
      'POKTK239',
      'Áo polo kẻ ngang POKTK239',
      [{ name: 'Size', values: SIZES_SHIRT }],
      306_000,
      M,
    ),
  },
  {
    key: 'stdol317',
    name: 'Áo sơ mi dài tay nhung tăm STDOL317',
    category: 'Áo sơ mi',
    brand: '360 Boutique',
    supplier: 'Xưởng may Hà Đông',
    sourceUrl: `${SOSANHGIA}/ao-so-mi-unisex-dai-tay-chat-nti197360171.html`,
    imageUrl:
      'https://salt.tikicdn.com/ts/product/58/dc/b7/f3d96931307481dd1a98337887e139e4.jpg',
    variants: grid(
      'STDOL317',
      'Sơ mi nhung tăm STDOL317',
      [
        { name: 'Màu', values: [v('NAU', 'Nâu'), v('BE', 'Be')] },
        { name: 'Size', values: SIZES_SHIRT },
      ],
      399_000,
      M,
    ),
  },
  {
    key: 'stntk217',
    name: 'Áo sơ mi nam ngắn tay cổ bẻ STNTK217',
    category: 'Áo sơ mi',
    brand: '360 Boutique',
    supplier: 'Xưởng may Hà Đông',
    assumed: true,
    sourceUrl: `${SOSANHGIA}/ao-so-mi-nam-360boutique-ngan-nsh8150499056.html`,
    variants: grid(
      'STNTK217',
      'Sơ mi ngắn tay STNTK217',
      [{ name: 'Size', values: SIZES_SHIRT }],
      315_000,
      M,
    ),
  },
  {
    key: 'aphtk261',
    name: 'Áo thun cổ tròn có túi ngực APHTK261',
    category: 'Áo thun',
    brand: '360 Boutique',
    supplier: 'Xưởng may Hà Đông',
    sourceUrl: `${SOSANHGIA}/ao-thun-co-tron-local-brand-360-nsh8667437722.html`,
    imageUrl: 'https://cf.shopee.vn/file/0d43e7940e77343791ac01b9afb0a952',
    variants: grid(
      'APHTK261',
      'Áo thun APHTK261',
      [
        { name: 'Màu', values: [v('TRANG', 'Trắng'), v('XAM', 'Xám đậm')] },
        { name: 'Size', values: SIZES_SHIRT },
      ],
      279_000,
      M,
    ),
  },
  {
    key: 'atdol326',
    name: 'Áo thun dài tay cổ tròn oversize ATDOL326',
    category: 'Áo thun',
    brand: '360 Boutique',
    supplier: 'Xưởng may Hà Đông',
    assumed: true,
    sourceUrl: `${SOSANHGIA}/ao-thun-nam-dai-tay-co-tron-nti201391728.html`,
    variants: grid(
      'ATDOL326',
      'Áo thun dài tay ATDOL326',
      [{ name: 'Size', values: SIZES_SHIRT }],
      199_000,
      M,
    ),
  },
  {
    key: 'adltk204',
    name: 'Áo da lộn cổ lông tháo lắp ADLTK204',
    category: 'Áo khoác',
    brand: '360 Boutique',
    supplier: 'Xưởng may Hà Đông',
    sourceUrl: `${SOSANHGIA}/ma-giam-gia-30k-ao-da-lon-cao-nsh14513748890.html`,
    imageUrl: 'https://cf.shopee.vn/file/76922c779b2888fa316eb8a4abadde4d',
    variants: grid(
      'ADLTK204',
      'Áo da lộn ADLTK204',
      [
        {
          name: 'Màu',
          values: [v('XAM', 'Xám đậm'), v('NAU', 'Nâu nhạt')],
        },
        { name: 'Size', values: SIZES_SHIRT },
      ],
      809_000,
      M,
    ),
  },
  {
    key: 'ahhtk211',
    name: 'Áo nỉ da cá in hình có mũ AHHTK211',
    category: 'Áo khoác',
    brand: '360 Boutique',
    supplier: 'Xưởng may Hà Đông',
    assumed: true,
    sourceUrl: `${SOSANHGIA}/ao-ni-da-ca-in-hinh-cao-cap-nsh10079929816.html`,
    variants: grid(
      'AHHTK211',
      'Áo nỉ có mũ AHHTK211',
      [{ name: 'Size', values: SIZES_SHIRT }],
      449_000,
      M,
    ),
  },
  {
    key: 'qactk206',
    name: 'Quần âu nam tapered QACTK206',
    category: 'Quần âu',
    brand: '360 Boutique',
    supplier: 'Xưởng may Hà Đông',
    sourceUrl: `${SOSANHGIA}/quan-au-nam-thuong-hieu-thoi-nsh15622247462.html`,
    imageUrl: 'https://cf.shopee.vn/file/b3675afefecccae54dd6b0082d4a95b8',
    variants: grid(
      'QACTK206',
      'Quần âu QACTK206',
      [
        { name: 'Màu', values: [v('XAM', 'Xám'), v('DEN', 'Đen')] },
        { name: 'Size', values: SIZES_PANTS },
      ],
      441_000,
      M,
    ),
  },
  {
    key: 'qastk204',
    name: 'Quần âu nam QASTK204',
    category: 'Quần âu',
    brand: '360 Boutique',
    supplier: 'Xưởng may Hà Đông',
    assumed: true,
    sourceUrl: `${SOSANHGIA}/quan-au-nam-thuong-hieu-thoi-nsh11169443320.html`,
    variants: grid(
      'QASTK204',
      'Quần âu QASTK204',
      [{ name: 'Size', values: SIZES_PANTS }],
      335_000,
      M,
    ),
  },
  {
    key: 'qkltk302',
    name: 'Quần kaki nam QKLTK302',
    category: 'Quần kaki',
    brand: '360 Boutique',
    supplier: 'Xưởng may Hà Đông',
    assumed: true,
    sourceUrl: `${SOSANHGIA}/quan-kaki-nam-thuong-hieu-360-nsh15981594388.html`,
    variants: grid(
      'QKLTK302',
      'Quần kaki QKLTK302',
      [{ name: 'Size', values: SIZES_PANTS }],
      371_000,
      M,
    ),
  },
  {
    key: 'capcn239',
    name: 'Túi đeo chéo nam CAPCN239',
    category: 'Phụ kiện',
    brand: '360 Boutique',
    supplier: 'Xưởng giày túi Phú Xuyên',
    sourceUrl: `${SOSANHGIA}/tui-deo-cheo-nam-thuong-hieu-nsh14538376298.html`,
    variants: [
      {
        sku: 'CAPCN239',
        name: 'Túi đeo chéo nam CAPCN239',
        details: [],
        retailPrice: 468_000,
        costPrice: cost(468_000, M),
      },
    ],
  },
  {
    key: 'depcn012',
    name: 'Sandal quai ngang đế ép DEPCN012',
    category: 'Giày dép',
    brand: '360 Boutique',
    supplier: 'Xưởng giày túi Phú Xuyên',
    assumed: true,
    sourceUrl: `${SOSANHGIA}/sandal-quai-ngang-den-de-ep-360-nsh7649357627.html`,
    variants: grid(
      'DEPCN012',
      'Sandal DEPCN012',
      [{ name: 'Size', values: [v('40', '40'), v('41', '41'), v('42', '42')] }],
      377_000,
      M,
    ),
  },
];
