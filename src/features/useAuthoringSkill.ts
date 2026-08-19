import { useCallback, useEffect, useState } from "react";
import { desktopApi } from "../api";
import type { AuthoringSkillStatus } from "./types";

const PREVIEW_STATUS: AuthoringSkillStatus = {
  id: "pi-desktop-feature-builder",
  name: "Pi Desktop Feature Builder",
  version: "1.0.0",
  directory: "~/.agents/skills/pi-desktop-feature-builder",
  installed: false,
  managed: false,
  updateAvailable: false,
};

const PREVIEW_MODE =
  import.meta.env.DEV &&
  ["conversation", "terminal"].includes(
    new URLSearchParams(window.location.search).get("preview") ?? "",
  );

export function useAuthoringSkill(enabled: boolean) {
  const [status, setStatus] = useState<AuthoringSkillStatus | null>(
    PREVIEW_MODE ? PREVIEW_STATUS : null,
  );
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState<"install" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    if (PREVIEW_MODE) return;
    setLoading(true);
    setError(null);
    void desktopApi
      .authoringSkillStatus()
      .then(setStatus)
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (enabled) reload();
  }, [enabled, reload]);

  const install = useCallback(async () => {
    setWorking("install");
    setError(null);
    try {
      if (PREVIEW_MODE) {
        setStatus({ ...PREVIEW_STATUS, installed: true, managed: true });
      } else {
        setStatus(await desktopApi.installAuthoringSkill());
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setWorking(null);
    }
  }, []);

  const remove = useCallback(async () => {
    setWorking("remove");
    setError(null);
    try {
      if (PREVIEW_MODE) {
        setStatus(PREVIEW_STATUS);
      } else {
        setStatus(await desktopApi.removeAuthoringSkill());
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setWorking(null);
    }
  }, []);

  return { status, loading, working, error, install, remove, reload };
}
