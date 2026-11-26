import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { CoverPlaceholder } from '../components/ui/CoverPlaceholder';

export function ExploreCoverImage({
  src,
  position,
  eager,
  draggable,
}: {
  src?: string;
  position?: CSSProperties['objectPosition'];
  eager?: boolean;
  draggable?: boolean;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [loadedSrc, setLoadedSrc] = useState<string>();
  const loaded = Boolean(src && loadedSrc === src);

  useEffect(() => {
    const img = imgRef.current;
    if (src && img?.complete && img.naturalWidth > 0) {
      setLoadedSrc(src);
    }
  }, [src]);

  return <>
    {!loaded && <CoverPlaceholder fill />}
    {src && <img ref={imgRef} src={src} style={{ objectPosition: position, opacity: loaded ? undefined : 0 }}
      loading={eager ? 'eager' : 'lazy'} decoding="async" alt="" draggable={draggable}
      onLoad={() => setLoadedSrc(src)} onError={() => setLoadedSrc(undefined)} />}
  </>;
}
