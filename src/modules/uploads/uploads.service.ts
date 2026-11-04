import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { v2 as cloudinary } from 'cloudinary';
import type { UploadApiResponse } from 'cloudinary';
import { ErrorCode } from '../../common/errors/error-codes';

/** Thư mục, định dạng và giới hạn dung lượng giữ nguyên từ UploadController của iKiotMS-BE. */
export const UPLOAD_FOLDER = 'ikiot_uploads';
export const ALLOWED_FORMATS = ['jpg', 'jpeg', 'png', 'webp', 'gif'] as const;
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

const ALLOWED_MIME = new Set(ALLOWED_FORMATS.map((f) => `image/${f}`));

/** Upload ảnh lên Cloudinary. Bản cũ đẩy request thẳng qua `multer-storage-cloudinary`; ở đây file nằm trong bộ nhớ rồi gửi bằng `upload_stream`, cùng thư mục, định dạng, trần 5MB và response `{ url }`, bớt một dependency, và validate trả được 400 thật. Không upload gì khi Cloudinary chưa cấu hình; bản cũ chỉ phát hiện điều này khi lỗi 500 ở lần dùng đầu. */
@Injectable()
export class UploadService {
  private readonly logger = new Logger(UploadService.name);
  private configured = false;

  private configure(): boolean {
    if (this.configured) return true;
    const {
      CLOUDINARY_CLOUD_NAME: cloud_name,
      CLOUDINARY_API_KEY: api_key,
      CLOUDINARY_API_SECRET: api_secret,
    } = process.env;
    if (!cloud_name || !api_key || !api_secret) return false;

    cloudinary.config({ cloud_name, api_key, api_secret });
    this.configured = true;
    return true;
  }

  async upload(file?: Express.Multer.File): Promise<{ url: string }> {
    if (!file) {
      throw new BadRequestException({
        code: ErrorCode.UPLOAD_FILE_REQUIRED,
        message: 'No file was selected for upload',
      });
    }
    if (!ALLOWED_MIME.has(file.mimetype)) {
      throw new BadRequestException({
        code: ErrorCode.UPLOAD_FORMAT_UNSUPPORTED,
        message: `Unsupported format. Accepted: ${ALLOWED_FORMATS.join(', ')}`,
      });
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new BadRequestException({
        code: ErrorCode.UPLOAD_FILE_TOO_LARGE,
        message: 'The file exceeds the 5MB limit',
      });
    }
    if (!this.configure()) {
      throw new InternalServerErrorException({
        code: ErrorCode.UPLOAD_NOT_CONFIGURED,
        message: 'Image storage is not configured on this server',
      });
    }

    const result = await new Promise<UploadApiResponse>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: UPLOAD_FOLDER, resource_type: 'image' },
        (error, uploaded) => {
          if (error || !uploaded) {
            reject(error instanceof Error ? error : new Error('Upload failed'));
            return;
          }
          resolve(uploaded);
        },
      );
      stream.end(file.buffer);
    }).catch((error: unknown) => {
      this.logger.error(
        'Cloudinary upload failed',
        error instanceof Error ? error.stack : error,
      );
      throw new InternalServerErrorException({
        code: ErrorCode.UPLOAD_FAILED,
        message: 'The upload failed',
      });
    });

    // `secure_url` là URL https, cùng giá trị bản cũ trả về ở `req.file.path`.
    return { url: result.secure_url };
  }
}
