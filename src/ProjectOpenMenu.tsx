import { useEffect, useState } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { experimental_Icon as Icon, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server.js";
import { discoverProjectApps, openProjectInApp, type ProjectOpenApps } from "./project-open.js";
import { APP_ICONS } from "./app-icons.js";

function AppIcon({ target }: { target: ProjectOpenApps["targets"][number] }) {
  const [failed, setFailed] = useState(false);
  const icon = target.icon;
  const name = icon?.kind === "builtin" ? icon.name : target.id;
  const src = icon?.kind === "data-url"
    ? icon.dataUrl
    : icon?.kind === "symbol" ? undefined : APP_ICONS[name === "intellij-idea" ? "intellij" : name];
  const symbol = icon?.kind === "symbol" ? icon.name : target.id;
  if (src && !failed) {
    return <img src={src} alt="" draggable={false} onError={() => setFailed(true)} className="size-5 shrink-0 rounded-sm object-contain" />;
  }
  return <Icon
    name={symbol === "default-app" ? "ExternalLink" : symbol === "file-manager" || symbol === "finder" ? "Folder" : ["terminal", "iterm2", "ghostty", "warp"].includes(symbol) ? "Terminal" : "AppWindow"}
    aria-hidden
    className="size-5 shrink-0 text-muted-foreground"
  />;
}

export function ProjectOpenMenu({ projectId, itemClassName, onError }: {
  projectId: string;
  itemClassName: string;
  onError: (message: string) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<ProjectOpenApps | string>("Loading apps...");
  useEffect(() => {
    const controller = new AbortController();
    setState("Loading apps...");
    void (async () => {
      const result = await rpc.call("getProjectOpenContext", { projectId });
      if (!result.source) return "This project has no checkout.";
      return discoverProjectApps(result.source, result.ports,
        window.location.origin, controller.signal);
    })().then(
      (result) => { if (!controller.signal.aborted) setState(result); },
      (error: unknown) => {
        if (!controller.signal.aborted) setState(error instanceof Error ? error.message : "Could not load apps.");
      },
    );
    return () => controller.abort();
  }, [projectId, rpc]);

  return (
    <ContextMenu.Sub>
      <ContextMenu.SubTrigger className={`${itemClassName} justify-between`}>
        <span>Open in</span><span aria-hidden="true">›</span>
      </ContextMenu.SubTrigger>
      <ContextMenu.Portal>
        <ContextMenu.SubContent data-bb-plugin="homepage" className="z-50 min-w-[12rem] max-w-sm rounded-md border border-border bg-card p-1 shadow-md">
          {typeof state === "string" ? (
            <ContextMenu.Item disabled className={itemClassName}>{state}</ContextMenu.Item>
          ) : state.targets.length === 0 ? (
            <ContextMenu.Item disabled className={itemClassName}>No apps support this checkout.</ContextMenu.Item>
          ) : state.targets.map((target) => (
            <ContextMenu.Item key={target.id} className={`${itemClassName} gap-3 py-2`} onSelect={() => {
              void openProjectInApp(state, target.id).catch((error: unknown) => {
                onError(error instanceof Error ? error.message : "Could not open app.");
              });
            }}><AppIcon target={target} /><span>{target.label}</span></ContextMenu.Item>
          ))}
        </ContextMenu.SubContent>
      </ContextMenu.Portal>
    </ContextMenu.Sub>
  );
}
