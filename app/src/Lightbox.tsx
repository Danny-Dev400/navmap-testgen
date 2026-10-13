import { useEffect } from "react";

interface LightboxProps {
  src: string | null;
  onClose: () => void;
}

export function Lightbox({ src, onClose }: LightboxProps) {
  useEffect(() => {
    if (!src) return;
    // Capture phase + preventDefault: Escape closes only the lightbox, not the side panel under it.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [src, onClose]);

  if (!src) return null;

  return (
    <div className="lightbox-overlay" onClick={onClose}>
      <button className="lightbox-close" onClick={onClose} aria-label="Close">
        &times;
      </button>
      <img className="lightbox-image" src={src} alt="Screenshot (enlarged)" onClick={(e) => e.stopPropagation()} />
    </div>
  );
}
