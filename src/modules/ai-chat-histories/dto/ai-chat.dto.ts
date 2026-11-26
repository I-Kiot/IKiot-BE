import { Transform } from 'class-transformer';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

const trim = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );

/** `POST /ai/chat` - hỏi một câu, có thể tiếp tục một thread đã có. */
export class ChatDto {
  @IsString()
  @trim()
  @IsNotEmpty({ message: 'Nội dung câu hỏi là bắt buộc' })
  @MaxLength(4000)
  message: string;

  /** Id hội thoại không có hoặc của người khác thì mở hội thoại mới. */
  @IsOptional()
  @IsUUID()
  conversationId?: string;
}

export class RenameConversationDto {
  @IsString()
  @trim()
  @IsNotEmpty({ message: 'Tiêu đề là bắt buộc' })
  @MaxLength(200)
  title: string;
}
