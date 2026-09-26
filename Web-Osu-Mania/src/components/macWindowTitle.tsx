import { DialogTitle } from "./ui/dialog";

export default function MacWindowTitle({
  children,
  onClose,
  closeLabel,
  disabled = false,
}: {
  children: string;
  onClose: () => void;
  closeLabel: string;
  disabled?: boolean;
}) {
  return (
    <div className="mac-window-titlebar">
      <button
        type="button"
        className="mac-window-close"
        aria-label={closeLabel}
        disabled={disabled}
        onClick={onClose}
      />
      <DialogTitle className="mac-window-title">
        <span>{children}</span>
      </DialogTitle>
    </div>
  );
}
