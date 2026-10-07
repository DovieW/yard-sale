export function cameraConstraints(deviceId?: string): MediaTrackConstraints {
  return {
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    ...(deviceId
      ? { deviceId: { exact: deviceId } }
      : { facingMode: { ideal: "environment" } }),
  };
}

type FocusCapabilities = MediaTrackCapabilities & { focusMode?: string[] };
type FocusConstraints = MediaTrackConstraints & { focusMode?: ConstrainDOMString };

export async function enableContinuousFocus(track: MediaStreamTrack): Promise<void> {
  // Some browsers omit getCapabilities or advertise controls they cannot apply.
  // An optional focus adjustment must never prevent the camera from opening.
  try {
    const capabilities = track.getCapabilities?.() as FocusCapabilities | undefined;
    if (!capabilities?.focusMode?.includes("continuous")) return;
    const constraints: FocusConstraints = {
      ...track.getConstraints(),
      focusMode: { exact: "continuous" },
    };
    await track.applyConstraints(constraints);
  } catch {
    // A rejected adjustment leaves the track's original constraints intact.
  }
}

function cameraSide(label: string): "Rear" | "Front" | undefined {
  if (/\b(back|rear|environment)\b/i.test(label)) return "Rear";
  if (/\b(front|user)\b/i.test(label)) return "Front";
}

export function cameraLabel(device: Pick<MediaDeviceInfo, "deviceId" | "label">, devices: Pick<MediaDeviceInfo, "deviceId" | "label">[]): string {
  const side = cameraSide(device.label);
  if (!side) return device.label || `Camera ${Math.max(0, devices.findIndex((entry) => entry.deviceId === device.deviceId)) + 1}`;
  const sameSide = devices.filter((entry) => cameraSide(entry.label) === side);
  const index = Math.max(0, sameSide.findIndex((entry) => entry.deviceId === device.deviceId));
  return `${side} camera${sameSide.length > 1 ? ` ${index + 1}` : ""}`;
}
