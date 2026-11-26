// Stub `jose` (ESM-only) cho jest; không test nào xác minh token Google thật.
module.exports = new Proxy(
  {},
  {
    get() {
      throw new Error('jose is stubbed in tests (see test/jose.stub.js)');
    },
  },
);
