import * as Sentry from '@sentry/nestjs';

Sentry.init({
  dsn: 'https://3176254b9212f496bfe817990b7a6030@o4512068561076224.ingest.de.sentry.io/4512068567367760',
  dataCollection: {
    // Tắt gửi thông tin người dùng và body: xem tuỳ chọn dataCollection của Sentry.
  },
});
