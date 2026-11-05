import type { CapacitorConfig } from "@capacitor/cli";

const mobileServerUrl = process.env.TURTLE_MOBILE_SERVER_URL?.trim() || "https://www.turtlebot.app";

const config: CapacitorConfig = {
  appId: "com.onixus.turtlebot",
  appName: "Turtle Bot",
  webDir: "mobile-shell",
  backgroundColor: "#05070b",
  ...(mobileServerUrl
    ? {
        server: {
          url: mobileServerUrl,
          errorPath: "index.html",
          cleartext: mobileServerUrl.startsWith("http://"),
          allowNavigation: [new URL(mobileServerUrl).hostname],
        },
      }
    : {}),
  ios: {
    scheme: "TurtleBot",
    contentInset: "automatic",
  },
  android: {
    backgroundColor: "#05070b",
    allowMixedContent: false,
  },
  plugins: {
    PushNotifications: {
      presentationOptions: ["badge", "sound", "banner", "list"],
    },
    SplashScreen: {
      launchAutoHide: true,
      launchShowDuration: 1200,
      backgroundColor: "#05070b",
      showSpinner: false,
    },
    StatusBar: {
      style: "DARK",
      backgroundColor: "#05070b",
    },
  },
};

export default config;
