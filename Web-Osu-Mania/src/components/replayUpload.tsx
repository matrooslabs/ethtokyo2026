import { cn } from "@/lib/utils";
import type { ReplayData } from "@/osuMania/systems/replayRecorder";
import { decompressSync } from "fflate";
import { Upload } from "lucide-react";
import type { ChangeEvent, DragEvent } from "react";
import { useState } from "react";
import { toast } from "sonner";
import { useGameStore } from "../stores/gameStore";

const ReplayUpload = () => {
  const startReplay = useGameStore.use.startReplay();
  const [isDraggingOver, setIsDraggingOver] = useState(false);

  const loadFile = async (file?: File) => {
    if (!file) return;

    if (!file.name.endsWith(".womr")) {
      toast.message("Failed to load replay file", {
        description: "File is not in the .womr format.",
      });
      return;
    }

    try {
      const compressed = new Uint8Array(await file.arrayBuffer());
      const replay: ReplayData = JSON.parse(
        new TextDecoder().decode(decompressSync(compressed)),
      );
      await startReplay(replay);
    } catch {
      toast.message("Error reading replay file", {
        description: "File is not a valid .womr replay format.",
      });
    }
  };

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    void loadFile(file);
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDraggingOver(false);
    void loadFile(e.dataTransfer.files[0]);
  };

  return (
    <div
      className="flex w-full items-center"
      onDragOver={(e) => {
        e.preventDefault();
        setIsDraggingOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          setIsDraggingOver(false);
        }
      }}
      onDrop={handleDrop}
    >
      <label
        htmlFor="ReplayUpload"
        className={cn(
          "hover:bg-accent flex w-full cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-4 transition-colors",
          isDraggingOver && "bg-accent",
        )}
      >
        <div className="flex items-center justify-center gap-3 text-sm text-gray-500">
          <Upload />
          <p>
            <span className="font-semibold">Click</span> or drag and drop
          </p>
        </div>
        <input
          id="ReplayUpload"
          type="file"
          accept=".womr"
          className="hidden"
          onChange={handleChange}
        />
      </label>
    </div>
  );
};

export default ReplayUpload;
