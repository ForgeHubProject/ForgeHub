import { useEffect, useState, type RefObject } from "react";

/**
 * Whether `ref` has come within `margin` of the screen, once watching starts.
 * It stays true afterwards, so whatever it gated keeps what it loaded. Where
 * IntersectionObserver is missing it answers true at once.
 */
export function useNearScreen(ref: RefObject<Element | null>, watch: boolean, margin = "600px"): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (!watch || near) return;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: margin },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, watch, near, margin]);
  return near;
}
