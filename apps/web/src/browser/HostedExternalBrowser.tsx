"use client";

import type { PreviewViewportSetting, ScopedThreadRef } from "@t3tools/contracts";
import { Code2, ExternalLink, Monitor } from "lucide-react";
import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";

import { Button } from "~/components/ui/button";
import { previewBridge } from "~/components/preview/previewBridge";
import { usePreviewBridge } from "~/components/preview/usePreviewBridge";

import { useBrowserSurfaceStore } from "./browserSurfaceStore";
import { acquireDesktopTab } from "./desktopTabLifetime";

export function HostedExternalBrowser(props: {
  readonly threadRef: ScopedThreadRef;
  readonly tabId: string;
  readonly runtimeTabId: string;
  readonly initialUrl: string | null;
  readonly viewport: PreviewViewportSetting;
  readonly zoomFactor: number;
  readonly browserName: string;
}) {
  const { threadRef, tabId, runtimeTabId, initialUrl, browserName } = props;
  const presentation = useBrowserSurfaceStore(
    useShallow((state) => {
      const current = state.byTabId[runtimeTabId];
      return {
        rect: current?.rect ?? null,
        visible: current?.visible ?? false,
        cornerRadius: current?.cornerRadius ?? 0,
      };
    }),
  );
  usePreviewBridge({ threadRef, tabId, runtimeTabId });

  useEffect(() => {
    const lease = acquireDesktopTab(runtimeTabId);
    return lease.release;
  }, [runtimeTabId]);

  const rect = presentation.rect;
  const active = presentation.visible && rect !== null;
  const style = active
    ? {
        left: rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
        borderRadius: presentation.cornerRadius,
      }
    : { left: -10_000, top: -10_000, width: 1, height: 1 };

  return (
    <div
      className="fixed z-30 flex overflow-hidden border border-border/60 bg-background text-foreground shadow-sm"
      style={style}
      aria-hidden={active ? undefined : true}
      data-external-browser={runtimeTabId}
    >
      <div className="m-auto flex max-w-md flex-col items-center gap-4 p-8 text-center">
        <div className="flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
          <Monitor className="size-6" />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-semibold">External browser</p>
          <p className="text-xs text-muted-foreground">{browserName}</p>
        </div>
        <p className="max-w-full truncate font-mono text-xs text-muted-foreground">
          {initialUrl ?? "about:blank"}
        </p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          The live page is in the visible {browserName} window. Manual and agent actions share the
          same persistent profile and tab.
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button
            size="sm"
            onClick={() => void previewBridge?.focusBrowser?.(runtimeTabId)}
            disabled={!previewBridge?.focusBrowser}
          >
            <ExternalLink />
            Focus Browser
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void previewBridge?.openDevTools(runtimeTabId)}
          >
            <Code2 />
            Open DevTools
          </Button>
        </div>
      </div>
    </div>
  );
}
