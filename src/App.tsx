import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  Archive,
  Bot,
  Camera,
  ChevronRight,
  CircleDollarSign,
  Download,
  ExternalLink,
  Gauge,
  History,
  ImageUp,
  LoaderCircle,
  RotateCw,
  ScanLine,
  Search,
  Settings,
  Square,
  Trash2,
  Video,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentRunHistory, AnalysisResponse, DetectedItem, HistoryPage, Stats } from "./types";
import { cameraConstraints, cameraLabel, enableContinuousFocus } from "./camera";
import { watchCameraPreview, type CameraPreview } from "./camera-preview";
import { captureDimensions, waitForVideoReady } from "./capture";
import { ScanWork } from "./scan-work";
import { ApiError, readApiResponse } from "./api";
import { APP_UPDATE_EVENT, installAppUpdate, updateAvailable } from "./app-updates";

const EMPTY_STATS: Stats = {
  framesProcessed: 0,
  itemsIdentified: 0,
  searchesPerformed: 0,
  modelCalls: 0,
  lastUpdated: null,
};
const EMPTY_ITEMS: DetectedItem[] = [];
const FIND_CRITERIA_STORAGE_KEY = "yard-sale-find-criteria";
const FIND_CRITERIA_PRESETS = [
  { label: "Vintage tees", value: "Vintage band tees worth more than $40" },
  { label: "Modern electronics", value: "Electronics that are still modern enough to use" },
  { label: "Designer goods", value: "Authentic designer clothing, shoes, bags, and accessories with strong resale value" },
  { label: "Collectibles", value: "Vintage toys, trading cards, figurines, and collectibles worth more than $30" },
  { label: "Quality cookware", value: "High-quality cookware, cast iron, knives, and small kitchen appliances worth reselling" },
  { label: "Rare media", value: "Rare, collectible, or out-of-print books, records, CDs, and physical media" },
];

type View = "scan" | "history";
type Source = "camera" | "video" | "image";
class CameraChangedError extends Error {
  constructor() { super("Camera selection changed."); }
}

async function fetchStats(): Promise<Stats> {
  const response = await fetch("/api/stats");
  if (!response.ok) throw new Error("Could not load processing statistics.");
  return response.json();
}

async function fetchItems(search: string, cursor: string | null, signal: AbortSignal): Promise<HistoryPage> {
  const params = new URLSearchParams({ q: search });
  if (cursor) params.set("cursor", cursor);
  const response = await fetch(`/api/items?${params}`, { signal });
  if (!response.ok) throw new Error("Could not load saved finds.");
  return response.json();
}

function useHistory(search: string, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: ["items", search],
    queryFn: ({ pageParam, signal }) => fetchItems(search, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled,
  });
}

async function fetchFrameItems(itemId: string): Promise<DetectedItem[]> {
  const response = await fetch(`/api/items/${encodeURIComponent(itemId)}`);
  if (!response.ok) throw new Error("Could not load this find.");
  return response.json();
}

async function fetchAgentRun(itemId: string): Promise<AgentRunHistory> {
  const response = await fetch(`/api/agent-runs/by-item/${encodeURIComponent(itemId)}`);
  const body = (await response.json()) as AgentRunHistory | { error?: string };
  if (!response.ok) throw new Error("error" in body && body.error ? body.error : "Could not load agent activity.");
  return body as AgentRunHistory;
}

async function deleteFindRequest(itemId: string): Promise<void> {
  const response = await fetch(`/api/items/${encodeURIComponent(itemId)}`, { method: "DELETE" });
  if (!response.ok) throw new Error("Could not delete this find.");
}

async function deleteAllFindsRequest(): Promise<void> {
  const response = await fetch("/api/items", { method: "DELETE" });
  if (!response.ok) throw new Error("Could not delete all finds.");
}

