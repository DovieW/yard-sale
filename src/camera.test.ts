import { describe, expect, it, vi } from "vitest";
import { cameraConstraints, cameraLabel, enableContinuousFocus } from "./camera";

describe("camera capture", () => {
  it("keeps high resolution when switching to a specific camera", () => {
    const defaults = cameraConstraints();
    const selected = cameraConstraints("rear-2");
    expect(selected.width).toEqual(defaults.width);
    expect(selected.height).toEqual(defaults.height);
    expect(selected.deviceId).toEqual({ exact: "rear-2" });
    expect(selected.facingMode).toBeUndefined();
    expect(defaults.facingMode).toEqual({ ideal: "environment" });
  });

  it("enables continuous focus without losing resolution or device selection", async () => {
    const constraints = cameraConstraints("rear");
    const applyConstraints = vi.fn().mockResolvedValue(undefined);
    const track = {
      getCapabilities: () => ({ focusMode: ["manual", "continuous"] }),
      getConstraints: () => constraints,
      applyConstraints,
    } as unknown as MediaStreamTrack;
    await enableContinuousFocus(track);
    expect(applyConstraints).toHaveBeenCalledWith({ ...constraints, focusMode: { exact: "continuous" } });
  });

  it("leaves cameras without autofocus controls usable", async () => {
    const applyConstraints = vi.fn();
    for (const getCapabilities of [undefined, () => ({}), () => ({ focusMode: ["manual"] })]) {
      await enableContinuousFocus({ getCapabilities, applyConstraints } as unknown as MediaStreamTrack);
    }
    expect(applyConstraints).not.toHaveBeenCalled();
  });

  it("does not break capture when a browser rejects advertised focus controls", async () => {
    const track = {
      getCapabilities: () => ({ focusMode: ["continuous"] }),
      getConstraints: () => cameraConstraints("rear"),
      applyConstraints: vi.fn().mockRejectedValue(new Error("Unsupported camera control")),
    } as unknown as MediaStreamTrack;
    await expect(enableContinuousFocus(track)).resolves.toBeUndefined();
  });

  it("distinguishes multiple cameras without inventing their lens types", () => {
    const devices = [
      { deviceId: "1", label: "camera 1, facing front" },
      { deviceId: "3", label: "camera 3, facing front" },
      { deviceId: "2", label: "camera 2, facing back" },
      { deviceId: "0", label: "camera 0, facing back" },
    ];
    expect(devices.map((device) => cameraLabel(device, devices))).toEqual([
      "Front camera 1", "Front camera 2", "Rear camera 1", "Rear camera 2",
    ]);
    expect(cameraLabel(devices[0], [devices[0]])).toBe("Front camera");
    expect(cameraLabel({ deviceId: "usb", label: "USB webcam" }, [])).toBe("USB webcam");
  });
});
