/**
 * Placeholder institutional mark — NOT the official NFSU crest/logo.
 * The real logo file (https://nfsu.ac.in/assets/img/NFSU_logo.png) could not
 * be retrieved in this environment. Replace the <circle>/<text> below with
 * an <img>/<svg> of the actual logo before shipping; nothing else in the
 * shell depends on this component's internals, only its footprint.
 */
export function Mark({ size = 36 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      role="img"
      aria-label="NFSU Placement Portal"
    >
      <circle cx="20" cy="20" r="19" stroke="var(--brand-gold)" strokeWidth="1.4" />
      <circle cx="20" cy="20" r="16.5" stroke="var(--brand-accent)" strokeWidth="1" opacity="0.7" />
      <circle cx="20" cy="20" r="15" fill="var(--brand-primary)" />
      <text
        x="20"
        y="25"
        textAnchor="middle"
        fontFamily="var(--font-serif)"
        fontSize="13"
        fontWeight="600"
        fill="var(--brand-gold)"
      >
        NF
      </text>
    </svg>
  );
}
