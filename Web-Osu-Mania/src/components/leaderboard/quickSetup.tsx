import MacWindowTitle from "../macWindowTitle";
import type { Beatmap, BeatmapSet } from "@/lib/beatmapTypes";
import { defaultSettings, useSettingsStore } from "@/stores/settingsStore";
import { ArrowLeft } from "lucide-react";
import { Suspense, lazy, useState, type CSSProperties } from "react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
const SidebarContent = lazy(() => import("../sidebar"));

export default function QuickSetup({
  beatmap,
  beatmapSet,
  onStart,
  onBack,
  paid,
  busy = false,
}: {
  beatmap: Beatmap;
  beatmapSet: BeatmapSet;
  onStart: () => void;
  onBack: () => void;
  paid: boolean;
  busy?: boolean;
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const speed = useSettingsStore.use.scrollSpeed();
  const performanceMode = useSettingsStore.use.performanceMode();
  const keybinds = useSettingsStore.use.keybinds();
  const setSettings = useSettingsStore.use.setSettings();
  const keys = keybinds.keyModes[3].map(
    (bind) => bind[0]?.replace(/^Key/, "") || "-",
  );
  return (
    <section className="arena-setup">
      <button className="arena-text-button" onClick={onBack}>
        <ArrowLeft size={16} /> Back
      </button>
      <div className="arena-page-heading">
        <div>
          <h1>Set your speed.</h1>
          <p>{paid ? "Paid run: 1 play is used when you start." : "Free practice"}</p>
        </div>
      </div>
      <div className="arena-song">
        <span className="arena-song-icon">4K</span>
        <div>
          <strong>{beatmapSet.title}</strong>
          <p>
            {beatmapSet.artist} · {Math.floor(beatmap.total_length / 60)}:
            {String(beatmap.total_length % 60).padStart(2, "0")} ·{" "}
            {beatmap.version}
          </p>
        </div>
      </div>
      <div className="arena-setup-grid">
        <div>
          <div className="arena-note-preview">
            <span className="arena-label">Key preview</span>
            <div
              className={`arena-lanes ${performanceMode ? "calm" : ""}`}
              style={
                { "--note-duration": `${4 - speed * 0.08}s` } as CSSProperties
              }
            >
              {keys.map((key, i) => (
                <div className="arena-lane" key={i}>
                  <span style={{ animationDelay: `${-i * 0.49}s` }} />
                  <kbd>{key}</kbd>
                </div>
              ))}
            </div>
          </div>
          <p className="arena-preview-caption">Press {keys.join(" ")} at the line.</p>
        </div>
        <div className="arena-controls">
          <div className="arena-control-heading">
            <label htmlFor="note-speed">Note speed</label>
            <output htmlFor="note-speed">{speed}</output>
          </div>
          <p>Scroll speed only; song timing and score stay the same.</p>
          <input
            id="note-speed"
            type="range"
            min="1"
            max="40"
            value={speed}
            onChange={(event) =>
              setSettings((draft) => {
                draft.scrollSpeed = Number(event.target.value);
              })
            }
          />
          <div className="arena-range-labels">
            <span>Slower</span>
            <span>Default</span>
            <span>Faster</span>
          </div>
          <div className="arena-effects">
            <div>
              <label htmlFor="visual-effects">Visual effects</label>
              <p>Glows and particles.</p>
            </div>
            <label className="arena-switch">
              <span>{performanceMode ? "Off" : "On"}</span>
              <input
                id="visual-effects"
                type="checkbox"
                checked={!performanceMode}
                onChange={(event) =>
                  setSettings((draft) => {
                    draft.performanceMode = !event.target.checked;
                  })
                }
              />
              <span className="arena-switch-track" />
            </label>
          </div>
          <div className="arena-setup-actions">
            <button
              className="arena-text-button"
              onClick={() =>
                setSettings((draft) => {
                  draft.scrollSpeed = defaultSettings.scrollSpeed;
                  draft.performanceMode = defaultSettings.performanceMode;
                })
              }
            >
              Reset
            </button>
            <button className="arena-primary" disabled={busy} onClick={onStart}>
              {busy ? "Starting…" : paid ? "Start paid run (1 play)" : "Start practice"}
            </button>
          </div>
        </div>
      </div>
      <button
        className="arena-text-button"
        onClick={() => setAdvancedOpen(true)}
      >
        More settings
      </button>
      <Dialog open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <DialogContent className="arena-advanced" aria-describedby={undefined}>
          <MacWindowTitle
            closeLabel="Close settings"
            onClose={() => setAdvancedOpen(false)}
          >
            Settings
          </MacWindowTitle>
          <Suspense fallback={<p>Loading settings…</p>}>
            <SidebarContent paid={paid} />
          </Suspense>
        </DialogContent>
      </Dialog>
    </section>
  );
}
