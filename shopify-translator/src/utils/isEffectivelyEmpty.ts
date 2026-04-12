/** True if string is blank or only HTML tags / whitespace (for “has translation?” checks). */
export function isEffectivelyEmpty(val: string): boolean {
  if (!val || !val.trim()) return true;
  return val.replace(/<[^>]*>/g, "").trim() === "";
}
