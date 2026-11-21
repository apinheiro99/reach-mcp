// The one owner of layout and shape: spacing, radii, type scale and the shell geometry. Colors live in theme.ts. The values
// follow the approved 1672x941 Overview proportions but are fluid (clamp, fr, container queries), never a fixed canvas.
export const DESIGN_CSS = `
:root{
  --font:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Liberation Sans","DejaVu Sans",sans-serif;
  --fs-xs:.75rem;--fs-sm:.8125rem;--fs-md:.9375rem;--fs-lg:1.125rem;--fs-xl:clamp(1.5rem,2.1vw,2rem);--fs-num:clamp(1.5rem,1.9vw,1.9rem);
  --sp-1:.25rem;--sp-2:.5rem;--sp-3:.75rem;--sp-4:1rem;--sp-5:1.5rem;--sp-6:2rem;
  --gap:clamp(.75rem,.95vw,1rem);--gutter:clamp(1rem,1.6vw,1.75rem);
  --radius-card:.625rem;--radius-control:.5rem;--radius-pill:999px;
  --sidebar-w:clamp(13rem,14.6vw,15.5rem);--header-h:clamp(5rem,10.4vh,6.25rem);
  --stat-h:clamp(6rem,11.8vh,7.25rem);--focus-ring:0 0 0 2px var(--c-bg),0 0 0 4px var(--c-accent);
  --shadow-card:0 1px 0 var(--c-shadow-edge) inset,0 10px 30px -18px var(--c-shadow);
}`;