export default function App({ children }: { children?: React.ReactNode }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const cameraPreviewRef = useRef<CameraPreview | null>(null);
  const restoringCameraRef = useRef<Promise<string> | null>(null);
  const cameraChooserRef = useRef<HTMLDialogElement>(null);
  const objectUrlRef = useRef<string | null>(null);
  const intervalRef = useRef<number | null>(null);
  const firstCaptureRef = useRef<number | null>(null);
  const inFlightRef = useRef(0);
  const scanWorkRef = useRef(new ScanWork());
  const requestRef = useRef<AbortController | null>(null);
  const cameraOperationRef = useRef(0);
  const openingCameraRef = useRef<Promise<string> | null>(null);
  const cameraWantedRef = useRef(false);
  const scanWantedRef = useRef(false);
  const lastFrameUrlRef = useRef<string | null>(null);
  const lastVideoTimeRef = useRef(-1);
  const streamQueueRef = useRef<DetectedItem[]>([]);
  const streamTimerRef = useRef<number | null>(null);
  const scanIntervalSecondsRef = useRef(4);
  const [findCriteria, setFindCriteria] = useState(() =>
    window.localStorage.getItem(FIND_CRITERIA_STORAGE_KEY) ?? "",
  );
  const findCriteriaRef = useRef(findCriteria);
  const [source, setSource] = useState<Source>("camera");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [inFlight, setInFlight] = useState(0);
  const [liveItems, setLiveItems] = useState<DetectedItem[]>([]);
  const [selectedItem, setSelectedItem] = useState<DetectedItem | null>(null);
  const [selectedFrameItems, setSelectedFrameItems] = useState<DetectedItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sourceLabel, setSourceLabel] = useState("Camera ready");
  const [cameraDevices, setCameraDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedCameraId, setSelectedCameraId] = useState("off");
  const [stillPreviewUrl, setStillPreviewUrl] = useState<string | null>(null);
  const [scanIntervalSeconds, setScanIntervalSeconds] = useState(4);
  const [cameraState, setCameraState] = useState<"off" | "opening" | "ready" | "interrupted">("off");
  const cameraStateRef = useRef(cameraState);
  cameraStateRef.current = cameraState;
  const [cameraChooserOpen, setCameraChooserOpen] = useState(false);
  const [scanMessage, setScanMessage] = useState("Choose a camera, take a photo, or upload an image.");
  const [lastFrameUrl, setLastFrameUrl] = useState<string | null>(null);
  const [framePreviewOpen, setFramePreviewOpen] = useState(false);
  const [requestStartedAt, setRequestStartedAt] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [hasUpdate, setHasUpdate] = useState(updateAvailable);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historySearch, setHistorySearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(historySearch.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [historySearch]);
  const [deletingItemId, setDeletingItemId] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const showCameraError = (cameraError: unknown, fallback = "Camera access failed.") => {
    if (!(cameraError instanceof CameraChangedError)) setError(cameraError instanceof Error ? cameraError.message : fallback);
  };
  const navigate = useNavigate();
  const location = useRouterState({ select: (state) => state.location });
  const findPath = location.pathname.split("/");
  const itemId = findPath[1] === "finds" && findPath[2] ? decodeURIComponent(findPath[2]) : null;
  const activityOpen = Boolean(itemId && findPath[3] === "activity");
  const view: View = location.pathname === "/history" || (itemId && location.search.from !== "scan")
    ? "history"
    : "scan";
  const viewRef = useRef(view);
  viewRef.current = view;
  const { data: stats = EMPTY_STATS } = useQuery({ queryKey: ["stats"], queryFn: fetchStats });
  const history = useHistory(debouncedSearch, view === "history");
  const savedFinds = useHistory("", settingsOpen);
  const historyItems = useMemo(() =>
    [...new Map(history.data?.pages.flatMap((page) => page.items).map((item) => [item.id, item]) ?? []).values()],
  [history.data]);
  const settingsItems = useMemo(() =>
    [...new Map(savedFinds.data?.pages.flatMap((page) => page.items).map((item) => [item.id, item]) ?? []).values()],
  [savedFinds.data]);
  const searchPending = historySearch.trim() !== debouncedSearch;
  const { data: routedFrameItems = EMPTY_ITEMS } = useQuery({
    queryKey: ["frame-items", itemId],
    queryFn: () => fetchFrameItems(itemId!),
    enabled: Boolean(itemId),
  });

  const updateFindCriteria = (nextCriteria: string) => {
    findCriteriaRef.current = nextCriteria;
    setFindCriteria(nextCriteria);
    window.localStorage.setItem(FIND_CRITERIA_STORAGE_KEY, nextCriteria);
  };

  const refreshHistory = useCallback(
    async () => queryClient.invalidateQueries({ queryKey: ["items"] }),
    [queryClient],
  );

  useEffect(() => {
    return () => {
      stopMedia();
      if (lastFrameUrlRef.current) URL.revokeObjectURL(lastFrameUrlRef.current);
    };
  }, []);

  useEffect(() => {
    const onUpdate = () => setHasUpdate(true);
    window.addEventListener(APP_UPDATE_EVENT, onUpdate);
    return () => window.removeEventListener(APP_UPDATE_EVENT, onUpdate);
  }, []);

  useEffect(() => {
    if (cameraChooserOpen) cameraChooserRef.current?.showModal();
  }, [cameraChooserOpen]);

  useEffect(() => {
    if (requestStartedAt === null) { setElapsedSeconds(0); return; }
    const tick = () => setElapsedSeconds(Math.floor((Date.now() - requestStartedAt) / 1000));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [requestStartedAt]);

  const startItemStream = useCallback(() => {
    if (streamTimerRef.current !== null) return;

    const revealNext = () => {
      const nextItem = streamQueueRef.current.shift();
      if (!nextItem) {
        streamTimerRef.current = null;
        return;
      }

      setLiveItems((current) => current.some((item) => item.id === nextItem.id)
        ? current.map((item) => item.id === nextItem.id ? nextItem : item)
        : [nextItem, ...current].slice(0, 100));
      streamTimerRef.current = window.setTimeout(revealNext, 500);
    };

    revealNext();
  }, []);

  useEffect(() => {
    if (!itemId) {
      setSelectedItem(null);
      setSelectedFrameItems((current) => current.length ? EMPTY_ITEMS : current);
      return;
    }
    const availableItems = [...routedFrameItems, ...liveItems, ...historyItems];
    const routeItem = availableItems.find((item) => item.id === itemId);
    if (!routeItem) return;
    setSelectedItem(routeItem);
    setSelectedFrameItems(
      routedFrameItems.length > 0
        ? routedFrameItems
        : availableItems.filter((item) => item.thumbnailUrl === routeItem.thumbnailUrl),
    );
  }, [historyItems, itemId, liveItems, routedFrameItems]);

  const refreshCameras = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter((device) => device.kind === "videoinput");
    setCameraDevices(cameras);
    return cameras;
  }, []);

  useEffect(() => {
    const refresh = () => { void refreshCameras().catch(() => {}); };
    refresh();
    navigator.mediaDevices?.addEventListener("devicechange", refresh);
    return () => navigator.mediaDevices?.removeEventListener("devicechange", refresh);
  }, [refreshCameras]);

  const submitBlob = useCallback(
    async (activeSessionId: string, blob: Blob, reservation?: number) => {
      const token = reservation ?? scanWorkRef.current.acquire();
      if (token === null) {
        setScanMessage("Still analyzing the last frame. The next frame will follow when it finishes.");
        return;
      }
      if (!scanWorkRef.current.isCurrent(token)) { scanWorkRef.current.release(); return; }
      inFlightRef.current += 1;
      setInFlight(inFlightRef.current);
      setRequestStartedAt(Date.now());
      setScanMessage("Identifying objects and checking values…");
      setError(null);
      if (lastFrameUrlRef.current) URL.revokeObjectURL(lastFrameUrlRef.current);
      lastFrameUrlRef.current = URL.createObjectURL(blob);
      setLastFrameUrl(lastFrameUrlRef.current);
      const controller = new AbortController();
      requestRef.current = controller;
      const timeout = window.setTimeout(() => controller.abort("timeout"), 90_000);
      try {
        const form = new FormData();
        form.set("sessionId", activeSessionId);
        form.set("capturedAt", new Date().toISOString());
        form.set("findCriteria", findCriteriaRef.current);
        form.set("image", blob, "frame.jpg");
        const response = await fetch("/api/analyze", { method: "POST", body: form, signal: controller.signal });
        const result = await readApiResponse<AnalysisResponse>(response);
        if (!scanWorkRef.current.isCurrent(token)) return;
        queryClient.setQueryData(["stats"], result.stats);
        setScanMessage(result.summary || (result.items.length ? `Identified ${result.items.length} object${result.items.length === 1 ? "" : "s"}.` : "No clear objects found. Move closer, hold steady, and try Snap."));
        if (result.items.length > 0) {
          streamQueueRef.current.push(...result.items);
          startItemStream();
          void refreshHistory();
        }
        setError(null);
      } catch (frameError) {
        if (!scanWorkRef.current.isCurrent(token)) return;
        stopScan();
        const message = controller.signal.aborted
          ? "Analysis timed out. Live scanning is paused; try a clear, steady snapshot."
          : frameError instanceof Error ? frameError.message : "Frame analysis failed";
        setError(message);
        setScanMessage(frameError instanceof ApiError && frameError.status === 429 ? "Usage limit reached. Scanning paused." : "Analysis failed. Try Snap again when ready.");
      } finally {
        window.clearTimeout(timeout);
        if (requestRef.current === controller) requestRef.current = null;
        inFlightRef.current -= 1;
        setInFlight(inFlightRef.current);
        setRequestStartedAt(null);
        scanWorkRef.current.release();
      }
    },
    [queryClient, refreshHistory, startItemStream],
  );

  const submitFrame = useCallback(
    async (activeSessionId: string, manual = false) => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas) throw new Error("The camera preview is unavailable.");
      const token = scanWorkRef.current.acquire();
      if (token === null) {
        if (manual) setScanMessage("Still analyzing the last frame. Please wait before taking another snapshot.");
        return;
      }
      let handedOff = false;
      try {
        if (streamRef.current && !cameraPreviewRef.current?.isHealthy()) {
          throw new Error("Camera preview has stopped. Tap Restart camera before taking a snapshot.");
        }
        await waitForVideoReady(video);
        if (!scanWorkRef.current.isCurrent(token)) return;
        if (!manual && video.currentTime === lastVideoTimeRef.current) return;
        lastVideoTimeRef.current = video.currentTime;
        const dimensions = captureDimensions(video.videoWidth, video.videoHeight);
        canvas.width = dimensions.width;
        canvas.height = dimensions.height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("The image canvas is unavailable.");
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
        if (!blob) throw new Error("The camera frame could not be captured.");
        handedOff = true;
        await submitBlob(activeSessionId, blob, token);
      } finally {
        if (!handedOff) scanWorkRef.current.release();
      }
    },
    [submitBlob],
  );

  const beginSession = useCallback(
    async (nextSource: Source, sourceName?: string, isCurrent: () => boolean = () => true) => {
      const id = crypto.randomUUID();
      const response = await fetch("/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, sourceType: nextSource, sourceName }),
      });
      await readApiResponse(response);
      if (!isCurrent()) throw new CameraChangedError();
      sessionIdRef.current = id;
      setSessionId(id);
      setSource(nextSource);
      setLiveItems([]);
      streamQueueRef.current = [];
      if (streamTimerRef.current !== null) window.clearTimeout(streamTimerRef.current);
      streamTimerRef.current = null;
      return id;
    },
    [],
  );

  const openCamera = (deviceId?: string): Promise<string> => {
    stopMedia();
    const operation = cameraOperationRef.current;
    cameraWantedRef.current = true;
    setCameraState("opening");
    setSource("camera");
    setError(null);
    setScanMessage("Opening camera…");
    setStillPreviewUrl(null);
    const promise = (async () => {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera access is unavailable in this browser. Try Chrome or upload a photo.");
      const stream = await navigator.mediaDevices.getUserMedia({ video: cameraConstraints(deviceId), audio: false });
      if (operation !== cameraOperationRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        throw new CameraChangedError();
      }
      streamRef.current = stream;
      if (!videoRef.current) throw new Error("Camera preview is unavailable.");
      const video = videoRef.current;
      video.removeAttribute("src");
      video.srcObject = stream;
      video.muted = true;
      const track = stream.getVideoTracks()[0];
      if (!track) throw new Error("Camera video track is unavailable.");
      const preview = watchCameraPreview(video, stream, {
        isVisible: () => document.visibilityState === "visible" && viewRef.current === "scan",
        onReady: () => {
          if (operation !== cameraOperationRef.current || openingCameraRef.current || restoringCameraRef.current) return;
          if (cameraStateRef.current === "interrupted") setScanMessage("Camera recovered. Tap Snap or Live to continue.");
          setCameraState("ready");
        },
        onInterrupted: () => {
          if (operation === cameraOperationRef.current) cameraInterrupted();
        },
      });
      cameraPreviewRef.current = preview;
      track.onended = cameraInterrupted;
      track.onmute = cameraInterrupted;
      track.onunmute = () => preview.reset();
      await video.play();
      await preview.waitForFrame();
      await enableContinuousFocus(track);
      if (operation !== cameraOperationRef.current) throw new CameraChangedError();
      const settings = track.getSettings();
      const activeDeviceId = settings.deviceId ?? deviceId ?? "";
      setSelectedCameraId(activeDeviceId || "off");
      const cameras = await refreshCameras();
      const device = cameras.find((entry) => entry.deviceId === activeDeviceId);
      const label = device ? cameraLabel(device, cameras) : track.label || "Camera";
      setSourceLabel(settings.width && settings.height ? `${label} · ${settings.width}×${settings.height}` : label);
      const id = await beginSession("camera", undefined, () => operation === cameraOperationRef.current);
      const ready = preview.isHealthy();
      setCameraState(ready ? "ready" : "interrupted");
      setScanMessage(ready ? "Camera ready. Hold steady and tap Snap, or start Live." : "Camera preview stopped. Tap Restart camera to reconnect.");
      return id;
    })().catch((cameraError: unknown) => {
      if (operation !== cameraOperationRef.current) throw new CameraChangedError();
      stopMedia();
      setSelectedCameraId("off");
      throw cameraError;
    }).finally(() => {
      if (openingCameraRef.current === promise) openingCameraRef.current = null;
    });
    openingCameraRef.current = promise;
    return promise;
  };

  const ensureCamera = (): Promise<string> => {
    if (openingCameraRef.current) return openingCameraRef.current;
    if (restoringCameraRef.current) return restoringCameraRef.current;
    const operation = cameraOperationRef.current;
    const promise = (async () => {
      const video = videoRef.current;
      // Reconnection can finish before React commits its new session state.
      // Read the current session, so an older restore effect cannot reopen it.
      const activeSessionId = sessionIdRef.current;
      if (activeSessionId && source === "video" && objectUrlRef.current && video) {
        if (video.ended) { video.currentTime = 0; lastVideoTimeRef.current = -1; }
        if (video.paused) await video.play();
        if (operation !== cameraOperationRef.current) throw new CameraChangedError();
        return activeSessionId;
      }
      const stream = streamRef.current;
      const preview = cameraPreviewRef.current;
      if (stream?.getVideoTracks().some((track) => track.readyState === "live") && source === "camera" && activeSessionId && video && preview) {
        if (preview.isHealthy()) return activeSessionId;
        setCameraState("opening");
        setScanMessage("Reconnecting camera…");
        preview.reset();
        try {
          if (video.srcObject !== stream) video.srcObject = stream;
          await video.play();
          await preview.waitForFrame(3_000);
          if (operation !== cameraOperationRef.current) throw new CameraChangedError();
          setCameraState("ready");
          setScanMessage("Camera ready. Hold steady and tap Snap, or start Live.");
          return activeSessionId;
        } catch {
          if (operation !== cameraOperationRef.current) throw new CameraChangedError();
          // Replaying a live but frozen stream is insufficient: release and reacquire it.
        }
      }
      return openCamera(selectedCameraId === "off" ? undefined : selectedCameraId);
    })().finally(() => {
      if (restoringCameraRef.current === promise) restoringCameraRef.current = null;
    });
    restoringCameraRef.current = promise;
    return promise;
  };

  const startLiveScan = (activeSessionId: string) => {
    pauseScan();
    scanWantedRef.current = true;
    setScanning(true);
    const capture = () => {
      if (document.visibilityState !== "visible" || viewRef.current !== "scan") return;
      if (streamRef.current && !cameraPreviewRef.current?.isHealthy()) return;
      void submitFrame(activeSessionId).catch((captureError: unknown) => {
        stopScan();
        setError(captureError instanceof Error ? captureError.message : "Frame capture failed.");
      });
    };
    intervalRef.current = window.setInterval(
      capture,
      scanIntervalSecondsRef.current * 1_000,
    );
    firstCaptureRef.current = window.setTimeout(capture, 500);
  };

  const changeScanInterval = (seconds: number) => {
    scanIntervalSecondsRef.current = seconds;
    setScanIntervalSeconds(seconds);
    if (!scanning || !sessionId) return;
    startLiveScan(sessionId);
  };

  const toggleLiveScan = async () => {
    try {
      if (scanning) {
        stopScan();
        return;
      }
      const id = await ensureCamera();
      startLiveScan(id);
    } catch (cameraError) {
      showCameraError(cameraError);
    }
  };

  const takeSnapshot = async () => {
    try {
      const id = await ensureCamera();
      await submitFrame(id, true);
    } catch (cameraError) {
      showCameraError(cameraError, "Camera snapshot failed.");
    }
  };

  const selectCamera = async (deviceId: string) => {
    setCameraChooserOpen(false);
    if (deviceId === "restart") deviceId = selectedCameraId === "off" ? "auto" : selectedCameraId;
    if (deviceId === "off") {
      stopMedia();
      setSource("camera");
      setStillPreviewUrl(null);
      setSelectedCameraId("off");
      setSessionId(null);
      setSourceLabel("Camera off");
      setScanMessage("Camera off. Choose a camera or upload a photo.");
      return;
    }
    const resumeScanning = scanWantedRef.current;
    const promise = openCamera(deviceId === "auto" ? undefined : deviceId);
    const operation = cameraOperationRef.current;
    try {
      const id = await promise;
      if (operation !== cameraOperationRef.current) return;
      if (resumeScanning) startLiveScan(id);
    } catch (cameraError) {
      if (cameraError instanceof CameraChangedError) return;
      setSelectedCameraId("off");
      showCameraError(cameraError);
    }
  };

  const loadVideo = async (file: File) => {
    try {
      stopMedia();
      const operation = cameraOperationRef.current;
      setSelectedCameraId("off");
      setStillPreviewUrl(null);
      const url = URL.createObjectURL(file);
      objectUrlRef.current = url;
      if (!videoRef.current) return;
      videoRef.current.srcObject = null;
      videoRef.current.src = url;
      videoRef.current.muted = true;
      videoRef.current.loop = false;
      await videoRef.current.play();
      if (operation !== cameraOperationRef.current) return;
      setSourceLabel(file.name);
      const id = await beginSession("video", file.name, () => operation === cameraOperationRef.current);
      startLiveScan(id);
    } catch (videoError) {
      showCameraError(videoError, "Video could not be loaded.");
    }
  };

  const loadImage = async (file: File) => {
    try {
      stopMedia();
      const operation = cameraOperationRef.current;
      setSelectedCameraId("off");
      const url = URL.createObjectURL(file);
      objectUrlRef.current = url;
      setStillPreviewUrl(url);
      const image = new Image();
      image.src = url;
      await image.decode();
      if (operation !== cameraOperationRef.current) return;
      const canvas = canvasRef.current;
      if (!canvas) throw new Error("Image canvas is unavailable.");
      const dimensions = captureDimensions(image.naturalWidth, image.naturalHeight);
      canvas.width = dimensions.width;
      canvas.height = dimensions.height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Image canvas is unavailable.");
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
      if (!blob) throw new Error("The selected image could not be prepared.");
      if (operation !== cameraOperationRef.current) return;
      setSourceLabel(file.name);
      const id = await beginSession("image", file.name, () => operation === cameraOperationRef.current);
      await submitBlob(id, blob);
    } catch (imageError) {
      showCameraError(imageError, "Image could not be loaded.");
    }
  };

  function pauseScan() {
    if (intervalRef.current !== null) window.clearInterval(intervalRef.current);
    if (firstCaptureRef.current !== null) window.clearTimeout(firstCaptureRef.current);
    intervalRef.current = null;
    firstCaptureRef.current = null;
    setScanning(false);
  }

  function stopScan() { scanWantedRef.current = false; pauseScan(); }

  function cameraInterrupted() {
    if (!cameraWantedRef.current || openingCameraRef.current || restoringCameraRef.current
      || document.visibilityState !== "visible" || viewRef.current !== "scan") return;
    pauseScan();
    setCameraState("interrupted");
    setScanMessage("Camera preview stopped. Tap Restart camera to reconnect.");
  }

  const restartCamera = () => {
    if (openingCameraRef.current || restoringCameraRef.current) return;
    void selectCamera(selectedCameraId === "off" ? "auto" : selectedCameraId);
  };

  function stopMedia() {
    stopScan();
    cameraOperationRef.current += 1;
    cameraWantedRef.current = false;
    openingCameraRef.current = null;
    restoringCameraRef.current = null;
    cameraPreviewRef.current?.stop();
    cameraPreviewRef.current = null;
    setCameraState("off");
    sessionIdRef.current = null;
    setSessionId(null);
    scanWorkRef.current.invalidate();
    requestRef.current?.abort("source changed");
    streamQueueRef.current = [];
    if (streamTimerRef.current !== null) window.clearTimeout(streamTimerRef.current);
    streamTimerRef.current = null;
    streamRef.current?.getTracks().forEach((track) => {
      track.onended = null;
      track.onmute = null;
      track.onunmute = null;
      track.stop();
    });
    streamRef.current = null;
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.srcObject = null;
      videoRef.current.removeAttribute("src");
      videoRef.current.load();
    }
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = null;
    lastVideoTimeRef.current = -1;
  }

  const displayedItems = view === "scan" ? liveItems : historyItems;
  const cameraOverlayVisible = source === "camera" && cameraState !== "ready";

  useEffect(() => {
    const restore = async () => {
      if (document.visibilityState !== "visible" || view !== "scan") {
        pauseScan();
        cameraPreviewRef.current?.reset();
        if (source === "video") videoRef.current?.pause();
        return;
      }
      if (source === "video" && sessionId && scanWantedRef.current) {
        try {
          const id = await ensureCamera();
          startLiveScan(id);
        } catch (videoError) {
          stopScan();
          showCameraError(videoError, "Tap Live to resume the video.");
        }
        return;
      }
      if (!cameraWantedRef.current || source !== "camera" || openingCameraRef.current) return;
      const resumeScanning = scanWantedRef.current;
      try {
        const id = await ensureCamera();
        if (document.visibilityState === "visible" && viewRef.current === "scan" && resumeScanning) startLiveScan(id);
      } catch (cameraError) {
        if (cameraError instanceof CameraChangedError) return;
        stopScan();
        setCameraState("interrupted");
        setError(cameraError instanceof Error ? cameraError.message : "Tap Resume camera to reconnect.");
      }
    };
    const onVisibility = () => { void restore(); };
    const onPageShow = (event: PageTransitionEvent) => { if (event.persisted) void restore(); };
    void restore();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [view, source, sessionId]);

  useEffect(() => {
    if (view === "history") void queryClient.invalidateQueries({ queryKey: ["stats"] });
  }, [view, queryClient]);

  const openItem = (selected: DetectedItem, sourceView: View) => {
    const sourceItems = sourceView === "scan" ? liveItems : historyItems;
    setSelectedItem(selected);
    setSelectedFrameItems(sourceItems.filter((candidate) => candidate.thumbnailUrl === selected.thumbnailUrl));
    void navigate({
      to: "/finds/$itemId",
      params: { itemId: selected.id },
      search: { from: sourceView },
      resetScroll: false,
    });
  };

  const deleteFind = async (item: DetectedItem) => {
    setDeletingItemId(item.id);
    try {
      await deleteFindRequest(item.id);
      setLiveItems((current) => current.filter((candidate) => candidate.id !== item.id));
      await refreshHistory();
      setError(null);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Could not delete this find.");
    } finally {
      setDeletingItemId(null);
    }
  };

  const deleteAllFinds = async () => {
    setDeletingItemId("all");
    try {
      await deleteAllFindsRequest();
      setLiveItems([]);
      await queryClient.resetQueries({ queryKey: ["items"] });
      setSettingsOpen(false);
      setError(null);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Could not delete all finds.");
    } finally {
      setDeletingItemId(null);
    }
  };

  return (
    <div className={`app-shell ${view === "scan" ? "scan-shell" : "history-shell"}`}>
        <main className="immersive-scan" hidden={view !== "scan"}>
          <header className="scan-topbar">
            <label className="camera-select-control">
              <Camera size={14} />
              <select
                value={selectedCameraId}
                onChange={(event) => void selectCamera(event.target.value)}
                aria-label="Select camera"
              >
                <option value="off">Camera off</option>
                <option value="auto">Use rear camera</option>
                {cameraState !== "off" && <option value="restart">Restart camera</option>}
                {cameraDevices.map((device) => (
                  <option key={device.deviceId} value={device.deviceId} title={device.label}>
                    {cameraLabel(device, cameraDevices)}
                  </option>
                ))}
              </select>
            </label>
            <div className={`live-state ${scanning ? "is-live" : ""}`} aria-live="polite">
              <span />
              {inFlight > 0 ? `Analyzing ${elapsedSeconds}s` : scanning ? "Live" : cameraState === "opening" ? "Opening" : cameraState === "interrupted" ? "Interrupted" : cameraState === "ready" ? "Ready" : "Paused"}
            </div>
            <button className="settings-trigger" onClick={() => setSettingsOpen(true)} aria-label="Open settings">
              <Settings size={15} />
            </button>
            <section className="stats-ribbon scan-stats" aria-label="Live processing statistics">
              <div className="stat active-stat" title={`${inFlight} of 1 requests active`}>
                {inFlight > 0 ? <LoaderCircle className="spin" size={12} /> : <Gauge size={12} />}
                <strong>{inFlight}/1</strong>
                <span>Active</span>
              </div>
              <Stat label="Frames" value={stats.framesProcessed} />
              <Stat label="Items" value={stats.itemsIdentified} />
              <Stat label="Searches" value={stats.searchesPerformed} />
              <Stat label="Calls" value={stats.modelCalls} />
            </section>
          </header>
          <section className={`camera-stage ${cameraOverlayVisible ? "has-camera-overlay" : ""}`}>
            <video ref={videoRef} autoPlay muted playsInline onPause={cameraInterrupted} onError={cameraInterrupted} onEnded={() => streamRef.current ? cameraInterrupted() : stopScan()} />
            {stillPreviewUrl && <img className="still-preview" src={stillPreviewUrl} alt="Uploaded frame" />}
            {cameraOverlayVisible && (
              <div className="camera-empty" aria-label="Camera controls">
                <div className="reticle" aria-hidden="true"><ScanLine size={44} /></div>
                <p>{cameraState === "interrupted" ? "Camera preview stopped" : cameraState === "opening" ? "Connecting to your camera…" : "Find out what’s in front of you."}</p>
                {cameraState === "opening" ? <button className="camera-open-button" disabled><LoaderCircle className="spin" size={18} /> Connecting…</button>
                  : cameraState === "interrupted" ? <>
                    <button className="camera-open-button" onClick={restartCamera}><RotateCw size={18} /> Restart camera</button>
                    <button className="camera-switch-button" onClick={() => setCameraChooserOpen(true)}>Select another camera</button>
                  </> : <button className="camera-open-button" onClick={() => setCameraChooserOpen(true)}><Camera size={18} /> Select camera</button>}
              </div>
            )}
            <canvas ref={canvasRef} hidden />
          </section>
          {error && <div className="error-banner" role="alert">
            <span>{error}</span>
            <button onClick={() => setError(null)} aria-label="Dismiss error"><X size={16} /></button>
          </div>}
        </main>
      {view === "history" && (
        <main className="history-screen">
          <header className="history-heading">
            <div>
              <p className="eyebrow">All-time finds</p>
              <h1>History</h1>
            </div>
            <div className="history-actions">
              <button className="icon-button" onClick={() => void refreshHistory()} aria-label="Refresh history">
                <History size={20} />
              </button>
              <button className="icon-button" onClick={() => setSettingsOpen(true)} aria-label="Open settings">
                <Settings size={19} />
              </button>
            </div>
          </header>
          <section className="stats-ribbon history-stats" aria-label="Processing statistics">
            <Stat label="Frames" value={stats.framesProcessed} />
            <Stat label="Items" value={stats.itemsIdentified} />
            <Stat label="Searches" value={stats.searchesPerformed} />
            <Stat label="Calls" value={stats.modelCalls} />
          </section>
          {(lastFrameUrl || inFlight > 0) && <section className="scan-feedback" aria-label="Last scan result">
            {lastFrameUrl && <button className="last-frame-button" onClick={() => setFramePreviewOpen(true)} aria-label="View full frame sent to AI">
              <img src={lastFrameUrl} alt="Last frame sent to AI" />
              <span>AI frame</span>
            </button>}
            <div>
              <p role="status">{inFlight > 0 ? `Analyzing… ${elapsedSeconds}s${elapsedSeconds >= 10 ? " · Checking sources can take a little longer." : ""}` : scanMessage}</p>
              {findCriteria && <button className="active-filter" onClick={() => updateFindCriteria("")} title="Clear the active filter">Filter: {findCriteria} <X size={12} /></button>}
            </div>
          </section>}
          <div className="history-search">
            <Search size={18} aria-hidden="true" />
            <input type="search" aria-label="Search all history" placeholder="Search all finds, brands, descriptions…"
              maxLength={500} value={historySearch} onChange={(event) => setHistorySearch(event.target.value)} />
            {historySearch && <button onClick={() => setHistorySearch("")} aria-label="Clear history search"><X size={18} /></button>}
          </div>
          {error && (
            <div className="error-banner history-error">
              <span>{error}</span>
              <button onClick={() => setError(null)} aria-label="Dismiss error"><X size={16} /></button>
            </div>
          )}
          <section className="finds-section" aria-busy={history.isFetching || searchPending}>
            <HistoryLoading query={history} searchPending={searchPending} />
            <div className="item-feed">
              {displayedItems.map((item) => (
                <ItemCard key={`${item.id}-history`} item={item} showCapturedAt onSelect={(selected) => openItem(selected, "history")} />
              ))}
              {displayedItems.length === 0 && !history.isPending && !history.isError && !searchPending && (
                <div className="empty-feed">
                  <CircleDollarSign size={36} />
                  <p>{debouncedSearch ? "No finds match your search." : "No saved finds yet."}</p>
                </div>
              )}
            </div>
            <HistoryLoadMore query={history} disabled={searchPending} />
          </section>
        </main>
      )}

      <nav className={`bottom-nav ${view === "scan" ? "scan-nav" : ""}`} aria-label="Primary navigation">
        <Link to="/scan" className={view === "scan" ? "active" : ""}>
          <ScanLine /> <span>Scan</span>
        </Link>
        {view === "scan" && <>
          <button
            className={`dock-action ${scanning ? "is-active" : ""}`}
            disabled={cameraState === "opening"}
            onClick={() => void toggleLiveScan()}
            aria-label={scanning ? "Stop live scanning" : "Start live scanning"}
          >
            {scanning ? <Square size={18} fill="currentColor" /> : <ScanLine size={20} />}
            <span>{scanning ? "Stop" : "Live"}</span>
          </button>
          <button className="dock-action snapshot-action" disabled={cameraState === "opening" || inFlight > 0} onClick={() => void takeSnapshot()} aria-label="Take snapshot">
            <Camera size={22} />
            <span>Snap</span>
          </button>
          <label className="dock-action dock-upload" aria-label="Upload a photo or video">
            <ImageUp size={20} />
            <span>Upload</span>
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,image/*,video/mp4,video/quicktime,video/*"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file?.type.startsWith("image/")) void loadImage(file);
                else if (file) void loadVideo(file);
                event.currentTarget.value = "";
              }}
            />
          </label>
        </>}
        <Link to="/history" className={view === "history" ? "active" : ""} onClick={() => void refreshHistory()}>
          <Archive /> <span>History {view === "scan" && liveItems.length > 0 && <b className="find-count">{liveItems.length}</b>}</span>
        </Link>
      </nav>

      {cameraChooserOpen && <dialog className="camera-chooser" ref={cameraChooserRef} aria-labelledby="camera-chooser-title" onCancel={() => setCameraChooserOpen(false)}>
        <header>
          <h2 id="camera-chooser-title">Select camera</h2>
          <button className="close-button" onClick={() => setCameraChooserOpen(false)} aria-label="Close camera selector"><X size={20} /></button>
        </header>
        <button className="camera-choice primary-camera-choice" aria-label="Use rear camera" onClick={() => void selectCamera("auto")}><Camera size={20} /><span>Use rear camera<small>Let your phone choose the main camera</small></span></button>
        {cameraDevices.filter((device) => device.label).map((device) => <button className="camera-choice" key={device.deviceId} onClick={() => void selectCamera(device.deviceId)}>
          <Camera size={20} /><span>{cameraLabel(device, cameraDevices)}</span>
        </button>)}
        {!cameraDevices.some((device) => device.label) && <p>Allow camera access to see all available cameras.</p>}
      </dialog>}

      {settingsOpen && (
        <div className="settings-backdrop" onMouseDown={() => setSettingsOpen(false)}>
          <section
            className="settings-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <p className="eyebrow">Saved inventory</p>
                <h2 id="settings-title">Settings</h2>
                <p className="eyebrow">Version {__APP_VERSION__} · Reliability update</p>
              </div>
              <button onClick={() => setSettingsOpen(false)} aria-label="Close settings"><X size={18} /></button>
            </header>
            <div className="settings-find-list">
              {hasUpdate && <button className="app-update-button" onClick={() => { stopMedia(); void installAppUpdate(); }}>Update app</button>}
              {sessionId && <div className="settings-camera">
                <p>{sourceLabel}</p>
                {source === "camera" && <button className="camera-switch-button" disabled={cameraState === "opening"} onClick={restartCamera}><RotateCw size={14} /> Restart camera</button>}
              </div>}
              <div className="settings-text-field">
                <label htmlFor="find-criteria">Find criteria</label>
                <textarea
                  id="find-criteria"
                  rows={3}
                  maxLength={1000}
                  value={findCriteria}
                  placeholder="Vintage band tees worth more than $40"
                  onChange={(event) => updateFindCriteria(event.target.value)}
                />
                <div className="criteria-presets" aria-label="Quick find criteria">
                  {FIND_CRITERIA_PRESETS.map((preset) => (
                    <button
                      key={preset.label}
                      type="button"
                      className={findCriteria === preset.value ? "active" : ""}
                      onClick={() => updateFindCriteria(preset.value)}
                    >
                      {preset.label}
                    </button>
                  ))}
                  {findCriteria && <button type="button" onClick={() => updateFindCriteria("")}>Clear</button>}
                </div>
              </div>
              <p className="settings-note">Frames run one at a time, so answers stay in order. Live pauses while the app is in the background. The portrait preview fills your screen; the AI receives the full frame.</p>
              <div className="settings-range">
                <label htmlFor="scan-frequency">
                  <span>Live scan frequency</span>
                  <strong>{scanIntervalSeconds}s</strong>
                </label>
                <input
                  id="scan-frequency"
                  type="range"
                  min="1"
                  max="30"
                  step="1"
                  value={scanIntervalSeconds}
                  onChange={(event) => changeScanInterval(Number(event.target.value))}
                />
                <div><span>1s</span><span>30s</span></div>
              </div>
              <HistoryLoading query={savedFinds} />
              {settingsItems.map((item) => (
                <div className="settings-find" key={item.id}>
                  <img src={item.thumbnailUrl} alt="" />
                  <div>
                    <strong>{item.name}</strong>
                    <span>{formatRange(item)}</span>
                  </div>
                  <button
                    onClick={() => void deleteFind(item)}
                    disabled={deletingItemId !== null}
                    aria-label={`Delete ${item.name}`}
                  >
                    {deletingItemId === item.id ? <LoaderCircle className="spin" size={17} /> : <Trash2 size={17} />}
                  </button>
                </div>
              ))}
              {settingsItems.length === 0 && !savedFinds.isPending && !savedFinds.isError && <p className="settings-empty">No saved finds.</p>}
              <HistoryLoadMore query={savedFinds} />
            </div>
            <footer>
              <button
                className="delete-all-button"
                onClick={() => void deleteAllFinds()}
                disabled={settingsItems.length === 0 || deletingItemId !== null}
              >
                {deletingItemId === "all" ? <LoaderCircle className="spin" size={17} /> : <Trash2 size={17} />}
                Delete all finds
              </button>
              <span>Processing stats are kept.</span>
            </footer>
          </section>
        </div>
      )}

      {framePreviewOpen && lastFrameUrl && <div className="modal-backdrop" onClick={() => setFramePreviewOpen(false)}>
        <section className="frame-preview-sheet" role="dialog" aria-modal="true" aria-label="Full frame sent to AI" onClick={(event) => event.stopPropagation()}>
          <header><h2>Full frame sent to AI</h2><button className="close-button" onClick={() => setFramePreviewOpen(false)} aria-label="Close frame preview"><X size={20} /></button></header>
          <img src={lastFrameUrl} alt="Full uncropped frame submitted for analysis" />
        </section>
      </div>}

      {selectedItem && (
        <ItemDetail
          item={selectedItem}
          frameItems={selectedFrameItems.length > 0 ? selectedFrameItems : [selectedItem]}
          onSelect={(nextItem) => {
            setSelectedItem(nextItem);
            void navigate(
              activityOpen
                ? {
                    to: "/finds/$itemId/activity",
                    params: { itemId: nextItem.id },
                    search: { from: view },
                    replace: true,
                    resetScroll: false,
                  }
                : {
                    to: "/finds/$itemId",
                    params: { itemId: nextItem.id },
                    search: { from: view },
                    replace: true,
                    resetScroll: false,
                  },
            );
          }}
          activityOpen={activityOpen}
          onToggleActivity={() => {
            void navigate(
              activityOpen
                ? { to: "/finds/$itemId", params: { itemId: selectedItem.id }, search: { from: view }, resetScroll: false }
                : { to: "/finds/$itemId/activity", params: { itemId: selectedItem.id }, search: { from: view }, resetScroll: false },
            );
          }}
          onClose={() => {
            void navigate({ to: view === "scan" ? "/scan" : "/history", resetScroll: false });
          }}
        />
      )}
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat">
      <strong>{value.toLocaleString()}</strong>
      <span>{label}</span>
    </div>
  );
}

function HistoryLoading({ query, searchPending = false }: { query: ReturnType<typeof useHistory>; searchPending?: boolean }) {
  if (query.isError) return (
    <div className="history-status" role="alert">
      <span>{query.error.message}</span>
      <button className="history-load-more" onClick={() => void (query.isFetchNextPageError ? query.fetchNextPage() : query.refetch())} disabled={query.isFetching}>Retry</button>
    </div>
  );
  if (query.isFetching || searchPending) return <p className="history-status" role="status">{searchPending ? "Searching…" : "Loading finds…"}</p>;
  return null;
}

function HistoryLoadMore({ query, disabled = false }: { query: ReturnType<typeof useHistory>; disabled?: boolean }) {
  if (!query.hasNextPage) return null;
  return <button className="history-load-more" disabled={disabled || query.isFetching} onClick={() => void query.fetchNextPage()}>
    {query.isFetchingNextPage ? "Loading…" : "Load more finds"}
  </button>;
}

function CapturedTime({ timestamp }: { timestamp?: string | null }) {
  if (!timestamp || Number.isNaN(Date.parse(timestamp))) return null;
  const date = new Date(timestamp);
  return <time className="captured-time" dateTime={date.toISOString()}>
    Snapped {date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
  </time>;
}

function ItemCard({
  item,
  animate,
  overlay,
  showCapturedAt,
  onSelect,
}: {
  item: DetectedItem;
  animate?: boolean;
  overlay?: boolean;
  showCapturedAt?: boolean;
  onSelect: (item: DetectedItem) => void;
}) {
  return (
    <button
      className={`item-card${animate ? " stream-in" : ""}${overlay ? " overlay-card" : ""}`}
      onClick={() => onSelect(item)}
    >
      <div className="thumbnail-wrap">
        <ItemThumbnail item={item} />
        <span className="confidence">{Math.round(item.confidence * 100)}%</span>
      </div>
      <div className="item-copy">
        <div className="item-meta">
          <span>{item.category}</span>
          {item.duplicate && <span className="repeat-badge">Seen {item.seenCount}×</span>}
          {!showCapturedAt && <RelativeTime timestamp={item.firstSeenAt} />}
        </div>
        {showCapturedAt && <CapturedTime timestamp={item.lastSeenAt} />}
        <h3>{item.name}</h3>
        <p>{item.valueSummary}</p>
        <div className="price-comparison card-prices">
          <div className="price-box resale-price">
            <span>Resale</span>
            <strong>{formatRange(item)}</strong>
          </div>
          <div className="price-box retail-price">
            <span>Retail</span>
            <strong>{item.retailPriceCents === null ? "—" : money(item.retailPriceCents, item.currency)}</strong>
          </div>
        </div>
        {item.observedPriceCents !== null && <span className="tag-price">Tag {money(item.observedPriceCents, item.currency)}</span>}
      </div>
      <ChevronRight className="card-chevron" size={20} />
    </button>
  );
}

function RelativeTime({ timestamp }: { timestamp: string }) {
  const [now, setNow] = useState(Date.now());
  const foundAt = Date.parse(timestamp);
  const ageMs = Math.max(0, now - foundAt);

  useEffect(() => {
    const refreshMs = ageMs < 60_000 ? 1_000 : ageMs < 3_600_000 ? 60_000 : 3_600_000;
    const timer = window.setTimeout(() => setNow(Date.now()), refreshMs);
    return () => window.clearTimeout(timer);
  }, [ageMs]);

  return (
    <time className="found-time" dateTime={timestamp} title={new Date(foundAt).toLocaleString()}>
      {formatRelativeTime(ageMs)}
    </time>
  );
}

function formatRelativeTime(ageMs: number) {
  const seconds = Math.floor(ageMs / 1_000);
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"} ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function ItemDetail({
  item,
  frameItems,
  activityOpen,
  onToggleActivity,
  onSelect,
  onClose,
}: {
  item: DetectedItem;
  frameItems: DetectedItem[];
  activityOpen: boolean;
  onToggleActivity: () => void;
  onSelect: (item: DetectedItem) => void;
  onClose: () => void;
}) {
  const [hoveredItemId, setHoveredItemId] = useState<string | null>(null);
  const modalRef = useRef<HTMLElement>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const downloadImage = async () => {
    if (!modalRef.current || downloading) return;
    const modal = modalRef.current;
    setDownloading(true);
    setDownloadError(null);
    try {
      const { downloadModalImage } = await import("./download-modal");
      await downloadModalImage(modal, `${item.name}${activityOpen ? "-activity" : ""}`);
    } catch {
      setDownloadError("Could not download the image. Check your connection and try again.");
    } finally {
      setDownloading(false);
    }
  };
  const frameListRef = useRef<HTMLDivElement>(null);
  const frameItemRefs = useRef(new Map<string, HTMLButtonElement>());
  const highlightedItemId = hoveredItemId ?? item.id;
  const marketEvidence = collectMarketEvidence(item);

  useEffect(() => {
    if (!hoveredItemId) return;
    const list = frameListRef.current;
    const matchedItem = frameItemRefs.current.get(hoveredItemId);
    if (!list || !matchedItem) return;

    const itemLeft = matchedItem.offsetLeft;
    const itemRight = itemLeft + matchedItem.offsetWidth;
    const visibleLeft = list.scrollLeft;
    const visibleRight = visibleLeft + list.clientWidth;
    if (itemLeft >= visibleLeft && itemRight <= visibleRight) return;

    const centeredLeft = matchedItem.offsetLeft - (list.clientWidth - matchedItem.offsetWidth) / 2;
    list.scrollTo({ left: centeredLeft, behavior: "instant" });
  }, [hoveredItemId]);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <article ref={modalRef} className="detail-sheet" onMouseDown={(event) => event.stopPropagation()}>
        <button className="download-image-button" data-export-exclude onClick={() => void downloadImage()} disabled={downloading} aria-label={downloading ? "Downloading image" : "Download modal as image"}>
          {downloading ? <LoaderCircle className="spin" size={18} /> : <Download size={18} />}
          {downloading ? "Preparing…" : "Download image"}
        </button>
        <button className="close-button" data-export-exclude onClick={onClose} aria-label="Close"><X /></button>
        <div className="detail-scroll">
          <div className="detail-visual">
            <AnnotatedImage
              key={item.thumbnailUrl}
              items={frameItems}
              activeItemId={highlightedItemId}
              onHoverItem={setHoveredItemId}
            />
          </div>
          <div className="detail-content">
          {downloadError && <p className="download-image-error" data-export-exclude role="alert">{downloadError}</p>}
          <p className="eyebrow">{frameItems.length} item{frameItems.length === 1 ? "" : "s"} found in this frame</p>
          <div ref={frameListRef} className="frame-find-list">
            {frameItems.map((frameItem) => (
              <button
                key={frameItem.id}
                ref={(element) => {
                  if (element) frameItemRefs.current.set(frameItem.id, element);
                  else frameItemRefs.current.delete(frameItem.id);
                }}
                className={frameItem.id === highlightedItemId ? "active" : ""}
                onClick={() => onSelect(frameItem)}
                onMouseEnter={() => setHoveredItemId(frameItem.id)}
                onMouseLeave={() => setHoveredItemId(null)}
              >
                <span>{frameItem.category}</span>
                <strong>{frameItem.name}</strong>
                <b>{formatRange(frameItem)}</b>
              </button>
            ))}
          </div>
          <button className="agent-activity-toggle" data-export-exclude onClick={onToggleActivity}>
            <Bot size={17} /> {activityOpen ? "Back to find" : "Agent activity"}
          </button>
          {activityOpen ? (
            <AgentActivity itemId={item.id} />
          ) : (
            <>
              <p className="eyebrow">{item.category} · {Math.round(item.confidence * 100)}% confidence</p>
              <h2>{item.name}</h2>
              <p className="detail-description">{item.description}</p>
              <div className="detail-values">
                <div className="price-comparison">
                  <div className="price-box resale-price">
                    <span>Estimated resale</span>
                    <strong>{formatRange(item)}</strong>
                  </div>
                  <div className="price-box retail-price">
                    <span>Estimated retail</span>
                    <strong>{item.retailPriceCents === null ? "—" : money(item.retailPriceCents, item.currency)}</strong>
                  </div>
                </div>
                <p>{item.valueSummary}</p>
              </div>
              <a
                className="lens-search-link"
                data-export-exclude
                href={`https://www.google.com/search?q=${encodeURIComponent([item.brand, item.model, item.name].filter(Boolean).join(" "))}`}
                target="_blank"
                rel="noreferrer"
              >
                <Search size={17} /> Search this item <ExternalLink size={15} />
              </a>
              {marketEvidence.length > 0 && (
                <section className="comparables">
                  <h3>Sold comps & web results</h3>
                  {marketEvidence.map((comparable, index) => {
                    const content = (
                      <>
                        <span className={`comp-type ${comparable.type}`}>{comparable.type}</span>
                        <span>{comparable.title}</span>
                        <strong>{comparable.priceCents === null ? "—" : money(comparable.priceCents, comparable.currency)}</strong>
                        {comparable.url && <ExternalLink size={15} />}
                      </>
                    );
                    return comparable.url ? (
                      <a key={`${comparable.title}-${index}`} href={comparable.url} target="_blank" rel="noreferrer">{content}</a>
                    ) : (
                      <div key={`${comparable.title}-${index}`}>{content}</div>
                    );
                  })}
                </section>
              )}
              <dl className="facts">
                <div><dt>Brand</dt><dd>{item.brand ?? "Unknown"}</dd></div>
                <div><dt>Model</dt><dd>{item.model ?? "Unknown"}</dd></div>
                <div><dt>Condition</dt><dd>{item.condition}</dd></div>
                <div><dt>Seen</dt><dd>{item.seenCount} time{item.seenCount === 1 ? "" : "s"}</dd></div>
              </dl>
            </>
          )}
          </div>
        </div>
      </article>
    </div>
  );
}

function AgentActivity({ itemId }: { itemId: string }) {
  const { data, error, isPending } = useQuery({
    queryKey: ["agent-run", itemId],
    queryFn: () => fetchAgentRun(itemId),
    retry: false,
  });

  if (isPending) {
    return <div className="agent-activity-state"><LoaderCircle className="spin" /> Loading activity</div>;
  }
  if (error || !data) {
    return <div className="agent-activity-state error">{error instanceof Error ? error.message : "Agent activity unavailable."}</div>;
  }

  return (
    <section className="agent-activity">
      <header>
        <div>
          <span>{data.model}</span>
          <strong>{(data.latencyMs / 1_000).toFixed(1)}s</strong>
        </div>
        <div>
          <span>Calls</span>
          <strong>{data.modelCalls}</strong>
        </div>
        <div>
          <span>Searches</span>
          <strong>{data.searchesPerformed}</strong>
        </div>
        <div>
          <span>Items</span>
          <strong>{data.itemCount}</strong>
        </div>
      </header>

      <AuditBlock title="Agent instructions" value={data.instructions} open />
      <AuditBlock title="Input" value={data.input} open />

      <div className="agent-timeline">
        {data.events.map((event) => (
          <article key={`${event.sequence}-${event.type}`}>
            <span className="timeline-index">{event.sequence + 1}</span>
            <div>
              <h4>{event.title}</h4>
              <pre>{prettyAuditValue(event.data)}</pre>
            </div>
          </article>
        ))}
        {data.events.length === 0 && <p>No agent events were recorded.</p>}
      </div>

      <AuditBlock title={`Raw model responses · ${data.rawResponses.length}`} value={data.rawResponses} />
      <AuditBlock title="Final structured output" value={data.output} />
      <AuditBlock title="Usage" value={data.usage} />
    </section>
  );
}

function AuditBlock({ title, value, open = false }: { title: string; value: unknown; open?: boolean }) {
  return (
    <details className="audit-block" open={open}>
      <summary>{title}</summary>
      <pre>{prettyAuditValue(value)}</pre>
    </details>
  );
}

function prettyAuditValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function ItemThumbnail({ item }: { item: DetectedItem }) {
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null);
  const box = item.boundingBox;
  const crop = box && imageSize ? paddedCrop(box, imageSize) : null;

  return (
    <>
      <img
        className={crop ? "thumbnail-source is-cropped" : "thumbnail-source"}
        src={item.thumbnailUrl}
        alt=""
        loading="lazy"
        onLoad={(event) => {
          const image = event.currentTarget;
          setImageSize({ width: image.naturalWidth, height: image.naturalHeight });
        }}
      />
      {crop && imageSize && (
        <svg className="cropped-thumbnail" viewBox={`${crop.x} ${crop.y} ${crop.width} ${crop.height}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
          <image href={item.thumbnailUrl} width={imageSize.width} height={imageSize.height} />
        </svg>
      )}
    </>
  );
}

function paddedCrop(
  box: NonNullable<DetectedItem["boundingBox"]>,
  imageSize: { width: number; height: number },
) {
  const x = (box.xMin / 1000) * imageSize.width;
  const y = (box.yMin / 1000) * imageSize.height;
  const width = ((box.xMax - box.xMin) / 1000) * imageSize.width;
  const height = ((box.yMax - box.yMin) / 1000) * imageSize.height;
  const paddingX = Math.max(width * 0.18, imageSize.width * 0.02);
  const paddingY = Math.max(height * 0.18, imageSize.height * 0.02);
  const cropX = Math.max(0, x - paddingX);
  const cropY = Math.max(0, y - paddingY);
  return {
    x: cropX,
    y: cropY,
    width: Math.min(imageSize.width - cropX, width + paddingX * 2),
    height: Math.min(imageSize.height - cropY, height + paddingY * 2),
  };
}

function AnnotatedImage({
  items,
  activeItemId,
  onHoverItem,
}: {
  items: DetectedItem[];
  activeItemId: string;
  onHoverItem: (itemId: string | null) => void;
}) {
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null);
  const imageUrl = items[0]?.thumbnailUrl;

  return (
    <div className="annotated-image">
      <img
        src={imageUrl}
        alt=""
        onLoad={(event) => {
          const image = event.currentTarget;
          setImageSize({ width: image.naturalWidth, height: image.naturalHeight });
        }}
      />
      {imageSize && (
        <svg
          className="item-box-overlay"
          viewBox={`0 0 ${imageSize.width} ${imageSize.height}`}
          preserveAspectRatio="xMidYMid meet"
          aria-hidden="true"
        >
          {items.map((frameItem) => {
            const box = frameItem.boundingBox;
            if (!box) return null;
            return (
              <rect
                key={frameItem.id}
                className={frameItem.id === activeItemId ? "active" : ""}
                x={(box.xMin / 1000) * imageSize.width}
                y={(box.yMin / 1000) * imageSize.height}
                width={((box.xMax - box.xMin) / 1000) * imageSize.width}
                height={((box.yMax - box.yMin) / 1000) * imageSize.height}
                rx="5"
                vectorEffect="non-scaling-stroke"
                onMouseEnter={() => onHoverItem(frameItem.id)}
                onMouseLeave={() => onHoverItem(null)}
              />
            );
          })}
        </svg>
      )}
    </div>
  );
}

function formatRange(item: DetectedItem): string {
  if (item.estimatedLowCents === null && item.estimatedHighCents === null) return "Value pending";
  if (item.estimatedLowCents === item.estimatedHighCents || item.estimatedHighCents === null) {
    return money(item.estimatedLowCents ?? item.estimatedHighCents ?? 0, item.currency);
  }
  return `${money(item.estimatedLowCents ?? 0, item.currency)}–${money(item.estimatedHighCents, item.currency)}`;
}

function collectMarketEvidence(item: DetectedItem) {
  const evidence: Array<{
    title: string;
    url: string | null;
    priceCents: number | null;
    currency: string;
    type: "retail" | "active" | "sold" | "web";
  }> = item.comparables.map((comparable) => ({ ...comparable }));
  const knownUrls = new Set(evidence.map((entry) => entry.url).filter(Boolean));
  const markdownLink = /\[([^\]]+)]\((https?:\/\/[^)]+)\)/g;
  for (const match of item.valueSummary.matchAll(markdownLink)) {
    const [, title, url] = match;
    if (!url || knownUrls.has(url)) continue;
    evidence.push({ title: title || "Web result", url, priceCents: null, currency: item.currency, type: "web" });
    knownUrls.add(url);
  }
  return evidence;
}

function money(cents: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: currency || "USD",
    currencyDisplay: "narrowSymbol",
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}
