import { useEffect, useState } from "react";
import Cropper, { type Area } from "react-easy-crop";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiErrorMessage } from "../../lib/api";
import {
  BRANDING_IMAGE_ACCEPT,
  brandingFileError,
  cropAspect,
  serverCrop,
  type BrandingImageKind,
} from "../../lib/branding";
import { uploadBrandingImage } from "./brandingApi";

// Pick → crop (react-easy-crop, MIT) → upload. The browser only chooses the
// crop rectangle; the server re-decodes, crops, resizes and strips metadata.

export default function BrandingImageUploader({
  kind,
  label,
  onDone,
}: {
  kind: BrandingImageKind;
  label: string;
  onDone?: () => void;
}) {
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [area, setArea] = useState<Area | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => {
    if (src) URL.revokeObjectURL(src);
  }, [src]);

  const upload = useMutation({
    mutationFn: () => uploadBrandingImage(kind, file!, file!.name || `${kind}`, serverCrop(area, natural)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["branding-me"] });
      void queryClient.invalidateQueries({ queryKey: ["branding-appraisal"] });
      setFile(null);
      setSrc(null);
      onDone?.();
    },
    onError: (e) => setError(apiErrorMessage(e, "Couldn't upload that image.")),
  });

  function choose(f: File | undefined) {
    setError(null);
    if (!f) return;
    const problem = brandingFileError(f);
    if (problem) return setError(problem);
    const url = URL.createObjectURL(f);
    const img = new Image();
    img.onload = () => setNatural({ width: img.naturalWidth, height: img.naturalHeight });
    img.src = url;
    setFile(f);
    setSrc(url);
    setZoom(1);
    setCrop({ x: 0, y: 0 });
  }

  return (
    <div className="ae-brand-uploader" data-kind={kind}>
      <label className="ae-brand-button">
        {label}
        <input type="file" accept={BRANDING_IMAGE_ACCEPT} className="ae-brand-vh" onChange={(e) => choose(e.target.files?.[0])} />
      </label>
      {error ? <p className="ae-brand-error" role="alert">{error}</p> : null}
      {src ? (
        <div className="ae-brand-crop" role="dialog" aria-label={`Crop ${kind}`}>
          <div className="ae-brand-crop-area">
            <Cropper
              image={src}
              crop={crop}
              zoom={zoom}
              aspect={cropAspect(kind) ?? (natural ? natural.width / natural.height : 3)}
              cropShape={kind === "photo" ? "round" : "rect"}
              onCropChange={setCrop}
              onZoomChange={setZoom}
              onCropComplete={(_a, px) => setArea(px)}
            />
          </div>
          <label className="ae-brand-zoom">
            Zoom
            <input type="range" min={1} max={3} step={0.05} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} />
          </label>
          <div className="ae-brand-actions">
            <button type="button" className="ae-brand-button" onClick={() => { setFile(null); setSrc(null); }}>
              Cancel
            </button>
            <button type="button" className="ae-brand-button is-primary" disabled={upload.isPending || !natural} onClick={() => upload.mutate()}>
              {upload.isPending ? "Saving…" : "Save image"}
            </button>
          </div>
          <p className="ae-brand-fine">PNG, JPG or WebP, up to 5 MB. AE removes location and camera data before saving.</p>
        </div>
      ) : null}
    </div>
  );
}
