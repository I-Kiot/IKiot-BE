/** What the assistant may look up, described for Gemini: the same thirty tools and wording as `ai.service.js` (the model reasons over that text), with `recordPerPage` renamed to `limit` and dropped filters removed rather than ignored. `permission` is not sent to Gemini - it is the gate `AiToolsService.run` checks. */

export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: {
    type: 'OBJECT';
    properties: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
}

const STRING = (description?: string) => ({ type: 'STRING', description });
const INTEGER = (description?: string) => ({ type: 'INTEGER', description });
const BOOLEAN = (description?: string) => ({ type: 'BOOLEAN', description });

const PAGING = {
  page: INTEGER('Trang kết quả cần lấy'),
  limit: INTEGER('Số lượng bản ghi mỗi trang'),
};

const DATE_RANGE = {
  fromDate: STRING('Ngày bắt đầu (YYYY-MM-DD)'),
  toDate: STRING('Ngày kết thúc (YYYY-MM-DD)'),
};

export const TOOL_DECLARATIONS: ToolDeclaration[] = [
  {
    name: 'searchProducts',
    description:
      'Tìm kiếm danh sách sản phẩm trong danh mục của cửa hàng theo tên, mã SKU hoặc mã vạch barcode.',
    parameters: {
      type: 'OBJECT',
      properties: {
        search: STRING('Từ khóa tìm kiếm (tên, sku, barcode)'),
        categoryId: STRING('Lọc theo mã danh mục'),
        status: STRING('Lọc theo trạng thái sản phẩm (ACTIVE, INACTIVE)'),
        ...PAGING,
      },
    },
  },
  {
    name: 'getProductStockLevel',
    description:
      'Kiểm tra số lượng tồn kho chi tiết của một sản phẩm cụ thể tại các chi nhánh/kho hàng.',
    parameters: {
      type: 'OBJECT',
      properties: {
        productId: STRING('ID, SKU hoặc tên của sản phẩm cần kiểm tra tồn kho'),
      },
      required: ['productId'],
    },
  },
  {
    name: 'getProductCategories',
    description: 'Lấy danh sách các danh mục hàng hóa của cửa hàng.',
    parameters: {
      type: 'OBJECT',
      properties: {
        search: STRING('Từ khóa tìm kiếm danh mục'),
        ...PAGING,
      },
    },
  },
  {
    name: 'getProductBrands',
    description: 'Lấy danh sách nhãn hiệu, thương hiệu sản phẩm của cửa hàng.',
    parameters: {
      type: 'OBJECT',
      properties: {
        search: STRING('Từ khóa tìm kiếm thương hiệu'),
        ...PAGING,
      },
    },
  },
  {
    name: 'searchCustomers',
    description:
      'Tìm kiếm thông tin khách hàng của cửa hàng theo tên hoặc số điện thoại.',
    parameters: {
      type: 'OBJECT',
      properties: {
        search: STRING('Tên hoặc số điện thoại khách hàng'),
        ...PAGING,
      },
    },
  },
  {
    name: 'getCustomerPurchaseHistory',
    description:
      'Xem chi tiết lịch sử mua hàng, công nợ và tổng số tiền đã chi trả của một khách hàng cụ thể.',
    parameters: {
      type: 'OBJECT',
      properties: {
        customerId: STRING('ID hoặc tên/SĐT của khách hàng'),
      },
      required: ['customerId'],
    },
  },
  {
    name: 'getBranchList',
    description: 'Xem danh sách các chi nhánh hiện có của cửa hàng.',
    parameters: {
      type: 'OBJECT',
      properties: { search: STRING('Tên chi nhánh'), ...PAGING },
    },
  },
  {
    name: 'getWarehouseList',
    description: 'Xem danh sách các kho hàng chứa hàng của doanh nghiệp.',
    parameters: {
      type: 'OBJECT',
      properties: { search: STRING('Tên kho hàng'), ...PAGING },
    },
  },
  {
    name: 'getSupplierList',
    description:
      'Xem danh sách các nhà cung cấp sản phẩm và công nợ với từng nhà cung cấp.',
    parameters: {
      type: 'OBJECT',
      properties: {
        search: STRING('Tên nhà cung cấp'),
        hasDebt: BOOLEAN('Chỉ lấy nhà cung cấp đang còn công nợ'),
        ...PAGING,
      },
    },
  },
  {
    name: 'getStaffList',
    description:
      'Xem danh sách nhân sự của doanh nghiệp (tất cả các nhân viên).',
    parameters: {
      type: 'OBJECT',
      properties: {
        // Was `keyword` + `role`: roles are tenant-defined rows now, so the model filters by where somebody works instead.
        search: STRING('Từ khóa tìm kiếm (tên, email, số điện thoại)'),
        status: STRING('Lọc theo trạng thái (ACTIVE, INACTIVE)'),
        branchId: STRING('Lọc nhân viên thuộc một chi nhánh'),
        warehouseId: STRING('Lọc nhân viên thuộc một kho hàng'),
        ...PAGING,
      },
    },
  },
  {
    name: 'getStaffAttendanceReport',
    description:
      'Thống kê lịch sử chấm công, số ngày làm việc, đi muộn của nhân viên.',
    parameters: {
      type: 'OBJECT',
      properties: {
        userId: STRING('ID của nhân viên cần kiểm tra'),
        status: STRING(
          'Trạng thái chấm công (CHECKED_IN, CHECKED_OUT, ABSENT)',
        ),
        checkinFrom: STRING('Ngày bắt đầu tìm kiếm chấm công (YYYY-MM-DD)'),
        checkinTo: STRING('Ngày kết thúc tìm kiếm chấm công (YYYY-MM-DD)'),
        branchId: STRING('Lọc theo chi nhánh'),
        ...PAGING,
      },
    },
  },
  {
    name: 'getLeaveRequests',
    description:
      'Xem danh sách đơn xin nghỉ phép của nhân viên và trạng thái phê duyệt.',
    parameters: {
      type: 'OBJECT',
      properties: {
        userId: STRING('ID của nhân viên'),
        status: STRING(
          'Trạng thái đơn (PENDING, APPROVED, REJECTED, CANCELLED, EXPIRED)',
        ),
        startDate: STRING('Ngày bắt đầu khoảng nghỉ (YYYY-MM-DD)'),
        endDate: STRING('Ngày kết thúc khoảng nghỉ (YYYY-MM-DD)'),
        ...PAGING,
      },
    },
  },
  {
    name: 'getStaffWorkingSchedule',
    description:
      'Xem lịch phân ca làm việc (lịch biểu tuần/tháng) của các nhân viên.',
    parameters: {
      type: 'OBJECT',
      properties: {
        userId: STRING('ID nhân viên'),
        startDate: STRING('Ngày bắt đầu ca làm (YYYY-MM-DD)'),
        endDate: STRING('Ngày kết thúc ca làm (YYYY-MM-DD)'),
        status: STRING('Trạng thái lịch làm (SCHEDULED, COMPLETED, CANCELLED)'),
        branchId: STRING('Lọc theo chi nhánh'),
        ...PAGING,
      },
    },
  },
  {
    name: 'getPayrollSummary',
    description:
      'Thống kê danh sách bảng lương và chi phí quỹ lương chi trả cho nhân sự.',
    parameters: {
      type: 'OBJECT',
      properties: { name: STRING('Tên bảng lương cần tìm'), ...PAGING },
    },
  },
  {
    name: 'getActivePromotions',
    description:
      'Xem danh sách các chương trình khuyến mãi, voucher đang chạy của cửa hàng.',
    parameters: {
      type: 'OBJECT',
      properties: { search: STRING('Từ khóa tìm kiếm khuyến mãi'), ...PAGING },
    },
  },
  {
    name: 'getTenantSubscriptionInfo',
    description:
      'Xem thông tin chi tiết gói dịch vụ tài khoản iKiot đang sử dụng (TRIAL, PLUS, PRO) và ngày hết hạn.',
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'getInventoryList',
    description: 'Xem danh sách tồn kho hàng hóa tổng quan của các sản phẩm.',
    parameters: {
      type: 'OBJECT',
      properties: {
        search: STRING('Từ khóa tên/SKU sản phẩm'),
        locationId: STRING('ID chi nhánh hoặc kho hàng'),
        locationType: STRING('Loại địa điểm (branch hoặc warehouse)'),
        isLowStock: BOOLEAN('Lọc sản phẩm sắp hết hàng'),
        ...PAGING,
      },
    },
  },
  {
    name: 'searchOrders',
    description:
      'Tìm kiếm danh sách đơn hàng dựa trên trạng thái, hình thức thanh toán hoặc mốc thời gian.',
    parameters: {
      type: 'OBJECT',
      properties: {
        status: STRING(
          'Trạng thái đơn (PENDING, COMPLETED, CANCELLED, RETURNED)',
        ),
        paymentMethod: STRING(
          'Phương thức thanh toán (CASH, BANK_TRANSFER, MOMO, VNPAY, SEPAY)',
        ),
        branchId: STRING('ID chi nhánh bán hàng'),
        search: STRING('Từ khóa tên hoặc SĐT khách hàng'),
        ...DATE_RANGE,
        ...PAGING,
      },
    },
  },
  {
    name: 'getRecentOrders',
    description: 'Lấy nhanh danh sách 5-10 đơn hàng phát sinh mới nhất.',
    parameters: {
      type: 'OBJECT',
      properties: {
        limit: INTEGER('Số lượng đơn cần lấy (mặc định là 10)'),
      },
    },
  },
  {
    name: 'getOrderDetailsByCode',
    description:
      'Tra cứu thông tin chi tiết của một đơn hàng cụ thể theo mã đơn (paymentReference, ví dụ: ORDxxxxxxxxxx) hoặc ID đơn hàng.',
    parameters: {
      type: 'OBJECT',
      properties: { orderCode: STRING('Mã đơn hàng hoặc ID đơn hàng') },
      required: ['orderCode'],
    },
  },
  {
    name: 'getStockMovementHistory',
    description:
      'Xem danh sách lịch sử phiếu di chuyển hàng hóa, điều chuyển kho giữa các chi nhánh.',
    parameters: {
      type: 'OBJECT',
      properties: {
        // The old tool searched by `requestNumber`; the ported list endpoint filters by status and movement type.
        status: STRING(
          'Trạng thái phiếu (DRAFT, PENDING, SHIPPED, COMPLETED, CANCELLED)',
        ),
        movementType: STRING('Loại điều chuyển'),
        ...PAGING,
      },
    },
  },
  {
    name: 'getRevenueOverview',
    description:
      'Xem thống kê tổng quan doanh thu, tổng số đơn hàng, giá trị trung bình đơn hàng (AOV), số lượng khách hàng và tỷ lệ tăng trưởng % so với kỳ trước.',
    parameters: {
      type: 'OBJECT',
      properties: {
        ...DATE_RANGE,
        branchId: STRING('Mã chi nhánh (nếu muốn lọc theo chi nhánh)'),
      },
    },
  },
  {
    name: 'getRevenueSeries',
    description:
      'Lấy dữ liệu chuỗi doanh thu và số lượng đơn hàng theo thời gian (theo ngày hoặc theo tháng) để phân tích xu hướng.',
    parameters: {
      type: 'OBJECT',
      properties: {
        ...DATE_RANGE,
        branchId: STRING('Mã chi nhánh'),
        groupBy: STRING("Gom nhóm theo 'day' hoặc 'month'"),
      },
    },
  },
  {
    name: 'getRevenueByPaymentMethod',
    description:
      'Thống kê tổng doanh thu phân loại theo các phương thức thanh toán (Tiền mặt CASH, Chuyển khoản BANK_TRANSFER, MoMo, VNPay, SePay...).',
    parameters: {
      type: 'OBJECT',
      properties: { ...DATE_RANGE, branchId: STRING('Mã chi nhánh') },
    },
  },
  {
    name: 'getRevenueByStaff',
    description:
      'Thống kê báo cáo doanh số bán hàng, số lượng đơn hàng và giá trị trung bình đơn hàng theo từng nhân viên.',
    parameters: {
      type: 'OBJECT',
      properties: { ...DATE_RANGE, branchId: STRING('Mã chi nhánh') },
    },
  },
  {
    name: 'getTopProducts',
    description:
      'Thống kê danh sách top sản phẩm bán chạy nhất theo số lượng bán ra hoặc theo doanh thu.',
    parameters: {
      type: 'OBJECT',
      properties: {
        ...DATE_RANGE,
        branchId: STRING('Mã chi nhánh'),
        sortBy: STRING(
          "Sắp xếp theo 'quantity' (số lượng) hoặc 'revenue' (doanh thu)",
        ),
        limit: INTEGER('Số lượng sản phẩm top cần lấy (mặc định 10)'),
      },
    },
  },
  {
    name: 'getInventoryOverviewStats',
    description:
      'Thống kê báo cáo tổng giá trị vốn tồn kho, tổng số mặt hàng SKU, số sản phẩm đã hết hàng và danh sách các mặt hàng sắp hết hàng.',
    parameters: {
      type: 'OBJECT',
      properties: {
        branchId: STRING('Mã chi nhánh'),
        warehouseId: STRING('Mã kho hàng'),
        lowStockThreshold: INTEGER(
          'Ngưỡng báo động tồn kho thấp (mặc định 10)',
        ),
      },
    },
  },
  {
    name: 'getCashflowSummary',
    description:
      'Xem báo cáo sổ quỹ tổng quan (tổng thu, tổng chi, thu net) và danh sách các phiếu thu/chi mới nhất.',
    parameters: {
      type: 'OBJECT',
      properties: {
        ...DATE_RANGE,
        flowType: STRING("Loại dòng tiền ('INCOME' thu hoặc 'EXPENSE' chi)"),
        flow: STRING(
          "Luồng tiền theo tiền tố mã ('ORD' bán hàng, 'SUP' trả NCC, 'PAYR' lương)",
        ),
        branchId: STRING('Mã chi nhánh'),
        warehouseId: STRING('Mã kho hàng'),
        ...PAGING,
      },
    },
  },
  {
    name: 'getCashDrawerSessions',
    description:
      'Xem thông tin báo cáo các phiên bàn giao két tiền, ca làm việc, tiền đầu ca, tiền cuối ca tại cửa hàng/chi nhánh.',
    parameters: {
      type: 'OBJECT',
      properties: {
        branchId: STRING('Mã chi nhánh'),
        status: STRING("Trạng thái ca két ('OPEN', 'CLOSED')"),
        ...DATE_RANGE,
        ...PAGING,
      },
    },
  },
  {
    name: 'getTenantTickets',
    description:
      'Xem danh sách các yêu cầu hỗ trợ kỹ thuật (tickets) của cửa hàng gửi tới hệ thống và trạng thái xử lý.',
    parameters: {
      type: 'OBJECT',
      properties: {
        status: STRING(
          "Trạng thái ticket ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED')",
        ),
        ...PAGING,
      },
    },
  },
];

export const TOOL_NAMES: string[] = TOOL_DECLARATIONS.map((tool) => tool.name);
