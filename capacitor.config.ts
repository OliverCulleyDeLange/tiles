import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'uk.co.oliverdelange.tiles',
  appName: 'Tiles',
  webDir: 'native-dist',
  server: {
    androidScheme: 'https',
  },
};

export default config;
