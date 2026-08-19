import type {
  AuthoringSkillStatus,
  FeatureCatalog,
  FeatureDescriptor,
} from "./types";

interface FeatureManagerProps {
  catalog: FeatureCatalog;
  loading: boolean;
  error: string | null;
  onReload: () => void;
  onOpen: (feature: FeatureDescriptor) => void;
  onInstallStarter: (starterId: string) => void;
  installingStarter: string | null;
  authoringSkill: AuthoringSkillStatus | null;
  authoringLoading: boolean;
  authoringWorking: "install" | "remove" | null;
  authoringError: string | null;
  onInstallAuthoring: () => void;
  onRemoveAuthoring: () => void;
}

export function FeatureManager({
  catalog,
  loading,
  error,
  onReload,
  onOpen,
  onInstallStarter,
  installingStarter,
  authoringSkill,
  authoringLoading,
  authoringWorking,
  authoringError,
  onInstallAuthoring,
  onRemoveAuthoring,
}: FeatureManagerProps) {
  return (
    <div className="feature-manager-scroll">
      <div className="feature-manager-content">
        <section className="feature-manager-intro">
          <span className="feature-manager-kicker">Feature Host API v1</span>
          <h2>Plugins and feature apps</h2>
          <p>
            Install maintained tools or ask an agent to build a complete local feature.
            Every feature owns its UI, service logic, state, and authentication.
          </p>
          <button type="button" className="secondary-button" onClick={onReload} disabled={loading}>
            {loading ? "Scanning…" : "Reload features"}
          </button>
        </section>

        {error && <div className="feature-manager-alert">{error}</div>}

        <section className="feature-manager-section">
          <div className="feature-section-heading">
            <div>
              <h3>Official plugins</h3>
              <p>Maintained by Pi Desktop. Nothing is installed until you choose it.</p>
            </div>
          </div>
          <div className="starter-feature-grid">
            {catalog.starters.map((starter) => (
              <article className="starter-feature-card" key={starter.id}>
                <span className="starter-feature-icon" aria-hidden="true">
                  {starter.icon}
                </span>
                <div>
                  <strong>{starter.name}</strong>
                  <div className="starter-feature-meta">
                    <span>Official</span>
                    <span>v{starter.version}</span>
                  </div>
                  <p>{starter.description}</p>
                </div>
                <button
                  type="button"
                  className={
                    starter.installed && !starter.updateAvailable
                      ? "text-button"
                      : "secondary-button"
                  }
                  disabled={
                    (starter.installed && !starter.updateAvailable) ||
                    installingStarter === starter.id
                  }
                  onClick={() => onInstallStarter(starter.id)}
                >
                  {installingStarter === starter.id
                    ? starter.updateAvailable
                      ? "Updating..."
                      : "Installing..."
                    : starter.updateAvailable
                      ? "Update"
                      : starter.installed
                    ? "Installed"
                      : "Install"}
                </button>
              </article>
            ))}
          </div>
        </section>

        <section className="feature-manager-section">
          <h3>AI authoring</h3>
          <article className="authoring-skill-row">
            <div>
              <div className="feature-card-title">
                <strong>Pi Desktop Feature Builder</strong>
                <span>Skill</span>
                {authoringSkill && <span>v{authoringSkill.version}</span>}
              </div>
              <p>
                Gives agents the version-matched SDK, service contract, and scaffold needed to
                build complete sidebar features without reading the Desktop source. New agent
                sessions can use it after you enable it.
              </p>
              <code>
                {authoringSkill?.directory ?? "~/.agents/skills/pi-desktop-feature-builder"}
              </code>
              {authoringError && <div className="authoring-skill-error">{authoringError}</div>}
            </div>
            <div className="authoring-skill-actions">
              {authoringSkill?.installed && authoringSkill.managed ? (
                <>
                  {authoringSkill.updateAvailable ? (
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={authoringWorking !== null}
                      onClick={onInstallAuthoring}
                    >
                      {authoringWorking === "install" ? "Updating..." : "Update"}
                    </button>
                  ) : (
                    <span className="authoring-enabled">Enabled</span>
                  )}
                  <button
                    type="button"
                    className="text-button"
                    disabled={authoringWorking !== null}
                    onClick={onRemoveAuthoring}
                  >
                    {authoringWorking === "remove" ? "Removing..." : "Remove"}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={
                    authoringLoading ||
                    authoringWorking !== null ||
                    Boolean(authoringSkill?.installed && !authoringSkill.managed)
                  }
                  onClick={onInstallAuthoring}
                >
                  {authoringLoading
                    ? "Checking..."
                    : authoringSkill?.installed
                      ? "Custom skill detected"
                      : authoringWorking === "install"
                        ? "Enabling..."
                        : "Enable authoring"}
                </button>
              )}
            </div>
          </article>
        </section>

        <section className="feature-manager-section">
          <h3>Installed features</h3>
          {catalog.features.length === 0 ? (
            <div className="feature-manager-empty">
              <strong>No feature apps found.</strong>
              <p>
                Ask an agent to build one in either directory below, then reload this page.
              </p>
            </div>
          ) : (
            <div className="feature-card-list">
              {catalog.features.map((feature) => (
                <article className="feature-card" key={feature.id}>
                  <div>
                    <div className="feature-card-title">
                      <strong>{feature.name}</strong>
                      <span>{feature.source}</span>
                      {feature.version && <span>v{feature.version}</span>}
                    </div>
                    {feature.description && <p>{feature.description}</p>}
                    <code>{feature.rootPath}</code>
                  </div>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => onOpen(feature)}
                  >
                    Open
                  </button>
                </article>
              ))}
            </div>
          )}
        </section>

        {catalog.errors.length > 0 && (
          <section className="feature-manager-section">
            <h3>Manifest errors</h3>
            <div className="feature-error-list">
              {catalog.errors.map((item, index) => (
                <div key={`${item.path}-${index}`}>
                  <code>{item.path}</code>
                  <p>{item.message}</p>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="feature-manager-section feature-paths">
          <h3>Discovery paths</h3>
          <dl>
            <div>
              <dt>Project</dt>
              <dd><code>{catalog.projectDirectory ?? "Choose a working directory first"}</code></dd>
            </div>
            <div>
              <dt>Global</dt>
              <dd><code>{catalog.globalDirectory}</code></dd>
            </div>
          </dl>
        </section>
      </div>
    </div>
  );
}
