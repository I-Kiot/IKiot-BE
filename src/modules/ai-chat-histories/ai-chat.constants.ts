/** Port từ ai.service.js của iKiotMS-BE. Prompt là copy nghiệp vụ, quyết định trợ lý được và không được làm gì, nên đặt ở đây thay vì trong logic điều phối. */

/** Cho phép ghi đè vì tên model là chi tiết vận hành; đọc lúc gọi hàm vì hằng số module được tính trước khi ConfigModule nạp `.env`. */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.1-flash-lite';

export function geminiModel(): string {
  return process.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL;
}

/** Số lượt model một câu hỏi được dùng; mỗi lượt là một batch tool call hoặc câu trả lời cuối. */
export const MAX_AGENT_STEPS = 10;

/** Tiêu đề của hội thoại mới là tin nhắn đầu tiên, cắt tới độ dài này. */
export const TITLE_MAX_LENGTH = 30;

export const ROUTING_HISTORY_MESSAGES = 6;

/** Gemini không kết hợp custom function tool với Google Search grounding trong một request, nên câu hỏi được phân loại trước và chỉ bật đúng một trong hai. */
export const AgentRoute = {
  /** Dữ liệu của shop. Bật custom tool, tắt search. */
  INTERNAL_DATA: 'INTERNAL_DATA',
  /** Thế giới bên ngoài. Bật Google Search grounding, tắt custom tool. */
  EXTERNAL_SEARCH: 'EXTERNAL_SEARCH',
  /** Không cái nào - chat, tư vấn, chào hỏi. Không bật tool nào. */
  GENERAL_LLM: 'GENERAL_LLM',
} as const;

export type AgentRoute = (typeof AgentRoute)[keyof typeof AgentRoute];

export const SYSTEM_INSTRUCTION = `Bạn là Trợ lý thông minh độc quyền (AI Chat Assistant) của hệ thống quản lý iKiot.
Nhiệm vụ của bạn là hỗ trợ người dùng giải đáp các thắc mắc về kinh doanh, doanh thu, tài chính, nhân sự, đơn hàng, tồn kho bằng các Tools có sẵn.
Khi câu hỏi yêu cầu dữ liệu của cửa hàng, hãy luôn sử dụng các custom tools được cung cấp thay vì tự đoán hoặc suy luận.
Khi câu hỏi liên quan đến kiến thức chung hoặc xu hướng bên ngoài thị trường, hãy sử dụng tính năng Google Search Grounding để tra cứu thông tin mới nhất từ Internet.
Mỗi tool chỉ trả về đúng phần dữ liệu mà người đang hỏi được phép xem. Nếu một tool báo lỗi không có quyền, hãy nói thẳng với người dùng rằng họ không có quyền xem thông tin đó, tuyệt đối không suy đoán hay bịa số thay thế.
Hãy trả lời một cách lịch sự, chuyên nghiệp bằng tiếng Việt, giải thích số liệu rõ ràng và định dạng câu trả lời bằng Markdown.`;

export function classificationPrompt(
  historyText: string,
  message: string,
): string {
  return `Phân loại câu hỏi mới nhất của người dùng vào một trong ba nhóm:
- "INTERNAL_DATA": Yêu cầu truy vấn dữ liệu riêng tư của cửa hàng như: doanh thu, lợi nhuận, top bán chạy, báo cáo tài chính, sổ quỹ thu chi, ca làm két tiền, đơn hàng, hàng hóa, tồn kho, lương bổng, chấm công, ca làm, khách hàng, nhà cung cấp, chi nhánh, kho hàng, ticket hỗ trợ.
- "EXTERNAL_SEARCH": Yêu cầu tra cứu thông tin thời gian thực bên ngoài Internet như: xu hướng thị trường, thời tiết, giá vàng, tin tức thời sự, hot trend mạng xã hội hiện nay.
- "GENERAL_LLM": Các câu hỏi chào hỏi, tư vấn kinh doanh chung chung không cần tra cứu Internet hay truy cập dữ liệu cửa hàng.

Trả về kết quả duy nhất là một trong các từ khóa: INTERNAL_DATA, EXTERNAL_SEARCH, GENERAL_LLM. Không giải thích thêm.

${historyText ? `Lịch sử trò chuyện gần đây:\n${historyText}\n` : ''}
Câu hỏi của người dùng: "${message}"`;
}

/** Người dùng thấy câu này khi model hoặc tool lỗi; hội thoại vẫn được lưu với câu này làm trả lời, nên không câu hỏi nào bị bỏ lửng. */
export const FALLBACK_REPLY =
  'Xin lỗi, tôi đang có chút xíu việc bận ngay lúc này. Hãy nhờ tôi vào một lúc sau nha.';
