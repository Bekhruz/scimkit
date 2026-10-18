import { MemoryScimStore } from 'scimkit';
import { describeStoreContract } from '../support/contract.js';

describeStoreContract('memory', () => {
  const store = new MemoryScimStore();
  return Promise.resolve({
    store,
    reset: () => {
      store.clear();
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
  });
});
