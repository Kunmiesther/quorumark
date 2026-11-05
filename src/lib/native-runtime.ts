import { Capacitor, type PluginListenerHandle } from "@capacitor/core";
import { Haptics, ImpactStyle } from "@capacitor/haptics";
import { PushNotifications } from "@capacitor/push-notifications";
import { StatusBar, Style } from "@capacitor/status-bar";

import { supabase } from "@/integrations/supabase/client";

const INTERACTIVE_SELECTOR =
  "button, a, [role='button'], input[type='checkbox'], input[type='radio']";

export function isNativeApp() {
  return Capacitor.isNativePlatform();
}

export async function initializeNativeRuntime(): Promise<() => void> {
  if (!isNativeApp()) return () => undefined;

  await Promise.allSettled([
    StatusBar.setStyle({ style: Style.Dark }),
    StatusBar.setBackgroundColor({ color: "#05070b" }),
  ]);

  const hapticTap = (event: Event) => {
    const target =
      event.target instanceof Element ? event.target.closest(INTERACTIVE_SELECTOR) : null;
    if (
      !target ||
      target.getAttribute("aria-disabled") === "true" ||
      target.hasAttribute("disabled")
    )
      return;
    void Haptics.impact({ style: ImpactStyle.Light }).catch(() => undefined);
  };
  document.addEventListener("click", hapticTap, { capture: true });

  const actionListener = await PushNotifications.addListener(
    "pushNotificationActionPerformed",
    ({ notification }) => {
      const destination = notification.data?.path;
      if (
        typeof destination === "string" &&
        destination.startsWith("/") &&
        !destination.startsWith("//")
      ) {
        window.location.assign(destination);
      }
    },
  );

  return () => {
    document.removeEventListener("click", hapticTap, { capture: true });
    void actionListener.remove();
  };
}

async function waitForNativePushToken(): Promise<string> {
  let registrationListener: PluginListenerHandle | undefined;
  let errorListener: PluginListenerHandle | undefined;

  try {
    let resolveToken!: (token: string) => void;
    let rejectToken!: (error: Error) => void;
    const tokenPromise = new Promise<string>((resolve, reject) => {
      resolveToken = resolve;
      rejectToken = reject;
    });
    const registrationTimeout = window.setTimeout(
      () => rejectToken(new Error("Notification registration timed out. Please try again.")),
      15_000,
    );

    registrationListener = await PushNotifications.addListener("registration", (token) => {
      window.clearTimeout(registrationTimeout);
      resolveToken(token.value);
    });
    errorListener = await PushNotifications.addListener("registrationError", ({ error }) => {
      window.clearTimeout(registrationTimeout);
      rejectToken(new Error(error || "This device could not register for notifications."));
    });

    try {
      await PushNotifications.register();
    } catch (error) {
      window.clearTimeout(registrationTimeout);
      throw error;
    }
    return await tokenPromise;
  } finally {
    await Promise.allSettled([registrationListener?.remove(), errorListener?.remove()]);
  }
}

export async function requestPushNotifications(userId: string): Promise<boolean> {
  if (!isNativeApp()) {
    if (typeof Notification === "undefined") {
      throw new Error("Notifications are not supported on this device.");
    }
    return (await Notification.requestPermission()) === "granted";
  }

  let permission = await PushNotifications.checkPermissions();
  if (permission.receive === "prompt" || permission.receive === "prompt-with-rationale") {
    permission = await PushNotifications.requestPermissions();
  }
  if (permission.receive !== "granted") return false;

  const token = await waitForNativePushToken();
  const platform = Capacitor.getPlatform();
  const now = new Date().toISOString();
  const { error } = await supabase.from("push_device_tokens").upsert(
    {
      user_id: userId,
      token,
      platform,
      last_seen_at: now,
      updated_at: now,
    },
    { onConflict: "user_id,token" },
  );
  if (error) throw error;

  return true;
}
