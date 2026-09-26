import type { Beatmap, BeatmapSet } from "@/lib/beatmapTypes";
import { defaultSettings, useSettingsStore } from "@/stores/settingsStore";
import { ArrowLeft, LockKeyhole, Play } from "lucide-react";
import { Suspense, lazy, useState, type CSSProperties } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
const SidebarContent = lazy(() => import("../sidebar"));

export default function QuickSetup({
  beatmap,
  beatmapSet,
  onStart,
  onBack,
  paid,
}: {
  beatmap: Beatmap;
  beatmapSet: BeatmapSet;
  onStart: () => void;
  onBack: () => void;
  paid: boolean;
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const speed = useSettingsStore.use.scrollSpeed();
  const performanceMode = useSettingsStore.use.performanceMode();
  const keybinds = useSettingsStore.use.keybinds();
  const setSettings = useSettingsStore.use.setSettings();
  const keys = keybinds.keyModes[3].map(
    (bind) => bind[0]?.replace(/^Key/, "") || "—",
  );
  return (
    <section className="arena-setup">
      <button className="arena-text-button" onClick={onBack}>
        <ArrowLeft size={16} /> Back to leaderboard
      </button>
      <div className="arena-page-heading">
        <div>
          <p className="arena-eyebrow">BEFORE YOU PLAY</p>
          <h1>Find your comfort zone.</h1>
          <p>One song. One challenge. Just make the view yours.</p>
        </div>
        <span className="arena-step">
          {paid
            ? "1 · Paid / 2 · Get ready / 3 · Play"
            : "Practice · Get ready"}
        </span>
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
        <span className="arena-song-rule">
          <LockKeyhole size={15} /> Same chart and scoring for every player
        </span>
      </div>
      <div className="arena-setup-grid">
        <div>
          <div className="arena-note-preview">
            <span className="arena-label">NOTE PREVIEW</span>
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
          <p className="arena-preview-caption">
            Press {keys.join(", ")} as notes reach the line.
            <br />
            {paid
              ? "Keep this tab open. Pausing ends a paid run."
              : "No setup needed? Jump straight in."}
          </p>
        </div>
        <div className="arena-controls">
          <div className="arena-control-heading">
            <label htmlFor="note-speed">Note speed</label>
            <output htmlFor="note-speed">{speed}</output>
          </div>
          <p>
            Choose how quickly notes approach the hit line.
            <br />
            The song’s tempo and scoring stay the same.
          </p>
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
            <span>Slower · 1</span>
            <span>20 · Default</span>
            <span>Faster · 40</span>
          </div>
          <div className="arena-effects">
            <div>
              <label htmlFor="visual-effects">Visual effects</label>
              <p>
                Hit glows and particles.
                <br />
                Turn off for a calmer, cleaner playfield.
              </p>
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
              Reset to defaults
            </button>
            <button className="arena-primary" onClick={onStart}>
              Start playing <Play size={20} fill="currentColor" />
            </button>
          </div>
        </div>
      </div>
      <button
        className="arena-text-button"
        onClick={() => setAdvancedOpen(true)}
      >
        Advanced settings & keybinds
      </button>
      <Dialog open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <DialogContent className="arena-advanced" aria-describedby={undefined}>
          <DialogTitle>Make it yours</DialogTitle>
          <button
            className="arena-text-button"
            onClick={() => setAdvancedOpen(false)}
          >
            Done
          </button>
          <Suspense fallback={<p>Loading settings…</p>}>
            <SidebarContent />
          </Suspense>
        </DialogContent>
      </Dialog>
    </section>
  );
}
