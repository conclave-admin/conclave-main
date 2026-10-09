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
      },
      fontSize: {
        // Typography.FontSize.* with the unitless 1.2 line height (Typography.LineHeight.Default)
        // and Typography.FontWeight.* carried per style.
        h1: ['20px', { lineHeight: '1.2', fontWeight: '700' }],
        h2: ['16px', { lineHeight: '1.2', fontWeight: '600' }],
        body: ['14px', { lineHeight: '1.2', fontWeight: '400' }],
        label: ['13px', { lineHeight: '1.2', fontWeight: '500' }],
        metadata: ['12px', { lineHeight: '1.2', fontWeight: '400' }],
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
      },
      animation: {
        'sheet-in': 'sheet-in 180ms ease-out',
        'fade-in': 'fade-in 150ms ease-out',
      },
      // Radius.8 -> rounded-lg, Radius.12 -> rounded-xl, Border.Width.1 -> border (Tailwind defaults).
    },
  },
  plugins: [],
};
