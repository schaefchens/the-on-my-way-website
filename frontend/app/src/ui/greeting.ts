/** Time of day for the greeting, the same bands as the admin's Greeting (home.tsx). */
export type DayPart = 'night' | 'morning' | 'day' | 'evening';

export function dayPart(hour: number): DayPart {
  if (hour < 5 || hour >= 22) return 'night';
  if (hour < 11) return 'morning';
  if (hour < 17) return 'day';
  return 'evening';
}
