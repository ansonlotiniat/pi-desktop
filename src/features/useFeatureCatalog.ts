import { useCallback, useEffect, useState } from "react";
import { desktopApi } from "../api";
import type { FeatureCatalog } from "./types";

const emptyCatalog: FeatureCatalog = {
  features: [],
  starters: [],
  errors: [],
  globalDirectory: "~/.pi-desktop/features",
};

const previewCatalog: FeatureCatalog = {
  ...emptyCatalog,
  starters: [
    {
      id: "code-review",
      name: "Code Review",
      description:
        "Review working, staged, or committed changes file by file, then send a focused task to Pi.",
      icon: "✓",
      version: "1.0.0",
      publisher: "Pi Desktop",
      installed: false,
      updateAvailable: false,
    },
    {
      id: "code-diff",
      name: "Code Diff",
      description:
        "Browse per-file working, staged, and last-commit diffs without consuming model tokens.",
      icon: "±",
      version: "1.0.0",
      publisher: "Pi Desktop",
      installed: false,
      updateAvailable: false,
    },
  ],
};

function projectFeaturesDirectory(projectRoot?: string): string | undefined {
  const root = projectRoot?.trim();
  if (!root) return undefined;
  const normalized = root.replace(/\/+$/, "");
  return `${normalized || ""}/.pi-desktop/features`;
}

const PREVIEW_MODE =
  import.meta.env.DEV &&
  ["conversation", "terminal"].includes(
    new URLSearchParams(window.location.search).get("preview") ?? "",
  );

export function useFeatureCatalog(projectRoot?: string) {
  const [catalog, setCatalog] = useState<FeatureCatalog>(() =>
    PREVIEW_MODE
      ? {
          ...previewCatalog,
          projectDirectory: projectFeaturesDirectory(projectRoot),
        }
      : emptyCatalog,
  );
  const [loading, setLoading] = useState(!PREVIEW_MODE);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [installingStarter, setInstallingStarter] = useState<string | null>(null);

  const reload = useCallback(() => {
    setRevision((value) => value + 1);
  }, []);

  useEffect(() => {
    setCatalog((current) => ({
      ...current,
      features: PREVIEW_MODE
        ? current.features
        : current.features.filter((feature) => feature.source === "global"),
      errors: [],
      projectDirectory: projectFeaturesDirectory(projectRoot),
    }));
    if (PREVIEW_MODE) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void desktopApi
      .listFeatures(projectRoot)
      .then((next) => {
        if (!cancelled) setCatalog(next);
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectRoot, revision]);

  const installStarter = useCallback(
    async (starterId: string) => {
      setInstallingStarter(starterId);
      setError(null);
      if (PREVIEW_MODE) {
        setCatalog((current) => ({
          ...current,
          starters: current.starters.map((starter) =>
            starter.id === starterId
              ? { ...starter, installed: true, updateAvailable: false }
              : starter,
          ),
        }));
        setInstallingStarter(null);
        return;
      }
      try {
        setCatalog(
          await desktopApi.installStarterFeature(starterId, projectRoot),
        );
        setRevision((value) => value + 1);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        setInstallingStarter(null);
      }
    },
    [projectRoot],
  );

  return {
    catalog,
    loading,
    error,
    reload,
    revision,
    installStarter,
    installingStarter,
  };
}
