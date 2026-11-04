import {
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { MAX_UPLOAD_BYTES, UploadService } from './uploads.service';

/** `POST /uploads`. Chỉ cần đăng nhập, không gate bằng permission: URL chỉ có ý nghĩa khi gắn vào sản phẩm, hồ sơ hoặc ticket, và mỗi nơi đó tự gate. Field multer là `file`. */
@ApiTags('uploads')
@ApiBearerAuth('bearer')
@Controller('uploads')
export class UploadController {
  constructor(private readonly service: UploadService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  // Giới hạn kiểm tra hai lần có chủ đích: multer ngắt việc đọc body quá lớn từ socket; service kiểm tra lại để trả 400 tiếng Việt thay vì định dạng lỗi của multer.
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }),
  )
  upload(@UploadedFile() file?: Express.Multer.File) {
    return this.service.upload(file);
  }
}
