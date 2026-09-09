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

/** `POST /ai/chat` - one question, optionally continuing an existing thread. */
export class ChatDto {
  @IsString()
  @trim()
  @IsNotEmpty({ message: 'Nội dung câu hỏi là bắt buộc' })
  @MaxLength(4000)
  message: string;

  /** Absent, or naming somebody else's conversation, starts a new thread - deliberately not a 404, since a stale browser tab should cost a new thread, not an error dialog. */
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
