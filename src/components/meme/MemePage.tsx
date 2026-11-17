import { ActionIcon, Button, Stack, Text } from "@mantine/core";
import { useDisclosure, useHotkeys, useStateHistory } from "@mantine/hooks";
import {
  IconArrowBackUp,
  IconArrowForwardUp,
  IconDownload,
  IconFocusCentered,
  IconGridDots,
  IconHandStop,
  IconMenu2,
  IconPencil,
  IconPhoto,
  IconTrash,
  IconUpload,
} from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";

import {
  StaffGrid,
  StaffGridSidebar,
  type StaffGridRef,
} from "@hextools/react";
import { useIsTouchscreen } from "@hextools/react";
import {
  DEFAULT_PATTERN_TYPE,
  GuiSpellcasting,
  type GuiSpellcastingSettings,
  type NamedResolvedPatternType,
  type ResolvedPattern,
} from "@hextools/renderer/staffGrid";

import { useI18n } from "../../i18n/I18nContext";
import HexParseInput from "../staffGrid/HexParseInput";
import { staffGridButtonProps } from "../staffGrid/StaffGrid.lib";
import StaffGridPalette from "../staffGrid/StaffGridPalette";

type MemeTool = "draw" | "image";

interface ImageTransform {
  /** Offset of the photo center from the stage center, in CSS pixels. */
  x: number;
  y: number;
  scale: number;
}

interface LoadedImage {
  url: string;
  width: number;
  height: number;
}

const MIN_IMAGE_SCALE = 0.05;
const MAX_IMAGE_SCALE = 20;

function clampScale(scale: number) {
  return Math.min(MAX_IMAGE_SCALE, Math.max(MIN_IMAGE_SCALE, scale));
}

function containScale(
  imageWidth: number,
  imageHeight: number,
  stageWidth: number,
  stageHeight: number,
) {
  if (
    imageWidth <= 0
    || imageHeight <= 0
    || stageWidth <= 0
    || stageHeight <= 0
  ) {
    return 1;
  }
  return clampScale(
    Math.min(stageWidth / imageWidth, stageHeight / imageHeight),
  );
}

/** Point relative to the center of `stage`. */
function stagePoint(stage: DOMRect, clientX: number, clientY: number) {
  return {
    x: clientX - stage.left - stage.width / 2,
    y: clientY - stage.top - stage.height / 2,
  };
}

/**
 * Scale the photo by `factor` so `prevPoint` moves to `nextPoint`.
 * Points are relative to the stage center.
 */
function zoomImage(
  current: ImageTransform,
  prevPoint: { x: number; y: number },
  nextPoint: { x: number; y: number },
  factor: number,
): ImageTransform {
  const scale = clampScale(current.scale * factor);
  const applied = scale / current.scale;
  return {
    scale,
    x: nextPoint.x - (prevPoint.x - current.x) * applied,
    y: nextPoint.y - (prevPoint.y - current.y) * applied,
  };
}

/** Place imported patterns to the right of what's already drawn, in the chosen color. */
function appendImportedPatterns(
  existing: readonly ResolvedPattern[],
  imported: readonly ResolvedPattern[],
  type: NamedResolvedPatternType,
): ResolvedPattern[] {
  if (imported.length === 0) {
    return [...existing];
  }

  let maxQ = -Infinity;
  for (const { pattern, origin } of existing) {
    for (const pos of pattern.positions(origin)) {
      maxQ = Math.max(maxQ, pos.q);
    }
  }

  let minQ = Infinity;
  for (const { pattern, origin } of imported) {
    for (const pos of pattern.positions(origin)) {
      minQ = Math.min(minQ, pos.q);
    }
  }

  const shift = Number.isFinite(maxQ) ? maxQ + 2 - minQ : 0;
  return [
    ...existing,
    ...imported.map((pattern) => ({
      ...pattern,
      type,
      origin: { q: pattern.origin.q + shift, r: pattern.origin.r },
    })),
  ];
}

function nextFrame() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function isTypingTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLElement
    && (target.isContentEditable
      || target.tagName === "INPUT"
      || target.tagName === "TEXTAREA")
  );
}

