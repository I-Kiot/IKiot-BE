import { Transform } from 'class-transformer';
import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { TICKET_PRIORITIES } from '../ticket.constants';

const trim = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );

/** `POST /tickets` - a shop asking the platform for help. */
export class CreateTicketDto {
  @IsString()
  @trim()
  @IsNotEmpty({ message: 'Tiêu đề là bắt buộc' })
  @MaxLength(200)
  title: string;

  /** Also becomes the first message of the thread, as the old controller had it. */
  @IsString()
  @trim()
  @IsNotEmpty({ message: 'Nội dung là bắt buộc' })
  @MaxLength(5000)
  description: string;

  @IsOptional()
  @IsIn(TICKET_PRIORITIES, {
    message: `priority phải là một trong ${TICKET_PRIORITIES.join(', ')}`,
  })
  priority?: string;
}

/** Both reply routes - the shop's and the operator's - take the same body. */
export class ReplyTicketDto {
  @IsString()
  @trim()
  @IsNotEmpty({ message: 'Nội dung trả lời là bắt buộc' })
  @MaxLength(5000)
  message: string;
}
