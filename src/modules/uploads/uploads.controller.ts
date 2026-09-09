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

/** `POST /uploads`, ported from the old upload module: authenticated but not permission-gated, since the URL is only useful once written onto a product, profile or ticket, each gated on its own resource. The multer field is `file`. */
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
  // The limit is enforced twice on purpose: multer stops reading a huge body off the socket, and the service re-checks so the caller gets a Vietnamese 400 rather than multer's error shape.
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }),
  )
  upload(@UploadedFile() file?: Express.Multer.File) {
    return this.service.upload(file);
  }
}
