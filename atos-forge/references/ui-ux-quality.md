<ui_ux_quality>

UI/UX quality standards for agents executing frontend phases. Agents @-reference this file when phase goal involves UI, components, frontend, styling, dashboard, or visual output.

## Activation

Apply these standards when the phase touches:
- React/Vue/Svelte/Angular components
- HTML/CSS/Tailwind styling
- Dashboard or data visualization
- Landing pages or marketing sites
- Mobile or responsive layouts
- Design system or theming work

When none of these apply, skip this reference entirely.

---

## 1. Accessibility (CRITICAL — never skip)

| Rule | Standard | Verify |
|------|----------|--------|
| Color contrast | 4.5:1 minimum for normal text, 3:1 for large text (18px+ bold or 24px+) | DevTools contrast checker or `npx pa11y` |
| Focus states | Every interactive element has visible focus indicator (2px+ outline, offset) | Tab through all interactive elements |
| Alt text | Every `<img>` has descriptive `alt`; decorative images use `alt=""` | Grep for `<img` without `alt` |
| ARIA labels | Icon-only buttons have `aria-label`; custom controls have proper `role` | Grep for `<button` containing only SVG/icon |
| Keyboard nav | All functionality reachable via keyboard alone; no keyboard traps | Tab + Enter/Space through full flow |
| Reduced motion | Wrap animations in `prefers-reduced-motion` media query | Toggle in OS settings |
| Semantic HTML | Use `<nav>`, `<main>`, `<section>`, `<article>`, `<aside>` — not div soup | Grep for structural elements |
| Form labels | Every input has a visible `<label>` with `htmlFor`/`for` match | Grep for `<input` without associated label |
| Error messages | Form errors announced to screen readers via `aria-live="polite"` or `role="alert"` | Test with VoiceOver/NVDA |
| Dynamic content | Route changes announce new page title; loading states communicated | Check `aria-live` regions |

---

## 2. Touch & Interaction

| Rule | Standard |
|------|----------|
| Touch targets | Minimum 44x44px (CSS) for all interactive elements |
| Target spacing | Minimum 8px between adjacent touch targets |
| Press feedback | Visual response within 100ms (opacity change, scale, or color shift) |
| Hover states | Distinct hover style on pointer devices; don't rely on hover for critical info |
| Active states | Visible pressed/active state distinct from hover |
| Disabled states | Reduced opacity (0.5-0.6) + `cursor: not-allowed` + `pointer-events: none` |
| Loading states | Show skeleton/spinner within 200ms of action; never leave user guessing |
| Gesture conflicts | Don't override native scroll, pinch-zoom, or swipe-back gestures |
| Safe areas | Respect `env(safe-area-inset-*)` on mobile for notch/home-bar |

---

## 3. Color System — Semantic Token Architecture

Never use raw hex/rgb values in components. Define and consume semantic tokens.

**Required token set (minimum):**

```
--primary           /* Brand action color */
--on-primary        /* Text on primary */
--secondary         /* Supporting color */
--on-secondary      /* Text on secondary */
--accent            /* Highlight / CTA contrast */
--on-accent         /* Text on accent */
--background        /* Page background */
--foreground        /* Default text on background */
--card              /* Card / surface background */
--card-foreground   /* Text on card */
--muted             /* Subdued backgrounds */
--muted-foreground  /* Secondary text */
--border            /* Borders and dividers */
--destructive       /* Error / danger actions */
--on-destructive    /* Text on destructive */
--ring              /* Focus ring color */
```