export default function MemePage() {
  const { t } = useI18n();
  const isTouchscreen = useIsTouchscreen();
  const staffRef = useRef<StaffGridRef>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageUrlRef = useRef<string | null>(null);
  const exportingRef = useRef(false);
  const loadRequestRef = useRef(0);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{ distance: number; cx: number; cy: number } | null>(
    null,
  );

  const [patterns, patternsHandlers, patternsHistory] = useStateHistory<
    readonly ResolvedPattern[]
  >([]);
  const [patternType, setPatternType] =
    useState<NamedResolvedPatternType>(DEFAULT_PATTERN_TYPE);
  const [settings, setSettings] = useState<GuiSpellcastingSettings>(() => ({
    ...GuiSpellcasting.getDefaultSettings({ isTouchscreen }),
    // The palette picks the color; don't swap it for intro/retro patterns.
    autoPatternType: false,
    dotsMode: "mouse",
  }));
  const [loaded, setLoaded] = useState<LoadedImage | null>(null);
  const [imageTransform, setImageTransform] = useState<ImageTransform>({
    x: 0,
    y: 0,
    scale: 1,
  });
  const [tool, setTool] = useState<MemeTool>("draw");
  const [spaceDown, setSpaceDown] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [imageError, setImageError] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [imagePanning, setImagePanning] = useState(false);
  const [sidebarOpen, { toggle: toggleSidebar, close: closeSidebar }] =
    useDisclosure(false);

  const effectiveTool: MemeTool = spaceDown && tool === "draw" ? "image" : tool;
  const gridSettings: GuiSpellcastingSettings = exporting
    ? { ...settings, dotsMode: "none" }
    : settings;

  useEffect(() => {
    return () => {
      loadRequestRef.current += 1;
      if (imageUrlRef.current) {
        URL.revokeObjectURL(imageUrlRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.code !== "Space"
        || event.repeat
        || isTypingTarget(event.target)
      ) {
        return;
      }
      event.preventDefault();
      staffRef.current?.cancelPattern();
      setSpaceDown(true);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code !== "Space") {
        return;
      }
      setSpaceDown(false);
      if (tool === "draw") {
        pointersRef.current.clear();
        pinchRef.current = null;
        setImagePanning(false);
      }
    };
    const onBlur = () => {
      setSpaceDown(false);
      pointersRef.current.clear();
      pinchRef.current = null;
      setImagePanning(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [tool]);

  useHotkeys([
    ["Escape", () => staffRef.current?.cancelPattern()],
    ["mod+Z", () => patternsHandlers.back()],
    ["mod+Y", () => patternsHandlers.forward()],
    ["mod+shift+Z", () => patternsHandlers.forward()],
  ]);

  const fitImage = (width: number, height: number) => {
    const rect = stageRef.current?.getBoundingClientRect();
    setImageTransform({
      x: 0,
      y: 0,
      scale: containScale(
        width,
        height,
        rect?.width ?? width,
        rect?.height ?? height,
      ),
    });
  };

  const loadImageFile = (file: File | undefined) => {
    if (file == null || (file.type !== "" && !file.type.startsWith("image/"))) {
      return;
    }
    const requestId = ++loadRequestRef.current;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      if (requestId !== loadRequestRef.current) {
        URL.revokeObjectURL(url);
        return;
      }
      if (imageUrlRef.current) {
        URL.revokeObjectURL(imageUrlRef.current);
      }
      imageUrlRef.current = url;
      setImageError(false);
      setLoaded({ url, width: img.naturalWidth, height: img.naturalHeight });
      fitImage(img.naturalWidth, img.naturalHeight);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      if (requestId === loadRequestRef.current) {
        setImageError(true);
      }
    };
    img.src = url;
  };

  const openFilePicker = () => {
    fileInputRef.current?.click();
  };

  const zoomAt = (clientX: number, clientY: number, factor: number) => {
    const stage = stageRef.current?.getBoundingClientRect();
    if (stage == null) {
      return;
    }
    const point = stagePoint(stage, clientX, clientY);
    setImageTransform((current) => zoomImage(current, point, point, factor));
  };

  const rememberPinch = () => {
    const points = [...pointersRef.current.values()];
    if (points.length >= 2) {
      const [a, b] = points;
      pinchRef.current = {
        distance: Math.hypot(a.x - b.x, a.y - b.y),
        cx: (a.x + b.x) / 2,
        cy: (a.y + b.y) / 2,
      };
    } else {
      pinchRef.current = null;
    }
    setImagePanning(points.length > 0);
  };

  const onImagePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    pointersRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    rememberPinch();
  };

  const onImagePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const prev = pointersRef.current.get(event.pointerId);
    if (prev == null) {
      return;
    }
    const next = { x: event.clientX, y: event.clientY };
    pointersRef.current.set(event.pointerId, next);
    const stage = stageRef.current?.getBoundingClientRect();
    const pinch = pinchRef.current;
    if (stage != null && pinch != null && pointersRef.current.size >= 2) {
      const points = [...pointersRef.current.values()];
      const [a, b] = points;
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      if (pinch.distance > 0 && distance > 0) {
        setImageTransform((current) =>
          zoomImage(
            current,
            stagePoint(stage, pinch.cx, pinch.cy),
            stagePoint(stage, cx, cy),
            distance / pinch.distance,
          ),
        );
      }
      pinchRef.current = { distance, cx, cy };
      return;
    }
    setImageTransform((current) => ({
      ...current,
      x: current.x + (next.x - prev.x),
      y: current.y + (next.y - prev.y),
    }));
  };

  const onImagePointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(event.pointerId);
    rememberPinch();
  };

  const onImageWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
    if (delta === 0) {
      return;
    }
    zoomAt(event.clientX, event.clientY, Math.exp(-delta * 0.0015));
  };

  const exportPng = async () => {
    const stage = stageRef.current;
    const glCanvas = staffRef.current?.getCanvas();
    if (stage == null || glCanvas == null || exportingRef.current) {
      return;
    }
    const rect = stage.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) {
      return;
    }

    exportingRef.current = true;
    setExporting(true);
    // Settings are applied in a layout effect; the next frames redraw
    // the staff without grid dots before we copy it.
    await nextFrame();
    await nextFrame();

    const photo = imageRef.current;
    const hasPhoto = loaded != null && photo?.complete === true;
    let cropX = 0;
    let cropY = 0;
    let cropW = rect.width;
    let cropH = rect.height;
    let photoLeft = 0;
    let photoTop = 0;
    if (hasPhoto && loaded != null) {
      const drawW = loaded.width * imageTransform.scale;
      const drawH = loaded.height * imageTransform.scale;
      photoLeft = rect.width / 2 + imageTransform.x - drawW / 2;
      photoTop = rect.height / 2 + imageTransform.y - drawH / 2;
      const x0 = Math.max(0, photoLeft);
      const y0 = Math.max(0, photoTop);
      const x1 = Math.min(rect.width, photoLeft + drawW);
      const y1 = Math.min(rect.height, photoTop + drawH);
      if (x1 - x0 >= 2 && y1 - y0 >= 2) {
        cropX = x0;
        cropY = y0;
        cropW = x1 - x0;
        cropH = y1 - y0;
      }
    }

    const dpr = window.devicePixelRatio || 1;
    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(cropW * dpr));
    out.height = Math.max(1, Math.round(cropH * dpr));
    const ctx = out.getContext("2d");
    if (ctx == null) {
      exportingRef.current = false;
      setExporting(false);
      return;
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    if (!hasPhoto || loaded == null || photo == null) {
      ctx.fillStyle = getComputedStyle(stage).backgroundColor;
      ctx.fillRect(0, 0, out.width, out.height);
    } else {
      ctx.drawImage(
        photo,
        (cropX - photoLeft) / imageTransform.scale,
        (cropY - photoTop) / imageTransform.scale,
        cropW / imageTransform.scale,
        cropH / imageTransform.scale,
        0,
        0,
        out.width,
        out.height,
      );
    }
    ctx.drawImage(
      glCanvas,
      (cropX / rect.width) * glCanvas.width,
      (cropY / rect.height) * glCanvas.height,
      (cropW / rect.width) * glCanvas.width,
      (cropH / rect.height) * glCanvas.height,
      0,
      0,
      out.width,
      out.height,
    );
    exportingRef.current = false;
    setExporting(false);

    out.toBlob((blob) => {
      if (blob == null) {
        return;
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "hex-meme.png";
      link.click();
      URL.revokeObjectURL(url);
    }, "image/png");
  };

  return (
    <div
      ref={stageRef}
      onDragOver={(event) => {
        if (![...event.dataTransfer.types].includes("Files")) {
          return;
        }
        event.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
          return;
        }
        setDragOver(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragOver(false);
        loadImageFile(event.dataTransfer.files[0]);
      }}
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        background: "var(--mantine-color-body)",
        userSelect: "none",
        WebkitUserSelect: "none",
        cursor: effectiveTool === "draw" ? "crosshair" : undefined,
      }}
    >
      {loaded != null && (
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            width: loaded.width * imageTransform.scale,
            height: loaded.height * imageTransform.scale,
            transform: `translate(-50%, -50%) translate(${imageTransform.x}px, ${imageTransform.y}px)`,
            zIndex: 0,
            pointerEvents: "none",
          }}
        >
          <img
            ref={imageRef}
            src={loaded.url}
            alt=""
            draggable={false}
            style={{ display: "block", width: "100%", height: "100%" }}
          />
        </div>
      )}

      <div style={{ position: "absolute", inset: 0, zIndex: 1 }}>
        <StaffGrid
          ref={staffRef}
          patterns={patterns}
          onPatternsChange={patternsHandlers.set}
          patternType={patternType}
          onPatternTypeChange={setPatternType}
          settings={gridSettings}
          preserveDrawingBuffer
        />
      </div>

      {effectiveTool === "image" && (
        <div
          onPointerDown={onImagePointerDown}
          onPointerMove={onImagePointerMove}
          onPointerUp={onImagePointerEnd}
          onPointerCancel={onImagePointerEnd}
          onWheel={onImageWheel}
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 2,
            touchAction: "none",
            cursor: imagePanning ? "grabbing" : "grab",
          }}
        />
      )}

      {loaded == null && (
        <Stack
          align="center"
          gap="sm"
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 3,
            justifyContent: "center",
            pointerEvents: "none",
          }}
        >
          <Text ta="center" maw={420} px="md">
            {imageError ? t("meme.imageError") : t("meme.empty")}
          </Text>
          {!imageError && (
            <Text ta="center" size="sm" c="dimmed" maw={460} px="md">
              {t("meme.hint")}
            </Text>
          )}
          <Button style={{ pointerEvents: "auto" }} onClick={openFilePicker}>
            {t("meme.upload")}
          </Button>
        </Stack>
      )}

      {dragOver && (
        <div
          style={{
            position: "absolute",
            inset: 8,
            zIndex: 4,
            pointerEvents: "none",
            border: "3px dashed var(--mantine-color-blue-filled)",
            borderRadius: "var(--mantine-radius-md)",
            background:
              "color-mix(in srgb, var(--mantine-color-body) 40%, transparent)",
            display: "grid",
            placeItems: "center",
          }}
        >
          <Text fw={600}>{t("meme.drop")}</Text>
        </div>
      )}

      <Stack gap="xs" pos="absolute" top={16} left={16} style={{ zIndex: 3 }}>
        <ActionIcon
          {...staffGridButtonProps}
          onClick={openFilePicker}
          aria-label={t("meme.upload")}
          title={t("meme.upload")}
        >
          <IconUpload />
        </ActionIcon>

        <ActionIcon
          {...staffGridButtonProps}
          variant={effectiveTool === "draw" ? "filled" : "default"}
          onClick={() => {
            pointersRef.current.clear();
            pinchRef.current = null;
            setImagePanning(false);
            setTool("draw");
          }}
          aria-pressed={effectiveTool === "draw"}
          aria-label={t("meme.draw")}
          title={t("meme.draw")}
        >
          <IconPencil />
        </ActionIcon>

        <ActionIcon
          {...staffGridButtonProps}
          variant={effectiveTool === "image" ? "filled" : "default"}
          onClick={() => setTool("image")}
          aria-pressed={effectiveTool === "image"}
          aria-label={t("meme.moveImage")}
          title={t("meme.moveImage")}
        >
          <IconHandStop />
        </ActionIcon>

        <HexParseInput
          onPatterns={(imported) => {
            const next = appendImportedPatterns(
              patterns,
              imported,
              patternType,
            );
            patternsHandlers.set(next);
            const firstAdded = next[patterns.length];
            if (firstAdded != null) {
              staffRef.current?.panToPattern(firstAdded);
            }
          }}
        />

        <ActionIcon
          {...staffGridButtonProps}
          onClick={() => {
            if (loaded != null) {
              fitImage(loaded.width, loaded.height);
            }
          }}
          disabled={loaded == null}
          aria-label={t("meme.fitImage")}
          title={t("meme.fitImage")}
        >
          <IconPhoto />
        </ActionIcon>

        <ActionIcon
          {...staffGridButtonProps}
          variant={settings.dotsMode === "none" ? "default" : "filled"}
          onClick={() =>
            setSettings((current) => ({
              ...current,
              dotsMode: current.dotsMode === "none" ? "mouse" : "none",
            }))
          }
          aria-pressed={settings.dotsMode !== "none"}
          aria-label={t("meme.gridDots")}
          title={t("meme.gridDots")}
        >
          <IconGridDots />
        </ActionIcon>
      </Stack>

      <Stack gap="xs" pos="absolute" top={16} right={16} style={{ zIndex: 3 }}>
        <StaffGridPalette
          patternType={patternType}
          onPatternTypeChange={setPatternType}
        />

        <ActionIcon
          {...staffGridButtonProps}
          onClick={toggleSidebar}
          aria-label={t("controls.patternList")}
          title={t("controls.patternList")}
        >
          <IconMenu2 />
        </ActionIcon>

        <ActionIcon
          {...staffGridButtonProps}
          onClick={() => patternsHandlers.back()}
          disabled={patternsHistory.current === 0}
          aria-label={t("controls.undo")}
          title={t("controls.undo")}
        >
          <IconArrowBackUp />
        </ActionIcon>

        <ActionIcon
          {...staffGridButtonProps}
          onClick={() => patternsHandlers.forward()}
          disabled={
            patternsHistory.current === patternsHistory.history.length - 1
          }
          aria-label={t("controls.redo")}
          title={t("controls.redo")}
        >
          <IconArrowForwardUp />
        </ActionIcon>

        <ActionIcon
          {...staffGridButtonProps}
          onClick={() => patternsHandlers.set([])}
          disabled={patterns.length === 0}
          aria-label={t("controls.clearGrid")}
          title={t("controls.clearGrid")}
        >
          <IconTrash />
        </ActionIcon>

        <ActionIcon
          {...staffGridButtonProps}
          onClick={() => staffRef.current?.resetPanAndZoom()}
          aria-label={t("meme.resetPatterns")}
          title={t("meme.resetPatterns")}
        >
          <IconFocusCentered />
        </ActionIcon>

        <ActionIcon
          {...staffGridButtonProps}
          onClick={() => void exportPng()}
          disabled={exporting}
          aria-label={t("meme.export")}
          title={t("meme.export")}
        >
          <IconDownload />
        </ActionIcon>
      </Stack>

      <StaffGridSidebar
        patterns={patterns}
        onPatternsChange={patternsHandlers.set}
        onPanToPattern={(pattern) => staffRef.current?.panToPattern(pattern)}
        opened={sidebarOpen}
        onClose={closeSidebar}
        labels={{
          patterns: t("sidebar.patterns"),
          copyAngleSignatures: t("sidebar.copyAngleSignatures"),
          copyHexBugCommand: t("sidebar.copyHexBugCommand"),
          share: t("sidebar.share"),
        }}
      />

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(event) => {
          loadImageFile(event.currentTarget.files?.[0]);
          event.currentTarget.value = "";
        }}
      />
    </div>
  );
}
