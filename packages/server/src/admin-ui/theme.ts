// The one owner of every color of the admin UI. Everything else (components, shell, views) consumes these semantic variables and
// never carries a color literal, so changing the accent here changes it everywhere. Dark is the polished theme; the light block
// only fills the same semantic slots, it is not a second stylesheet.
export const THEME_CSS = `
:root,[data-theme="dark"]{
  color-scheme:dark;
  --c-bg:#050607;--c-surface:#0b0d10;--c-elevated:#101318;--c-border:rgba(255,255,255,.1);--c-border-strong:rgba(255,255,255,.18);
  --c-text:#f3f4f6;--c-muted:#8c939d;
  --c-accent:#f2b829;--c-accent-hover:#ffd45a;--c-accent-contrast:#0b0d10;--c-accent-soft:rgba(242,184,41,.14);--c-glow:rgba(242,184,41,.32);
  --c-ok:#2ddf8a;--c-warn:#f2b829;--c-bad:#ff667a;
  --c-ok-soft:rgba(45,223,138,.14);--c-warn-soft:rgba(242,184,41,.14);--c-bad-soft:rgba(255,102,122,.14);
  --c-card:rgba(11,13,16,.72);--c-overlay:rgba(5,6,7,.55);
  --c-shadow:rgba(0,0,0,.8);--c-shadow-edge:rgba(255,255,255,.03);
  --c-node:rgba(242,184,41,.5);--c-line:rgba(242,184,41,.11);--c-star:rgba(243,244,246,.5);
}
[data-theme="light"]{
  color-scheme:light;
  --c-bg:#f6f6f4;--c-surface:#ffffff;--c-elevated:#ffffff;--c-border:rgba(0,0,0,.12);--c-border-strong:rgba(0,0,0,.22);
  --c-text:#15171a;--c-muted:#5c636d;
  --c-accent:#c98f00;--c-accent-hover:#e0a200;--c-accent-contrast:#ffffff;--c-accent-soft:rgba(201,143,0,.12);--c-glow:rgba(201,143,0,.25);
  --c-ok:#14803f;--c-warn:#c98f00;--c-bad:#c0233a;
  --c-ok-soft:rgba(20,128,63,.12);--c-warn-soft:rgba(201,143,0,.12);--c-bad-soft:rgba(192,35,58,.12);
  --c-card:rgba(255,255,255,.8);--c-overlay:rgba(255,255,255,.6);
  --c-shadow:rgba(0,0,0,.18);--c-shadow-edge:rgba(255,255,255,.6);
  --c-node:rgba(201,143,0,.5);--c-line:rgba(201,143,0,.18);--c-star:rgba(21,23,26,.35);
}`;
