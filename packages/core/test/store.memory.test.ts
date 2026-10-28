import { memoryStore } from '../src/store/memory.js';
import { runStoreContract } from './store.contract.js';

runStoreContract('memory', async () => memoryStore());
