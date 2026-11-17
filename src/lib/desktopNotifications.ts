export type DesktopNotificationPermission = NotificationPermission | 'unsupported';

export function getDesktopNotificationPermission(): DesktopNotificationPermission {
  if (typeof window === 'undefined' || typeof window.Notification === 'undefined') {
    return 'unsupported';
  }
  return window.Notification.permission;
}

export async function requestDesktopNotificationPermission(): Promise<DesktopNotificationPermission> {
  if (typeof window === 'undefined' || typeof window.Notification === 'undefined') {
    return 'unsupported';
  }
  try {
    const result = await window.Notification.requestPermission();
    return result;
  } catch {
    return window.Notification.permission ?? 'denied';
  }
}

export interface DesktopNotificationPayload {
  title: string;
  body: string;
  tag?: string;
  onClick?: () => void;
}

export function sendDesktopNotification({
  title,
  body,
  tag,
  onClick,
}: DesktopNotificationPayload): boolean {
  if (typeof window === 'undefined' || typeof window.Notification === 'undefined') {
    return false;
  }
  if (window.Notification.permission !== 'granted') {
    return false;
  }

  try {
    const notification = new window.Notification(title, {
      body,
      tag,
      requireInteraction: false,
    });

    notification.onclick = () => {
      try {
        window.focus();
      } catch {
        // ignore focus restriction in embedded contexts
      }
      onClick?.();
      notification.close();
    };

    window.setTimeout(() => {
      notification.close();
    }, 8000);

    return true;
  } catch {
    return false;
  }
}