**Rules:**
- All accent colors WCAG 3:1 minimum contrast against their background
- Primary text on background WCAG 4.5:1 minimum
- Dark mode: invert surface hierarchy (darkest = background, lighter = elevated)
- Never use `black` (#000) on `white` (#fff) — too harsh. Use off-black/off-white (e.g., #0a0a0a / #fafafa)

---

## 4. Typography

| Rule | Standard |
|------|----------|
| Body line-height | 1.5 to 1.75 for readability |
| Line length | 65-75 characters max (use `max-w-prose` or `ch` units) |
| Font scale | Use a consistent type scale (e.g., 1.25 ratio: 12/15/18/23/28/36) |
| Font loading | Use `font-display: swap` to prevent invisible text during load |
| Heading hierarchy | Only one `<h1>` per page; headings never skip levels (h1 > h2 > h3) |
| Tabular figures | Use `font-variant-numeric: tabular-nums` for numbers in tables/data |
| Minimum size | 16px body text on mobile (prevents iOS zoom on focus) |
| Font pairing | Max 2 font families (1 heading + 1 body); 3 is absolute maximum |

**Recommended pairings by product type:**

| Product Type | Heading | Body | Mood |
|-------------|---------|------|------|
| SaaS / Tech | Inter, Geist, or Plus Jakarta Sans | Same as heading | Clean, modern |
| Finance / Enterprise | DM Serif Display or Playfair Display | Inter or Source Sans 3 | Trust, authority |
| Creative / Portfolio | Space Grotesk or Syne | Work Sans or Outfit | Distinctive, bold |
| E-commerce | Poppins or Nunito | Open Sans or Lato | Friendly, approachable |
| Dashboard / Data | JetBrains Mono (data) + Inter (UI) | Inter | Technical, precise |
| Healthcare | Source Sans 3 or Libre Franklin | Same as heading | Clear, trustworthy |

---

## 5. Spacing & Layout

| Rule | Standard |
|------|----------|
| Spacing system | Use 4px/8px grid (4, 8, 12, 16, 24, 32, 48, 64, 96) — no magic numbers |
| Mobile-first | Write base styles for mobile, add complexity at larger breakpoints |
| Breakpoints | 640px (sm), 768px (md), 1024px (lg), 1280px (xl), 1536px (2xl) — or Tailwind defaults |
| Container | Max-width 1280px centered with auto margins; full-bleed sections are intentional |
| Viewport height | Use `min-h-dvh` (dynamic viewport), not `min-h-screen` (ignores mobile chrome) |
| Z-index scale | Use named layers: `base(0)`, `dropdown(10)`, `sticky(20)`, `modal(30)`, `popover(40)`, `toast(50)` |
| Scroll padding | Add `scroll-padding-top` when sticky headers exist |
| Content overflow | `overflow-wrap: break-word` on long text containers; truncate with ellipsis where appropriate |

---

## 6. Animation & Motion

| Rule | Standard |
|------|----------|
| Duration | 150-300ms for micro-interactions; 300-500ms for layout transitions |
| Easing | `ease-out` for enter, `ease-in` for exit, `ease-in-out` for state changes |
| Properties | Only animate `transform` and `opacity` (GPU-accelerated); avoid animating `width`, `height`, `top`, `left` |
| Reduced motion | Wrap in `@media (prefers-reduced-motion: no-preference) { }` |
| Loading skeleton | Pulse animation on placeholder shapes matching content layout |
| Page transitions | Fade (150ms) or slide (200ms); never bounce or overshoot |
| Scroll animations | Use `IntersectionObserver`, not scroll event listeners |
| Interruptible | Animations should be cancellable mid-way (no `animation-fill-mode: forwards` traps) |
| Spring physics | For drag/gesture interactions: `damping: 20-30`, `stiffness: 200-400` (Framer Motion / React Spring) |

---

## 7. Performance

| Rule | Standard |
|------|----------|
| Images | WebP/AVIF with `<picture>` fallback; `width`/`height` attributes to prevent layout shift |
| Lazy loading | `loading="lazy"` on below-fold images; `loading="eager"` on LCP image |
| Font loading | Subset fonts, use `font-display: swap`, preload critical fonts |
| Bundle | Code-split routes; dynamic import heavy components (charts, editors, maps) |
| Frame budget | 16ms per frame (60fps); defer non-visual work to `requestIdleCallback` |
| Layout shifts | Reserve space for async content (images, ads, embeds) — target CLS < 0.1 |
| Lists | Virtualize lists >50 items (`react-window`, `@tanstack/virtual`, or framework equivalent) |
| Debounce | Search inputs: 300ms debounce; resize handlers: 150ms throttle |

---

## 8. Forms & Feedback

| Rule | Standard |
|------|----------|
| Visible labels | Every field has a visible label above it (not just placeholder) |
| Validation timing | Validate on blur (first interaction); re-validate on change after first error |
| Error placement | Inline below the field, not in a banner at page top |
| Error style | Red border + icon + text; don't rely on color alone (colorblind users) |
| Success feedback | Confirm successful actions with toast/banner (auto-dismiss 3-5s) |
| Progressive disclosure | Show optional fields behind "Advanced" toggle; don't overwhelm |
| Autofill support | Use correct `autocomplete` attributes (`email`, `current-password`, `given-name`, etc.) |
| Submit state | Disable button + show spinner during submission; re-enable on error |
| Destructive actions | Require confirmation for delete/remove; show what will be affected |

---

## 9. Charts & Data Visualization

| Rule | Standard |
|------|----------|
| Chart type | Match data type: comparison=bar, trend=line, proportion=pie/donut, distribution=histogram |
| Color | Max 5-7 series colors; use colorblind-safe palette (avoid red+green as sole differentiator) |
| Accessible fallback | Provide data table alongside or togglable from every chart |
| Labels | Direct labels on data points when <7 series; legend when more |
| Responsive | SVG for <1000 data points; Canvas for 1000-100K; WebGL for 100K+ |
| Interactions | Tooltip on hover with exact values; click to drill down when applicable |
| Libraries | Chart.js (simple), Recharts (React), D3.js (custom), Plotly (scientific) |

---

## 10. Pre-Delivery Checklist

Run through before marking any UI phase as complete:

**Visual Quality**
- [ ] No emoji used as icons (use icon library: Lucide, Phosphor, or Heroicons)
- [ ] Consistent icon family throughout (don't mix libraries)
- [ ] Semantic color tokens used everywhere (no raw hex in components)
- [ ] Spacing follows 4/8px grid (no magic numbers like 13px, 7px)

**Interaction**
- [ ] All buttons/links show press feedback
- [ ] Touch targets >= 44px
- [ ] Animation durations 150-300ms
- [ ] Disabled states visually distinct

**Light/Dark Mode** (if applicable)
- [ ] Primary text contrast >= 4.5:1 in both modes
- [ ] Borders/dividers visible in both modes
- [ ] Images/shadows adapted for both modes

**Layout**
- [ ] Tested at 375px, 768px, 1024px, 1440px widths
- [ ] No horizontal scroll at any breakpoint
- [ ] Content readable without zooming on mobile
- [ ] Spacing rhythm consistent (4/8px grid)

**Accessibility**
- [ ] All images have alt text
- [ ] All form inputs have labels
- [ ] All interactive elements keyboard-reachable
- [ ] Focus indicators visible
- [ ] `prefers-reduced-motion` respected

</ui_ux_quality>
