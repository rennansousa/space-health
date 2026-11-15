import type { CapacitorConfig } from '@capacitor/cli';

// Android and iOS shells around the same web build (dist/).
// androidScheme "http" lets the app call the ship server over plain HTTP on the cabin network.
const config: CapacitorConfig = {
  appId: 'org.spaceapps.spacehealth',
  appName: 'Space Health',
  webDir: 'dist',
  server: { androidScheme: 'http', cleartext: true },
};

export default config;
