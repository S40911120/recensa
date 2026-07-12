import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Extract a display string from an unknown caught value: an Error's message, otherwise its String() form. */
export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
