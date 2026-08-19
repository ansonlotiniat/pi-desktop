import { useEffect, useMemo, useState } from "react";
import {
  Eye,
  EyeSlash,
  Plus,
  TrashSimple,
  X,
} from "@phosphor-icons/react";
import type {
  AppSettings,
  KernelInfo,
  ProviderConfig,
  ProviderModel,
} from "../types";

interface SettingsDialogProps {
  settings: AppSettings;
  kernel: KernelInfo;
  onClose: () => void;
  onSave: (settings: AppSettings) => Promise<AppSettings>;
  onConnect: () => Promise<void>;
  onDisconnect: () => Promise<void>;
}

const API_TYPES: Array<{ value: ProviderConfig["api"]; label: string }> = [
  { value: "openai-completions", label: "OpenAI Chat Completions" },
  { value: "openai-responses", label: "OpenAI Responses" },
  { value: "anthropic-messages", label: "Anthropic Messages" },
  { value: "google-generative-ai", label: "Google Generative AI" },
];

function cloneSettings(settings: AppSettings): AppSettings {
  return {
    ...settings,
    providers: settings.providers.map((provider) => ({
      ...provider,
      models: provider.models.map((model) => ({ ...model })),
    })),
  };
}

function readableError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Could not save settings.";
}

function validate(settings: AppSettings): string | null {
  const providerIds = new Set<string>();
  for (const provider of settings.providers) {
    if (!provider.id.trim()) return "Every provider needs an ID.";
    if (providerIds.has(provider.id.trim())) {
      return `Provider ID "${provider.id.trim()}" is already in use.`;
    }
    providerIds.add(provider.id.trim());
    if (!provider.name.trim()) return "Every provider needs a display name.";
    if (!provider.baseUrl.trim()) return `${provider.name} needs a base URL.`;
    try {
      const url = new URL(provider.baseUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
    } catch {
      return `${provider.name} has an invalid base URL.`;
    }
    if (provider.models.length === 0) {
      return `${provider.name} needs at least one model.`;
    }
    if (provider.models.some((model) => !model.id.trim())) {
      return `${provider.name} has a model without an ID.`;
    }
  }
  return null;
}

function normalize(settings: AppSettings): AppSettings {
  return {
    kernelPath: settings.kernelPath.trim(),
    defaultCwd: settings.defaultCwd.trim(),
    providers: settings.providers.map((provider) => ({
      ...provider,
      id: provider.id.trim(),
      name: provider.name.trim(),
      baseUrl: provider.baseUrl.trim().replace(/\/$/, ""),
      models: provider.models.map((model) => ({
        ...model,
        id: model.id.trim(),
        name: model.name?.trim() || undefined,
      })),
    })),
  };
}

export function SettingsDialog({
  settings,
  kernel,
  onClose,
  onSave,
  onConnect,
  onDisconnect,
}: SettingsDialogProps) {
  const [draft, setDraft] = useState(() => cloneSettings(settings));
  const [visibleKeys, setVisibleKeys] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [connectionBusy, setConnectionBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !saving) onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, saving]);

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(settings),
    [draft, settings],
  );

  function updateProvider(index: number, patch: Partial<ProviderConfig>) {
    setDraft((current) => ({
      ...current,
      providers: current.providers.map((provider, providerIndex) =>
        providerIndex === index ? { ...provider, ...patch } : provider,
      ),
    }));
  }

  function updateModel(
    providerIndex: number,
    modelIndex: number,
    patch: Partial<ProviderModel>,
  ) {
    setDraft((current) => ({
      ...current,
      providers: current.providers.map((provider, currentProviderIndex) =>
        currentProviderIndex === providerIndex
          ? {
              ...provider,
              models: provider.models.map((model, currentModelIndex) =>
                currentModelIndex === modelIndex ? { ...model, ...patch } : model,
              ),
            }
          : provider,
      ),
    }));
  }

  function addProvider() {
    const suffix = Date.now().toString(36).slice(-5);
    setDraft((current) => ({
      ...current,
      providers: [
        ...current.providers,
        {
          id: `custom-${suffix}`,
          name: "Custom provider",
          baseUrl: "https://api.openai.com/v1",
          apiKey: "",
          api: "openai-completions",
          authHeader: true,
          models: [{ id: "", name: "", reasoning: false }],
        },
      ],
    }));
  }

  function removeProvider(index: number) {
    setDraft((current) => ({
      ...current,
      providers: current.providers.filter((_, providerIndex) => providerIndex !== index),
    }));
  }

  function addModel(providerIndex: number) {
    setDraft((current) => ({
      ...current,
      providers: current.providers.map((provider, index) =>
        index === providerIndex
          ? {
              ...provider,
              models: [
                ...provider.models,
                { id: "", name: "", reasoning: false },
              ],
            }
          : provider,
      ),
    }));
  }

  function removeModel(providerIndex: number, modelIndex: number) {
    setDraft((current) => ({
      ...current,
      providers: current.providers.map((provider, index) =>
        index === providerIndex
          ? {
              ...provider,
              models: provider.models.filter(
                (_, currentModelIndex) => currentModelIndex !== modelIndex,
              ),
            }
          : provider,
      ),
    }));
  }

  async function save() {
    const normalized = normalize(draft);
    const validationError = validate(normalized);
    if (validationError) {
      setFormError(validationError);
      return;
    }

    setSaving(true);
    setFormError(null);
    try {
      await onSave(normalized);
      onClose();
    } catch (error) {
      setFormError(readableError(error));
    } finally {
      setSaving(false);
    }
  }

  async function toggleConnection() {
    setConnectionBusy(true);
    setFormError(null);
    try {
      if (kernel.status === "connected") await onDisconnect();
      else await onConnect();
    } catch (error) {
      setFormError(readableError(error));
    } finally {
      setConnectionBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <div>
            <h2 id="settings-title">Settings</h2>
            <p>Kernel and model providers</p>
          </div>
          <button
            className="glyph-button"
            type="button"
            aria-label="Close settings"
            onClick={onClose}
            disabled={saving}
          >
            <X size={15} weight="regular" aria-hidden="true" />
          </button>
        </header>

        <div className="settings-scroll">
          <section className="settings-section">
            <div className="settings-section-heading">
              <div>
                <h3>Pi kernel</h3>
                <p>
                  {kernel.status === "connected"
                    ? `Connected to ${kernel.executable ?? "Pi"}`
                    : "Use discovery or set an explicit executable."}
                </p>
              </div>
              <button
                className="secondary-button"
                type="button"
                onClick={() => void toggleConnection()}
                disabled={connectionBusy || kernel.status === "connecting" || dirty}
                title={dirty ? "Save changes before connecting" : undefined}
              >
                {connectionBusy || kernel.status === "connecting"
                  ? "Working..."
                  : kernel.status === "connected"
                    ? "Disconnect"
                    : "Connect"}
              </button>
            </div>
            <div className="form-grid two-column">
              <label className="field">
                <span>Kernel executable</span>
                <input
                  value={draft.kernelPath}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      kernelPath: event.currentTarget.value,
                    }))
                  }
                  placeholder="Auto-discover pi, or /path/to/pi"
                  spellCheck={false}
                />
              </label>
              <label className="field">
                <span>Default working directory</span>
                <input
                  value={draft.defaultCwd}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      defaultCwd: event.currentTarget.value,
                    }))
                  }
                  placeholder="/Users/you/project"
                  spellCheck={false}
                />
              </label>
            </div>
          </section>

          <section className="settings-section providers-section">
            <div className="settings-section-heading">
              <div>
                <h3>Model providers</h3>
                <p>API keys are stored in the app-private configuration file.</p>
              </div>
              <button className="secondary-button" type="button" onClick={addProvider}>
                <Plus size={14} weight="regular" aria-hidden="true" />
                Add provider
              </button>
            </div>

            {draft.providers.length === 0 ? (
              <div className="settings-empty">
                <strong>No custom providers</strong>
                <span>Pi's built-in provider configuration remains available.</span>
              </div>
            ) : (
              draft.providers.map((provider, providerIndex) => (
                <section className="provider-editor" key={`${provider.id}-${providerIndex}`}>
                  <div className="provider-heading">
                    <strong>{provider.name || "Untitled provider"}</strong>
                    <button
                      className="text-button danger-text"
                      type="button"
                      onClick={() => removeProvider(providerIndex)}
                    >
                      <TrashSimple size={13} weight="regular" aria-hidden="true" />
                      Remove
                    </button>
                  </div>

                  <div className="form-grid two-column">
                    <label className="field">
                      <span>Provider ID</span>
                      <input
                        value={provider.id}
                        onChange={(event) =>
                          updateProvider(providerIndex, {
                            id: event.currentTarget.value,
                          })
                        }
                        placeholder="my-provider"
                        spellCheck={false}
                      />
                    </label>
                    <label className="field">
                      <span>Display name</span>
                      <input
                        value={provider.name}
                        onChange={(event) =>
                          updateProvider(providerIndex, {
                            name: event.currentTarget.value,
                          })
                        }
                        placeholder="My provider"
                      />
                    </label>
                    <label className="field">
                      <span>Base URL</span>
                      <input
                        value={provider.baseUrl}
                        onChange={(event) =>
                          updateProvider(providerIndex, {
                            baseUrl: event.currentTarget.value,
                          })
                        }
                        placeholder="https://api.example.com/v1"
                        inputMode="url"
                        spellCheck={false}
                      />
                    </label>
                    <label className="field">
                      <span>API type</span>
                      <select
                        value={provider.api}
                        onChange={(event) =>
                          updateProvider(providerIndex, {
                            api: event.currentTarget.value as ProviderConfig["api"],
                          })
                        }
                      >
                        {API_TYPES.map((apiType) => (
                          <option key={apiType.value} value={apiType.value}>
                            {apiType.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field field-wide">
                      <span>API key</span>
                      <div className="secret-input">
                        <input
                          value={provider.apiKey}
                          type={visibleKeys[provider.id] ? "text" : "password"}
                          onChange={(event) =>
                            updateProvider(providerIndex, {
                              apiKey: event.currentTarget.value,
                            })
                          }
                          placeholder="Use any value if a local endpoint ignores auth"
                          autoComplete="off"
                          spellCheck={false}
                        />
                        <button
                          type="button"
                          onClick={() =>
                            setVisibleKeys((current) => ({
                              ...current,
                              [provider.id]: !current[provider.id],
                            }))
                          }
                        >
                          {visibleKeys[provider.id] ? (
                            <EyeSlash size={13} weight="regular" aria-hidden="true" />
                          ) : (
                            <Eye size={13} weight="regular" aria-hidden="true" />
                          )}
                          {visibleKeys[provider.id] ? "Hide" : "Show"}
                        </button>
                      </div>
                    </label>
                  </div>

                  <label className="checkbox-field">
                    <input
                      type="checkbox"
                      checked={provider.authHeader}
                      onChange={(event) =>
                        updateProvider(providerIndex, {
                          authHeader: event.currentTarget.checked,
                        })
                      }
                    />
                    <span>Send API key in the Authorization header</span>
                  </label>

                  <div className="models-heading">
                    <span>Models</span>
                    <button
                      className="text-button"
                      type="button"
                      onClick={() => addModel(providerIndex)}
                    >
                      <Plus size={13} weight="regular" aria-hidden="true" />
                      Add model
                    </button>
                  </div>

                  <div className="model-editor-list">
                    {provider.models.map((model, modelIndex) => (
                      <div className="model-editor" key={`${model.id}-${modelIndex}`}>
                        <label className="field">
                          <span>Model ID</span>
                          <input
                            value={model.id}
                            onChange={(event) =>
                              updateModel(providerIndex, modelIndex, {
                                id: event.currentTarget.value,
                              })
                            }
                            placeholder="model-id"
                            spellCheck={false}
                          />
                        </label>
                        <label className="field">
                          <span>Display name</span>
                          <input
                            value={model.name ?? ""}
                            onChange={(event) =>
                              updateModel(providerIndex, modelIndex, {
                                name: event.currentTarget.value,
                              })
                            }
                            placeholder="Optional"
                          />
                        </label>
                        <label className="checkbox-field compact-checkbox">
                          <input
                            type="checkbox"
                            checked={model.reasoning ?? false}
                            onChange={(event) =>
                              updateModel(providerIndex, modelIndex, {
                                reasoning: event.currentTarget.checked,
                              })
                            }
                          />
                          <span>Reasoning</span>
                        </label>
                        <button
                          className="glyph-button remove-model"
                          type="button"
                          aria-label={`Remove ${model.id || "model"}`}
                          onClick={() => removeModel(providerIndex, modelIndex)}
                        >
                          <X size={14} weight="regular" aria-hidden="true" />
                        </button>
                      </div>
                    ))}
                  </div>
                </section>
              ))
            )}
          </section>
        </div>

        {formError && <div className="modal-error">{formError}</div>}

        <footer className="modal-footer">
          <span>{dirty ? "Unsaved changes" : "Settings are up to date"}</span>
          <div className="modal-actions">
            <button
              className="secondary-button"
              type="button"
              onClick={onClose}
              disabled={saving}
            >
              Cancel
            </button>
            <button
              className="primary-button"
              type="button"
              onClick={() => void save()}
              disabled={saving || !dirty}
            >
              {saving ? "Saving..." : "Save settings"}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
