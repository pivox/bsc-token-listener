import { defineConfig } from 'hardhat/config';

export default defineConfig({
  networks: {
    local: {
      type: 'edr-simulated',
      chainType: 'l1',
      initialDate: '2030-01-01T00:00:00.000Z',
    },
  },
});
