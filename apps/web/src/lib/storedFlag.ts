import { useState } from "react";

/**
 * A boolean kept in localStorage, for per-browser view preferences (the commit
 * and file pages' file trees). Storage can be missing or refuse (privacy
 * modes); the flag then simply doesn't stick, and the page never breaks.
 */
export function useStoredFlag(key: string, initial: boolean): [boolean, (on: boolean) => void] {
  const [value, setValue] = useState<boolean>(() => {
    try {
      const stored = globalThis.localStorage?.getItem(key);
      return stored === null || stored === undefined ? initial : stored === "1";
    } catch {
      return initial;
    }
  });
  const set = (on: boolean): void => {
    setValue(on);
    try {
      globalThis.localStorage?.setItem(key, on ? "1" : "0");
    } catch {
      /* not remembered */
    }
  };
  return [value, set];
}
