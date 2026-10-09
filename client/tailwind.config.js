/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  // Theme is switched by a class on <html>, set before first paint by the
  // inline script in index.html so there is no flash of the wrong theme.
  darkMode: 'class',
  theme: {
    screens: { md: '768px', lg: '1280px' },
    extend: {
      // Values sourced from the Penpot "Conclave-Foundations" token set, now
      // backed by CSS variables in src/index.css so dark mode redefines each
      // token once instead of per utility.
      //
      // The `<alpha-value>` placeholder is what keeps `bg-brand/20` working:
      // Tailwind substitutes the requested alpha in place of it. Writing
      // `rgb(var(--color-brand))` instead would drop that substitution and
      // make every opacity modifier compile to nothing.
      colors: {
        canvas: 'rgb(var(--color-canvas) / <alpha-value>)', // Color.Background
        surface: 'rgb(var(--color-surface) / <alpha-value>)', // Color.Surface
        ink: 'rgb(var(--color-ink) / <alpha-value>)', // Color.Text.Primary
        muted: 'rgb(var(--color-muted) / <alpha-value>)', // Color.Text.Secondary
        line: 'rgb(var(--color-line) / <alpha-value>)', // Color.Border
        brand: 'rgb(var(--color-brand) / <alpha-value>)', // Color.Primary
        'brand-soft': 'rgb(var(--color-brand-soft) / <alpha-value>)', // not a Foundations token; retained until components are reworked
        success: 'rgb(var(--color-success) / <alpha-value>)', // Color.Success
        warning: 'rgb(var(--color-warning) / <alpha-value>)', // Color.Warning
        error: 'rgb(var(--color-error) / <alpha-value>)', // Color.Error
      },
      fontFamily: {
        // Typography.FontFamily.InterTight
        sans: ['"Inter Tight"', 'Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'sans-serif'],
        // Landing headings only. A high-contrast editorial serif rather than a
        // second grotesque — Inter Tight already covers the neutral voice, and
        // the serif is what makes a heading read as a statement. Instrument
        // Serif ships one weight (400) with a true italic, so no weight list.
        display: ['"Instrument Serif"', 'Georgia', 'ui-serif', 'serif'],
      },
      fontSize: {
        // Typography.FontSize.* with the unitless 1.2 line height (Typography.LineHeight.Default)
        // and Typography.FontWeight.* carried per style.
        h1: ['20px', { lineHeight: '1.2', fontWeight: '700' }],
        h2: ['16px', { lineHeight: '1.2', fontWeight: '600' }],
        body: ['14px', { lineHeight: '1.2', fontWeight: '400' }],
        label: ['13px', { lineHeight: '1.2', fontWeight: '500' }],
        metadata: ['12px', { lineHeight: '1.2', fontWeight: '400' }],

        // Landing display scale. The Foundations set tops out at h1 (20px),
        // which cannot carry an editorial hero, so the landing extends it
        // rather than reaching for an arbitrary value at the call site.
        //
        // Fluid via clamp instead of one size per breakpoint. Section 5 asks
        // for the layout to hold between 320px and 1920px, and display type
        // that steps at 768 and 1280 is the most visible way to break that —
        // a heading that jumps while the container grows around it reads as a
        // layout bug, not as design.
        //
        // Weight is 400 because Instrument Serif ships one weight. Leading
        // stays at the repo's unitless 1.2; if a multi-line hero reads too
        // open, tighten it here rather than per component.
        'display-1': ['clamp(2.5rem, 6.5vw, 5rem)', { lineHeight: '1.2', fontWeight: '400' }],
        'display-2': ['clamp(1.875rem, 3.5vw, 3rem)', { lineHeight: '1.2', fontWeight: '400' }],
        'display-3': ['clamp(1.375rem, 2.2vw, 1.875rem)', { lineHeight: '1.2', fontWeight: '400' }],
      },
      spacing: {
        // Spacing.4/8/12/16/20/24/28/32/48 already match Tailwind's default 1/2/3/4/5/6/7/8/12 steps.
        18: '18px', // Spacing.18
      },
      boxShadow: {
        // Elevation.Header and Elevation.SidebarEdge are transparent in the design (no shadow).
        modal: 'var(--shadow-modal)', // Elevation.Modal, redefined per theme
      },
      // Only entrance the app has. Components mount already-visible, so the
      // overlay fades and the sheet arrives from the edge it is anchored to,
      // in CSS rather than a mount/visible state dance in every dialog.
      // Both are wrapped in `motion-safe:` at the call site.
      keyframes: {
        'sheet-in': {
          from: { transform: 'translateY(100%)' },
          to: { transform: 'translateY(0)' },
        },
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        // Landing only: the hero mock reveals its bubbles in sequence rather
        // than appearing as a finished screenshot.
        'message-in': {
          from: { opacity: '0', transform: 'translateY(0.5rem)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'typing-dot': {
          '0%, 60%, 100%': { transform: 'translateY(0)', opacity: '0.4' },
          '30%': { transform: 'translateY(-0.25rem)', opacity: '1' },
        },
        marquee: {
          from: { transform: 'translateX(0)' },
          to: { transform: 'translateX(-50%)' },
        },
      },
      animation: {
        'sheet-in': 'sheet-in 180ms ease-out',
        'fade-in': 'fade-in 150ms ease-out',
        'message-in': 'message-in 450ms ease-out both',
        'typing-dot': 'typing-dot 1.2s ease-in-out infinite',
        // Loops by translating exactly half the track, so the duplicated half
        // takes the place of the first with no seam. Anything other than 50%
        // leaves a visible jump.
        marquee: 'marquee 42s linear infinite',
      },
      // Radius.8 -> rounded-lg, Radius.12 -> rounded-xl, Border.Width.1 -> border (Tailwind defaults).
    },
  },
  plugins: [],
};
