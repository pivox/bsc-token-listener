import { defineConfig } from 'hardhat/config';

export default defineConfig({
  networks: {
    local: {
      type: 'edr-simulated',
      chainType: 'l1',
    },
  },
});
