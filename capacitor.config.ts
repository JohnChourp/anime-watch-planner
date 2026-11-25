import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.john.animewatchplanner',
  appName: 'Anime Planner for AniList',
  webDir: 'www',
  plugins: {
    // fetch goes through the native HTTP stack on iOS and Android (task 3.3). AniList sends its 429 for signed-in
    // calls without CORS headers, so in the WebView a 429 looked like "offline" and Retry-After was hidden.
    CapacitorHttp: { enabled: true },
  },
};

export default config;
