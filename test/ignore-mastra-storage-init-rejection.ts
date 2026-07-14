// Mastra's background createDefaultIndexes() can reject on DNS failure AFTER a test finishes
// when a store is built against a placeholder Atlas URI. Drop ONLY that specific rejection so
// real failures still surface.
process.on('unhandledRejection', (reason: unknown) => {
  const msg = String((reason as { message?: string })?.message ?? reason);
  if (msg.includes('Storage init failed') || msg.includes('MASTRA_STORAGE_MONGODB_CREATE_DEFAULT_INDEXES_FAILED')) return;
  throw reason;
});
