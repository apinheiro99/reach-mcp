// The one timer seam shared by the transport and the dispatcher: schedule a callback, get its canceller.
export type Schedule = (fn: () => void, ms: number) => () => void;

export const realSchedule: Schedule = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
};
