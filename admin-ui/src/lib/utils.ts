import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import { useEffect, useState } from "react"

/**
 * Merge Tailwind classes with proper de-duplication.
 * Filters falsy values, then resolves conflicts via tailwind-merge.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Debounce any value by `delayMs`. Returns the latest value after the
 * input settles. Used by Patterns search to avoid per-keystroke fetches.
 *
 *   const debounced = useDebounce(searchTerm, 300)
 *   useEffect(() => { fetch(debounced) }, [debounced])
 */
export function useDebounce<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState<T>(value)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(id)
  }, [value, delayMs])
  return debounced
}

/**
 * Copy text to the clipboard, falling back to a hidden textarea +
 * execCommand for older browsers / non-secure contexts. Resolves
 * `false` when neither path works.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* fall through to the textarea fallback */
  }
  try {
    const ta = document.createElement("textarea")
    ta.value = text
    ta.setAttribute("readonly", "")
    ta.style.position = "fixed"
    ta.style.opacity = "0"
    document.body.appendChild(ta)
    ta.select()
    document.execCommand("copy")
    document.body.removeChild(ta)
    return true
  } catch {
    return false
  }
}
