import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { v2 as cloudinary } from 'cloudinary';
import type { UploadApiResponse } from 'cloudinary';
import { ErrorCode } from '../../common/errors/error-codes';

/** Folder, formats and size limit ported verbatim from iKiotMS-BE's UploadController. */
export const UPLOAD_FOLDER = 'ikiot_uploads';
export const ALLOWED_FORMATS = ['jpg', 'jpeg', 'png', 'webp', 'gif'] as const;
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

const ALLOWED_MIME = new Set(ALLOWED_FORMATS.map((f) => `image/${f}`));

/** Image uploads to Cloudinary. The old module piped the request straight through `multer-storage-cloudinary`; here the file arrives in memory and goes up with `upload_stream` - same folder, formats, 5MB ceiling and `{ url }` response, one fewer dependency, and validation that can return a real 400. Nothing is uploaded when Cloudinary is unconfigured, which the old module only discovered as a 500 on first use. */
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

    // `secure_url` is the https one - the same value the old module returned as `req.file.path`.
    return { url: result.secure_url };
  }
}
