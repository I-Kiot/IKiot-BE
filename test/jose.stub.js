// `jose` is ESM-only and reached only through firebase-admin → jwks-rsa, i.e. only when
// verifying a real Google ID token - which no test does. Two runs need it stubbed, and
// both map to this one file (package.json's `jest.moduleNameMapper` and
// test/jest-e2e.json):
//   * e2e runs under --experimental-vm-modules for Prisma 7's WASM query compiler, and
//     under that flag the CJS `require('jose')` inside jwks-rsa throws;
//   * the unit run reaches firebase-admin through PushService → FirebaseService, and Jest
//     cannot parse jose's ESM at all there.
// Stubbing keeps the whole ESM interop problem out of the test setup; delete this the day
// a test actually exercises /auth/firebase-login (it would need a mocked Google JWKS
// endpoint anyway).
module.exports = new Proxy(
  {},
  {
    get() {
      throw new Error('jose is stubbed in tests (see test/jose.stub.js)');
    },
  },
);
